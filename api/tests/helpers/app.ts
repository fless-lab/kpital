import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app";
import { loadConfig } from "../../src/config/env";
import type { Db } from "../../src/db/client";
import type { Notifier } from "../../src/lib/notifier";
import { db, ensureMigrated } from "./db";

const testUrl = process.env.TEST_DATABASE_URL ?? "postgres://kpital:kpital@127.0.0.1:5544/kpital_test";

// Capturing notifier: extracts any 6-digit code from a sent message body into
// `sentCodes` so tests can read the OTP that was "sent". (Task 11 can extend the
// captured message shape here for reset links without changing callers.)
function makeCapturingNotifier(): { notifier: Notifier; sentCodes: string[] } {
  const sentCodes: string[] = [];
  const notifier: Notifier = {
    async send(_to, m) {
      const match = m.body.match(/\b(\d{6})\b/);
      if (match) sentCodes.push(match[1]);
    },
  };
  return { notifier, sentCodes };
}

export async function buildTestApp(): Promise<{ app: FastifyInstance; db: Db; sentCodes: string[] }> {
  await ensureMigrated();
  const config = loadConfig({
    DATABASE_URL: testUrl,
    CORS_ORIGIN: "http://localhost:8080",
  });
  const { notifier, sentCodes } = makeCapturingNotifier();
  const app = buildApp({ db, config, notifier });
  return { app, db, sentCodes };
}
