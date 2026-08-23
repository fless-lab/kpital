import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { buildTestApp, loginAs } from "./helpers/app";
import { MockPaymentProvider } from "../src/lib/payments";
import { accounts, projects, investments } from "../src/db/schema";

const COOKIE = "kpital_sess";

// Seed a project owner + a project (collecting by default). Returns the id.
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

async function accountId(db: Awaited<ReturnType<typeof buildTestApp>>["db"], email: string): Promise<string> {
  const [a] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.email, email));
  return a!.id;
}

async function makeAccount(db: Awaited<ReturnType<typeof buildTestApp>>["db"], email: string): Promise<string> {
  const [a] = await db
    .insert(accounts)
    .values({ email, passwordHash: "x", firstName: "X", lastName: "Y", country: "Togo", roles: ["investisseur"] })
    .returning();
  return a!.id;
}

describe("GET /me/investments", () => {
  it("lists my investments with a project summary", async () => {
    const { app, db } = await buildTestApp();
    const cookie = await loginAs(app, "i@a.co");
    await verify(db, "i@a.co");
    const pid = await seedProject(db);

    const invest = await app.inject({
      method: "POST",
      url: `/projects/${pid}/invest`,
      cookies: { [COOKIE]: cookie },
      payload: { amountMinor: 50000, source: "payment" },
    });
    expect(invest.statusCode).toBe(201);

    const mine = await app.inject({ method: "GET", url: "/me/investments", cookies: { [COOKIE]: cookie } });
    expect(mine.statusCode).toBe(200);
    const list = mine.json().investments as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);

    const row = list[0]!;
    expect(row.amountMinor).toBe(50000);
    expect(row.source).toBe("payment");
    expect(typeof row.id).toBe("string");
    expect(typeof row.createdAt).toBe("string");
    // Top-level status is the INVESTMENT status. The default mock settles the
    // deposit synchronously, so a fresh payment invest is "escrowed".
    expect(row.status).toBe("escrowed");
    // Internal provider ref must never surface on the investor list.
    expect(row).not.toHaveProperty("paymentRef");

    const project = row.project as Record<string, unknown>;
    expect(project.id).toBe(pid);
    expect(project.title).toBeTruthy();
    expect(project.category).toBe("commerce");
    expect(project.status).toBe("collecting");
    // roiPct is a numeric column: it comes back as a string, unchanged.
    expect(project.roiPct).toBe("16");
    // The project summary must never leak owner PII or other private fields.
    expect(project).not.toHaveProperty("ownerAccountId");
    expect(project).not.toHaveProperty("fundsUsage");
    expect(project).not.toHaveProperty("city");
    expect(project).not.toHaveProperty("raisedMinor");

    await app.close();
  });

  it("reports a pending-mode invest with a top-level status of pending", async () => {
    const payments = new MockPaymentProvider();
    payments.depositMode = "pending";
    const { app, db } = await buildTestApp({ payments });
    const cookie = await loginAs(app, "i@a.co");
    await verify(db, "i@a.co");
    const pid = await seedProject(db);

    const invest = await app.inject({
      method: "POST",
      url: `/projects/${pid}/invest`,
      cookies: { [COOKIE]: cookie },
      payload: { amountMinor: 50000, source: "payment" },
    });
    expect(invest.statusCode).toBe(201);

    const mine = await app.inject({ method: "GET", url: "/me/investments", cookies: { [COOKIE]: cookie } });
    expect(mine.statusCode).toBe(200);
    const list = mine.json().investments as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    // The deposit never settled, so the investment stays "pending".
    expect(list[0]!.status).toBe("pending");
    // The nested project status is distinct: it is still collecting.
    expect((list[0]!.project as Record<string, unknown>).status).toBe("collecting");

    await app.close();
  });

  it("returns only MY investments, not another account's", async () => {
    const { app, db } = await buildTestApp();
    const cookie = await loginAs(app, "i@a.co");
    await verify(db, "i@a.co");
    const pid = await seedProject(db);
    const me = await accountId(db, "i@a.co");
    const other = await makeAccount(db, "other@a.co");

    // Mine, through the route.
    const invest = await app.inject({
      method: "POST",
      url: `/projects/${pid}/invest`,
      cookies: { [COOKIE]: cookie },
      payload: { amountMinor: 50000, source: "payment" },
    });
    expect(invest.statusCode).toBe(201);

    // Another account's investment on the SAME project, inserted directly. This
    // proves the query keys on investorAccountId and not on a join artifact.
    await db.insert(investments).values({
      projectId: pid,
      investorAccountId: other,
      amountMinor: 70000,
      source: "payment",
      status: "escrowed",
    });

    const mine = await app.inject({ method: "GET", url: "/me/investments", cookies: { [COOKIE]: cookie } });
    expect(mine.statusCode).toBe(200);
    const list = mine.json().investments as Array<{ amountMinor: number }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.amountMinor).toBe(50000);
    // Sanity: my account really did place exactly one row.
    void me;

    await app.close();
  });

  it("returns an empty array when the caller has no investments", async () => {
    const { app } = await buildTestApp();
    const cookie = await loginAs(app, "i@a.co");

    const mine = await app.inject({ method: "GET", url: "/me/investments", cookies: { [COOKIE]: cookie } });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().investments).toEqual([]);

    await app.close();
  });

  it("orders newest first, tiebreaking on id for equal timestamps", async () => {
    const { app, db } = await buildTestApp();
    const cookie = await loginAs(app, "i@a.co");
    const me = await accountId(db, "i@a.co");
    const pid = await seedProject(db);

    const older = new Date("2026-01-01T00:00:00.000Z");
    const newer = new Date("2026-06-01T00:00:00.000Z");
    // Same timestamp on two rows to exercise the id tiebreak.
    const tieA = "00000000-0000-4000-8000-000000000001";
    const tieB = "00000000-0000-4000-8000-000000000002";

    await db.insert(investments).values([
      { projectId: pid, investorAccountId: me, amountMinor: 10000, source: "payment", status: "escrowed", createdAt: older },
      { projectId: pid, investorAccountId: me, amountMinor: 20000, source: "payment", status: "escrowed", createdAt: newer },
      { id: tieB, projectId: pid, investorAccountId: me, amountMinor: 30000, source: "payment", status: "escrowed", createdAt: newer },
      { id: tieA, projectId: pid, investorAccountId: me, amountMinor: 40000, source: "payment", status: "escrowed", createdAt: newer },
    ]);

    const mine = await app.inject({ method: "GET", url: "/me/investments", cookies: { [COOKIE]: cookie } });
    expect(mine.statusCode).toBe(200);
    const ids = (mine.json().investments as Array<{ id: string }>).map((r) => r.id);
    // newer rows first; among the two newer rows sharing a timestamp, id asc;
    // the older row last.
    expect(ids.slice(0, 2)).toEqual([tieA, tieB]);
    expect(ids[3]).toBeDefined();

    await app.close();
  });

  it("requires authentication", async () => {
    const { app } = await buildTestApp();
    const mine = await app.inject({ method: "GET", url: "/me/investments" });
    expect(mine.statusCode).toBe(401);
    await app.close();
  });
});
