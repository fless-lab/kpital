import type { FastifyInstance } from "fastify";
import { settleDeposit, failDeposit } from "./service";

type SettlementBody = {
  depositRef?: unknown;
  status?: unknown;
};

// Escrow settlement webhook. NO session auth: the provider calls this, so it is
// verified by a shared secret carried in the x-escrow-signature header, compared
// against config.escrowWebhookSecret. An unset secret (empty) rejects every
// caller, the safe prod default until a real secret is configured. Idempotent:
// the guarded transitions in settleDeposit/failDeposit make a replay a no-op.
export default async function escrowRoutes(app: FastifyInstance) {
  app.post("/escrow/settlement", async (req, reply) => {
    // A header sent more than once arrives as an array, which never equals the
    // string secret, so it is rejected as a bad signature.
    const sig = req.headers["x-escrow-signature"];
    if (!app.config.escrowWebhookSecret || sig !== app.config.escrowWebhookSecret) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "bad signature" } });
    }

    const body = (req.body ?? {}) as SettlementBody;
    const depositRef = body.depositRef;
    const status = body.status;
    if (typeof depositRef !== "string" || depositRef.length === 0) {
      return reply.code(400).send({ error: { code: "validation_error", message: "depositRef must be a non-empty string" } });
    }
    if (status !== "settled" && status !== "failed") {
      return reply.code(400).send({ error: { code: "validation_error", message: "status must be one of settled, failed" } });
    }

    if (status === "failed") {
      const res = await failDeposit(app.db, { depositRef });
      if (!res.found) {
        return reply.code(404).send({ error: { code: "not_found", message: "Deposit not found" } });
      }
      return reply.send({ ok: true });
    }

    const res = await settleDeposit(app.db, app.payments, { depositRef });
    if (!res.found) {
      return reply.code(404).send({ error: { code: "not_found", message: "Deposit not found" } });
    }
    return reply.send({ ok: true, applied: res.applied, projectStatus: res.projectStatus });
  });
}
