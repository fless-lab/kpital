# Partial + Advance Repayment Sub-system Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a porteur repay an installment partially and pay ahead (a payment cascades over later installments), each payment applied in one atomic transaction with per-portion pro-rata distribution to investors, replacing #6's per-installment tout-ou-rien flow.

**Architecture:** A `repayment_payment` row is the two-phase collection unit (webhook resolves by its ref); one pending payment per project. On settle, the whole payment is applied in ONE atomic transaction under the project lock: it cascades over non-paid installments in `seq` order, persisting each portion in `repayment_application` and distributing it pro-rata (reusing #6's opus-verified math, extracted as `distributePortion`), bumping `paid_minor`, and closing the project when fully repaid. Idempotency is the payment status guard plus atomicity (no recompute-from-paid_minor over-application). #7 delinquency is redefined as `paid_minor < amount_minor AND overdue`.

**Tech Stack:** Node/TypeScript/Fastify/Drizzle/Postgres, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-29-partial-repayment-design.md`

## Global Constraints

- TypeScript strict, ESM (extensionless imports). HTTP tests use `buildTestApp()`, service tests use `withTestDb`. Run `cd api && npm test` (currently 238 passing) + `npm run typecheck` after each task; keep green. NEVER run two suite-executing processes against the shared `kpital_test` DB at once.
- Uniform error envelope `{ error: { code, message, details? } }`. Reuse `invalid_state` (409), `exceeds_remaining` (409, `details.remainingMinor`), `payment_failed` (402), `forbidden` (403), `not_found` (404), `unauthorized` (401). No new codes.
- Money is integer minor units (FCFA). NO early-payoff discount (total fixed). `now = new Date()` (server); tests seed `due_at`/`paid_minor`.
- NO em dashes anywhere in code, comments, strings, docs. Use commas, parentheses, colons.
- MONEY-CRITICAL invariants (named; the crux reviewer attacks these): (a) `Σ application.amount_minor for a payment == payment.amount_minor` exactly; (b) `installment.paid_minor == Σ application.amount_minor for that installment` (DB `CHECK paid_minor <= amount_minor`); (c) per portion `Σ distribution == portion` (floor + largest-remainder, BigInt); (d) settle is ONE atomic transaction so a replay sees `payment.status='settled'` and no-ops wholesale, NEVER recomputing the allocation from mutable `paid_minor`; (e) no over-payment (amount capped to project remaining); (f) one pending payment per project (strict-sequential at the payment level).
- accountId ALWAYS `req.accountId`; `/repay` owner-only; webhook via `repayment_payment.ref` only, secret-gated.
- Every task ends green + committed on branch `partial-repayment-subsystem` (do NOT push). Implementers OPUS. Reviewers sonnet EXCEPT Task 3 (the atomic swap, money crux) = OPUS reviewer; final whole-branch review = opus.

---

### Task 1: Schema + migration (additive)

**Files:**
- Modify: `api/src/db/schema.ts`
- Create (generated): `api/drizzle/0017_*.sql`
- Test: `api/tests/partial-repay-schema.test.ts`

**Interfaces:**
- Produces: `repaymentInstallments.paidMinor` (bigint not null default 0) + CHECK; enum `repayment_payment_status` (`pending`|`settled`|`failed`); table `repaymentPayments` (id, projectId, amountMinor, ref nullable, status default pending, settledAt, createdAt) + partial unique on ref; table `repaymentApplications` (id, paymentId, installmentId, amountMinor, createdAt) + UNIQUE(paymentId, installmentId); `repaymentDistributions.applicationId` (uuid nullable fk, for now). The old `repayment_distribution_installment_investment_unique` STAYS in this task (removed in Task 3 with the flow swap) so #6 stays green.

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/partial-repay-schema.test.ts
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "./helpers/db";
import { accounts, projects, repaymentInstallments, repaymentPayments, repaymentApplications } from "../src/db/schema";

describe("partial repayment schema", () => {
  it("installment has paid_minor default 0, and payment + application tables exist", async () => {
    await withTestDb(async (db) => {
      const [o] = await db.insert(accounts).values({ email: "o@a.co", passwordHash: "x",
        firstName: "O", lastName: "A", country: "Togo", roles: ["porteur"] }).returning();
      const [p] = await db.insert(projects).values({ ownerAccountId: o!.id, category: "commerce",
        title: "P", city: "L", description: "d", targetMinor: 1000000, durationMonths: 6, roiPct: "16",
        fundsUsage: "u", cautionType: "a", status: "repaying", raisedMinor: 1000000 }).returning();
      const [ins] = await db.insert(repaymentInstallments).values({ projectId: p!.id, seq: 1,
        amountMinor: 100000, dueAt: new Date() }).returning();
      expect(ins!.paidMinor).toBe(0);
      const [pay] = await db.insert(repaymentPayments).values({ projectId: p!.id, amountMinor: 50000, ref: "mp-1" }).returning();
      expect(pay!.status).toBe("pending");
      const [app] = await db.insert(repaymentApplications).values({ paymentId: pay!.id, installmentId: ins!.id, amountMinor: 50000 }).returning();
      expect(app!.amountMinor).toBe(50000);
    });
  });
  it("rejects paid_minor above amount_minor (CHECK)", async () => {
    await withTestDb(async (db) => {
      const [o] = await db.insert(accounts).values({ email: "o@a.co", passwordHash: "x",
        firstName: "O", lastName: "A", country: "Togo", roles: ["porteur"] }).returning();
      const [p] = await db.insert(projects).values({ ownerAccountId: o!.id, category: "commerce",
        title: "P", city: "L", description: "d", targetMinor: 1000000, durationMonths: 6, roiPct: "16",
        fundsUsage: "u", cautionType: "a", status: "repaying", raisedMinor: 1000000 }).returning();
      await expect(
        db.insert(repaymentInstallments).values({ projectId: p!.id, seq: 1, amountMinor: 100000, dueAt: new Date(), paidMinor: 100001 }),
      ).rejects.toThrow();
    });
  });
  it("rejects two payments sharing a non-null ref (partial unique)", async () => {
    await withTestDb(async (db) => {
      const [o] = await db.insert(accounts).values({ email: "o@a.co", passwordHash: "x",
        firstName: "O", lastName: "A", country: "Togo", roles: ["porteur"] }).returning();
      const [p] = await db.insert(projects).values({ ownerAccountId: o!.id, category: "commerce",
        title: "P", city: "L", description: "d", targetMinor: 1000000, durationMonths: 6, roiPct: "16",
        fundsUsage: "u", cautionType: "a", status: "repaying", raisedMinor: 1000000 }).returning();
      await db.insert(repaymentPayments).values({ projectId: p!.id, amountMinor: 50000, ref: "dup" });
      await expect(db.insert(repaymentPayments).values({ projectId: p!.id, amountMinor: 60000, ref: "dup" })).rejects.toThrow();
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails** - `cd api && npm test -- partial-repay-schema` -> FAIL.

- [ ] **Step 3: Implement in `schema.ts`.** `uniqueIndex`, `check`, `sql` are already imported.
  - Add `paidMinor: bigint("paid_minor", { mode: "number" }).notNull().default(0)` to `repaymentInstallments`; add to its table config callback a `check("repayment_installment_paid_within_amount", sql`${t.paidMinor} >= 0 AND ${t.paidMinor} <= ${t.amountMinor}`)`. (The table currently has a `(t) => ({ repaymentRefUnique: ... })` config; add the check alongside it.)
  - Add near the repayment tables:
    ```ts
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
    ```
  - Add `applicationId: uuid("application_id").references(() => repaymentApplications.id)` (NULLABLE for now) to `repaymentDistributions`. KEEP its existing `perInvestmentUnique` unique in this task.
  - Generate: `cd api && DATABASE_URL="postgres://kpital:kpital@127.0.0.1:5544/kpital" npx drizzle-kit generate` (additive: CHECK, one enum, two tables, one ADD COLUMN, indexes). Inspect additive-only.

- [ ] **Step 4: Run to verify it passes** - `cd api && npm test -- partial-repay-schema` -> PASS.
- [ ] **Step 5: Full suite + typecheck** - green + clean (#6 untouched).
- [ ] **Step 6: Commit** - `git add api && git commit -m "feat(api): partial-repayment schema (paid_minor, payment + application tables, migration 0017)"`

---

### Task 2: distributePortion (extract #6 pro-rata math)

**Files:**
- Create: `api/src/modules/repayment/distribute.ts`
- Test: `api/tests/partial-distribute.test.ts`

**Interfaces:**
- Consumes: `repaymentDistributions`, `investments`, `projects`, `wallets`, `walletEntries`.
- Produces: `distributePortion(tx, args: { projectId: string; applicationId: string; installmentId: string; amountMinor: number }): Promise<void>` - distributes `amountMinor` pro-rata across the project's released investors, inserting `repaymentDistributions({ applicationId, installmentId, investmentId, amountMinor: share })` + a `repayment` wallet credit, ALL within the passed transaction `tx`. Uses the exact #6 share math (released-only set, BigInt `amount*p_i`, floor + largest-remainder, tiebreak `investment.id`).

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/partial-distribute.test.ts (excerpt - implementer writes full seeding)
// Seed a repaying project raised 1_000_000 across 3 released investors (500k/300k/200k),
// one installment, one payment, one application (amountMinor = the portion). Call
// distributePortion inside a db.transaction. Assert: each investor credited
// floor(portion*p_i/R) + largest-remainder units; sum of distributions == portion;
// distribution rows carry the applicationId.
it("distributes a portion pro-rata with exact conservation", async () => {
  await withTestDb(async (db) => {
    // ... seed; const portion = 193333;
    await db.transaction(async (tx) => {
      await distributePortion(tx as any, { projectId, applicationId, installmentId, amountMinor: 193333 });
    });
    // assert sum(distributions for application) === 193333; per-investor shares match floor+remainder
  });
});
```

- [ ] **Step 2: Run to verify it fails** - `cd api && npm test -- partial-distribute` -> FAIL.

- [ ] **Step 3: Implement `distribute.ts`.** Copy the share computation from `settleRepayment` (`api/src/modules/repayment/service.ts` lines ~128-173) BYTE-IDENTICAL: load released investors (`sum(p_i)==R`), `R<=0||invs.length===0 -> return`, BigInt `An*BigInt(p_i)`, `share=Number(prod/Rn)`, `frac=Number(prod%Rn)`, `floorSum`, `remainder=amountMinor-floorSum`, sort by `frac` desc tiebreak `inv.id` asc, add the remainder units. Then for each `share>0`, WITHIN the passed `tx` (no per-investor sub-transaction, no onConflictDoNothing - the caller's single atomic settle transaction provides idempotency via the payment status guard): insert `repaymentDistributions({ applicationId: args.applicationId, installmentId: args.installmentId, investmentId: inv.id, amountMinor: share })`, look up the investor wallet (throw if missing), insert `walletEntries({ walletId, type: "repayment", amountMinor: share, reference: <distribution id> })`. `A = args.amountMinor`.

- [ ] **Step 4: Run to verify it passes** - `cd api && npm test -- partial-distribute` -> PASS.
- [ ] **Step 5: Full suite + typecheck** - green + clean (#6 settleRepayment untouched, coexists).
- [ ] **Step 6: Commit** - `git add api && git commit -m "feat(api): distributePortion (extracted pro-rata math, tx-scoped)"`

---

### Task 3: The atomic swap - settlePayment + payment /repay + webhook, retire #6 flow [MONEY CRUX, opus reviewer]

This is the coherent #6->#8 flow swap. It is large by necessity: partial payment requires dropping the old `repayment_distribution` unique, which is incompatible with #6's `settleRepayment` idempotency, so both change together.

**Files:**
- Modify: `api/src/modules/repayment/service.ts` (add `settlePayment`, `failPayment`, `repayKey(paymentId)`; REMOVE `settleRepayment`, `failRepaymentSettlement`, the old `repayKey(installmentId)`)
- Modify: `api/src/modules/repayment/routes.ts` (rewrite `POST /projects/:id/repay` to the payment flow; rewrite `POST /escrow/repayment` to resolve by payment ref)
- Modify: `api/src/db/schema.ts` (DROP the old `repayment_distribution_installment_investment_unique`; make `repaymentDistributions.applicationId` NOT NULL)
- Create (generated): `api/drizzle/0018_*.sql`
- Tests: rewrite `api/tests/repayment-repay.test.ts`, `api/tests/repayment-webhook.test.ts`; rewrite/replace `api/tests/repayment-settle.test.ts` -> `api/tests/partial-settle.test.ts`; keep `api/tests/collections-repay.test.ts` working (the /repay it calls is now payment-based)

**Interfaces:**
- Produces:
  - `repayKey(paymentId: string): string` = `` `repay:${paymentId}` `` (payment-scoped).
  - `settlePayment(db, args: { paymentId: string }): Promise<void>` - in ONE `db.transaction`: load the payment; if `status !== "pending"` return (settled -> already done / no-op; failed -> never applies). Lock the project row FOR UPDATE. Load non-`paid` installments ORDER BY seq. Cascade `reste = payment.amountMinor` over them: for each, `portion = min(reste, amountMinor - paidMinor)`, insert `repaymentApplications({ paymentId, installmentId, amountMinor: portion })`, `await distributePortion(tx, { projectId, applicationId, installmentId, amountMinor: portion })`, `UPDATE installment SET paid_minor = paid_minor + portion, status = (paid_minor+portion === amount_minor ? "paid" : status)`, `reste -= portion`; stop at `reste===0`. Then `UPDATE payment SET status="settled", settled_at=now WHERE id=? AND status="pending"`. Then if every installment of the project is `paid`, `UPDATE project SET status="closed" WHERE id=? AND status IN ("repaying","defaulted")`; else auto-lift (Task 4 handles the #7 predicate; for THIS task, keep the existing #7 auto-lift call if present, or leave the project status as-is - Task 4 refines). All in the one transaction (atomic; a replay finds status settled and returns).
  - `failPayment(db, args: { paymentId: string }): Promise<void>` - guarded `UPDATE payment SET status="failed" WHERE id=? AND status="pending"`. Applies nothing.
- Route `POST /projects/:id/repay { amountMinor, confirmCapToRemaining? }`: see spec section 6. Route `POST /escrow/repayment { repaymentRef, status }`: resolve `repaymentPayments` by `ref`, dispatch to settlePayment/failPayment.

- [ ] **Step 1: Write the failing tests** in `api/tests/partial-settle.test.ts` (service) and rewrite the route tests. Cover the spec section 10 cases: partial (paid_minor advances, not paid, distributed); cascade over 2.5 installments (`Σ application == payment`, each portion distributed); payoff -> closed; over-remaining -> 409 exceeds_remaining, confirm caps; async pending -> nothing applied, webhook settled -> cascade, webhook REPLAY -> applied once (payment status guard), second /repay while pending -> 409; webhook failed -> nothing applied; provider decline -> 402 no payment row; re-settle of a settled payment -> no new applications/distributions/credits, `Σ application == amount`.

- [ ] **Step 2: Run to verify it fails** - `cd api && npm test -- partial-settle repayment-repay repayment-webhook` -> FAIL.

- [ ] **Step 3: Implement.**
  - `service.ts`: add `settlePayment`/`failPayment`/`repayKey(paymentId)` per Interfaces (import `distributePortion` from `./distribute`, `repaymentPayments`/`repaymentApplications` from schema). Delete `settleRepayment`, `failRepaymentSettlement`, and the old installment-scoped `repayKey`. The settle transaction holds the project row FOR UPDATE and does the whole cascade atomically. Idempotency: the entry guard `if (payment.status !== "pending") return;` plus the single transaction (a crash rolls back everything; a replay of a settled payment no-ops).
  - `routes.ts` `POST /projects/:id/repay`: preHandler requireAuth; UUID 404; load project, owner 403, status must be `repaying`|`defaulted` else 409; in a `db.transaction` locking the project: if any `repaymentPayments` with status `pending` for the project exists -> 409 invalid_state; compute `remaining = Σ(amount_minor - paid_minor)` over non-`paid` installments; validate `amountMinor` positive int; `> remaining` without confirm -> 409 exceeds_remaining (+details.remainingMinor), with confirm -> cap; capped `<= 0` -> 409 invalid_state; insert `repaymentPayments({ status:"pending", amountMinor })`; `initiateRepayment({ payerAccountId: project.ownerAccountId, amountMinor, idempotencyKey: repayKey(paymentId) })`; `!ok` -> throw (rollback, 402 payment_failed); set `ref = dep.ref`; commit. After commit: if `dep.status === "settled"` -> `await settlePayment(app.db, { paymentId })`. Read back the payment status + project status + `appliedMinor` (sum of applications for the payment). Respond `201 { paymentId, amountMinor, status, appliedMinor, projectStatus }`.
  - `routes.ts` `POST /escrow/repayment`: unchanged auth (x-escrow-signature vs config.escrowWebhookSecret, empty -> 401); body `{ repaymentRef, status }` validated; resolve `repaymentPayments` by `ref` (404 if none); `failed` -> `failPayment`; `settled` -> `settlePayment`; 200.
  - `schema.ts`: remove the `perInvestmentUnique` from `repaymentDistributions`; change `applicationId` to `.notNull()`. Generate migration 0018 (DROP INDEX the old unique; note: existing #6 distribution rows have null application_id, but the test DB is fresh each run and there is no prod data, so the NOT NULL is safe; if drizzle emits a NOT NULL that would fail on existing nulls, the migration still applies on the fresh test DB - confirm the suite is green).
  - Rewrite `repayment-repay.test.ts` + `repayment-webhook.test.ts` for the payment flow; replace `repayment-settle.test.ts` with `partial-settle.test.ts`.

- [ ] **Step 4: Run to verify it passes** - `cd api && npm test -- partial-settle repayment-repay repayment-webhook collections-repay` -> PASS.
- [ ] **Step 5: Full suite + typecheck** - `cd api && npm test` ALL green (grep for any remaining `settleRepayment`/`failRepaymentSettlement` reference: `grep -rn "settleRepayment\|failRepaymentSettlement" api/src api/tests` must be empty) + `npm run typecheck` clean.
- [ ] **Step 6: Commit** - `git add api && git commit -m "feat(api): payment-based repay + atomic cascade settlePayment, retire per-installment flow"`

---

### Task 4: #7 delinquency by paid_minor + auto-lift

**Files:**
- Modify: `api/src/modules/collections/service.ts` (`runRepaymentSweep` reminder/default/recovery predicates)
- Modify: `api/src/modules/repayment/routes.ts` (the `/repay` auto-lift predicate, if not already handled in Task 3)
- Test: `api/tests/collections-sweep.test.ts` + `api/tests/collections-repay.test.ts` (extend)

**Interfaces:**
- Produces: sweep + auto-lift treat an installment as delinquent when `paid_minor < amount_minor` (not `status IN (due,pending)`).

- [ ] **Step 1: Write the failing test**

```ts
// in collections-sweep.test.ts
it("treats a partially-paid overdue installment as delinquent (reminds + defaults past grace)", async () => {
  // seed a repaying project, one installment amount 100000 paid_minor 40000 (partial), due 40 days ago;
  // sweep -> reminder sent AND project defaulted (still delinquent because paid_minor < amount_minor).
});
it("recovers once every overdue installment is fully paid (paid_minor == amount_minor)", async () => {
  // a defaulted project whose overdue installment reaches paid_minor == amount_minor -> sweep recovers.
});
```

- [ ] **Step 2: Run to verify it fails** - `cd api && npm test -- collections-sweep` -> FAIL.

- [ ] **Step 3: Implement.** In `runRepaymentSweep`: replace the reminder-phase and default-phase installment predicate `eq(status, "due")` with `lt(repaymentInstallments.paidMinor, repaymentInstallments.amountMinor)` (a not-fully-paid installment). Replace the recovery-phase `inArray(status, ["due","pending"])` with the same `lt(paidMinor, amountMinor)`. Keep the `due_at`/`graceCutoff` and `remindedAt IS NULL` conditions. In `/repay`'s auto-lift (Task 3 / here), the "no grace-exceeded delinquent installment remains" check uses `paid_minor < amount_minor AND due_at < graceCutoff`. Use `lt` from drizzle. (A fully-paid installment has `paid_minor == amount_minor` so is excluded, matching the old `status='paid'` exclusion; the reminder `reminded_at IS NULL` guard is unchanged.)

- [ ] **Step 4: Run to verify it passes** - `cd api && npm test -- collections-sweep collections-repay` -> PASS.
- [ ] **Step 5: Full suite + typecheck** - green + clean.
- [ ] **Step 6: Commit** - `git add api && git commit -m "feat(api): #7 delinquency keyed on paid_minor for partial payments"`

---

### Task 5: Reads (paidMinor + remainingMinor on the schedule)

**Files:**
- Modify: `api/src/modules/repayment/routes.ts` (GET /projects/:id/repayment-schedule)
- Test: `api/tests/repayment-reads.test.ts` (extend)

**Interfaces:**
- Produces: each schedule installment gains `paidMinor` and `remainingMinor` (= `amount_minor - paid_minor`), alongside the existing `overdue`/`remindedAt`/`seq`/`amountMinor`/`dueAt`/`status`/`settledAt`.

- [ ] **Step 1: Write the failing test**

```ts
it("exposes paidMinor + remainingMinor per installment on the schedule", async () => {
  // owner seeds installments with paid_minor 0, 40000 (partial), and 100000 (paid);
  // assert paidMinor + remainingMinor per row; totals unchanged; no PII.
});
```

- [ ] **Step 2: Run to verify it fails** - `cd api && npm test -- repayment-reads` -> FAIL.

- [ ] **Step 3: Implement.** In the schedule handler, also select `repaymentInstallments.paidMinor`; map each row to add `paidMinor: row.paidMinor` and `remainingMinor: row.amountMinor - row.paidMinor`. Keep existing fields/totals unchanged. Confirm `repaidMinor` on `/me/investments` still sums distributions correctly (it groups by investment_id across all distributions, so multi-portion works unchanged - add a note/assertion if convenient).

- [ ] **Step 4: Run to verify it passes** - `cd api && npm test -- repayment-reads` -> PASS.
- [ ] **Step 5: Full suite + typecheck** - green + clean.
- [ ] **Step 6: Commit** - `git add api && git commit -m "feat(api): expose paidMinor + remainingMinor on the repayment schedule"`

---

## Self-review notes

- **Spec coverage:** schema/migration + backstops (T1); distributePortion extraction (T2); the atomic swap - settlePayment cascade, payment /repay, payment-ref webhook, retire #6 orchestration, drop old unique (T3, crux); #7 delinquency by paid_minor (T4); reads (T5). Security section: one-pending-per-project + cap-to-remaining + atomic conservation (T3), owner/webhook auth (T3), no PII (T5).
- **Deferred (spec section 11, next design):** early-payoff discount; real caution/penalty (#7 carry); real provider integration (#5/#6 carry); multiple concurrent payments with capacity reservation; rounding drift.
- **Money-crux task:** T3 gets an OPUS reviewer (the atomic cascade, the persisted-allocation invariant against recompute-over-application, one-pending-per-project, idempotent replay). Final whole-branch review is opus. The reviewer must attack invariants (a)-(f) from Global Constraints, especially (d) atomic no-recompute.
- **Type consistency:** `repayKey(paymentId)`, `settlePayment({paymentId})`, `failPayment({paymentId})`, `distributePortion(tx,{projectId,applicationId,installmentId,amountMinor})`, tables `repaymentPayments`/`repaymentApplications`, `repaymentInstallments.paidMinor`, `repaymentDistributions.applicationId`, `repayment_payment_status`. Response `{ paymentId, amountMinor, status, appliedMinor, projectStatus }`.
- **Migrations:** 0017 (additive: paid_minor+CHECK, payment+application tables, ref unique, distribution.application_id nullable) in T1; 0018 (drop old distribution unique, application_id NOT NULL) in T3. Both apply cleanly on the fresh test DB (no prod data).
- **Frozen-code touch (approved by user):** T3 retires #6's `settleRepayment`/`failRepaymentSettlement` and the per-installment `/repay`+webhook; T4 changes #7's sweep predicates. The #6 pro-rata MATH is preserved byte-identical in `distributePortion` (T2), so the opus-verified distribution logic is not rewritten, only re-hosted.
