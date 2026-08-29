import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "../src/db/client";
import { withTestDb } from "./helpers/db";
import {
  accounts,
  projects,
  investments,
  wallets,
  walletEntries,
  repaymentInstallments,
  repaymentPayments,
  repaymentApplications,
  repaymentDistributions,
} from "../src/db/schema";
import { settlePayment, failPayment, repayKey } from "../src/modules/repayment/service";

const DAY = 24 * 60 * 60 * 1000;
// A grace cutoff far in the past: no installment is ever "grace-exceeded", so the
// auto-lift branch is inert for the repaying-project cases below.
const NO_LIFT = Date.now() - 3650 * DAY;

interface InstallmentSpec {
  seq: number;
  amountMinor: number;
  paidMinor?: number;
  status?: "due" | "pending" | "paid";
  dueAt?: Date;
}

interface SeedOpts {
  investorAmounts?: number[];
  installments?: InstallmentSpec[];
  projectStatus?: "repaying" | "defaulted";
  adminDefaulted?: boolean;
  defaultedAt?: Date | null;
  paymentAmount: number;
  paymentRef?: string | null;
  paymentStatus?: "pending" | "settled" | "failed";
}

// Seed a repaying/defaulted project with a frozen (all released) investor set,
// an explicit installment schedule (with optional paid_minor), and one
// repayment_payment (pending by default). Returns the ids the tests assert on.
async function seed(db: Db, opts: SeedOpts) {
  const investorAmounts = opts.investorAmounts ?? [500000, 300000, 200000];
  const installmentSpecs = opts.installments ?? [{ seq: 1, amountMinor: 193333 }];
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
      status: opts.projectStatus ?? "repaying",
      adminDefaulted: opts.adminDefaulted ?? false,
      defaultedAt: opts.defaultedAt ?? null,
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
      .values({
        projectId: p!.id,
        seq: spec.seq,
        amountMinor: spec.amountMinor,
        paidMinor: spec.paidMinor ?? 0,
        dueAt: spec.dueAt ?? new Date(),
        status: spec.status ?? "due",
      })
      .returning();
    installments.push(ins!);
  }

  const [pay] = await db
    .insert(repaymentPayments)
    .values({
      projectId: p!.id,
      amountMinor: opts.paymentAmount,
      ref: opts.paymentRef === undefined ? "mp-1" : opts.paymentRef,
      status: opts.paymentStatus ?? "pending",
    })
    .returning();

  return { pid: p!.id, ownerId: owner!.id, investors, installments, paymentId: pay!.id };
}

async function sumApplications(db: Db, paymentId: string): Promise<number> {
  const rows = await db.select().from(repaymentApplications).where(eq(repaymentApplications.paymentId, paymentId));
  return rows.reduce((s, r) => s + r.amountMinor, 0);
}
async function distSum(db: Db, installmentId: string): Promise<number> {
  const rows = await db.select().from(repaymentDistributions).where(eq(repaymentDistributions.installmentId, installmentId));
  return rows.reduce((s, r) => s + r.amountMinor, 0);
}

