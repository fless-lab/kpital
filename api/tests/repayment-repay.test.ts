import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { buildTestApp, loginAs } from "./helpers/app";
import { MockPaymentProvider } from "../src/lib/payments";
import type { PaymentProvider, RepaymentRequest, RepaymentResult } from "../src/lib/payments";
import {
  accounts,
  projects,
  investments,
  wallets,
  walletEntries,
  repaymentInstallments,
  repaymentDistributions,
} from "../src/db/schema";

const COOKIE = "kpital_sess";

type Db = Awaited<ReturnType<typeof buildTestApp>>["db"];

interface SeedOpts {
  investorAmounts?: number[];
  installmentAmounts?: number[];
  installmentStatus?: "due" | "pending" | "paid";
  projectStatus?: string;
  ownerEmail?: string;
}

// Seed a `repaying` project owned by a freshly registered account (so the owner
// can log in and act on it), with a frozen (all released) investor set and one
// or more installments. Mirrors repayment-settle.test.ts seeding, adapted for an
// HTTP owner (the project's ownerAccountId is the logged-in account's id).
async function seedRepaying(app: Awaited<ReturnType<typeof buildTestApp>>["app"], db: Db, opts: SeedOpts = {}) {
  const investorAmounts = opts.investorAmounts ?? [500000, 300000, 200000];
  const installmentAmounts = opts.installmentAmounts ?? [96667, 96666];
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
  for (let s = 0; s < installmentAmounts.length; s += 1) {
    const [ins] = await db
      .insert(repaymentInstallments)
      .values({ projectId: p!.id, seq: s + 1, amountMinor: installmentAmounts[s]!, dueAt: new Date(), status: opts.installmentStatus ?? "due" })
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

describe("POST /projects/:id/repay", () => {
  it("pays the next due installment; settled mock distributes immediately", async () => {
    const { app, db } = await buildTestApp();
    const { pid, ownerCookie, investors, installments } = await seedRepaying(app, db);

    const r = await app.inject({
      method: "POST",
      url: `/projects/${pid}/repay`,
      cookies: { [COOKIE]: ownerCookie },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.installmentId).toBe(installments[0]!.id);
    expect(body.seq).toBe(1);
    expect(body.amountMinor).toBe(96667);
    expect(body.status).toBe("paid");
    // Two installments seeded, so the project is not yet closed.
    expect(body.projectStatus).toBe("repaying");

    // The lowest-seq installment is paid; the second stays due.
    const [ins1] = await db.select().from(repaymentInstallments).where(eq(repaymentInstallments.id, installments[0]!.id));
    expect(ins1!.status).toBe("paid");
    expect(ins1!.repaymentRef).not.toBeNull();
    const [ins2] = await db.select().from(repaymentInstallments).where(eq(repaymentInstallments.id, installments[1]!.id));
    expect(ins2!.status).toBe("due");

    // Investors credited pro-rata: A = 96667, R = 1_000_000.
    let sum = 0;
    for (const inv of investors) {
      const entries = await db.select().from(walletEntries).where(eq(walletEntries.walletId, inv.walletId));
      expect(entries).toHaveLength(1);
      expect(entries[0]!.type).toBe("repayment");
      sum += entries[0]!.amountMinor;
    }
    expect(sum).toBe(96667); // conservation
  });

  it("closes the project when the last installment is paid", async () => {
    const { app, db } = await buildTestApp();
    const { pid, ownerCookie } = await seedRepaying(app, db, { installmentAmounts: [193333] });

    const r = await app.inject({ method: "POST", url: `/projects/${pid}/repay`, cookies: { [COOKIE]: ownerCookie } });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.status).toBe("paid");
    expect(body.projectStatus).toBe("closed");
  });

  it("returns 402 repayment_failed and leaves the installment due when the provider declines", async () => {
    const { app, db } = await buildTestApp({ payments: new DecliningProvider() });
    const { pid, ownerCookie, investors, installments } = await seedRepaying(app, db);

    const r = await app.inject({ method: "POST", url: `/projects/${pid}/repay`, cookies: { [COOKIE]: ownerCookie } });
    expect(r.statusCode).toBe(402);
    expect(r.json().error.code).toBe("repayment_failed");

    // The failed collection rolled back: installment returns to `due`, ref still null.
    const [ins] = await db.select().from(repaymentInstallments).where(eq(repaymentInstallments.id, installments[0]!.id));
    expect(ins!.status).toBe("due");
    expect(ins!.repaymentRef).toBeNull();

    // Nothing distributed.
    const dists = await db.select().from(repaymentDistributions).where(eq(repaymentDistributions.installmentId, installments[0]!.id));
    expect(dists).toHaveLength(0);
    for (const inv of investors) {
      const entries = await db.select().from(walletEntries).where(eq(walletEntries.walletId, inv.walletId));
      expect(entries).toHaveLength(0);
    }
  });

  it("pending mode returns status pending and distributes nothing", async () => {
    const pending = new MockPaymentProvider();
    pending.repaymentMode = "pending";
    const { app, db } = await buildTestApp({ payments: pending });
    const { pid, ownerCookie, investors, installments } = await seedRepaying(app, db);

    const r = await app.inject({ method: "POST", url: `/projects/${pid}/repay`, cookies: { [COOKIE]: ownerCookie } });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.status).toBe("pending");
    expect(body.projectStatus).toBe("repaying");

    // A pending collection sets the ref but distributes nothing.
    const [ins] = await db.select().from(repaymentInstallments).where(eq(repaymentInstallments.id, installments[0]!.id));
    expect(ins!.status).toBe("pending");
    expect(ins!.repaymentRef).not.toBeNull();
    const dists = await db.select().from(repaymentDistributions).where(eq(repaymentDistributions.installmentId, installments[0]!.id));
    expect(dists).toHaveLength(0);
    for (const inv of investors) {
      const entries = await db.select().from(walletEntries).where(eq(walletEntries.walletId, inv.walletId));
      expect(entries).toHaveLength(0);
    }
  });

  it("rejects a non-owner with 403", async () => {
    const { app, db } = await buildTestApp();
    const { pid } = await seedRepaying(app, db);
    const otherCookie = await loginAs(app, "intruder@a.co");

    const r = await app.inject({ method: "POST", url: `/projects/${pid}/repay`, cookies: { [COOKIE]: otherCookie } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("forbidden");
  });

  it("rejects a non-repaying project with 409", async () => {
    const { app, db } = await buildTestApp();
    const { pid, ownerCookie } = await seedRepaying(app, db, { projectStatus: "collecting" });

    const r = await app.inject({ method: "POST", url: `/projects/${pid}/repay`, cookies: { [COOKIE]: ownerCookie } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("invalid_state");
  });

  it("rejects when there is nothing left to pay with 409", async () => {
    const { app, db } = await buildTestApp();
    const { pid, ownerCookie } = await seedRepaying(app, db, { installmentStatus: "paid" });

    const r = await app.inject({ method: "POST", url: `/projects/${pid}/repay`, cookies: { [COOKIE]: ownerCookie } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("invalid_state");
  });

  it("rejects a second concurrent repay while a settlement is in flight (strict sequential)", async () => {
    // An installment already `pending` (a settlement in flight) blocks a new /repay
    // on the same project: only one collection may be in flight at a time.
    const { app, db } = await buildTestApp();
    const { pid, ownerCookie } = await seedRepaying(app, db, { installmentStatus: "pending" });

    const r = await app.inject({ method: "POST", url: `/projects/${pid}/repay`, cookies: { [COOKIE]: ownerCookie } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("invalid_state");
  });

  it("returns 404 for a non-UUID project id", async () => {
    const { app } = await buildTestApp();
    const cookie = await loginAs(app, "someone@a.co");
    const r = await app.inject({ method: "POST", url: `/projects/not-a-uuid/repay`, cookies: { [COOKIE]: cookie } });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("not_found");
  });
});
