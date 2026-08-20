# KYC Sub-system Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an account submit identity documents (stored in MinIO/S3 behind a `StorageProvider` interface) and let an admin review them manually, driving `account.kyc_status`.

**Architecture:** Builds on the Foundation (`api/`, Fastify DI `buildApp({db,config,notifier?,payments?})`, `requireAuth`/`requireAdmin`, `withTestDb`+`buildTestApp` harness, uniform error envelope). Adds a `StorageProvider` (MinIO impl + in-memory fake), `kyc_submission`/`kyc_document` tables, multipart upload with magic-byte + size validation, and admin review via short-TTL signed URLs.

**Tech Stack:** Node/TypeScript/Fastify/Drizzle/Postgres, `@fastify/multipart`, MinIO (S3) via `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-20-kyc-design.md`

## Global Constraints

- TypeScript strict, ESM (extensionless imports in TS source). Tests via Vitest; HTTP tests use `buildTestApp()`, service tests use `withTestDb`. Run `cd api && npm test` (currently 44 passing) + `npm run typecheck` after each task; keep green.
- Uniform error envelope `{ error: { code, message } }`. Money/PII rules from the Foundation still apply.
- Files: allowed types jpg/png/pdf validated by MAGIC BYTES (not extension/Content-Type); size ≤ `config.kycMaxFileMb` (default 10). Per `doc_type`: `passeport` → exactly 1 `passport_page`; `cni`/`sejour` → exactly 2 (`front`+`back`).
- Storage keys are server-generated `kyc/{accountId}/{submissionId}/{kind}.{ext}` — NEVER the client filename. Bucket is private; documents are viewable only via short-TTL signed URLs, only by the owner or an admin.
- New migrations are versioned files under `api/drizzle/` (`npx drizzle-kit generate`, commit SQL+meta). Timestamps are `timestamptz` (`{ withTimezone: true }`).
- Every task ends green and committed on branch `kyc-subsystem` (do not push).

---

### Task 1: Config env (MinIO + KYC) and docker-compose MinIO service

**Files:**
- Modify: `api/src/config/env.ts` (add MinIO + KYC fields)
- Modify: `api/.env.example`, `docker-compose.yml` (add `kpital-minio`)
- Test: `api/tests/config.test.ts` (extend)

**Interfaces:**
- Produces: `Config` gains `minioEndpoint, minioAccessKey, minioSecretKey, minioBucket, minioRegion, kycUrlTtlSeconds, kycMaxFileMb`.

- [ ] **Step 1: Write the failing test** (append to config.test.ts)

```ts
it("parses MinIO + KYC config with defaults", () => {
  const c = loadConfig({ DATABASE_URL: "postgres://x", CORS_ORIGIN: "http://localhost:8080",
    MINIO_ENDPOINT: "http://127.0.0.1:9100", MINIO_ACCESS_KEY: "kpital",
    MINIO_SECRET_KEY: "kpital-secret", MINIO_BUCKET: "kpital-kyc" });
  expect(c.minioBucket).toBe("kpital-kyc");
  expect(c.kycUrlTtlSeconds).toBe(120);
  expect(c.kycMaxFileMb).toBe(10);
});
```

- [ ] **Step 2: Run** `cd api && npm test -- config` → FAIL.

- [ ] **Step 3: Implement.** In `env.ts` schema add: `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_BUCKET` (all `z.string().min(1)`), `MINIO_REGION` (default `"us-east-1"`), `KYC_URL_TTL_SECONDS` (coerce number, default 120), `KYC_MAX_FILE_MB` (coerce number, default 10). Map into `Config` (camelCase). Add the keys to `.env.example`. Add a `kpital-minio` service to `docker-compose.yml`:

```yaml
  kpital-minio:
    image: minio/minio
    container_name: kpital-minio
    restart: unless-stopped
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: kpital
      MINIO_ROOT_PASSWORD: kpital-secret
    ports: ["9100:9000", "9101:9001"]
    volumes: ["kpital_miniodata:/data"]
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 5s
      timeout: 3s
      retries: 10
```
Add `kpital_miniodata:` under top-level `volumes:`. (Bucket is created lazily by the app in Task 2 — no init container.)

- [ ] **Step 4: Run** `npm test -- config` → PASS.
- [ ] **Step 5: Commit** — `git add api docker-compose.yml && git commit -m "feat(api): MinIO + KYC config and compose service"`

---

### Task 2: StorageProvider interface + in-memory fake + MinioStorage

