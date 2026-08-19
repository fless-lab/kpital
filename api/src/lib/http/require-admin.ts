import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { accounts } from "../../db/schema";

// `requireAdmin` runs after `requireAuth` (use as `preHandler: [app.requireAuth,
// app.requireAdmin]`). It loads the account fresh per request by `accountId` and
// replies 403 unless `isAdmin` is true. It self-guards `accountId` so an
// unauthenticated request still yields 401 regardless of composition.
export default fp(async (app) => {
  app.decorate("requireAdmin", async (req: FastifyRequest, reply: FastifyReply) => {
    const accountId = req.accountId;
    if (!accountId) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "Login required" } });
    }
    const [account] = await app.db
      .select({ isAdmin: accounts.isAdmin })
      .from(accounts)
      .where(eq(accounts.id, accountId));
    if (!account || !account.isAdmin) {
      return reply.code(403).send({ error: { code: "forbidden", message: "Admin access required" } });
    }
  });
});
