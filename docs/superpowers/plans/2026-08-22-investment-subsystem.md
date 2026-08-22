# Investment Intent Sub-system Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a KYC-verified investor commit a ticket to a `collecting` project (funds mocked), advancing funding progress concurrency-safely and auto-`funded` at target with no overfunding, from either fresh payment or wallet balance.

**Architecture:** Builds on Foundation + KYC + Projects (`api/`, Fastify DI `buildApp({db,config,notifier?,payments?,storage?,verifier?})`, `requireAuth`, `withTestDb`+`buildTestApp`, uniform envelope, wallet ledger, `MockPaymentProvider`, project tables + `FOR UPDATE` patterns). Adds an `investment` table + `project.raised_minor`, a `collectFunds` method on `PaymentProvider`, and the invest flow guarded by a `FOR UPDATE` lock on the project row.

**Tech Stack:** Node/TypeScript/Fastify/Drizzle/Postgres, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-22-investment-design.md`

## Global Constraints

- TypeScript strict, ESM (extensionless imports). HTTP tests use `buildTestApp()`, service tests use `withTestDb`. Run `cd api && npm test` (currently 118 passing) + `npm run typecheck` after each task; keep green.
- Uniform error envelope `{ error: { code, message, details? } }`. New codes: `kyc_required` (403), `below_min_ticket` (400), `exceeds_remaining` (409, `details.remainingMinor`), `payment_failed` (402); reuse `invalid_state` (409), `insufficient_funds` (400).
- Money is integer minor units (FCFA, no sub-unit). `MIN_TICKET_MINOR = 10000`. Timestamps `timestamptz`. New migration per table-adding task.
- Eligibility: invest only when `project.status = "collecting"` AND `account.kyc_status = "verified"`. `investor_account_id`/`accountId` always `req.accountId`, never from the body.
- Concurrency (MONEY-CRITICAL): the whole invest flow is ONE `db.transaction` that FIRST takes a `FOR UPDATE` lock on the `project` row; `remaining = target_minor - raised_minor` is read UNDER that lock; the wallet balance (wallet source) is checked under a `FOR UPDATE` lock on the wallet row; `raised_minor` is incremented and the `funded` transition happens in the same transaction. No overfunding is possible.
- No overfunding: if `amountMinor > remaining` and `confirmCapToRemaining` is not set → `409 exceeds_remaining` (with `remainingMinor`), nothing charged; if set → cap `amountMinor = remaining` and proceed. `funded` when `raised_minor == target_minor`.
- Every task ends green + committed on branch `investment-subsystem` (do not push).

---

### Task 1: Schema — investment table + project.raised_minor + migration

**Files:**
- Modify: `api/src/db/schema.ts` (add `investments` table + enums; add `raisedMinor` to `projects`); regenerate migration
- Test: `api/tests/investment-schema.test.ts`

**Interfaces:**
- Produces: enums `investment_source`(payment|wallet), `investment_status`(confirmed); table `investments`; `projects.raisedMinor` bigint default 0.

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/investment-schema.test.ts
import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db";
import { accounts, projects, investments } from "../src/db/schema";
describe("investment", () => {
  it("records an investment and project has raised_minor default 0", async () => {
    await withTestDb(async (db) => {
      const [a] = await db.insert(accounts).values({ email:"i@a.co", passwordHash:"x",
        firstName:"I", lastName:"A", country:"Togo", roles:["investor"] }).returning();
      const [p] = await db.insert(projects).values({ ownerAccountId: a!.id, category:"commerce",
        title:"P", city:"L", description:"d", targetMinor: 1000000, durationMonths:6,
        roiPct:"16", fundsUsage:"u", cautionType:"a", status:"collecting" }).returning();
      expect(p!.raisedMinor).toBe(0);
      const [inv] = await db.insert(investments).values({ projectId: p!.id, investorAccountId: a!.id,
        amountMinor: 50000, source:"payment", paymentRef:"mock-1" }).returning();
      expect(inv!.status).toBe("confirmed");
    });
  });
});
```

- [ ] **Step 2: Add schema + regenerate, run** `npm test -- investment-schema` → FAIL then implement:

```ts
// append to api/src/db/schema.ts
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
```
Add `raisedMinor: bigint("raised_minor", { mode: "number" }).notNull().default(0)` to the `projects` table definition. Run `npx drizzle-kit generate` (an additive migration adding the enums, the `investment` table, and the `project.raised_minor` column).

- [ ] **Step 3/4:** `npm test -- investment-schema` → PASS.
- [ ] **Step 5: Commit** — `git add api && git commit -m "feat(api): investment table + project.raised_minor + migration"`

---

### Task 2: collectFunds + invest service + POST /projects/:id/invest (the crux)

**Files:**
- Modify: `api/src/lib/payments/index.ts` (add `collectFunds` to `PaymentProvider` + `MockPaymentProvider`)
- Create: `api/src/modules/investments/service.ts`; add the route to `api/src/modules/projects/routes.ts` (or a new `investments/routes.ts` registered in `app.ts`)
- Test: `api/tests/investment-invest.test.ts`

