import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { buildTestApp, loginAs } from "./helpers/app";
import { MockPaymentProvider } from "../src/lib/payments";
import { accounts, projects, investments, wallets, repaymentInstallments } from "../src/db/schema";

const COOKIE = "kpital_sess";
const DAY = 24 * 60 * 60 * 1000;

type App = Awaited<ReturnType<typeof buildTestApp>>["app"];
type Db = Awaited<ReturnType<typeof buildTestApp>>["db"];

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY);
}
function daysFromNow(n: number): Date {
  return new Date(Date.now() + n * DAY);
}

interface InstallmentSpec {
  seq: number;
  amountMinor: number;
  dueAt: Date;
  status?: "due" | "pending" | "paid";
}

interface SeedOpts {
  projectStatus?: "repaying" | "defaulted";
  adminDefaulted?: boolean;
  defaultedAt?: Date | null;
  installments: InstallmentSpec[];
  ownerEmail?: string;
}

// Seed a project owned by a freshly registered account (so the owner can log in
// and call /repay), with a frozen (all released) investor set covering raised,
// and an explicit installment schedule. Mirrors repayment-repay.test.ts seeding,
// extended for a defaulted / admin-defaulted project and per-installment due_at.
async function seedProject(app: App, db: Db, opts: SeedOpts) {
  const investorAmounts = [500000, 300000, 200000];
  const raised = investorAmounts.reduce((s, a) => s + a, 0);

  const ownerEmail = opts.ownerEmail ?? "owner@a.co";
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
      targetMinor: raised,
      durationMonths: 6,
      roiPct: "16",
      fundsUsage: "u",
      cautionType: "a",
      status: opts.projectStatus ?? "repaying",
      adminDefaulted: opts.adminDefaulted ?? false,
      defaultedAt: opts.defaultedAt ?? null,
      raisedMinor: raised,
    })
    .returning();

  for (let i = 0; i < investorAmounts.length; i += 1) {
    const [acc] = await db
      .insert(accounts)
      .values({ email: `i${i}@a.co`, passwordHash: "x", firstName: "I", lastName: String(i), country: "Togo", roles: ["investor"] })
      .returning();
    await db.insert(wallets).values({ accountId: acc!.id });
    await db
      .insert(investments)
      .values({ projectId: p!.id, investorAccountId: acc!.id, amountMinor: investorAmounts[i]!, source: "payment", paymentRef: `d${i}`, status: "released" });
  }

  const installments: (typeof repaymentInstallments.$inferSelect)[] = [];
  for (const spec of opts.installments) {
    const [ins] = await db
      .insert(repaymentInstallments)
      .values({ projectId: p!.id, seq: spec.seq, amountMinor: spec.amountMinor, dueAt: spec.dueAt, status: spec.status ?? "due" })
      .returning();
    installments.push(ins!);
  }

  return { pid: p!.id, ownerId: owner!.id, ownerCookie, installments };
}

