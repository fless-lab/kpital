import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db/client";
import { buildTestApp } from "./helpers/app";
import { accounts, projects, investments, wallets } from "../src/db/schema";

// Seed a pending PAYMENT investment on a collecting project via direct inserts,
// mirroring escrow-settle.test.ts. paymentRef "dep-9" is the webhook depositRef.
async function seedPending(db: Db, opts: { targetMinor?: number; raisedMinor?: number; amount?: number } = {}) {
  const [investor] = await db.insert(accounts).values({ email: "wi@a.co", passwordHash: "x", firstName: "I", lastName: "A", country: "Togo", roles: ["investor"] }).returning();
  const [owner] = await db.insert(accounts).values({ email: "wo@a.co", passwordHash: "x", firstName: "O", lastName: "A", country: "Togo", roles: ["porteur"] }).returning();
  await db.insert(wallets).values({ accountId: owner!.id }); // porteur wallet for disbursement
  const [p] = await db.insert(projects).values({ ownerAccountId: owner!.id, category: "commerce", title: "P", city: "L", description: "d", targetMinor: opts.targetMinor ?? 1000000, durationMonths: 6, roiPct: "16", fundsUsage: "u", cautionType: "a", status: "collecting", raisedMinor: opts.raisedMinor ?? 0 }).returning();
  const [inv] = await db.insert(investments).values({ projectId: p!.id, investorAccountId: investor!.id, amountMinor: opts.amount ?? 50000, source: "payment", paymentRef: "dep-9", status: "pending" }).returning();
  return { pid: p!.id, invId: inv!.id, ownerId: owner!.id };
}

describe("POST /escrow/settlement (webhook)", () => {
  it("settles a pending deposit via the webhook and is idempotent on replay", async () => {
    const { app, db } = await buildTestApp({});
    const { pid, invId } = await seedPending(db);

    const call = () =>
      app.inject({
        method: "POST",
        url: "/escrow/settlement",
        headers: { "x-escrow-signature": "test-secret" },
        payload: { depositRef: "dep-9", status: "settled" },
      });

    const r1 = await call();
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ ok: true, applied: true });

    const r2 = await call();
    expect(r2.statusCode).toBe(200); // replay is a no-op
    expect(r2.json().applied).toBe(false);

    // raised advanced exactly once
    const [p] = await db.select().from(projects).where(eq(projects.id, pid));
    expect(p!.raisedMinor).toBe(50000);
    const [inv] = await db.select().from(investments).where(eq(investments.id, invId));
    expect(inv!.status).toBe("escrowed");
  });

  it("rejects a missing signature header with 401", async () => {
    const { app, db } = await buildTestApp({});
    await seedPending(db);
    const res = await app.inject({
      method: "POST",
      url: "/escrow/settlement",
      payload: { depositRef: "dep-9", status: "settled" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: "unauthorized", message: "bad signature" } });
  });

  it("rejects a wrong signature with 401", async () => {
    const { app, db } = await buildTestApp({});
    await seedPending(db);
    const res = await app.inject({
      method: "POST",
      url: "/escrow/settlement",
      headers: { "x-escrow-signature": "nope" },
      payload: { depositRef: "dep-9", status: "settled" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 for an unknown depositRef", async () => {
    const { app } = await buildTestApp({});
    const res = await app.inject({
      method: "POST",
      url: "/escrow/settlement",
      headers: { "x-escrow-signature": "test-secret" },
      payload: { depositRef: "nope", status: "settled" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("marks a deposit failed on status=failed and leaves raised untouched", async () => {
    const { app, db } = await buildTestApp({});
    const { pid, invId } = await seedPending(db);
    const res = await app.inject({
      method: "POST",
      url: "/escrow/settlement",
      headers: { "x-escrow-signature": "test-secret" },
      payload: { depositRef: "dep-9", status: "failed" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const [inv] = await db.select().from(investments).where(eq(investments.id, invId));
    expect(inv!.status).toBe("failed");
    const [p] = await db.select().from(projects).where(eq(projects.id, pid));
    expect(p!.raisedMinor).toBe(0);
  });

  it("rejects an invalid body with 400 validation_error", async () => {
    const { app, db } = await buildTestApp({});
    await seedPending(db);
    const res = await app.inject({
      method: "POST",
      url: "/escrow/settlement",
      headers: { "x-escrow-signature": "test-secret" },
      payload: { depositRef: "dep-9", status: "bogus" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });
});
