import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "../../src/db/schema";
import type { Db } from "../../src/db/client";

const testUrl = process.env.TEST_DATABASE_URL ?? "postgres://kpital:kpital@127.0.0.1:5544/kpital_test";

const pool = new pg.Pool({ connectionString: testUrl });
const db = drizzle(pool, { schema });

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

let migratedOnce: Promise<void> | undefined;

function ensureMigrated(): Promise<void> {
  migratedOnce ??= migrate(db, { migrationsFolder });
  return migratedOnce;
}

export async function withTestDb(fn: (db: Db) => Promise<void>): Promise<void> {
  await ensureMigrated();
  const SENT = Symbol("rollback");
  try {
    await db.transaction(async (tx) => {
      await fn(tx as unknown as Db);
      throw SENT;
    });
  } catch (e) {
    if (e !== SENT) throw e;
  }
}
