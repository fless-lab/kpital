import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db";
import { accounts } from "../src/db/schema";

describe("accounts table", () => {
  it("inserts and reads an account", async () => {
    await withTestDb(async (db) => {
      const [row] = await db.insert(accounts).values({
        email: "a@b.co", passwordHash: "x", firstName: "K", lastName: "A",
        country: "Togo", roles: ["investor"],
      }).returning();
      expect(row).toBeDefined();
      expect(row?.kycStatus).toBe("pending");
      expect(row?.roles).toEqual(["investor"]);
    });
  });
});
