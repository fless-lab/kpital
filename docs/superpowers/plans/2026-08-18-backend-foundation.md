# Backend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the KPITAL backend Foundation: accounts, password + OTP auth with revocable sessions, an append-only wallet ledger, a channel-driven notifier, a mocked payment interface, and a minimal admin, as a Node/TypeScript API in `api/`.

**Architecture:** Modular monolith. A Fastify HTTP layer validates input and delegates to services (auth, accounts, wallet). PostgreSQL via Drizzle ORM with versioned migrations. Money lives in an append-only `wallet_entry` ledger (balance = sum of entries). External effects (email, SMS, payouts) sit behind interfaces so nothing depends on an unsigned partner.

**Tech Stack:** Node.js LTS, TypeScript, Fastify, PostgreSQL, Drizzle ORM, argon2, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-18-backend-fondation-design.md`

## Global Constraints

- Language: TypeScript, strict mode. All source under `api/src/`, tests under `api/tests/` or colocated `*.test.ts`.
- DB access only through Drizzle; never string-concatenate SQL. Migrations are versioned files under `api/drizzle/`.
- Secrets/config only via environment, validated at boot (fail fast). Never commit secrets.
- Passwords hashed with argon2id. OTP codes, session tokens, and reset tokens are stored **hashed**, never in clear.
- Money amounts are integers in minor units (`bigint`, `amount_minor`), currency `XOF`. Wallet balance is always computed as `SUM(amount_minor)`; there is no mutable balance column.
- Notifications (OTP included) go through the `Notifier` layer; the active channels come from env `NOTIFY_CHANNELS` (`email` | `sms` | `email,sms`).
- Auth uses opaque server sessions in an httpOnly, Secure, SameSite=Lax cookie. JWTs are not used.
- Anti-enumeration: identifier-based flows (login, forgot-password, otp request) return the same response whether or not an account exists.
- Every task ends green (its tests pass) and with a commit.

---

### Task 1: Project scaffold + health route

**Files:**
- Create: `api/package.json`, `api/tsconfig.json`, `api/vitest.config.ts`, `api/.env.example`, `api/.gitignore`
- Create: `api/src/server.ts`, `api/src/app.ts`
- Test: `api/tests/health.test.ts`

**Interfaces:**
- Produces: `buildApp(): FastifyInstance` (in `api/src/app.ts`) — the app factory every route test imports.

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/health.test.ts
import { describe, it, expect } from "vitest";
import { buildApp } from "../src/app";

describe("GET /health", () => {
  it("returns ok", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });
});
```

- [ ] **Step 2: Init the package and install deps**

Run:
```bash
cd api && npm init -y
npm i fastify @fastify/cookie
npm i -D typescript tsx vitest @types/node
npx tsc --init --rootDir src --outDir dist --strict --module esnext --moduleResolution bundler --target es2022
```
Add to `api/package.json` scripts: `"dev": "tsx watch src/server.ts"`, `"test": "vitest run"`, `"build": "tsc"`. Set `"type": "module"`.

- [ ] **Step 3: Write minimal app + server**

```ts
// api/src/app.ts
import Fastify, { type FastifyInstance } from "fastify";

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get("/health", async () => ({ status: "ok" }));
  return app;
}
```
```ts
// api/src/server.ts
import { buildApp } from "./app";
const app = buildApp();
app.listen({ port: 3000, host: "0.0.0.0" }).catch((e) => { console.error(e); process.exit(1); });
```
Create `api/.gitignore` (`node_modules`, `dist`, `.env`) and `api/.env.example` (empty for now).

- [ ] **Step 4: Run the test**

Run: `cd api && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api && git commit -m "feat(api): scaffold Fastify app with health route"
```

---

### Task 2: Config module (env validation)

**Files:**
- Create: `api/src/config/env.ts`
- Test: `api/tests/config.test.ts`
- Modify: `api/.env.example`

**Interfaces:**
- Produces: `loadConfig(source?: Record<string,string|undefined>): Config` and the `Config` type with fields `databaseUrl`, `sessionCookieName`, `sessionTtlDays`, `otpTtlMinutes`, `notifyChannels: ("email"|"sms")[]`, `corsOrigin`.

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/config.test.ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config/env";

const base = { DATABASE_URL: "postgres://x", CORS_ORIGIN: "http://localhost:8080" };

describe("loadConfig", () => {
  it("parses NOTIFY_CHANNELS into an array", () => {
    const c = loadConfig({ ...base, NOTIFY_CHANNELS: "email,sms" });
    expect(c.notifyChannels).toEqual(["email", "sms"]);
  });
  it("throws when DATABASE_URL is missing", () => {
    expect(() => loadConfig({ CORS_ORIGIN: "x" })).toThrow();
  });
  it("defaults NOTIFY_CHANNELS to [email]", () => {
    expect(loadConfig(base).notifyChannels).toEqual(["email"]);
  });
});
```

- [ ] **Step 2: Install zod and run test (expect fail)**

Run: `cd api && npm i zod && npm test -- config`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement config**

```ts
// api/src/config/env.ts
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  SESSION_COOKIE_NAME: z.string().default("kpital_sess"),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  OTP_TTL_MINUTES: z.coerce.number().int().positive().default(10),
  NOTIFY_CHANNELS: z.string().default("email"),
  CORS_ORIGIN: z.string().min(1),
});

