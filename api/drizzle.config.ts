import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  // Used by `drizzle-kit migrate` / `studio`. Reads DATABASE_URL from the
  // environment so dev migrations target the same Postgres the app connects to.
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
