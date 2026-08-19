import { describe, it, expect } from "vitest";
import { withTestDb } from "../../../tests/helpers/db";
import { issueOtp, verifyOtp } from "./otp";
import { accounts } from "../../db/schema";

async function acct(db: any) {
  const [a] = await db.insert(accounts).values({ email: "o@a.co", passwordHash: "x",
    firstName: "O", lastName: "A", country: "Togo", roles: ["investor"] }).returning();
  return a.id as string;
}

describe("otp", () => {
  it("verifies a correct fresh code once", async () => {
    await withTestDb(async (db) => {
      const id = await acct(db);
      const { code } = await issueOtp(db, { accountId: id, channel: "email", purpose: "login", ttlMinutes: 10 });
      expect(await verifyOtp(db, { accountId: id, purpose: "login", code })).toBe(true);
      expect(await verifyOtp(db, { accountId: id, purpose: "login", code })).toBe(false); // single use
    });
  });
  it("rejects a wrong code", async () => {
    await withTestDb(async (db) => {
      const id = await acct(db);
      await issueOtp(db, { accountId: id, channel: "email", purpose: "login", ttlMinutes: 10 });
      expect(await verifyOtp(db, { accountId: id, purpose: "login", code: "000000" })).toBe(false);
    });
  });
  it("refuses the correct code once the attempts cap is reached", async () => {
    await withTestDb(async (db) => {
      const id = await acct(db);
      const { code } = await issueOtp(db, { accountId: id, channel: "email", purpose: "login", ttlMinutes: 10 });
      const wrong = code === "000000" ? "111111" : "000000";
      for (let i = 0; i < 5; i++) {
        expect(await verifyOtp(db, { accountId: id, purpose: "login", code: wrong })).toBe(false);
      }
      expect(await verifyOtp(db, { accountId: id, purpose: "login", code })).toBe(false); // cap reached
    });
  });
});
