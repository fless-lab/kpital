import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  projects,
  investments,
  repaymentInstallments,
  repaymentDistributions,
  wallets,
  walletEntries,
} from "../../db/schema";

// The transaction handle passed to a db.transaction callback. Derived from Db so
// this module never imports anything runtime from escrow/service (escrow ->
// repayment is the only runtime edge; a back-import would close the cycle).
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// Shift a date forward by n whole months. setMonth normalises overflow (e.g. a
// month index past 11 rolls the year), which is the intended calendar behaviour.
function addMonths(d: Date, n: number): Date {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}

// The subset of a project row generateSchedule needs. roiPct is a numeric string
// at the DB boundary, coerced with Number for the total_owed computation.
interface SchedulableProject {
  id: string;
  durationMonths: number;
  raisedMinor: number;
  roiPct: string;
}

// Insert the N-installment repayment schedule for a project, under the caller's
// transaction. total_owed = round(raised * (1 + roi/100)); each of the first N-1
// installments is floor(total_owed / N) and the LAST absorbs the rounding
// remainder, so the schedule sums to total_owed EXACTLY. due_at = now + seq
// months; status relies on the column DEFAULT ('due').
export async function generateSchedule(tx: Tx, project: SchedulableProject): Promise<void> {
  const n = project.durationMonths;
  const totalOwed = Math.round(project.raisedMinor * (1 + Number(project.roiPct) / 100));
  const base = Math.floor(totalOwed / n);
  const now = new Date();

  const rows = [] as { projectId: string; seq: number; amountMinor: number; dueAt: Date }[];
  for (let seq = 1; seq <= n; seq += 1) {
    rows.push({
      projectId: project.id,
      seq,
      amountMinor: seq < n ? base : totalOwed - base * (n - 1),
      dueAt: addMonths(now, seq),
    });
  }
  await tx.insert(repaymentInstallments).values(rows);
}

// Move a fully-released project from `funded` to `repaying` and lay down its
// repayment schedule. Runs in ONE transaction holding the project row FOR UPDATE.
// The flip happens ONLY when every investment has left escrow: while any
// `escrowed` straggler remains (a partial release), the project stays `funded` so
// a resumed releaseProject can finish disbursing, which is REQUIRED for coherence
// with the #5 funded-guard on releaseProject. The transition is GUARDED (funded
// -> repaying under a WHERE status = funded): a concurrent/replayed call finds the
// row already `repaying`, changes zero rows, and generates NO second schedule
// (idempotent). Callers: releaseProject at release completion.
export async function startRepayment(db: Db, args: { projectId: string }): Promise<void> {
  await db.transaction(async (tx) => {
    const [project] = await tx.select().from(projects).where(eq(projects.id, args.projectId)).for("update");
    if (!project) return;
    if (project.status !== "funded") return;

    // Any investment still escrowed means release did not complete: do NOT flip.
    const escrowed = await tx
      .select({ id: investments.id })
      .from(investments)
      .where(and(eq(investments.projectId, args.projectId), eq(investments.status, "escrowed")))
      .limit(1);
    if (escrowed.length > 0) return;

    // Guarded funded -> repaying. FOR UPDATE already serialises this, but the
    // guard keeps the schedule generation single-shot even across replays.
    const flipped = await tx
      .update(projects)
      .set({ status: "repaying", updatedAt: new Date() })
      .where(and(eq(projects.id, args.projectId), eq(projects.status, "funded")))
      .returning({ id: projects.id });
    if (flipped.length === 0) return;

    await generateSchedule(tx, project);
  });
}

// Deterministic provider idempotency key for a repayment collection. A replayed
// /repay carries the SAME key so the provider dedupes rather than collecting
// twice. Keyed by the installment id, never a timestamp (mirrors escrow idemKey).
export function repayKey(installmentId: string): string {
  return `repay:${installmentId}`;
}

