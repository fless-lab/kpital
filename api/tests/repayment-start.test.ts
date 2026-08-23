import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "./helpers/db";
import { accounts, projects, investments, wallets, repaymentInstallments } from "../src/db/schema";
import { startRepayment } from "../src/modules/repayment/service";

async function seedFunded(db: any, opts: { withEscrowedStraggler?: boolean } = {}) {
  const [owner] = await db.insert(accounts).values({ email: "o@a.co", passwordHash: "x", firstName: "O", lastName: "A", country: "Togo", roles: ["porteur"] }).returning();
  const [i1] = await db.insert(accounts).values({ email: "i@a.co", passwordHash: "x", firstName: "I", lastName: "A", country: "Togo", roles: ["investor"] }).returning();
  await db.insert(wallets).values({ accountId: owner.id });
  const [p] = await db.insert(projects).values({ ownerAccountId: owner.id, category: "commerce", title: "P", city: "L", description: "d", targetMinor: 1000000, durationMonths: 6, roiPct: "16", fundsUsage: "u", cautionType: "a", status: "funded", raisedMinor: 1000000 }).returning();
  await db.insert(investments).values({ projectId: p.id, investorAccountId: i1.id, amountMinor: 1000000, source: "payment", paymentRef: "d1", status: opts.withEscrowedStraggler ? "escrowed" : "released" });
  return p.id;
}

describe("startRepayment", () => {
  it("flips funded->repaying and generates the schedule once release is complete", async () => {
    await withTestDb(async (db) => {
      const pid = await seedFunded(db);
      await startRepayment(db, { projectId: pid });
      const [p] = await db.select().from(projects).where(eq(projects.id, pid));
      expect(p!.status).toBe("repaying");
      const installments = await db.select().from(repaymentInstallments).where(eq(repaymentInstallments.projectId, pid));
      expect(installments).toHaveLength(6); // durationMonths
      const total = installments.reduce((s: number, r: any) => s + r.amountMinor, 0);
      expect(total).toBe(1160000); // round(1_000_000 * 1.16)
      // idempotent: a second call does not duplicate the schedule
      await startRepayment(db, { projectId: pid });
      const again = await db.select().from(repaymentInstallments).where(eq(repaymentInstallments.projectId, pid));
      expect(again).toHaveLength(6);
    });
  });

  it("does NOT flip while an escrowed straggler remains (partial release)", async () => {
    await withTestDb(async (db) => {
      const pid = await seedFunded(db, { withEscrowedStraggler: true });
      await startRepayment(db, { projectId: pid });
      const [p] = await db.select().from(projects).where(eq(projects.id, pid));
      expect(p!.status).toBe("funded"); // still funded; release not complete
      const installments = await db.select().from(repaymentInstallments).where(eq(repaymentInstallments.projectId, pid));
      expect(installments).toHaveLength(0);
    });
  });
});