export type Config = {
  databaseUrl: string; sessionCookieName: string; sessionTtlDays: number;
  otpTtlMinutes: number; notifyChannels: ("email" | "sms")[]; corsOrigin: string;
};

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const e = schema.parse(source);
  const channels = e.NOTIFY_CHANNELS.split(",").map((s) => s.trim()).filter(Boolean);
  for (const c of channels) if (c !== "email" && c !== "sms") throw new Error(`bad channel: ${c}`);
  return {
    databaseUrl: e.DATABASE_URL, sessionCookieName: e.SESSION_COOKIE_NAME,
    sessionTtlDays: e.SESSION_TTL_DAYS, otpTtlMinutes: e.OTP_TTL_MINUTES,
    notifyChannels: channels as ("email" | "sms")[], corsOrigin: e.CORS_ORIGIN,
  };
}
```
Fill `api/.env.example` with the keys above.

- [ ] **Step 4: Run test** — Run: `cd api && npm test -- config` — Expected: PASS.
- [ ] **Step 5: Commit** — `git add api && git commit -m "feat(api): env config with validation"`

---

### Task 3: Database client, Drizzle schema (accounts), and test harness

**Files:**
- Create: `api/src/db/schema.ts`, `api/src/db/client.ts`, `api/drizzle.config.ts`
- Create: `api/tests/helpers/db.ts` (spin up a clean test schema)
- Test: `api/tests/db.test.ts`

**Interfaces:**
- Produces: `accounts` table (columns per spec §6), `db` (Drizzle instance factory `makeDb(url): Db`), and test helper `withTestDb()`.

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/db.test.ts
import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db";
import { accounts } from "../src/db/schema";

describe("accounts table", () => {
  it("inserts and reads an account", async () => {
    await withTestDb(async (db) => {
      const [row] = await db.insert(accounts).values({
        email: "a@b.co", passwordHash: "x", firstName: "K", lastName: "A",
        country: "Togo", roles: ["investor"],
      }).returning();
      expect(row.kycStatus).toBe("pending");
      expect(row.roles).toEqual(["investor"]);
    });
  });
});
```

- [ ] **Step 2: Install and run (expect fail)**

Run: `cd api && npm i drizzle-orm pg && npm i -D drizzle-kit @types/pg && npm test -- db`
Expected: FAIL.

- [ ] **Step 3: Implement schema, client, and harness**

```ts
// api/src/db/schema.ts
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
```
```ts
// api/src/db/client.ts
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
export type Db = ReturnType<typeof makeDb>;
export function makeDb(url: string) {
  const pool = new pg.Pool({ connectionString: url });
  return drizzle(pool, { schema });
}
```
Create `api/drizzle.config.ts` pointing at `src/db/schema.ts` and `drizzle/`. Generate the migration: `npx drizzle-kit generate`. The test helper `api/tests/helpers/db.ts` connects to `TEST_DATABASE_URL`, runs migrations onto a fresh schema, yields a `Db`, and truncates/drops after. (Use a local Postgres or a container; document in `api/README.md`.)

- [ ] **Step 4: Run test** — Run: `cd api && npm test -- db` — Expected: PASS.
- [ ] **Step 5: Commit** — `git add api && git commit -m "feat(api): drizzle account schema + test db harness"`

---

### Task 4: Password hashing + policy

**Files:**
- Create: `api/src/modules/auth/password.ts`
- Test: `api/src/modules/auth/password.test.ts`

**Interfaces:**
- Produces: `hashPassword(pw): Promise<string>`, `verifyPassword(pw, hash): Promise<boolean>`, `isStrongPassword(pw): boolean` (min 8, one uppercase, one digit — matches the front).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, isStrongPassword } from "./password";

describe("password", () => {
  it("hashes and verifies", async () => {
    const h = await hashPassword("Abcdef12");
    expect(await verifyPassword("Abcdef12", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
  });
  it("enforces policy", () => {
    expect(isStrongPassword("Abcdef12")).toBe(true);
    expect(isStrongPassword("short1")).toBe(false);
    expect(isStrongPassword("alllower123")).toBe(false);
  });
});
```

- [ ] **Step 2: Install and run (expect fail)** — Run: `cd api && npm i argon2 && npm test -- password` — Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// api/src/modules/auth/password.ts
import argon2 from "argon2";
export const hashPassword = (pw: string) => argon2.hash(pw, { type: argon2.argon2id });
export const verifyPassword = (pw: string, hash: string) => argon2.verify(hash, pw);
export const isStrongPassword = (pw: string) =>
  pw.length >= 8 && /[A-Z]/.test(pw) && /[0-9]/.test(pw);
```

- [ ] **Step 4: Run test** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(api): argon2 password hashing + policy"`

---

### Task 5: Wallet schema + registration service (account + wallet)

**Files:**
- Modify: `api/src/db/schema.ts` (add `wallets`, `walletEntries`), regenerate migration
- Create: `api/src/modules/accounts/register.ts`
- Test: `api/src/modules/accounts/register.test.ts`

**Interfaces:**
- Consumes: `accounts` (Task 3), `hashPassword`, `isStrongPassword` (Task 4).
- Produces: `registerAccount(db, input): Promise<{ accountId: string }>` where `input = { email, phone?, password, firstName, lastName, country, roles: ("investor"|"porteur")[] }`. Creates the account (`kyc_status=pending`) **and** its wallet in one DB transaction. Throws `WeakPasswordError` / `EmailTakenError`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { withTestDb } from "../../../tests/helpers/db";
import { registerAccount } from "./register";
import { wallets } from "../../db/schema";
import { eq } from "drizzle-orm";

describe("registerAccount", () => {
  it("creates account + wallet, defaults to kyc pending", async () => {
    await withTestDb(async (db) => {
      const { accountId } = await registerAccount(db, {
        email: "k@a.co", password: "Abcdef12", firstName: "Kofi",
        lastName: "A", country: "Togo", roles: ["investor"],
      });
      const w = await db.select().from(wallets).where(eq(wallets.accountId, accountId));
      expect(w).toHaveLength(1);
    });
  });
  it("rejects a weak password", async () => {
    await withTestDb(async (db) => {
      await expect(registerAccount(db, {
        email: "w@a.co", password: "weak", firstName: "W", lastName: "W",
        country: "Togo", roles: ["investor"],
      })).rejects.toThrow();
    });
  });
});
```

- [ ] **Step 2: Add wallet tables to schema and regenerate**

```ts
// append to api/src/db/schema.ts
import { bigint, jsonb } from "drizzle-orm/pg-core";
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
```
Run `npx drizzle-kit generate`. Then run: `cd api && npm test -- register` — Expected: FAIL (register not implemented).

- [ ] **Step 3: Implement register**

```ts
// api/src/modules/accounts/register.ts
import type { Db } from "../../db/client";
import { accounts, wallets } from "../../db/schema";
import { hashPassword, isStrongPassword } from "../auth/password";

export class WeakPasswordError extends Error {}
export type RegisterInput = {
  email: string; phone?: string; password: string;
  firstName: string; lastName: string; country: string;
  roles: ("investor" | "porteur")[];
};

export async function registerAccount(db: Db, input: RegisterInput): Promise<{ accountId: string }> {
  if (!isStrongPassword(input.password)) throw new WeakPasswordError();
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    const [acc] = await tx.insert(accounts).values({
      email: input.email, phone: input.phone, passwordHash,
      firstName: input.firstName, lastName: input.lastName,
      country: input.country, roles: input.roles.length ? input.roles : ["investor"],
    }).returning({ id: accounts.id });
    await tx.insert(wallets).values({ accountId: acc.id });
    return { accountId: acc.id };
  });
}
```

- [ ] **Step 4: Run test** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(api): wallet tables + register account with wallet"`

