import type { FastifyInstance } from "fastify";
import { settleDeposit, failDeposit, cancelAndRefund, InvalidStateError, ProjectNotFoundError } from "./service";

// Canonical UUID shape. A non-UUID :id would otherwise reach pg and throw 22P02
// (-> 500), so reject it as a 404 (unknown project) first, mirroring
// investments/routes.ts.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  // POST /admin/projects/:id/cancel — cancel a collecting project and refund
  // every pending/escrowed investment to its source. requireAdmin runs after
  // requireAuth (which populates req.accountId), matching kyc/admin-routes.ts.
  app.post("/admin/projects/:id/cancel", { preHandler: [app.requireAuth, app.requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) {
      return reply.code(404).send({ error: { code: "not_found", message: "Project not found" } });
    }

    try {
      await cancelAndRefund(app.db, app.payments, { projectId: id });
      return reply.code(200).send({ ok: true });
    } catch (err) {
      // Errors thrown inside db.transaction may be wrapped by the ROLLBACK path,
      // so match on both the class and the message code (mirrors investments/routes).
      const code = (err as Error)?.message;
      if (err instanceof ProjectNotFoundError || code === "project_not_found") {
        return reply.code(404).send({ error: { code: "not_found", message: "Project not found" } });
      }
      if (err instanceof InvalidStateError || code === "invalid_state") {
        return reply.code(409).send({ error: { code: "invalid_state", message: "project is not collecting" } });
      }
      throw err;
    }
  });
}
