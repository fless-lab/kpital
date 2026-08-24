# Collections (Late/Default) Sub-system Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect overdue repayment installments, remind the porteur, and move a project to `defaulted` past a configurable grace period, all materialized by an idempotent admin-triggered sweep, with no monetary penalty (soft) behind an extensible `PenaltyPolicy` seam.

**Architecture:** `overdue` is a derived condition (a `#6` `due` installment whose `due_at < now`), not a stored state. A `runRepaymentSweep` service (the mock daily cron, triggered by an admin endpoint) materializes the lifecycle: reminders (once per installment, guarded by `reminded_at`), `repaying -> defaulted` past `DEFAULT_GRACE_DAYS`, and auto-recovery `defaulted -> repaying` when no grace-exceeded overdue installment remains. Notifications go to the porteur (reminders) and investors (default) via the existing notifier respecting `notification_pref`. A `PenaltyPolicy` (currently `NoPenaltyPolicy`, returns 0) is called per overdue installment so a future fee/interest plugs in without touching the cycle. No money moves in #7.

**Tech Stack:** Node/TypeScript/Fastify/Drizzle/Postgres, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-25-collections-design.md`

## Global Constraints

- TypeScript strict, ESM (extensionless imports). HTTP tests use `buildTestApp()`, service tests use `withTestDb`. Run `cd api && npm test` (currently 208 passing) + `npm run typecheck` after each task; keep green. NEVER run two suite-executing processes against the shared `kpital_test` DB at once.
- Uniform error envelope `{ error: { code, message, details? } }`. Reuse `invalid_state` (409), `forbidden` (403), `not_found` (404), `unauthorized` (401). No new codes.
- Money is integer minor units (FCFA). NO money moves in #7 (penalty = 0). `now = new Date()` (server); tests seed past `due_at` to drive time. `DEFAULT_GRACE_DAYS` default 30.
- NO em dashes anywhere in code, comments, strings, docs. Use commas, parentheses, colons.
- Idempotency / state integrity: every project transition is a GUARDED update (`WHERE status = <expected>`); reminders are guarded by `reminded_at IS NULL`. A re-run of the sweep does not re-notify or re-transition. Notifications run OUTSIDE the guard transaction (never fail the transition), respecting `notification_pref` (LEFT JOIN the pref, default `["email"]` when no pref row, empty array means opted out).
- accountId is ALWAYS `req.accountId`; admin routes are `requireAdmin`; `/repay` stays auth + owner. `overdue` is derived server-side, never from a body.
- Every task ends green + committed on branch `collections-subsystem` (do NOT push). Implementers OPUS. Reviewers sonnet EXCEPT Task 3 (the sweep, state-critical) = OPUS reviewer; final whole-branch review = opus.

---

### Task 1: Schema + migration + config

**Files:**
- Modify: `api/src/db/schema.ts` (add `reminded_at` to `repayment_installment`, `defaulted_at` to `project`, `defaulted` to `project_status`)
- Modify: `api/src/config/env.ts` (add `DEFAULT_GRACE_DAYS` -> `config.defaultGraceDays`)
- Create (generated): `api/drizzle/0015_*.sql`
- Test: `api/tests/collections-schema.test.ts`

**Interfaces:**
- Produces: `repaymentInstallments.remindedAt` (timestamptz null); `projects.defaultedAt` (timestamptz null); `project_status` value `defaulted`; `config.defaultGraceDays: number` (default 30).

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/collections-schema.test.ts
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "./helpers/db";
import { loadConfig } from "../src/config/env";
import { accounts, projects, repaymentInstallments } from "../src/db/schema";

describe("collections schema + config", () => {
  it("project accepts defaulted + defaulted_at, installment accepts reminded_at", async () => {
    await withTestDb(async (db) => {
      const [o] = await db.insert(accounts).values({ email: "o@a.co", passwordHash: "x",
        firstName: "O", lastName: "A", country: "Togo", roles: ["porteur"] }).returning();
      const [p] = await db.insert(projects).values({ ownerAccountId: o!.id, category: "commerce",
        title: "P", city: "L", description: "d", targetMinor: 1000000, durationMonths: 6, roiPct: "16",
        fundsUsage: "u", cautionType: "a", status: "defaulted", defaultedAt: new Date(), raisedMinor: 1000000 }).returning();
      expect(p!.status).toBe("defaulted");
      expect(p!.defaultedAt).not.toBeNull();
      const [ins] = await db.insert(repaymentInstallments).values({ projectId: p!.id, seq: 1,
        amountMinor: 100000, dueAt: new Date(), remindedAt: new Date() }).returning();
      expect(ins!.remindedAt).not.toBeNull();
    });
  });
  it("defaultGraceDays defaults to 30 and is overridable", () => {
    const base = { DATABASE_URL: "postgres://x", CORS_ORIGIN: "http://localhost",
      MINIO_ENDPOINT: "http://x", MINIO_ACCESS_KEY: "x", MINIO_SECRET_KEY: "x", MINIO_BUCKET: "x" };
    expect(loadConfig(base).defaultGraceDays).toBe(30);
    expect(loadConfig({ ...base, DEFAULT_GRACE_DAYS: "7" }).defaultGraceDays).toBe(7);
  });
});
```

