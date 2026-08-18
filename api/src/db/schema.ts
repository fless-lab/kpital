import { pgTable, uuid, text, boolean, timestamp, pgEnum, bigint, jsonb } from "drizzle-orm/pg-core";

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
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const wallets = pgTable("wallet", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull().references(() => accounts.id).unique(),
  currency: text("currency").notNull().default("XOF"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const entryType = pgEnum("entry_type", ["repayment", "withdrawal", "reinvestment", "adjustment"]);
export const walletEntries = pgTable("wallet_entry", {
  id: uuid("id").defaultRandom().primaryKey(),
  walletId: uuid("wallet_id").notNull().references(() => wallets.id),
  type: entryType("type").notNull(),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  reference: text("reference"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
