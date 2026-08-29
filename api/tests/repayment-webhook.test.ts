import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db/client";
import { buildTestApp } from "./helpers/app";
import {
  accounts,
  projects,
  investments,
  wallets,
  walletEntries,
  repaymentInstallments,
  repaymentPayments,
  repaymentApplications,
  repaymentDistributions,
} from "../src/db/schema";

// Seed a `repaying` project with a frozen (all released) investor set, one `due`
// installment, and one `pending` repayment_payment carrying ref "r9". The webhook
// resolves the payment by that ref.
async function seedPending(db: Db, opts: { investorAmounts?: number[]; installmentAmount?: number; paymentAmount?: number } = {}) {
  const investorAmounts = opts.investorAmounts ?? [500000, 300000, 200000];
  const installmentAmount = opts.installmentAmount ?? 193333;
  const paymentAmount = opts.paymentAmount ?? installmentAmount;
  const raised = investorAmounts.reduce((s, a) => s + a, 0);

  const [owner] = await db
    .insert(accounts)
    .values({ email: "o@a.co", passwordHash: "x", firstName: "O", lastName: "A", country: "Togo", roles: ["porteur"] })
    .returning();
  await db.insert(wallets).values({ accountId: owner!.id });
  const [p] = await db
    .insert(projects)
    .values({
      ownerAccountId: owner!.id,
      category: "commerce",
      title: "P",
      city: "L",
      description: "d",
      targetMinor: raised,
      durationMonths: 6,
      roiPct: "16",
      fundsUsage: "u",
      cautionType: "a",
      status: "repaying",
      raisedMinor: raised,
    })
    .returning();

  const investors: { accountId: string; walletId: string; invId: string; amount: number }[] = [];
  for (let i = 0; i < investorAmounts.length; i += 1) {
    const [acc] = await db
      .insert(accounts)
      .values({ email: `i${i}@a.co`, passwordHash: "x", firstName: "I", lastName: String(i), country: "Togo", roles: ["investor"] })
      .returning();
    const [w] = await db.insert(wallets).values({ accountId: acc!.id }).returning();
    const [inv] = await db
      .insert(investments)
      .values({ projectId: p!.id, investorAccountId: acc!.id, amountMinor: investorAmounts[i]!, source: "payment", paymentRef: `d${i}`, status: "released" })
      .returning();
    investors.push({ accountId: acc!.id, walletId: w!.id, invId: inv!.id, amount: investorAmounts[i]! });
  }

  const [ins] = await db
    .insert(repaymentInstallments)
    .values({ projectId: p!.id, seq: 1, amountMinor: installmentAmount, dueAt: new Date(), status: "due" })
    .returning();
  const [pay] = await db
    .insert(repaymentPayments)
    .values({ projectId: p!.id, amountMinor: paymentAmount, ref: "r9", status: "pending" })
    .returning();

  return { pid: p!.id, investors, installmentId: ins!.id, paymentId: pay!.id };
}

