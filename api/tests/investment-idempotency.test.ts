import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { buildTestApp, loginAs } from "./helpers/app";
import { accounts, projects, investments } from "../src/db/schema";

const COOKIE = "kpital_sess";
const KEY = "idem-key-";

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

function invest(app: Awaited<ReturnType<typeof buildTestApp>>["app"], pid: string, cookie: string, key: string | null, amountMinor = 50000) {
  return app.inject({
    method: "POST",
    url: `/projects/${pid}/invest`,
    cookies: { [COOKIE]: cookie },
    ...(key !== null ? { headers: { "idempotency-key": key } } : {}),
    payload: { amountMinor, source: "payment" },
  });
}

describe("POST /projects/:id/invest idempotency", () => {
  it("a replay with the same Idempotency-Key returns the same investment and does not double-invest", async () => {
    const { app, db } = await buildTestApp();
    const cookie = await loginAs(app, "i@a.co");
    await verify(db, "i@a.co");
    const pid = await seedProject(db);

    const r1 = await invest(app, pid, cookie, KEY + "A");
    const r2 = await invest(app, pid, cookie, KEY + "A");

    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
    const b1 = r1.json();
    const b2 = r2.json();
    // Same logical request -> same investment, returned twice.
    expect(b2.investmentId).toBe(b1.investmentId);

    // Exactly ONE investment row exists, and raised advanced ONCE.
    const rows = await db.select().from(investments).where(eq(investments.projectId, pid));
    expect(rows.length).toBe(1);
    const [pj] = await db.select().from(projects).where(eq(projects.id, pid));
    expect(pj!.raisedMinor).toBe(50000);

    await app.close();
  });

  it("two different keys create two investments", async () => {
    const { app, db } = await buildTestApp();
    const cookie = await loginAs(app, "i@a.co");
    await verify(db, "i@a.co");
    const pid = await seedProject(db);

    const r1 = await invest(app, pid, cookie, KEY + "A");
    const r2 = await invest(app, pid, cookie, KEY + "B");
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
    expect(r2.json().investmentId).not.toBe(r1.json().investmentId);

    const rows = await db.select().from(investments).where(eq(investments.projectId, pid));
    expect(rows.length).toBe(2);
    const [pj] = await db.select().from(projects).where(eq(projects.id, pid));
    expect(pj!.raisedMinor).toBe(100000);

    await app.close();
  });

  it("rejects an invest with no Idempotency-Key header (400)", async () => {
    const { app, db } = await buildTestApp();
    const cookie = await loginAs(app, "i@a.co");
    await verify(db, "i@a.co");
    const pid = await seedProject(db);

    const r = await invest(app, pid, cookie, null);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("validation_error");

    const rows = await db.select().from(investments).where(eq(investments.projectId, pid));
    expect(rows.length).toBe(0);

    await app.close();
  });

  it("two concurrent requests with the same key create exactly one investment", async () => {
    const { app, db } = await buildTestApp();
    const cookie = await loginAs(app, "i@a.co");
    await verify(db, "i@a.co");
    const pid = await seedProject(db);

    // Fire both before awaiting either: the unique index must serialize them so
    // only one investment is created and raised advances once.
    const [r1, r2] = await Promise.all([
      invest(app, pid, cookie, KEY + "R"),
      invest(app, pid, cookie, KEY + "R"),
    ]);
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
    expect(r1.json().investmentId).toBe(r2.json().investmentId);

    const rows = await db.select().from(investments).where(eq(investments.projectId, pid));
    expect(rows.length).toBe(1);
    const [pj] = await db.select().from(projects).where(eq(projects.id, pid));
    expect(pj!.raisedMinor).toBe(50000);

    await app.close();
  });

  it("reusing a key for a different project is a 409 conflict, not a wrong-project replay", async () => {
    const { app, db } = await buildTestApp();
    const cookie = await loginAs(app, "i@a.co");
    await verify(db, "i@a.co");
    const pidA = await seedProject(db);
    const pidB = await seedProject(db);

    const rA = await invest(app, pidA, cookie, KEY + "X");
    expect(rA.statusCode).toBe(201);
    const rB = await invest(app, pidB, cookie, KEY + "X");
    expect(rB.statusCode).toBe(409);
    expect(rB.json().error.code).toBe("idempotency_conflict");

    // No investment was created on project B.
    const rowsB = await db.select().from(investments).where(eq(investments.projectId, pidB));
    expect(rowsB.length).toBe(0);

    await app.close();
  });
});
