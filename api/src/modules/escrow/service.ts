import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import { projects, wallets, walletEntries, investments } from "../../db/schema";
import type { PaymentProvider } from "../../lib/payments";

// The target project is not in the "collecting" state (includes an already
// cancelled project on a re-cancel). Route maps this to 409 invalid_state.
// Defined LOCALLY here (not imported from investments/service) on purpose:
// investments/service already imports from this module, so importing back would
// create a module cycle and make the route's instanceof check order-dependent.
export class InvalidStateError extends Error {
  constructor() {
    super("invalid_state");
    this.name = "InvalidStateError";
  }
}

// The target project row does not exist (well-formed but absent id). Route maps
// this to 404, mirroring the other project routes' absent-id convention.
export class ProjectNotFoundError extends Error {
  constructor() {
    super("project_not_found");
    this.name = "ProjectNotFoundError";
  }
}

// Deterministic idempotency key for a provider escrow operation. A replayed
// settle/release/refund carries the SAME key so the provider dedupes rather
// than moving money twice. Keyed by the investment id, never a timestamp.
export function idemKey(op: "deposit" | "release" | "refund", investmentId: string): string {
  return `${op}:${investmentId}`;
}

export interface SettleResult {
  found: boolean;
  applied: boolean;
  projectStatus?: string;
}

// Settle a provider deposit into escrow. The whole apply step runs in ONE
// transaction that holds SELECT ... FOR UPDATE on the project row, so the
// raised_minor read-modify-write is atomic across concurrent settlements and no
// overfunding is possible. The investment transition is GUARDED (pending ->
// escrowed): if a concurrent/replayed settle already moved it, the guard changes
// zero rows and the money move is skipped (idempotent no-op). The porteur payout
// (releaseProject) runs AFTER this transaction commits, never under the project
// lock: no network I/O is held inside the lock.
export async function settleDeposit(
  db: Db,
  payments: PaymentProvider,
  args: { depositRef: string },
): Promise<SettleResult> {
  const [found] = await db
    .select({ id: investments.id, projectId: investments.projectId })
    .from(investments)
    .where(eq(investments.paymentRef, args.depositRef));
  if (!found) return { found: false, applied: false };

  const projectId = found.projectId;

  const outcome = await db.transaction(async (tx) => {
    // Lock the project row FIRST, then read the investment under that lock.
    const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
    if (!project) return { applied: false as const, projectStatus: undefined };

    const [inv] = await tx
      .select({ status: investments.status, amountMinor: investments.amountMinor })
      .from(investments)
      .where(eq(investments.id, found.id));
    if (!inv) return { applied: false as const, projectStatus: project.status };

    // Idempotent no-op: the project already left collecting, or this deposit is
    // no longer pending (already settled or failed).
    if (project.status !== "collecting" || inv.status !== "pending") {
      return { applied: false as const, projectStatus: project.status };
    }

    // Guarded pending -> escrowed. If a concurrent writer already flipped it, the
    // guard changes zero rows and we skip the money move.
    const escrowed = await tx
      .update(investments)
      .set({ status: "escrowed", settledAt: new Date() })
      .where(and(eq(investments.id, found.id), eq(investments.status, "pending")))
      .returning({ id: investments.id });
    if (escrowed.length === 0) {
      return { applied: false as const, projectStatus: project.status };
    }

    // raised_minor moves ONLY here, under the project lock. Flip to funded at
    // strict equality; the DB CHECK (0 <= raised <= target) is the backstop.
    const newRaised = project.raisedMinor + inv.amountMinor;
    const projectStatus = newRaised === project.targetMinor ? "funded" : project.status;
    await tx
      .update(projects)
      .set({ raisedMinor: newRaised, status: projectStatus, updatedAt: new Date() })
      .where(eq(projects.id, projectId));

    return { applied: true as const, projectStatus };
  });

  // AFTER commit: if the project is in the funded STATE, release escrow to the
  // porteur. This runs outside the settlement transaction so no network I/O is
  // held under the project lock. Gating on the state (not on `applied`) is what
  // makes release RESUMABLE: if a prior settlement funded the project but its
  // release crashed partway, a replayed webhook re-enters here even though the
  // settle itself is now a no-op, and releaseProject's guard skips whatever was
  // already released (no double-credit).
  if (outcome.projectStatus === "funded") {
    await releaseProject(db, payments, { projectId });
  }

  return {
    found: true,
    applied: outcome.applied,
    ...(outcome.projectStatus !== undefined ? { projectStatus: outcome.projectStatus } : {}),
  };
}

