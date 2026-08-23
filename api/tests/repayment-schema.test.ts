import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "./helpers/db";
import { accounts, projects, investments, repaymentInstallments, repaymentDistributions } from "../src/db/schema";

describe("repayment schema", () => {
  it("records an installment schedule and a distribution with a unique guard", async () => {
    await withTestDb(async (db) => {
      const [owner] = await db.insert(accounts).values({ email: "o@a.co", passwordHash: "x",
        firstName: "O", lastName: "A", country: "Togo", roles: ["porteur"] }).returning();
      const [inv0] = await db.insert(accounts).values({ email: "i@a.co", passwordHash: "x",
        firstName: "I", lastName: "A", country: "Togo", roles: ["investor"] }).returning();
      const [p] = await db.insert(projects).values({ ownerAccountId: owner!.id, category: "commerce",
        title: "P", city: "L", description: "d", targetMinor: 1000000, durationMonths: 6, roiPct: "16",
        fundsUsage: "u", cautionType: "a", status: "repaying", raisedMinor: 1000000 }).returning();
      const [inv] = await db.insert(investments).values({ projectId: p!.id, investorAccountId: inv0!.id,
        amountMinor: 1000000, source: "payment", paymentRef: "d1", status: "released" }).returning();
      // No `status` passed: this asserts the column DEFAULT 'due' that Task 3's
      // generateSchedule relies on (it inserts installments without a status).
      const [ins] = await db.insert(repaymentInstallments).values({ projectId: p!.id, seq: 1,
        amountMinor: 193333, dueAt: new Date(), repaymentRef: "r1" }).returning();
      expect(ins!.status).toBe("due");
      const [dist] = await db.insert(repaymentDistributions).values({ installmentId: ins!.id,
        investmentId: inv!.id, amountMinor: 193333 }).returning();
      expect(dist!.amountMinor).toBe(193333);
      // The unique guard blocks a second distribution for the same (installment, investment).
      await expect(
        db.insert(repaymentDistributions).values({ installmentId: ins!.id, investmentId: inv!.id, amountMinor: 1 }),
      ).rejects.toThrow();
    });
  });

  it("rejects two installments sharing a non-null repayment_ref", async () => {
    // Separate `it` from the null-ref case: the expected unique violation aborts
    // the withTestDb transaction, so no further statements can run in this block.
    await withTestDb(async (db) => {
      const [owner] = await db.insert(accounts).values({ email: "o@a.co", passwordHash: "x",
        firstName: "O", lastName: "A", country: "Togo", roles: ["porteur"] }).returning();
      const [p] = await db.insert(projects).values({ ownerAccountId: owner!.id, category: "commerce",
        title: "P", city: "L", description: "d", targetMinor: 1000000, durationMonths: 6, roiPct: "16",
        fundsUsage: "u", cautionType: "a", status: "repaying", raisedMinor: 1000000 }).returning();
      await db.insert(repaymentInstallments).values({ projectId: p!.id, seq: 1,
        amountMinor: 100000, dueAt: new Date(), repaymentRef: "dup-ref" });
      await expect(
        db.insert(repaymentInstallments).values({ projectId: p!.id, seq: 2,
          amountMinor: 100000, dueAt: new Date(), repaymentRef: "dup-ref" }),
      ).rejects.toThrow();
    });
  });

  it("allows many installments with a null repayment_ref (partial index)", async () => {
    await withTestDb(async (db) => {
      const [owner] = await db.insert(accounts).values({ email: "o@a.co", passwordHash: "x",
        firstName: "O", lastName: "A", country: "Togo", roles: ["porteur"] }).returning();
      const [p] = await db.insert(projects).values({ ownerAccountId: owner!.id, category: "commerce",
        title: "P", city: "L", description: "d", targetMinor: 1000000, durationMonths: 6, roiPct: "16",
        fundsUsage: "u", cautionType: "a", status: "repaying", raisedMinor: 1000000 }).returning();
      await db.insert(repaymentInstallments).values({ projectId: p!.id, seq: 1,
        amountMinor: 100000, dueAt: new Date(), repaymentRef: null });
      await db.insert(repaymentInstallments).values({ projectId: p!.id, seq: 2,
        amountMinor: 100000, dueAt: new Date(), repaymentRef: null });
      const rows = await db.select().from(repaymentInstallments).where(eq(repaymentInstallments.projectId, p!.id));
      expect(rows).toHaveLength(2);
    });
  });
});
