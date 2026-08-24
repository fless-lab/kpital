import type { FastifyInstance } from "fastify";
import { and, asc, eq, ne } from "drizzle-orm";
import { projects, repaymentInstallments } from "../../db/schema";
import { settleRepayment, failRepaymentSettlement, repayKey } from "./service";

// Canonical UUID shape. A non-UUID :id would otherwise reach pg and throw 22P02
// (-> 500), so reject it as a 404 (unknown project) first, mirroring
// investments/routes.ts.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Thrown from inside the two-phase transaction so the ROLLBACK undoes the
// `due -> pending` guard. The message doubles as the error code because drizzle
// may re-wrap a throw from the transaction callback, so the mapper below matches
// on BOTH the class and the message code (mirrors investments/routes.ts).
class InvalidStateError extends Error {
  constructor() {
    super("invalid_state");
  }
}
class RepaymentFailedError extends Error {
  constructor() {
    super("repayment_failed");
  }
}

export default async function repaymentRoutes(app: FastifyInstance) {
  // POST /projects/:id/repay: the porteur collects the next due installment. Two
  // phase: (1) a transaction holding the target installment row FOR UPDATE guards
  // `due -> pending` and calls the provider (a decline rolls the guard back); (2)
  // after commit, a `settled` collection distributes pro-rata and may close the
  // project. The provider call sits UNDER the row lock on purpose: the rollback is
  // exactly what returns the installment to `due` on a decline (see spec 6).
  app.post("/projects/:id/repay", { preHandler: app.requireAuth }, async (req, reply) => {
    const accountId = req.accountId;
    if (!accountId) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "Login required" } });
    }

    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) {
      return reply.code(404).send({ error: { code: "not_found", message: "Project not found" } });
    }

    const [project] = await app.db.select().from(projects).where(eq(projects.id, id));
    if (!project) {
      return reply.code(404).send({ error: { code: "not_found", message: "Project not found" } });
    }
    if (project.ownerAccountId !== accountId) {
      return reply.code(403).send({ error: { code: "forbidden", message: "Not your project" } });
    }
    if (project.status !== "repaying") {
      return reply.code(409).send({ error: { code: "invalid_state", message: "Project is not repaying" } });
    }

    let committed: { installmentId: string; depStatus: "pending" | "settled" };
    try {
      committed = await app.db.transaction(async (tx) => {
        // Lowest-seq NON-paid installment, locked FOR UPDATE to serialise two
        // concurrent /repay calls: the loser blocks, then re-reads the row and
        // sees `pending` (strict sequential, one collection in flight at a time).
        const [installment] = await tx
          .select()
          .from(repaymentInstallments)
          .where(and(eq(repaymentInstallments.projectId, id), ne(repaymentInstallments.status, "paid")))
          .orderBy(asc(repaymentInstallments.seq))
          .limit(1)
          .for("update");
        if (!installment) throw new InvalidStateError(); // nothing left to pay
        if (installment.status === "pending") throw new InvalidStateError(); // settlement in flight

        // It is `due`. Guarded due -> pending under the row lock.
        await tx
          .update(repaymentInstallments)
          .set({ status: "pending" })
          .where(and(eq(repaymentInstallments.id, installment.id), eq(repaymentInstallments.status, "due")));

        const dep = await app.payments.initiateRepayment({
          payerAccountId: project.ownerAccountId,
          amountMinor: installment.amountMinor,
          idempotencyKey: repayKey(installment.id),
        });
        // A decline throws so the transaction rolls the `due -> pending` back and
        // leaves the ref null; the porteur can retry.
        if (!dep.ok) throw new RepaymentFailedError();

        await tx
          .update(repaymentInstallments)
          .set({ repaymentRef: dep.ref })
          .where(eq(repaymentInstallments.id, installment.id));

        return { installmentId: installment.id, depStatus: dep.status };
      });
    } catch (err) {
      const code = (err as Error)?.message;
      if (err instanceof InvalidStateError || code === "invalid_state") {
        return reply.code(409).send({ error: { code: "invalid_state", message: "No installment to repay" } });
      }
      if (err instanceof RepaymentFailedError || code === "repayment_failed") {
        return reply.code(402).send({ error: { code: "repayment_failed", message: "Repayment collection failed" } });
      }
      throw err;
    }

    // Phase 2, OUTSIDE the lock: a settled collection distributes pro-rata and may
    // close the project. `pending` returns without distributing (the money has not
    // arrived; the webhook settles it later).
    if (committed.depStatus === "settled") {
      await settleRepayment(app.db, { installmentId: committed.installmentId });
    }

    // Read back the ACTUAL statuses: settleRepayment may have moved the installment
    // to `paid` and closed the project (concurrent close is possible too), so never
    // hardcode either value.
    const [ins] = await app.db
      .select({ seq: repaymentInstallments.seq, amountMinor: repaymentInstallments.amountMinor, status: repaymentInstallments.status })
      .from(repaymentInstallments)
      .where(eq(repaymentInstallments.id, committed.installmentId));
    const [proj] = await app.db.select({ status: projects.status }).from(projects).where(eq(projects.id, id));

    return reply.code(201).send({
      installmentId: committed.installmentId,
      seq: ins!.seq,
      amountMinor: ins!.amountMinor,
      status: ins!.status,
      projectStatus: proj!.status,
    });
  });

  // GET /projects/:id/repayment-schedule: the porteur reads their own repayment
  // plan. Owner-only. Projects ONLY the installment-level fields (seq, amount, due,
  // status, settled) - never repayment_ref or any investor/distribution PII.
  app.get("/projects/:id/repayment-schedule", { preHandler: app.requireAuth }, async (req, reply) => {
    const accountId = req.accountId;
    if (!accountId) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "Login required" } });
    }

    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) {
      return reply.code(404).send({ error: { code: "not_found", message: "Project not found" } });
    }

    const [project] = await app.db.select().from(projects).where(eq(projects.id, id));
    if (!project) {
      return reply.code(404).send({ error: { code: "not_found", message: "Project not found" } });
    }
    if (project.ownerAccountId !== accountId) {
      return reply.code(403).send({ error: { code: "forbidden", message: "Not your project" } });
    }

    const installments = await app.db
      .select({
        seq: repaymentInstallments.seq,
        amountMinor: repaymentInstallments.amountMinor,
        dueAt: repaymentInstallments.dueAt,
        status: repaymentInstallments.status,
        settledAt: repaymentInstallments.settledAt,
      })
      .from(repaymentInstallments)
      .where(eq(repaymentInstallments.projectId, id))
      .orderBy(asc(repaymentInstallments.seq));

    const totalOwedMinor = installments.reduce((sum, i) => sum + i.amountMinor, 0);
    const paidCount = installments.filter((i) => i.status === "paid").length;
    const totalCount = installments.length;

    return reply.send({ installments, totalOwedMinor, paidCount, totalCount });
  });

  // Escrow repayment settlement webhook. NO session auth: the provider calls this,
  // so it is verified by a shared secret carried in the x-escrow-signature header,
  // compared against config.escrowWebhookSecret. An unset secret (empty) rejects
  // every caller, the safe prod default until a real secret is configured. Mirrors
  // escrow/routes.ts POST /escrow/settlement. Idempotent: the guarded transitions
  // in settleRepayment/failRepaymentSettlement make a replay a no-op (a second
  // `settled` re-runs distribution but the UNIQUE(installment, investment) guard
  // credits each investor exactly once).
  app.post("/escrow/repayment", async (req, reply) => {
    // A header sent more than once arrives as an array, which never equals the
    // string secret, so it is rejected as a bad signature.
    const sig = req.headers["x-escrow-signature"];
    if (!app.config.escrowWebhookSecret || sig !== app.config.escrowWebhookSecret) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "bad signature" } });
    }

    const body = (req.body ?? {}) as { repaymentRef?: unknown; status?: unknown };
    const repaymentRef = body.repaymentRef;
    const status = body.status;
    if (typeof repaymentRef !== "string" || repaymentRef.length === 0) {
      return reply.code(400).send({ error: { code: "validation_error", message: "repaymentRef must be a non-empty string" } });
    }
    if (status !== "settled" && status !== "failed") {
      return reply.code(400).send({ error: { code: "validation_error", message: "status must be one of settled, failed" } });
    }

    const [installment] = await app.db
      .select({ id: repaymentInstallments.id })
      .from(repaymentInstallments)
      .where(eq(repaymentInstallments.repaymentRef, repaymentRef));
    if (!installment) {
      return reply.code(404).send({ error: { code: "not_found", message: "Installment not found" } });
    }

    if (status === "failed") {
      await failRepaymentSettlement(app.db, { installmentId: installment.id });
      return reply.send({ ok: true });
    }

    await settleRepayment(app.db, { installmentId: installment.id });
    return reply.send({ ok: true });
  });
}
