# KPITAL API

Backend Foundation for KPITAL: a Fastify (TypeScript, ESM, strict) service providing
accounts and roles, password + OTP authentication with revocable sessions, password
reset, an integer-minor-unit wallet ledger with mock payouts, a notifier abstraction
(email/SMS), and admin endpoints (KYC/account status). Postgres via drizzle-orm.

## Prerequisites

- Node.js 24+
- Docker (for the dedicated Postgres)

## 1. Database

A dedicated Postgres runs in Docker. From the **repository root**:

```bash
docker compose up -d
```

This brings up the `kpital-postgres` container on `127.0.0.1:5544` (user `kpital`,
password `kpital`) with two databases:

- `kpital`: the application database (`DATABASE_URL`)
- `kpital_test`: the integration-test database (`TEST_DATABASE_URL`), created on first
  init by `docker/postgres-init/01-create-test-db.sql`

Stop it with `docker compose down` (add `-v` to also drop the data volume).

## 2. Environment

The API reads configuration from the environment (validated in `src/config/env.ts`).
Create `api/.env` or export these before running:

| Variable              | Required | Default        | Notes                                                        |
| --------------------- | -------- | -------------- | ------------------------------------------------------------ |
| `DATABASE_URL`        | yes      | none           | App DB, e.g. `postgres://kpital:kpital@127.0.0.1:5544/kpital` |
| `CORS_ORIGIN`         | yes      | none           | Allowed browser origin, e.g. `http://localhost:8080`         |
| `TEST_DATABASE_URL`   | tests    | `…/kpital_test`| Used by the test harness; falls back to the local test DB    |
| `NOTIFY_CHANNELS`     | no       | `email`        | Comma list of `email` / `sms` the notifier delivers on       |
| `SESSION_COOKIE_NAME` | no       | `kpital_sess`  | Session cookie name                                          |
| `SESSION_TTL_DAYS`    | no       | `30`           | Session lifetime                                             |
| `OTP_TTL_MINUTES`     | no       | `10`           | OTP / reset-code lifetime                                    |

CORS is restricted to `CORS_ORIGIN` with credentials enabled (the app is cookie-auth).
The `/auth/*` routes are rate limited per IP.

## 3. Migrations

Schema lives in `src/db/schema.ts`; SQL migrations are committed under `drizzle/`.

- **Generate** a new migration after a schema change:

  ```bash
  npm run db:generate
  ```

- **Apply** pending migrations to the dev database (needs `DATABASE_URL` set):

  ```bash
  DATABASE_URL=postgres://kpital:kpital@127.0.0.1:5544/kpital npm run db:migrate
  ```

- **Tests auto-migrate**: the test harness (`tests/helpers/db.ts`) runs the drizzle
  migrator against `TEST_DATABASE_URL` on the first `buildTestApp()`, so you do not
  migrate the test DB by hand.

## 4. Run

```bash
cd api
npm install
npm run dev      # tsx watch on src/server.ts, listens on :3000
```

Health check: `GET http://localhost:3000/health` → `{ "status": "ok" }`.

## 5. Test

Requires the Postgres container to be up (step 1).

```bash
cd api
npm test         # vitest run: unit + Postgres-backed integration tests
```

## Errors

All routes return a uniform envelope:

```json
{ "error": { "code": "validation_error", "message": "…", "details": {} } }
```

A central Fastify handler (`src/lib/http/errors.ts`) normalizes any domain error,
schema-validation failure, rate-limit `429`, or unknown route (`404`) into this envelope,
and collapses unexpected failures to `500 { "error": { "code": "internal_error" } }`
without leaking internals.
