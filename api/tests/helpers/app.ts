import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app";
import { loadConfig } from "../../src/config/env";
import type { Db } from "../../src/db/client";
import type { Notifier } from "../../src/lib/notifier";
import type { PaymentProvider } from "../../src/lib/payments";
import { db, ensureMigrated } from "./db";

const testUrl = process.env.TEST_DATABASE_URL ?? "postgres://kpital:kpital@127.0.0.1:5544/kpital_test";

// Capturing notifier: extracts any 6-digit code from a sent message body into
// `sentCodes`, and any reset token (the `token=` query param of a reset link)
// into `sentLinks`, so tests can read what was "sent". Both matches fire
// independently on a message; each is harmless when the other pattern is absent.
function makeCapturingNotifier(): { notifier: Notifier; sentCodes: string[]; sentLinks: string[] } {
  const sentCodes: string[] = [];
  const sentLinks: string[] = [];
  const notifier: Notifier = {
    async send(_to, m) {
      const code = m.body.match(/\b(\d{6})\b/);
      if (code) sentCodes.push(code[1]);
      const token = m.body.match(/token=([A-Za-z0-9_-]+)/);
      if (token) sentLinks.push(token[1]);
    },
  };
  return { notifier, sentCodes, sentLinks };
}

export async function buildTestApp(opts?: {
  payments?: PaymentProvider;
  rateLimitMax?: number;
}): Promise<{
  app: FastifyInstance;
  db: Db;
  sentCodes: string[];
  sentLinks: string[];
}> {
  await ensureMigrated();
  const config = loadConfig({
    DATABASE_URL: testUrl,
    CORS_ORIGIN: "http://localhost:8080",
  });
  const { notifier, sentCodes, sentLinks } = makeCapturingNotifier();
  const app = buildApp({
    db,
    config,
    notifier,
    ...(opts?.payments ? { payments: opts.payments } : {}),
    ...(opts?.rateLimitMax !== undefined ? { rateLimitMax: opts.rateLimitMax } : {}),
  });
  return { app, db, sentCodes, sentLinks };
}

// Registers a fresh account with the given email (defaulting to the investor
// role) and returns the session cookie value, so tests can act as that user.
export async function loginAs(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email, password: "Abcdef12", firstName: "Test", lastName: "User", country: "Togo" },
  });
  if (res.statusCode !== 201) {
    throw new Error(`loginAs: register failed (${res.statusCode}): ${res.body}`);
  }
  const cookie = res.cookies.find((c) => c.name === "kpital_sess");
  if (!cookie) throw new Error("loginAs: session cookie not set");
  return cookie.value;
}
