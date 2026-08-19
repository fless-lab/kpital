import { describe, it, expect } from "vitest";
import { withTestDb } from "../../../tests/helpers/db";
import { registerAccount } from "./register";
import { wallets } from "../../db/schema";
import { eq } from "drizzle-orm";

describe("registerAccount", () => {
  it("creates account + wallet, defaults to kyc pending", async () => {
    await withTestDb(async (db) => {
      const { accountId } = await registerAccount(db, {
        email: "k@a.co", password: "Abcdef12", firstName: "Kofi",
        lastName: "A", country: "Togo", roles: ["investor"],
      });
      const w = await db.select().from(wallets).where(eq(wallets.accountId, accountId));
      expect(w).toHaveLength(1);
    });
  });
  it("rejects a weak password", async () => {
    await withTestDb(async (db) => {
      await expect(registerAccount(db, {
        email: "w@a.co", password: "weak", firstName: "W", lastName: "W",
        country: "Togo", roles: ["investor"],
      })).rejects.toThrow();
    });
  });
});
