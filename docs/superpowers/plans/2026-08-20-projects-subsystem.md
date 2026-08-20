# Projects + Showcase Sub-system Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project lifecycle: porteur submission (+ docs), admin moderation + A-D scoring, and two mutually-exclusive public surfaces — Showcase (discovery: follow/upvote/notify) in the pre-collection phase and the Funding catalog once collection is open. Real investing is sub-system #4.

**Architecture:** Builds on the Foundation + KYC (`api/`, Fastify DI `buildApp({db,config,notifier?,payments?,storage?,verifier?})`, `requireAuth`/`requireAdmin`, `withTestDb`+`buildTestApp` returning `{app,db,sentCodes,sentLinks,storage}`, uniform error envelope, `StorageProvider`/MinIO, KYC's `sniffMime`/`extForMime` magic-byte validation, timestamptz). Adds `project`/`project_document`/`project_follow`/`project_upvote` tables and porteur/public/engagement/admin routes.

**Tech Stack:** Node/TypeScript/Fastify/Drizzle/Postgres, `@fastify/multipart` (already installed), MinIO via the existing `StorageProvider`, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-20-projects-design.md`

## Global Constraints

- TypeScript strict, ESM (extensionless imports). HTTP tests use `buildTestApp()`, service tests use `withTestDb`. Run `cd api && npm test` (currently 78 passing) + `npm run typecheck` after each task; keep green.
- Uniform error envelope `{ error: { code, message } }`. New codes: `invalid_state` (409) for bad state transitions, plus existing `validation_error`/`forbidden`/`not_found`.
- One project entity, TWO mutually-exclusive public surfaces: Showcase = status `showcase` only; Funding = status `collecting` only. A project is publicly visible only in states `showcase|collecting|funded|repaying|closed`; `draft|submitted|in_review|rejected` are owner+admin only. NEVER expose private documents (rccm/foncier/releves) or porteur PII on public routes.
- Files: reuse KYC's `sniffMime`/`extForMime` (jpg/png/pdf, magic bytes) + size ≤ `config.kycMaxFileMb*1024*1024`. Photos → `visibility=public`; rccm/foncier/releves → `visibility=private`. Storage keys server-generated `projects/{projectId}/{docId}.{ext}` (never client filename) via `app.storage`.
- Money amounts integer minor units (`target_minor` bigint). Timestamps `timestamptz`. New migration under `api/drizzle/` per table-adding task.
- Authorization: create requires the `porteur` role (403 otherwise); a porteur may edit/submit/add-docs only to their OWN projects (owner = `req.accountId`, never a body field); admin routes behind `[app.requireAuth, app.requireAdmin]`.
- Regulatory guardrail: upvotes/follows are engagement signals only — the Funding catalog is NEVER ordered by upvotes.
- Every task ends green + committed on branch `projects-subsystem` (do not push).

---

### Task 1: Schema + migration (project, project_document, follow, upvote)

**Files:**
- Modify: `api/src/db/schema.ts`; regenerate migration under `api/drizzle/`
- Test: `api/tests/project-schema.test.ts`

**Interfaces:**
- Produces: enums `project_category`(immobilier|commerce|agriculture), `project_status`(draft|submitted|in_review|rejected|showcase|collecting|funded|repaying|closed), `project_score`(A|B|C|D), `project_doc_kind`(rccm|foncier|releves|photo), `project_doc_visibility`(public|private); tables `projects`, `projectDocuments`, `projectFollows`, `projectUpvotes`.

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/project-schema.test.ts
import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db";
import { accounts, projects } from "../src/db/schema";
describe("project", () => {
  it("defaults to draft and links an owner", async () => {
    await withTestDb(async (db) => {
      const [a] = await db.insert(accounts).values({ email:"p@a.co", passwordHash:"x",
        firstName:"P", lastName:"A", country:"Togo", roles:["porteur"] }).returning();
      const [p] = await db.insert(projects).values({ ownerAccountId: a!.id, category:"commerce",
        title:"Boutique", city:"Lomé", description:"d", targetMinor: 1500000, durationMonths: 6,
        roiPct: "16", fundsUsage:"stock", cautionType:"aval" }).returning();
      expect(p!.status).toBe("draft");
      expect(p!.upvoteCount).toBe(0);
    });
  });
});
```

- [ ] **Step 2: Add schema + regenerate, run** `npm test -- project-schema` → FAIL then implement:

```ts
// append to api/src/db/schema.ts (import numeric, integer if missing)
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
```
(Import `numeric`, `integer`, `primaryKey` from `drizzle-orm/pg-core` as needed.) Run `npx drizzle-kit generate`.

- [ ] **Step 3/4:** `npm test -- project-schema` → PASS.
- [ ] **Step 5: Commit** — `git add api && git commit -m "feat(api): project + document + follow + upvote schema + migration"`

---

### Task 2: Porteur project service + routes (create/update/submit/mine)

**Files:**
- Create: `api/src/modules/projects/service.ts`, `api/src/modules/projects/routes.ts`; register routes in `api/src/app.ts`
- Test: `api/tests/project-porteur.test.ts`

**Interfaces:**
- Consumes: `projects` table, `requireAuth`, `accounts.roles`.
- Produces: `createProject(db, ownerId, input)`; `updateProject(db, ownerId, id, patch)` (only if owner + status ∈ {draft,rejected}, else throws); `submitProject(db, ownerId, id)` (draft|rejected → submitted); `listMine(db, ownerId)`. Routes: `POST /projects`, `PATCH /projects/:id`, `POST /projects/:id/submit`, `GET /projects/mine` (all `requireAuth`; create requires the `porteur` role → else `403 forbidden`; non-owner or bad state → `403 forbidden`/`409 invalid_state`).

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/project-porteur.test.ts
import { describe, it, expect } from "vitest";
import { buildTestApp, loginAs } from "./helpers/app";
import { accounts } from "../src/db/schema";
import { eq } from "drizzle-orm";
const body = { category:"commerce", title:"Boutique", city:"Lomé", description:"d",
  targetMinor:1500000, durationMonths:6, roiPct:16, fundsUsage:"stock", cautionType:"aval" };
describe("porteur projects", () => {
  it("porteur creates a draft, edits, submits", async () => {
    const { app, db } = await buildTestApp();
    const cookie = await loginAs(app, "p@a.co");
    await db.update(accounts).set({ roles:["investor","porteur"] }).where(eq(accounts.email,"p@a.co"));
    const c = await app.inject({ method:"POST", url:"/projects", cookies:{ kpital_sess: cookie }, payload: body });
    expect(c.statusCode).toBe(201);
    const id = c.json().id;
    const s = await app.inject({ method:"POST", url:`/projects/${id}/submit`, cookies:{ kpital_sess: cookie } });
    expect(s.statusCode).toBe(200);
    const mine = await app.inject({ method:"GET", url:"/projects/mine", cookies:{ kpital_sess: cookie } });
    expect(mine.json().projects[0].status).toBe("submitted");
  });
  it("a non-porteur cannot create", async () => {
    const { app } = await buildTestApp();
    const cookie = await loginAs(app, "i@a.co"); // default role ["investor"]
    const c = await app.inject({ method:"POST", url:"/projects", cookies:{ kpital_sess: cookie }, payload: body });
    expect(c.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2:** `npm test -- project-porteur` → FAIL.

- [ ] **Step 3: Implement.** `service.ts`: validate the body (enums, positive integers), insert with `ownerAccountId=ownerId`, `status="draft"`. `updateProject` loads the row, throws `NotOwnerError`/`InvalidStateError` if owner≠ownerId or status ∉ {draft,rejected}, else applies an allowlist of editable fields + `updatedAt`. `submitProject` transitions draft|rejected→submitted (else `InvalidStateError`). `listMine` selects by owner. Routes map errors: role check for create (load `accounts.roles`, 403 if no `porteur`), `NotOwnerError`→403, `InvalidStateError`→409 invalid_state, validation→400. Register in `app.ts`.

- [ ] **Step 4:** `npm test -- project-porteur` → PASS (+ full suite green).
- [ ] **Step 5: Commit** — `git add api && git commit -m "feat(api): porteur project create/update/submit/mine"`

---

### Task 3: Project documents (multipart upload, public/private by kind)

**Files:**
- Modify: `api/src/modules/projects/routes.ts` (add `POST /projects/:id/documents`)
- Create: `api/src/modules/projects/documents.ts` (kind→visibility + store helper) if helpful
- Test: `api/tests/project-documents.test.ts`

**Interfaces:**
- Consumes: KYC's `sniffMime`/`extForMime` (`api/src/modules/kyc/validate.ts`), `app.storage`, `projectDocuments`.
- Produces: `POST /projects/:id/documents` (requireAuth, owner + status draft|rejected, multipart): one file + a `kind` field; validate magic-byte MIME + size; `visibility = kind === "photo" ? "public" : "private"`; mint docId; store at `projects/{projectId}/{docId}.{ext}`; insert `projectDocuments` row; reply `201 { documentId, kind, visibility }`.

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/project-documents.test.ts (buildTestApp + loginAs + buildMultipart from kyc-routes helper)
it("uploads a public photo and a private rccm", async () => {
  const { app, db, storage } = await buildTestApp();
  const cookie = await loginAs(app, "p@a.co");
  await db.update(accounts).set({ roles:["porteur"] }).where(eq(accounts.email,"p@a.co"));
  const id = (await app.inject({ method:"POST", url:"/projects", cookies:{kpital_sess:cookie}, payload: body })).json().id;
  const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3]);
  const form = buildMultipart({ fields:{ kind:"photo" }, files:[{name:"file", filename:"p.png", contentType:"image/png", data: png }] });
  const r = await app.inject({ method:"POST", url:`/projects/${id}/documents`, cookies:{kpital_sess:cookie}, headers: form.headers, payload: form.body });
  expect(r.statusCode).toBe(201);
  expect(r.json().visibility).toBe("public");
  expect((storage as any).objects.size).toBe(1);
});
```

- [ ] **Step 2:** `npm test -- project-documents` → FAIL.

- [ ] **Step 3: Implement.** Reuse the KYC multipart pattern (drain any non-buffered part; NO early `return` inside the parts loop — flag + drain + return after; `fields`/`parts` limits already global). Buffer the single file, read the `kind` field, `sniffMime`→400 on null, size→400, owner+state check first. Set `visibility` from `kind`. Store + insert. (`extForMime` gives the extension.)

- [ ] **Step 4:** `npm test -- project-documents` → PASS.
- [ ] **Step 5: Commit** — `git add api && git commit -m "feat(api): project document upload with public/private visibility"`

---

### Task 4: Public surfaces (showcase, funding, detail)

**Files:**
- Modify: `api/src/modules/projects/routes.ts` (public routes)
- Test: `api/tests/project-public.test.ts`

**Interfaces:**
- Produces: `GET /projects/showcase` (status=showcase only), `GET /projects/funding` (status=collecting only), `GET /projects/:id` (any publicly-visible status). All return a PUBLIC projection (no ownerAccountId/PII, no private docs); detail includes `documents[]` for PUBLIC (photo) docs only, each with `app.storage.getSignedUrl(key, config.kycUrlTtlSeconds)`, plus `upvoteCount`/`followCount`/`status`/`score`.

- [ ] **Step 1: Write the failing test** (seed projects at various statuses directly via db, assert surface separation):

```ts
it("showcase and funding surfaces are mutually exclusive; private docs never public", async () => {
  const { app, db } = await buildTestApp();
  const [owner] = await db.insert(accounts).values({ email:"o@a.co", passwordHash:"x", firstName:"O", lastName:"A", country:"Togo", roles:["porteur"] }).returning();
  const [showP] = await db.insert(projects).values({ ownerAccountId: owner!.id, category:"commerce", title:"Show", city:"L", description:"d", targetMinor:1000000, durationMonths:6, roiPct:"16", fundsUsage:"u", cautionType:"a", status:"showcase" }).returning();
  const [fundP] = await db.insert(projects).values({ ownerAccountId: owner!.id, category:"immobilier", title:"Fund", city:"L", description:"d", targetMinor:2000000, durationMonths:12, roiPct:"12", fundsUsage:"u", cautionType:"a", status:"collecting" }).returning();
  const sc = await app.inject({ method:"GET", url:"/projects/showcase" });
  expect(sc.json().projects.map((p:any)=>p.id)).toEqual([showP!.id]); // only showcase
  const fu = await app.inject({ method:"GET", url:"/projects/funding" });
  expect(fu.json().projects.map((p:any)=>p.id)).toEqual([fundP!.id]); // only collecting
  const det = await app.inject({ method:"GET", url:`/projects/${showP!.id}` });
  expect(det.json().project).not.toHaveProperty("ownerAccountId");
});
```

- [ ] **Step 2:** `npm test -- project-public` → FAIL.

- [ ] **Step 3: Implement.** A `PUBLIC_PROJECT_COLUMNS` projection (id, category, title, city, quartier, description, targetMinor, durationMonths, roiPct, status, score, upvoteCount, followCount, publishedAt, createdAt — NOT ownerAccountId/reviewedBy/rejectReason). `showcase` filters `status=showcase`; `funding` filters `status=collecting`; both paginated + a deterministic sort (funding: by `publishedAt`/`score`, NEVER by upvoteCount). Detail: 404 unless status ∈ public set; join `projectDocuments` where `visibility=public` only, build signed URLs.

- [ ] **Step 4:** `npm test -- project-public` → PASS.
- [ ] **Step 5: Commit** — `git add api && git commit -m "feat(api): public showcase/funding/detail surfaces"`

---

### Task 5: Engagement (follow, upvote, my-state)

**Files:**
- Modify: `api/src/modules/projects/routes.ts`
- Test: `api/tests/project-engagement.test.ts`

**Interfaces:**
- Produces: `POST /projects/:id/follow` / `DELETE .../follow` / `POST /projects/:id/upvote` / `DELETE .../upvote` (all requireAuth, idempotent, unique per account); `GET /projects/:id/me` (`{ following, upvoted }`). Counter updates are ATOMIC in one transaction with the insert/delete (insert-on-conflict-do-nothing + increment only when a row was actually inserted; same for delete). Follow allowed while the project is publicly visible; upvote allowed only while `status=showcase`.

- [ ] **Step 1: Write the failing test**

```ts
it("upvote is unique and idempotent and moves the counter", async () => {
  const { app, db } = await buildTestApp();
  const [owner] = await db.insert(accounts).values({ email:"o@a.co", passwordHash:"x", firstName:"O", lastName:"A", country:"Togo", roles:["porteur"] }).returning();
  const [p] = await db.insert(projects).values({ ownerAccountId: owner!.id, category:"commerce", title:"S", city:"L", description:"d", targetMinor:1000000, durationMonths:6, roiPct:"16", fundsUsage:"u", cautionType:"a", status:"showcase" }).returning();
  const cookie = await loginAs(app, "u@a.co");
  await app.inject({ method:"POST", url:`/projects/${p!.id}/upvote`, cookies:{kpital_sess:cookie} });
  await app.inject({ method:"POST", url:`/projects/${p!.id}/upvote`, cookies:{kpital_sess:cookie} }); // idempotent
  const me = await app.inject({ method:"GET", url:`/projects/${p!.id}/me`, cookies:{kpital_sess:cookie} });
  expect(me.json().upvoted).toBe(true);
  const det = await app.inject({ method:"GET", url:`/projects/${p!.id}` });
  expect(det.json().project.upvoteCount).toBe(1); // not 2
});
```

- [ ] **Step 2:** `npm test -- project-engagement` → FAIL.

- [ ] **Step 3: Implement.** Follow/upvote: `db.transaction` → `insert(...).onConflictDoNothing().returning()`; if a row was returned (newly inserted), `update projects set upvoteCount = upvoteCount + 1` (SQL expression). Delete: `delete(...).returning()`; if a row was returned, decrement. This keeps the counter exact and idempotent. `GET /me` selects both membership rows. Upvote route 409/400 if status≠showcase.

- [ ] **Step 4:** `npm test -- project-engagement` → PASS.
- [ ] **Step 5: Commit** — `git add api && git commit -m "feat(api): project follow/upvote engagement with atomic counters"`

---

### Task 6: Admin moderation (queue, detail+signed+audit, decision, open-collection+notify)

**Files:**
- Create: `api/src/modules/projects/admin-routes.ts`; register in `api/src/app.ts`
- Test: `api/tests/project-admin.test.ts`

**Interfaces:**
- Consumes: `requireAuth`+`requireAdmin`, `projects`/`projectDocuments`/`projectFollows`/`accounts`, `app.storage`, `app.notifier`.
- Produces: `GET /admin/projects?status=in_review` (metadata queue); `GET /admin/projects/:id` (detail + ALL documents with signed URLs incl. private + audit log `{adminId, projectId, action:"project_view"}`); `POST /admin/projects/:id/decision` (`{decision:"approve", score}` → status=showcase + score + publishedAt + reviewedBy/At, valid only from submitted|in_review; `{decision:"reject", reason}` → rejected + reason; reject requires non-empty reason → else 400); `POST /admin/projects/:id/open-collection` (showcase → collecting + collectingOpenedAt, valid only from showcase; then notify all followers via `app.notifier.send`). Invalid transitions → `409 invalid_state`.

- [ ] **Step 1: Write the failing test**

```ts
it("admin approves+scores → showcase, then opens collection → collecting + notifies followers", async () => {
  const { app, db, sentCodes } = await buildTestApp(); // capturing notifier available
  const porteur = await loginAs(app, "p@a.co");
  await db.update(accounts).set({ roles:["porteur"] }).where(eq(accounts.email,"p@a.co"));
  const id = (await app.inject({ method:"POST", url:"/projects", cookies:{kpital_sess:porteur}, payload: body })).json().id;
  await app.inject({ method:"POST", url:`/projects/${id}/submit`, cookies:{kpital_sess:porteur} });
  const follower = await loginAs(app, "f@a.co");
  const admin = await loginAs(app, "admin@a.co");
  await db.update(accounts).set({ isAdmin: true }).where(eq(accounts.email,"admin@a.co"));
  const dec = await app.inject({ method:"POST", url:`/admin/projects/${id}/decision`, cookies:{kpital_sess:admin}, payload:{ decision:"approve", score:"B" } });
  expect(dec.statusCode).toBe(200);
  // follower follows the now-showcased project, then admin opens collection
  await app.inject({ method:"POST", url:`/projects/${id}/follow`, cookies:{kpital_sess:follower} });
  const open = await app.inject({ method:"POST", url:`/admin/projects/${id}/open-collection`, cookies:{kpital_sess:admin} });
  expect(open.statusCode).toBe(200);
  // project now only on /projects/funding, not /projects/showcase
  const fu = await app.inject({ method:"GET", url:"/projects/funding" });
  expect(fu.json().projects.map((p:any)=>p.id)).toContain(id);
});
```
(Add a non-admin→403 test and a reject-without-reason→400 test.)

- [ ] **Step 2:** `npm test -- project-admin` → FAIL.

- [ ] **Step 3: Implement** the four admin routes behind `[app.requireAuth, app.requireAdmin]`. Decision + open-collection each in one `db.transaction`, guarded by the current status (`.where(and(eq(id), eq(status, expected)))` with `.returning()`; no row → `InvalidStateError` → 409, rolled back). open-collection, after committing, loads the project's followers (`projectFollows` join `accounts` for contact) and calls `app.notifier.send(...)` per follower with a "collection open" message. Detail builds signed URLs for ALL docs (private included) and emits the audit line. Never return `password_hash`; list is metadata only.

- [ ] **Step 4:** `npm test -- project-admin` → PASS (+ full suite green + typecheck).
- [ ] **Step 5: Commit** — `git add api && git commit -m "feat(api): admin project moderation, scoring, open-collection + follower notify"`

---

## Self-review notes

- **Spec coverage:** schema+migration (T1), porteur create/edit/submit/mine + role gate (T2), documents public/private (T3), the TWO mutually-exclusive public surfaces + detail projection (T4), engagement follow/upvote/me atomic+unique (T5), admin queue/detail-signed-audit/decision-score/open-collection-notify (T6). Security (owner checks, admin gating, private docs never public, no PII leak, regulatory no-upvote-ranking) lands across T2/T3/T4/T5/T6.
- **Deferred (spec §1):** real investing (#4), comments, automated scoring engine (manual admin now), funded/repaying/closed financial lifecycle (#5).
- **Ordering:** each task green before the next; schema additive with one migration (T1); routes registered incrementally in app.ts.
