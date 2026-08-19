import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app";
import { loadConfig } from "../../src/config/env";
import type { Db } from "../../src/db/client";
import type { Notifier } from "../../src/lib/notifier";
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

export async function buildTestApp(): Promise<{
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
  const app = buildApp({ db, config, notifier });
  return { app, db, sentCodes, sentLinks };
}
