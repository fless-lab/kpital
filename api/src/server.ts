import { loadConfig } from "./config/env";
import { makeDb } from "./db/client";
import { buildApp } from "./app";

const config = loadConfig();
const db = makeDb(config.databaseUrl);
const app = buildApp({ db, config });

app.listen({ port: 3000, host: "0.0.0.0" }).catch((e) => {
  console.error(e);
  process.exit(1);
});
