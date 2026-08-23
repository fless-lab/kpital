import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { projects, wallets, walletEntries, investments } from "../../db/schema";
import type { PaymentProvider } from "../../lib/payments";

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

  // AFTER commit: if the project just became funded, release escrow to the
  // porteur. This runs outside the settlement transaction so no network I/O is
  // held under the project lock.
  if (outcome.applied && outcome.projectStatus === "funded") {
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
    await db.transaction(async (tx) => {
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
        // Leave the investment escrowed on a provider failure: a later release
        // re-run resumes it (guarded, retry-safe), never double-crediting.
        if (!release.ok) return;
        resolutionRef = release.ref;
      }

      const [w] = await tx
        .select({ id: wallets.id })
        .from(wallets)
        .where(eq(wallets.accountId, project.ownerAccountId));
      if (!w) throw new Error("porteur wallet not found for disbursement");

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
  }
}