---

### Task 6: Sessions + auth plugin + password login route

**Files:**
- Modify: `api/src/db/schema.ts` (add `sessions`), regenerate migration
- Create: `api/src/modules/auth/session.ts`, `api/src/lib/http/auth.ts` (Fastify plugin), `api/src/modules/auth/routes.ts`
- Modify: `api/src/app.ts` (register cookie plugin + auth plugin + auth routes)
- Test: `api/tests/auth-login.test.ts`

**Interfaces:**
- Consumes: `accounts`, `verifyPassword`.
- Produces: `createSession(db, accountId, meta): Promise<{ token: string }>`, `resolveSession(db, token): Promise<{ accountId: string } | null>`, `revokeSession(db, token)`, `revokeAllSessions(db, accountId)`. Route `POST /auth/login` sets the session cookie. The auth plugin exposes `request.accountId` and a `requireAuth` preHandler.

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/auth-login.test.ts
import { describe, it, expect } from "vitest";
import { buildTestApp } from "./helpers/app"; // wires buildApp to a test db

describe("POST /auth/login", () => {
  it("logs in with correct password and sets a cookie", async () => {
    const { app, db } = await buildTestApp();
    const { registerAccount } = await import("../src/modules/accounts/register");
    await registerAccount(db, { email: "k@a.co", password: "Abcdef12",
      firstName: "K", lastName: "A", country: "Togo", roles: ["investor"] });
    const res = await app.inject({ method: "POST", url: "/auth/login",
      payload: { identifier: "k@a.co", password: "Abcdef12" } });
    expect(res.statusCode).toBe(200);
    expect(res.cookies.some((c) => c.name === "kpital_sess")).toBe(true);
    await app.close();
  });
  it("rejects wrong password with invalid_credentials", async () => {
    const { app, db } = await buildTestApp();
    const { registerAccount } = await import("../src/modules/accounts/register");
    await registerAccount(db, { email: "k@a.co", password: "Abcdef12",
      firstName: "K", lastName: "A", country: "Togo", roles: ["investor"] });
    const res = await app.inject({ method: "POST", url: "/auth/login",
      payload: { identifier: "k@a.co", password: "nope" } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_credentials");
    await app.close();
  });
});
```
(Add `api/tests/helpers/app.ts` that builds the app against the test db and injects config; fold this helper into this task.)

- [ ] **Step 2: Add sessions table, regenerate, run test (expect fail)**

```ts
// append to schema.ts
export const sessions = pgTable("session", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  tokenHash: text("token_hash").notNull().unique(),
  userAgent: text("user_agent"), ip: text("ip"),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  revokedAt: timestamp("revoked_at"),
});
```
Run `npx drizzle-kit generate`; `npm test -- auth-login` — Expected: FAIL.

- [ ] **Step 3: Implement session service, auth plugin, login route**

```ts
// api/src/modules/auth/session.ts
import { randomBytes, createHash } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import { sessions } from "../../db/schema";
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

export async function createSession(db: Db, accountId: string, meta: { ttlDays: number; userAgent?: string; ip?: string }) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + meta.ttlDays * 864e5);
  await db.insert(sessions).values({ accountId, tokenHash: sha(token), expiresAt, userAgent: meta.userAgent, ip: meta.ip });
  return { token };
}
export async function resolveSession(db: Db, token: string) {
  const [row] = await db.select().from(sessions).where(and(
    eq(sessions.tokenHash, sha(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())));
  return row ? { accountId: row.accountId } : null;
}
export const revokeSession = (db: Db, token: string) =>
  db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.tokenHash, sha(token)));