**Interfaces:**
- Consumes: `projects`/`investments`/`accounts`/`wallets`/`walletEntries`, wallet balance helper, `app.payments`, `requireAuth`.
- Produces: `PaymentProvider.collectFunds({accountId, amountMinor, method}): Promise<{ ok: boolean; ref: string }>` (+ mock returning `{ok:true}`); `createInvestment(db, payments, input): Promise<{ investmentId, amountMinor, raisedMinor, projectStatus }>` where `input = { projectId, accountId, amountMinor, source, method?, confirmCapToRemaining? }`, throwing the typed errors below; `POST /projects/:id/invest`.

- [ ] **Step 1: Write the failing test** (buildTestApp + loginAs; seed a collecting project + a KYC-verified account)

```ts
// api/tests/investment-invest.test.ts (excerpt)
it("invests via payment on a collecting project and advances raised_minor", async () => {
  const { app, db } = await buildTestApp();
  const cookie = await loginAs(app, "i@a.co");
  await db.update(accounts).set({ kycStatus:"verified" }).where(eq(accounts.email,"i@a.co"));
  const [owner] = await db.insert(accounts).values({ email:"o@a.co", passwordHash:"x", firstName:"O", lastName:"A", country:"Togo", roles:["porteur"] }).returning();
  const [p] = await db.insert(projects).values({ ownerAccountId: owner!.id, category:"commerce", title:"P", city:"L", description:"d", targetMinor:1000000, durationMonths:6, roiPct:"16", fundsUsage:"u", cautionType:"a", status:"collecting" }).returning();
  const r = await app.inject({ method:"POST", url:`/projects/${p!.id}/invest`, cookies:{kpital_sess:cookie},
    payload:{ amountMinor: 50000, source:"payment" } });
  expect(r.statusCode).toBe(201);
  expect(r.json().raisedMinor).toBe(50000);
});
it("blocks a non-verified account", async () => { /* kycStatus pending → 403 kyc_required */ });
it("rejects over-remaining without confirm, caps with confirm", async () => {
  /* target 1_000_000, invest 900_000 first, then invest 200_000 without confirm → 409 exceeds_remaining remaining=100_000;
     re-invest with confirmCapToRemaining:true → 201 amountMinor=100_000, raisedMinor=1_000_000, projectStatus="funded";
     a further invest → 409 invalid_state (no longer collecting) */
});
it("invests from wallet balance (reinvestment) and rejects insufficient", async () => {
  /* credit the wallet 60000; invest source:"wallet" 50000 → 201 + a reinvestment wallet_entry of -50000, balance 10000;
     invest wallet 999999 → 400 insufficient_funds */
});
```

- [ ] **Step 2:** `npm test -- investment-invest` → FAIL.

- [ ] **Step 3: Implement.**
  - `payments/index.ts`: add `collectFunds({accountId, amountMinor, method}): Promise<{ok, ref}>` to the interface; `MockPaymentProvider.collectFunds` returns `{ ok: true, ref: "mock-collect-" + <counter> }`.
  - `service.ts` `createInvestment` — export typed errors `KycRequiredError`, `NotCollectingError`, `BelowMinTicketError`, `ExceedsRemainingError(remainingMinor)`, `InsufficientFundsError` (reuse the wallet one), `PaymentFailedError`. In ONE `db.transaction`:
    1. load the account's `kyc_status`; if ≠ "verified" → throw `KycRequiredError`.
    2. `SELECT ... FOR UPDATE` the project row; if status ≠ "collecting" → `NotCollectingError`.
    3. `remaining = targetMinor - raisedMinor`. if `amountMinor < MIN_TICKET_MINOR` → `BelowMinTicketError`. if `amountMinor > remaining`: if `!confirmCapToRemaining` → `ExceedsRemainingError(remaining)`; else `amountMinor = remaining`.
    4. mint `investmentId = randomUUID()`. if source==="wallet": lock the wallet row FOR UPDATE, compute balance (SUM under lock), if `< amountMinor` → `InsufficientFundsError`, insert `walletEntries(type:"reinvestment", amountMinor: -amountMinor, reference: investmentId)`; if source==="payment": `const res = await payments.collectFunds({accountId, amountMinor, method})`; if `!res.ok` → `PaymentFailedError`; `paymentRef = res.ref`.
    5. insert `investments(id=investmentId, projectId, investorAccountId=accountId, amountMinor, source, paymentRef, status:"confirmed")`.
    6. `newRaised = raisedMinor + amountMinor`; update `projects set raisedMinor = newRaised, status = (newRaised === targetMinor ? "funded" : status)`.
    7. return `{ investmentId, amountMinor, raisedMinor: newRaised, projectStatus }`.
  - Route `POST /projects/:id/invest` (requireAuth): validate the body (amountMinor positive int, source ∈ {payment, wallet}), call `createInvestment(app.db, app.payments, {...accountId: req.accountId})`, map errors → the status codes in Global Constraints (`ExceedsRemainingError` → `409 { error:{ code:"exceeds_remaining", message, details:{ remainingMinor } } }`).

