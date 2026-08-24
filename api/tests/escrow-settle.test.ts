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
      // Release completed (porteur wallet seeded, sole investment released), so
      // startRepayment (hooked at release completion) flips funded -> repaying.
      expect(p!.status).toBe("repaying");
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

  it("releases a wallet-source escrowed investment without ever calling the provider", async () => {
    await withTestDb(async (db: any) => {
      // A provider that fails the test if releaseEscrow is ever called: wallet
      // source must stay on the internal ledger.
      const payments = new MockPaymentProvider();
      let releaseCalls = 0;
      payments.releaseEscrow = async () => {
        releaseCalls += 1;
        return { ok: true, ref: "should-not-happen" };
      };
      const [investor] = await db.insert(accounts).values({ email: "wi@a.co", passwordHash: "x", firstName: "W", lastName: "I", country: "Togo", roles: ["investor"] }).returning();
      const [owner] = await db.insert(accounts).values({ email: "wo@a.co", passwordHash: "x", firstName: "W", lastName: "O", country: "Togo", roles: ["porteur"] }).returning();
      await db.insert(wallets).values({ accountId: owner.id });
      const [p] = await db.insert(projects).values({ ownerAccountId: owner.id, category: "commerce", title: "P", city: "L", description: "d", targetMinor: 50000, durationMonths: 6, roiPct: "16", fundsUsage: "u", cautionType: "a", status: "funded", raisedMinor: 50000 }).returning();
      const [inv] = await db.insert(investments).values({ projectId: p.id, investorAccountId: investor.id, amountMinor: 50000, source: "wallet", paymentRef: null, status: "escrowed" }).returning();

      await releaseProject(db, payments, { projectId: p.id });

      expect(releaseCalls).toBe(0);
      const [after] = await db.select().from(investments).where(eq(investments.id, inv.id));
      expect(after!.status).toBe("released");
      expect(after!.resolutionRef).toBeNull();
      const [w] = await db.select().from(wallets).where(eq(wallets.accountId, owner.id));
      const entries = await db.select().from(walletEntries).where(eq(walletEntries.walletId, w!.id));
      const disbursements = entries.filter((e: any) => e.type === "disbursement");
      expect(disbursements).toHaveLength(1);
      expect(disbursements[0]!.amountMinor).toBe(50000);
    });
  });

  it("leaves the investment escrowed and writes no disbursement when releaseEscrow returns not-ok", async () => {
    await withTestDb(async (db) => {
      const payments = new MockPaymentProvider();
      payments.releaseEscrow = async () => ({ ok: false, ref: "" });
      const { pid, invId, ownerId } = await seedPendingInvestment(db, { targetMinor: 50000, raisedMinor: 0, amount: 50000 });
      // Settle to funded; the provider declines the release. The settlement money
      // move (raised + funded) still stands; the investment stays escrowed for a
      // later retry, and no disbursement is written.
      await settleDeposit(db, payments, { depositRef: "dep-1" });
      const [inv] = await db.select().from(investments).where(eq(investments.id, invId));
      expect(inv!.status).toBe("escrowed");
      const [p] = await db.select().from(projects).where(eq(projects.id, pid));
      expect(p!.status).toBe("funded");
      const [w] = await db.select().from(wallets).where(eq(wallets.accountId, ownerId));
      const entries = await db.select().from(walletEntries).where(eq(walletEntries.walletId, w!.id));
      expect(entries.filter((e: any) => e.type === "disbursement")).toHaveLength(0);
    });
  });

  it("isolates a per-investment release failure so the others still release", async () => {
    await withTestDb(async (db: any) => {
      const payments = new MockPaymentProvider();
      const realRelease = payments.releaseEscrow.bind(payments);
      // Throw (like a real adapter timeout) only for the poison deposit; succeed
      // for the rest.
      payments.releaseEscrow = async (p) => {
        if (p.depositRef === "dep-poison") throw new Error("provider timeout");
        return realRelease(p);
      };
      const [investor] = await db.insert(accounts).values({ email: "ii@a.co", passwordHash: "x", firstName: "I", lastName: "I", country: "Togo", roles: ["investor"] }).returning();
      const [owner] = await db.insert(accounts).values({ email: "io@a.co", passwordHash: "x", firstName: "I", lastName: "O", country: "Togo", roles: ["porteur"] }).returning();
      await db.insert(wallets).values({ accountId: owner.id });
      const [p] = await db.insert(projects).values({ ownerAccountId: owner.id, category: "commerce", title: "P", city: "L", description: "d", targetMinor: 80000, durationMonths: 6, roiPct: "16", fundsUsage: "u", cautionType: "a", status: "funded", raisedMinor: 80000 }).returning();
      const [poison] = await db.insert(investments).values({ projectId: p.id, investorAccountId: investor.id, amountMinor: 30000, source: "payment", paymentRef: "dep-poison", status: "escrowed" }).returning();
      const [ok] = await db.insert(investments).values({ projectId: p.id, investorAccountId: investor.id, amountMinor: 50000, source: "payment", paymentRef: "dep-ok", status: "escrowed" }).returning();

      await releaseProject(db, payments, { projectId: p.id });

      const [poisonAfter] = await db.select().from(investments).where(eq(investments.id, poison.id));
      expect(poisonAfter!.status).toBe("escrowed");
      const [okAfter] = await db.select().from(investments).where(eq(investments.id, ok.id));
      expect(okAfter!.status).toBe("released");
      const [w] = await db.select().from(wallets).where(eq(wallets.accountId, owner.id));
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
