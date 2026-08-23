# Escrow Sub-system Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hold each investment in escrow during collection, release it to the porteur's wallet when the project funds, and refund investors when an admin cancels, with all money movement mocked behind a swappable async-ready `EscrowProvider` plugin.

**Architecture:** Extends the #4 invest flow into a two-phase escrow state machine (`pending -> escrowed -> released|refunded`, plus `failed`). The existing `PaymentProvider` gains `initiateDeposit` (replaces `collectFunds`), `releaseEscrow`, and `refundEscrow`; `payout` is kept for wallet withdrawals. All state-machine and accounting logic lives in our services; only money-movement calls cross the provider seam. `raised_minor` advances at settlement under the project `FOR UPDATE` lock; release and refund run OUTSIDE that lock in short idempotent per-investment transactions. Idempotency comes from guarded state-transition updates plus deterministic provider idempotency keys.

**Tech Stack:** Node/TypeScript/Fastify/Drizzle/Postgres, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-23-escrow-design.md`

## Global Constraints

- TypeScript strict, ESM (extensionless imports). HTTP tests use `buildTestApp()`, service tests use `withTestDb`. Run `cd api && npm test` (currently 136 passing) + `npm run typecheck` after each task; keep green. NEVER run two suite-executing processes against the shared `kpital_test` DB at once (concurrent truncating `beforeEach` causes phantom failures).
- Uniform error envelope `{ error: { code, message, details? } }`. Reuse #4 codes (`kyc_required` 403, `below_min_ticket` 400, `exceeds_remaining` 409 + `details.remainingMinor`, `invalid_state` 409, `insufficient_funds` 400, `payment_failed` 402). New webhook responses: `401` (bad/absent secret), `404` (unknown depositRef), `200` (settled/failed/no-op). Admin cancel: `403` (non-admin), `409 invalid_state` (project not collecting).
- Money is integer minor units (FCFA, no sub-unit). Timestamps `timestamptz`. New migration per table-adding/altering task.
- NO em dashes anywhere in code, comments, strings, or docs (house style, user requirement). Use commas, parentheses, or colons.
- Concurrency (MONEY-CRITICAL): `raised_minor` moves ONLY inside a transaction that holds `SELECT ... FOR UPDATE` on the project row. Every escrow state transition is a GUARDED update (`WHERE status = <expected>`); the money move (raised increment/decrement, wallet entry) happens only when the guard actually changed a row. Provider calls carry deterministic idempotency keys `deposit:<investmentId>` / `release:<investmentId>` / `refund:<investmentId>`. Preserve the #4 `CHECK (raised_minor >= 0 AND raised_minor <= target_minor)` invariant.
- accountId is ALWAYS `req.accountId` from the session, never from the body. The webhook acts only via `depositRef`, never an accountId from its body.
- Every task ends green + committed on branch `escrow-subsystem` (do NOT push). Implementers OPUS (standing pref). Reviewers sonnet EXCEPT Task 3 and Task 4 (money crux) = OPUS reviewer; final whole-branch review = opus.

---

### Task 1: Schema and migration (escrow states + audit columns)

**Files:**
- Modify: `api/src/db/schema.ts`
- Create (generated, then hand-edited): `api/drizzle/0011_*.sql` (+ meta snapshot)
- Test: `api/tests/escrow-schema.test.ts`

**Interfaces:**
- Produces: `investment_status` enum values `pending`|`escrowed`|`released`|`refunded`|`failed` (default `pending`); `project_status` gains `cancelled`; `entry_type` gains `disbursement`|`refund`; `investment` gains `resolution_ref` text null, `settled_at` timestamptz null, `resolved_at` timestamptz null.

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/escrow-schema.test.ts
import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db";
import { accounts, projects, investments } from "../src/db/schema";

describe("escrow schema", () => {
  it("investment defaults to pending and accepts escrow states + audit columns", async () => {
    await withTestDb(async (db) => {
      const [a] = await db.insert(accounts).values({ email: "i@a.co", passwordHash: "x",
        firstName: "I", lastName: "A", country: "Togo", roles: ["investor"] }).returning();
      const [p] = await db.insert(projects).values({ ownerAccountId: a!.id, category: "commerce",
        title: "P", city: "L", description: "d", targetMinor: 1000000, durationMonths: 6,
        roiPct: "16", fundsUsage: "u", cautionType: "a", status: "collecting" }).returning();
      const [inv] = await db.insert(investments).values({ projectId: p!.id, investorAccountId: a!.id,
        amountMinor: 50000, source: "payment", paymentRef: "mock-deposit-1" }).returning();
      expect(inv!.status).toBe("pending");
      const [esc] = await db.update(investments).set({ status: "escrowed", settledAt: new Date() })
        .where((await import("drizzle-orm")).eq(investments.id, inv!.id)).returning();
      expect(esc!.status).toBe("escrowed");
      const [rel] = await db.update(investments).set({ status: "released",
        resolutionRef: "mock-release-1", resolvedAt: new Date() })
        .where((await import("drizzle-orm")).eq(investments.id, inv!.id)).returning();
      expect(rel!.status).toBe("released");
      expect(rel!.resolutionRef).toBe("mock-release-1");
    });
  });

  it("project accepts the cancelled status", async () => {
    await withTestDb(async (db) => {
      const [a] = await db.insert(accounts).values({ email: "o@a.co", passwordHash: "x",
        firstName: "O", lastName: "A", country: "Togo", roles: ["porteur"] }).returning();
      const [p] = await db.insert(projects).values({ ownerAccountId: a!.id, category: "commerce",
        title: "P", city: "L", description: "d", targetMinor: 1000000, durationMonths: 6,
        roiPct: "16", fundsUsage: "u", cautionType: "a", status: "cancelled" }).returning();
      expect(p!.status).toBe("cancelled");
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails** - `cd api && npm test -- escrow-schema` → FAIL (unknown enum value / unknown column).

- [ ] **Step 3: Edit `schema.ts`.**
  - Replace the enum line `export const investmentStatus = pgEnum("investment_status", ["confirmed"]);` with:
    ```ts
    export const investmentStatus = pgEnum("investment_status", ["pending","escrowed","released","refunded","failed"]);
    ```
  - Change the `investments.status` default from `.default("confirmed")` to `.default("pending")`.
  - Add to the `investments` table definition (after `paymentRef`):
    ```ts
    resolutionRef: text("resolution_ref"),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    ```
  - In `projectStatus` pgEnum, add `"cancelled"` to the array (append at the end).
  - In `entryType` pgEnum, add `"disbursement"` and `"refund"` (append at the end): `["repayment","withdrawal","reinvestment","adjustment","disbursement","refund"]`.
  - HOLDING EDIT so the suite stays green (the real two-phase rework is Task 4): in `investments/service.ts` `createInvestment`, change the hardcoded investment insert `status: "confirmed"` to `status: "escrowed"` (invest still settles synchronously for now). The removed `confirmed` value would otherwise make the insert fail at runtime.
  - Update existing #4 test fixtures that reference the removed `confirmed`: in `api/tests/investment-schema.test.ts` change `expect(inv!.status).toBe("confirmed")` to `toBe("pending")` (the new default); in `api/tests/investment-invest.test.ts`, any assertion of investment row `status === "confirmed"` becomes `"escrowed"` (the response-body shape is NOT changed here; Task 4 adds the `status`/`depositRef` response fields).

- [ ] **Step 4: Generate the migration.**

Run: `cd api && DATABASE_URL="postgres://kpital:kpital@127.0.0.1:5544/kpital" npx drizzle-kit generate`

Then OPEN the generated `drizzle/0011_*.sql`. Drizzle emits `ALTER TYPE ... ADD VALUE` for the appended enum values (project_status, entry_type) and `ALTER TABLE investment ADD COLUMN` for the three columns. For `investment_status`, because a value was effectively removed (`confirmed`), drizzle-kit may emit a destructive enum recreate. Since there is NO production data, HAND-EDIT the migration so it is clean and correct:
  - Keep the three `ALTER TABLE "investment" ADD COLUMN` statements (resolution_ref, settled_at, resolved_at).
  - Keep `ALTER TYPE "project_status" ADD VALUE 'cancelled';` and `ALTER TYPE "entry_type" ADD VALUE 'disbursement';` / `ADD VALUE 'refund';`.
  - For `investment_status`: the column default must change to `'pending'` and the new values must exist. Replace any messy generated block with an explicit, ordered sequence:
    ```sql
    ALTER TABLE "investment" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "investment" ALTER COLUMN "status" SET DATA TYPE text;
    DROP TYPE "investment_status";
    CREATE TYPE "investment_status" AS ENUM('pending','escrowed','released','refunded','failed');
    ALTER TABLE "investment" ALTER COLUMN "status" SET DATA TYPE "investment_status" USING "status"::"investment_status";
    ALTER TABLE "investment" ALTER COLUMN "status" SET DEFAULT 'pending';
    ```
    (Note: `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block with other statements in some setups; if the migration runner errors, split the `ADD VALUE` statements into their own migration file `0012`. Verify by running the suite in Step 6.)