**Files:**
- Create: `api/src/lib/storage/index.ts` (interface + factory), `api/src/lib/storage/minio.ts`, `api/src/lib/storage/memory.ts`
- Test: `api/src/lib/storage/memory.test.ts`

**Interfaces:**
- Produces: `interface StorageProvider { put(key,body,contentType): Promise<void>; getSignedUrl(key,ttlSeconds): Promise<string>; delete(key): Promise<void> }`, `MemoryStorage` (test fake, exposes `objects: Map<string,{body:Buffer,contentType:string}>`), `MinioStorage` (S3 SDK; ensures bucket exists lazily), and `makeStorage(config): StorageProvider`.

- [ ] **Step 1: Write the failing test**

```ts
// api/src/lib/storage/memory.test.ts
import { describe, it, expect } from "vitest";
import { MemoryStorage } from "./memory";
describe("MemoryStorage", () => {
  it("puts, signs, and deletes", async () => {
    const s = new MemoryStorage();
    await s.put("k/1.png", Buffer.from("x"), "image/png");
    expect(s.objects.get("k/1.png")?.contentType).toBe("image/png");
    const url = await s.getSignedUrl("k/1.png", 60);
    expect(url).toContain("k/1.png");
    await s.delete("k/1.png");
    expect(s.objects.has("k/1.png")).toBe(false);
  });
});
```

- [ ] **Step 2:** `cd api && npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner` then `npm test -- memory` → FAIL.

- [ ] **Step 3: Implement.**

```ts
// api/src/lib/storage/index.ts
import type { Readable } from "node:stream";
export interface StorageProvider {
  put(key: string, body: Buffer | Readable, contentType: string): Promise<void>;
  getSignedUrl(key: string, ttlSeconds: number): Promise<string>;
  delete(key: string): Promise<void>;
}
import type { Config } from "../../config/env";
import { MinioStorage } from "./minio";
export function makeStorage(config: Config): StorageProvider { return new MinioStorage(config); }
```
```ts
// api/src/lib/storage/memory.ts
import type { StorageProvider } from "./index";
export class MemoryStorage implements StorageProvider {
  objects = new Map<string, { body: Buffer; contentType: string }>();
  async put(key: string, body: any, contentType: string) {
    this.objects.set(key, { body: Buffer.isBuffer(body) ? body : Buffer.from([]), contentType });
  }
  async getSignedUrl(key: string, ttl: number) { return `memory://signed/${key}?ttl=${ttl}`; }
  async delete(key: string) { this.objects.delete(key); }
}
```
`minio.ts`: an `S3Client` configured with `endpoint: config.minioEndpoint`, `forcePathStyle: true`, `region: config.minioRegion`, creds from config. `put` → `PutObjectCommand` (with `ServerSideEncryption: "AES256"`). `getSignedUrl` → `getSignedUrl(client, new GetObjectCommand(...), { expiresIn })`. `delete` → `DeleteObjectCommand`. On first use, ensure the bucket exists (`HeadBucket`, create on 404 via `CreateBucketCommand`) guarded by a once-promise. (No unit test hits real MinIO; `MinioStorage` is exercised manually / in a future integration check — note this in the report.)

- [ ] **Step 4:** `npm test -- memory` → PASS.
- [ ] **Step 5: Commit** — `git add api && git commit -m "feat(api): StorageProvider interface + MinIO impl + memory fake"`

---

### Task 3: DB schema — kyc_submission + kyc_document + migration

**Files:**
- Modify: `api/src/db/schema.ts`; regenerate migration under `api/drizzle/`
- Test: `api/tests/kyc-schema.test.ts`

**Interfaces:**
- Produces: `kycSubmissions`, `kycDocuments` tables + enums `kyc_sub_status` (pending|verified|rejected), `kyc_doc_kind` (front|back|passport_page), `kyc_doc_type` (cni|passeport|sejour).

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/kyc-schema.test.ts
import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db";
import { accounts, kycSubmissions } from "../src/db/schema";
describe("kyc_submission", () => {
  it("defaults to pending and links an account", async () => {
    await withTestDb(async (db) => {
      const [a] = await db.insert(accounts).values({ email: "k@a.co", passwordHash: "x",
        firstName: "K", lastName: "A", country: "Togo", roles: ["investor"] }).returning();
      const [s] = await db.insert(kycSubmissions).values({ accountId: a.id, docType: "cni",
        docNumber: "TG-1", dob: "1990-01-01", nationality: "Togolaise" }).returning();
      expect(s.status).toBe("pending");
    });
  });
});
```

