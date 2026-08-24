import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "./helpers/db";
import {
  accounts,
  projects,
  investments,
  wallets,
  walletEntries,
  repaymentInstallments,
  repaymentDistributions,
} from "../src/db/schema";
import { settleRepayment, failRepaymentSettlement, repayKey } from "../src/modules/repayment/service";

interface SeedOpts {
  investorAmounts?: number[];
  installmentAmounts?: number[];
}

// Seed a `repaying` project with a frozen (all released) investor set and one or
// more `pending` installments, all via direct inserts (mirrors repayment-start +
// escrow-settle seeding). Each investor gets a wallet so distribution can credit.
async function seedRepaying(db: any, opts: SeedOpts = {}) {
  const investorAmounts = opts.investorAmounts ?? [500000, 300000, 200000];
  const installmentAmounts = opts.installmentAmounts ?? [193333];
  const raised = investorAmounts.reduce((s, a) => s + a, 0);

  const [owner] = await db
    .insert(accounts)
    .values({ email: "o@a.co", passwordHash: "x", firstName: "O", lastName: "A", country: "Togo", roles: ["porteur"] })
    .returning();
  await db.insert(wallets).values({ accountId: owner.id });
  const [p] = await db
    .insert(projects)
    .values({
      ownerAccountId: owner.id,
      category: "commerce",
      title: "P",
      city: "L",
      description: "d",
      targetMinor: raised,
      durationMonths: 6,
      roiPct: "16",
      fundsUsage: "u",
      cautionType: "a",
      status: "repaying",
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
      .values({ projectId: p.id, investorAccountId: acc!.id, amountMinor: investorAmounts[i], source: "payment", paymentRef: `d${i}`, status: "released" })
      .returning();
    investors.push({ accountId: acc!.id, walletId: w.id, invId: inv.id, amount: investorAmounts[i]! });
  }

  const installments: any[] = [];
  for (let s = 0; s < installmentAmounts.length; s += 1) {
    const [ins] = await db
      .insert(repaymentInstallments)
      .values({ projectId: p.id, seq: s + 1, amountMinor: installmentAmounts[s], dueAt: new Date(), status: "pending", repaymentRef: `r${s + 1}` })
      .returning();
    installments.push(ins);
  }

  return { pid: p.id, ownerId: owner.id, investors, installments };
}

describe("settleRepayment", () => {
  it("repayKey builds the deterministic provider idempotency key", () => {
    expect(repayKey("abc")).toBe("repay:abc");
  });

  it("distributes an installment pro-rata (with a remainder) and marks it paid", async () => {
    await withTestDb(async (db) => {
      const { investors, installments } = await seedRepaying(db);
      const installmentId = installments[0].id;

      await settleRepayment(db, { installmentId });

      // A = 193333, R = 1_000_000. floors: 96666 / 57999 / 38666 (sum 193331);
      // fracs 500000 / 900000 / 600000 -> the +1 units go to the 300k and 200k
      // investors (largest fractional remainder). Final 96666 / 58000 / 38667.
      const expected = [96666, 58000, 38667];
      let sum = 0;
      for (let i = 0; i < investors.length; i += 1) {
        const inv = investors[i]!;
        const entries = await db.select().from(walletEntries).where(eq(walletEntries.walletId, inv.walletId));
        expect(entries).toHaveLength(1);
        expect(entries[0]!.type).toBe("repayment");
        expect(entries[0]!.amountMinor).toBe(expected[i]);
        sum += entries[0]!.amountMinor;

        const dists = await db
          .select()
          .from(repaymentDistributions)
          .where(and(eq(repaymentDistributions.installmentId, installmentId), eq(repaymentDistributions.investmentId, inv.invId)));
        expect(dists).toHaveLength(1);
        expect(dists[0]!.amountMinor).toBe(expected[i]);
        // wallet entry references the distribution row it was born from.
        expect(entries[0]!.reference).toBe(dists[0]!.id);
      }
      expect(sum).toBe(193333); // conservation: sum(distributed) == A exactly

      const [ins] = await db.select().from(repaymentInstallments).where(eq(repaymentInstallments.id, installmentId));
      expect(ins!.status).toBe("paid");
      expect(ins!.settledAt).not.toBeNull();
    });
  });

  it("is idempotent: replaying settle credits each investment exactly once", async () => {
    await withTestDb(async (db) => {
      const { investors, installments } = await seedRepaying(db);
      const installmentId = installments[0].id;

      await settleRepayment(db, { installmentId });
      await settleRepayment(db, { installmentId });

      let sum = 0;
      for (const inv of investors) {
        const entries = await db.select().from(walletEntries).where(eq(walletEntries.walletId, inv.walletId));
        expect(entries).toHaveLength(1); // one entry per investment, never doubled
        sum += entries[0]!.amountMinor;
      }
      expect(sum).toBe(193333);
    });
  });

  it("resumes after a partial crash: credits only the missing investors, once", async () => {
    await withTestDb(async (db) => {
      const { investors, installments } = await seedRepaying(db);
      const installmentId = installments[0].id;

      // Simulate a crash mid-loop: investor 0 was already distributed + credited
      // (96666, its floor share), the installment is still `pending`.
      const [dist] = await db
        .insert(repaymentDistributions)
        .values({ installmentId, investmentId: investors[0]!.invId, amountMinor: 96666 })
        .returning();
      await db.insert(walletEntries).values({ walletId: investors[0]!.walletId, type: "repayment", amountMinor: 96666, reference: dist!.id });

      await settleRepayment(db, { installmentId });

      let sum = 0;
      for (const inv of investors) {
        const entries = await db.select().from(walletEntries).where(eq(walletEntries.walletId, inv.walletId));
        expect(entries).toHaveLength(1); // investor 0 not re-credited; 1 and 2 credited once
        sum += entries[0]!.amountMinor;
      }
      expect(sum).toBe(193333);

      const [ins] = await db.select().from(repaymentInstallments).where(eq(repaymentInstallments.id, installmentId));
      expect(ins!.status).toBe("paid");
    });
  });

  it("excludes non-released investments from the pro-rata base (conservation)", async () => {
    await withTestDb(async (db) => {
      const { pid, installments } = await seedRepaying(db);
      // A `failed` deposit row that never advanced raised_minor must NOT dilute the
      // split; including it would make sum(p_i) > R and over-distribute.
      const [acc] = await db
        .insert(accounts)
        .values({ email: "x@a.co", passwordHash: "x", firstName: "X", lastName: "Y", country: "Togo", roles: ["investor"] })
        .returning();
      await db.insert(wallets).values({ accountId: acc!.id });
      await db.insert(investments).values({ projectId: pid, investorAccountId: acc!.id, amountMinor: 400000, source: "payment", paymentRef: "dfail", status: "failed" });

      await settleRepayment(db, { installmentId: installments[0].id });

      const dists = await db.select().from(repaymentDistributions).where(eq(repaymentDistributions.installmentId, installments[0].id));
      const sum = dists.reduce((s: number, d: any) => s + d.amountMinor, 0);
      expect(dists).toHaveLength(3); // only the 3 released investors
      expect(sum).toBe(193333);
    });
  });

  it("closes the project only when the last installment is paid", async () => {
    await withTestDb(async (db) => {
      const { pid, installments } = await seedRepaying(db, { installmentAmounts: [100000, 100000] });

      await settleRepayment(db, { installmentId: installments[0].id });
      const [afterFirst] = await db.select().from(projects).where(eq(projects.id, pid));
      expect(afterFirst!.status).toBe("repaying"); // not yet, one installment still pending

      await settleRepayment(db, { installmentId: installments[1].id });
      const [afterLast] = await db.select().from(projects).where(eq(projects.id, pid));
      expect(afterLast!.status).toBe("closed");
    });
  });

  it("never distributes a `due` installment (money not yet collected)", async () => {
    await withTestDb(async (db) => {
      const { investors, installments } = await seedRepaying(db);
      const installmentId = installments[0].id;
      // Simulate a failed settlement having reset it pending -> due (ref retained),
      // then a stray `settled` callback carrying that ref reaching settleRepayment.
      await db.update(repaymentInstallments).set({ status: "due" }).where(eq(repaymentInstallments.id, installmentId));

      await settleRepayment(db, { installmentId });

      const dists = await db.select().from(repaymentDistributions).where(eq(repaymentDistributions.installmentId, installmentId));
      expect(dists).toHaveLength(0);
      for (const inv of investors) {
        const entries = await db.select().from(walletEntries).where(eq(walletEntries.walletId, inv.walletId));
        expect(entries).toHaveLength(0);
      }
      const [ins] = await db.select().from(repaymentInstallments).where(eq(repaymentInstallments.id, installmentId));
      expect(ins!.status).toBe("due");
    });
  });

  it("failRepaymentSettlement resets pending->due and distributes nothing", async () => {
    await withTestDb(async (db) => {
      const { investors, installments } = await seedRepaying(db);
      const installmentId = installments[0].id;

      await failRepaymentSettlement(db, { installmentId });

      const [ins] = await db.select().from(repaymentInstallments).where(eq(repaymentInstallments.id, installmentId));
      expect(ins!.status).toBe("due");

      const dists = await db.select().from(repaymentDistributions).where(eq(repaymentDistributions.installmentId, installmentId));
      expect(dists).toHaveLength(0);
      for (const inv of investors) {
        const entries = await db.select().from(walletEntries).where(eq(walletEntries.walletId, inv.walletId));
        expect(entries).toHaveLength(0);
      }
    });
  });
});
