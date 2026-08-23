import { describe, it, expect } from "vitest";
import { MockPaymentProvider } from "../src/lib/payments";

describe("MockPaymentProvider escrow methods", () => {
  it("initiateDeposit settles by default and is idempotent per key", async () => {
    const p = new MockPaymentProvider();
    const r1 = await p.initiateDeposit({ accountId: "a", amountMinor: 50000, idempotencyKey: "deposit:x" });
    expect(r1.ok).toBe(true);
    expect(r1.status).toBe("settled");
    expect(r1.ref).toMatch(/^mock-deposit-\d+$/);
    const r2 = await p.initiateDeposit({ accountId: "a", amountMinor: 50000, idempotencyKey: "deposit:x" });
    expect(r2.ref).toBe(r1.ref); // replay returns the same ref, no new movement
  });

  it("initiateDeposit can be put in pending mode", async () => {
    const p = new MockPaymentProvider();
    p.depositMode = "pending";
    const r = await p.initiateDeposit({ accountId: "a", amountMinor: 50000, idempotencyKey: "deposit:y" });
    expect(r.status).toBe("pending");
  });

  it("releaseEscrow and refundEscrow return ok refs and are idempotent per key", async () => {
    const p = new MockPaymentProvider();
    const rel = await p.releaseEscrow({ depositRef: "mock-deposit-1", payeeAccountId: "o", amountMinor: 50000, idempotencyKey: "release:x" });
    expect(rel.ok).toBe(true);
    expect(rel.ref).toMatch(/^mock-release-\d+$/);
    expect((await p.releaseEscrow({ depositRef: "mock-deposit-1", payeeAccountId: "o", amountMinor: 50000, idempotencyKey: "release:x" })).ref).toBe(rel.ref);
    const ref = await p.refundEscrow({ depositRef: "mock-deposit-1", amountMinor: 50000, idempotencyKey: "refund:x" });
    expect(ref.ref).toMatch(/^mock-refund-\d+$/);
    expect((await p.refundEscrow({ depositRef: "mock-deposit-1", amountMinor: 50000, idempotencyKey: "refund:x" })).ref).toBe(ref.ref);
  });
});
