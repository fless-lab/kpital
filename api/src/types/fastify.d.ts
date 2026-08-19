import "fastify";
import type { Db } from "../db/client";
import type { Config } from "../config/env";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    config: Config;
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    accountId: string | null;
  }
}
