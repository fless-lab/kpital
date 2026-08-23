import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { buildTestApp, loginAs } from "./helpers/app";
import { MockPaymentProvider, type RefundRequest } from "../src/lib/payments";
import { accounts, projects, investments, wallets, walletEntries } from "../src/db/schema";

const COOKIE = "kpital_sess";

// A payments provider that records every refundEscrow call so a test can assert
// the provider contract (called once per payment-source investment, never for a
// wallet-source one, with the deterministic refund:<id> idempotency key).
function spyPayments(): { payments: MockPaymentProvider; refundCalls: RefundRequest[] } {
  const payments = new MockPaymentProvider();
  const refundCalls: RefundRequest[] = [];
  const realRefund = payments.refundEscrow.bind(payments);
  payments.refundEscrow = async (p) => {
    refundCalls.push(p);
    return realRefund(p);
  };
  return { payments, refundCalls };
}

async function loginAsAdmin(
  app: Awaited<ReturnType<typeof buildTestApp>>["app"],
  db: Awaited<ReturnType<typeof buildTestApp>>["db"],
  email = "admin@cancel.co",
): Promise<string> {
  const cookie = await loginAs(app, email);
  await db.update(accounts).set({ isAdmin: true }).where(eq(accounts.email, email));
  return cookie;
}

// Seed a collecting project with a mix of investments:
//   - one wallet-source escrowed (investor wallet must be credited back)
//   - one payment-source escrowed (refundEscrow called)
//   - one payment-source pending (refundEscrow called, raised untouched)
// raised_minor is seeded as EXACTLY the sum of the escrowed amounts, so a bug
// that decrements for the pending one lands on a wrong number instead of 0.
// db is typed `any` so the `returning()` destructures stay terse, mirroring the
// seed helper in escrow-settle.test.ts.
async function seedScenario(db: any) {
  const [investor] = await db
    .insert(accounts)
    .values({ email: "inv@cancel.co", passwordHash: "x", firstName: "I", lastName: "V", country: "Togo", roles: ["investor"] })
    .returning();
  const [owner] = await db
    .insert(accounts)
    .values({ email: "owner@cancel.co", passwordHash: "x", firstName: "O", lastName: "W", country: "Togo", roles: ["porteur"] })
    .returning();
  // The investor needs a wallet so the wallet-source refund entry has somewhere
  // to land (escrow-settle's helper only seeds the porteur wallet).
  const [investorWallet] = await db.insert(wallets).values({ accountId: investor.id }).returning();

  const [p] = await db
    .insert(projects)
    .values({
      ownerAccountId: owner.id,
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
      raisedMinor: 80000, // 50000 (wallet escrowed) + 30000 (payment escrowed)
    })
    .returning();

  const [walletEsc] = await db
    .insert(investments)
    .values({ projectId: p.id, investorAccountId: investor.id, amountMinor: 50000, source: "wallet", paymentRef: null, status: "escrowed" })
    .returning();
  const [payEsc] = await db
    .insert(investments)
    .values({ projectId: p.id, investorAccountId: investor.id, amountMinor: 30000, source: "payment", paymentRef: "dep-esc", status: "escrowed" })
    .returning();
  const [payPend] = await db
    .insert(investments)
    .values({ projectId: p.id, investorAccountId: investor.id, amountMinor: 40000, source: "payment", paymentRef: "dep-pend", status: "pending" })
    .returning();

  return {
    pid: p.id,
    investorId: investor.id,
    investorWalletId: investorWallet.id,
    walletEscId: walletEsc.id,
    payEscId: payEsc.id,
    payPendId: payPend.id,
  };
}

