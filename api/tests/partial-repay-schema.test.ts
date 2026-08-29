import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "./helpers/db";
import { accounts, projects, repaymentInstallments, repaymentPayments, repaymentApplications } from "../src/db/schema";

describe("partial repayment schema", () => {
  it("installment has paid_minor default 0, and payment + application tables exist", async () => {
    await withTestDb(async (db) => {
      const [o] = await db.insert(accounts).values({ email: "o@a.co", passwordHash: "x",
        firstName: "O", lastName: "A", country: "Togo", roles: ["porteur"] }).returning();
      const [p] = await db.insert(projects).values({ ownerAccountId: o!.id, category: "commerce",
        title: "P", city: "L", description: "d", targetMinor: 1000000, durationMonths: 6, roiPct: "16",
        fundsUsage: "u", cautionType: "a", status: "repaying", raisedMinor: 1000000 }).returning();
      const [ins] = await db.insert(repaymentInstallments).values({ projectId: p!.id, seq: 1,
        amountMinor: 100000, dueAt: new Date() }).returning();
      expect(ins!.paidMinor).toBe(0);
      const [pay] = await db.insert(repaymentPayments).values({ projectId: p!.id, amountMinor: 50000, ref: "mp-1" }).returning();
      expect(pay!.status).toBe("pending");
      const [app] = await db.insert(repaymentApplications).values({ paymentId: pay!.id, installmentId: ins!.id, amountMinor: 50000 }).returning();
      expect(app!.amountMinor).toBe(50000);
    });
  });
  it("rejects paid_minor above amount_minor (CHECK)", async () => {
    await withTestDb(async (db) => {
      const [o] = await db.insert(accounts).values({ email: "o@a.co", passwordHash: "x",
        firstName: "O", lastName: "A", country: "Togo", roles: ["porteur"] }).returning();
      const [p] = await db.insert(projects).values({ ownerAccountId: o!.id, category: "commerce",
        title: "P", city: "L", description: "d", targetMinor: 1000000, durationMonths: 6, roiPct: "16",
        fundsUsage: "u", cautionType: "a", status: "repaying", raisedMinor: 1000000 }).returning();
      await expect(
        db.insert(repaymentInstallments).values({ projectId: p!.id, seq: 1, amountMinor: 100000, dueAt: new Date(), paidMinor: 100001 }),
      ).rejects.toThrow();
    });
  });
  it("rejects two payments sharing a non-null ref (partial unique)", async () => {
    await withTestDb(async (db) => {
      const [o] = await db.insert(accounts).values({ email: "o@a.co", passwordHash: "x",
        firstName: "O", lastName: "A", country: "Togo", roles: ["porteur"] }).returning();
      const [p] = await db.insert(projects).values({ ownerAccountId: o!.id, category: "commerce",
        title: "P", city: "L", description: "d", targetMinor: 1000000, durationMonths: 6, roiPct: "16",
        fundsUsage: "u", cautionType: "a", status: "repaying", raisedMinor: 1000000 }).returning();
      await db.insert(repaymentPayments).values({ projectId: p!.id, amountMinor: 50000, ref: "dup" });
      await expect(db.insert(repaymentPayments).values({ projectId: p!.id, amountMinor: 60000, ref: "dup" })).rejects.toThrow();
    });
  });
});
