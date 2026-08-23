import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "./helpers/db";
import { MockPaymentProvider } from "../src/lib/payments";
import { releaseProject } from "../src/modules/escrow/service";
import { accounts, projects, investments, wallets, walletEntries } from "../src/db/schema";

async function seedProject(
  db: Parameters<Parameters<typeof withTestDb>[0]>[0],
  status: "collecting" | "funded",
) {
  const [investor] = await db
    .insert(accounts)
    .values({ email: "i@a.co", passwordHash: "x", firstName: "I", lastName: "A", country: "Togo", roles: ["investor"] })
    .returning();
  const [owner] = await db
    .insert(accounts)
    .values({ email: "o@a.co", passwordHash: "x", firstName: "O", lastName: "A", country: "Togo", roles: ["porteur"] })
    .returning();
  await db.insert(wallets).values({ accountId: owner!.id });
  const [p] = await db
    .insert(projects)
    .values({ ownerAccountId: owner!.id, category: "commerce", title: "P", city: "L", description: "d",
      targetMinor: 1000000, durationMonths: 6, roiPct: "16", fundsUsage: "u", cautionType: "a", status })
    .returning();
  return { investorId: investor!.id, ownerId: owner!.id, projectId: p!.id };
}

describe("escrow hardening", () => {
  it("rejects two payment investments sharing a payment_ref", async () => {
    await withTestDb(async (db) => {
      const { investorId, projectId } = await seedProject(db, "collecting");
      await db.insert(investments).values({ projectId, investorAccountId: investorId,
        amountMinor: 50000, source: "payment", paymentRef: "dup-1", status: "pending" });
      await expect(
        db.insert(investments).values({ projectId, investorAccountId: investorId,
          amountMinor: 60000, source: "payment", paymentRef: "dup-1", status: "pending" }),
      ).rejects.toThrow();
    });
  });

  it("allows many wallet-source investments with a null payment_ref", async () => {
    await withTestDb(async (db) => {
      const { investorId, projectId } = await seedProject(db, "collecting");
      await db.insert(investments).values({ projectId, investorAccountId: investorId,
        amountMinor: 50000, source: "wallet", paymentRef: null, status: "escrowed" });
      // A second null payment_ref must not collide with the partial unique index.
      await db.insert(investments).values({ projectId, investorAccountId: investorId,
        amountMinor: 40000, source: "wallet", paymentRef: null, status: "escrowed" });
      const rows = await db.select().from(investments).where(eq(investments.projectId, projectId));
      expect(rows).toHaveLength(2);
    });
  });

  it("releaseProject is a no-op on a project that is not funded", async () => {
    await withTestDb(async (db) => {
      const payments = new MockPaymentProvider();
      const { investorId, ownerId, projectId } = await seedProject(db, "collecting");
      const [inv] = await db.insert(investments).values({ projectId, investorAccountId: investorId,
        amountMinor: 50000, source: "payment", paymentRef: "dep-x", status: "escrowed" }).returning();

      await releaseProject(db, payments, { projectId });

      const [after] = await db.select().from(investments).where(eq(investments.id, inv!.id));
      expect(after!.status).toBe("escrowed"); // not released
      const [w] = await db.select().from(wallets).where(eq(wallets.accountId, ownerId));
      const disb = await db
        .select()
        .from(walletEntries)
        .where(and(eq(walletEntries.walletId, w!.id), eq(walletEntries.type, "disbursement")));
      expect(disb).toHaveLength(0); // no porteur credit on an unfunded project
    });
  });
});