describe("admin cancel + escrow refund", () => {
  it("cancels a collecting project and refunds each investment to its source", async () => {
    const { payments, refundCalls } = spyPayments();
    const { app, db } = await buildTestApp({ payments });
    const adminCookie = await loginAsAdmin(app, db);
    const s = await seedScenario(db);

    const r = await app.inject({
      method: "POST",
      url: `/admin/projects/${s.pid}/cancel`,
      cookies: { [COOKIE]: adminCookie },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });

    // Project is cancelled and raised has been wound back to 0 (only the two
    // escrowed investments ever contributed; the pending one never did).
    const [p] = await db.select().from(projects).where(eq(projects.id, s.pid));
    expect(p!.status).toBe("cancelled");
    expect(p!.raisedMinor).toBe(0);

    // Every investment is refunded with a resolvedAt stamp.
    for (const id of [s.walletEscId, s.payEscId, s.payPendId]) {
      const [i] = await db.select().from(investments).where(eq(investments.id, id));
      expect(i!.status).toBe("refunded");
      expect(i!.resolvedAt).not.toBeNull();
    }

    // Wallet-source: a single positive refund entry to the investor wallet, no
    // provider ref (funds never left the internal ledger).
    const entries = await db.select().from(walletEntries).where(eq(walletEntries.walletId, s.investorWalletId));
    const refunds = entries.filter((e) => e.type === "refund");
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.amountMinor).toBe(50000);
    expect(refunds[0]!.reference).toBe(s.walletEscId);
    const [walletInv] = await db.select().from(investments).where(eq(investments.id, s.walletEscId));
    expect(walletInv!.resolutionRef).toBeNull();

    // Payment-source: refundEscrow called exactly twice with the deterministic
    // refund:<id> key, once per payment investment, and each carries a ref.
    expect(refundCalls).toHaveLength(2);
    const keys = refundCalls.map((c) => c.idempotencyKey).sort();
    expect(keys).toEqual([`refund:${s.payEscId}`, `refund:${s.payPendId}`].sort());
    const [payEscInv] = await db.select().from(investments).where(eq(investments.id, s.payEscId));
    const [payPendInv] = await db.select().from(investments).where(eq(investments.id, s.payPendId));
    expect(payEscInv!.resolutionRef).not.toBeNull();
    expect(payPendInv!.resolutionRef).not.toBeNull();
  });

  it("re-cancelling a cancelled project returns 409 invalid_state and refunds nothing twice", async () => {
    const { payments, refundCalls } = spyPayments();
    const { app, db } = await buildTestApp({ payments });
    const adminCookie = await loginAsAdmin(app, db);
    const s = await seedScenario(db);

    const first = await app.inject({ method: "POST", url: `/admin/projects/${s.pid}/cancel`, cookies: { [COOKIE]: adminCookie } });
    expect(first.statusCode).toBe(200);
    expect(refundCalls).toHaveLength(2);

    const second = await app.inject({ method: "POST", url: `/admin/projects/${s.pid}/cancel`, cookies: { [COOKIE]: adminCookie } });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("invalid_state");

    // No double refund: the provider is not called again and the investor wallet
    // still carries exactly one refund entry.
    expect(refundCalls).toHaveLength(2);
    const [p] = await db.select().from(projects).where(eq(projects.id, s.pid));
    expect(p!.raisedMinor).toBe(0);
    const entries = await db.select().from(walletEntries).where(eq(walletEntries.walletId, s.investorWalletId));
    expect(entries.filter((e) => e.type === "refund")).toHaveLength(1);
  });

  it("rejects a non-admin caller with 403", async () => {
    const { app } = await buildTestApp();
    const userCookie = await loginAs(app, "user@cancel.co");
    const missing = "00000000-0000-0000-0000-000000000000";
    const r = await app.inject({ method: "POST", url: `/admin/projects/${missing}/cancel`, cookies: { [COOKIE]: userCookie } });
    expect(r.statusCode).toBe(403);
  });

  it("returns 404 for a non-UUID id", async () => {
    const { app, db } = await buildTestApp();
    const adminCookie = await loginAsAdmin(app, db);
    const r = await app.inject({ method: "POST", url: `/admin/projects/not-a-uuid/cancel`, cookies: { [COOKIE]: adminCookie } });
    expect(r.statusCode).toBe(404);
  });

  it("returns 404 for a well-formed but absent project id", async () => {
    const { app, db } = await buildTestApp();
    const adminCookie = await loginAsAdmin(app, db);
    const missing = "11111111-2222-4333-8444-555555555555";
    const r = await app.inject({ method: "POST", url: `/admin/projects/${missing}/cancel`, cookies: { [COOKIE]: adminCookie } });
    expect(r.statusCode).toBe(404);
  });
});