- [ ] **Step 2: Run to verify it fails** - `cd api && npm test -- collections-schema` -> FAIL.

- [ ] **Step 3: Implement.**
  - `schema.ts`: in `projectStatus` pgEnum append `"defaulted"`: `["draft","submitted","in_review","rejected","showcase","collecting","funded","repaying","closed","cancelled","defaulted"]`. Add `defaultedAt: timestamp("defaulted_at", { withTimezone: true })` to the `projects` table. Add `remindedAt: timestamp("reminded_at", { withTimezone: true })` to the `repaymentInstallments` table.
  - `env.ts`: add `DEFAULT_GRACE_DAYS: z.coerce.number().int().positive().default(30)` to the zod schema; add `defaultGraceDays: number` to the `Config` interface; in `loadConfig` map `defaultGraceDays: e.DEFAULT_GRACE_DAYS`.
  - Generate: `cd api && DATABASE_URL="postgres://kpital:kpital@127.0.0.1:5544/kpital" npx drizzle-kit generate` (additive: `ALTER TYPE project_status ADD VALUE 'defaulted'`, two `ADD COLUMN`). Inspect the SQL is additive-only.

- [ ] **Step 4: Run to verify it passes** - `cd api && npm test -- collections-schema` -> PASS.
- [ ] **Step 5: Full suite + typecheck** - green + clean.
- [ ] **Step 6: Commit** - `git add api && git commit -m "feat(api): collections schema (defaulted, reminded_at, defaulted_at) + grace config"`

---

### Task 2: PenaltyPolicy seam

**Files:**
- Create: `api/src/lib/penalty/index.ts`
- Modify: `api/src/app.ts` (decorate `app.penalty`, accept `opts.penalty`)
- Modify: `api/src/types/fastify.d.ts` (or wherever `app.notifier`/`app.payments` are typed on FastifyInstance) - add `penalty: PenaltyPolicy`
- Modify: `api/tests/helpers/app.ts` (allow injecting `penalty`)
- Test: `api/tests/penalty-policy.test.ts`

**Interfaces:**
- Produces: `interface PenaltyPolicy { penaltyFor(args: { installmentId: string; amountMinor: number; daysLate: number }): number }`; `class NoPenaltyPolicy implements PenaltyPolicy` returning 0; `app.penalty: PenaltyPolicy` (default `new NoPenaltyPolicy()`); `buildApp({ penalty? })`.

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/penalty-policy.test.ts
import { describe, it, expect } from "vitest";
import { NoPenaltyPolicy } from "../src/lib/penalty";

