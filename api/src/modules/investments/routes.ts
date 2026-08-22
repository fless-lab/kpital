import type { FastifyInstance, FastifyReply } from "fastify";
import {
  createInvestment,
  KycRequiredError,
  NotCollectingError,
  BelowMinTicketError,
  ExceedsRemainingError,
  PaymentFailedError,
  ProjectNotFoundError,
  InsufficientFundsError,
  type InvestmentSource,
} from "./service";

// Canonical UUID shape. A non-UUID :id would otherwise reach pg and throw 22P02,
// which the central handler turns into a 500 — reject it as a 404 (unknown
// project) first, matching the other project routes' guard rationale.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SOURCES: readonly InvestmentSource[] = ["payment", "wallet"];

type InvestBody = {
  amountMinor?: unknown;
  source?: unknown;
  method?: unknown;
  confirmCapToRemaining?: unknown;
};

export default async function investmentRoutes(app: FastifyInstance) {
  const validationError = (reply: FastifyReply, message: string) =>
    reply.code(400).send({ error: { code: "validation_error", message } });

  // POST /projects/:id/invest — invest in a collecting project. The whole
  // money path lives in createInvestment's single locked transaction.
  app.post("/projects/:id/invest", { preHandler: app.requireAuth }, async (req, reply) => {
    const accountId = req.accountId;
    if (!accountId) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "Login required" } });
    }

    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) {
      return reply.code(404).send({ error: { code: "not_found", message: "Project not found" } });
    }

    const body = (req.body ?? {}) as InvestBody;
    if (typeof body.amountMinor !== "number" || !Number.isInteger(body.amountMinor) || body.amountMinor <= 0) {
      return validationError(reply, "amountMinor must be a positive integer");
    }
    if (typeof body.source !== "string" || !SOURCES.includes(body.source as InvestmentSource)) {
      return validationError(reply, "source must be one of payment, wallet");
    }
    const method =
      typeof body.method === "object" && body.method !== null && typeof (body.method as { type?: unknown }).type === "string"
        ? (body.method as { type: string })
        : undefined;

    try {
      const result = await createInvestment(app.db, app.payments, {
        projectId: id,
        accountId,
        amountMinor: body.amountMinor,
        source: body.source as InvestmentSource,
        confirmCapToRemaining: body.confirmCapToRemaining === true,
        ...(method !== undefined ? { method } : {}),
      });
      return reply.code(201).send(result);
    } catch (err) {
      return mapInvestError(err, reply);
    }
  });
}

// Errors thrown through drizzle's ROLLBACK TO SAVEPOINT may be wrapped, so match
// on both the class and the message code (mirrors wallet/routes.ts).
function mapInvestError(err: unknown, reply: FastifyReply): FastifyReply {
  const code = (err as Error)?.message;
  if (err instanceof KycRequiredError || code === "kyc_required") {
    return reply.code(403).send({ error: { code: "kyc_required", message: "KYC verification required" } });
  }
  if (err instanceof NotCollectingError || code === "invalid_state") {
    return reply.code(409).send({ error: { code: "invalid_state", message: "Project is not collecting" } });
  }
  if (err instanceof BelowMinTicketError || code === "below_min_ticket") {
    return reply.code(400).send({ error: { code: "below_min_ticket", message: "Amount is below the minimum ticket" } });
  }
  if (err instanceof ExceedsRemainingError) {
    return reply.code(409).send({
      error: {
        code: "exceeds_remaining",
        message: "Amount exceeds the remaining capacity",
        details: { remainingMinor: err.remainingMinor },
      },
    });
  }
  if (err instanceof InsufficientFundsError || code === "insufficient_funds") {
    return reply.code(400).send({ error: { code: "insufficient_funds", message: "Insufficient funds" } });
  }
  if (err instanceof PaymentFailedError || code === "payment_failed") {
    return reply.code(402).send({ error: { code: "payment_failed", message: "Payment failed" } });
  }
  if (err instanceof ProjectNotFoundError || code === "project_not_found") {
    return reply.code(404).send({ error: { code: "not_found", message: "Project not found" } });
  }
  throw err;
}
