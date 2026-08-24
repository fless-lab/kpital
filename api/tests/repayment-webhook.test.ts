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
  repaymentDistributions,
} from "../src/db/schema";

// Seed a `repaying` project with a frozen (all released) investor set and one
// `pending` installment carrying repaymentRef "r9", all via direct inserts
// (mirrors repayment-settle.test.ts seeding). Each investor gets a wallet so a
// distribution can credit. The porteur also gets a wallet for symmetry with the
// release/disburse flows.
async function seedRepaying(db: Db, opts: { investorAmounts?: number[]; installmentAmount?: number } = {}) {
  const investorAmounts = opts.investorAmounts ?? [500000, 300000, 200000];
  const installmentAmount = opts.installmentAmount ?? 193333;
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
    .values({ projectId: p!.id, seq: 1, amountMinor: installmentAmount, dueAt: new Date(), status: "pending", repaymentRef: "r9" })
    .returning();

  return { pid: p!.id, ownerId: owner!.id, investors, installmentId: ins!.id };
}

describe("POST /escrow/repayment (webhook)", () => {
  it("settles a pending installment via the webhook and is idempotent on replay", async () => {
    const { app, db } = await buildTestApp({});
    const { investors, installmentId } = await seedRepaying(db);

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
    expect(r2.statusCode).toBe(200); // replay is a no-op
    expect(r2.json()).toEqual({ ok: true });

    // Distributed exactly once: one wallet entry per investor, summing to A.
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
  });

  it("rejects a missing signature header with 401", async () => {
    const { app, db } = await buildTestApp({});
    await seedRepaying(db);
    const res = await app.inject({
      method: "POST",
      url: "/escrow/repayment",
      payload: { repaymentRef: "r9", status: "settled" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: "unauthorized", message: "bad signature" } });
  });

  it("rejects a wrong signature with 401", async () => {
    const { app, db } = await buildTestApp({});
    await seedRepaying(db);
    const res = await app.inject({
      method: "POST",
      url: "/escrow/repayment",
      headers: { "x-escrow-signature": "nope" },
      payload: { repaymentRef: "r9", status: "settled" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects every caller when the configured secret is empty (safe prod default)", async () => {
    // With ESCROW_WEBHOOK_SECRET empty the webhook must reject all callers, even
    // one presenting an empty signature, so a misconfigured deployment cannot be
    // driven by an unauthenticated request.
    const { app, db } = await buildTestApp({ env: { ESCROW_WEBHOOK_SECRET: "" } });
    await seedRepaying(db);
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
    await seedRepaying(db);
    const res = await app.inject({
      method: "POST",
      url: "/escrow/repayment",
      headers: { "x-escrow-signature": "test-secret" },
      payload: { repaymentRef: "nope", status: "settled" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("resets pending->due on status=failed and distributes nothing", async () => {
    const { app, db } = await buildTestApp({});
    const { investors, installmentId } = await seedRepaying(db);
    const res = await app.inject({
      method: "POST",
      url: "/escrow/repayment",
      headers: { "x-escrow-signature": "test-secret" },
      payload: { repaymentRef: "r9", status: "failed" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const [ins] = await db.select().from(repaymentInstallments).where(eq(repaymentInstallments.id, installmentId));
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
    await seedRepaying(db);
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
