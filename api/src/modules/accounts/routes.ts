import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { accounts } from "../../db/schema";

export default async function accountsRoutes(app: FastifyInstance) {
  app.get("/me", { preHandler: app.requireAuth }, async (req, reply) => {
    const accountId = req.accountId;
    if (!accountId) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "Login required" } });
    }

    const [account] = await app.db
      .select({
        id: accounts.id,
        email: accounts.email,
        firstName: accounts.firstName,
        lastName: accounts.lastName,
        roles: accounts.roles,
        kycStatus: accounts.kycStatus,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId));

    if (!account) {
      return reply.code(404).send({ error: { code: "not_found", message: "Account not found" } });
    }

    return reply.send(account);
  });
}