// Mark a failed provider deposit. Guarded pending -> failed. raised_minor is
// never touched: a failed deposit never contributed to the raise.
export async function failDeposit(db: Db, args: { depositRef: string }): Promise<SettleResult> {
  const [found] = await db
    .select({ id: investments.id })
    .from(investments)
    .where(eq(investments.paymentRef, args.depositRef));
  if (!found) return { found: false, applied: false };

  const applied = await db.transaction(async (tx) => {
    const failed = await tx
      .update(investments)
      .set({ status: "failed", resolvedAt: new Date() })
      .where(and(eq(investments.id, found.id), eq(investments.status, "pending")))
      .returning({ id: investments.id });
    return failed.length > 0;
  });

  return { found: true, applied };
}

// Release every escrowed investment of a funded project to the porteur wallet.
// Each investment is released in its OWN short transaction, OUTSIDE any project
// lock held by settlement: the provider call is network I/O and must never run
// under the project row lock. Each transition is GUARDED (escrowed -> released),
// so a re-run credits nothing twice and the provider call carries the
// deterministic release idempotency key.
export async function releaseProject(
  db: Db,
  payments: PaymentProvider,
  args: { projectId: string },
): Promise<void> {
  const [project] = await db
    .select({ ownerAccountId: projects.ownerAccountId })
    .from(projects)
    .where(eq(projects.id, args.projectId));
  if (!project) return;

  const escrowedInvs = await db
    .select({
      id: investments.id,
      amountMinor: investments.amountMinor,
      paymentRef: investments.paymentRef,
      source: investments.source,
    })
    .from(investments)
    .where(and(eq(investments.projectId, args.projectId), eq(investments.status, "escrowed")));

  for (const inv of escrowedInvs) {
    // Isolate each investment: a real releaseEscrow that TIMES OUT throws rather
    // than returning ok:false, which would reject this investment's tx AND break
    // the loop, stranding every later release in this pass. One poison
    // investment must not block the rest; the state guard keeps a later retry
    // idempotent, so we log and continue.
    try {
      await db.transaction(async (tx) => {
        // Look up the porteur wallet BEFORE any provider money moves, so a
        // missing wallet fails ahead of the release call.
        const [w] = await tx
          .select({ id: wallets.id })
          .from(wallets)
          .where(eq(wallets.accountId, project.ownerAccountId));
        if (!w) throw new Error("porteur wallet not found for disbursement");

        // Only payment-source escrow crosses the provider seam (section 4/7):
        // wallet-source funds never left the internal ledger, so there is nothing
        // for the provider to release. Both sources still credit the porteur.
        let resolutionRef: string | null = null;
        if (inv.source === "payment") {
          const release = await payments.releaseEscrow({
            depositRef: inv.paymentRef ?? "",
            payeeAccountId: project.ownerAccountId,
            amountMinor: inv.amountMinor,
            idempotencyKey: idemKey("release", inv.id),
          });
          // Leave the investment escrowed on a provider decline: a later release
          // re-run resumes it (guarded, retry-safe), never double-crediting.
          if (!release.ok) return;
          resolutionRef = release.ref;
        }

        // Guarded escrowed -> released. If a concurrent/replayed release already
        // moved this investment, the guard changes zero rows: skip the credit so
        // the porteur is never double-credited.
        const released = await tx
          .update(investments)
          .set({ status: "released", resolutionRef, resolvedAt: new Date() })
          .where(and(eq(investments.id, inv.id), eq(investments.status, "escrowed")))
          .returning({ id: investments.id });
        if (released.length === 0) return;

        await tx.insert(walletEntries).values({
          walletId: w.id,
          type: "disbursement",
          amountMinor: inv.amountMinor,
          reference: inv.id,
        });
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`escrow release failed for investment ${inv.id}, continuing`, err);
    }
  }
}

// Admin cancel: guarded collecting -> cancelled, then refund every pending or
// escrowed investment to its source. The state flip runs in ONE transaction
// holding the project row FOR UPDATE; a project that is not collecting (already
// cancelled included) throws InvalidStateError (-> 409) and nothing is refunded.
// The per-investment refunds run AFTER that commit, each in its OWN short
// transaction OUTSIDE the cancel lock, mirroring releaseProject: no provider
// network I/O is ever held under a project row lock, and one poison investment
// cannot strand the rest.
export async function cancelAndRefund(
  db: Db,
  payments: PaymentProvider,
  args: { projectId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [project] = await tx
      .select({ status: projects.status })
      .from(projects)
      .where(eq(projects.id, args.projectId))
      .for("update");
    if (!project) throw new ProjectNotFoundError();
    if (project.status !== "collecting") throw new InvalidStateError();

    // Guarded collecting -> cancelled. FOR UPDATE already serialises this, but
    // the guard keeps the transition consistent with every other escrow move.
    const cancelled = await tx
      .update(projects)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(projects.id, args.projectId), eq(projects.status, "collecting")))
      .returning({ id: projects.id });
    if (cancelled.length === 0) throw new InvalidStateError();
  });

  // Snapshot the investments to refund AFTER the cancel commits. The project is
  // now `cancelled`, so settleDeposit (which requires `collecting` under the
  // project lock) can no longer advance any pending investment to escrowed: this
  // pending/escrowed snapshot is stable, which is what makes the per-investment
  // `inv.status === "escrowed"` decision below load-bearing-correct. The other
  // half also holds: no NEW pending/escrowed row can appear after this unlocked
  // read, because createInvestment takes the same project FOR UPDATE lock and
  // throws NotCollectingError unless the project is `collecting`, so any invest
  // either committed before the cancel took the lock (visible here) or blocks
  // then 409s. The refundable set is closed at cancel-commit.
  const invs = await db
    .select({
      id: investments.id,
      amountMinor: investments.amountMinor,
      source: investments.source,
      paymentRef: investments.paymentRef,
      status: investments.status,
      investorAccountId: investments.investorAccountId,
    })
    .from(investments)
    .where(and(eq(investments.projectId, args.projectId), inArray(investments.status, ["pending", "escrowed"])));

  for (const inv of invs) {
    // Isolate each investment (like releaseProject): a refundEscrow that throws
    // must not reject the whole pass and strand later refunds. The guarded
    // transition keeps a later retry idempotent, so we log and continue.
    try {
      await db.transaction(async (tx) => {
        // payment-source crosses the provider seam. Call it BEFORE acquiring the
        // project lock so no network I/O is held under the row lock; the
        // deterministic refund:<id> key makes a replay a provider no-op.
        let resolutionRef: string | null = null;
        if (inv.source === "payment") {
          const refund = await payments.refundEscrow({
            depositRef: inv.paymentRef ?? "",
            amountMinor: inv.amountMinor,
            idempotencyKey: idemKey("refund", inv.id),
          });
          // Leave the investment refundable on a provider decline (guarded, so a
          // retry never double-refunds), exactly as releaseProject does.
          if (!refund.ok) return;
          resolutionRef = refund.ref;
        }

        // Lock the project row: the raised_minor decrement below moves money and
        // must run under the project FOR UPDATE lock (global concurrency rule).
        const [project] = await tx
          .select({ raisedMinor: projects.raisedMinor })
          .from(projects)
          .where(eq(projects.id, args.projectId))
          .for("update");
        if (!project) return;

        // Guarded pending|escrowed -> refunded. This GATES every non-idempotent
        // money move below (wallet credit, raised decrement): a re-run finds the
        // row already refunded, changes zero rows, and does nothing.
        const refunded = await tx
          .update(investments)
          .set({ status: "refunded", resolutionRef, resolvedAt: new Date() })
          .where(and(eq(investments.id, inv.id), inArray(investments.status, ["pending", "escrowed"])))
          .returning({ id: investments.id });
        if (refunded.length === 0) return;

        // wallet-source funds never left the internal ledger: credit them back
        // with a positive refund entry to the investor wallet.
        if (inv.source === "wallet") {
          const [w] = await tx.select({ id: wallets.id }).from(wallets).where(eq(wallets.accountId, inv.investorAccountId));
          if (!w) throw new Error("investor wallet not found for refund");
          await tx.insert(walletEntries).values({
            walletId: w.id,
            type: "refund",
            amountMinor: inv.amountMinor,
            reference: inv.id,
          });
        }

        // Only escrowed funds ever advanced raised_minor; a pending deposit held
        // reserved capacity but never moved raised, so it is NOT decremented.
        if (inv.status === "escrowed") {
          await tx
            .update(projects)
            .set({ raisedMinor: project.raisedMinor - inv.amountMinor, updatedAt: new Date() })
            .where(eq(projects.id, args.projectId));
        }
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`escrow refund failed for investment ${inv.id}, continuing`, err);
    }
  }
}