export const revokeAllSessions = (db: Db, accountId: string) =>
  db.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.accountId, accountId), isNull(sessions.revokedAt)));
```
```ts
// api/src/lib/http/auth.ts
import fp from "fastify-plugin";
import { resolveSession } from "../../modules/auth/session";
export default fp(async (app) => {
  app.decorateRequest("accountId", null);
  app.decorate("requireAuth", async (req: any, reply: any) => {
    const token = req.cookies?.[app.config.sessionCookieName];
    const s = token && (await resolveSession(app.db, token));
    if (!s) return reply.code(401).send({ error: { code: "unauthorized", message: "Login required" } });
    req.accountId = s.accountId;
  });
});
```
`api/src/modules/auth/routes.ts` implements `POST /auth/login`: look up account by email or phone (`identifier`), `verifyPassword`, on success `createSession` and set the cookie (httpOnly, secure, sameSite lax, maxAge from ttl); on failure return `401 { error: { code: "invalid_credentials" } }` (same shape whether the account exists or not). Register `@fastify/cookie`, the auth plugin, and these routes in `app.ts`, and decorate `app.db` / `app.config`.

- [ ] **Step 4: Run test** — Run: `cd api && npm test -- auth-login` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(api): sessions, auth plugin, password login"`

---

### Task 7: Register route (HTTP) + logout + /me

**Files:**
- Modify: `api/src/modules/auth/routes.ts` (add `POST /auth/register`, `POST /auth/logout`, `POST /auth/logout-all`)
- Create: `api/src/modules/accounts/routes.ts` (`GET /me`)
- Modify: `api/src/app.ts`
- Test: `api/tests/auth-register.test.ts`

**Interfaces:**
- Consumes: `registerAccount`, `createSession`, `requireAuth`, `revokeSession`, `revokeAllSessions`.
- Produces: HTTP endpoints. `GET /me` returns `{ id, email, firstName, lastName, roles, kycStatus }`.

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/auth-register.test.ts
import { describe, it, expect } from "vitest";
import { buildTestApp } from "./helpers/app";

