import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "./helpers/db";
import {
  accounts,
  projects,
  repaymentInstallments,
  investments,
  notificationPrefs,
  wallets,
  walletEntries,
  repaymentDistributions,
} from "../src/db/schema";
import type { Db } from "../src/db/client";
import type { Notifier, Recipient, NotificationMessage, Channel } from "../src/lib/notifier";
import { NoPenaltyPolicy } from "../src/lib/penalty";
import { runRepaymentSweep } from "../src/modules/collections/service";

const DAY = 24 * 60 * 60 * 1000;

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY);
}

function capturingNotifier(): { notifier: Notifier; sent: { to: Recipient; m: NotificationMessage }[] } {
  const sent: { to: Recipient; m: NotificationMessage }[] = [];
  const notifier: Notifier = {
    async send(to, m) {
      sent.push({ to, m });
    },
  };
  return { notifier, sent };
}

let seq = 0;

type Acct = { id: string; email: string };

async function seedAccount(
  db: Db,
  opts: { phone?: string; channels?: string[] | null; roles?: string[] } = {},
): Promise<Acct> {
  seq += 1;
  const email = `acct${seq}@sweep.co`;
  const [acc] = await db
    .insert(accounts)
    .values({
      email,
      phone: opts.phone ?? null,
      passwordHash: "x",
      firstName: "F",
      lastName: "L",
      country: "Togo",
      roles: opts.roles ?? ["porteur"],
    })
    .returning({ id: accounts.id });
  if (opts.channels !== undefined && opts.channels !== null) {
    await db.insert(notificationPrefs).values({ accountId: acc!.id, channels: opts.channels });
  }
  return { id: acc!.id, email };
}

async function seedProject(
  db: Db,
  ownerAccountId: string,
  status: "repaying" | "defaulted",
  defaultedAt: Date | null = null,
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
      defaultedAt,
      raisedMinor: 1_000_000,
    })
    .returning({ id: projects.id });
  return p!.id;
}

async function seedInstallment(
  db: Db,
  projectId: string,
  opts: { dueAt: Date; status?: "due" | "pending" | "paid"; remindedAt?: Date | null; s?: number },
): Promise<string> {
  const [ins] = await db
    .insert(repaymentInstallments)
    .values({
      projectId,
      seq: opts.s ?? 1,
      amountMinor: 100_000,
      dueAt: opts.dueAt,
      status: opts.status ?? "due",
      remindedAt: opts.remindedAt ?? null,
    })
    .returning({ id: repaymentInstallments.id });
  return ins!.id;
}

async function seedInvestment(db: Db, projectId: string, investorAccountId: string): Promise<void> {
  await db.insert(investments).values({
    projectId,
    investorAccountId,
    amountMinor: 500_000,
    source: "payment",
    status: "released",
  });
}

const opts30: { graceDays: number; notifyChannels: Channel[] } = { graceDays: 30, notifyChannels: ["email"] };

