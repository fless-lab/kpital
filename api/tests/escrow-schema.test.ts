import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db";
import { accounts, projects, investments } from "../src/db/schema";

describe("escrow schema", () => {
  it("investment defaults to pending and accepts escrow states + audit columns", async () => {
    await withTestDb(async (db) => {
      const [a] = await db.insert(accounts).values({ email: "i@a.co", passwordHash: "x",
        firstName: "I", lastName: "A", country: "Togo", roles: ["investor"] }).returning();
      const [p] = await db.insert(projects).values({ ownerAccountId: a!.id, category: "commerce",
        title: "P", city: "L", description: "d", targetMinor: 1000000, durationMonths: 6,
        roiPct: "16", fundsUsage: "u", cautionType: "a", status: "collecting" }).returning();
      const [inv] = await db.insert(investments).values({ projectId: p!.id, investorAccountId: a!.id,
        amountMinor: 50000, source: "payment", paymentRef: "mock-deposit-1" }).returning();
      expect(inv!.status).toBe("pending");
      const [esc] = await db.update(investments).set({ status: "escrowed", settledAt: new Date() })
        .where((await import("drizzle-orm")).eq(investments.id, inv!.id)).returning();
      expect(esc!.status).toBe("escrowed");
      const [rel] = await db.update(investments).set({ status: "released",
        resolutionRef: "mock-release-1", resolvedAt: new Date() })
        .where((await import("drizzle-orm")).eq(investments.id, inv!.id)).returning();
      expect(rel!.status).toBe("released");
      expect(rel!.resolutionRef).toBe("mock-release-1");
    });
  });

  it("project accepts the cancelled status", async () => {
    await withTestDb(async (db) => {
      const [a] = await db.insert(accounts).values({ email: "o@a.co", passwordHash: "x",
        firstName: "O", lastName: "A", country: "Togo", roles: ["porteur"] }).returning();
      const [p] = await db.insert(projects).values({ ownerAccountId: a!.id, category: "commerce",
        title: "P", city: "L", description: "d", targetMinor: 1000000, durationMonths: 6,
        roiPct: "16", fundsUsage: "u", cautionType: "a", status: "cancelled" }).returning();
      expect(p!.status).toBe("cancelled");
    });
  });
});
