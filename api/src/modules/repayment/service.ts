import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { projects, investments, repaymentInstallments } from "../../db/schema";

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
