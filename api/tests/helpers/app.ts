import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app";
import { loadConfig } from "../../src/config/env";
import type { Db } from "../../src/db/client";
import { db, ensureMigrated } from "./db";

const testUrl = process.env.TEST_DATABASE_URL ?? "postgres://kpital:kpital@127.0.0.1:5544/kpital_test";

export async function buildTestApp(): Promise<{ app: FastifyInstance; db: Db }> {
  await ensureMigrated();
  const config = loadConfig({
    DATABASE_URL: testUrl,
    CORS_ORIGIN: "http://localhost:8080",
  });
  const app = buildApp({ db, config });
  return { app, db };
}
