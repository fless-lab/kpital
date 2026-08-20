import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import type { Db } from "./db/client";
import type { Config } from "./config/env";
import type { Notifier } from "./lib/notifier";
import { makeDefaultNotifier } from "./lib/notifier";
import type { PaymentProvider } from "./lib/payments";
import { MockPaymentProvider } from "./lib/payments";
import type { StorageProvider } from "./lib/storage";
import { makeStorage } from "./lib/storage";
import type { KycVerifier } from "./lib/kyc/verifier";
import { ManualVerifier } from "./lib/kyc/verifier";
import { registerErrorHandler } from "./lib/http/errors";
import authPlugin from "./lib/http/auth";
import requireAdminPlugin from "./lib/http/require-admin";
import authRoutes from "./modules/auth/routes";
import accountsRoutes from "./modules/accounts/routes";
import walletRoutes from "./modules/wallet/routes";
import adminRoutes from "./modules/admin/routes";
import kycRoutes from "./modules/kyc/routes";
import kycAdminRoutes from "./modules/kyc/admin-routes";
import projectRoutes from "./modules/projects/routes";
import projectAdminRoutes from "./modules/projects/admin-routes";

export function buildApp(opts: {
  db: Db;
  config: Config;
  notifier?: Notifier;
  payments?: PaymentProvider;
  // Storage + KYC verifier are constructed ONCE per app (makeStorage mints a
  // fresh S3 client, so never per-request). Tests inject a MemoryStorage.
  storage?: StorageProvider;
  verifier?: KycVerifier;
  // Max requests per IP per minute against /auth/* routes. Kept as a buildApp
  // knob (not on Config) so tests can dial it down without changing env parsing.
  rateLimitMax?: number;
  // Server logger. Defaults to false so tests stay silent; server.ts enables it
  // so the error handler's server-side logging of unexpected errors is real.
  logger?: FastifyServerOptions["logger"];
}): FastifyInstance {
  // trustProxy is config-driven (TRUST_PROXY), default false. Behind a reverse
  // proxy set it to the hop count (e.g. 1) so req.ip reflects X-Forwarded-For
  // and the per-IP /auth/* rate-limit keys on the real client, without letting a
  // direct client spoof the whole chain (which trustProxy: true would allow).
  const app = Fastify({ trustProxy: opts.config.trustProxy, logger: opts.logger ?? false });
  app.decorate("db", opts.db);
  app.decorate("config", opts.config);
  app.decorate("notifier", opts.notifier ?? makeDefaultNotifier(opts.config));
  app.decorate("payments", opts.payments ?? new MockPaymentProvider());
  app.decorate("storage", opts.storage ?? makeStorage(opts.config));
  app.decorate("verifier", opts.verifier ?? new ManualVerifier());

  registerErrorHandler(app);

  app.register(cors, { origin: opts.config.corsOrigin, credentials: true });
  app.register(cookie);
  app.register(multipart, {
    // Bound non-file input too: fields/parts caps stop a malicious body from
    // flooding the parts loop (the KYC form is 4 fields + 2 files = 6 parts).
    limits: { fileSize: opts.config.kycMaxFileMb * 1024 * 1024, files: 2, fields: 10, parts: 12 },
  });
  app.register(authPlugin);
  app.register(requireAdminPlugin);

  // Rate-limit only the /auth/* routes: register the plugin inside an
  // encapsulated scope that owns just authRoutes, so the limit does not touch
  // wallet/admin/account endpoints. The 429 shape is normalized centrally.
  app.register(async (scope) => {
    // No errorResponseBuilder: let the plugin throw its default RateLimitError
    // (which carries statusCode 429) so the central error handler normalizes it
    // to the uniform { error: { code: "rate_limited", ... } } envelope.
    await scope.register(rateLimit, {
      max: opts.rateLimitMax ?? 30,
      timeWindow: "1 minute",
    });
    await scope.register(authRoutes);
  });

  app.register(accountsRoutes);
  app.register(walletRoutes);
  app.register(adminRoutes);
  app.register(kycRoutes);
  app.register(kycAdminRoutes);
  app.register(projectRoutes);
  app.register(projectAdminRoutes);
  app.get("/health", async () => ({ status: "ok" }));
  return app;
}
