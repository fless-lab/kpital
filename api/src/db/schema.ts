import { pgTable, uuid, text, boolean, timestamp, pgEnum, bigint, jsonb, integer, date, numeric, primaryKey } from "drizzle-orm/pg-core";

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

export const entryType = pgEnum("entry_type", ["repayment", "withdrawal", "reinvestment", "adjustment"]);
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
export const projectStatus = pgEnum("project_status", ["draft","submitted","in_review","rejected","showcase","collecting","funded","repaying","closed"]);
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
  upvoteCount: integer("upvote_count").notNull().default(0),
  followCount: integer("follow_count").notNull().default(0),
  raisedMinor: bigint("raised_minor", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
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
export const investmentStatus = pgEnum("investment_status", ["confirmed"]);
export const investments = pgTable("investment", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  investorAccountId: uuid("investor_account_id").notNull().references(() => accounts.id),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  source: investmentSource("source").notNull(),
  paymentRef: text("payment_ref"),
  status: investmentStatus("status").notNull().default("confirmed"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
