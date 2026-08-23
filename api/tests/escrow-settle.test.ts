import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "./helpers/db";
import { MockPaymentProvider } from "../src/lib/payments";
import { accounts, projects, investments, wallets, walletEntries } from "../src/db/schema";
import { settleDeposit, failDeposit, releaseProject } from "../src/modules/escrow/service";

async function seedPendingInvestment(db: any, opts: { targetMinor?: number; raisedMinor?: number; amount?: number } = {}) {
  const [inv1] = await db.insert(accounts).values({ email: "i@a.co", passwordHash: "x", firstName: "I", lastName: "A", country: "Togo", roles: ["investor"] }).returning();
  const [owner] = await db.insert(accounts).values({ email: "o@a.co", passwordHash: "x", firstName: "O", lastName: "A", country: "Togo", roles: ["porteur"] }).returning();
  await db.insert(wallets).values({ accountId: owner.id }); // porteur wallet for disbursement
  const [p] = await db.insert(projects).values({ ownerAccountId: owner.id, category: "commerce", title: "P", city: "L", description: "d", targetMinor: opts.targetMinor ?? 1000000, durationMonths: 6, roiPct: "16", fundsUsage: "u", cautionType: "a", status: "collecting", raisedMinor: opts.raisedMinor ?? 0 }).returning();
  const [inv] = await db.insert(investments).values({ projectId: p.id, investorAccountId: inv1.id, amountMinor: opts.amount ?? 50000, source: "payment", paymentRef: "dep-1", status: "pending" }).returning();
  return { pid: p.id, invId: inv.id, ownerId: owner.id };
}

describe("escrow settle/fail/release", () => {
  it("settling a pending deposit escrows it and advances raised_minor", async () => {
    await withTestDb(async (db) => {
      const payments = new MockPaymentProvider();
      const { pid, invId } = await seedPendingInvestment(db);
      const res = await settleDeposit(db, payments, { depositRef: "dep-1" });
      expect(res.applied).toBe(true);
      const [inv] = await db.select().from(investments).where(eq(investments.id, invId));
      expect(inv!.status).toBe("escrowed");
      const [p] = await db.select().from(projects).where(eq(projects.id, pid));
      expect(p!.raisedMinor).toBe(50000);
    });
  });

  it("settling twice is idempotent (raised advances once)", async () => {
    await withTestDb(async (db) => {
      const payments = new MockPaymentProvider();
      const { pid } = await seedPendingInvestment(db);
      await settleDeposit(db, payments, { depositRef: "dep-1" });
      const second = await settleDeposit(db, payments, { depositRef: "dep-1" });
      expect(second.applied).toBe(false);
      const [p] = await db.select().from(projects).where(eq(projects.id, pid));
      expect(p!.raisedMinor).toBe(50000);
    });
  });

  it("failing a pending deposit marks it failed and never touches raised", async () => {
    await withTestDb(async (db) => {
      const { pid, invId } = await seedPendingInvestment(db);
      const res = await failDeposit(db, { depositRef: "dep-1" });
      expect(res.applied).toBe(true);
      const [inv] = await db.select().from(investments).where(eq(investments.id, invId));
      expect(inv!.status).toBe("failed");
      const [p] = await db.select().from(projects).where(eq(projects.id, pid));
      expect(p!.raisedMinor).toBe(0);
    });
  });

  it("settling the final ticket funds the project and releases escrow to the porteur wallet", async () => {
    await withTestDb(async (db) => {
      const payments = new MockPaymentProvider();
      const { pid, invId, ownerId } = await seedPendingInvestment(db, { targetMinor: 50000, raisedMinor: 0, amount: 50000 });
      await settleDeposit(db, payments, { depositRef: "dep-1" });
      const [p] = await db.select().from(projects).where(eq(projects.id, pid));
      expect(p!.status).toBe("funded");
      const [inv] = await db.select().from(investments).where(eq(investments.id, invId));
      expect(inv!.status).toBe("released");
      const [w] = await db.select().from(wallets).where(eq(wallets.accountId, ownerId));
      const entries = await db.select().from(walletEntries).where(eq(walletEntries.walletId, w!.id));
      expect(entries.find((e: any) => e.type === "disbursement")?.amountMinor).toBe(50000);
    });
  });

  it("re-running releaseProject after funding credits the porteur exactly once (guarded)", async () => {
    await withTestDb(async (db) => {
      const payments = new MockPaymentProvider();
      const { pid, ownerId } = await seedPendingInvestment(db, { targetMinor: 50000, raisedMinor: 0, amount: 50000 });
      await settleDeposit(db, payments, { depositRef: "dep-1" });
      // Second explicit release must be a no-op: the guard (escrowed -> released)
      // matches nothing, so no second disbursement and no new provider ref.
      await releaseProject(db, payments, { projectId: pid });
      const [w] = await db.select().from(wallets).where(eq(wallets.accountId, ownerId));
      const entries = await db.select().from(walletEntries).where(eq(walletEntries.walletId, w!.id));
      const disbursements = entries.filter((e: any) => e.type === "disbursement");
      expect(disbursements).toHaveLength(1);
      expect(disbursements[0]!.amountMinor).toBe(50000);
    });
  });

  it("returns not-found for an unknown depositRef", async () => {
    await withTestDb(async (db) => {
      const payments = new MockPaymentProvider();
      const res = await settleDeposit(db, payments, { depositRef: "nope" });
      expect(res.found).toBe(false);
    });
  });
});
