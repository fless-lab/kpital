import "fastify";
import type { Db } from "../db/client";
import type { Config } from "../config/env";
import type { Notifier } from "../lib/notifier";
import type { PaymentProvider } from "../lib/payments";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    config: Config;
    notifier: Notifier;
    payments: PaymentProvider;
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    accountId: string | null;
  }
}
