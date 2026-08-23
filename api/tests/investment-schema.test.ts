import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db";
import { accounts, projects, investments } from "../src/db/schema";
describe("investment", () => {
  it("records an investment and project has raised_minor default 0", async () => {
    await withTestDb(async (db) => {
      const [a] = await db.insert(accounts).values({ email:"i@a.co", passwordHash:"x",
        firstName:"I", lastName:"A", country:"Togo", roles:["investor"] }).returning();
      const [p] = await db.insert(projects).values({ ownerAccountId: a!.id, category:"commerce",
        title:"P", city:"L", description:"d", targetMinor: 1000000, durationMonths:6,
        roiPct:"16", fundsUsage:"u", cautionType:"a", status:"collecting" }).returning();
      expect(p!.raisedMinor).toBe(0);
      const [inv] = await db.insert(investments).values({ projectId: p!.id, investorAccountId: a!.id,
        amountMinor: 50000, source:"payment", paymentRef:"mock-1" }).returning();
      expect(inv!.status).toBe("pending");
    });
  });
});
