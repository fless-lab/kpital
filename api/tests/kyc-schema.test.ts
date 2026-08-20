import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db";
import { accounts, kycSubmissions } from "../src/db/schema";

describe("kyc_submission", () => {
  it("defaults to pending and links an account", async () => {
    await withTestDb(async (db) => {
      const [a] = await db
        .insert(accounts)
        .values({
          email: "k@a.co",
          passwordHash: "x",
          firstName: "K",
          lastName: "A",
          country: "Togo",
          roles: ["investor"],
        })
        .returning();
      expect(a).toBeDefined();
      const [s] = await db
        .insert(kycSubmissions)
        .values({
          accountId: a!.id,
          docType: "cni",
          docNumber: "TG-1",
          dob: "1990-01-01",
          nationality: "Togolaise",
        })
        .returning();
      expect(s?.status).toBe("pending");
    });
  });
});