describe("POST /escrow/repayment (webhook)", () => {
  it("settles a pending payment via the webhook and is idempotent on replay (applied once)", async () => {
    const { app, db } = await buildTestApp({});
    const { investors, installmentId, paymentId } = await seedPending(db);

    const call = () =>
      app.inject({
        method: "POST",
        url: "/escrow/repayment",
        headers: { "x-escrow-signature": "test-secret" },
        payload: { repaymentRef: "r9", status: "settled" },
      });

    const r1 = await call();
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual({ ok: true });

    const r2 = await call();
    expect(r2.statusCode).toBe(200); // replay no-ops
    expect(r2.json()).toEqual({ ok: true });

    // Applied exactly once: one application summing to the payment amount, and no
    // extra distributions (payment status guard).
    const apps = await db.select().from(repaymentApplications).where(eq(repaymentApplications.paymentId, paymentId));
    expect(apps).toHaveLength(1);
    expect(apps.reduce((s, a) => s + a.amountMinor, 0)).toBe(193333);

    const dists = await db.select().from(repaymentDistributions).where(eq(repaymentDistributions.installmentId, installmentId));
    expect(dists).toHaveLength(3); // one per released investor, not doubled
    let sum = 0;
    for (const inv of investors) {
      const entries = await db.select().from(walletEntries).where(eq(walletEntries.walletId, inv.walletId));
      expect(entries).toHaveLength(1);
      expect(entries[0]!.type).toBe("repayment");
      sum += entries[0]!.amountMinor;
    }
    expect(sum).toBe(193333);

    const [ins] = await db.select().from(repaymentInstallments).where(eq(repaymentInstallments.id, installmentId));
    expect(ins!.status).toBe("paid");
    expect(ins!.paidMinor).toBe(193333);
    const [pay] = await db.select().from(repaymentPayments).where(eq(repaymentPayments.id, paymentId));
    expect(pay!.status).toBe("settled");
  });

  it("cascades a partial webhook settle (paid_minor advances, not paid)", async () => {
    const { app, db } = await buildTestApp({});
    const { installmentId, paymentId } = await seedPending(db, { installmentAmount: 100000, paymentAmount: 40000 });

    const res = await app.inject({
      method: "POST",
      url: "/escrow/repayment",
      headers: { "x-escrow-signature": "test-secret" },
      payload: { repaymentRef: "r9", status: "settled" },
    });
    expect(res.statusCode).toBe(200);

    const [ins] = await db.select().from(repaymentInstallments).where(eq(repaymentInstallments.id, installmentId));
    expect(ins!.paidMinor).toBe(40000);
    expect(ins!.status).toBe("due");
    const apps = await db.select().from(repaymentApplications).where(eq(repaymentApplications.paymentId, paymentId));
    expect(apps.reduce((s, a) => s + a.amountMinor, 0)).toBe(40000);
  });

  it("rejects a missing signature header with 401", async () => {
    const { app, db } = await buildTestApp({});
    await seedPending(db);
    const res = await app.inject({ method: "POST", url: "/escrow/repayment", payload: { repaymentRef: "r9", status: "settled" } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: "unauthorized", message: "bad signature" } });
  });

  it("rejects a wrong signature with 401", async () => {
    const { app, db } = await buildTestApp({});
    await seedPending(db);
    const res = await app.inject({
      method: "POST",
      url: "/escrow/repayment",
      headers: { "x-escrow-signature": "nope" },
      payload: { repaymentRef: "r9", status: "settled" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects every caller when the configured secret is empty (safe prod default)", async () => {
    const { app, db } = await buildTestApp({ env: { ESCROW_WEBHOOK_SECRET: "" } });
    await seedPending(db);
    const res = await app.inject({
      method: "POST",
      url: "/escrow/repayment",
      headers: { "x-escrow-signature": "" },
      payload: { repaymentRef: "r9", status: "settled" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 for an unknown repaymentRef", async () => {
    const { app, db } = await buildTestApp({});
    await seedPending(db);
    const res = await app.inject({
      method: "POST",
      url: "/escrow/repayment",
      headers: { "x-escrow-signature": "test-secret" },
      payload: { repaymentRef: "nope", status: "settled" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("marks the payment failed on status=failed and applies nothing", async () => {
    const { app, db } = await buildTestApp({});
    const { investors, installmentId, paymentId } = await seedPending(db);
    const res = await app.inject({
      method: "POST",
      url: "/escrow/repayment",
      headers: { "x-escrow-signature": "test-secret" },
      payload: { repaymentRef: "r9", status: "failed" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const [pay] = await db.select().from(repaymentPayments).where(eq(repaymentPayments.id, paymentId));
    expect(pay!.status).toBe("failed");
    const [ins] = await db.select().from(repaymentInstallments).where(eq(repaymentInstallments.id, installmentId));
    expect(ins!.paidMinor).toBe(0);
    expect(ins!.status).toBe("due");
    const dists = await db.select().from(repaymentDistributions).where(eq(repaymentDistributions.installmentId, installmentId));
    expect(dists).toHaveLength(0);
    for (const inv of investors) {
      const entries = await db.select().from(walletEntries).where(eq(walletEntries.walletId, inv.walletId));
      expect(entries).toHaveLength(0);
    }
  });

  it("rejects an invalid body with 400 validation_error", async () => {
    const { app, db } = await buildTestApp({});
    await seedPending(db);
    const res = await app.inject({
      method: "POST",
      url: "/escrow/repayment",
      headers: { "x-escrow-signature": "test-secret" },
      payload: { repaymentRef: "r9", status: "bogus" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });
});
