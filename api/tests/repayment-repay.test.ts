import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { buildTestApp, loginAs } from "./helpers/app";
import { MockPaymentProvider } from "../src/lib/payments";
import type { RepaymentRequest, RepaymentResult } from "../src/lib/payments";
import {
  accounts,
  projects,
  investments,
  wallets,
  walletEntries,
  repaymentInstallments,
  repaymentPayments,
  repaymentApplications,
} from "../src/db/schema";

const COOKIE = "kpital_sess";

type Db = Awaited<ReturnType<typeof buildTestApp>>["db"];

interface InstallmentSpec {
  seq: number;
  amountMinor: number;
  paidMinor?: number;
  status?: "due" | "pending" | "paid";
}

interface SeedOpts {
  investorAmounts?: number[];
  installments?: InstallmentSpec[];
  projectStatus?: string;
  ownerEmail?: string;
}

// Seed a `repaying` project owned by a freshly registered account (so the owner
// can log in and act on it), with a frozen (all released) investor set and an
// explicit installment schedule.
async function seedRepaying(app: Awaited<ReturnType<typeof buildTestApp>>["app"], db: Db, opts: SeedOpts = {}) {
  const investorAmounts = opts.investorAmounts ?? [500000, 300000, 200000];
  const installmentSpecs = opts.installments ?? [{ seq: 1, amountMinor: 100000 }, { seq: 2, amountMinor: 100000 }];
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
      status: (opts.projectStatus ?? "repaying") as typeof projects.$inferInsert.status,
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

  const installments: (typeof repaymentInstallments.$inferSelect)[] = [];
  for (const spec of installmentSpecs) {
    const [ins] = await db
      .insert(repaymentInstallments)
      .values({ projectId: p!.id, seq: spec.seq, amountMinor: spec.amountMinor, paidMinor: spec.paidMinor ?? 0, dueAt: new Date(), status: spec.status ?? "due" })
      .returning();
    installments.push(ins!);
  }

  return { pid: p!.id, ownerId: owner!.id, ownerCookie, investors, installments };
}

// A provider that declines every repayment collection, to exercise the 402 path.
class DecliningProvider extends MockPaymentProvider {
  override async initiateRepayment(_p: RepaymentRequest): Promise<RepaymentResult> {
    return { ok: false, ref: "", status: "pending" };
  }
}

async function repay(app: any, pid: string, cookie: string, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `/projects/${pid}/repay`, cookies: { [COOKIE]: cookie }, payload: body });
}

