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
      const [ins] = await db.insert(repaymentInstallments).values({ projectId: p!.id, seq: 1,
        amountMinor: 193333, dueAt: new Date(), status: "due" }).returning();
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
});
