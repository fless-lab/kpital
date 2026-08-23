import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { accounts, projects, wallets, walletEntries, investments } from "../../db/schema";
import type { PaymentProvider, PayoutMethod } from "../../lib/payments";
import { idemKey, settleDeposit, releaseProject } from "../escrow/service";
import { balanceForWallet, InsufficientFundsError } from "../wallet/service";

// Minimum single investment ticket, in integer minor units.
export const MIN_TICKET_MINOR = 10000;

// The caller's KYC is not verified. → 403 kyc_required.
export class KycRequiredError extends Error {
  constructor() {
    super("kyc_required");
    this.name = "KycRequiredError";
  }
}

// The target project is not in the "collecting" state. → 409 invalid_state.
export class NotCollectingError extends Error {
  constructor() {
    super("invalid_state");
    this.name = "NotCollectingError";
  }
}

// The amount is below MIN_TICKET_MINOR. → 400 below_min_ticket.
export class BelowMinTicketError extends Error {
  constructor() {
    super("below_min_ticket");
    this.name = "BelowMinTicketError";
  }
}

// The amount exceeds the remaining capacity and the caller did not opt into
// capping. Carries the remaining amount so the route can surface it. → 409.
export class ExceedsRemainingError extends Error {
  readonly remainingMinor: number;
  constructor(remainingMinor: number) {
    super("exceeds_remaining");
    this.name = "ExceedsRemainingError";
    this.remainingMinor = remainingMinor;
  }
}

// The payment provider declined the collection. → 402 payment_failed.
export class PaymentFailedError extends Error {
  constructor() {
    super("payment_failed");
    this.name = "PaymentFailedError";
  }
}

// The target project row does not exist. → 404 not_found.
export class ProjectNotFoundError extends Error {
  constructor() {
    super("project_not_found");
    this.name = "ProjectNotFoundError";
  }
}

// Re-export so route/tests can reference the wallet insufficient-funds error
// from this module too.
export { InsufficientFundsError };

export type InvestmentSource = "payment" | "wallet";

export interface CreateInvestmentInput {
  projectId: string;
  accountId: string;
  amountMinor: number;
  source: InvestmentSource;
  method?: PayoutMethod;
  confirmCapToRemaining?: boolean;
}

export interface CreateInvestmentResult {
  investmentId: string;
  amountMinor: number;
  status: "escrowed" | "pending";
  raisedMinor: number;
  projectStatus: string;
  depositRef: string | null;
}