describe("POST /projects/:id/repay", () => {
  it("applies a partial payment: paid_minor advances, portion distributed, settled", async () => {
    const { app, db } = await buildTestApp();
    const { pid, ownerCookie, investors, installments } = await seedRepaying(app, db, {
      installments: [{ seq: 1, amountMinor: 100000 }],
    });

    const r = await repay(app, pid, ownerCookie, { amountMinor: 40000 });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.paymentId).toBeTruthy();
    expect(body.amountMinor).toBe(40000);
    expect(body.status).toBe("settled");
    expect(body.appliedMinor).toBe(40000);
    expect(body.projectStatus).toBe("repaying");

    const [ins] = await db.select().from(repaymentInstallments).where(eq(repaymentInstallments.id, installments[0]!.id));
    expect(ins!.paidMinor).toBe(40000);
    expect(ins!.status).toBe("due");

    let sum = 0;
    for (const inv of investors) {
      const entries = await db.select().from(walletEntries).where(eq(walletEntries.walletId, inv.walletId));
      expect(entries).toHaveLength(1);
      sum += entries[0]!.amountMinor;
    }
    expect(sum).toBe(40000);
  });

  it("cascades an advance payment over 2.5 installments (Sigma application == payment)", async () => {
    const { app, db } = await buildTestApp();
    const { pid, ownerCookie, installments } = await seedRepaying(app, db, {
      installments: [
        { seq: 1, amountMinor: 100000 },
        { seq: 2, amountMinor: 100000 },
        { seq: 3, amountMinor: 100000 },
      ],
    });

    const r = await repay(app, pid, ownerCookie, { amountMinor: 250000 });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.status).toBe("settled");
    expect(body.appliedMinor).toBe(250000);

    const rows = await db.select().from(repaymentInstallments).where(eq(repaymentInstallments.projectId, pid));
    const bySeq = Object.fromEntries(rows.map((x) => [x.seq, x]));
    expect(bySeq[1]!.status).toBe("paid");
    expect(bySeq[2]!.status).toBe("paid");
    expect(bySeq[3]!.status).toBe("due");
    expect(bySeq[3]!.paidMinor).toBe(50000);

    const apps = await db.select().from(repaymentApplications).where(eq(repaymentApplications.paymentId, body.paymentId));
    expect(apps.reduce((s, a) => s + a.amountMinor, 0)).toBe(250000);
    expect(installments).toHaveLength(3);
  });

  it("pays off the whole schedule and closes the project", async () => {
    const { app, db } = await buildTestApp();
    const { pid, ownerCookie } = await seedRepaying(app, db, {
      installments: [{ seq: 1, amountMinor: 100000 }, { seq: 2, amountMinor: 100000 }],
    });

    const r = await repay(app, pid, ownerCookie, { amountMinor: 200000 });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.status).toBe("settled");
    expect(body.appliedMinor).toBe(200000);
    expect(body.projectStatus).toBe("closed");
  });

  it("rejects an over-remaining amount with 409 exceeds_remaining + remainingMinor", async () => {
    const { app, db } = await buildTestApp();
    const { pid, ownerCookie } = await seedRepaying(app, db, {
      installments: [{ seq: 1, amountMinor: 100000 }, { seq: 2, amountMinor: 100000 }],
    });

    const r = await repay(app, pid, ownerCookie, { amountMinor: 250000 });
    expect(r.statusCode).toBe(409);
    const body = r.json();
    expect(body.error.code).toBe("exceeds_remaining");
    expect(body.error.details.remainingMinor).toBe(200000);

    // Nothing was created.
    const pays = await db.select().from(repaymentPayments).where(eq(repaymentPayments.projectId, pid));
    expect(pays).toHaveLength(0);
  });

  it("caps to remaining with confirmCapToRemaining and pays off", async () => {
    const { app, db } = await buildTestApp();
    const { pid, ownerCookie } = await seedRepaying(app, db, {
      installments: [{ seq: 1, amountMinor: 100000 }, { seq: 2, amountMinor: 100000 }],
    });

    const r = await repay(app, pid, ownerCookie, { amountMinor: 999999, confirmCapToRemaining: true });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.amountMinor).toBe(200000); // capped to remaining
    expect(body.status).toBe("settled");
    expect(body.appliedMinor).toBe(200000);
    expect(body.projectStatus).toBe("closed");
  });

  it("returns 402 repayment_failed and creates no payment row when the provider declines", async () => {
    const { app, db } = await buildTestApp({ payments: new DecliningProvider() });
    const { pid, ownerCookie, investors, installments } = await seedRepaying(app, db, {
      installments: [{ seq: 1, amountMinor: 100000 }],
    });

    const r = await repay(app, pid, ownerCookie, { amountMinor: 50000 });
    expect(r.statusCode).toBe(402);
    expect(r.json().error.code).toBe("payment_failed");

    // No payment row, nothing applied, nothing distributed.
    const pays = await db.select().from(repaymentPayments).where(eq(repaymentPayments.projectId, pid));
    expect(pays).toHaveLength(0);
    const [ins] = await db.select().from(repaymentInstallments).where(eq(repaymentInstallments.id, installments[0]!.id));
    expect(ins!.paidMinor).toBe(0);
    for (const inv of investors) {
      const entries = await db.select().from(walletEntries).where(eq(walletEntries.walletId, inv.walletId));
      expect(entries).toHaveLength(0);
    }
  });

  it("pending mode returns status pending and applies nothing", async () => {
    const pending = new MockPaymentProvider();
    pending.repaymentMode = "pending";
    const { app, db } = await buildTestApp({ payments: pending });
    const { pid, ownerCookie, investors, installments } = await seedRepaying(app, db, {
      installments: [{ seq: 1, amountMinor: 100000 }],
    });

    const r = await repay(app, pid, ownerCookie, { amountMinor: 40000 });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.status).toBe("pending");
    expect(body.appliedMinor).toBe(0);
    expect(body.projectStatus).toBe("repaying");

    // A pending payment carries a ref but applies nothing until the webhook settles.
    const [pay] = await db.select().from(repaymentPayments).where(eq(repaymentPayments.id, body.paymentId));
    expect(pay!.status).toBe("pending");
    expect(pay!.ref).not.toBeNull();
    const [ins] = await db.select().from(repaymentInstallments).where(eq(repaymentInstallments.id, installments[0]!.id));
    expect(ins!.paidMinor).toBe(0);
    expect(ins!.status).toBe("due");
    for (const inv of investors) {
      const entries = await db.select().from(walletEntries).where(eq(walletEntries.walletId, inv.walletId));
      expect(entries).toHaveLength(0);
    }
  });

  it("rejects a second /repay while a payment is pending (one pending payment per project)", async () => {
    const pending = new MockPaymentProvider();
    pending.repaymentMode = "pending";
    const { app, db } = await buildTestApp({ payments: pending });
    const { pid, ownerCookie } = await seedRepaying(app, db, {
      installments: [{ seq: 1, amountMinor: 100000 }],
    });

    const r1 = await repay(app, pid, ownerCookie, { amountMinor: 40000 });
    expect(r1.statusCode).toBe(201);
    expect(r1.json().status).toBe("pending");

    const r2 = await repay(app, pid, ownerCookie, { amountMinor: 40000 });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error.code).toBe("invalid_state");

    // Only the first payment exists.
    const pays = await db.select().from(repaymentPayments).where(eq(repaymentPayments.projectId, pid));
    expect(pays).toHaveLength(1);
  });

  it("rejects a missing/non-integer amount with 400 validation_error", async () => {
    const { app, db } = await buildTestApp();
    const { pid, ownerCookie } = await seedRepaying(app, db);
    const r1 = await repay(app, pid, ownerCookie, {});
    expect(r1.statusCode).toBe(400);
    expect(r1.json().error.code).toBe("validation_error");
    const r2 = await repay(app, pid, ownerCookie, { amountMinor: -5 });
    expect(r2.statusCode).toBe(400);
    const r3 = await repay(app, pid, ownerCookie, { amountMinor: 1.5 });
    expect(r3.statusCode).toBe(400);
  });

  it("rejects a non-owner with 403", async () => {
    const { app, db } = await buildTestApp();
    const { pid } = await seedRepaying(app, db);
    const otherCookie = await loginAs(app, "intruder@a.co");
    const r = await repay(app, pid, otherCookie, { amountMinor: 40000 });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("forbidden");
  });

  it("rejects a non-repaying project with 409", async () => {
    const { app, db } = await buildTestApp();
    const { pid, ownerCookie } = await seedRepaying(app, db, { projectStatus: "collecting" });
    const r = await repay(app, pid, ownerCookie, { amountMinor: 40000 });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("invalid_state");
  });

  it("rejects when there is nothing left to pay with 409 (all paid)", async () => {
    const { app, db } = await buildTestApp();
    const { pid, ownerCookie } = await seedRepaying(app, db, {
      installments: [{ seq: 1, amountMinor: 100000, paidMinor: 100000, status: "paid" }],
    });
    const r = await repay(app, pid, ownerCookie, { amountMinor: 40000 });
    expect(r.statusCode).toBe(409);
    // remaining is 0; a positive amount without confirm exceeds it -> exceeds_remaining.
    const body = r.json();
    expect(body.error.code).toBe("exceeds_remaining");
    expect(body.error.details.remainingMinor).toBe(0);
  });

  it("caps-to-zero on a fully paid project yields 409 invalid_state", async () => {
    const { app, db } = await buildTestApp();
    const { pid, ownerCookie } = await seedRepaying(app, db, {
      installments: [{ seq: 1, amountMinor: 100000, paidMinor: 100000, status: "paid" }],
    });
    const r = await repay(app, pid, ownerCookie, { amountMinor: 40000, confirmCapToRemaining: true });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("invalid_state");
  });

  it("returns 404 for a non-UUID project id", async () => {
    const { app } = await buildTestApp();
    const cookie = await loginAs(app, "someone@a.co");
    const r = await repay(app, "not-a-uuid", cookie, { amountMinor: 40000 });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("not_found");
  });
});
