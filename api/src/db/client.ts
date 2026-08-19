import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Db = ReturnType<typeof makeDb>;

export function makeDb(url: string) {
  const pool = new pg.Pool({ connectionString: url });
  return drizzle(pool, { schema });
}
