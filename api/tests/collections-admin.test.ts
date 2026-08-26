import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { buildTestApp, loginAs } from "./helpers/app";
import { accounts, projects, repaymentInstallments, investments, notificationPrefs } from "../src/db/schema";
import type { Notifier } from "../src/lib/notifier";

const COOKIE = "kpital_sess";
const DAY = 24 * 60 * 60 * 1000;

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY);
}

async function loginAsAdmin(
  app: Awaited<ReturnType<typeof buildTestApp>>["app"],
  db: Awaited<ReturnType<typeof buildTestApp>>["db"],
  email = "admin@collections.co",
): Promise<string> {
  const cookie = await loginAs(app, email);
  await db.update(accounts).set({ isAdmin: true }).where(eq(accounts.email, email));
  return cookie;
}

let seq = 0;

async function seedAccount(
  db: any,
  opts: { channels?: string[] | null; roles?: string[] } = {},
): Promise<{ id: string; email: string }> {
  seq += 1;
  const email = `acct${seq}@collections.co`;
  const [acc] = await db
    .insert(accounts)
    .values({ email, passwordHash: "x", firstName: "F", lastName: "L", country: "Togo", roles: opts.roles ?? ["porteur"] })
    .returning({ id: accounts.id });
  if (opts.channels !== undefined && opts.channels !== null) {
    await db.insert(notificationPrefs).values({ accountId: acc.id, channels: opts.channels });
  }
  return { id: acc.id, email };
}

async function seedProject(
  db: any,
  ownerAccountId: string,
  status: "repaying" | "defaulted",
  opts: { defaultedAt?: Date | null; adminDefaulted?: boolean } = {},
): Promise<string> {
  const [p] = await db
    .insert(projects)
    .values({
      ownerAccountId,
      category: "commerce",
      title: "P",
      city: "Lome",
      description: "d",
      targetMinor: 1_000_000,
      durationMonths: 6,
      roiPct: "16",
      fundsUsage: "u",
      cautionType: "a",
      status,
      defaultedAt: opts.defaultedAt ?? (status === "defaulted" ? daysAgo(1) : null),
      adminDefaulted: opts.adminDefaulted ?? false,
      raisedMinor: 1_000_000,
    })
    .returning({ id: projects.id });
  return p.id;
}

async function seedInstallment(
  db: any,
  projectId: string,
  opts: { dueAt: Date; status?: "due" | "pending" | "paid"; s?: number },
): Promise<void> {
  await db.insert(repaymentInstallments).values({
    projectId,
    seq: opts.s ?? 1,
    amountMinor: 100_000,
    dueAt: opts.dueAt,
    status: opts.status ?? "due",
  });
}

async function seedReleasedInvestor(db: any, projectId: string): Promise<string> {
  const investor = await seedAccount(db, { channels: ["email"], roles: ["investisseur"] });
  await db.insert(investments).values({
    projectId,
    investorAccountId: investor.id,
    amountMinor: 500_000,
    source: "payment",
    status: "released",
  });
  return investor.email;
}