- [ ] **Step 5: Run to verify it passes** - `cd api && npm test -- escrow-schema` → PASS.

- [ ] **Step 6: Full suite + typecheck.** `cd api && npm test` → ALL green (the holding edits in Step 3 keep `createInvestment` and the #4 tests working under the new states). `npm run typecheck` → clean. If anything is red, it means a `"confirmed"` reference was missed; grep `grep -rn '"confirmed"' api/src api/tests` and fix before committing.

- [ ] **Step 7: Commit** - `git add api && git commit -m "feat(api): escrow state machine schema + migration (0011)"`

---

### Task 2: EscrowProvider methods on PaymentProvider + config secret

**Files:**
- Modify: `api/src/lib/payments/index.ts`
- Modify: `api/src/config/env.ts` (add `escrowWebhookSecret`)
- Test: `api/tests/escrow-provider.test.ts`

**Interfaces:**
- Produces on `PaymentProvider`: `initiateDeposit(p: DepositRequest): Promise<DepositResult>` where `DepositRequest = { accountId: string; amountMinor: number; method?: PayoutMethod; idempotencyKey: string }` and `DepositResult = { ok: boolean; ref: string; status: "pending" | "settled" }`; `releaseEscrow(p: ReleaseRequest): Promise<EscrowMoveResult>` where `ReleaseRequest = { depositRef: string; payeeAccountId: string; amountMinor: number; idempotencyKey: string }` and `EscrowMoveResult = { ok: boolean; ref: string }`; `refundEscrow(p: RefundRequest): Promise<EscrowMoveResult>` where `RefundRequest = { depositRef: string; amountMinor: number; idempotencyKey: string }`. `payout` is KEPT. `collectFunds` is KEPT in this task (removed in Task 4 once unused). `MockPaymentProvider` implements all, with a settable `depositMode: "settled" | "pending"` (default `"settled"`) and idempotency memoization keyed by `idempotencyKey`. Config gains `escrowWebhookSecret: string`.

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/escrow-provider.test.ts
import { describe, it, expect } from "vitest";
import { MockPaymentProvider } from "../src/lib/payments";

describe("MockPaymentProvider escrow methods", () => {
  it("initiateDeposit settles by default and is idempotent per key", async () => {
    const p = new MockPaymentProvider();
    const r1 = await p.initiateDeposit({ accountId: "a", amountMinor: 50000, idempotencyKey: "deposit:x" });
    expect(r1.ok).toBe(true);
    expect(r1.status).toBe("settled");
    expect(r1.ref).toMatch(/^mock-deposit-\d+$/);
    const r2 = await p.initiateDeposit({ accountId: "a", amountMinor: 50000, idempotencyKey: "deposit:x" });
    expect(r2.ref).toBe(r1.ref); // replay returns the same ref, no new movement
  });

  it("initiateDeposit can be put in pending mode", async () => {
    const p = new MockPaymentProvider();
    p.depositMode = "pending";
    const r = await p.initiateDeposit({ accountId: "a", amountMinor: 50000, idempotencyKey: "deposit:y" });
    expect(r.status).toBe("pending");
  });

  it("releaseEscrow and refundEscrow return ok refs and are idempotent per key", async () => {
    const p = new MockPaymentProvider();
    const rel = await p.releaseEscrow({ depositRef: "mock-deposit-1", payeeAccountId: "o", amountMinor: 50000, idempotencyKey: "release:x" });
    expect(rel.ok).toBe(true);
    expect(rel.ref).toMatch(/^mock-release-\d+$/);
    expect((await p.releaseEscrow({ depositRef: "mock-deposit-1", payeeAccountId: "o", amountMinor: 50000, idempotencyKey: "release:x" })).ref).toBe(rel.ref);
    const ref = await p.refundEscrow({ depositRef: "mock-deposit-1", amountMinor: 50000, idempotencyKey: "refund:x" });
    expect(ref.ref).toMatch(/^mock-refund-\d+$/);
    expect((await p.refundEscrow({ depositRef: "mock-deposit-1", amountMinor: 50000, idempotencyKey: "refund:x" })).ref).toBe(ref.ref);
  });
});
```

- [ ] **Step 2: Run to verify it fails** - `cd api && npm test -- escrow-provider` → FAIL.

- [ ] **Step 3: Implement in `payments/index.ts`.** Add the request/result types and the three interface methods:

```ts
export interface DepositRequest { accountId: string; amountMinor: number; method?: PayoutMethod; idempotencyKey: string; }
export interface DepositResult { ok: boolean; ref: string; status: "pending" | "settled"; }
export interface ReleaseRequest { depositRef: string; payeeAccountId: string; amountMinor: number; idempotencyKey: string; }
export interface RefundRequest { depositRef: string; amountMinor: number; idempotencyKey: string; }
export interface EscrowMoveResult { ok: boolean; ref: string; }

export interface PaymentProvider {
  payout(p: PayoutRequest): Promise<PayoutResult>;
  collectFunds(p: CollectRequest): Promise<CollectResult>; // kept until Task 4
  initiateDeposit(p: DepositRequest): Promise<DepositResult>;
  releaseEscrow(p: ReleaseRequest): Promise<EscrowMoveResult>;
  refundEscrow(p: RefundRequest): Promise<EscrowMoveResult>;
}
```

In `MockPaymentProvider`, add a memo map and the methods (keep `payout`/`collectFunds` and their counters):

```ts
  depositMode: "settled" | "pending" = "settled";
  private depositSeq = 0;
  private releaseSeq = 0;
  private refundSeq = 0;
  // Deterministic idempotency: a replayed key returns the prior result, never a
  // new ref, mirroring how a real provider dedupes by idempotency key.
  private memo = new Map<string, { ref: string; status?: "pending" | "settled" }>();

  async initiateDeposit(p: DepositRequest): Promise<DepositResult> {
    const prior = this.memo.get(p.idempotencyKey);
    if (prior) return { ok: true, ref: prior.ref, status: prior.status ?? "settled" };
    this.depositSeq += 1;
    const ref = `mock-deposit-${this.depositSeq}`;
    this.memo.set(p.idempotencyKey, { ref, status: this.depositMode });
    return { ok: true, ref, status: this.depositMode };
  }

  async releaseEscrow(p: ReleaseRequest): Promise<EscrowMoveResult> {
    const prior = this.memo.get(p.idempotencyKey);
    if (prior) return { ok: true, ref: prior.ref };
    this.releaseSeq += 1;
    const ref = `mock-release-${this.releaseSeq}`;
    this.memo.set(p.idempotencyKey, { ref });
    return { ok: true, ref };
  }

  async refundEscrow(p: RefundRequest): Promise<EscrowMoveResult> {
    const prior = this.memo.get(p.idempotencyKey);
    if (prior) return { ok: true, ref: prior.ref };
    this.refundSeq += 1;
    const ref = `mock-refund-${this.refundSeq}`;
    this.memo.set(p.idempotencyKey, { ref });
    return { ok: true, ref };
  }
```

In `config/env.ts`: add `escrowWebhookSecret: string` to the `Config` type and read it from `process.env.ESCROW_WEBHOOK_SECRET ?? ""` (default empty string; empty means the webhook rejects all callers, which is the safe prod default). Follow the existing pattern in that file for reading env vars.

- [ ] **Step 4: Run to verify it passes** - `cd api && npm test -- escrow-provider` → PASS.

- [ ] **Step 5: Full suite + typecheck** - `cd api && npm test` → all green (this task only adds provider methods and a config field). `npm run typecheck` → clean.

- [ ] **Step 6: Commit** - `git add api && git commit -m "feat(api): escrow provider methods (deposit/release/refund) + webhook secret config"`

---

### Task 3: Escrow service (settle, fail, release) [MONEY CRUX, opus reviewer]

**Files:**
- Create: `api/src/modules/escrow/service.ts`
- Test: `api/tests/escrow-settle.test.ts`

**Interfaces:**
- Consumes: `PaymentProvider.initiateDeposit/releaseEscrow` (Task 2), `investments`/`projects`/`wallets`/`walletEntries` tables (Task 1 states), `Db` type (from `../investments/service` or `../../db/client` - match how the investments module imports `Db`).
- Produces:
  - `idemKey(op: "deposit" | "release" | "refund", investmentId: string): string` returning `` `${op}:${investmentId}` ``.
  - `settleDeposit(db: Db, payments: PaymentProvider, args: { depositRef: string }): Promise<SettleResult>` where `SettleResult = { found: boolean; applied: boolean; projectStatus?: string }`. Finds the investment by `payment_ref = depositRef`. If none: `{ found: false, applied: false }`. Else, in ONE transaction locking the project row `FOR UPDATE`: if `project.status !== "collecting"` OR investment `status !== "pending"` -> `{ found: true, applied: false, projectStatus }` (no-op, idempotent). Else guarded `UPDATE investment SET status='escrowed', settledAt=now() WHERE id=? AND status='pending'`; if it changed a row, `raised_minor += amount` and flip `funded` at strict equality; return `{ found: true, applied: true, projectStatus }`. AFTER the transaction commits, if the project became `funded`, call `releaseProject(db, payments, { projectId })`.
  - `failDeposit(db: Db, args: { depositRef: string }): Promise<SettleResult>` - find by depositRef; guarded `UPDATE investment SET status='failed', resolvedAt=now() WHERE id=? AND status='pending'`; never touches raised. `{found, applied}`.
  - `releaseProject(db: Db, payments: PaymentProvider, args: { projectId: string }): Promise<void>` - select the project's `escrowed` investments; for EACH, in its OWN short transaction: `payments.releaseEscrow({ depositRef: inv.paymentRef, payeeAccountId: <project.ownerAccountId>, amountMinor: inv.amountMinor, idempotencyKey: idemKey("release", inv.id) })`; look up the porteur wallet (`wallets WHERE accountId = ownerAccountId`); insert `walletEntries({ walletId, type: "disbursement", amountMinor: +inv.amountMinor, reference: inv.id })`; guarded `UPDATE investment SET status='released', resolutionRef=<ref>, resolvedAt=now() WHERE id=? AND status='escrowed'`. Guard makes a re-run a no-op (no double credit).

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/escrow-settle.test.ts
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "./helpers/db";
import { MockPaymentProvider } from "../src/lib/payments";
import { accounts, projects, investments, wallets, walletEntries } from "../src/db/schema";
import { settleDeposit, failDeposit } from "../src/modules/escrow/service";

async function seedPendingInvestment(db: any, opts: { targetMinor?: number; raisedMinor?: number; amount?: number } = {}) {
  const [inv1] = await db.insert(accounts).values({ email: "i@a.co", passwordHash: "x", firstName: "I", lastName: "A", country: "Togo", roles: ["investor"] }).returning();
  const [owner] = await db.insert(accounts).values({ email: "o@a.co", passwordHash: "x", firstName: "O", lastName: "A", country: "Togo", roles: ["porteur"] }).returning();
  await db.insert(wallets).values({ accountId: owner.id }); // porteur wallet for disbursement
  const [p] = await db.insert(projects).values({ ownerAccountId: owner.id, category: "commerce", title: "P", city: "L", description: "d", targetMinor: opts.targetMinor ?? 1000000, durationMonths: 6, roiPct: "16", fundsUsage: "u", cautionType: "a", status: "collecting", raisedMinor: opts.raisedMinor ?? 0 }).returning();
  const [inv] = await db.insert(investments).values({ projectId: p.id, investorAccountId: inv1.id, amountMinor: opts.amount ?? 50000, source: "payment", paymentRef: "dep-1", status: "pending" }).returning();
  return { pid: p.id, invId: inv.id, ownerId: owner.id };
}

describe("escrow settle/fail/release", () => {
  it("settling a pending deposit escrows it and advances raised_minor", async () => {
    await withTestDb(async (db) => {
      const payments = new MockPaymentProvider();
      const { pid, invId } = await seedPendingInvestment(db);
      const res = await settleDeposit(db, payments, { depositRef: "dep-1" });
      expect(res.applied).toBe(true);
      const [inv] = await db.select().from(investments).where(eq(investments.id, invId));
      expect(inv!.status).toBe("escrowed");
      const [p] = await db.select().from(projects).where(eq(projects.id, pid));
      expect(p!.raisedMinor).toBe(50000);
    });
  });

  it("settling twice is idempotent (raised advances once)", async () => {
    await withTestDb(async (db) => {
      const payments = new MockPaymentProvider();
      const { pid } = await seedPendingInvestment(db);
      await settleDeposit(db, payments, { depositRef: "dep-1" });
      const second = await settleDeposit(db, payments, { depositRef: "dep-1" });
      expect(second.applied).toBe(false);
      const [p] = await db.select().from(projects).where(eq(projects.id, pid));
      expect(p!.raisedMinor).toBe(50000);
    });
  });

  it("failing a pending deposit marks it failed and never touches raised", async () => {
    await withTestDb(async (db) => {
      const { pid, invId } = await seedPendingInvestment(db);
      const res = await failDeposit(db, { depositRef: "dep-1" });
      expect(res.applied).toBe(true);
      const [inv] = await db.select().from(investments).where(eq(investments.id, invId));
      expect(inv!.status).toBe("failed");
      const [p] = await db.select().from(projects).where(eq(projects.id, pid));
      expect(p!.raisedMinor).toBe(0);
    });
  });

  it("settling the final ticket funds the project and releases escrow to the porteur wallet", async () => {
    await withTestDb(async (db) => {
      const payments = new MockPaymentProvider();
      const { pid, invId, ownerId } = await seedPendingInvestment(db, { targetMinor: 50000, raisedMinor: 0, amount: 50000 });
      await settleDeposit(db, payments, { depositRef: "dep-1" });
      const [p] = await db.select().from(projects).where(eq(projects.id, pid));
      expect(p!.status).toBe("funded");
      const [inv] = await db.select().from(investments).where(eq(investments.id, invId));
      expect(inv!.status).toBe("released");
      const [w] = await db.select().from(wallets).where(eq(wallets.accountId, ownerId));
      const entries = await db.select().from(walletEntries).where(eq(walletEntries.walletId, w!.id));
      expect(entries.find((e: any) => e.type === "disbursement")?.amountMinor).toBe(50000);
    });
  });

  it("returns not-found for an unknown depositRef", async () => {
    await withTestDb(async (db) => {
      const payments = new MockPaymentProvider();
      const res = await settleDeposit(db, payments, { depositRef: "nope" });
      expect(res.found).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails** - `cd api && npm test -- escrow-settle` → FAIL (module not found).

- [ ] **Step 3: Implement `escrow/service.ts`.** Mirror the transaction + `.for("update")` + `balanceForWallet` idioms from `investments/service.ts` (read that file first). Key points:
  - `settleDeposit`: `const [inv] = await db.select().from(investments).where(eq(investments.paymentRef, args.depositRef))`. If none -> `{found:false, applied:false}`. Otherwise `db.transaction`: lock the project (`.for("update")`), re-read the investment status; if `project.status !== "collecting"` or `inv.status !== "pending"` -> return `{found:true, applied:false, projectStatus: project.status}`. Else guarded update to `escrowed` (set `settledAt: new Date()`), compute `newRaised = project.raisedMinor + inv.amountMinor`, `status = newRaised === project.targetMinor ? "funded" : project.status`, update project. Return `{found:true, applied:true, projectStatus:status}`. After commit, if `status === "funded"` call `await releaseProject(db, payments, { projectId })`.
  - `failDeposit`: find by depositRef; `db.transaction` guarded `pending -> failed` with `resolvedAt`. No project lock needed (raised untouched), but selecting then guarded-updating is enough.
  - `releaseProject`: `const escrowedInvs = await db.select().from(investments).where(and(eq(investments.projectId, projectId), eq(investments.status, "escrowed")))`. Load `ownerAccountId` from the project once. For each inv, `db.transaction`: call `payments.releaseEscrow(...)` with `idemKey("release", inv.id)`; find the porteur wallet row; insert the `disbursement` walletEntry; guarded `escrowed -> released` with `resolutionRef` + `resolvedAt`. Use `and`/`eq` from `drizzle-orm`.
  - Export `idemKey`, `settleDeposit`, `failDeposit`, `releaseProject`, and the `SettleResult` type.

- [ ] **Step 4: Run to verify it passes** - `cd api && npm test -- escrow-settle` → PASS.

- [ ] **Step 5: Full suite + typecheck** - `cd api && npm test` → all green (this task only adds the escrow service + its own test). `npm run typecheck` → clean.

- [ ] **Step 6: Commit** - `git add api && git commit -m "feat(api): escrow settle/fail/release service"`

---

### Task 4: Rework invest flow to two-phase escrow [MONEY CRUX, opus reviewer]

**Files:**
- Modify: `api/src/modules/investments/service.ts` (`createInvestment`)
- Modify: `api/src/modules/investments/routes.ts` (response shape)
- Modify: `api/src/lib/payments/index.ts` (REMOVE now-unused `collectFunds` + `CollectRequest`/`CollectResult` from interface and mock)
- Modify/Test: `api/tests/investment-invest.test.ts` (rewrite to escrow semantics)

**Interfaces:**
- Consumes: `settleDeposit` from `../escrow/service` (Task 3), `PaymentProvider.initiateDeposit` (Task 2).
- Produces: `createInvestment` returns `{ investmentId, amountMinor, status: "escrowed" | "pending", raisedMinor, projectStatus, depositRef }` (renames the old `paymentRef` return field to `depositRef`). Route `201` body carries the same shape.

- [ ] **Step 1: Rewrite the failing tests** in `investment-invest.test.ts`. Keep all the #4 guard tests (KYC 403, min-ticket 400, exceeds_remaining 409 + cap, insufficient_funds 400, concurrency serialization) but update assertions:
  - payment invest (default mock settled) -> `201`, `status: "escrowed"`, `raisedMinor` advanced, and the investment row status is `escrowed`.
  - wallet invest -> `201`, `status: "escrowed"`, negative `reinvestment` entry, `raisedMinor` advanced.
  - NEW pending case: build the app with a mock whose `depositMode = "pending"` and inject it; payment invest -> `201`, `status: "pending"`, `raisedMinor` UNCHANGED, investment row status `pending`.
  - payment_failed: inject a mock whose `initiateDeposit` returns `{ ok: false, ref: "", status: "settled" }`; assert `402 payment_failed`, NO investment row, `raisedMinor` unchanged.
  - The concurrency test: with the default settled mock, two overlapping invests still serialize to `[201, 409]`. Keep it.

  Injecting a pending-mode mock:
  ```ts
  import { MockPaymentProvider } from "../src/lib/payments";
  const pendingPayments = new MockPaymentProvider();
  pendingPayments.depositMode = "pending";
  const { app, db } = await buildTestApp({ payments: pendingPayments });
  ```

- [ ] **Step 2: Run to verify it fails** - `cd api && npm test -- investment-invest` → FAIL.

- [ ] **Step 3: Rework `createInvestment`.** Replace steps 4-7 of the current implementation:
  - Mint `investmentId = randomUUID()`.
  - `wallet` source (unchanged debit): lock wallet FOR UPDATE, check balance, insert negative `reinvestment` entry. Then insert the investment with `status: "escrowed"`, `paymentRef: null`. Advance `raised_minor` + funded flip IN THIS transaction (wallet settles instantly). Set `status: "escrowed"`, `depositRef: null` in the result. If it funded, trigger release AFTER the transaction commits (call `releaseProject`).
  - `payment` source: insert the investment with `status: "pending"`, `paymentRef: null` for now (updated to depositRef next). Do NOT advance raised here. Call `const dep = await payments.initiateDeposit({ accountId, amountMinor, method?, idempotencyKey: idemKey("deposit", investmentId) })`. If `!dep.ok` -> throw `PaymentFailedError` (rolls back the pending insert -> no investment row). Else `UPDATE investment SET paymentRef = dep.ref WHERE id = investmentId`. Commit the transaction. THEN, if `dep.status === "settled"`, call `await settleDeposit(db, payments, { depositRef: dep.ref })` (which does the escrow + raised++ + funded + release, all outside the invest transaction, under its own project lock). Read back the resulting project status / raised for the response, or return the values `settleDeposit` reports.

  IMPORTANT ordering to preserve atomicity semantics: the pending investment row and its depositRef are committed first; then settlement (settled mock) transitions it. On a mock this is synchronous and reads as one flow. Structure the function so the RETURN reflects post-settlement state for the settled case: `status: "escrowed"`, `raisedMinor` = the value after settlement, `projectStatus` from `settleDeposit`. For the pending case: `status: "pending"`, `raisedMinor` = the pre-settlement project raised (unchanged), `projectStatus` = "collecting", `depositRef: dep.ref`.

  Move the funded-release trigger for the WALLET path to run after the invest transaction commits (call `releaseProject(db, payments, { projectId })` when the wallet invest funded the project), so release never runs network I/O under the invest lock.

- [ ] **Step 4: Update the route** in `investments/routes.ts`: the `201` body is whatever `createInvestment` returns (already the new shape). Ensure `PaymentFailedError -> 402 payment_failed` mapping is intact. No new error codes.

- [ ] **Step 5: Remove `collectFunds`.** Delete `collectFunds` from the `PaymentProvider` interface and `MockPaymentProvider`, and delete `CollectRequest`/`CollectResult` if unused elsewhere (grep first: `grep -rn collectFunds api/src api/tests`). Update any remaining reference.

- [ ] **Step 6: Run to verify it passes** - `cd api && npm test -- investment-invest` → PASS. Then update the spec doc field note if needed.

- [ ] **Step 7: Full suite + typecheck** - `cd api && npm test` → all green (the invest flow now produces pending/escrowed, and the rewritten #4 tests assert the new two-phase semantics). `npm run typecheck` → clean.

- [ ] **Step 8: Commit** - `git add api && git commit -m "feat(api): two-phase escrow invest flow (pending/escrowed) + remove collectFunds"`

---

### Task 5: Settlement webhook route

**Files:**
- Create: `api/src/modules/escrow/routes.ts` (registers `POST /escrow/settlement`)
- Modify: `api/src/app.ts` (register `escrowRoutes`)
- Test: `api/tests/escrow-webhook.test.ts`

**Interfaces:**
- Consumes: `settleDeposit`, `failDeposit` (Task 3), `app.config.escrowWebhookSecret`, `app.payments`, `app.db`.
- Produces: `POST /escrow/settlement`, secret-verified via the `x-escrow-signature` header equal to `config.escrowWebhookSecret`. Body `{ depositRef: string, status: "settled" | "failed" }`.

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/escrow-webhook.test.ts (excerpt)
it("settles a pending deposit via the webhook and is idempotent", async () => {
  const { app, db } = await buildTestApp();
  // seed a pending payment investment on a collecting project (direct inserts) with paymentRef "dep-9"
  // ...
  const call = () => app.inject({ method: "POST", url: "/escrow/settlement",
    headers: { "x-escrow-signature": "test-secret" }, payload: { depositRef: "dep-9", status: "settled" } });
  const r1 = await call();
  expect(r1.statusCode).toBe(200);
  const r2 = await call();
  expect(r2.statusCode).toBe(200); // replay is a no-op
  // assert raised advanced exactly once
});
it("rejects a bad or missing secret with 401", async () => { /* no header -> 401; wrong header -> 401 */ });
it("returns 404 for an unknown depositRef", async () => { /* signed, depositRef "nope" -> 404 */ });
it("marks a deposit failed on status=failed and leaves raised untouched", async () => { /* -> 200, investment failed */ });
```

  The test config secret: `buildTestApp` must set `escrowWebhookSecret: "test-secret"` (see Task-agnostic note: update `tests/helpers/app.ts` config to include `escrowWebhookSecret: "test-secret"`).

- [ ] **Step 2: Run to verify it fails** - `cd api && npm test -- escrow-webhook` → FAIL.

- [ ] **Step 3: Implement the route.**
  - In `tests/helpers/app.ts`, add `escrowWebhookSecret: "test-secret"` to the config object passed to `buildApp` (match the existing config-building code there).
  - `escrow/routes.ts`: a Fastify plugin. `app.post("/escrow/settlement", async (req, reply) => { ... })`:
    - Read `const sig = req.headers["x-escrow-signature"]`. If `!app.config.escrowWebhookSecret || sig !== app.config.escrowWebhookSecret` -> `reply.code(401).send({ error: { code: "unauthorized", message: "bad signature" } })`.
    - Validate body: `depositRef` non-empty string, `status` in `{settled, failed}`; else `400 validation_error`.
    - `status === "failed"` -> `const res = await failDeposit(app.db, { depositRef })`; if `!res.found` -> `404 not_found`; else `200 { ok: true }`.
    - `status === "settled"` -> `const res = await settleDeposit(app.db, app.payments, { depositRef })`; if `!res.found` -> `404 not_found`; else `200 { ok: true, applied: res.applied, projectStatus: res.projectStatus }`.
  - Register in `app.ts`: `app.register(escrowRoutes)` near the other route registrations. Import at top.

- [ ] **Step 4: Run to verify it passes** - `cd api && npm test -- escrow-webhook` → PASS.

- [ ] **Step 5: Full suite + typecheck** - green + clean.

- [ ] **Step 6: Commit** - `git add api && git commit -m "feat(api): escrow settlement webhook (secret-verified, idempotent)"`

---

### Task 6: Admin cancel + refund routine

**Files:**
- Modify: `api/src/modules/escrow/service.ts` (`cancelAndRefund`)
- Modify: `api/src/modules/escrow/routes.ts` (add `POST /admin/projects/:id/cancel`, requireAdmin)
- Test: `api/tests/escrow-cancel.test.ts`

**Interfaces:**
- Produces: `cancelAndRefund(db, payments, { projectId }): Promise<void>` - under a project `FOR UPDATE` lock, guarded `collecting -> cancelled`; if the project was not `collecting`, throw `NotCollectingError` (reuse from investments/service, or define a local `InvalidStateError`). Then OUTSIDE the lock, for each `pending`/`escrowed` investment of the project, in its own transaction: if `source === "wallet"` insert a positive `refund` walletEntry to the investor wallet; if `source === "payment"` call `payments.refundEscrow({ depositRef: inv.paymentRef, amountMinor, idempotencyKey: idemKey("refund", inv.id) })`; if the investment was `escrowed`, decrement `raised_minor` by its amount under a project lock; guarded transition to `refunded` (+`resolutionRef` for payment, `resolvedAt`). `POST /admin/projects/:id/cancel` (requireAdmin) calls it.

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/escrow-cancel.test.ts (excerpt)
it("cancels a collecting project and refunds each investment to its source", async () => {
  const { app, db } = await buildTestApp();
  const adminCookie = await loginAsAdmin(app, db); // reuse the existing admin login helper pattern from kyc-admin tests
  // seed: collecting project; one wallet-source escrowed investment (investor wallet credited back);
  // one payment-source escrowed investment (refundEscrow called); one payment-source pending investment.
  const r = await app.inject({ method: "POST", url: `/admin/projects/${pid}/cancel`, cookies: { kpital_sess: adminCookie } });
  expect(r.statusCode).toBe(200);
  // project cancelled; each investment refunded; wallet-source investor has a +refund entry; raised decremented to 0.
});
it("re-cancelling a cancelled project returns 409 invalid_state", async () => { /* ... */ });
it("rejects a non-admin caller with 403", async () => { /* ... */ });
```

  Look at `api/tests/kyc-admin.test.ts` for the exact admin-login helper and cookie name; reuse it. If none is exported, seed an admin account + login inline as those tests do.

- [ ] **Step 2: Run to verify it fails** - `cd api && npm test -- escrow-cancel` → FAIL.

- [ ] **Step 3: Implement.**
  - `cancelAndRefund` in `escrow/service.ts`: `db.transaction` -> lock project `.for("update")`; if `project.status !== "collecting"` throw the invalid-state error; else update to `cancelled`. After commit: `const invs = await db.select().from(investments).where(and(eq(investments.projectId, projectId), inArray(investments.status, ["pending","escrowed"])))` (`inArray` from drizzle-orm). For each inv, `db.transaction`: branch on `inv.source`; wallet -> find investor wallet, insert `walletEntries({ walletId, type: "refund", amountMinor: +inv.amountMinor, reference: inv.id })`; payment -> `await payments.refundEscrow({ depositRef: inv.paymentRef ?? "", amountMinor: inv.amountMinor, idempotencyKey: idemKey("refund", inv.id) })`. If `inv.status === "escrowed"`, lock the project row and `raised_minor = raised_minor - amount` (use `sql` decrement or read-modify-write under the lock). Guarded `UPDATE investment SET status='refunded', resolutionRef=<ref or null>, resolvedAt=now() WHERE id=? AND status IN ('pending','escrowed')`.
  - Route in `escrow/routes.ts`: `app.post("/admin/projects/:id/cancel", { preHandler: app.requireAdmin }, async (req, reply) => { try { await cancelAndRefund(app.db, app.payments, { projectId: req.params.id }); return reply.code(200).send({ ok: true }); } catch (e) { if (e instanceof <InvalidState>) return reply.code(409).send({ error: { code: "invalid_state", message: "project is not collecting" } }); throw e; } })`. (Validate `:id` is a UUID first, mirroring `investments/routes.ts`, returning 404 for a non-UUID.)

- [ ] **Step 4: Run to verify it passes** - `cd api && npm test -- escrow-cancel` → PASS.

- [ ] **Step 5: Full suite + typecheck** - green + clean.

- [ ] **Step 6: Commit** - `git add api && git commit -m "feat(api): admin cancel + escrow refund to source"`

---

### Task 7: Expose investment status on GET /me/investments

**Files:**
- Modify: `api/src/modules/investments/service.ts` (`listMyInvestments` / `MyInvestment`)
- Test: `api/tests/investment-mine.test.ts` (extend)

**Interfaces:**
- Produces: each `/me/investments` item gains a top-level `status` field (`pending|escrowed|released|refunded|failed`). Project summary projection unchanged (still no PII).

- [ ] **Step 1: Extend the failing test** - after an invest, assert `mine.json().investments[0].status` is `"escrowed"` (default settled mock). Add a case: a pending-mode invest shows `status: "pending"`.

- [ ] **Step 2: Run to verify it fails** - `cd api && npm test -- investment-mine` → FAIL.

- [ ] **Step 3: Implement** - add `status: investments.status` to the selected columns in `listMyInvestments`, and `status` to the `MyInvestment` interface and the returned object shape.

- [ ] **Step 4: Run to verify it passes** - `cd api && npm test -- investment-mine` → PASS.

- [ ] **Step 5: Full suite + typecheck** - green + clean.

- [ ] **Step 6: Commit** - `git add api && git commit -m "feat(api): expose investment status on /me/investments"`

---

## Self-review notes

- **Spec coverage:** state machine + audit columns + cancelled/entry types (T1); provider deposit/release/refund + secret (T2); settle/fail/release service with guarded idempotent transitions + release-outside-lock (T3); two-phase invest rework + pending/escrowed/402 + collectFunds removal (T4); settlement webhook secret-verified + idempotent + 401/404/failed (T5); admin cancel + refund-to-source + raised decrement + 409/403 (T6); investment status on /me/investments (T7). Security section: accountId from session (T4/T7), webhook via depositRef only + secret (T5), KYC gate preserved (T4), no-overfund FOR UPDATE + CHECK preserved (T3/T4), no network I/O under lock (T3 release, T6 refund), release to porteur wallet (T3).
- **Deferred to #6 / real-partner integration (documented in spec):** repayment lifecycle (funded->repaying->closed, ROI distributions); collection deadline auto-expiry; admin disbursement gate; late-settlement-refund for a deposit that settles after the project left `collecting` under TRUE async concurrency (mock settles synchronously so this cannot arise in #5; `settleDeposit`'s `project.status==="collecting"` guard makes such a late settlement a safe no-op, and admin-cancel already refunds pending deposits).
- **Money-crux tasks:** T3 and T4 get an OPUS reviewer; final whole-branch review is opus. The genuine two-transaction concurrency test from #4 stays green (T4) and a settle-twice idempotency test proves the guard (T3).
- **Type consistency:** `idemKey(op, id)`, `settleDeposit`/`failDeposit`/`releaseProject`/`cancelAndRefund`, `DepositRequest/DepositResult/ReleaseRequest/RefundRequest/EscrowMoveResult`, result field renamed `paymentRef -> depositRef` in the invest response (T4). `depositMode` on the mock (T2) drives the pending tests (T4/T5/T7).
- **Migration risk:** T1 flags that `ALTER TYPE ... ADD VALUE` may need to be split into its own migration if the runner wraps migrations in a transaction; the fix (a `0012` for the ADD VALUEs) is spelled out. Verified by the full suite in T1 Step 6.