describe("settlePayment (atomic cascade)", () => {
  it("repayKey builds the deterministic payment-scoped provider idempotency key", () => {
    expect(repayKey("abc")).toBe("repay:abc");
  });

  it("applies a partial payment: paid_minor advances, installment stays not paid, portion distributed", async () => {
    await withTestDb(async (db) => {
      const { investors, installments, paymentId } = await seed(db, {
        installments: [{ seq: 1, amountMinor: 100000 }],
        paymentAmount: 40000,
      });

      await settlePayment(db, { paymentId, graceCutoffMs: NO_LIFT });

      const [ins] = await db.select().from(repaymentInstallments).where(eq(repaymentInstallments.id, installments[0]!.id));
      expect(ins!.paidMinor).toBe(40000);
      expect(ins!.status).toBe("due"); // not fully paid

      // Payment settled, conservation (a): Sigma application == payment amount.
      const [pay] = await db.select().from(repaymentPayments).where(eq(repaymentPayments.id, paymentId));
      expect(pay!.status).toBe("settled");
      expect(pay!.settledAt).not.toBeNull();
      expect(await sumApplications(db, paymentId)).toBe(40000);

      // Portion distributed (c): Sigma distribution == portion; each investor credited once.
      expect(await distSum(db, installments[0]!.id)).toBe(40000);
      let sum = 0;
      for (const inv of investors) {
        const entries = await db.select().from(walletEntries).where(eq(walletEntries.walletId, inv.walletId));
        expect(entries).toHaveLength(1);
        expect(entries[0]!.type).toBe("repayment");
        sum += entries[0]!.amountMinor;
      }
      expect(sum).toBe(40000);
    });
  });

  it("two sequential payments settle one installment (allocation reads paid_minor at settle time)", async () => {
    await withTestDb(async (db) => {
      // Payment 1: 40000 of a 100000 installment -> paid_minor 40000, not paid.
      const first = await seed(db, {
        installments: [{ seq: 1, amountMinor: 100000 }],
        paymentAmount: 40000,
        paymentRef: "mp-a",
      });
      await settlePayment(db, { paymentId: first.paymentId, graceCutoffMs: NO_LIFT });

      // Payment 2: 60000 -> portion = 100000 - 40000 = 60000 -> paid.
      const [pay2] = await db
        .insert(repaymentPayments)
        .values({ projectId: first.pid, amountMinor: 60000, ref: "mp-b", status: "pending" })
        .returning();
      await settlePayment(db, { paymentId: pay2!.id, graceCutoffMs: NO_LIFT });

      const [ins] = await db.select().from(repaymentInstallments).where(eq(repaymentInstallments.id, first.installments[0]!.id));
      expect(ins!.paidMinor).toBe(100000);
      expect(ins!.status).toBe("paid");

      // Invariant (b): installment.paid_minor == Sigma application for that installment.
      const apps = await db.select().from(repaymentApplications).where(eq(repaymentApplications.installmentId, first.installments[0]!.id));
      expect(apps.reduce((s, a) => s + a.amountMinor, 0)).toBe(100000);
      // Each payment fully applied (a).
      expect(await sumApplications(db, first.paymentId)).toBe(40000);
      expect(await sumApplications(db, pay2!.id)).toBe(60000);
      // Two distinct distribution sets sum to 100000.
      expect(await distSum(db, first.installments[0]!.id)).toBe(100000);
    });
  });

  it("cascades over 2.5 installments: Sigma application == payment, each portion distributed", async () => {
    await withTestDb(async (db) => {
      // Three installments of 100000; a payment of 250000 pays 1 and 2 fully and
      // half of 3.
      const { installments, paymentId } = await seed(db, {
        installments: [
          { seq: 1, amountMinor: 100000 },
          { seq: 2, amountMinor: 100000 },
          { seq: 3, amountMinor: 100000 },
        ],
        paymentAmount: 250000,
      });

      await settlePayment(db, { paymentId, graceCutoffMs: NO_LIFT });

      const rows = await db.select().from(repaymentInstallments).where(eq(repaymentInstallments.projectId, installments[0]!.projectId));
      const bySeq = Object.fromEntries(rows.map((r) => [r.seq, r]));
      expect(bySeq[1]!.status).toBe("paid");
      expect(bySeq[1]!.paidMinor).toBe(100000);
      expect(bySeq[2]!.status).toBe("paid");
      expect(bySeq[2]!.paidMinor).toBe(100000);
      expect(bySeq[3]!.status).toBe("due");
      expect(bySeq[3]!.paidMinor).toBe(50000);

      // Conservation (a): the whole payment is applied.
      expect(await sumApplications(db, paymentId)).toBe(250000);
      // Each portion distributed exactly (c).
      expect(await distSum(db, installments[0]!.id)).toBe(100000);
      expect(await distSum(db, installments[1]!.id)).toBe(100000);
      expect(await distSum(db, installments[2]!.id)).toBe(50000);
    });
  });

  it("payoff closes the project (from repaying)", async () => {
    await withTestDb(async (db) => {
      const { pid, paymentId } = await seed(db, {
        installments: [
          { seq: 1, amountMinor: 100000 },
          { seq: 2, amountMinor: 100000 },
        ],
        paymentAmount: 200000,
      });
      await settlePayment(db, { paymentId, graceCutoffMs: NO_LIFT });
      const [p] = await db.select().from(projects).where(eq(projects.id, pid));
      expect(p!.status).toBe("closed");
    });
  });

  it("closes a defaulted project when fully repaid (terminal close from defaulted)", async () => {
    await withTestDb(async (db) => {
      const { pid, paymentId } = await seed(db, {
        projectStatus: "defaulted",
        defaultedAt: new Date(Date.now() - 3 * DAY),
        installments: [{ seq: 1, amountMinor: 100000, dueAt: new Date(Date.now() - 40 * DAY) }],
        paymentAmount: 100000,
      });
      await settlePayment(db, { paymentId, graceCutoffMs: Date.now() - 30 * DAY });
      const [p] = await db.select().from(projects).where(eq(projects.id, pid));
      expect(p!.status).toBe("closed");
    });
  });

  it("auto-lifts a defaulted project when no grace-exceeded unpaid installment remains", async () => {
    await withTestDb(async (db) => {
      const { pid, paymentId } = await seed(db, {
        projectStatus: "defaulted",
        defaultedAt: new Date(Date.now() - 3 * DAY),
        installments: [
          { seq: 1, amountMinor: 100000, dueAt: new Date(Date.now() - 40 * DAY) }, // grace-exceeded, paid this call
          { seq: 2, amountMinor: 100000, dueAt: new Date(Date.now() + 30 * DAY) }, // future, not grace-exceeded
        ],
        paymentAmount: 100000,
      });
      await settlePayment(db, { paymentId, graceCutoffMs: Date.now() - 30 * DAY });
      const [p] = await db.select({ status: projects.status, defaultedAt: projects.defaultedAt }).from(projects).where(eq(projects.id, pid));
      expect(p!.status).toBe("repaying");
      expect(p!.defaultedAt).toBeNull();
    });
  });

  it("does NOT auto-lift when another grace-exceeded unpaid installment remains", async () => {
    await withTestDb(async (db) => {
      const { pid, paymentId } = await seed(db, {
        projectStatus: "defaulted",
        defaultedAt: new Date(Date.now() - 3 * DAY),
        installments: [
          { seq: 1, amountMinor: 100000, dueAt: new Date(Date.now() - 40 * DAY) }, // paid this call
          { seq: 2, amountMinor: 100000, dueAt: new Date(Date.now() - 40 * DAY) }, // still grace-exceeded
        ],
        paymentAmount: 100000,
      });
      await settlePayment(db, { paymentId, graceCutoffMs: Date.now() - 30 * DAY });
      const [p] = await db.select().from(projects).where(eq(projects.id, pid));
      expect(p!.status).toBe("defaulted");
    });
  });

  it("does NOT auto-lift a sticky admin-defaulted project", async () => {
    await withTestDb(async (db) => {
      const { pid, paymentId } = await seed(db, {
        projectStatus: "defaulted",
        adminDefaulted: true,
        defaultedAt: new Date(Date.now() - 3 * DAY),
        installments: [
          { seq: 1, amountMinor: 100000, dueAt: new Date(Date.now() - 40 * DAY) },
          { seq: 2, amountMinor: 100000, dueAt: new Date(Date.now() + 30 * DAY) },
        ],
        paymentAmount: 100000,
      });
      await settlePayment(db, { paymentId, graceCutoffMs: Date.now() - 30 * DAY });
      const [p] = await db.select().from(projects).where(eq(projects.id, pid));
      expect(p!.status).toBe("defaulted");
    });
  });

  it("is idempotent: re-settling a settled payment adds no application, distribution, or credit", async () => {
    await withTestDb(async (db) => {
      const { investors, installments, paymentId } = await seed(db, {
        installments: [{ seq: 1, amountMinor: 193333 }],
        paymentAmount: 193333,
      });

      await settlePayment(db, { paymentId, graceCutoffMs: NO_LIFT });
      await settlePayment(db, { paymentId, graceCutoffMs: NO_LIFT });

      // Conservation (a) still holds; nothing doubled.
      expect(await sumApplications(db, paymentId)).toBe(193333);
      const apps = await db.select().from(repaymentApplications).where(eq(repaymentApplications.paymentId, paymentId));
      expect(apps).toHaveLength(1);
      expect(await distSum(db, installments[0]!.id)).toBe(193333);
      let sum = 0;
      for (const inv of investors) {
        const entries = await db.select().from(walletEntries).where(eq(walletEntries.walletId, inv.walletId));
        expect(entries).toHaveLength(1); // credited exactly once, never doubled on replay
        sum += entries[0]!.amountMinor;
      }
      expect(sum).toBe(193333);
    });
  });

  it("no-ops on a failed payment (never applies)", async () => {
    await withTestDb(async (db) => {
      const { installments, paymentId } = await seed(db, {
        installments: [{ seq: 1, amountMinor: 100000 }],
        paymentAmount: 40000,
        paymentStatus: "failed",
      });
      await settlePayment(db, { paymentId, graceCutoffMs: NO_LIFT });
      const [ins] = await db.select().from(repaymentInstallments).where(eq(repaymentInstallments.id, installments[0]!.id));
      expect(ins!.paidMinor).toBe(0);
      expect(await sumApplications(db, paymentId)).toBe(0);
    });
  });

  it("failPayment marks a pending payment failed and applies nothing", async () => {
    await withTestDb(async (db) => {
      const { installments, paymentId } = await seed(db, {
        installments: [{ seq: 1, amountMinor: 100000 }],
        paymentAmount: 40000,
      });
      await failPayment(db, { paymentId });
      const [pay] = await db.select().from(repaymentPayments).where(eq(repaymentPayments.id, paymentId));
      expect(pay!.status).toBe("failed");
      const [ins] = await db.select().from(repaymentInstallments).where(eq(repaymentInstallments.id, installments[0]!.id));
      expect(ins!.paidMinor).toBe(0);
      expect(await distSum(db, installments[0]!.id)).toBe(0);
    });
  });

  it("failPayment does not un-settle an already settled payment (guarded)", async () => {
    await withTestDb(async (db) => {
      const { paymentId } = await seed(db, {
        installments: [{ seq: 1, amountMinor: 100000 }],
        paymentAmount: 40000,
      });
      await settlePayment(db, { paymentId, graceCutoffMs: NO_LIFT });
      await failPayment(db, { paymentId });
      const [pay] = await db.select().from(repaymentPayments).where(eq(repaymentPayments.id, paymentId));
      expect(pay!.status).toBe("settled");
    });
  });

  it("distributes with a remainder (floor + largest-remainder), conservation exact", async () => {
    await withTestDb(async (db) => {
      const { investors, installments, paymentId } = await seed(db, {
        installments: [{ seq: 1, amountMinor: 193333 }],
        paymentAmount: 193333,
      });
      await settlePayment(db, { paymentId, graceCutoffMs: NO_LIFT });
      // A = 193333, R = 1_000_000. floors 96666 / 57999 / 38666; the +1 units go to
      // the 300k and 200k investors -> 96666 / 58000 / 38667.
      const expected = [96666, 58000, 38667];
      let sum = 0;
      for (let i = 0; i < investors.length; i += 1) {
        const dists = await db
          .select()
          .from(repaymentDistributions)
          .where(and(eq(repaymentDistributions.installmentId, installments[0]!.id), eq(repaymentDistributions.investmentId, investors[i]!.invId)));
        expect(dists).toHaveLength(1);
        expect(dists[0]!.amountMinor).toBe(expected[i]);
        expect(dists[0]!.applicationId).not.toBeNull();
        sum += dists[0]!.amountMinor;
      }
      expect(sum).toBe(193333);
    });
  });
});
