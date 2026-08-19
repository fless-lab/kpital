import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import type { Db } from "./db/client";
import type { Config } from "./config/env";
import authPlugin from "./lib/http/auth";
import authRoutes from "./modules/auth/routes";

export function buildApp(opts: { db: Db; config: Config }): FastifyInstance {
  const app = Fastify({ logger: false });
  app.decorate("db", opts.db);
  app.decorate("config", opts.config);
  app.register(cookie);
  app.register(authPlugin);
  app.register(authRoutes);
  app.get("/health", async () => ({ status: "ok" }));
  return app;
}