- [ ] **Step 2:** regenerate + `npm test -- kyc-schema` → FAIL. Add to `schema.ts`:

```ts
export const kycDocType = pgEnum("kyc_doc_type", ["cni", "passeport", "sejour"]);
export const kycSubStatus = pgEnum("kyc_sub_status", ["pending", "verified", "rejected"]);
export const kycDocKind = pgEnum("kyc_doc_kind", ["front", "back", "passport_page"]);
export const kycSubmissions = pgTable("kyc_submission", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  docType: kycDocType("doc_type").notNull(),
  docNumber: text("doc_number").notNull(),
  dob: date("dob").notNull(),
  nationality: text("nationality").notNull(),
  status: kycSubStatus("status").notNull().default("pending"),
  rejectReason: text("reject_reason"),
  reviewedBy: uuid("reviewed_by").references(() => accounts.id),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  superseded: boolean("superseded").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const kycDocuments = pgTable("kyc_document", {
  id: uuid("id").defaultRandom().primaryKey(),
  submissionId: uuid("submission_id").notNull().references(() => kycSubmissions.id, { onDelete: "cascade" }),
  kind: kycDocKind("kind").notNull(),
  storageKey: text("storage_key").notNull(),
  mime: text("mime").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```
(Import `date` from `drizzle-orm/pg-core` if not already.) Run `npx drizzle-kit generate`.

- [ ] **Step 3/4:** `npm test -- kyc-schema` → PASS.
- [ ] **Step 5: Commit** — `git add api && git commit -m "feat(api): kyc_submission + kyc_document schema + migration"`

---

### Task 4: KYC service — validation + createSubmission + KycVerifier

**Files:**
- Create: `api/src/lib/kyc/verifier.ts` (`KycVerifier` + `ManualVerifier`), `api/src/modules/kyc/validate.ts` (magic-byte sniff + rules), `api/src/modules/kyc/service.ts`
- Test: `api/src/modules/kyc/validate.test.ts`, `api/src/modules/kyc/service.test.ts`

**Interfaces:**
- Consumes: `StorageProvider`, `kycSubmissions`/`kycDocuments`/`accounts`, `Db`, `withTestDb`.
- Produces: `sniffMime(buf): "image/jpeg"|"image/png"|"application/pdf"|null`; `expectedKinds(docType): KycDocKind[]`; `createSubmission(db, storage, input): Promise<{ submissionId: string }>` where `input = { accountId, docType, docNumber, dob, nationality, files: {kind, buffer, clientMime}[] }`; throws `KycValidationError` (bad count/mime/size). `getActiveSubmission(db, accountId)`.

- [ ] **Step 1: Write the failing tests.** `validate.test.ts`: `sniffMime` recognizes a PNG magic-byte buffer (`Buffer.from([0x89,0x50,0x4e,0x47,...])`) and returns null for garbage; `expectedKinds("passeport")` → `["passport_page"]`, `expectedKinds("cni")` → `["front","back"]`. `service.test.ts` (with `withTestDb` + `MemoryStorage`):

```ts
it("creates a pending submission, stores files, mirrors kyc_status", async () => {
  await withTestDb(async (db) => {
    const storage = new MemoryStorage();
    const [a] = await db.insert(accounts).values({ email:"k@a.co", passwordHash:"x",
      firstName:"K", lastName:"A", country:"Togo", roles:["investor"] }).returning();
    const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a, 1,2,3]);
    const { submissionId } = await createSubmission(db, storage, {
      accountId: a.id, docType:"cni", docNumber:"TG-1", dob:"1990-01-01", nationality:"Togolaise",
      files: [{kind:"front", buffer:png, clientMime:"image/png"}, {kind:"back", buffer:png, clientMime:"image/png"}] });
    const docs = await db.select().from(kycDocuments).where(eq(kycDocuments.submissionId, submissionId));
    expect(docs).toHaveLength(2);
    expect(storage.objects.size).toBe(2);
    const [acc] = await db.select().from(accounts).where(eq(accounts.id, a.id));
    expect(acc.kycStatus).toBe("pending");
  });
});
it("rejects wrong file count", async () => { /* cni with 1 file → rejects KycValidationError */ });
it("rejects a non-image buffer via magic bytes", async () => { /* clientMime image/png but garbage bytes → rejects */ });
```

