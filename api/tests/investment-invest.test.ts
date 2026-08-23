import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { buildTestApp, loginAs } from "./helpers/app";
import { MockPaymentProvider } from "../src/lib/payments";
import { accounts, projects, investments } from "../src/db/schema";
import type { PaymentProvider } from "../src/lib/payments";

const COOKIE = "kpital_sess";

// Seed a project owner + a collecting project. Returns the project id.
async function seedProject(
  db: Awaited<ReturnType<typeof buildTestApp>>["db"],
  overrides: Partial<typeof projects.$inferInsert> = {},
): Promise<string> {
  const [owner] = await db
    .insert(accounts)
    .values({ email: `o-${Math.random().toString(36).slice(2)}@a.co`, passwordHash: "x", firstName: "O", lastName: "A", country: "Togo", roles: ["porteur"] })
    .returning();
  const [p] = await db
    .insert(projects)
    .values({
      ownerAccountId: owner!.id,
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
      ...overrides,
    })
    .returning();
  return p!.id;
}

async function verify(db: Awaited<ReturnType<typeof buildTestApp>>["db"], email: string) {
  await db.update(accounts).set({ kycStatus: "verified" }).where(eq(accounts.email, email));
}

describe("POST /projects/:id/invest", () => {
  it("invests via payment (settled mock) escrows it and advances raised_minor", async () => {
    const { app, db } = await buildTestApp();
    const cookie = await loginAs(app, "i@a.co");
    await verify(db, "i@a.co");
    const pid = await seedProject(db);

    const r = await app.inject({
      method: "POST",
      url: `/projects/${pid}/invest`,
      cookies: { [COOKIE]: cookie },
      payload: { amountMinor: 50000, source: "payment" },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    // The default mock settles synchronously: the investment escrows and raised advances.
    expect(body.status).toBe("escrowed");
    expect(body.raisedMinor).toBe(50000);
    expect(body.amountMinor).toBe(50000);
    expect(body.projectStatus).toBe("collecting");
    expect(typeof body.investmentId).toBe("string");
    // payment source returns the mock deposit reference for the front to show
    expect(typeof body.depositRef).toBe("string");
    expect(body.depositRef.length).toBeGreaterThan(0);

    // The investment row is escrowed and carries the deposit ref.
    const [inv] = await db.select().from(investments).where(eq(investments.id, body.investmentId));
    expect(inv!.status).toBe("escrowed");
    expect(inv!.paymentRef).toBe(body.depositRef);

    await app.close();
  });

  it("holds a payment invest in pending when the deposit does not settle synchronously", async () => {
    const pendingPayments = new MockPaymentProvider();
    pendingPayments.depositMode = "pending";
    const { app, db } = await buildTestApp({ payments: pendingPayments });
    const cookie = await loginAs(app, "i@a.co");
    await verify(db, "i@a.co");
    const pid = await seedProject(db);

    const r = await app.inject({
      method: "POST",
      url: `/projects/${pid}/invest`,
      cookies: { [COOKIE]: cookie },
      payload: { amountMinor: 50000, source: "payment" },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    // Pending: the deposit was initiated but not settled, so raised is UNCHANGED.
    expect(body.status).toBe("pending");
    expect(body.raisedMinor).toBe(0);
    expect(body.projectStatus).toBe("collecting");
    expect(typeof body.depositRef).toBe("string");
    expect(body.depositRef.length).toBeGreaterThan(0);

    // The investment row is pending; raised_minor did not move.
    const [inv] = await db.select().from(investments).where(eq(investments.id, body.investmentId));
    expect(inv!.status).toBe("pending");
    const [p] = await db.select().from(projects).where(eq(projects.id, pid));
    expect(p!.raisedMinor).toBe(0);
    expect(p!.status).toBe("collecting");

    await app.close();
  });

  it("blocks a non-verified account with 403 kyc_required", async () => {
    const { app, db } = await buildTestApp();
    const cookie = await loginAs(app, "i@a.co");
    // kycStatus stays default "pending"
    const pid = await seedProject(db);

    const r = await app.inject({
      method: "POST",
      url: `/projects/${pid}/invest`,
      cookies: { [COOKIE]: cookie },
      payload: { amountMinor: 50000, source: "payment" },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("kyc_required");

    await app.close();
  });

  it("rejects an invest on a non-collecting project with 409 invalid_state", async () => {
    const { app, db } = await buildTestApp();
    const cookie = await loginAs(app, "i@a.co");
    await verify(db, "i@a.co");
    const pid = await seedProject(db, { status: "showcase" });

    const r = await app.inject({
      method: "POST",
      url: `/projects/${pid}/invest`,
      cookies: { [COOKIE]: cookie },
      payload: { amountMinor: 50000, source: "payment" },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("invalid_state");

    await app.close();
  });

  it("rejects an amount below the minimum ticket with 400 below_min_ticket", async () => {
    const { app, db } = await buildTestApp();
    const cookie = await loginAs(app, "i@a.co");
    await verify(db, "i@a.co");
    const pid = await seedProject(db);

    const r = await app.inject({
      method: "POST",
      url: `/projects/${pid}/invest`,
      cookies: { [COOKIE]: cookie },
      payload: { amountMinor: 9999, source: "payment" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("below_min_ticket");

    await app.close();
  });

  it("rejects over-remaining without confirm, caps with confirm, auto-funds, then blocks further", async () => {
    const { app, db } = await buildTestApp();
    const cookie = await loginAs(app, "i@a.co");
    await verify(db, "i@a.co");
    const pid = await seedProject(db, { targetMinor: 1000000 });

    // First invest 900_000 (settles) -> raised 900_000, remaining 100_000
    const r1 = await app.inject({
      method: "POST",
      url: `/projects/${pid}/invest`,
      cookies: { [COOKIE]: cookie },
      payload: { amountMinor: 900000, source: "payment" },
    });
    expect(r1.statusCode).toBe(201);
    expect(r1.json().status).toBe("escrowed");
    expect(r1.json().raisedMinor).toBe(900000);

    // Over remaining without confirm -> 409 exceeds_remaining with details.remainingMinor
    const r2 = await app.inject({
      method: "POST",
      url: `/projects/${pid}/invest`,
      cookies: { [COOKIE]: cookie },
      payload: { amountMinor: 200000, source: "payment" },
    });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error.code).toBe("exceeds_remaining");
    expect(r2.json().error.details.remainingMinor).toBe(100000);

    // With confirm -> capped to 100_000, raised hits target, status funded
    const r3 = await app.inject({
      method: "POST",
      url: `/projects/${pid}/invest`,
      cookies: { [COOKIE]: cookie },
      payload: { amountMinor: 200000, source: "payment", confirmCapToRemaining: true },
    });
    expect(r3.statusCode).toBe(201);
    expect(r3.json().amountMinor).toBe(100000);
    expect(r3.json().raisedMinor).toBe(1000000);
    expect(r3.json().projectStatus).toBe("funded");

    // A further invest -> 409 invalid_state (no longer collecting)
    const r4 = await app.inject({
      method: "POST",
      url: `/projects/${pid}/invest`,
      cookies: { [COOKIE]: cookie },
      payload: { amountMinor: 50000, source: "payment" },
    });
    expect(r4.statusCode).toBe(409);
    expect(r4.json().error.code).toBe("invalid_state");

    await app.close();
  });

  it("invests from wallet balance (reinvestment entry, instant escrow) and rejects insufficient", async () => {
    const { app, db } = await buildTestApp();
    const cookie = await loginAs(app, "i@a.co");
    await verify(db, "i@a.co");
    const pid = await seedProject(db);
    const [inv] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.email, "i@a.co"));
    const { credit, getBalance } = await import("../src/modules/wallet/service");
    await credit(db, { accountId: inv!.id, amountMinor: 60000, type: "repayment", reference: "seed" });

    const r = await app.inject({
      method: "POST",
      url: `/projects/${pid}/invest`,
      cookies: { [COOKIE]: cookie },
      payload: { amountMinor: 50000, source: "wallet" },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.investmentId).toBeDefined();
    // Wallet settles instantly: escrowed, no deposit ref, raised advanced.
    expect(body.status).toBe("escrowed");
    expect(body.depositRef).toBeNull();
    expect(body.raisedMinor).toBe(50000);

    // The investment row is escrowed.
    const [invRow] = await db.select().from(investments).where(eq(investments.id, body.investmentId));
    expect(invRow!.status).toBe("escrowed");

    // Balance dropped by 50_000 via a -amount reinvestment entry referencing the investment
    expect(await getBalance(db, inv!.id)).toBe(10000);
    const wr = await app.inject({ method: "GET", url: "/wallet", cookies: { [COOKIE]: cookie } });
    const entries = wr.json().entries as Array<{ type: string; amountMinor: number; reference: string }>;
    const reinv = entries.find((e) => e.type === "reinvestment");
    expect(reinv).toBeDefined();
    expect(reinv!.amountMinor).toBe(-50000);
    expect(reinv!.reference).toBe(body.investmentId);

    // Insufficient wallet -> 400 insufficient_funds
    const r2 = await app.inject({
      method: "POST",
      url: `/projects/${pid}/invest`,
      cookies: { [COOKIE]: cookie },
      payload: { amountMinor: 999999, source: "wallet", confirmCapToRemaining: true },
    });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().error.code).toBe("insufficient_funds");

    await app.close();
  });

  it("returns 402 payment_failed and rolls back when the provider declines the deposit", async () => {
    // Inject a payments provider whose initiateDeposit always fails. The invest
    // transaction must roll back entirely: no investment row, no raised_minor
    // change.
    const failingPayments: PaymentProvider = {
      async payout() {
        return { ok: false, ref: "" };
      },
      async initiateDeposit() {
        return { ok: false, ref: "", status: "settled" as const };
      },
      async releaseEscrow() {
        return { ok: false, ref: "" };
      },
      async refundEscrow() {
        return { ok: false, ref: "" };
      },
    };
    const { app, db } = await buildTestApp({ payments: failingPayments });
    const cookie = await loginAs(app, "i@a.co");
    await verify(db, "i@a.co");
    const pid = await seedProject(db);

    const r = await app.inject({
      method: "POST",
      url: `/projects/${pid}/invest`,
      cookies: { [COOKIE]: cookie },
      payload: { amountMinor: 50000, source: "payment" },
    });
    expect(r.statusCode).toBe(402);
    expect(r.json().error.code).toBe("payment_failed");

    // Transaction rolled back: no investment row exists for this project, and
    // raised_minor is untouched.
    const rows = await db.select().from(investments).where(eq(investments.projectId, pid));
    expect(rows).toHaveLength(0);
    const [p] = await db.select().from(projects).where(eq(projects.id, pid));
    expect(p!.raisedMinor).toBe(0);
    expect(p!.status).toBe("collecting");

    await app.close();
  });

  it("serializes concurrent invests so the project can never overfund", async () => {
    const { app, db } = await buildTestApp();
    const cookie = await loginAs(app, "i@a.co");
    await verify(db, "i@a.co");
    // remaining = 100_000. Two concurrent invests of 80_000 each would together
    // overfund (160_000 > 100_000). The FOR UPDATE lock serializes them AND the
    // remaining check counts in-flight pending deposits, so exactly one succeeds;
    // the other reads remaining = target - raised - pending and is rejected. This
    // holds even though (in the two-phase flow) raised_minor only advances at
    // settlement, outside the invest lock.
    const pid = await seedProject(db, { targetMinor: 1000000, raisedMinor: 900000 });

    const fire = () =>
      app.inject({
        method: "POST",
        url: `/projects/${pid}/invest`,
        cookies: { [COOKIE]: cookie },
        payload: { amountMinor: 80000, source: "payment" },
      });
    const [a, b] = await Promise.all([fire(), fire()]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([201, 409]);
    const failed = a.statusCode === 409 ? a : b;
    expect(failed.json().error.code).toBe("exceeds_remaining");
    expect(failed.json().error.details.remainingMinor).toBe(20000);

    // Never overfunded: raised advanced by exactly one 80_000 invest (at settlement).
    const [p] = await db.select().from(projects).where(eq(projects.id, pid));
    expect(p!.raisedMinor).toBe(980000);
    expect(p!.status).toBe("collecting");

    await app.close();
  });
});
