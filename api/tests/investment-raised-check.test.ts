import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "./helpers/db";
import { accounts, projects } from "../src/db/schema";

// A DB-level backstop for the no-overfunding invariant: even if some future
// writer forgets the FOR UPDATE lock (admin adjustment, refund/repayment path,
// a backfill), the database itself must refuse raised_minor > target_minor or
// a negative raised_minor. The invest path already enforces this in app logic;
// this constraint is defense in depth.
describe("project.raised_minor CHECK constraint", () => {
  async function seed(db: Parameters<Parameters<typeof withTestDb>[0]>[0]) {
    const [a] = await db
      .insert(accounts)
      .values({
        email: "o@a.co",
        passwordHash: "x",
        firstName: "O",
        lastName: "A",
        country: "Togo",
        roles: ["porteur"],
      })
      .returning();
    const [p] = await db
      .insert(projects)
      .values({
        ownerAccountId: a!.id,
        category: "commerce",
        title: "P",
        city: "L",
        description: "d",
        targetMinor: 1000000,
        durationMonths: 6,
        roiPct: "16",
        fundsUsage: "u",
        cautionType: "a",
        status: "collecting",
      })
      .returning();
    return p!.id;
  }

  it("rejects raised_minor above target_minor", async () => {
    await withTestDb(async (db) => {
      const pid = await seed(db);
      await expect(
        db.update(projects).set({ raisedMinor: 1000001 }).where(eq(projects.id, pid)),
      ).rejects.toThrow();
    });
  });

  it("rejects a negative raised_minor", async () => {
    await withTestDb(async (db) => {
      const pid = await seed(db);
      await expect(
        db.update(projects).set({ raisedMinor: -1 }).where(eq(projects.id, pid)),
      ).rejects.toThrow();
    });
  });

  it("allows raised_minor exactly at target_minor (the funded boundary)", async () => {
    await withTestDb(async (db) => {
      const pid = await seed(db);
      await db.update(projects).set({ raisedMinor: 1000000 }).where(eq(projects.id, pid));
      const [p] = await db.select().from(projects).where(eq(projects.id, pid));
      expect(p!.raisedMinor).toBe(1000000);
    });
  });
});
