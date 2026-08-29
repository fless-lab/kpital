import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "./helpers/db";
import {
  accounts,
  projects,
  investments,
  wallets,
  walletEntries,
  repaymentInstallments,
  repaymentPayments,
  repaymentApplications,
  repaymentDistributions,
} from "../src/db/schema";
import { distributePortion } from "../src/modules/repayment/distribute";

// Seed a `repaying` project with a frozen (all released) investor set, one
// installment, one settled payment, and one application whose amountMinor is the
// portion to distribute. Mirrors repayment-settle seeding, plus the #8 payment +
// application rows. Each investor gets a wallet so distribution can credit.
async function seedApplication(db: any, portion: number) {
  const investorAmounts = [500000, 300000, 200000];
  const raised = investorAmounts.reduce((s, a) => s + a, 0);

  const [owner] = await db
    .insert(accounts)
    .values({ email: "o@a.co", passwordHash: "x", firstName: "O", lastName: "A", country: "Togo", roles: ["porteur"] })
    .returning();
  await db.insert(wallets).values({ accountId: owner.id });
  const [p] = await db
    .insert(projects)
    .values({
      ownerAccountId: owner.id,
      category: "commerce",
      title: "P",
      city: "L",
      description: "d",
      targetMinor: raised,
      durationMonths: 6,
      roiPct: "16",
      fundsUsage: "u",
      cautionType: "a",
      status: "repaying",
      raisedMinor: raised,
    })
    .returning();

  const investors: { accountId: string; walletId: string; invId: string; amount: number }[] = [];
  for (let i = 0; i < investorAmounts.length; i += 1) {
    const [acc] = await db
      .insert(accounts)
      .values({ email: `i${i}@a.co`, passwordHash: "x", firstName: "I", lastName: String(i), country: "Togo", roles: ["investor"] })
      .returning();
    const [w] = await db.insert(wallets).values({ accountId: acc!.id }).returning();
    const [inv] = await db
      .insert(investments)
      .values({ projectId: p.id, investorAccountId: acc!.id, amountMinor: investorAmounts[i], source: "payment", paymentRef: `d${i}`, status: "released" })
      .returning();
    investors.push({ accountId: acc!.id, walletId: w.id, invId: inv.id, amount: investorAmounts[i]! });
  }

  const [ins] = await db
    .insert(repaymentInstallments)
    .values({ projectId: p.id, seq: 1, amountMinor: 200000, dueAt: new Date(), status: "pending", repaymentRef: "r1" })
    .returning();

  const [pay] = await db
    .insert(repaymentPayments)
    .values({ projectId: p.id, amountMinor: portion, ref: "pay1", status: "settled" })
    .returning();
  const [app] = await db
    .insert(repaymentApplications)
    .values({ paymentId: pay.id, installmentId: ins.id, amountMinor: portion })
    .returning();

  return { pid: p.id, investors, installmentId: ins.id, applicationId: app.id };
}

describe("distributePortion", () => {
  it("distributes a portion pro-rata with exact conservation", async () => {
    await withTestDb(async (db) => {
      const portion = 193333;
      const { pid, investors, installmentId, applicationId } = await seedApplication(db, portion);

      await db.transaction(async (tx) => {
        await distributePortion(tx as any, { projectId: pid, applicationId, installmentId, amountMinor: portion });
      });

      // A = 193333, R = 1_000_000. floors: 96666 / 57999 / 38666 (sum 193331);
      // fracs 500000 / 900000 / 600000 -> the +1 units go to the 300k and 200k
      // investors (largest fractional remainder). Final 96666 / 58000 / 38667.
      const expected = [96666, 58000, 38667];
      let sum = 0;
      for (let i = 0; i < investors.length; i += 1) {
        const inv = investors[i]!;
        const dists = await db
          .select()
          .from(repaymentDistributions)
          .where(and(eq(repaymentDistributions.applicationId, applicationId), eq(repaymentDistributions.investmentId, inv.invId)));
        expect(dists).toHaveLength(1);
        expect(dists[0]!.amountMinor).toBe(expected[i]);
        expect(dists[0]!.applicationId).toBe(applicationId); // application-scoped row
        expect(dists[0]!.installmentId).toBe(installmentId);

        const entries = await db.select().from(walletEntries).where(eq(walletEntries.walletId, inv.walletId));
        expect(entries).toHaveLength(1);
        expect(entries[0]!.type).toBe("repayment"); // wallet credited as a repayment
        expect(entries[0]!.amountMinor).toBe(expected[i]);
        // wallet entry references the distribution row it was born from.
        expect(entries[0]!.reference).toBe(dists[0]!.id);
        sum += entries[0]!.amountMinor;
      }
      expect(sum).toBe(portion); // conservation: sum(distributed) == portion exactly

      const all = await db
        .select()
        .from(repaymentDistributions)
        .where(eq(repaymentDistributions.applicationId, applicationId));
      expect(all).toHaveLength(3);
      expect(all.reduce((s: number, d: any) => s + d.amountMinor, 0)).toBe(portion);
    });
  });

  it("is tx-scoped: a rollback after distributePortion leaves no rows", async () => {
    await withTestDb(async (db) => {
      const portion = 193333;
      const { pid, applicationId, installmentId } = await seedApplication(db, portion);

      // distributePortion writes ONLY within the passed tx (no inner sub-transaction).
      // A throw after it must roll back every distribution + wallet entry it wrote.
      await expect(
        db.transaction(async (tx) => {
          await distributePortion(tx as any, { projectId: pid, applicationId, installmentId, amountMinor: portion });
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");

      const dists = await db
        .select()
        .from(repaymentDistributions)
        .where(eq(repaymentDistributions.applicationId, applicationId));
      expect(dists).toHaveLength(0); // rolled back with the caller's tx
      const entries = await db.select().from(walletEntries).where(eq(walletEntries.type, "repayment"));
      expect(entries).toHaveLength(0);
    });
  });

  it("THROWS (never silently returns) when the project has no released investors", async () => {
    // A silent return here would let the caller settle the payment and mark the
    // installment paid with nobody credited (silent money loss). distributePortion
    // must throw so the atomic settle rolls back and the payment stays pending.
    await withTestDb(async (db) => {
      const [owner] = await db.insert(accounts).values({ email: "o@a.co", passwordHash: "x",
        firstName: "O", lastName: "A", country: "Togo", roles: ["porteur"] }).returning();
      // A repaying project with raisedMinor > 0 but NO released investment (artificial:
      // the normal flow guarantees released investors, this exercises the guard).
      const [p] = await db.insert(projects).values({ ownerAccountId: owner!.id, category: "commerce",
        title: "P", city: "L", description: "d", targetMinor: 100000, durationMonths: 6, roiPct: "16",
        fundsUsage: "u", cautionType: "a", status: "repaying", raisedMinor: 100000 }).returning();
      const [ins] = await db.insert(repaymentInstallments).values({ projectId: p!.id, seq: 1, amountMinor: 100000, dueAt: new Date() }).returning();
      const [pay] = await db.insert(repaymentPayments).values({ projectId: p!.id, amountMinor: 100000, ref: "mp-x", status: "pending" }).returning();
      const [app] = await db.insert(repaymentApplications).values({ paymentId: pay!.id, installmentId: ins!.id, amountMinor: 100000 }).returning();

      await expect(
        db.transaction(async (tx) => {
          await distributePortion(tx as any, { projectId: p!.id, applicationId: app!.id, installmentId: ins!.id, amountMinor: 100000 });
        }),
      ).rejects.toThrow(/no released investors/);
    });
  });
});
