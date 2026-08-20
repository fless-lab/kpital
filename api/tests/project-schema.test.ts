import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db";
import { accounts, projects } from "../src/db/schema";
describe("project", () => {
  it("defaults to draft and links an owner", async () => {
    await withTestDb(async (db) => {
      const [a] = await db.insert(accounts).values({ email:"p@a.co", passwordHash:"x",
        firstName:"P", lastName:"A", country:"Togo", roles:["porteur"] }).returning();
      const [p] = await db.insert(projects).values({ ownerAccountId: a!.id, category:"commerce",
        title:"Boutique", city:"Lomé", description:"d", targetMinor: 1500000, durationMonths: 6,
        roiPct: "16", fundsUsage:"stock", cautionType:"aval" }).returning();
      expect(p!.status).toBe("draft");
      expect(p!.upvoteCount).toBe(0);
    });
  });
});
