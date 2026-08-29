import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  projects,
  investments,
  repaymentDistributions,
  wallets,
  walletEntries,
} from "../../db/schema";

// The transaction handle passed to a db.transaction callback. Derived from Db so
// this module never imports anything runtime from service (the pro-rata math lives
// here, not there). Same shape as service.ts's Tx.
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// Distribute one applied portion pro-rata across a project's released investors,
// WITHIN the caller's transaction `tx`. The share math is byte-identical to the
// original #6 distribution (released-only investor set, BigInt A*p_i product, floor
// + largest-remainder with investment.id ASC tiebreak), so sum(share_i) === A is a
// proven invariant (money-critical invariant (c)). This writes every distribution +
// wallet credit in the SAME passed transaction (no per-investor sub-transaction, no
// onConflictDoNothing): idempotency is the caller's, provided by its single atomic
// settlePayment plus the payment status guard. A missing wallet throws and aborts
// the caller's transaction (no partial credit).
export async function distributePortion(
  tx: Tx,
  args: { projectId: string; applicationId: string; installmentId: string; amountMinor: number },
): Promise<void> {
  const A = args.amountMinor;

  const [project] = await tx
    .select({ raisedMinor: projects.raisedMinor })
    .from(projects)
    .where(eq(projects.id, args.projectId));
  // Contract: distributePortion distributes the FULL portion or throws. It must
  // never return silently, because the caller (settlePayment) has already inserted
  // the application row and will bump paid_minor / flip the installment to `paid`
  // in the same transaction. A silent no-op here would settle the payment (porteur
  // debited, installment paid) with NObody credited, and no error: silent money
  // loss. Throwing rolls back the whole atomic settle and leaves the payment
  // `pending` (retryable). Same failure discipline as the missing-wallet throw below.
  if (!project) throw new Error("project not found for repayment distribution");
  const R = project.raisedMinor;

  // The frozen investor set: only RELEASED investments contributed to raised_minor
  // (R). A funded project can still carry `failed` deposit rows that never advanced
  // the raise; including them would make sum(p_i) > R, drive `remainder` negative,
  // and over-distribute. Filtering to `released` keeps sum(p_i) === R exact.
  const invs = await tx
    .select({ id: investments.id, amountMinor: investments.amountMinor, investorAccountId: investments.investorAccountId })
    .from(investments)
    .where(and(eq(investments.projectId, args.projectId), eq(investments.status, "released")));

  // Unreachable for a legitimate `repaying` project (it has released investments and
  // raised_minor > 0). But if it ever holds, THROW (do not silently return): the
  // caller has already recorded the application and is about to mark the installment
  // paid, so a silent skip would settle the portion with no investor credited and no
  // signal. The throw aborts the atomic settle (payment stays `pending`), which is
  // the only money-safe outcome.
  if (invs.length === 0 || R <= 0) {
    throw new Error("no released investors or non-positive raise for repayment distribution");
  }

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

  // Insert each distribution and credit the wallet in the caller's transaction so
  // they commit (or roll back) together with the settle. A share of 0 distributes
  // nothing. A missing wallet throws and aborts the whole settle: no partial credit.
  for (const { inv, share } of shares) {
    if (share <= 0) continue;

    const [dist] = await tx
      .insert(repaymentDistributions)
      .values({ applicationId: args.applicationId, installmentId: args.installmentId, investmentId: inv.id, amountMinor: share })
      .returning({ id: repaymentDistributions.id });

    const [w] = await tx
      .select({ id: wallets.id })
      .from(wallets)
      .where(eq(wallets.accountId, inv.investorAccountId));
    if (!w) throw new Error("investor wallet not found for repayment distribution");

    await tx.insert(walletEntries).values({
      walletId: w.id,
      type: "repayment",
      amountMinor: share,
      reference: dist!.id,
    });
  }
}
