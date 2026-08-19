import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import type { Db } from "./db/client";
import type { Config } from "./config/env";
import type { Notifier } from "./lib/notifier";
import { makeDefaultNotifier } from "./lib/notifier";
import type { PaymentProvider } from "./lib/payments";
import { MockPaymentProvider } from "./lib/payments";
import authPlugin from "./lib/http/auth";
import requireAdminPlugin from "./lib/http/require-admin";
import authRoutes from "./modules/auth/routes";
import accountsRoutes from "./modules/accounts/routes";
import walletRoutes from "./modules/wallet/routes";
import adminRoutes from "./modules/admin/routes";

export function buildApp(opts: { db: Db; config: Config; notifier?: Notifier; payments?: PaymentProvider }): FastifyInstance {
  const app = Fastify({ logger: false });
  app.decorate("db", opts.db);
  app.decorate("config", opts.config);
  app.decorate("notifier", opts.notifier ?? makeDefaultNotifier(opts.config));
  app.decorate("payments", opts.payments ?? new MockPaymentProvider());
  app.register(cookie);
  app.register(authPlugin);
  app.register(requireAdminPlugin);
  app.register(authRoutes);
  app.register(accountsRoutes);
  app.register(walletRoutes);
  app.register(adminRoutes);
  app.get("/health", async () => ({ status: "ok" }));
  return app;
}
