import { eq, desc, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { wallets, walletEntries } from "../../db/schema";
import type { PaymentProvider, PayoutMethod } from "../../lib/payments";

export class WalletNotFoundError extends Error {
  constructor() {
    super("wallet_not_found");
    this.name = "WalletNotFoundError";
  }
}

export class InsufficientFundsError extends Error {
  constructor() {
    super("insufficient_funds");
    this.name = "InsufficientFundsError";
  }
}

export class PayoutFailedError extends Error {
  constructor() {
    super("payout_failed");
    this.name = "PayoutFailedError";
  }
}

async function walletIdFor(db: Db, accountId: string): Promise<string> {
  const [w] = await db.select({ id: wallets.id }).from(wallets).where(eq(wallets.accountId, accountId));
  if (!w) throw new WalletNotFoundError();
  return w.id;
}

// Balance is always the ledger sum — there is no mutable balance column.
// pg returns sum(bigint) as numeric (a string), so coerce with Number().
export async function balanceForWallet(db: Db, walletId: string): Promise<number> {
  const [r] = await db
    .select({ bal: sql<string>`coalesce(sum(${walletEntries.amountMinor}), 0)` })
    .from(walletEntries)
    .where(eq(walletEntries.walletId, walletId));
  return Number(r?.bal ?? 0);
}

export async function getBalance(db: Db, accountId: string): Promise<number> {
  const wid = await walletIdFor(db, accountId);
  return balanceForWallet(db, wid);
}

export type WalletEntry = typeof walletEntries.$inferSelect;

export async function listEntries(db: Db, accountId: string): Promise<WalletEntry[]> {
  const wid = await walletIdFor(db, accountId);
  return db
    .select()
    .from(walletEntries)
    .where(eq(walletEntries.walletId, wid))
    // Secondary sort on id keeps ordering deterministic when several entries
    // share a transaction-start now() createdAt.
    .orderBy(desc(walletEntries.createdAt), desc(walletEntries.id));
}

// Positive ledger entry. Used to fund a wallet (e.g. a repayment credit).
export async function credit(
  db: Db,
  p: { accountId: string; amountMinor: number; type: "repayment" | "reinvestment" | "adjustment"; reference?: string },
): Promise<{ entryId: string }> {
  const wid = await walletIdFor(db, p.accountId);
  const [e] = await db
    .insert(walletEntries)
    .values({ walletId: wid, type: p.type, amountMinor: p.amountMinor, reference: p.reference })
    .returning({ id: walletEntries.id });
  if (!e) throw new Error("wallet_entry insert returned no row");
  return { entryId: e.id };
}

// Overdraw-safe withdrawal. The wallet row is locked FOR UPDATE before the
// balance is summed so two concurrent withdrawals cannot both pass the check
// and overdraw: the second waiter blocks until the first commits, then re-sums
// and sees the debit. NOTE: the lock lives on the `wallet` row while the balance
// is SUM(wallet_entry) — this is only safe as long as EVERY balance-reducing
// writer (future negative reinvestment, etc.) takes this same lock first.
export async function withdraw(
  db: Db,
  payments: PaymentProvider,
  p: { accountId: string; amountMinor: number; method: PayoutMethod },
): Promise<{ entryId: string }> {
  return db.transaction(async (tx) => {
    const [w] = await tx.select({ id: wallets.id }).from(wallets).where(eq(wallets.accountId, p.accountId)).for("update");
    if (!w) throw new WalletNotFoundError();

    const balance = await balanceForWallet(tx as unknown as Db, w.id);
    if (p.amountMinor <= 0 || p.amountMinor > balance) throw new InsufficientFundsError();

    const res = await payments.payout({ accountId: p.accountId, amountMinor: p.amountMinor, method: p.method });
    if (!res.ok) throw new PayoutFailedError();

    const [e] = await tx
      .insert(walletEntries)
      .values({ walletId: w.id, type: "withdrawal", amountMinor: -p.amountMinor, reference: res.ref })
      .returning({ id: walletEntries.id });
    if (!e) throw new Error("wallet_entry insert returned no row");
    return { entryId: e.id };
  });
}
