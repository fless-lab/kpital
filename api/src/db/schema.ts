import { pgTable, uuid, text, boolean, timestamp, pgEnum, bigint, jsonb, integer } from "drizzle-orm/pg-core";

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