// Two-phase escrow invest flow.
//
// Phase 1 (this transaction) locks the project row FOR UPDATE first, so the
// remaining-capacity check and every capacity-reserving write are atomic across
// concurrent investments. The reserved capacity invariant is
//   raised_minor + sum(status = 'pending') <= target_minor
// and EVERY mutator of either term holds the project FOR UPDATE lock: the invest
// tx inserts a pending payment deposit (or advances raised for wallet);
// settleDeposit (Task 3) moves a pending deposit INTO raised, conserving the
// total; the wallet path advances raised directly. So `remaining` below subtracts
// BOTH settled raise and in-flight pending deposits: a payment deposit that has
// not settled yet still holds capacity in the invest tx, exactly reconstructing
// the single-transaction #4 semantics even though raised now advances at
// settlement (outside this lock). failDeposit only ever shrinks the pending sum
// (frees capacity) so it needs no project lock and cannot cause an overfund.
//
// wallet source settles instantly inside this transaction (internal ledger).
// payment source inserts a `pending` investment and initiates the provider
// deposit; if the mock/provider returns `settled`, settlement (escrow + raised++
// + funded + release) runs in settleDeposit AFTER this transaction commits, under
// its OWN project lock, so no network I/O is ever held under the invest lock.
export async function createInvestment(
  db: Db,
  payments: PaymentProvider,
  input: CreateInvestmentInput,
): Promise<CreateInvestmentResult> {
  const investmentId = randomUUID();

  const phase1 = await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;

    // 1. KYC gate: read the caller's status.
    const [acct] = await tx
      .select({ kycStatus: accounts.kycStatus })
      .from(accounts)
      .where(eq(accounts.id, input.accountId));
    if (!acct) throw new KycRequiredError();
    if (acct.kycStatus !== "verified") throw new KycRequiredError();

    // 2. Lock the project row FIRST, then validate its state.
    const [project] = await tx.select().from(projects).where(eq(projects.id, input.projectId)).for("update");
    if (!project) throw new ProjectNotFoundError();
    if (project.status !== "collecting") throw new NotCollectingError();

    // 3. Remaining is read UNDER the lock and reserves in-flight pending deposits
    // (see the invariant above). Min-ticket is checked BEFORE any cap.
    const [pending] = await tx
      .select({ sum: sql<string>`coalesce(sum(${investments.amountMinor}), 0)` })
      .from(investments)
      .where(and(eq(investments.projectId, input.projectId), eq(investments.status, "pending")));
    const pendingMinor = Number(pending?.sum ?? 0);
    const remaining = project.targetMinor - project.raisedMinor - pendingMinor;
    let amountMinor = input.amountMinor;
    if (amountMinor < MIN_TICKET_MINOR) throw new BelowMinTicketError();
    if (amountMinor > remaining) {
      if (!input.confirmCapToRemaining) throw new ExceedsRemainingError(remaining);
      amountMinor = remaining;
    }

    if (input.source === "wallet") {
      // Lock the wallet row before summing the balance so two concurrent
      // balance-reducing writers cannot both pass the check and overdraw.
      const [w] = await tx.select({ id: wallets.id }).from(wallets).where(eq(wallets.accountId, input.accountId)).for("update");
      if (!w) throw new InsufficientFundsError();
      const balance = await balanceForWallet(txDb, w.id);
      if (balance < amountMinor) throw new InsufficientFundsError();
      await tx.insert(walletEntries).values({
        walletId: w.id,
        type: "reinvestment",
        amountMinor: -amountMinor,
        reference: investmentId,
      });

      // Wallet settles instantly: record the escrowed investment and advance
      // raised_minor here, flipping to "funded" exactly when the target is hit.
      await tx.insert(investments).values({
        id: investmentId,
        projectId: input.projectId,
        investorAccountId: input.accountId,
        amountMinor,
        source: "wallet",
        paymentRef: null,
        status: "escrowed",
      });
      const newRaised = project.raisedMinor + amountMinor;
      const projectStatus = newRaised === project.targetMinor ? "funded" : project.status;
      await tx
        .update(projects)
        .set({ raisedMinor: newRaised, status: projectStatus, updatedAt: new Date() })
        .where(eq(projects.id, input.projectId));
      return { source: "wallet" as const, amountMinor, raisedMinor: newRaised, projectStatus };
    }

    // payment source: record a PENDING investment (raised NOT advanced), then
    // initiate the provider deposit. A synchronous decline rolls this insert back
    // (no investment row). On success, store the deposit ref as paymentRef.
    await tx.insert(investments).values({
      id: investmentId,
      projectId: input.projectId,
      investorAccountId: input.accountId,
      amountMinor,
      source: "payment",
      paymentRef: null,
      status: "pending",
    });
    const dep = await payments.initiateDeposit({
      accountId: input.accountId,
      amountMinor,
      ...(input.method !== undefined ? { method: input.method } : {}),
      idempotencyKey: idemKey("deposit", investmentId),
    });
    if (!dep.ok) throw new PaymentFailedError();
    await tx.update(investments).set({ paymentRef: dep.ref }).where(eq(investments.id, investmentId));
    return { source: "payment" as const, amountMinor, depositRef: dep.ref, depositStatus: dep.status, preRaised: project.raisedMinor };
  });

  // Phase 2 runs AFTER the invest transaction commits, never under the invest
  // lock.
  if (phase1.source === "wallet") {
    // A wallet invest that hit the target releases escrow to the porteur here,
    // outside the invest lock, so release never runs network I/O under the lock.
    if (phase1.projectStatus === "funded") {
      await releaseProject(db, payments, { projectId: input.projectId });
    }
    return {
      investmentId,
      amountMinor: phase1.amountMinor,
      status: "escrowed",
      raisedMinor: phase1.raisedMinor,
      projectStatus: phase1.projectStatus,
      depositRef: null,
    };
  }

  if (phase1.depositStatus === "settled") {
    // Settled deposit: apply escrow + raised++ + funded + release under its own
    // project lock, then reflect the post-settlement project state in the return.
    const settle = await settleDeposit(db, payments, { depositRef: phase1.depositRef });
    const [pj] = await db
      .select({ raisedMinor: projects.raisedMinor, status: projects.status })
      .from(projects)
      .where(eq(projects.id, input.projectId));
    return {
      investmentId,
      amountMinor: phase1.amountMinor,
      status: "escrowed",
      raisedMinor: pj?.raisedMinor ?? phase1.preRaised,
      projectStatus: settle.projectStatus ?? pj?.status ?? "collecting",
      depositRef: phase1.depositRef,
    };
  }

  // Pending deposit: nothing settled, raised_minor is unchanged.
  return {
    investmentId,
    amountMinor: phase1.amountMinor,
    status: "pending",
    raisedMinor: phase1.preRaised,
    projectStatus: "collecting",
    depositRef: phase1.depositRef,
  };
}

// The ONLY project fields an investor sees on their own investment list. It
// deliberately omits ownerAccountId (porteur PII), every internal review field,
// and raisedMinor/targetMinor (funding-surface concerns). This is the single
// source of truth for the joined project summary, mirroring the
// PUBLIC_PROJECT_COLUMNS idiom in the projects module.
export const MY_INVESTMENT_PROJECT_COLUMNS = {
  id: projects.id,
  title: projects.title,
  category: projects.category,
  status: projects.status,
  roiPct: projects.roiPct,
} as const;

export interface MyInvestment {
  id: string;
  amountMinor: number;
  source: InvestmentSource;
  createdAt: Date;
  project: {
    id: string;
    title: string;
    category: (typeof projects.$inferSelect)["category"];
    status: (typeof projects.$inferSelect)["status"];
    roiPct: string;
  };
}

// The caller's own investments, newest first, each with a projected project
// summary. The join is INNER because investments.projectId is NOT NULL and
// references a real project. No status filter: every investment status is
// returned (pending, escrowed, released, refunded, failed). Ordering is deterministic:
// createdAt desc with an id tiebreak for a total order.
export async function listMyInvestments(db: Db, accountId: string): Promise<MyInvestment[]> {
  return db
    .select({
      id: investments.id,
      amountMinor: investments.amountMinor,
      source: investments.source,
      createdAt: investments.createdAt,
      project: MY_INVESTMENT_PROJECT_COLUMNS,
    })
    .from(investments)
    .innerJoin(projects, eq(investments.projectId, projects.id))
    .where(eq(investments.investorAccountId, accountId))
    .orderBy(desc(investments.createdAt), asc(investments.id));
}
