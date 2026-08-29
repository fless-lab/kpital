import { and, eq, lt, isNull, inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import type { Channel, Notifier, Recipient } from "../../lib/notifier";
import { resolveEffectiveChannels } from "../../lib/notifier";
import type { PenaltyPolicy } from "../../lib/penalty";
import {
  accounts,
  investments,
  notificationPrefs,
  projects,
  repaymentInstallments,
} from "../../db/schema";

export type SweepResult = { remindersSent: number; defaulted: number; recovered: number };
export type SweepOpts = { graceDays: number; notifyChannels: Channel[] };

const DAY_MS = 24 * 60 * 60 * 1000;

// Build the recipient a notification may actually reach for one account: intersect
// the account's own pref channels (defaulting to ["email"] when it has NO pref row;
// an explicit empty array means "opted out of everything") with the globally
// enabled channels, then keep only the contact fields those channels cover.
// Mirrors admin-routes.ts open-collection so both notify paths behave identically.
function recipientFor(
  contact: { email: string | null; phone: string | null; channels: string[] | null },
  notifyChannels: Channel[],
): Recipient | null {
  const effective = resolveEffectiveChannels(contact.channels ?? ["email"], notifyChannels);
  const to: Recipient = {
    ...(effective.includes("email") && contact.email ? { email: contact.email } : {}),
    ...(effective.includes("sms") && contact.phone ? { phone: contact.phone } : {}),
  };
  if (!to.email && !to.phone) return null;
  return to;
}

// Notify a defaulted project's investors (released stakes only), best-effort and
// deduped by account so an investor with several released investments is notified
// once. Mirrors the sweep's phase-2 inline block so the admin-default route and the
// schedule-default sweep notify identically; a send failure is swallowed (the
// caller's status transition has already committed and must not roll back).
export async function notifyProjectDefaulted(
  db: Db,
  notifier: Notifier,
  projectId: string,
  notifyChannels: Channel[],
): Promise<void> {
  try {
    const investors = await db
      .selectDistinct({
        accountId: investments.investorAccountId,
        email: accounts.email,
        phone: accounts.phone,
        channels: notificationPrefs.channels,
      })
      .from(investments)
      .innerJoin(accounts, eq(accounts.id, investments.investorAccountId))
      .leftJoin(notificationPrefs, eq(notificationPrefs.accountId, investments.investorAccountId))
      .where(and(eq(investments.projectId, projectId), eq(investments.status, "released")));

    await Promise.all(
      investors.map((inv) => {
        const to = recipientFor(inv, notifyChannels);
        if (!to) return Promise.resolve();
        return notifier.send(to, {
          subject: "Projet en defaut de remboursement",
          body: "Un projet KPITAL dans lequel vous avez investi est en defaut de remboursement. Nos equipes assurent le suivi.",
        });
      }),
    );
  } catch {
    // best-effort: the transition is durable regardless of delivery.
  }
}

// Daily-cron mock. Idempotent: reminders are guarded by reminded_at, the project
// transitions by a status guard, so a re-run sends nothing new and re-transitions
// nothing. No money moves here (the PenaltyPolicy seam returns 0). Notifications
// run best-effort AFTER their guard has committed, so a send failure can never
// roll back a reminded_at or a status change.
export async function runRepaymentSweep(
  db: Db,
  notifier: Notifier,
  penalty: PenaltyPolicy,
  opts: SweepOpts,
): Promise<SweepResult> {
  const now = new Date();
  const graceCutoff = new Date(now.getTime() - opts.graceDays * DAY_MS);

  let remindersSent = 0;
  let defaulted = 0;
  let recovered = 0;

  // ---- Phase 1: reminders (once per overdue installment) ----
  // An overdue installment is a not-fully-paid one (paid_minor < amount_minor) whose
  // due_at has passed, on a project still in the repayment cycle (repaying OR
  // defaulted). Keying on paid_minor (not status) means a partially-paid installment
  // is still delinquent. reminded_at IS NULL is both a filter and the guard the
  // UPDATE re-checks, so concurrent sweeps cannot double-remind.
  const overdue = await db
    .select({
      installmentId: repaymentInstallments.id,
      amountMinor: repaymentInstallments.amountMinor,
      dueAt: repaymentInstallments.dueAt,
      ownerAccountId: projects.ownerAccountId,
    })
    .from(repaymentInstallments)
    .innerJoin(projects, eq(projects.id, repaymentInstallments.projectId))
    .where(
      and(
        lt(repaymentInstallments.paidMinor, repaymentInstallments.amountMinor),
        lt(repaymentInstallments.dueAt, now),
        isNull(repaymentInstallments.remindedAt),
        inArray(projects.status, ["repaying", "defaulted"]),
      ),
    );

  for (const row of overdue) {
    // Guarded update: re-check reminded_at so only the sweep that actually flips
    // NULL -> now owns the reminder. This UPDATE stands alone (no surrounding
    // transaction) so the send below can never undo it.
    const changed = await db
      .update(repaymentInstallments)
      .set({ remindedAt: now })
      .where(and(eq(repaymentInstallments.id, row.installmentId), isNull(repaymentInstallments.remindedAt)))
      .returning({ id: repaymentInstallments.id });
    if (changed.length === 0) continue;

    remindersSent += 1;

    // Exercise the penalty seam (NoPenaltyPolicy -> 0 -> no money moves).
    const daysLate = Math.floor((now.getTime() - row.dueAt.getTime()) / DAY_MS);
    penalty.penaltyFor({ installmentId: row.installmentId, amountMinor: row.amountMinor, daysLate });

    // Notify the porteur, best-effort. A failure here must not roll back the
    // committed reminded_at, so it is caught and swallowed.
    try {
      const [contact] = await db
        .select({ email: accounts.email, phone: accounts.phone, channels: notificationPrefs.channels })
        .from(accounts)
        .leftJoin(notificationPrefs, eq(notificationPrefs.accountId, accounts.id))
        .where(eq(accounts.id, row.ownerAccountId));
      const to = contact ? recipientFor(contact, opts.notifyChannels) : null;
      if (to) {
        await notifier.send(to, {
          subject: "Rappel : echeance de remboursement en retard",
          body: "Une echeance de remboursement de votre projet KPITAL est en retard. Merci de regulariser au plus vite.",
        });
      }
    } catch {
      // best-effort: the reminder is durable regardless of delivery.
    }
  }

  // ---- Phase 2: default (repaying -> defaulted) ----
  // Distinct projects that have at least one grace-exceeded not-fully-paid
  // installment (paid_minor < amount_minor) and are still `repaying`. Guarded UPDATE
  // flips exactly the ones still repaying.
  const defaultCandidates = await db
    .selectDistinct({ projectId: repaymentInstallments.projectId })
    .from(repaymentInstallments)
    .innerJoin(projects, eq(projects.id, repaymentInstallments.projectId))
    .where(
      and(
        lt(repaymentInstallments.paidMinor, repaymentInstallments.amountMinor),
        lt(repaymentInstallments.dueAt, graceCutoff),
        eq(projects.status, "repaying"),
      ),
    );

  for (const { projectId } of defaultCandidates) {
    const changed = await db
      .update(projects)
      .set({ status: "defaulted", defaultedAt: now, updatedAt: now })
      .where(and(eq(projects.id, projectId), eq(projects.status, "repaying")))
      .returning({ id: projects.id });
    if (changed.length === 0) continue;

    defaulted += 1;

    // Notify the project's investors (released stakes), best-effort, deduped by
    // account so an investor with several released investments is notified once.
    try {
      const investors = await db
        .selectDistinct({
          accountId: investments.investorAccountId,
          email: accounts.email,
          phone: accounts.phone,
          channels: notificationPrefs.channels,
        })
        .from(investments)
        .innerJoin(accounts, eq(accounts.id, investments.investorAccountId))
        .leftJoin(notificationPrefs, eq(notificationPrefs.accountId, investments.investorAccountId))
        .where(and(eq(investments.projectId, projectId), eq(investments.status, "released")));

      await Promise.all(
        investors.map((inv) => {
          const to = recipientFor(inv, opts.notifyChannels);
          if (!to) return Promise.resolve();
          return notifier.send(to, {
            subject: "Projet en defaut de remboursement",
            body: "Un projet KPITAL dans lequel vous avez investi est en defaut de remboursement. Nos equipes assurent le suivi.",
          });
        }),
      );
    } catch {
      // best-effort: the transition is durable regardless of delivery.
    }
  }

  // ---- Phase 3: recovery (defaulted -> repaying) ----
  // Re-query current state (AFTER the default phase). A defaulted project recovers
  // when NO not-fully-paid installment (paid_minor < amount_minor) remains past the
  // grace cutoff. Projects with such an installment are excluded; the rest are
  // flipped back under a status guard.
  // admin_defaulted = false: only auto-recover schedule-driven defaults. An admin
  // default is sticky (POST /admin/projects/:id/default sets the marker), so the
  // sweep's global auto-recovery cannot silently undo it; only undefault clears it.
  const defaultedProjects = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.status, "defaulted"), eq(projects.adminDefaulted, false)));

  if (defaultedProjects.length > 0) {
    // A grace-exceeded installment counts as still-delinquent while
    // paid_minor < amount_minor (not yet fully paid). This naturally covers an
    // in-flight collection: a `pending` collection has not incremented paid_minor
    // yet, so the installment still reads as delinquent. Recovering on in-flight
    // money would flip the project to `repaying`; if that collection then fails,
    // the next sweep re-defaults and re-notifies investors. Waiting for paid_minor
    // to reach amount_minor (money actually settled) avoids that flap and matches
    // /repay, which only lifts once paid_minor covers the amount.
    const stillDelinquentRows = await db
      .selectDistinct({ projectId: repaymentInstallments.projectId })
      .from(repaymentInstallments)
      .where(
        and(
          lt(repaymentInstallments.paidMinor, repaymentInstallments.amountMinor),
          lt(repaymentInstallments.dueAt, graceCutoff),
        ),
      );
    const stillDelinquent = new Set(stillDelinquentRows.map((r) => r.projectId));

    for (const { id } of defaultedProjects) {
      if (stillDelinquent.has(id)) continue;
      const changed = await db
        .update(projects)
        .set({ status: "repaying", defaultedAt: null, updatedAt: now })
        .where(and(eq(projects.id, id), eq(projects.status, "defaulted")))
        .returning({ id: projects.id });
      if (changed.length > 0) recovered += 1;
    }
  }

  return { remindersSent, defaulted, recovered };
}