- [ ] **Step 2:** `npm test -- kyc` → FAIL.

- [ ] **Step 3: Implement.** `validate.ts`: `sniffMime` checks leading bytes (JPEG `FF D8 FF`, PNG `89 50 4E 47 0D 0A 1A 0A`, PDF `25 50 44 46`). `expectedKinds`. `verifier.ts`: `interface KycVerifier { submitForReview(submissionId: string): Promise<void> }` + `class ManualVerifier { async submitForReview() {} }`. `service.ts` `createSubmission`:
  1. `expectedKinds(docType)` must equal the sorted set of provided `files[].kind` (exact count + kinds) else throw `KycValidationError("bad_file_set")`.
  2. For each file: `sniffMime(buffer)` must be non-null AND consistent (allowed set) else throw; `buffer.length <= maxBytes` else throw. (maxBytes passed in or read from config by the caller — accept `maxBytes` in input, default from config at the route.)
  3. Mint `submissionId = randomUUID()`. For each file: `key = kyc/${accountId}/${submissionId}/${kind}.${extFor(mime)}`; `await storage.put(key, buffer, mime)`.
  4. In ONE `db.transaction`: mark prior active submissions of this account `superseded=true`; insert the `kycSubmissions` row (id=submissionId, status pending); insert the `kycDocuments` rows; `update accounts set kycStatus="pending" where id=accountId`.
  5. `await verifier.submitForReview(submissionId)` (no-op) — or accept the verifier as a param; return `{ submissionId }`.
  (Uploads happen before the DB txn using the minted id; a DB failure leaves orphaned objects, acceptable — note it.)

- [ ] **Step 4:** `npm test -- kyc` → PASS.
- [ ] **Step 5: Commit** — `git add api && git commit -m "feat(api): kyc validation + createSubmission service + manual verifier"`

---

### Task 5: HTTP — storage DI, multipart, POST /kyc/submission, GET /kyc/me

**Files:**
- Modify: `api/src/app.ts` (register `@fastify/multipart`; add `storage?`/`verifier?` to `buildApp` opts, decorate `app.storage`), `api/src/server.ts`
- Create: `api/src/modules/kyc/routes.ts`
- Modify: `api/tests/helpers/app.ts` (`buildTestApp` injects `MemoryStorage`, returns it as `storage`)
- Test: `api/tests/kyc-routes.test.ts`

