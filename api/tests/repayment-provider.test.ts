import { describe, it, expect } from "vitest";
import { MockPaymentProvider } from "../src/lib/payments";

describe("MockPaymentProvider.initiateRepayment", () => {
  it("settles by default, supports pending mode, and is idempotent per key", async () => {
    const p = new MockPaymentProvider();
    const r1 = await p.initiateRepayment({ payerAccountId: "o", amountMinor: 50000, idempotencyKey: "repay:x" });
    expect(r1.ok).toBe(true);
    expect(r1.status).toBe("settled");
    expect(r1.ref).toMatch(/^mock-repay-\d+$/);
    const r2 = await p.initiateRepayment({ payerAccountId: "o", amountMinor: 50000, idempotencyKey: "repay:x" });
    expect(r2.ref).toBe(r1.ref); // replay: same ref, no new movement
    const q = new MockPaymentProvider();
    q.repaymentMode = "pending";
    expect((await q.initiateRepayment({ payerAccountId: "o", amountMinor: 1, idempotencyKey: "repay:y" })).status).toBe("pending");
  });
});