describe("register + me", () => {
  it("registers, logs in via cookie, reads /me", async () => {
    const { app } = await buildTestApp();
    const reg = await app.inject({ method: "POST", url: "/auth/register", payload: {
      email: "k@a.co", password: "Abcdef12", firstName: "Kofi", lastName: "A",
      country: "Togo", roles: ["investor"] } });
    expect(reg.statusCode).toBe(201);
    const cookie = reg.cookies.find((c) => c.name === "kpital_sess")!;
    const me = await app.inject({ method: "GET", url: "/me",
      cookies: { kpital_sess: cookie.value } });
    expect(me.json().email).toBe("k@a.co");
    expect(me.json().kycStatus).toBe("pending");
    await app.close();
  });
  it("rejects a weak password with validation_error", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/auth/register", payload: {
      email: "w@a.co", password: "weak", firstName: "W", lastName: "W",
      country: "Togo", roles: ["investor"] } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
```

- [ ] **Step 2: Run test (expect fail)** — Run: `cd api && npm test -- auth-register` — Expected: FAIL.

- [ ] **Step 3: Implement routes**

Add a Fastify JSON body schema for register (email, password, firstName, lastName, country, roles). Handler: call `registerAccount`; on `WeakPasswordError` return `400 { error: { code: "validation_error" } }`; on unique-violation return `409 { error: { code: "email_taken" } }`; on success `createSession` + set cookie + reply `201 { id }`. `POST /auth/logout` calls `revokeSession` on the cookie token and clears the cookie. `POST /auth/logout-all` is behind `requireAuth` and calls `revokeAllSessions(req.accountId)`. `GET /me` (behind `requireAuth`) selects the account and returns the public fields.

- [ ] **Step 4: Run test** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(api): register, logout, /me endpoints"`

---

### Task 8: Notifier layer (channels from NOTIFY_CHANNELS)

**Files:**
- Create: `api/src/lib/notifier/index.ts`, `api/src/lib/notifier/email.ts`, `api/src/lib/notifier/sms.ts`
- Test: `api/src/lib/notifier/notifier.test.ts`

**Interfaces:**
- Produces: `interface Notifier { send(to: Recipient, msg: NotificationMessage): Promise<void> }`, `Recipient = { email?: string; phone?: string }`, `NotificationMessage = { subject: string; body: string }`, and `makeNotifier(channels, providers): Notifier`. A `CaptureProvider` (test fake) records sends.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { makeNotifier, type Channel, type Provider } from "./index";

function capture() {
  const sent: any[] = [];
  const p: Provider = { channel: "email", send: async (to, m) => { sent.push({ to, m }); } };
  return { p, sent };
}

describe("notifier", () => {
  it("only invokes providers for active channels", async () => {
    const email = capture(); const sms = capture(); (sms.p as any).channel = "sms";
    const n = makeNotifier(["email"], [email.p, sms.p]);
    await n.send({ email: "a@b.co", phone: "+228" }, { subject: "s", body: "b" });
    expect(email.sent).toHaveLength(1);
    expect(sms.sent).toHaveLength(0);
  });
  it("fans out when both channels are active", async () => {
    const email = capture(); const sms = capture(); (sms.p as any).channel = "sms";
    const n = makeNotifier(["email", "sms"], [email.p, sms.p]);
    await n.send({ email: "a@b.co", phone: "+228" }, { subject: "s", body: "b" });
    expect(email.sent).toHaveLength(1);
    expect(sms.sent).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test (expect fail)** — Run: `cd api && npm test -- notifier` — Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// api/src/lib/notifier/index.ts
export type Channel = "email" | "sms";
export type Recipient = { email?: string; phone?: string };
export type NotificationMessage = { subject: string; body: string };
export interface Provider { channel: Channel; send(to: Recipient, m: NotificationMessage): Promise<void>; }
export interface Notifier { send(to: Recipient, m: NotificationMessage): Promise<void>; }

export function makeNotifier(channels: Channel[], providers: Provider[]): Notifier {
  const active = providers.filter((p) => channels.includes(p.channel));
  return { async send(to, m) { await Promise.all(active.map((p) => p.send(to, m))); } };
}
```
`email.ts` exports an `EmailProvider` (`channel: "email"`) that logs to console in dev (or sends via SMTP if configured). `sms.ts` exports a stub `SmsProvider` (`channel: "sms"`) that logs. A small factory wires `makeNotifier(config.notifyChannels, [EmailProvider, SmsProvider])`.

- [ ] **Step 4: Run test** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(api): notifier layer driven by NOTIFY_CHANNELS"`

---

### Task 9: OTP service (generate, verify, rate-limit)

**Files:**
- Modify: `api/src/db/schema.ts` (add `otpCodes`), regenerate migration
- Create: `api/src/modules/auth/otp.ts`
- Test: `api/src/modules/auth/otp.test.ts`

**Interfaces:**
- Produces: `issueOtp(db, { accountId, channel, purpose, ttlMinutes }): Promise<{ code: string }>` (returns the clear code for the notifier to send; stores only the hash), `verifyOtp(db, { accountId, purpose, code }): Promise<boolean>` (single-use, expiry, increments `attempts`, caps attempts).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { withTestDb } from "../../../tests/helpers/db";
import { issueOtp, verifyOtp } from "./otp";
import { accounts } from "../../db/schema";

async function acct(db: any) {
  const [a] = await db.insert(accounts).values({ email: "o@a.co", passwordHash: "x",
    firstName: "O", lastName: "A", country: "Togo", roles: ["investor"] }).returning();
  return a.id as string;
}

describe("otp", () => {
  it("verifies a correct fresh code once", async () => {
    await withTestDb(async (db) => {
      const id = await acct(db);
      const { code } = await issueOtp(db, { accountId: id, channel: "email", purpose: "login", ttlMinutes: 10 });
      expect(await verifyOtp(db, { accountId: id, purpose: "login", code })).toBe(true);
      expect(await verifyOtp(db, { accountId: id, purpose: "login", code })).toBe(false); // single use
    });
  });
  it("rejects a wrong code", async () => {
    await withTestDb(async (db) => {
      const id = await acct(db);
      await issueOtp(db, { accountId: id, channel: "email", purpose: "login", ttlMinutes: 10 });
      expect(await verifyOtp(db, { accountId: id, purpose: "login", code: "000000" })).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Add otp table, regenerate, run (expect fail)**

```ts
// append to schema.ts
export const otpChannel = pgEnum("otp_channel", ["email", "sms"]);
export const otpPurpose = pgEnum("otp_purpose", ["login", "password_reset", "verify_contact"]);
import { integer } from "drizzle-orm/pg-core";
export const otpCodes = pgTable("otp_code", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").references(() => accounts.id),
  channel: otpChannel("channel").notNull(),
  purpose: otpPurpose("purpose").notNull(),
  codeHash: text("code_hash").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  attempts: integer("attempts").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
```
Run `npx drizzle-kit generate`; `npm test -- otp` — Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// api/src/modules/auth/otp.ts
import { randomInt, createHash } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import { otpCodes } from "../../db/schema";
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const MAX_ATTEMPTS = 5;

export async function issueOtp(db: Db, p: { accountId: string; channel: "email"|"sms"; purpose: "login"|"password_reset"|"verify_contact"; ttlMinutes: number }) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.insert(otpCodes).values({ accountId: p.accountId, channel: p.channel, purpose: p.purpose,
    codeHash: sha(code), expiresAt: new Date(Date.now() + p.ttlMinutes * 60_000) });
  return { code };
}

export async function verifyOtp(db: Db, p: { accountId: string; purpose: "login"|"password_reset"|"verify_contact"; code: string }) {
  const [row] = await db.select().from(otpCodes).where(and(
    eq(otpCodes.accountId, p.accountId), eq(otpCodes.purpose, p.purpose),
    isNull(otpCodes.consumedAt), gt(otpCodes.expiresAt, new Date()))).orderBy(desc(otpCodes.createdAt)).limit(1);
  if (!row || row.attempts >= MAX_ATTEMPTS) return false;
  if (row.codeHash !== sha(p.code)) {
    await db.update(otpCodes).set({ attempts: row.attempts + 1 }).where(eq(otpCodes.id, row.id));
    return false;
  }
  await db.update(otpCodes).set({ consumedAt: new Date() }).where(eq(otpCodes.id, row.id));
  return true;
}
```

- [ ] **Step 4: Run test** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(api): OTP issue/verify with expiry and attempt cap"`

---

### Task 10: OTP login routes (request + verify) via Notifier

**Files:**
- Modify: `api/src/modules/auth/routes.ts` (`POST /auth/otp/request`, `POST /auth/otp/verify`)
- Modify: `api/src/app.ts` (inject notifier)
- Test: `api/tests/auth-otp.test.ts`

**Interfaces:**
- Consumes: `issueOtp`, `verifyOtp`, `createSession`, `Notifier`, account lookup by identifier.
- Produces: request endpoint that always replies `200 { sent: true }` (anti-enumeration) and, when the account exists, issues an OTP and sends it via the notifier; verify endpoint that on success creates a session cookie.

- [ ] **Step 1: Write the failing test** (inject a capturing notifier through the test app)

```ts
// api/tests/auth-otp.test.ts
import { describe, it, expect } from "vitest";
import { buildTestApp } from "./helpers/app";

describe("otp login", () => {
  it("requests a code, then logs in with it", async () => {
    const { app, sentCodes } = await buildTestApp(); // sentCodes captures notifier output
    const { registerAccount } = await import("../src/modules/accounts/register");
    await registerAccount((app as any).db, { email: "k@a.co", password: "Abcdef12",
      firstName: "K", lastName: "A", country: "Togo", roles: ["investor"] });
    const r = await app.inject({ method: "POST", url: "/auth/otp/request",
      payload: { identifier: "k@a.co", channel: "email" } });
    expect(r.json()).toEqual({ sent: true });
    const code = sentCodes.at(-1);
    const v = await app.inject({ method: "POST", url: "/auth/otp/verify",
      payload: { identifier: "k@a.co", code } });
    expect(v.statusCode).toBe(200);
    expect(v.cookies.some((c) => c.name === "kpital_sess")).toBe(true);
    await app.close();
  });
  it("returns sent:true even for an unknown identifier", async () => {
    const { app } = await buildTestApp();
    const r = await app.inject({ method: "POST", url: "/auth/otp/request",
      payload: { identifier: "nobody@a.co", channel: "email" } });
    expect(r.json()).toEqual({ sent: true });
    await app.close();
  });
});
```
(Extend `buildTestApp` to wire a capturing notifier whose email provider pushes the code into `sentCodes`; fold this into the task.)

- [ ] **Step 2: Run test (expect fail)** — Run: `cd api && npm test -- auth-otp` — Expected: FAIL.

- [ ] **Step 3: Implement routes** — `otp/request`: look up account by identifier; if found, `issueOtp` then `notifier.send` with the code in the body; always reply `{ sent: true }`. `otp/verify`: look up account; `verifyOtp`; on success `createSession` + cookie + `200`; else `401 { error: { code: "otp_invalid" } }`.

- [ ] **Step 4: Run test** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(api): OTP login request/verify via notifier"`

---

### Task 11: Password reset (forgot + reset)

**Files:**
- Modify: `api/src/db/schema.ts` (add `passwordResets`), regenerate
- Create: `api/src/modules/auth/reset.ts`
- Modify: `api/src/modules/auth/routes.ts` (`POST /auth/password/forgot`, `POST /auth/password/reset`)
- Test: `api/tests/auth-reset.test.ts`

**Interfaces:**
- Produces: `issueResetToken(db, accountId): Promise<{ token: string }>` (email link path, hashed at rest, 30-min TTL, single-use), `consumeResetToken(db, token): Promise<string | null>` (returns accountId). Reset also accepts an OTP `purpose=password_reset` for the phone path.

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/auth-reset.test.ts
import { describe, it, expect } from "vitest";
import { buildTestApp } from "./helpers/app";

describe("password reset (email link)", () => {
  it("forgot then reset lets the new password log in", async () => {
    const { app, sentLinks } = await buildTestApp(); // sentLinks captures reset tokens
    const { registerAccount } = await import("../src/modules/accounts/register");
    await registerAccount((app as any).db, { email: "k@a.co", password: "Abcdef12",
      firstName: "K", lastName: "A", country: "Togo", roles: ["investor"] });
    await app.inject({ method: "POST", url: "/auth/password/forgot",
      payload: { identifier: "k@a.co", channel: "email" } });
    const token = sentLinks.at(-1);
    const rr = await app.inject({ method: "POST", url: "/auth/password/reset",
      payload: { token, password: "Newpass12" } });
    expect(rr.statusCode).toBe(200);
    const login = await app.inject({ method: "POST", url: "/auth/login",
      payload: { identifier: "k@a.co", password: "Newpass12" } });
    expect(login.statusCode).toBe(200);
    await app.close();
  });
  it("forgot for unknown identifier still returns sent:true", async () => {
    const { app } = await buildTestApp();
    const r = await app.inject({ method: "POST", url: "/auth/password/forgot",
      payload: { identifier: "no@a.co", channel: "email" } });
    expect(r.json()).toEqual({ sent: true });
    await app.close();
  });
});
```

- [ ] **Step 2: Add table, regenerate, run (expect fail)**

```ts
// append to schema.ts
export const passwordResets = pgTable("password_reset", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
```
Run `npx drizzle-kit generate`; `npm test -- auth-reset` — Expected: FAIL.

- [ ] **Step 3: Implement** — `reset.ts` mirrors the session token pattern (random token, store `sha`, 30-min TTL, `consumeResetToken` checks unexpired + unconsumed and marks consumed). `password/forgot`: look up account; email channel -> `issueResetToken` + notify with a link `${frontUrl}/nouveau-mot-de-passe?token=...`; phone channel -> `issueOtp(purpose="password_reset")` + notify code; always reply `{ sent: true }`. `password/reset`: accept `{ token, password }` (link path) or `{ identifier, code, password }` (phone path); validate strength; on valid token/code, `hashPassword` + update account + `revokeAllSessions`; reply `200`.

- [ ] **Step 4: Run test** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(api): password reset via email link and phone code"`

---

### Task 12: Wallet ledger service + withdraw + PaymentProvider mock

**Files:**
- Create: `api/src/lib/payments/index.ts` (interface + mock), `api/src/modules/wallet/service.ts`, `api/src/modules/wallet/routes.ts`
- Modify: `api/src/app.ts`
- Test: `api/src/modules/wallet/service.test.ts`, `api/tests/wallet-routes.test.ts`

**Interfaces:**
- Produces: `getBalance(db, accountId): Promise<number>`, `listEntries(db, accountId)`, `withdraw(db, payments, { accountId, amountMinor, method }): Promise<{ entryId: string }>` (rejects if amount > balance; writes a negative `withdrawal` entry and calls `payments.payout`). `interface PaymentProvider { payout(p): Promise<{ ok: boolean; ref: string }> }`; `MockPaymentProvider` returns `{ ok: true }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { withTestDb } from "../../../tests/helpers/db";
import { registerAccount } from "../accounts/register";
import { getBalance, credit, withdraw } from "./service";
import { MockPaymentProvider } from "../../lib/payments";

describe("wallet ledger", () => {
  it("balance is the sum of entries; withdraw cannot exceed it", async () => {
    await withTestDb(async (db) => {
      const { accountId } = await registerAccount(db, { email: "w@a.co", password: "Abcdef12",
        firstName: "W", lastName: "A", country: "Togo", roles: ["investor"] });
      await credit(db, { accountId, amountMinor: 230000, type: "repayment", reference: "prj1" });
      expect(await getBalance(db, accountId)).toBe(230000);
      await withdraw(db, new MockPaymentProvider(), { accountId, amountMinor: 100000, method: { type: "tmoney" } });
      expect(await getBalance(db, accountId)).toBe(130000);
      await expect(withdraw(db, new MockPaymentProvider(), { accountId, amountMinor: 999999, method: { type: "tmoney" } }))
        .rejects.toThrow();
    });
  });
});
```

- [ ] **Step 2: Run test (expect fail)** — Run: `cd api && npm test -- wallet` — Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// api/src/lib/payments/index.ts
export interface PaymentProvider { payout(p: { accountId: string; amountMinor: number; method: any }): Promise<{ ok: boolean; ref: string }>; }
export class MockPaymentProvider implements PaymentProvider {
  async payout() { return { ok: true, ref: "mock-" + Date.now() }; }
}
```
```ts
// api/src/modules/wallet/service.ts
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { wallets, walletEntries } from "../../db/schema";
import type { PaymentProvider } from "../../lib/payments";

async function walletId(db: Db, accountId: string) {
  const [w] = await db.select().from(wallets).where(eq(wallets.accountId, accountId));
  if (!w) throw new Error("wallet_not_found");
  return w.id;
}
export async function getBalance(db: Db, accountId: string) {
  const wid = await walletId(db, accountId);
  const [r] = await db.select({ bal: sql<number>`coalesce(sum(${walletEntries.amountMinor}),0)` })
    .from(walletEntries).where(eq(walletEntries.walletId, wid));
  return Number(r.bal);
}
export async function credit(db: Db, p: { accountId: string; amountMinor: number; type: "repayment"|"adjustment"; reference?: string }) {
  const wid = await walletId(db, p.accountId);
  await db.insert(walletEntries).values({ walletId: wid, type: p.type, amountMinor: p.amountMinor, reference: p.reference });
}
export async function withdraw(db: Db, payments: PaymentProvider, p: { accountId: string; amountMinor: number; method: any }) {
  return db.transaction(async (tx) => {
    const bal = await getBalance(tx as unknown as Db, p.accountId);
    if (p.amountMinor <= 0 || p.amountMinor > bal) throw new Error("insufficient_funds");
    const res = await payments.payout({ accountId: p.accountId, amountMinor: p.amountMinor, method: p.method });
    if (!res.ok) throw new Error("payout_failed");
    const wid = await walletId(tx as unknown as Db, p.accountId);
    const [e] = await tx.insert(walletEntries).values({ walletId: wid, type: "withdrawal",
      amountMinor: -p.amountMinor, reference: res.ref }).returning({ id: walletEntries.id });
    return { entryId: e.id };
  });
}
```
`wallet/routes.ts` (behind `requireAuth`): `GET /wallet` returns `{ balance, entries }`; `POST /wallet/withdraw` validates the body and calls `withdraw`, mapping `insufficient_funds` to `400 { error: { code: "insufficient_funds" } }`. Add `api/tests/wallet-routes.test.ts` for the HTTP happy-path + insufficient-funds case.

- [ ] **Step 4: Run tests** — Run: `cd api && npm test -- wallet` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(api): wallet ledger, withdraw, mock payment provider"`

---

### Task 13: Profile, roles, notification preferences

**Files:**
- Modify: `api/src/db/schema.ts` (add `notificationPrefs`, `payoutMethods`), regenerate
- Modify: `api/src/modules/accounts/routes.ts` (`PATCH /me`, `POST /me/roles`, `GET/PATCH /me/notification-pref`, `GET/POST /wallet/payout-methods`)
- Test: `api/tests/me.test.ts`

**Interfaces:**
- Produces: profile update, role addition (append `porteur` to `roles` idempotently — cumulative roles), notification-pref read/update (`channels`, `categories`), payout-method list/add.

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/me.test.ts
import { describe, it, expect } from "vitest";
import { buildTestApp, loginAs } from "./helpers/app"; // loginAs registers + returns a cookie

describe("account self-service", () => {
  it("adds the porteur role idempotently", async () => {
    const { app } = await buildTestApp();
    const cookie = await loginAs(app, "k@a.co");
    await app.inject({ method: "POST", url: "/me/roles",
      cookies: { kpital_sess: cookie }, payload: { role: "porteur" } });
    const me = await app.inject({ method: "GET", url: "/me", cookies: { kpital_sess: cookie } });
    expect(me.json().roles.sort()).toEqual(["investor", "porteur"]);
    await app.close();
  });
});
```

- [ ] **Step 2: Add tables, regenerate, run (expect fail)**

```ts
// append to schema.ts
export const payoutType = pgEnum("payout_type", ["tmoney", "flooz", "bank"]);
export const payoutMethods = pgTable("payout_method", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  type: payoutType("type").notNull(),
  details: jsonb("details").notNull(),
  verified: boolean("verified").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export const notificationPrefs = pgTable("notification_pref", {
  accountId: uuid("account_id").primaryKey().references(() => accounts.id),
  channels: text("channels").array().notNull().default(["email"]),
  categories: jsonb("categories").notNull().default({}),
});
```
Run `npx drizzle-kit generate`; `npm test -- me` — Expected: FAIL.

- [ ] **Step 3: Implement routes** — `POST /me/roles` reads current `roles`, adds the requested role if absent, writes back (idempotent). `PATCH /me` updates allowed profile fields. notification-pref read returns the row (or defaults); update writes `channels`/`categories`. payout-methods list/add operate on `payoutMethods`. All behind `requireAuth`.

- [ ] **Step 4: Run test** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(api): profile, cumulative roles, notification prefs, payout methods"`

---

### Task 14: Admin back-office (guard + routes)

**Files:**
- Create: `api/src/modules/admin/routes.ts`, `api/src/lib/http/require-admin.ts`
- Modify: `api/src/app.ts`
- Test: `api/tests/admin.test.ts`

**Interfaces:**
- Consumes: `requireAuth`, `accounts`, wallet `listEntries`.
- Produces: `requireAdmin` preHandler (403 unless `is_admin`), and `GET /admin/accounts`, `GET /admin/accounts/:id`, `PATCH /admin/accounts/:id` (set `kyc_status` / `status`), `GET /admin/accounts/:id/wallet`.

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/admin.test.ts
import { describe, it, expect } from "vitest";
import { buildTestApp, loginAs } from "./helpers/app";
import { accounts } from "../src/db/schema";
import { eq } from "drizzle-orm";

describe("admin", () => {
  it("blocks non-admins and lets an admin set kyc_status", async () => {
    const { app } = await buildTestApp();
    const userCookie = await loginAs(app, "u@a.co");
    const blocked = await app.inject({ method: "GET", url: "/admin/accounts", cookies: { kpital_sess: userCookie } });
    expect(blocked.statusCode).toBe(403);

    // promote a second account to admin directly, then act as admin
    const adminCookie = await loginAs(app, "admin@a.co");
    const db = (app as any).db;
    await db.update(accounts).set({ isAdmin: true }).where(eq(accounts.email, "admin@a.co"));
    const list = await app.inject({ method: "GET", url: "/admin/accounts", cookies: { kpital_sess: adminCookie } });
    expect(list.statusCode).toBe(200);
    await app.close();
  });
});
```

- [ ] **Step 2: Run test (expect fail)** — Run: `cd api && npm test -- admin` — Expected: FAIL.

- [ ] **Step 3: Implement** — `require-admin.ts`: after `requireAuth`, load the account and 403 unless `isAdmin`. Admin routes: list/search accounts (paginated), read one, patch `kyc_status`/`status`, read a wallet's entries. A sober admin HTML page can be added later; endpoints ship first.

- [ ] **Step 4: Run test** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(api): admin guard and back-office endpoints"`

---

## Post-plan wiring (final task)

### Task 15: CORS, error normalization, rate limiting, README

**Files:**
- Create: `api/src/lib/http/errors.ts` (single `{ error: { code, message, details? } }` serializer via Fastify `setErrorHandler`)
- Modify: `api/src/app.ts` (register `@fastify/cors` restricted to `config.corsOrigin`, `@fastify/rate-limit` on `/auth/*`)
- Create: `api/README.md` (how to run Postgres, migrate, dev, test)
- Test: `api/tests/errors.test.ts` (a thrown domain error becomes the normalized shape; a rate-limited endpoint returns `429 { error: { code: "rate_limited" } }`)

- [ ] **Step 1:** Write the failing test for the normalized error shape and the rate-limit response.
- [ ] **Step 2:** Run (expect fail).
- [ ] **Step 3:** Implement the error handler mapping known domain errors (`insufficient_funds`, `invalid_credentials`, `otp_invalid`, `validation_error`, `email_taken`) to status + code; register CORS + rate-limit; write the README.
- [ ] **Step 4:** Run tests (expect pass), then run the whole suite: `cd api && npm test`.
- [ ] **Step 5:** Commit — `git commit -am "feat(api): cors, error normalization, rate limiting, README"`

---

## Self-review notes

- **Spec coverage:** accounts+roles (T3,T5,T13), password auth+sessions (T4,T6,T7), OTP (T9,T10), reset (T11), wallet ledger + mock payments (T5,T12), notifier/NOTIFY_CHANNELS (T8), admin+kyc_status (T14), security/validation/errors (T6,T7,T15), config/env (T2). KYC document handling is intentionally out of scope (sub-system #2); the Foundation only initializes and exposes `kyc_status`.
- **Boundaries honored:** money is integer minor units; balance always summed from `wallet_entry`; tokens/codes hashed at rest; anti-enumeration on login/otp/forgot; sessions revocable.
- **Ordering:** each task compiles and its tests pass before the next; schema grows additively with a new migration per table-adding task.