- [ ] **Step 4:** `npm test -- investment-invest` → PASS (+ full suite green + typecheck).
- [ ] **Step 5: Commit** — `git add api && git commit -m "feat(api): invest endpoint with KYC gate, two sources, anti-overfund, auto-funded"`

---

### Task 3: GET /me/investments

**Files:**
- Modify: `api/src/modules/investments/service.ts` (`listMyInvestments`) + the routes file (add `GET /me/investments`)
- Test: `api/tests/investment-mine.test.ts`

**Interfaces:**
- Produces: `GET /me/investments` (requireAuth) → `{ investments: [{ id, amountMinor, source, createdAt, project: { id, title, category, status, roiPct } }] }` for the caller (join a project summary; NEVER the project owner PII or private fields).

- [ ] **Step 1: Write the failing test**

```ts
it("lists my investments with a project summary", async () => {
  const { app, db } = await buildTestApp();
  const cookie = await loginAs(app, "i@a.co");
  await db.update(accounts).set({ kycStatus:"verified" }).where(eq(accounts.email,"i@a.co"));
  // seed a collecting project, invest 50000 via payment (reuse the invest route) ...
  const mine = await app.inject({ method:"GET", url:"/me/investments", cookies:{kpital_sess:cookie} });
  expect(mine.statusCode).toBe(200);
  expect(mine.json().investments[0].amountMinor).toBe(50000);
  expect(mine.json().investments[0].project.title).toBeTruthy();
  expect(mine.json().investments[0].project).not.toHaveProperty("ownerAccountId");
});
```

- [ ] **Step 2:** `npm test -- investment-mine` → FAIL.
- [ ] **Step 3: Implement** `listMyInvestments(db, accountId)` — select the caller's `investments` joined to a projected project summary (id, title, category, status, roiPct — NOT ownerAccountId/private fields), ordered by `createdAt desc`, tiebreak `id`. Route returns `{ investments }`.
- [ ] **Step 4:** `npm test -- investment-mine` → PASS.
- [ ] **Step 5: Commit** — `git add api && git commit -m "feat(api): GET /me/investments"`

---

### Task 4: Funding progress — raisedMinor on funding surface + detail

**Files:**
- Modify: `api/src/modules/projects/service.ts` (`FUNDING_PROJECT_COLUMNS` + `PUBLIC_PROJECT_COLUMNS` add `raisedMinor`)
- Test: `api/tests/investment-progress.test.ts`

**Interfaces:**
- Produces: `raisedMinor` present on `/projects/funding` items and on `GET /projects/:id` for public projects (so the front can render `raised/target`). Still NO `upvoteCount`/`followCount` on the funding surface.

- [ ] **Step 1: Write the failing test**

```ts
it("funding surface and detail expose raisedMinor", async () => {
  const { app, db } = await buildTestApp();
  const [owner] = await db.insert(accounts).values({ email:"o@a.co", passwordHash:"x", firstName:"O", lastName:"A", country:"Togo", roles:["porteur"] }).returning();
  const [p] = await db.insert(projects).values({ ownerAccountId: owner!.id, category:"commerce", title:"P", city:"L", description:"d", targetMinor:1000000, durationMonths:6, roiPct:"16", fundsUsage:"u", cautionType:"a", status:"collecting", raisedMinor: 250000 }).returning();
  const fu = await app.inject({ method:"GET", url:"/projects/funding" });
  const card = fu.json().projects.find((x:any)=>x.id===p!.id);
  expect(card.raisedMinor).toBe(250000);
  expect(card).not.toHaveProperty("upvoteCount");
  const det = await app.inject({ method:"GET", url:`/projects/${p!.id}` });
  expect(det.json().project.raisedMinor).toBe(250000);
});
```

- [ ] **Step 2:** `npm test -- investment-progress` → FAIL.
- [ ] **Step 3: Implement** — add `raisedMinor: projects.raisedMinor` to BOTH `PUBLIC_PROJECT_COLUMNS` (used by showcase + detail) and `FUNDING_PROJECT_COLUMNS`. (Funding still omits `upvoteCount`/`followCount`.) The showcase surface carrying `raisedMinor` is harmless (0 for showcase projects).
- [ ] **Step 4:** `npm test -- investment-progress` → PASS (+ full suite green + typecheck).
- [ ] **Step 5: Commit** — `git add api && git commit -m "feat(api): expose raised_minor funding progress on public surfaces"`

---

## Self-review notes

- **Spec coverage:** schema+raised_minor+migration (T1); collectFunds + invest flow with KYC gate, two sources, exceeds_remaining/confirmCap, FOR-UPDATE concurrency, auto-funded (T2); GET /me/investments (T3); raisedMinor progress on funding+detail (T4). Security/integrity (accountId from session, KYC gate, FOR UPDATE anti-overfund + anti-overdraw, atomic transaction) lands in T2.
- **Deferred (spec §1, #5):** real payment/escrow, escrow states, repayment lifecycle, collection-failure refunds.
- **Ordering:** each task green before the next; T1 is the only migration; T2 is the money-critical crux (review it hardest).
