import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "./helpers/db";
import { loadConfig } from "../src/config/env";
import { accounts, projects, repaymentInstallments } from "../src/db/schema";

describe("collections schema + config", () => {
  it("project accepts defaulted + defaulted_at, installment accepts reminded_at", async () => {
    await withTestDb(async (db) => {
      const [o] = await db.insert(accounts).values({ email: "o@a.co", passwordHash: "x",
        firstName: "O", lastName: "A", country: "Togo", roles: ["porteur"] }).returning();
      const [p] = await db.insert(projects).values({ ownerAccountId: o!.id, category: "commerce",
        title: "P", city: "L", description: "d", targetMinor: 1000000, durationMonths: 6, roiPct: "16",
        fundsUsage: "u", cautionType: "a", status: "defaulted", defaultedAt: new Date(), raisedMinor: 1000000 }).returning();
      expect(p!.status).toBe("defaulted");
      expect(p!.defaultedAt).not.toBeNull();
      const [ins] = await db.insert(repaymentInstallments).values({ projectId: p!.id, seq: 1,
        amountMinor: 100000, dueAt: new Date(), remindedAt: new Date() }).returning();
      expect(ins!.remindedAt).not.toBeNull();
    });
  });
  it("defaultGraceDays defaults to 30 and is overridable", () => {
    const base = { DATABASE_URL: "postgres://x", CORS_ORIGIN: "http://localhost",
      MINIO_ENDPOINT: "http://x", MINIO_ACCESS_KEY: "x", MINIO_SECRET_KEY: "x", MINIO_BUCKET: "x" };
    expect(loadConfig(base).defaultGraceDays).toBe(30);
    expect(loadConfig({ ...base, DEFAULT_GRACE_DAYS: "7" }).defaultGraceDays).toBe(7);
  });
});
