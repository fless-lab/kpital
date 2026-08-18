import { pgTable, uuid, text, boolean, timestamp, pgEnum } from "drizzle-orm/pg-core";

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
