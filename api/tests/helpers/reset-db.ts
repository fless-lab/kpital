import { beforeEach } from "vitest";
import { pool, ensureMigrated } from "./db";

beforeEach(async () => {
  await ensureMigrated();
  const { rows } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  const tables = rows
    .map((r) => r.table_name)
    .filter((name) => name !== "__drizzle_migrations");
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t}"`).join(", ");
  await pool.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
});