// Distribute a settled installment pro-rata to the project's investors, idempotent
// and resumable, then mark it `paid` and close the project once every installment
// is `paid`. The investor set is FROZEN (project funded, all investments released),
// so the pro-rata base (raised_minor, parts p_i) is stable with no concurrency.
// Called only after the money has settled (route settled-branch / webhook settled),
// never for a `pending` collection: distribution never precedes the money.
export async function settleRepayment(db: Db, args: { installmentId: string }): Promise<void> {
  const { installmentId } = args;

  const [installment] = await db
    .select({
      projectId: repaymentInstallments.projectId,
      amountMinor: repaymentInstallments.amountMinor,
      status: repaymentInstallments.status,
    })
    .from(repaymentInstallments)
    .where(eq(repaymentInstallments.id, installmentId));
  if (!installment) return;

  // NEVER distribute a `due` installment: the money has not been collected. This
  // enforces spec section 8 ("la distribution n'arrive jamais avant l'argent; seul
  // settled declenche"). It is reachable: failRepaymentSettlement resets pending ->
  // due but leaves repayment_ref populated, and the Task 6 webhook resolves by that
  // ref, so a stray `settled` callback carrying it must NOT credit uncollected money.
  // `pending` (normal settle) and `paid` (replay / straggler resume) both proceed, so
  // resumability is untouched.
  if (installment.status === "due") return;

  const projectId = installment.projectId;
  const A = installment.amountMinor;

  const [project] = await db
    .select({ raisedMinor: projects.raisedMinor })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) return;
  const R = project.raisedMinor;

  // The frozen investor set: only RELEASED investments contributed to raised_minor
  // (R). A funded project can still carry `failed` deposit rows that never advanced
  // the raise; including them would make sum(p_i) > R, drive `remainder` negative,
  // and over-distribute. Filtering to `released` is a tightening of the brief's
  // "all investments" that reduces to it under the spec's premise (a repaying
  // project has every investment released), and it keeps sum(p_i) === R exact.
  const invs = await db
    .select({ id: investments.id, amountMinor: investments.amountMinor, investorAccountId: investments.investorAccountId })
    .from(investments)
    .where(and(eq(investments.projectId, projectId), eq(investments.status, "released")));

  // Unreachable for a legitimate `repaying` project (it has released investments and
  // raised_minor > 0), but a no-op here beats a BigInt divide-by-zero or an empty-array
  // remainder walk if either ever holds.
  if (invs.length === 0 || R <= 0) return;

  // Deterministic pro-rata split. BigInt for the A * p_i product so the floor and
  // fractional part are exact even past 2^53 (plausible at FCFA magnitudes), which
  // makes sum(share_i) === A a proven invariant rather than an empirical one.
  const An = BigInt(A);
  const Rn = BigInt(R);
  const shares = invs.map((inv) => {
    const prod = An * BigInt(inv.amountMinor);
    return { inv, share: Number(prod / Rn), frac: Number(prod % Rn) };
  });
  const floorSum = shares.reduce((s, x) => s + x.share, 0);
  const remainder = A - floorSum;

  // Largest fractional remainder wins the leftover units; tiebreak investment.id
  // ASC for a replay-stable order. A zero-floor investor with a large fractional
  // part can legitimately collect a +1 unit, so this ranks BEFORE the share > 0
  // filter in the distribution loop.
  const order = [...shares].sort((a, b) => b.frac - a.frac || (a.inv.id < b.inv.id ? -1 : a.inv.id > b.inv.id ? 1 : 0));
  for (let k = 0; k < remainder; k += 1) {
    order[k]!.share += 1;
  }

  // Per-investment SHORT transactions, OUTSIDE any long lock (mirrors releaseProject:
  // no I/O held under a row lock). The UNIQUE(installment_id, investment_id) guard
  // makes each credit exactly-once: a replay/crash re-run inserts only the missing
  // distribution rows and skips the rest. A share of 0 distributes nothing. Each row
  // is isolated in try/catch: one poison investment (e.g. a missing wallet) must not
  // strand the rest, and the guard keeps a later retry idempotent.
  // Tracks whether any per-investor distribution failed (caught below). If so we
  // do NOT mark the installment paid, so a later replay resumes the stragglers.
  let anyFailed = false;
  for (const { inv, share } of shares) {
    if (share <= 0) continue;
    try {
      await db.transaction(async (tx) => {
        // Insert the distribution and credit the wallet in the SAME transaction so
        // they commit together. onConflictDoNothing + empty .returning() means the
        // row already existed (already distributed) -> skip the credit.
        const [dist] = await tx
          .insert(repaymentDistributions)
          .values({ installmentId, investmentId: inv.id, amountMinor: share })
          .onConflictDoNothing()
          .returning({ id: repaymentDistributions.id });
        if (!dist) return;

        const [w] = await tx
          .select({ id: wallets.id })
          .from(wallets)
          .where(eq(wallets.accountId, inv.investorAccountId));
        if (!w) throw new Error("investor wallet not found for repayment distribution");

        await tx.insert(walletEntries).values({
          walletId: w.id,
          type: "repayment",
          amountMinor: share,
          reference: dist.id,
        });
      });
    } catch (err) {
      anyFailed = true;
      // eslint-disable-next-line no-console
      console.error(`repayment distribution failed for investment ${inv.id}, continuing`, err);
    }
  }

  // If any distribution failed (a caught per-investor fault) OR the process crashed
  // mid-loop, do NOT mark the installment paid: leaving it `pending` keeps the resume
  // signal so a replay re-runs distribution for the stragglers (spec 7: an installment
  // is never `paid` before its distribution is complete). The per-investor UNIQUE guard
  // keeps that replay idempotent (already-credited rows are skipped).
  if (anyFailed) return;

  // Mark the installment paid only after a fully-successful distribution loop. Guarded
  // pending -> paid; a replay on an already-paid installment changes zero rows.
  await db
    .update(repaymentInstallments)
    .set({ status: "paid", settledAt: new Date() })
    .where(and(eq(repaymentInstallments.id, installmentId), eq(repaymentInstallments.status, "pending")));

  // Close the project once EVERY installment is `paid`. A project can be `repaying`
  // OR `defaulted` at this point (#7 lets a defaulted project be repaid), and a
  // fully-repaid project must reach the terminal `closed` state either way: the
  // sticky admin_defaulted flag governs the active repaying<->defaulted axis, not
  // the terminal close. Guarded so a replay closes exactly once; the length > 0
  // check stops an empty set (a project with no schedule) from closing on `[].every`.
  const all = await db
    .select({ status: repaymentInstallments.status })
    .from(repaymentInstallments)
    .where(eq(repaymentInstallments.projectId, projectId));
  if (all.length > 0 && all.every((i) => i.status === "paid")) {
    await db
      .update(projects)
      .set({ status: "closed", updatedAt: new Date() })
      .where(and(eq(projects.id, projectId), inArray(projects.status, ["repaying", "defaulted"])));
  }
}

// Mark a failed installment settlement. Guarded pending -> due (retryable by the
// porteur). Distributes nothing: a failed settlement never moved money. If the
// installment is not `pending` (already paid, or already due), the guard changes
// zero rows.
export async function failRepaymentSettlement(db: Db, args: { installmentId: string }): Promise<void> {
  await db
    .update(repaymentInstallments)
    .set({ status: "due" })
    .where(and(eq(repaymentInstallments.id, args.installmentId), eq(repaymentInstallments.status, "pending")));
}
