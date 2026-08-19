import { describe, it, expect } from "vitest";
import { withTestDb } from "../../../tests/helpers/db";
import { registerAccount } from "../accounts/register";
import { getBalance, credit, withdraw } from "./service";
import { MockPaymentProvider } from "../../lib/payments";

describe("wallet ledger", () => {
  it("balance is the sum of entries; withdraw cannot exceed it", async () => {
    await withTestDb(async (db) => {
      const { accountId } = await registerAccount(db, {
        email: "w@a.co",
        password: "Abcdef12",
        firstName: "W",
        lastName: "A",
        country: "Togo",
        roles: ["investor"],
      });
      await credit(db, { accountId, amountMinor: 230000, type: "repayment", reference: "prj1" });
      expect(await getBalance(db, accountId)).toBe(230000);
      await withdraw(db, new MockPaymentProvider(), { accountId, amountMinor: 100000, method: { type: "tmoney" } });
      expect(await getBalance(db, accountId)).toBe(130000);
      await expect(
        withdraw(db, new MockPaymentProvider(), { accountId, amountMinor: 999999, method: { type: "tmoney" } }),
      ).rejects.toThrow();
    });
  });
});