describe("runRepaymentSweep", () => {
  it("reminds the porteur once for an overdue installment (anti-spam)", async () => {
    await withTestDb(async (db) => {
      const { notifier, sent } = capturingNotifier();
      const owner = await seedAccount(db, { channels: ["email"] });
      const project = await seedProject(db, owner.id, "repaying");
      await seedInstallment(db, project, { dueAt: daysAgo(5) });

      const r1 = await runRepaymentSweep(db, notifier, new NoPenaltyPolicy(), { ...opts30 });
      expect(r1.remindersSent).toBe(1);
      expect(r1.defaulted).toBe(0);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to.email).toBe(owner.email);

      const [ins] = await db
        .select({ remindedAt: repaymentInstallments.remindedAt })
        .from(repaymentInstallments)
        .where(eq(repaymentInstallments.projectId, project));
      expect(ins!.remindedAt).not.toBeNull();

      // Re-sweep: reminded_at guard means no new reminder, no new send.
      const r2 = await runRepaymentSweep(db, notifier, new NoPenaltyPolicy(), { ...opts30 });
      expect(r2.remindersSent).toBe(0);
      expect(sent).toHaveLength(1);
    });
  });

  it("reminds even a defaulted project's newly-overdue installments", async () => {
    await withTestDb(async (db) => {
      const { notifier, sent } = capturingNotifier();
      const owner = await seedAccount(db, { channels: ["email"] });
      const project = await seedProject(db, owner.id, "defaulted", daysAgo(1));
      // Overdue but within grace -> reminds, does not affect status.
      await seedInstallment(db, project, { dueAt: daysAgo(5) });

      const r = await runRepaymentSweep(db, notifier, new NoPenaltyPolicy(), { ...opts30 });
      expect(r.remindersSent).toBe(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to.email).toBe(owner.email);
    });
  });

  it("defaults a project when an installment is overdue past the grace period", async () => {
    await withTestDb(async (db) => {
      const { notifier, sent } = capturingNotifier();
      const owner = await seedAccount(db, { channels: [] }); // silence porteur reminder
      const investor = await seedAccount(db, { channels: ["email"], roles: ["investisseur"] });
      const project = await seedProject(db, owner.id, "repaying");
      await seedInstallment(db, project, { dueAt: daysAgo(40) });
      await seedInvestment(db, project, investor.id);

      const r1 = await runRepaymentSweep(db, notifier, new NoPenaltyPolicy(), { ...opts30 });
      // Single sweep defaults but does NOT immediately recover (phase ordering).
      expect(r1.defaulted).toBe(1);
      expect(r1.recovered).toBe(0);

      const [p] = await db
        .select({ status: projects.status, defaultedAt: projects.defaultedAt })
        .from(projects)
        .where(eq(projects.id, project));
      expect(p!.status).toBe("defaulted");
      expect(p!.defaultedAt).not.toBeNull();

      // Only the investor is notified (porteur opted out).
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to.email).toBe(investor.email);

      // Re-sweep: guard prevents re-transition and re-notify.
      const r2 = await runRepaymentSweep(db, notifier, new NoPenaltyPolicy(), { ...opts30 });
      expect(r2.defaulted).toBe(0);
      expect(sent).toHaveLength(1);
    });
  });

  it("does NOT default when overdue but within grace", async () => {
    await withTestDb(async (db) => {
      const { notifier } = capturingNotifier();
      const owner = await seedAccount(db, { channels: ["email"] });
      const project = await seedProject(db, owner.id, "repaying");
      await seedInstallment(db, project, { dueAt: daysAgo(5) });

      const r = await runRepaymentSweep(db, notifier, new NoPenaltyPolicy(), { ...opts30 });
      expect(r.defaulted).toBe(0);
      expect(r.remindersSent).toBe(1);
      const [p] = await db
        .select({ status: projects.status })
        .from(projects)
        .where(eq(projects.id, project));
      expect(p!.status).toBe("repaying");
    });
  });

  it("respects the grace boundary on both sides", async () => {
    await withTestDb(async (db) => {
      const { notifier } = capturingNotifier();
      const owner = await seedAccount(db, { channels: ["email"] });
      // Just past grace (30d + 1h) -> defaults.
      const past = await seedProject(db, owner.id, "repaying");
      await seedInstallment(db, past, { dueAt: new Date(Date.now() - 30 * DAY - 60 * 60 * 1000) });
      // Just within grace (29d) -> reminds only, stays repaying.
      const within = await seedProject(db, owner.id, "repaying");
      await seedInstallment(db, within, { dueAt: daysAgo(29) });

      const r = await runRepaymentSweep(db, notifier, new NoPenaltyPolicy(), { ...opts30 });
      expect(r.defaulted).toBe(1);

      const [pPast] = await db
        .select({ status: projects.status })
        .from(projects)
        .where(eq(projects.id, past));
      const [pWithin] = await db
        .select({ status: projects.status })
        .from(projects)
        .where(eq(projects.id, within));
      expect(pPast!.status).toBe("defaulted");
      expect(pWithin!.status).toBe("repaying");
    });
  });

  it("recovers defaulted -> repaying once no grace-exceeded overdue installment remains", async () => {
    await withTestDb(async (db) => {
      const { notifier, sent } = capturingNotifier();
      const owner = await seedAccount(db, { channels: ["email"] });
      const project = await seedProject(db, owner.id, "defaulted", daysAgo(3));
      // The formerly-overdue installment is now paid -> nothing grace-exceeded remains.
      await seedInstallment(db, project, { dueAt: daysAgo(40), status: "paid" });

      const r = await runRepaymentSweep(db, notifier, new NoPenaltyPolicy(), { ...opts30 });
      expect(r.recovered).toBe(1);
      // No notification on recovery.
      expect(sent).toHaveLength(0);

      const [p] = await db
        .select({ status: projects.status, defaultedAt: projects.defaultedAt })
        .from(projects)
        .where(eq(projects.id, project));
      expect(p!.status).toBe("repaying");
      expect(p!.defaultedAt).toBeNull();
    });
  });

  it("does NOT recover a defaulted project while a grace-exceeded installment is still pending", async () => {
    await withTestDb(async (db) => {
      const { notifier } = capturingNotifier();
      const owner = await seedAccount(db, { channels: ["email"] });
      const project = await seedProject(db, owner.id, "defaulted", daysAgo(3));
      // The overdue installment is mid-collection (pending, money not settled), not
      // paid. It must count as still-delinquent so the project stays defaulted until
      // the collection actually settles (avoids a recover -> fail -> re-default flap).
      await seedInstallment(db, project, { dueAt: daysAgo(40), status: "pending" });

      const r = await runRepaymentSweep(db, notifier, new NoPenaltyPolicy(), { ...opts30 });
      expect(r.recovered).toBe(0);

      const [p] = await db.select({ status: projects.status }).from(projects).where(eq(projects.id, project));
      expect(p!.status).toBe("defaulted");
    });
  });

  it("defaults to email when the porteur has no notification_pref row", async () => {
    await withTestDb(async (db) => {
      const { notifier, sent } = capturingNotifier();
      const owner = await seedAccount(db, { channels: null }); // no pref row
      const project = await seedProject(db, owner.id, "repaying");
      await seedInstallment(db, project, { dueAt: daysAgo(5) });

      const r = await runRepaymentSweep(db, notifier, new NoPenaltyPolicy(), {
        graceDays: 30,
        notifyChannels: ["email", "sms"],
      });
      expect(r.remindersSent).toBe(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to.email).toBe(owner.email);
    });
  });

  it("increments the counter but sends nothing when the porteur opted out (channels [])", async () => {
    await withTestDb(async (db) => {
      const { notifier, sent } = capturingNotifier();
      const owner = await seedAccount(db, { phone: "+22890000010", channels: [] });
      const project = await seedProject(db, owner.id, "repaying");
      const installment = await seedInstallment(db, project, { dueAt: daysAgo(5) });

      const r = await runRepaymentSweep(db, notifier, new NoPenaltyPolicy(), {
        graceDays: 30,
        notifyChannels: ["email", "sms"],
      });
      expect(r.remindersSent).toBe(1);
      expect(sent).toHaveLength(0);
      // The guarded reminded_at was still written despite the skipped send.
      const [ins] = await db
        .select({ remindedAt: repaymentInstallments.remindedAt })
        .from(repaymentInstallments)
        .where(eq(repaymentInstallments.id, installment));
      expect(ins!.remindedAt).not.toBeNull();
    });
  });

  it("notifies each investor once even with several released investments", async () => {
    await withTestDb(async (db) => {
      const { notifier, sent } = capturingNotifier();
      const owner = await seedAccount(db, { channels: [] }); // silence the porteur reminder
      const investor = await seedAccount(db, { channels: ["email"], roles: ["investisseur"] });
      const project = await seedProject(db, owner.id, "repaying");
      await seedInstallment(db, project, { dueAt: daysAgo(40) });
      await seedInvestment(db, project, investor.id);
      await seedInvestment(db, project, investor.id); // same investor, second release

      const r = await runRepaymentSweep(db, notifier, new NoPenaltyPolicy(), { ...opts30 });
      expect(r.defaulted).toBe(1);
      // Porteur opted out; the only send is to the single investor, once.
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to.email).toBe(investor.email);
    });
  });

  it("ignores non-due installments (a paid overdue installment neither reminds nor defaults)", async () => {
    await withTestDb(async (db) => {
      const { notifier, sent } = capturingNotifier();
      const owner = await seedAccount(db, { channels: ["email"] });
      const project = await seedProject(db, owner.id, "repaying");
      // 40 days overdue but already paid: the status='due' filter must exclude it.
      await seedInstallment(db, project, { dueAt: daysAgo(40), status: "paid" });

      const r = await runRepaymentSweep(db, notifier, new NoPenaltyPolicy(), { ...opts30 });
      expect(r.remindersSent).toBe(0);
      expect(r.defaulted).toBe(0);
      expect(sent).toHaveLength(0);
      const [p] = await db
        .select({ status: projects.status })
        .from(projects)
        .where(eq(projects.id, project));
      expect(p!.status).toBe("repaying");
    });
  });

  it("moves no money (NoPenaltyPolicy): no wallet or distribution rows created", async () => {
    await withTestDb(async (db) => {
      const { notifier } = capturingNotifier();
      const owner = await seedAccount(db, { channels: ["email"] });
      const investor = await seedAccount(db, { channels: ["email"], roles: ["investisseur"] });
      await db.insert(wallets).values({ accountId: owner.id });
      await db.insert(wallets).values({ accountId: investor.id });
      const project = await seedProject(db, owner.id, "repaying");
      await seedInstallment(db, project, { dueAt: daysAgo(40) });
      await seedInvestment(db, project, investor.id);

      const r = await runRepaymentSweep(db, notifier, new NoPenaltyPolicy(), { ...opts30 });
      // The sweep actually did work in this same test (non-vacuous).
      expect(r.remindersSent + r.defaulted).toBeGreaterThan(0);

      const entries = await db.select({ id: walletEntries.id }).from(walletEntries);
      const dists = await db.select({ id: repaymentDistributions.id }).from(repaymentDistributions);
      expect(entries).toHaveLength(0);
      expect(dists).toHaveLength(0);
    });
  });
});
