import "fastify";
import type { Db } from "../db/client";
import type { Config } from "../config/env";
import type { Notifier } from "../lib/notifier";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    config: Config;
    notifier: Notifier;
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    accountId: string | null;
  }
}