describe("collections admin endpoints", () => {
  it("runs the sweep and returns a summary (admin only; non-admin 403)", async () => {
    const { app, db, sentMessages } = await buildTestApp();
    const adminCookie = await loginAsAdmin(app, db);

    const owner = await seedAccount(db, { channels: [] }); // silence porteur reminder
    const project = await seedProject(db, owner.id, "repaying");
    await seedInstallment(db, project, { dueAt: daysAgo(40) });
    const investorEmail = await seedReleasedInvestor(db, project);

    const r = await app.inject({ method: "POST", url: "/admin/repayment/sweep", cookies: { [COOKIE]: adminCookie } });
    expect(r.statusCode).toBe(200);
    const summary = r.json();
    expect(summary).toMatchObject({ remindersSent: expect.any(Number), defaulted: expect.any(Number), recovered: expect.any(Number) });
    expect(summary.defaulted).toBe(1);

    const [p] = await db.select({ status: projects.status }).from(projects).where(eq(projects.id, project));
    expect(p!.status).toBe("defaulted");
    // The default transition notifies the released investor.
    expect(sentMessages.some((m) => m.to.email === investorEmail && m.subject === "Projet en defaut de remboursement")).toBe(true);

    // Non-admin caller is rejected.
    const userCookie = await loginAs(app, "user@collections.co");
    const forbidden = await app.inject({ method: "POST", url: "/admin/repayment/sweep", cookies: { [COOKIE]: userCookie } });
    expect(forbidden.statusCode).toBe(403);
  });

  it("admin default guards repaying->defaulted, sets admin_defaulted, notifies investors (409 otherwise)", async () => {
    const { app, db, sentMessages } = await buildTestApp();
    const adminCookie = await loginAsAdmin(app, db);
    const owner = await seedAccount(db);
    const project = await seedProject(db, owner.id, "repaying");
    const investorEmail = await seedReleasedInvestor(db, project);

    const r = await app.inject({ method: "POST", url: `/admin/projects/${project}/default`, cookies: { [COOKIE]: adminCookie } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });

    const [p] = await db
      .select({ status: projects.status, defaultedAt: projects.defaultedAt, adminDefaulted: projects.adminDefaulted })
      .from(projects)
      .where(eq(projects.id, project));
    expect(p!.status).toBe("defaulted");
    expect(p!.defaultedAt).not.toBeNull();
    expect(p!.adminDefaulted).toBe(true);
    expect(sentMessages.some((m) => m.to.email === investorEmail && m.subject === "Projet en defaut de remboursement")).toBe(true);

    // Re-default a now-defaulted project -> guard fails -> 409, no double notify.
    const before = sentMessages.length;
    const again = await app.inject({ method: "POST", url: `/admin/projects/${project}/default`, cookies: { [COOKIE]: adminCookie } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("invalid_state");
    expect(sentMessages.length).toBe(before);
  });

  it("admin undefault guards defaulted->repaying and clears admin_defaulted (409 otherwise)", async () => {
    const { app, db } = await buildTestApp();
    const adminCookie = await loginAsAdmin(app, db);
    const owner = await seedAccount(db);
    const project = await seedProject(db, owner.id, "defaulted", { adminDefaulted: true });

    const r = await app.inject({ method: "POST", url: `/admin/projects/${project}/undefault`, cookies: { [COOKIE]: adminCookie } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });

    const [p] = await db
      .select({ status: projects.status, defaultedAt: projects.defaultedAt, adminDefaulted: projects.adminDefaulted })
      .from(projects)
      .where(eq(projects.id, project));
    expect(p!.status).toBe("repaying");
    expect(p!.defaultedAt).toBeNull();
    expect(p!.adminDefaulted).toBe(false);

    // Undefault a repaying project -> guard fails -> 409.
    const again = await app.inject({ method: "POST", url: `/admin/projects/${project}/undefault`, cookies: { [COOKIE]: adminCookie } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("invalid_state");
  });

  it("returns 404 for a non-UUID id on default and undefault, 403 for a non-admin caller", async () => {
    const { app, db } = await buildTestApp();
    const adminCookie = await loginAsAdmin(app, db);

    const d = await app.inject({ method: "POST", url: "/admin/projects/not-a-uuid/default", cookies: { [COOKIE]: adminCookie } });
    expect(d.statusCode).toBe(404);
    const u = await app.inject({ method: "POST", url: "/admin/projects/not-a-uuid/undefault", cookies: { [COOKIE]: adminCookie } });
    expect(u.statusCode).toBe(404);

    // Well-formed but absent -> 404.
    const missing = "11111111-2222-4333-8444-555555555555";
    const absent = await app.inject({ method: "POST", url: `/admin/projects/${missing}/default`, cookies: { [COOKIE]: adminCookie } });
    expect(absent.statusCode).toBe(404);

    // Non-admin caller -> 403 (before the UUID check runs).
    const userCookie = await loginAs(app, "user2@collections.co");
    const forbidden = await app.inject({ method: "POST", url: `/admin/projects/${missing}/default`, cookies: { [COOKIE]: userCookie } });
    expect(forbidden.statusCode).toBe(403);
  });

  it("STICKY: a subsequent sweep does not auto-recover an admin-defaulted project, but does recover a schedule-defaulted one (same run)", async () => {
    const { app, db } = await buildTestApp();
    const adminCookie = await loginAsAdmin(app, db);

    // Project A: admin-defaults it through the route (sets admin_defaulted=true).
    // No grace-exceeded due installment (a paid one), so phase 3 would recover it
    // were it not sticky.
    const ownerA = await seedAccount(db);
    const projectA = await seedProject(db, ownerA.id, "repaying");
    await seedInstallment(db, projectA, { dueAt: daysAgo(40), status: "paid" });
    const defaultRes = await app.inject({ method: "POST", url: `/admin/projects/${projectA}/default`, cookies: { [COOKIE]: adminCookie } });
    expect(defaultRes.statusCode).toBe(200);
    const [aAfterDefault] = await db.select({ adminDefaulted: projects.adminDefaulted }).from(projects).where(eq(projects.id, projectA));
    expect(aAfterDefault!.adminDefaulted).toBe(true);

    // Project B: schedule-defaulted (admin_defaulted=false) with retards cleared
    // (its overdue installment is paid) -> phase 3 must recover it.
    const ownerB = await seedAccount(db);
    const projectB = await seedProject(db, ownerB.id, "defaulted", { defaultedAt: daysAgo(3), adminDefaulted: false });
    await seedInstallment(db, projectB, { dueAt: daysAgo(40), status: "paid" });

    // One sweep run over both projects.
    const sweep = await app.inject({ method: "POST", url: "/admin/repayment/sweep", cookies: { [COOKIE]: adminCookie } });
    expect(sweep.statusCode).toBe(200);
    expect(sweep.json().recovered).toBe(1); // exactly B, not A

    const [a] = await db.select({ status: projects.status }).from(projects).where(eq(projects.id, projectA));
    const [b] = await db.select({ status: projects.status }).from(projects).where(eq(projects.id, projectB));
    expect(a!.status).toBe("defaulted"); // sticky: NOT auto-recovered
    expect(b!.status).toBe("repaying"); // schedule-default: auto-recovered
  });

  it("lifecycle: admin default -> sweep keeps defaulted -> undefault -> subsequent sweep does not re-default", async () => {
    const { app, db } = await buildTestApp();
    const adminCookie = await loginAsAdmin(app, db);
    const owner = await seedAccount(db);
    const project = await seedProject(db, owner.id, "repaying");
    await seedInstallment(db, project, { dueAt: daysAgo(40), status: "paid" }); // no grace-exceeded due retard

    await app.inject({ method: "POST", url: `/admin/projects/${project}/default`, cookies: { [COOKIE]: adminCookie } });
    await app.inject({ method: "POST", url: "/admin/repayment/sweep", cookies: { [COOKIE]: adminCookie } });
    const [s1] = await db.select({ status: projects.status, adminDefaulted: projects.adminDefaulted }).from(projects).where(eq(projects.id, project));
    expect(s1!.status).toBe("defaulted"); // sweep did not lift the admin default

    const undo = await app.inject({ method: "POST", url: `/admin/projects/${project}/undefault`, cookies: { [COOKIE]: adminCookie } });
    expect(undo.statusCode).toBe(200);
    const [s2] = await db.select({ status: projects.status, adminDefaulted: projects.adminDefaulted }).from(projects).where(eq(projects.id, project));
    expect(s2!.status).toBe("repaying");
    expect(s2!.adminDefaulted).toBe(false);

    // A subsequent sweep must not re-default it (its only overdue retard is paid).
    await app.inject({ method: "POST", url: "/admin/repayment/sweep", cookies: { [COOKIE]: adminCookie } });
    const [s3] = await db.select({ status: projects.status }).from(projects).where(eq(projects.id, project));
    expect(s3!.status).toBe("repaying");
  });

  it("a sweep whose notifier.send rejects still resolves and still sets reminded_at and transitions", async () => {
    const throwing: Notifier = { async send() { throw new Error("delivery boom"); } };
    const { app, db } = await buildTestApp({ notifier: throwing });
    const adminCookie = await loginAsAdmin(app, db);

    const owner = await seedAccount(db, { channels: ["email"] }); // porteur reminded (send throws)
    const project = await seedProject(db, owner.id, "repaying");
    await seedInstallment(db, project, { dueAt: daysAgo(40) }); // overdue past grace -> reminds AND defaults
    await seedReleasedInvestor(db, project); // investor notify also throws

    const r = await app.inject({ method: "POST", url: "/admin/repayment/sweep", cookies: { [COOKIE]: adminCookie } });
    expect(r.statusCode).toBe(200);
    const summary = r.json();
    expect(summary.remindersSent).toBe(1);
    expect(summary.defaulted).toBe(1);

    // The reminder is durable and the transition happened despite delivery failing.
    const [ins] = await db.select({ remindedAt: repaymentInstallments.remindedAt }).from(repaymentInstallments).where(eq(repaymentInstallments.projectId, project));
    expect(ins!.remindedAt).not.toBeNull();
    const [p] = await db.select({ status: projects.status }).from(projects).where(eq(projects.id, project));
    expect(p!.status).toBe("defaulted");
  });
});