describe("POST /projects/:id/repay (collections: defaulted + auto-recovery)", () => {
  it("accepts /repay on a defaulted project (not 409) while a grace-exceeded due remains", async () => {
    const { app, db } = await buildTestApp();
    const { pid, ownerCookie, installments } = await seedProject(app, db, {
      projectStatus: "defaulted",
      defaultedAt: daysAgo(3),
      installments: [
        { seq: 1, amountMinor: 100000, dueAt: daysAgo(40) },
        { seq: 2, amountMinor: 100000, dueAt: daysAgo(40) },
      ],
    });

    const r = await app.inject({ method: "POST", url: `/projects/${pid}/repay`, cookies: { [COOKIE]: ownerCookie } });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.installmentId).toBe(installments[0]!.id);
    expect(body.status).toBe("paid");
  });

  it("auto-recovers a defaulted project to repaying when the last grace-exceeded due is cleared", async () => {
    const { app, db } = await buildTestApp();
    const { pid, ownerCookie } = await seedProject(app, db, {
      projectStatus: "defaulted",
      defaultedAt: daysAgo(3),
      installments: [
        { seq: 1, amountMinor: 100000, dueAt: daysAgo(40) }, // grace-exceeded, paid this call
        { seq: 2, amountMinor: 100000, dueAt: daysFromNow(30) }, // future due, NOT grace-exceeded
      ],
    });

    const r = await app.inject({ method: "POST", url: `/projects/${pid}/repay`, cookies: { [COOKIE]: ownerCookie } });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.status).toBe("paid");
    expect(body.projectStatus).toBe("repaying");

    const [p] = await db.select({ status: projects.status, defaultedAt: projects.defaultedAt }).from(projects).where(eq(projects.id, pid));
    expect(p!.status).toBe("repaying");
    expect(p!.defaultedAt).toBeNull();
  });

  it("keeps a project defaulted after /repay if another grace-exceeded due remains", async () => {
    const { app, db } = await buildTestApp();
    const { pid, ownerCookie } = await seedProject(app, db, {
      projectStatus: "defaulted",
      defaultedAt: daysAgo(3),
      installments: [
        { seq: 1, amountMinor: 100000, dueAt: daysAgo(40) }, // paid this call
        { seq: 2, amountMinor: 100000, dueAt: daysAgo(40) }, // still grace-exceeded
      ],
    });

    const r = await app.inject({ method: "POST", url: `/projects/${pid}/repay`, cookies: { [COOKIE]: ownerCookie } });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.status).toBe("paid");
    expect(body.projectStatus).toBe("defaulted");

    const [p] = await db.select({ status: projects.status, defaultedAt: projects.defaultedAt }).from(projects).where(eq(projects.id, pid));
    expect(p!.status).toBe("defaulted");
    expect(p!.defaultedAt).not.toBeNull();
  });

  it("does NOT auto-recover an admin-defaulted project even when no grace-exceeded due remains (sticky)", async () => {
    const { app, db } = await buildTestApp();
    const { pid, ownerCookie } = await seedProject(app, db, {
      projectStatus: "defaulted",
      adminDefaulted: true,
      defaultedAt: daysAgo(3),
      installments: [
        { seq: 1, amountMinor: 100000, dueAt: daysAgo(40) }, // paid this call
        { seq: 2, amountMinor: 100000, dueAt: daysFromNow(30) }, // future due, NOT grace-exceeded
      ],
    });

    const r = await app.inject({ method: "POST", url: `/projects/${pid}/repay`, cookies: { [COOKIE]: ownerCookie } });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.status).toBe("paid");
    // Sticky admin default: the auto-lift's admin_defaulted=false guard blocks it.
    expect(body.projectStatus).toBe("defaulted");

    const [p] = await db.select({ status: projects.status, defaultedAt: projects.defaultedAt }).from(projects).where(eq(projects.id, pid));
    expect(p!.status).toBe("defaulted");
    expect(p!.defaultedAt).not.toBeNull();
  });

  it("does NOT auto-recover on a pending collection (money has not landed)", async () => {
    const pending = new MockPaymentProvider();
    pending.repaymentMode = "pending";
    const { app, db } = await buildTestApp({ payments: pending });
    const { pid, ownerCookie, installments } = await seedProject(app, db, {
      projectStatus: "defaulted",
      defaultedAt: daysAgo(3),
      installments: [{ seq: 1, amountMinor: 100000, dueAt: daysAgo(40) }],
    });

    const r = await app.inject({ method: "POST", url: `/projects/${pid}/repay`, cookies: { [COOKIE]: ownerCookie } });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.status).toBe("pending");
    // A pending collection distributes nothing and must not lift the default: the
    // grace-exceeded due is still `pending`, and the money has not settled.
    expect(body.projectStatus).toBe("defaulted");

    const [ins] = await db.select({ status: repaymentInstallments.status }).from(repaymentInstallments).where(eq(repaymentInstallments.id, installments[0]!.id));
    expect(ins!.status).toBe("pending");
    const [p] = await db.select({ status: projects.status }).from(projects).where(eq(projects.id, pid));
    expect(p!.status).toBe("defaulted");
  });

  it("closes a defaulted project when its final installment is paid (fully repaid is terminal)", async () => {
    const { app, db } = await buildTestApp();
    // A defaulted project whose ONLY installment is now paid must reach `closed`,
    // not get stuck in repaying: settleRepayment closes from repaying OR defaulted.
    const { pid, ownerCookie, installments } = await seedProject(app, db, {
      projectStatus: "defaulted",
      defaultedAt: daysAgo(3),
      installments: [{ seq: 1, amountMinor: 100000, dueAt: daysAgo(40) }],
    });

    const r = await app.inject({ method: "POST", url: `/projects/${pid}/repay`, cookies: { [COOKIE]: ownerCookie } });
    expect(r.statusCode).toBe(201);
    expect(r.json().status).toBe("paid");
    expect(r.json().projectStatus).toBe("closed");

    const [ins] = await db.select({ status: repaymentInstallments.status }).from(repaymentInstallments).where(eq(repaymentInstallments.id, installments[0]!.id));
    expect(ins!.status).toBe("paid");
    const [p] = await db.select({ status: projects.status }).from(projects).where(eq(projects.id, pid));
    expect(p!.status).toBe("closed");
  });

  it("closes an admin-defaulted project too when fully repaid (closed is terminal, sticky governs the active axis)", async () => {
    const { app, db } = await buildTestApp();
    const { pid, ownerCookie } = await seedProject(app, db, {
      projectStatus: "defaulted",
      adminDefaulted: true,
      defaultedAt: daysAgo(3),
      installments: [{ seq: 1, amountMinor: 100000, dueAt: daysAgo(40) }],
    });

    const r = await app.inject({ method: "POST", url: `/projects/${pid}/repay`, cookies: { [COOKIE]: ownerCookie } });
    expect(r.statusCode).toBe(201);
    expect(r.json().status).toBe("paid");
    // Fully repaid closes even when admin-defaulted: the sticky flag blocks the
    // repaying auto-lift (active axis), not the terminal close.
    expect(r.json().projectStatus).toBe("closed");
    const [p] = await db.select({ status: projects.status }).from(projects).where(eq(projects.id, pid));
    expect(p!.status).toBe("closed");
  });
});