describe("PenaltyPolicy", () => {
  it("NoPenaltyPolicy always returns 0", () => {
    const p = new NoPenaltyPolicy();
    expect(p.penaltyFor({ installmentId: "x", amountMinor: 100000, daysLate: 90 })).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails** - `cd api && npm test -- penalty-policy` -> FAIL.

- [ ] **Step 3: Implement.**
  - `lib/penalty/index.ts`:
    ```ts
    export interface PenaltyPolicy {
      // Penalty owed (integer FCFA) for a late installment. 0 today.
      penaltyFor(args: { installmentId: string; amountMinor: number; daysLate: number }): number;
    }
    export class NoPenaltyPolicy implements PenaltyPolicy {
      penaltyFor(): number {
        return 0;
      }
    }
    ```
  - `app.ts`: import `{ PenaltyPolicy, NoPenaltyPolicy }`; add `penalty?: PenaltyPolicy` to the `buildApp` opts type; `app.decorate("penalty", opts.penalty ?? new NoPenaltyPolicy());`. (Config-driven selection by a `PENALTY_POLICY` env var is deferred to the first real policy; #7 only provides the injectable default.)
  - Add `penalty: PenaltyPolicy` to the FastifyInstance module augmentation next to `notifier`/`payments` (grep `declare module "fastify"` or `interface FastifyInstance` to find it).
  - `tests/helpers/app.ts`: add `penalty?: PenaltyPolicy` to the `buildTestApp` opts and pass it through to `buildApp` (mirror the `payments` passthrough).

- [ ] **Step 4: Run to verify it passes** - `cd api && npm test -- penalty-policy` -> PASS.
- [ ] **Step 5: Full suite + typecheck** - green + clean.
- [ ] **Step 6: Commit** - `git add api && git commit -m "feat(api): PenaltyPolicy seam (NoPenaltyPolicy) injected on the app"`

---

### Task 3: runRepaymentSweep service [state-critical, opus reviewer]

**Files:**
- Create: `api/src/modules/collections/service.ts`
- Test: `api/tests/collections-sweep.test.ts`

**Interfaces:**
- Consumes: `Notifier` (`app.notifier`), `PenaltyPolicy` (`app.penalty`), `config.defaultGraceDays`, `config.notifyChannels`, `resolveEffectiveChannels` from `../../lib/notifier`, tables `projects`/`repaymentInstallments`/`investments`/`accounts`/`notificationPrefs`.
- Produces: `runRepaymentSweep(db, notifier, penalty, opts: { graceDays: number; notifyChannels: Channel[] }): Promise<{ remindersSent: number; defaulted: number; recovered: number }>`.

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/collections-sweep.test.ts (excerpt - implementer writes the full seeding)
// Helper: seed a repaying project (porteur + investor with notification pref rows)
// with N installments, controlling each due_at.
it("reminds the porteur once for an overdue installment (anti-spam)", async () => {
  // seed a repaying project, installment 1 due 5 days ago (< grace), reminded_at null.
  const r1 = await runRepaymentSweep(db, notifier, penalty, { graceDays: 30, notifyChannels: ["email"] });
  expect(r1.remindersSent).toBe(1);            // porteur notified once
  // reminded_at now set; a second sweep sends nothing new
  const r2 = await runRepaymentSweep(db, notifier, penalty, { graceDays: 30, notifyChannels: ["email"] });
  expect(r2.remindersSent).toBe(0);
});
it("defaults a project when an installment is overdue past the grace period", async () => {
  // installment due 40 days ago, grace 30 -> project repaying -> defaulted, defaulted_at set,
  // investors notified; re-sweep does not re-notify (defaulted guard).
});
it("does NOT default when overdue but within grace", async () => {
  // installment due 5 days ago, grace 30 -> reminded, project stays repaying.
});
it("recovers defaulted -> repaying once no grace-exceeded overdue installment remains", async () => {
  // a defaulted project whose overdue installment is now paid -> sweep -> repaying, defaulted_at null.
});
it("moves no money (NoPenaltyPolicy): no wallet entries created by a sweep", async () => {});
```

- [ ] **Step 2: Run to verify it fails** - `cd api && npm test -- collections-sweep` -> FAIL.

- [ ] **Step 3: Implement `collections/service.ts`.** Study `api/src/modules/projects/admin-routes.ts:183-211` for the notify-followers-respecting-prefs idiom and mirror it. Structure:
  - `const now = new Date();` `const graceCutoff = new Date(now.getTime() - opts.graceDays * 24 * 60 * 60 * 1000);` (installments with `due_at < graceCutoff` are grace-exceeded).
  - **Reminders.** Select installments joined to their project WHERE `repaymentInstallments.status = 'due'` AND `repaymentInstallments.dueAt < now` AND `repaymentInstallments.remindedAt IS NULL` AND `projects.status IN ('repaying','defaulted')`, projecting `{ installmentId, projectId, ownerAccountId }`. For each, in its own short transaction: guarded `UPDATE repayment_installment SET reminded_at = now WHERE id = ? AND reminded_at IS NULL`; if it changed a row, load the porteur contact + pref (`accounts` LEFT JOIN `notificationPrefs` on ownerAccountId), build the `to` via `resolveEffectiveChannels(channels ?? ["email"], opts.notifyChannels)`, and `notifier.send(to, { subject, body })` OUTSIDE the guard update is fine since the guard already committed (or send after the update in the same flow but do not let a send failure roll back the reminded_at: wrap the send in try/catch). Increment `remindersSent` per guarded row changed. Also call `penalty.penaltyFor({ installmentId, amountMinor, daysLate })` here (result 0, ignored) so the seam is exercised.
  - **Default.** Find distinct `projectId` of installments WHERE `status='due'` AND `dueAt < graceCutoff`, whose project is `repaying`. For each project: guarded `UPDATE project SET status='defaulted', defaulted_at=now, updated_at=now WHERE id=? AND status='repaying'` returning rows; if changed, notify the project's investors (distinct `investorAccountId` from `investments` WHERE `projectId` AND `status='released'`, LEFT JOIN prefs, resolveEffectiveChannels, notifier.send, in a try/catch), increment `defaulted`.
  - **Recovery.** Find projects `status='defaulted'` that have NO installment with `status='due'` AND `dueAt < graceCutoff`. For each: guarded `UPDATE project SET status='repaying', defaulted_at=NULL, updated_at=now WHERE id=? AND status='defaulted'`; increment `recovered` per row changed. (No notification on recovery.)
  - Return `{ remindersSent, defaulted, recovered }`. Use `and`/`eq`/`lt`/`isNull`/`inArray` from `drizzle-orm`.

- [ ] **Step 4: Run to verify it passes** - `cd api && npm test -- collections-sweep` -> PASS.
- [ ] **Step 5: Full suite + typecheck** - green + clean.
- [ ] **Step 6: Commit** - `git add api && git commit -m "feat(api): runRepaymentSweep (reminders, default, recovery)"`

---

### Task 4: Admin endpoints (sweep, default, undefault)

**Files:**
- Create: `api/src/modules/collections/routes.ts`
- Modify: `api/src/app.ts` (register `collectionsRoutes`)
- Test: `api/tests/collections-admin.test.ts`

**Interfaces:**
- Consumes: `runRepaymentSweep` (Task 3), `app.requireAdmin`, `app.notifier`, `app.penalty`, `app.config`.
- Produces: `POST /admin/repayment/sweep`; `POST /admin/projects/:id/default`; `POST /admin/projects/:id/undefault`.

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/collections-admin.test.ts (excerpt)
it("runs the sweep and returns a summary (admin only)", async () => {
  // seed an overdue-past-grace repaying project; POST /admin/repayment/sweep as admin
  // -> 200 { remindersSent, defaulted, recovered }; the project is now defaulted.
  // non-admin -> 403.
});
it("admin default guards repaying->defaulted (409 otherwise) and notifies investors", async () => {});
it("admin undefault guards defaulted->repaying (409 otherwise)", async () => {});
it("rejects a non-admin caller with 403 and a non-UUID id with 404", async () => {});
```

  Reuse the admin-login helper from `api/tests/kyc-admin.test.ts` (or seed an admin account + login inline as those tests do).

- [ ] **Step 2: Run to verify it fails** - `cd api && npm test -- collections-admin` -> FAIL.

- [ ] **Step 3: Implement `collections/routes.ts`** (mirror `escrow/routes.ts` admin-cancel for the `[requireAuth, requireAdmin]` preHandler + UUID validation + guarded transition + investor notify):
  - `POST /admin/repayment/sweep` (`preHandler: [app.requireAuth, app.requireAdmin]`): `const summary = await runRepaymentSweep(app.db, app.notifier, app.penalty, { graceDays: app.config.defaultGraceDays, notifyChannels: app.config.notifyChannels }); return reply.code(200).send(summary);`
  - `POST /admin/projects/:id/default` (`[requireAuth, requireAdmin]`): UUID-validate (`404` on non-UUID); load project (`404` if missing); guarded `UPDATE project SET status='defaulted', defaulted_at=now WHERE id=? AND status='repaying'` returning rows; if zero rows -> `409 invalid_state`; else notify investors (same idiom as the sweep) and `200 { ok: true }`.
  - `POST /admin/projects/:id/undefault` (`[requireAuth, requireAdmin]`): UUID-validate; load project; guarded `UPDATE project SET status='repaying', defaulted_at=NULL WHERE id=? AND status='defaulted'`; zero rows -> `409 invalid_state`; else `200 { ok: true }`.
  - Register `app.register(collectionsRoutes)` in `app.ts`.

- [ ] **Step 4: Run to verify it passes** - `cd api && npm test -- collections-admin` -> PASS.
- [ ] **Step 5: Full suite + typecheck** - green + clean.
- [ ] **Step 6: Commit** - `git add api && git commit -m "feat(api): admin sweep + default/undefault endpoints"`

---

### Task 5: /repay accepts defaulted + auto-recovery

**Files:**
- Modify: `api/src/modules/repayment/routes.ts` (POST /projects/:id/repay)
- Test: `api/tests/repayment-repay.test.ts` (extend) or `api/tests/collections-repay.test.ts` (new)

**Interfaces:**
- Consumes: existing `/repay` flow; a small `graceCutoff` computed from `config.defaultGraceDays`.
- Produces: `/repay` accepts a project in `repaying` OR `defaulted`; after a `settled` collection that leaves no grace-exceeded overdue installment, the project is lifted `defaulted -> repaying`.

- [ ] **Step 1: Write the failing test**

```ts
it("allows /repay on a defaulted project and auto-recovers it when the last overdue is cleared", async () => {
  // seed a defaulted project with one remaining due installment (overdue past grace),
  // porteur pays it (settled mock) -> installment paid; the project is lifted back to repaying.
});
it("keeps a project defaulted after /repay if another grace-exceeded installment remains", async () => {
  // two overdue-past-grace installments; pay one -> still defaulted.
});
```

- [ ] **Step 2: Run to verify it fails** - `cd api && npm test -- collections-repay` (or `repayment-repay`) -> FAIL.

- [ ] **Step 3: Implement.**
  - In `/repay`, change the state guard from `if (project.status !== "repaying")` to `if (project.status !== "repaying" && project.status !== "defaulted")` (both return `409 invalid_state` otherwise).
  - After phase 2 (the `settled` branch calls `settleRepayment`), if the project was `defaulted`, check for auto-recovery: `const graceCutoff = new Date(Date.now() - app.config.defaultGraceDays*24*60*60*1000);` select any installment of the project WHERE `status='due'` AND `dueAt < graceCutoff` LIMIT 1; if NONE remain, guarded `UPDATE project SET status='repaying', defaulted_at=NULL WHERE id=? AND status='defaulted'`. Do this BEFORE the final read-back so the response `projectStatus` reflects the recovery. (This mirrors the sweep's recovery step; both are guarded and idempotent.)

- [ ] **Step 4: Run to verify it passes** - `cd api && npm test -- collections-repay` -> PASS. Confirm the existing `repayment-repay.test.ts` still passes (a `repaying` project is unaffected).
- [ ] **Step 5: Full suite + typecheck** - green + clean.
- [ ] **Step 6: Commit** - `git add api && git commit -m "feat(api): /repay accepts defaulted projects with auto-recovery"`

---

### Task 6: Reads (overdue + remindedAt on the schedule)

**Files:**
- Modify: `api/src/modules/repayment/routes.ts` (GET /projects/:id/repayment-schedule)
- Test: `api/tests/repayment-reads.test.ts` (extend)

**Interfaces:**
- Produces: each installment in the schedule gains `overdue: boolean` (derived: `status === "due" && dueAt < now`) and `remindedAt` (timestamptz or null).

- [ ] **Step 1: Write the failing test**

```ts
it("exposes overdue + remindedAt per installment on the schedule", async () => {
  // owner seeds installments: one due in the past (overdue true), one due in the future (overdue false),
  // one paid (overdue false regardless of due_at); assert the flags + remindedAt passthrough.
});
```

- [ ] **Step 2: Run to verify it fails** - `cd api && npm test -- repayment-reads` -> FAIL.

- [ ] **Step 3: Implement.** In the schedule handler, also select `repaymentInstallments.remindedAt`, and map each row to add `overdue: row.status === "due" && row.dueAt.getTime() < Date.now()` and `remindedAt: row.remindedAt`. Keep the existing fields (`seq, amountMinor, dueAt, status, settledAt`) and the totals unchanged. No investor PII.

- [ ] **Step 4: Run to verify it passes** - `cd api && npm test -- repayment-reads` -> PASS.
- [ ] **Step 5: Full suite + typecheck** - green + clean.
- [ ] **Step 6: Commit** - `git add api && git commit -m "feat(api): expose overdue + remindedAt on the repayment schedule"`

---

## Self-review notes

- **Spec coverage:** schema/config (T1); PenaltyPolicy seam (T2); sweep reminders+default+recovery+penalty-hook (T3); admin sweep/default/undefault (T4); /repay accepts defaulted + auto-recovery (T5); overdue+remindedAt reads (T6). Security section: requireAdmin on sweep/default/undefault (T4), /repay auth+owner unchanged (T5), notifications respect notification_pref (T3/T4), no money moves (T3, penalty 0), guarded idempotent transitions (T3/T4/T5).
- **Deferred (spec section 11, to the NEXT design):** real caution/guarantee activation on default; non-zero penalty collection+distribution; fine reminder cadence (re-reminders); real scheduler wiring; and the still-open #5/#6 items (real provider integration, partial/early repayment = #8, rounding drift).
- **State-critical task:** T3 (the sweep) gets an OPUS reviewer (it materializes the default state machine + notifications and must be idempotent); final whole-branch review is opus. T3's idempotency rests on guarded transitions + `reminded_at IS NULL`.
- **Type consistency:** `runRepaymentSweep(db, notifier, penalty, { graceDays, notifyChannels })` -> `{ remindersSent, defaulted, recovered }`; `PenaltyPolicy.penaltyFor`, `NoPenaltyPolicy`, `app.penalty`; `config.defaultGraceDays`; `projects.defaultedAt`, `repaymentInstallments.remindedAt`, `project_status` value `defaulted`. The `/repay` recovery (T5) uses the same graceCutoff formula as the sweep (T3).
- **Migration:** T1 is the only migration (0015), additive (one enum ADD VALUE + two ADD COLUMN). The `ALTER TYPE ... ADD VALUE` for `defaulted` is not referenced in the same migration, so it applies cleanly in-transaction (same as #5's 0011).
