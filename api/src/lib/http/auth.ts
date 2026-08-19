import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest } from "fastify";
import { resolveSession } from "../../modules/auth/session";

export default fp(async (app) => {
  app.decorateRequest("accountId", null);
  app.decorate("requireAuth", async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies?.[app.config.sessionCookieName];
    const session = token ? await resolveSession(app.db, token) : null;
    if (!session) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "Login required" } });
    }
    req.accountId = session.accountId;
  });
});
