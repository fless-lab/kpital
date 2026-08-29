import { and, asc, eq, inArray, lt, ne } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  projects,
  investments,
  repaymentInstallments,
  repaymentPayments,
  repaymentApplications,
} from "../../db/schema";
import { distributePortion } from "./distribute";

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
// /repay carries the SAME key so the provider dedupes rather than collecting the
// versement twice. Keyed by the PAYMENT id (the #8 collection unit), never a
// timestamp (mirrors escrow idemKey).
export function repayKey(paymentId: string): string {
  return `repay:${paymentId}`;
}

// Apply a settled repayment payment to the schedule in ONE atomic transaction
// under the project lock (spec section 3). The payment amount cascades over the
// non-`paid` installments in `seq` order: each portion is persisted in
// repayment_application, distributed pro-rata via distributePortion, and added to
// the installment's paid_minor (flipping it to `paid` at equality). The payment is
// then flipped `pending -> settled`, and the project closes if fully repaid or is
// auto-lifted out of `defaulted` otherwise.
//
// MONEY CRUX (invariant d). The allocation is decided ONCE, inside this single
// transaction, and the whole cascade (applications + distributions + paid_minor
// bumps + payment flip + project transition) commits or rolls back as a unit. The
// entry guard `payment.status !== "pending" -> return` makes a replay (webhook
// re-delivery, re-call) a wholesale no-op: it never recomputes the allocation from
// mutable paid_minor, so it can never over-apply (a crash mid-cascade rolls back
// everything, leaving the payment `pending` for a clean retry, never a partial
// state). `A <= project remaining` (enforced at /repay) plus one-pending-payment
// guarantee the cascade absorbs the whole amount; the post-loop `reste !== 0`
// throw makes conservation invariant (a) unreachable in code, not just in prose.
//
// graceCutoffMs: the #7 grace boundary (Date.now() - graceDays*86400000), passed
// by the caller (the route/webhook has app.config, this module does not). The
// auto-lift treats an installment as still-delinquent when
// `paid_minor < amount_minor AND due_at < graceCutoff`.
export async function settlePayment(
  db: Db,
  args: { paymentId: string; graceCutoffMs: number },
): Promise<void> {
  const { paymentId, graceCutoffMs } = args;

  await db.transaction(async (tx) => {
    // Resolve the payment's project id first (a cheap read, just to know what to
    // lock). The status is NOT trusted yet: it is re-read AFTER the lock below.
    const [pre] = await tx.select({ projectId: repaymentPayments.projectId }).from(repaymentPayments).where(eq(repaymentPayments.id, paymentId));
    if (!pre) return;
    const projectId = pre.projectId;

    // Lock the project row FOR UPDATE BEFORE reading the payment status: serialises
    // this settle against a concurrent /repay and against another settle of the same
    // payment/project. Two concurrent webhook deliveries for one ref both block here;
    // the loser proceeds only after the winner commits, then re-reads the payment as
    // `settled` and no-ops. Reading the status before the lock (on a snapshot taken
    // pre-block) would let the loser cascade a second time (invariant d, concurrent
    // form). Lock-then-read mirrors startRepayment.
    const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
    if (!project) return;

    // Idempotent entry, re-read UNDER the lock: a `settled` payment is already
    // applied (no-op); a `failed` payment never applies. Only a `pending` payment
    // cascades. Under READ COMMITTED this SELECT sees the winner's committed flip.
    const [payment] = await tx.select().from(repaymentPayments).where(eq(repaymentPayments.id, paymentId));
    if (!payment || payment.status !== "pending") return;

    // Non-`paid` installments in seq order. The `portion <= 0` guard below skips a
    // row that is already full (paid_minor == amount_minor) but not yet flipped, so
    // this status-based load stays consistent with the paid_minor-based math.
    const installments = await tx
      .select()
      .from(repaymentInstallments)
      .where(and(eq(repaymentInstallments.projectId, projectId), ne(repaymentInstallments.status, "paid")))
      .orderBy(asc(repaymentInstallments.seq));

    let reste = payment.amountMinor;
    for (const ins of installments) {
      if (reste <= 0) break;
      const portion = Math.min(reste, ins.amountMinor - ins.paidMinor);
      if (portion <= 0) continue;

      const [application] = await tx
        .insert(repaymentApplications)
        .values({ paymentId, installmentId: ins.id, amountMinor: portion })
        .returning({ id: repaymentApplications.id });

      await distributePortion(tx, { projectId, applicationId: application!.id, installmentId: ins.id, amountMinor: portion });

      const newPaid = ins.paidMinor + portion;
      await tx
        .update(repaymentInstallments)
        .set(newPaid === ins.amountMinor ? { paidMinor: newPaid, status: "paid", settledAt: new Date() } : { paidMinor: newPaid })
        .where(eq(repaymentInstallments.id, ins.id));

      reste -= portion;
    }

    // Conservation invariant (a), enforced in code: the whole payment MUST be
    // applied. `A <= remaining` (cap at /repay) plus one-pending-payment make this
    // unreachable; if it ever held, the throw rolls the transaction back (a stuck
    // `pending` payment is safer than an unaccounted-for one).
    if (reste !== 0) {
      throw new Error(`settlePayment: unallocated remainder ${reste} for payment ${paymentId} (invariant a)`);
    }

    // Guarded pending -> settled. FOR UPDATE already serialises this; the guard
    // keeps the flip single-shot across any replay path.
    await tx
      .update(repaymentPayments)
      .set({ status: "settled", settledAt: new Date() })
      .where(and(eq(repaymentPayments.id, paymentId), eq(repaymentPayments.status, "pending")));

    // Close once EVERY installment is `paid` (from repaying OR defaulted: a fully
    // repaid project is terminal either way, #7). Guarded so a replay closes once;
    // the length check stops an empty schedule from closing on `[].every`.
    const all = await tx
      .select({ status: repaymentInstallments.status })
      .from(repaymentInstallments)
      .where(eq(repaymentInstallments.projectId, projectId));
    if (all.length > 0 && all.every((i) => i.status === "paid")) {
      await tx
        .update(projects)
        .set({ status: "closed", updatedAt: new Date() })
        .where(and(eq(projects.id, projectId), inArray(projects.status, ["repaying", "defaulted"])));
      return;
    }

    // Auto-lift #7: a schedule-defaulted project (admin_defaulted = false) whose
    // grace-exceeded delinquency is now cleared recovers to `repaying`. Delinquency
    // is keyed on paid_minor (a partially paid installment is still delinquent). A
    // sticky admin default is only cleared by /undefault, so it is excluded here.
    if (project.status === "defaulted" && !project.adminDefaulted) {
      const [blocker] = await tx
        .select({ id: repaymentInstallments.id })
        .from(repaymentInstallments)
        .where(
          and(
            eq(repaymentInstallments.projectId, projectId),
            lt(repaymentInstallments.paidMinor, repaymentInstallments.amountMinor),
            lt(repaymentInstallments.dueAt, new Date(graceCutoffMs)),
          ),
        )
        .limit(1);
      if (!blocker) {
        await tx
          .update(projects)
          .set({ status: "repaying", defaultedAt: null, updatedAt: new Date() })
          .where(and(eq(projects.id, projectId), eq(projects.status, "defaulted"), eq(projects.adminDefaulted, false)));
      }
    }
  });
}

// Mark a failed repayment collection. Guarded `pending -> failed`: applies nothing
// (a failed collection never moved money). A payment already `settled` or `failed`
// is untouched by the guard (a replay changes zero rows).
export async function failPayment(db: Db, args: { paymentId: string }): Promise<void> {
  await db
    .update(repaymentPayments)
    .set({ status: "failed" })
    .where(and(eq(repaymentPayments.id, args.paymentId), eq(repaymentPayments.status, "pending")));
}
