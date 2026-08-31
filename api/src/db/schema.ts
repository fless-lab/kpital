import { pgTable, uuid, text, boolean, timestamp, pgEnum, bigint, jsonb, integer, date, numeric, primaryKey, check, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const kycStatus = pgEnum("kyc_status", ["pending", "verified", "rejected"]);
export const acctStatus = pgEnum("acct_status", ["active", "suspended", "closed"]);

export const accounts = pgTable("account", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").unique(),
  phone: text("phone").unique(),
  passwordHash: text("password_hash").notNull(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  country: text("country").notNull(),
  roles: text("roles").array().notNull().default([]),
  kycStatus: kycStatus("kyc_status").notNull().default("pending"),
  status: acctStatus("status").notNull().default("active"),
  isAdmin: boolean("is_admin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const wallets = pgTable("wallet", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull().references(() => accounts.id).unique(),
  currency: text("currency").notNull().default("XOF"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("session", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  tokenHash: text("token_hash").notNull().unique(),
  userAgent: text("user_agent"),
  ip: text("ip"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const entryType = pgEnum("entry_type", ["repayment", "withdrawal", "reinvestment", "adjustment", "disbursement", "refund"]);
export const walletEntries = pgTable("wallet_entry", {
  id: uuid("id").defaultRandom().primaryKey(),
  walletId: uuid("wallet_id").notNull().references(() => wallets.id),
  type: entryType("type").notNull(),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  reference: text("reference"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const passwordResets = pgTable("password_reset", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const payoutType = pgEnum("payout_type", ["tmoney", "flooz", "bank"]);
export const payoutMethods = pgTable("payout_method", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  type: payoutType("type").notNull(),
  details: jsonb("details").notNull(),
  verified: boolean("verified").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const notificationPrefs = pgTable("notification_pref", {
  accountId: uuid("account_id").primaryKey().references(() => accounts.id),
  channels: text("channels").array().notNull().default(["email"]),
  categories: jsonb("categories").notNull().default({}),
});

export const kycDocType = pgEnum("kyc_doc_type", ["cni", "passeport", "sejour"]);
export const kycSubStatus = pgEnum("kyc_sub_status", ["pending", "verified", "rejected"]);
export const kycDocKind = pgEnum("kyc_doc_kind", ["front", "back", "passport_page"]);
export const kycSubmissions = pgTable("kyc_submission", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  docType: kycDocType("doc_type").notNull(),
  docNumber: text("doc_number").notNull(),
  dob: date("dob").notNull(),
  nationality: text("nationality").notNull(),
  status: kycSubStatus("status").notNull().default("pending"),
  rejectReason: text("reject_reason"),
  reviewedBy: uuid("reviewed_by").references(() => accounts.id),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  superseded: boolean("superseded").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const kycDocuments = pgTable("kyc_document", {
  id: uuid("id").defaultRandom().primaryKey(),
  submissionId: uuid("submission_id").notNull().references(() => kycSubmissions.id, { onDelete: "cascade" }),
  kind: kycDocKind("kind").notNull(),
  storageKey: text("storage_key").notNull(),
  mime: text("mime").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const otpChannel = pgEnum("otp_channel", ["email", "sms"]);
export const otpPurpose = pgEnum("otp_purpose", ["login", "password_reset", "verify_contact"]);
export const otpCodes = pgTable("otp_code", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").references(() => accounts.id),
  channel: otpChannel("channel").notNull(),
  purpose: otpPurpose("purpose").notNull(),
  codeHash: text("code_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projectCategory = pgEnum("project_category", ["immobilier","commerce","agriculture"]);
export const projectStatus = pgEnum("project_status", ["draft","submitted","in_review","rejected","showcase","collecting","funded","repaying","closed","cancelled","defaulted"]);
export const projectScore = pgEnum("project_score", ["A","B","C","D"]);
export const projectDocKind = pgEnum("project_doc_kind", ["rccm","foncier","releves","photo"]);
export const projectDocVisibility = pgEnum("project_doc_visibility", ["public","private"]);
export const projects = pgTable("project", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerAccountId: uuid("owner_account_id").notNull().references(() => accounts.id),
  category: projectCategory("category").notNull(),
  title: text("title").notNull(), city: text("city").notNull(), quartier: text("quartier"),
  description: text("description").notNull(),
  targetMinor: bigint("target_minor", { mode: "number" }).notNull(),
  durationMonths: integer("duration_months").notNull(),
  roiPct: numeric("roi_pct").notNull(),
  fundsUsage: text("funds_usage").notNull(),
  cautionType: text("caution_type").notNull(),
  status: projectStatus("status").notNull().default("draft"),
  score: projectScore("score"),
  rejectReason: text("reject_reason"),
  reviewedBy: uuid("reviewed_by").references(() => accounts.id),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  collectingOpenedAt: timestamp("collecting_opened_at", { withTimezone: true }),
  defaultedAt: timestamp("defaulted_at", { withTimezone: true }),
  // Set true when an admin defaults the project by hand (POST /admin/projects/:id/default).
  // The sweep's auto-recovery phase excludes these, so an admin default is STICKY:
  // only schedule-driven defaults (this stays false) are auto-recovered. Cleared by undefault.
  adminDefaulted: boolean("admin_defaulted").notNull().default(false),
  upvoteCount: integer("upvote_count").notNull().default(0),
  followCount: integer("follow_count").notNull().default(0),
  raisedMinor: bigint("raised_minor", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // DB-level backstop for the no-overfunding invariant: raised is always within
  // [0, target], even if a future writer forgets the FOR UPDATE lock. The invest
  // path enforces this in app logic; this constraint is defense in depth.
  raisedWithinTarget: check(
    "project_raised_within_target",
    sql`${t.raisedMinor} >= 0 AND ${t.raisedMinor} <= ${t.targetMinor}`,
  ),
}));
export const projectDocuments = pgTable("project_document", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  kind: projectDocKind("kind").notNull(),
  visibility: projectDocVisibility("visibility").notNull(),
  storageKey: text("storage_key").notNull(), mime: text("mime").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const projectFollows = pgTable("project_follow", {
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.accountId, t.projectId] }) }));
export const projectUpvotes = pgTable("project_upvote", {
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.accountId, t.projectId] }) }));

export const investmentSource = pgEnum("investment_source", ["payment", "wallet"]);
export const investmentStatus = pgEnum("investment_status", ["pending","escrowed","released","refunded","failed"]);
export const investments = pgTable("investment", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  investorAccountId: uuid("investor_account_id").notNull().references(() => accounts.id),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  source: investmentSource("source").notNull(),
  paymentRef: text("payment_ref"),
  resolutionRef: text("resolution_ref"),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  status: investmentStatus("status").notNull().default("pending"),
  // Client-supplied request idempotency key (Idempotency-Key header). A retry of
  // the same logical invest reuses the key so a lost response after commit does
  // not create a second investment. Nullable: rows predating this column carry
  // null and are exempt from the partial unique index below.
  idempotencyKey: text("idempotency_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // The escrow webhook resolves a settlement/failure by payment_ref, so a
  // deposit ref must map to at most one investment. Enforce it at the DB layer
  // (partial: wallet-source rows carry a null payment_ref and are exempt).
  depositRefUnique: uniqueIndex("investment_payment_ref_unique")
    .on(t.paymentRef)
    .where(sql`${t.paymentRef} IS NOT NULL`),
  // Request idempotency: at most one investment per (investor, key). The insert
  // carries the key, so a concurrent same-key racer blocks on this index then
  // fails with a unique violation, which the service maps to a replay of the
  // winning investment. Partial: null keys (legacy rows) are exempt.
  idempotencyUnique: uniqueIndex("investment_idempotency_unique")
    .on(t.investorAccountId, t.idempotencyKey)
    .where(sql`${t.idempotencyKey} IS NOT NULL`),
}));

export const repaymentInstallmentStatus = pgEnum("repayment_installment_status", ["due", "pending", "paid"]);
export const repaymentInstallments = pgTable("repayment_installment", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  seq: integer("seq").notNull(),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  paidMinor: bigint("paid_minor", { mode: "number" }).notNull().default(0),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  status: repaymentInstallmentStatus("status").notNull().default("due"),
  repaymentRef: text("repayment_ref"),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  remindedAt: timestamp("reminded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // The repayment webhook resolves a settlement by repayment_ref, so a ref must
  // map to at most one installment. Enforce it at the DB layer (partial: a `due`
  // installment carries a null ref and is exempt). Mirrors investment.payment_ref.
  repaymentRefUnique: uniqueIndex("repayment_installment_ref_unique")
    .on(t.repaymentRef)
    .where(sql`${t.repaymentRef} IS NOT NULL`),
  // Partial repayment (#8): paid_minor accumulates applied portions and can never
  // exceed the installment amount (conservation invariant (b)).
  paidWithinAmount: check(
    "repayment_installment_paid_within_amount",
    sql`${t.paidMinor} >= 0 AND ${t.paidMinor} <= ${t.amountMinor}`,
  ),
}));
export const repaymentPaymentStatus = pgEnum("repayment_payment_status", ["pending", "settled", "failed"]);
export const repaymentPayments = pgTable("repayment_payment", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  ref: text("ref"),
  status: repaymentPaymentStatus("status").notNull().default("pending"),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refUnique: uniqueIndex("repayment_payment_ref_unique").on(t.ref).where(sql`${t.ref} IS NOT NULL`),
}));
export const repaymentApplications = pgTable("repayment_application", {
  id: uuid("id").defaultRandom().primaryKey(),
  paymentId: uuid("payment_id").notNull().references(() => repaymentPayments.id),
  installmentId: uuid("installment_id").notNull().references(() => repaymentInstallments.id),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  perInstallmentUnique: uniqueIndex("repayment_application_payment_installment_unique").on(t.paymentId, t.installmentId),
}));
export const repaymentDistributions = pgTable("repayment_distribution", {
  id: uuid("id").defaultRandom().primaryKey(),
  installmentId: uuid("installment_id").notNull().references(() => repaymentInstallments.id),
  investmentId: uuid("investment_id").notNull().references(() => investments.id),
  // #8: a payment applies portions to an installment, so one installment can now
  // receive several distributions (one per portion). The old UNIQUE(installment_id,
  // investment_id) is dropped for that reason; exactly-once is instead guaranteed
  // by settlePayment's single atomic transaction plus the payment.status guard, so
  // application_id is a plain (now mandatory) FK, not a uniqueness carrier.
  applicationId: uuid("application_id").notNull().references(() => repaymentApplications.id),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
