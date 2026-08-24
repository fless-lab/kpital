# Repayment Sub-system Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a project funds and its escrow is released to the porteur (#5), let the porteur repay principal + ROI in monthly installments via the mocked provider, distributing each settled installment pro-rata to investors' wallets, until the project is fully repaid and closed.

**Architecture:** Builds on Escrow (#5). At the end of `releaseProject` (once all escrow is released), `startRepayment` flips `funded -> repaying` and generates a fixed installment schedule. The porteur pays the next `due` installment via a new two-phase `initiateRepayment` provider call (async-ready like the escrow deposit); a settled installment is distributed pro-rata to investors (credit `repayment` wallet entries), gated idempotently by a `UNIQUE(installment_id, investment_id)` distribution table; the project moves to `closed` when every installment is `paid`. All money-movement crosses only the provider seam; distribution runs outside long locks in resumable per-investor transactions.

**Tech Stack:** Node/TypeScript/Fastify/Drizzle/Postgres, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-24-repayment-design.md`

## Global Constraints

- TypeScript strict, ESM (extensionless imports). HTTP tests use `buildTestApp()`, service tests use `withTestDb`. Run `cd api && npm test` (currently 167 passing) + `npm run typecheck` after each task; keep green. NEVER run two suite-executing processes against the shared `kpital_test` DB at once.
- Uniform error envelope `{ error: { code, message, details? } }`. New codes: `repayment_failed` (402); reuse `invalid_state` (409), `forbidden` (403), `not_found` (404), `unauthorized` (401), `validation_error` (400).
- Money is integer minor units (FCFA, no sub-unit). `total_owed = round(raised_minor * (1 + Number(roiPct)/100))`. Timestamps `timestamptz`. New migration per table-adding task.
- NO em dashes anywhere in code, comments, strings, or docs (house style). Use commas, parentheses, colons.
- Concurrency / money integrity: a settled installment is distributed exactly once per (installment, investment) via the `UNIQUE(installment_id, investment_id)` guard; distribution runs in per-investor short transactions (no network I/O under a long lock), resumable and idempotent (replay re-runs, skips already-credited, re-marks paid, re-checks close). `initiateRepayment` uses idempotency key `repay:<installmentId>`. The distribution set is frozen (project funded, all investments released).
- Investor set base: `p_i = investment.amount_minor`, `R = raised_minor`. Pro-rata `share_i = floor(A * p_i / R)`, remainder assigned one unit at a time by largest fractional remainder, tiebreak `investment.id`, so `sum(share_i) = A` exactly.
- accountId is ALWAYS `req.accountId`; `POST /repay` verifies the caller owns the project. The webhook acts only via `repaymentRef`, never a body accountId.
- Every task ends green + committed on branch `repayment-subsystem` (do NOT push). Implementers OPUS. Reviewers sonnet EXCEPT Task 3 (touches the #5 release money path) and Task 4 (distribution money crux) = OPUS reviewer; final whole-branch review = opus.

---

### Task 1: Schema and migration (installment + distribution tables)

**Files:**
- Modify: `api/src/db/schema.ts`
- Create (generated): `api/drizzle/0013_*.sql` (+ meta snapshot)
- Test: `api/tests/repayment-schema.test.ts`

**Interfaces:**
- Produces: enum `repayment_installment_status` (`due`|`pending`|`paid`); table `repayment_installment` (id, project_id fk, seq int, amount_minor bigint, due_at timestamptz, status default `due`, repayment_ref text null, settled_at timestamptz null, created_at); table `repayment_distribution` (id, installment_id fk, investment_id fk, amount_minor bigint, created_at) with `UNIQUE(installment_id, investment_id)`.

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/repayment-schema.test.ts
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "./helpers/db";
import { accounts, projects, investments, repaymentInstallments, repaymentDistributions } from "../src/db/schema";

describe("repayment schema", () => {
  it("records an installment schedule and a distribution with a unique guard", async () => {
    await withTestDb(async (db) => {
      const [owner] = await db.insert(accounts).values({ email: "o@a.co", passwordHash: "x",
        firstName: "O", lastName: "A", country: "Togo", roles: ["porteur"] }).returning();
      const [inv0] = await db.insert(accounts).values({ email: "i@a.co", passwordHash: "x",
        firstName: "I", lastName: "A", country: "Togo", roles: ["investor"] }).returning();
      const [p] = await db.insert(projects).values({ ownerAccountId: owner!.id, category: "commerce",
        title: "P", city: "L", description: "d", targetMinor: 1000000, durationMonths: 6, roiPct: "16",
        fundsUsage: "u", cautionType: "a", status: "repaying", raisedMinor: 1000000 }).returning();
      const [inv] = await db.insert(investments).values({ projectId: p!.id, investorAccountId: inv0!.id,
        amountMinor: 1000000, source: "payment", paymentRef: "d1", status: "released" }).returning();
      const [ins] = await db.insert(repaymentInstallments).values({ projectId: p!.id, seq: 1,
        amountMinor: 193333, dueAt: new Date(), status: "due" }).returning();
      expect(ins!.status).toBe("due");
      const [dist] = await db.insert(repaymentDistributions).values({ installmentId: ins!.id,
        investmentId: inv!.id, amountMinor: 193333 }).returning();
      expect(dist!.amountMinor).toBe(193333);
      // The unique guard blocks a second distribution for the same (installment, investment).
      await expect(
        db.insert(repaymentDistributions).values({ installmentId: ins!.id, investmentId: inv!.id, amountMinor: 1 }),
      ).rejects.toThrow();
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails** - `cd api && npm test -- repayment-schema` -> FAIL.

- [ ] **Step 3: Add to `schema.ts`** (near the investment tables). Ensure `uniqueIndex` is imported (it already is from the #5 hardening):

```ts
export const repaymentInstallmentStatus = pgEnum("repayment_installment_status", ["due", "pending", "paid"]);
export const repaymentInstallments = pgTable("repayment_installment", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  seq: integer("seq").notNull(),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  status: repaymentInstallmentStatus("status").notNull().default("due"),
  repaymentRef: text("repayment_ref"),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const repaymentDistributions = pgTable("repayment_distribution", {
  id: uuid("id").defaultRandom().primaryKey(),
  installmentId: uuid("installment_id").notNull().references(() => repaymentInstallments.id),
  investmentId: uuid("investment_id").notNull().references(() => investments.id),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  perInvestmentUnique: uniqueIndex("repayment_distribution_installment_investment_unique")
    .on(t.installmentId, t.investmentId),
}));
```

- [ ] **Step 4: Generate the migration** - `cd api && DATABASE_URL="postgres://kpital:kpital@127.0.0.1:5544/kpital" npx drizzle-kit generate` (additive: one enum, two tables, one unique index). Inspect the SQL is purely `CREATE TYPE` / `CREATE TABLE` / `CREATE UNIQUE INDEX`.

- [ ] **Step 5: Run to verify it passes** - `cd api && npm test -- repayment-schema` -> PASS.
- [ ] **Step 6: Full suite + typecheck** - `cd api && npm test` (all green; additive) + `npm run typecheck`.
- [ ] **Step 7: Commit** - `git add api && git commit -m "feat(api): repayment installment + distribution schema (migration 0013)"`

---

### Task 2: initiateRepayment on the provider

**Files:**
- Modify: `api/src/lib/payments/index.ts`
- Test: `api/tests/repayment-provider.test.ts`

**Interfaces:**
- Produces on `PaymentProvider`: `initiateRepayment(p: RepaymentRequest): Promise<RepaymentResult>` where `RepaymentRequest = { payerAccountId: string; amountMinor: number; idempotencyKey: string }` and `RepaymentResult = { ok: boolean; ref: string; status: "pending" | "settled" }`. `MockPaymentProvider` implements it with a settable `repaymentMode: "settled" | "pending"` (default `"settled"`), reusing the existing `memo` map, refs `mock-repay-N`.

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/repayment-provider.test.ts
import { describe, it, expect } from "vitest";
import { MockPaymentProvider } from "../src/lib/payments";

describe("MockPaymentProvider.initiateRepayment", () => {
  it("settles by default, supports pending mode, and is idempotent per key", async () => {
    const p = new MockPaymentProvider();
    const r1 = await p.initiateRepayment({ payerAccountId: "o", amountMinor: 50000, idempotencyKey: "repay:x" });
    expect(r1.ok).toBe(true);
    expect(r1.status).toBe("settled");
    expect(r1.ref).toMatch(/^mock-repay-\d+$/);
    const r2 = await p.initiateRepayment({ payerAccountId: "o", amountMinor: 50000, idempotencyKey: "repay:x" });
    expect(r2.ref).toBe(r1.ref); // replay: same ref, no new movement
    const q = new MockPaymentProvider();
    q.repaymentMode = "pending";
    expect((await q.initiateRepayment({ payerAccountId: "o", amountMinor: 1, idempotencyKey: "repay:y" })).status).toBe("pending");
  });
});
```

- [ ] **Step 2: Run to verify it fails** - `cd api && npm test -- repayment-provider` -> FAIL.

- [ ] **Step 3: Implement** in `payments/index.ts`: add the types and the interface method:

```ts
export interface RepaymentRequest { payerAccountId: string; amountMinor: number; idempotencyKey: string; }
export interface RepaymentResult { ok: boolean; ref: string; status: "pending" | "settled"; }
```
Add `initiateRepayment(p: RepaymentRequest): Promise<RepaymentResult>;` to `PaymentProvider`. In `MockPaymentProvider` add `repaymentMode: "settled" | "pending" = "settled";` and a `private repaySeq = 0;`, then:
```ts
  async initiateRepayment(p: RepaymentRequest): Promise<RepaymentResult> {
    const prior = this.memo.get(p.idempotencyKey);
    if (prior) return { ok: true, ref: prior.ref, status: prior.status ?? "settled" };
    this.repaySeq += 1;
    const ref = `mock-repay-${this.repaySeq}`;
    this.memo.set(p.idempotencyKey, { ref, status: this.repaymentMode });
    return { ok: true, ref, status: this.repaymentMode };
  }
```
Adding a method to `PaymentProvider` will break typecheck in the inline `: PaymentProvider` test stubs. Grep `grep -rn ": PaymentProvider" api/tests` and add an `initiateRepayment` returning a placeholder (`{ ok: false, ref: "", status: "settled" }`) to each, matching how the #5 escrow methods were stubbed.

- [ ] **Step 4: Run to verify it passes** - `cd api && npm test -- repayment-provider` -> PASS.
- [ ] **Step 5: Full suite + typecheck** - green + clean.
- [ ] **Step 6: Commit** - `git add api && git commit -m "feat(api): initiateRepayment provider method"`

---

### Task 3: startRepayment + schedule generation + releaseProject hook [touches #5 money path, opus reviewer]

**Files:**
- Create: `api/src/modules/repayment/service.ts` (`startRepayment`, `generateSchedule`)
- Modify: `api/src/modules/escrow/service.ts` (call `startRepayment` at the end of `releaseProject`)
- Modify (test updates): `api/tests/escrow-settle.test.ts` and any #5 test asserting a project stays `"funded"` after a fully-released funding
- Test: `api/tests/repayment-start.test.ts`

**Interfaces:**
- Consumes: `projects`, `investments`, `repaymentInstallments` (Task 1), `Db`.
- Produces: `startRepayment(db: Db, args: { projectId: string }): Promise<void>` - if the project is `funded` AND no investment of it is still `escrowed` (release complete), guarded `funded -> repaying` and, when that changed the row, generate the schedule. No-op otherwise (stragglers remain, or already repaying/closed). `generateSchedule(tx, project)` inserts N = `durationMonths` installments, `seq` 1..N, `due_at = now + seq months`, `amount_minor = floor(total_owed / N)` with the LAST installment = `total_owed - (N-1)*floor` (absorbs the rounding remainder), where `total_owed = Math.round(raised_minor * (1 + Number(roiPct)/100))`.

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/repayment-start.test.ts
import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "./helpers/db";
import { accounts, projects, investments, wallets, repaymentInstallments } from "../src/db/schema";
import { startRepayment } from "../src/modules/repayment/service";

async function seedFunded(db: any, opts: { withEscrowedStraggler?: boolean } = {}) {
  const [owner] = await db.insert(accounts).values({ email: "o@a.co", passwordHash: "x", firstName: "O", lastName: "A", country: "Togo", roles: ["porteur"] }).returning();
  const [i1] = await db.insert(accounts).values({ email: "i@a.co", passwordHash: "x", firstName: "I", lastName: "A", country: "Togo", roles: ["investor"] }).returning();
  await db.insert(wallets).values({ accountId: owner.id });
  const [p] = await db.insert(projects).values({ ownerAccountId: owner.id, category: "commerce", title: "P", city: "L", description: "d", targetMinor: 1000000, durationMonths: 6, roiPct: "16", fundsUsage: "u", cautionType: "a", status: "funded", raisedMinor: 1000000 }).returning();
  await db.insert(investments).values({ projectId: p.id, investorAccountId: i1.id, amountMinor: 1000000, source: "payment", paymentRef: "d1", status: opts.withEscrowedStraggler ? "escrowed" : "released" });
  return p.id;
}

describe("startRepayment", () => {
  it("flips funded->repaying and generates the schedule once release is complete", async () => {
    await withTestDb(async (db) => {
      const pid = await seedFunded(db);
      await startRepayment(db, { projectId: pid });
      const [p] = await db.select().from(projects).where(eq(projects.id, pid));
      expect(p!.status).toBe("repaying");
      const installments = await db.select().from(repaymentInstallments).where(eq(repaymentInstallments.projectId, pid));
      expect(installments).toHaveLength(6); // durationMonths
      const total = installments.reduce((s: number, r: any) => s + r.amountMinor, 0);
      expect(total).toBe(1160000); // round(1_000_000 * 1.16)
      // idempotent: a second call does not duplicate the schedule
      await startRepayment(db, { projectId: pid });
      const again = await db.select().from(repaymentInstallments).where(eq(repaymentInstallments.projectId, pid));
      expect(again).toHaveLength(6);
    });
  });

  it("does NOT flip while an escrowed straggler remains (partial release)", async () => {
    await withTestDb(async (db) => {
      const pid = await seedFunded(db, { withEscrowedStraggler: true });
      await startRepayment(db, { projectId: pid });
      const [p] = await db.select().from(projects).where(eq(projects.id, pid));
      expect(p!.status).toBe("funded"); // still funded; release not complete
      const installments = await db.select().from(repaymentInstallments).where(eq(repaymentInstallments.projectId, pid));
      expect(installments).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails** - `cd api && npm test -- repayment-start` -> FAIL.

- [ ] **Step 3: Implement `repayment/service.ts`.**
  - `startRepayment(db, { projectId })`: in a `db.transaction`, lock the project row `.for("update")`; if `project.status !== "funded"` return. Count investments of the project with `status = "escrowed"`; if any remain, return (release not complete). Guarded update `funded -> repaying` (`WHERE id = ? AND status = "funded"`); if it changed a row, call `generateSchedule(tx, project)`.
  - `generateSchedule(tx, project)`: `const N = project.durationMonths; const totalOwed = Math.round(project.raisedMinor * (1 + Number(project.roiPct) / 100)); const base = Math.floor(totalOwed / N);` Build N rows: for `seq` 1..N, `amountMinor = seq < N ? base : totalOwed - base * (N - 1)`, `dueAt = addMonths(new Date(), seq)`. Insert all. Provide a local `addMonths(d: Date, n: number): Date` helper (`const x = new Date(d); x.setMonth(x.getMonth() + n); return x;`).
  - Export `startRepayment` (and `generateSchedule` if useful for tests).
  - In `escrow/service.ts` `releaseProject`: at the very END of the function (after the `for` loop over escrowed investments), add `await startRepayment(db, { projectId: args.projectId });`. Import `startRepayment` from `../repayment/service`. (This is a one-way runtime dependency escrow -> repayment; repayment/service must NOT import from escrow/service, to avoid a cycle. It only needs schema + db.)

- [ ] **Step 4: Run to verify it passes** - `cd api && npm test -- repayment-start` -> PASS.

- [ ] **Step 5: Fix the now-repaying #5 tests.** Hooking `startRepayment` means a fully-released funded project (porteur wallet present, all investments released) now ends in `repaying`, not `funded`. Run `cd api && npm test` and update ONLY the assertions that break for this reason:
  - `api/tests/escrow-settle.test.ts` "settling the final ticket funds the project and releases escrow to the porteur wallet": the project status assertion changes from `"funded"` to `"repaying"` (the investment `"released"` assertion stays). 
  - Any other test where a project is funded AND its escrow fully releases (porteur wallet seeded) and it asserts `status === "funded"`: change to `"repaying"`.
  - Do NOT change tests where release does NOT complete (e.g. auto-fund tests that seed no porteur wallet, so `releaseProject` cannot disburse and `startRepayment` correctly leaves the project `funded`) - those keep asserting `"funded"`. Verify by reading each failing assertion's setup before editing.

- [ ] **Step 6: Full suite + typecheck** - `cd api && npm test` all green + `npm run typecheck` clean.
- [ ] **Step 7: Commit** - `git add api && git commit -m "feat(api): startRepayment + schedule generation, hooked at release completion"`

---

### Task 4: settleRepayment (pro-rata distribution) [MONEY CRUX, opus reviewer]

**Files:**
- Modify: `api/src/modules/repayment/service.ts` (`settleRepayment`, `failRepaymentSettlement`, and a `repayKey` helper)
- Test: `api/tests/repayment-settle.test.ts`

**Interfaces:**
- Produces:
  - `repayKey(installmentId: string): string` returning `` `repay:${installmentId}` ``.
  - `settleRepayment(db: Db, args: { installmentId: string }): Promise<void>` - distributes the installment amount pro-rata to the project's investors (frozen set), idempotent and resumable, then marks the installment `paid` and closes the project if all installments are `paid`.
  - `failRepaymentSettlement(db: Db, args: { installmentId: string }): Promise<void>` - guarded `pending -> due` (retryable), distributes nothing.
  - A lookup helper `findInstallmentByRef(db, repaymentRef)` used by the webhook (Task 6) OR the webhook selects directly; either is fine, keep it in this module.

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/repayment-settle.test.ts (excerpt - the implementer writes the full seeding)
it("distributes an installment pro-rata to investors and marks it paid", async () => {
  await withTestDb(async (db) => {
    // seed a repaying project with raised 1_000_000 across 3 investors (500k/300k/200k),
    // all investments 'released'; one 'pending' installment amount 100_000 with repaymentRef 'r1'.
    await settleRepayment(db, { installmentId });
    // each investor's repayment wallet entry = floor(100000 * p_i / 1_000_000) + largest-remainder unit(s);
    // sum of credits == 100000 exactly; installment now 'paid'.
  });
});
it("is idempotent: replaying settle distributes exactly once", async () => { /* re-run -> unique guard skips; sum unchanged; one wallet entry per investor */ });
it("closes the project when the last installment is paid", async () => { /* settle all -> project 'closed' */ });
it("failRepaymentSettlement resets pending->due and distributes nothing", async () => { /* -> due, zero distributions */ });
```

- [ ] **Step 2: Run to verify it fails** - `cd api && npm test -- repayment-settle` -> FAIL.

- [ ] **Step 3: Implement.** Study `releaseProject` in `escrow/service.ts` for the per-item-short-transaction + guarded-transition + try/catch-continue idioms and mirror them.
  - `settleRepayment(db, { installmentId })`:
    1. Load the installment; if not found or `status === "paid"`, still run the close-check at the end but do not re-distribute against a wrong amount (if `paid`, distribution rows already exist; re-running is safe via the unique guard). Load its `projectId` and `amountMinor` (A).
    2. Load `raisedMinor` (R) from the project and all investments of the project (id, amountMinor) as the frozen investor set.
    3. Compute `share_i = Math.floor(A * p_i / R)` for each; `remainder = A - sum(share_i)`; sort investors by fractional part `(A * p_i) % R` descending, tiebreak `investment.id` ascending; give one extra unit to the first `remainder` of them. Now `sum(share_i) === A`.
    4. For EACH investor with `share_i > 0`, in its OWN `db.transaction` wrapped in try/catch (log + continue): `insert repaymentDistributions({ installmentId, investmentId, amountMinor: share_i })` using `.onConflictDoNothing()`; check whether a row was inserted (`.returning()` empty means it already existed -> skip the credit); if inserted, find the investor wallet (`wallets WHERE accountId = investment.investorAccountId`) and `insert walletEntries({ walletId, type: "repayment", amountMinor: +share_i, reference: <distribution id or installmentId:investmentId> })`. The distribution insert and the wallet credit MUST be in the same transaction so they commit together.
    5. After the loop: guarded `UPDATE repayment_installment SET status='paid', settledAt=now() WHERE id=? AND status='pending'`. Then load all installments of the project; if every one is `paid`, guarded `UPDATE project SET status='closed' WHERE id=? AND status='repaying'`.
  - `failRepaymentSettlement(db, { installmentId })`: guarded `UPDATE repayment_installment SET status='due' WHERE id=? AND status='pending'`. Distributes nothing.
  - `repayKey(installmentId)` returns `` `repay:${installmentId}` ``.

- [ ] **Step 4: Run to verify it passes** - `cd api && npm test -- repayment-settle` -> PASS.
- [ ] **Step 5: Full suite + typecheck** - green + clean.
- [ ] **Step 6: Commit** - `git add api && git commit -m "feat(api): settleRepayment pro-rata distribution (idempotent, resumable)"`

---

### Task 5: POST /projects/:id/repay (porteur, two-phase)

**Files:**
- Create: `api/src/modules/repayment/routes.ts` (registers `POST /projects/:id/repay`)
- Modify: `api/src/app.ts` (register `repaymentRoutes`)
- Test: `api/tests/repayment-repay.test.ts`

**Interfaces:**
- Consumes: `initiateRepayment` (Task 2), `settleRepayment` (Task 4), `repayKey`.
- Produces: `POST /projects/:id/repay` (requireAuth + owner) -> `201 { installmentId, seq, amountMinor, status: "pending"|"paid", projectStatus }`.

- [ ] **Step 1: Write the failing test** (`buildTestApp` + `loginAs`; seed a repaying project with a schedule by funding it end to end OR by direct inserts):

```ts
it("pays the next due installment; settled mock distributes immediately", async () => {
  // owner logs in; project 'repaying' with due installments; POST /projects/:id/repay
  // -> 201 status 'paid', investors credited, installment 'paid'.
});
it("returns 402 repayment_failed and leaves the installment due when the provider declines", async () => {
  // inject a provider whose initiateRepayment returns { ok:false } -> 402, installment still 'due', nothing distributed.
});
it("pending mode returns status pending and distributes nothing", async () => { /* repaymentMode='pending' */ });
it("rejects a non-owner with 403 and a non-repaying project with 409", async () => {});
it("rejects when there is nothing left to pay with 409", async () => {});
```

- [ ] **Step 2: Run to verify it fails** - `cd api && npm test -- repayment-repay` -> FAIL.

- [ ] **Step 3: Implement the route** (mirror `investments/routes.ts` UUID validation + owner-check + error mapping):
  - Validate `:id` is a UUID (else 404). Load the project; if not found -> 404; if `ownerAccountId !== req.accountId` -> 403 forbidden; if `status !== "repaying"` -> 409 invalid_state.
  - In a `db.transaction` locking the target installment row: find the lowest-`seq` non-`paid` installment (`ORDER BY seq`); if none -> 409 invalid_state; if it is already `pending` -> 409 invalid_state (a settlement is in flight); else it is `due`, guarded `due -> pending`.
  - Call `initiateRepayment({ payerAccountId: project.ownerAccountId, amountMinor: installment.amountMinor, idempotencyKey: repayKey(installmentId) })`. If `!ok`, throw so the transaction rolls the `due -> pending` back (installment returns to `due`), and map to `402 repayment_failed`. Else set `repayment_ref` and commit.
  - After commit: if `status === "settled"`, `await settleRepayment(db, { installmentId })`. Read back the installment + project status. Respond `201 { installmentId, seq, amountMinor, status: (settled ? "paid" : "pending"), projectStatus }` (read the ACTUAL installment status for the settled case, in case of a concurrent close).
  - Register `app.register(repaymentRoutes)` in `app.ts`.

- [ ] **Step 4: Run to verify it passes** - `cd api && npm test -- repayment-repay` -> PASS.
- [ ] **Step 5: Full suite + typecheck** - green + clean.
- [ ] **Step 6: Commit** - `git add api && git commit -m "feat(api): POST /projects/:id/repay (porteur, two-phase)"`

---

### Task 6: POST /escrow/repayment webhook

**Files:**
- Modify: `api/src/modules/repayment/routes.ts` (add the webhook)
- Test: `api/tests/repayment-webhook.test.ts`

**Interfaces:**
- Consumes: `settleRepayment`, `failRepaymentSettlement`, a lookup of an installment by `repayment_ref`, `app.config.escrowWebhookSecret`.
- Produces: `POST /escrow/repayment` (secret-verified) body `{ repaymentRef, status: "settled"|"failed" }`.

- [ ] **Step 1: Write the failing test** (mirror `escrow-webhook.test.ts`):

```ts
it("settles a pending installment via the webhook and is idempotent on replay", async () => {
  // seed a repaying project with a 'pending' installment repaymentRef 'r9';
  // POST /escrow/repayment {repaymentRef:'r9', status:'settled'} twice -> 200 both, distributed once.
});
it("rejects a missing/wrong secret with 401", async () => {});
it("returns 404 for an unknown repaymentRef", async () => {});
it("resets pending->due on status=failed and distributes nothing", async () => {});
it("rejects every caller when the configured secret is empty", async () => { /* env ESCROW_WEBHOOK_SECRET="" */ });
```

- [ ] **Step 2: Run to verify it fails** - `cd api && npm test -- repayment-webhook` -> FAIL.

- [ ] **Step 3: Implement** `POST /escrow/repayment` in `repayment/routes.ts` (mirror `escrow/routes.ts` exactly):
  - `const sig = req.headers["x-escrow-signature"]`. If `!app.config.escrowWebhookSecret || sig !== app.config.escrowWebhookSecret` -> `401 unauthorized`.
  - Validate body: `repaymentRef` non-empty string, `status` in {settled, failed}; else `400 validation_error`.
  - Look up the installment by `repayment_ref === repaymentRef`; if none -> `404 not_found`.
  - `status === "failed"` -> `await failRepaymentSettlement(app.db, { installmentId })` -> `200 { ok: true }`.
  - `status === "settled"` -> `await settleRepayment(app.db, { installmentId })` -> `200 { ok: true }`.

- [ ] **Step 4: Run to verify it passes** - `cd api && npm test -- repayment-webhook` -> PASS.
- [ ] **Step 5: Full suite + typecheck** - green + clean.
- [ ] **Step 6: Commit** - `git add api && git commit -m "feat(api): escrow repayment settlement webhook"`

---

### Task 7: Reads (repayment schedule + repaidMinor on /me/investments)

**Files:**
- Modify: `api/src/modules/repayment/routes.ts` (add `GET /projects/:id/repayment-schedule`)
- Modify: `api/src/modules/investments/service.ts` (`listMyInvestments` adds `repaidMinor`)
- Test: `api/tests/repayment-reads.test.ts` + extend `api/tests/investment-mine.test.ts`

**Interfaces:**
- Produces: `GET /projects/:id/repayment-schedule` (requireAuth + owner) -> `{ installments: [{ seq, amountMinor, dueAt, status, settledAt }], totalOwedMinor, paidCount, totalCount }`. `listMyInvestments` items gain `repaidMinor` (sum of `repayment_distribution.amount_minor` for the caller's investment).

- [ ] **Step 1: Write the failing tests**
  - `GET /projects/:id/repayment-schedule`: owner sees the schedule (installments ordered by seq, totals correct); a non-owner -> 403; non-UUID -> 404.
  - `investment-mine.test.ts`: after some installments are distributed, the caller's investment shows `repaidMinor` equal to the sum of their distributions (and `0` before any repayment).

- [ ] **Step 2: Run to verify it fails** - `cd api && npm test -- repayment-reads investment-mine` -> FAIL.

- [ ] **Step 3: Implement.**
  - Route `GET /projects/:id/repayment-schedule`: UUID-validate; load project (404 if missing); `ownerAccountId !== req.accountId` -> 403; select `repaymentInstallments WHERE project_id = :id ORDER BY seq`, project only `{ seq, amountMinor, dueAt, status, settledAt }` (no investor PII); compute `totalOwedMinor = sum(amountMinor)`, `paidCount`, `totalCount`.
  - `listMyInvestments`: add a correlated `repaidMinor` per investment. Simplest correct approach: after the main select, run one grouped query `SELECT investment_id, COALESCE(SUM(amount_minor),0) FROM repayment_distribution WHERE investment_id IN (<caller ids>) GROUP BY investment_id`, then map onto the results (default 0). Add `repaidMinor: number` to the `MyInvestment` interface and the returned shape. Keep the project projection unchanged (no new PII).

- [ ] **Step 4: Run to verify it passes** - `cd api && npm test -- repayment-reads investment-mine` -> PASS.
- [ ] **Step 5: Full suite + typecheck** - green + clean.
- [ ] **Step 6: Commit** - `git add api && git commit -m "feat(api): repayment schedule read + repaidMinor on /me/investments"`

---

## Self-review notes

- **Spec coverage:** schema (T1); provider initiateRepayment (T2); startRepayment + schedule + release hook, with the release-complete condition and the #5-test updates (T3); settleRepayment pro-rata distribution idempotent+resumable + close (T4); POST /repay two-phase (T5); webhook settle/fail (T6); schedule read + repaidMinor (T7). Security section: accountId from session + owner check (T5/T7), webhook secret + ref-only (T6), distribution conservation + unique guard (T4), no I/O under long lock (T4), no PII (T7).
- **The #5 coupling (T3):** hooking `startRepayment` at the end of `releaseProject` changes a fully-released funded project to `repaying`. T3 explicitly updates the #5 tests that assert `"funded"` where release completes (porteur wallet seeded), and leaves untouched the ones where release cannot complete (no porteur wallet) so the project stays `funded`. This is called out as a step, not left to discovery. The `startRepayment` release-complete guard also preserves the #5 `releaseProject` `funded`-only guard's correctness (flip only after zero escrowed remain).
- **Deferred (spec section 11, to the NEXT design):** late/penalty/default, partial/early repayment, schedule regeneration, late-settlement after closed, per-investor rounding drift, real-partner collection declines. None are in scope here.
- **Money-crux tasks:** T3 (touches the #5 release path) and T4 (distribution) get an OPUS reviewer; final whole-branch review is opus. T4's idempotency rests on `UNIQUE(installment_id, investment_id)` (T1) + `onConflictDoNothing`, resumable exactly like the #5 release fix.
- **Type consistency:** `RepaymentRequest`/`RepaymentResult`, `initiateRepayment`, `repaymentMode`, `startRepayment`, `generateSchedule`, `settleRepayment`, `failRepaymentSettlement`, `repayKey`, tables `repaymentInstallments`/`repaymentDistributions`, `repaidMinor` on `MyInvestment`. Provider ref `mock-repay-N`. Webhook body `{ repaymentRef, status }`.
- **Migration:** T1 is the only migration (0013), purely additive (one enum, two tables, one unique index) - no enum recreate, no data backfill.
