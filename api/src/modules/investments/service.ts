import { randomUUID } from "node:crypto";
import { asc, desc, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { accounts, projects, wallets, walletEntries, investments } from "../../db/schema";
import type { PaymentProvider, PayoutMethod } from "../../lib/payments";
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
  raisedMinor: number;
  projectStatus: string;
  paymentRef: string | null;
}

// The whole invest flow is ONE transaction. The project row is locked FOR
// UPDATE first, so the remaining-capacity check and the raised_minor increment
// are atomic across concurrent investments, so no overfunding is possible. When
// funding from the wallet, the wallet row is locked FOR UPDATE (mirroring the
// overdraw-safe withdraw pattern) before the balance is summed.
export async function createInvestment(
  db: Db,
  payments: PaymentProvider,
  input: CreateInvestmentInput,
): Promise<CreateInvestmentResult> {
  return db.transaction(async (tx) => {
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

    // 3. Remaining is read UNDER the lock. Min-ticket is checked BEFORE any cap.
    const remaining = project.targetMinor - project.raisedMinor;
    let amountMinor = input.amountMinor;
    if (amountMinor < MIN_TICKET_MINOR) throw new BelowMinTicketError();
    if (amountMinor > remaining) {
      if (!input.confirmCapToRemaining) throw new ExceedsRemainingError(remaining);
      amountMinor = remaining;
    }

    // 4. Mint the id, then collect the funds from the chosen source.
    const investmentId = randomUUID();
    let paymentRef: string | null = null;

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
    } else {
      const res = await payments.collectFunds({
        accountId: input.accountId,
        amountMinor,
        ...(input.method !== undefined ? { method: input.method } : {}),
      });
      if (!res.ok) throw new PaymentFailedError();
      paymentRef = res.ref;
    }

    // 5. Record the confirmed investment.
    await tx.insert(investments).values({
      id: investmentId,
      projectId: input.projectId,
      investorAccountId: input.accountId,
      amountMinor,
      source: input.source,
      paymentRef,
      status: "confirmed",
    });

    // 6. Advance raised_minor; flip to "funded" exactly when the target is hit.
    const newRaised = project.raisedMinor + amountMinor;
    const projectStatus = newRaised === project.targetMinor ? "funded" : project.status;
    await tx
      .update(projects)
      .set({ raisedMinor: newRaised, status: projectStatus, updatedAt: new Date() })
      .where(eq(projects.id, input.projectId));

    // 7.
    return { investmentId, amountMinor, raisedMinor: newRaised, projectStatus, paymentRef };
  });
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
// returned (today only "confirmed" exists). Ordering is deterministic:
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
