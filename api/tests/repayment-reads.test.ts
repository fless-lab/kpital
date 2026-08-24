import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { buildTestApp, loginAs } from "./helpers/app";
import { accounts, projects, repaymentInstallments } from "../src/db/schema";

const COOKIE = "kpital_sess";

type Db = Awaited<ReturnType<typeof buildTestApp>>["db"];

// Seed a `repaying` project owned by a freshly registered account (so the owner
// can log in over HTTP), with a schedule inserted OUT OF seq order to prove the
// route sorts by seq. Returns the owner cookie and the project id.
async function seedScheduled(
  app: Awaited<ReturnType<typeof buildTestApp>>["app"],
  db: Db,
  ownerEmail = "owner@a.co",
) {
  const ownerCookie = await loginAs(app, ownerEmail);
  const [owner] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.email, ownerEmail));

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
      status: "repaying",
      raisedMinor: 1000000,
    })
    .returning();

  const settledAt = new Date("2026-03-01T00:00:00.000Z");
  // Inserted seq 2 then seq 1 then seq 3, so a raw insert-order read would be wrong.
  await db.insert(repaymentInstallments).values([
    { projectId: p!.id, seq: 2, amountMinor: 40000, dueAt: new Date("2026-02-01T00:00:00.000Z"), status: "due" },
    { projectId: p!.id, seq: 1, amountMinor: 30000, dueAt: new Date("2026-01-01T00:00:00.000Z"), status: "paid", settledAt },
    { projectId: p!.id, seq: 3, amountMinor: 50000, dueAt: new Date("2026-03-01T00:00:00.000Z"), status: "due" },
  ]);

  return { pid: p!.id, ownerId: owner!.id, ownerCookie };
}

describe("GET /projects/:id/repayment-schedule", () => {
  it("returns the owner's schedule ordered by seq with correct totals", async () => {
    const { app, db } = await buildTestApp();
    const { pid, ownerCookie } = await seedScheduled(app, db);

    const res = await app.inject({
      method: "GET",
      url: `/projects/${pid}/repayment-schedule`,
      cookies: { [COOKIE]: ownerCookie },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      installments: Array<Record<string, unknown>>;
      totalOwedMinor: number;
      paidCount: number;
      totalCount: number;
    };

    // Ordered by seq ascending.
    expect(body.installments.map((i) => i.seq)).toEqual([1, 2, 3]);
    expect(body.totalOwedMinor).toBe(120000);
    expect(body.paidCount).toBe(1);
    expect(body.totalCount).toBe(3);

    const first = body.installments[0]!;
    expect(first.seq).toBe(1);
    expect(first.amountMinor).toBe(30000);
    expect(first.status).toBe("paid");
    expect(typeof first.dueAt).toBe("string");
    expect(typeof first.settledAt).toBe("string");

    // A `due` installment carries a null settledAt.
    const second = body.installments[1]!;
    expect(second.status).toBe("due");
    expect(second.settledAt).toBeNull();

    // No investor PII / internal fields leak.
    for (const ins of body.installments) {
      expect(ins).not.toHaveProperty("repaymentRef");
      expect(ins).not.toHaveProperty("projectId");
      expect(ins).not.toHaveProperty("id");
      expect(ins).not.toHaveProperty("investmentId");
      expect(ins).not.toHaveProperty("investorAccountId");
    }

    await app.close();
  });

  it("forbids a non-owner from reading the schedule", async () => {
    const { app, db } = await buildTestApp();
    const { pid } = await seedScheduled(app, db);
    const strangerCookie = await loginAs(app, "stranger@a.co");

    const res = await app.inject({
      method: "GET",
      url: `/projects/${pid}/repayment-schedule`,
      cookies: { [COOKIE]: strangerCookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");

    await app.close();
  });

  it("requires authentication", async () => {
    const { app, db } = await buildTestApp();
    const { pid } = await seedScheduled(app, db);
    const res = await app.inject({ method: "GET", url: `/projects/${pid}/repayment-schedule` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 404 for a non-UUID project id", async () => {
    const { app } = await buildTestApp();
    const cookie = await loginAs(app, "owner@a.co");
    const res = await app.inject({
      method: "GET",
      url: "/projects/not-a-uuid/repayment-schedule",
      cookies: { [COOKIE]: cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
    await app.close();
  });

  it("returns 404 for a missing project", async () => {
    const { app } = await buildTestApp();
    const cookie = await loginAs(app, "owner@a.co");
    const res = await app.inject({
      method: "GET",
      url: "/projects/00000000-0000-4000-8000-000000000999/repayment-schedule",
      cookies: { [COOKIE]: cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
    await app.close();
  });
});
