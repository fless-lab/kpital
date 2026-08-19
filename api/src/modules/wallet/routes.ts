import type { FastifyInstance } from "fastify";
import { getBalance, listEntries, withdraw, InsufficientFundsError, WalletNotFoundError } from "./service";

type WithdrawBody = {
  amountMinor?: unknown;
  method?: unknown;
};

export default async function walletRoutes(app: FastifyInstance) {
  app.get("/wallet", { preHandler: app.requireAuth }, async (req, reply) => {
    const accountId = req.accountId;
    if (!accountId) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "Login required" } });
    }
    const [balance, entries] = await Promise.all([
      getBalance(app.db, accountId),
      listEntries(app.db, accountId),
    ]);
    return reply.send({ balance, entries });
  });

  app.post("/wallet/withdraw", { preHandler: app.requireAuth }, async (req, reply) => {
    const accountId = req.accountId;
    if (!accountId) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "Login required" } });
    }

    const body = (req.body ?? {}) as WithdrawBody;
    const amountMinor = body.amountMinor;
    const method = body.method;

    if (typeof amountMinor !== "number" || !Number.isInteger(amountMinor) || amountMinor <= 0) {
      return reply
        .code(400)
        .send({ error: { code: "validation_error", message: "amountMinor must be a positive integer" } });
    }
    if (typeof method !== "object" || method === null || typeof (method as { type?: unknown }).type !== "string") {
      return reply
        .code(400)
        .send({ error: { code: "validation_error", message: "method.type is required" } });
    }

    try {
      const { entryId } = await withdraw(app.db, app.payments, {
        accountId,
        amountMinor,
        method: method as { type: string },
      });
      return reply.code(200).send({ entryId });
    } catch (err) {
      // Thrown through drizzle's ROLLBACK TO SAVEPOINT; match on both the class
      // and the message code in case the original is wrapped.
      if (err instanceof InsufficientFundsError || (err as Error)?.message === "insufficient_funds") {
        return reply.code(400).send({ error: { code: "insufficient_funds", message: "Insufficient funds" } });
      }
      if (err instanceof WalletNotFoundError || (err as Error)?.message === "wallet_not_found") {
        return reply.code(404).send({ error: { code: "wallet_not_found", message: "Wallet not found" } });
      }
      throw err;
    }
  });
}