**Interfaces:**
- Consumes: `createSubmission`/`getActiveSubmission`, `requireAuth`, `StorageProvider`, `MemoryStorage`.
- Produces: `POST /kyc/submission` (auth, multipart) → `201 { submissionId, status }`; `GET /kyc/me` (auth) → `{ submission | null }` (+ signed URLs to the caller's own docs). `buildTestApp()` returns `{ app, db, sentCodes, sentLinks, storage }`.

- [ ] **Step 1: Write the failing test** (`kyc-routes.test.ts`, using `buildTestApp` + a multipart payload builder):

```ts
it("submits KYC docs and reads them back via /kyc/me", async () => {
  const { app, storage } = await buildTestApp();
  const cookie = await loginAs(app, "k@a.co");
  const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3]);
  const form = buildMultipart({ fields: { doc_type:"cni", doc_number:"TG-1", dob:"1990-01-01", nationality:"Togolaise" },
    files: [{ name:"front", filename:"f.png", contentType:"image/png", data: png },
            { name:"back", filename:"b.png", contentType:"image/png", data: png }] });
  const res = await app.inject({ method:"POST", url:"/kyc/submission", cookies:{ kpital_sess: cookie },
    headers: form.headers, payload: form.body });
  expect(res.statusCode).toBe(201);
  expect((storage as any).objects.size).toBe(2);
  const me = await app.inject({ method:"GET", url:"/kyc/me", cookies:{ kpital_sess: cookie } });
  expect(me.json().submission.status).toBe("pending");
});
```
(Provide a small `buildMultipart` helper in the test or `tests/helpers`.)

- [ ] **Step 2:** `cd api && npm i @fastify/multipart` then `npm test -- kyc-routes` → FAIL.

- [ ] **Step 3: Implement.** Register `@fastify/multipart` with limits (`fileSize = config.kycMaxFileMb*1024*1024`, `files = 2`). Add `storage`/`verifier` to `buildApp` opts (default `makeStorage(config)` / `new ManualVerifier()`), decorate `app.storage`. `POST /kyc/submission` (behind `requireAuth`): read the multipart parts, collect fields + files (buffer each with the size limit; map each file's form field name to a `kind`), then call `createSubmission(app.db, app.storage, {...})` mapping `KycValidationError` → `400 validation_error`. `GET /kyc/me` returns the caller's active submission (from `getActiveSubmission`) with a `documents[]` array each carrying a fresh `app.storage.getSignedUrl(key, config.kycUrlTtlSeconds)`. Extend `buildTestApp` to build a `MemoryStorage`, pass it to `buildApp`, and return it as `storage`.

- [ ] **Step 4:** `npm test -- kyc-routes` → PASS (+ full suite green).
- [ ] **Step 5: Commit** — `git add api && git commit -m "feat(api): kyc submission + /kyc/me endpoints with multipart + storage DI"`

---

### Task 6: Admin review — queue, detail (signed URLs + audit), decision (mirror)

**Files:**
- Create: `api/src/modules/kyc/admin-routes.ts`; register in `api/src/app.ts`
- Test: `api/tests/kyc-admin.test.ts`

**Interfaces:**
- Consumes: `requireAuth`+`requireAdmin`, `kycSubmissions`/`kycDocuments`/`accounts`, `StorageProvider`.
- Produces: `GET /admin/kyc?status=pending` (list), `GET /admin/kyc/:id` (submission + `documents[]` with signed URLs; logs an audit line `{adminId, submissionId, action:"view"}`), `POST /admin/kyc/:id/decision` `{ decision:"verified"|"rejected", reason? }` → updates submission (`status`, `reviewedBy`, `reviewedAt`, `rejectReason`) AND mirrors `account.kyc_status`, in one transaction; `rejected` requires a non-empty `reason` (else 400).

- [ ] **Step 1: Write the failing test** (`buildTestApp` + `loginAs`; promote an admin via direct `db.update`):

```ts
it("admin verifies a submission and mirrors kyc_status", async () => {
  const { app, db, storage } = await buildTestApp();
  const userCookie = await loginAs(app, "u@a.co");
  // ...submit KYC as the user (reuse the multipart helper)...
  const adminCookie = await loginAs(app, "admin@a.co");
  await db.update(accounts).set({ isAdmin: true }).where(eq(accounts.email, "admin@a.co"));
  const list = await app.inject({ method:"GET", url:"/admin/kyc?status=pending", cookies:{ kpital_sess: adminCookie } });
  const id = list.json().submissions[0].id;
  const dec = await app.inject({ method:"POST", url:`/admin/kyc/${id}/decision`,
    cookies:{ kpital_sess: adminCookie }, payload:{ decision:"verified" } });
  expect(dec.statusCode).toBe(200);
  // the submitting user's account is now verified
});
it("non-admin gets 403 on /admin/kyc", async () => { /* ... */ });
it("reject requires a reason", async () => { /* decision rejected with no reason → 400 */ });
```

- [ ] **Step 2:** `npm test -- kyc-admin` → FAIL.

- [ ] **Step 3: Implement** the three admin routes behind `[app.requireAuth, app.requireAdmin]`. Detail route builds a signed URL per document and emits an audit log via `req.log.info({ adminId: req.accountId, submissionId, action: "kyc_view" })`. Decision route validates the enum + reason, then in one `db.transaction` updates the submission and `accounts.kycStatus` for the submission's `accountId`. Never return `password_hash` or raw storage bytes; list returns metadata only.

- [ ] **Step 4:** `npm test -- kyc-admin` → PASS (+ full suite green + `npm run typecheck`).
- [ ] **Step 5: Commit** — `git add api && git commit -m "feat(api): admin KYC queue, detail with signed URLs, decision mirroring kyc_status"`

---

## Self-review notes

- **Spec coverage:** config+compose MinIO (T1), StorageProvider+MinIO+fake (T2), schema (T3), validation+service+KycVerifier+kyc_status mirror-on-submit (T4), submission/me endpoints+multipart+DI (T5), admin queue/detail-signed-urls-audit/decision-mirror (T6). Security (private bucket, signed URLs only, magic-byte MIME, size cap, server keys, no content logging, access control) lands across T2/T4/T5/T6.
- **Deferred (spec §1/§11):** automated `KycVerifier` provider, investment gating (#4), antivirus, scheduled retention — interfaces/keys present, not implemented.
- **Ordering:** each task compiles + tests green before the next; schema grows additively with one new migration (T3).
