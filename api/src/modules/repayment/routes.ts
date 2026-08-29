import type { FastifyInstance } from "fastify";
import { and, asc, eq, ne } from "drizzle-orm";
import { projects, repaymentInstallments, repaymentPayments, repaymentApplications } from "../../db/schema";
import { settlePayment, failPayment, repayKey } from "./service";

// Canonical UUID shape. A non-UUID :id would otherwise reach pg and throw 22P02
// (-> 500), so reject it as a 404 (unknown project) first, mirroring
// investments/routes.ts.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DAY_MS = 24 * 60 * 60 * 1000;

// Thrown from inside the /repay transaction so the ROLLBACK undoes the payment
// insert. The message doubles as the error code because drizzle may re-wrap a
// throw from the transaction callback, so the mapper matches on BOTH the class and
// the message code (mirrors investments/routes.ts).
class ValidationError extends Error {
  constructor() {
    super("validation_error");
  }
}
class InvalidStateError extends Error {
  constructor() {
    super("invalid_state");
  }
}
class ExceedsRemainingError extends Error {
  constructor() {
    super("exceeds_remaining");
  }
}
class PaymentFailedError extends Error {
  constructor() {
    super("payment_failed");
  }
}

export default async function repaymentRoutes(app: FastifyInstance) {
  // POST /projects/:id/repay { amountMinor, confirmCapToRemaining? }: the porteur
  // makes a free-amount repayment (partial or advance) that cascades over the
  // schedule (spec section 6). Two phase: (1) a transaction holding the project row
  // FOR UPDATE rejects a second concurrent payment (one pending payment per
  // project), caps the amount to the project remaining, inserts the pending payment
  // and calls the provider (a decline rolls the whole thing back -> no payment
  // row); (2) after commit, a `settled` collection applies the cascade via
  // settlePayment. The provider call sits UNDER the lock on purpose: its rollback
  // is what removes the payment row on a decline.
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
    // A `defaulted` project is still in the repayment cycle: the porteur may repay
    // it, and clearing its retards auto-recovers it (spec 3, 6). Any other status
    // (collecting, closed, ...) stays 409.
    if (project.status !== "repaying" && project.status !== "defaulted") {
      return reply.code(409).send({ error: { code: "invalid_state", message: "Project is not repaying" } });
    }

    const body = (req.body ?? {}) as { amountMinor?: unknown; confirmCapToRemaining?: unknown };
    const confirmCap = body.confirmCapToRemaining === true;

    // `remainingMinor` is captured in the closure so it survives drizzle's possible
    // re-wrap of the thrown error (the class/message may be lost, this value is not).
    let remainingForError = 0;

    let committed: { paymentId: string; amountMinor: number; depStatus: "pending" | "settled" };
    try {
      committed = await app.db.transaction(async (tx) => {
        // Lock the project: serialises two concurrent /repay calls so the second
        // sees the first's pending payment and 409s (strict-sequential).
        await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).for("update");

        // One pending payment per project (spec section 8): a collection already in
        // flight blocks a new one.
        const [pending] = await tx
          .select({ id: repaymentPayments.id })
          .from(repaymentPayments)
          .where(and(eq(repaymentPayments.projectId, id), eq(repaymentPayments.status, "pending")))
          .limit(1);
        if (pending) throw new InvalidStateError();

        // Remaining = Sigma(amount_minor - paid_minor) over the non-`paid` schedule.
        const insList = await tx
          .select({ amountMinor: repaymentInstallments.amountMinor, paidMinor: repaymentInstallments.paidMinor })
          .from(repaymentInstallments)
          .where(and(eq(repaymentInstallments.projectId, id), ne(repaymentInstallments.status, "paid")))
          .orderBy(asc(repaymentInstallments.seq));
        const remaining = insList.reduce((s, i) => s + (i.amountMinor - i.paidMinor), 0);
        remainingForError = remaining;

        // amountMinor must be a positive integer.
        const raw = body.amountMinor;
        if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) throw new ValidationError();

        let amountMinor = raw;
        if (amountMinor > remaining) {
          // Over the remaining: reject unless the caller confirmed capping.
          if (!confirmCap) throw new ExceedsRemainingError();
          amountMinor = remaining;
        }
        // A capped amount of 0 (nothing left to pay) is invalid; a solde project is
        // already `closed`.
        if (amountMinor <= 0) throw new InvalidStateError();

        const [payment] = await tx
          .insert(repaymentPayments)
          .values({ projectId: id, amountMinor, status: "pending" })
          .returning({ id: repaymentPayments.id });

        const dep = await app.payments.initiateRepayment({
          payerAccountId: project.ownerAccountId,
          amountMinor,
          idempotencyKey: repayKey(payment!.id),
        });
        // A decline throws so the transaction rolls back: the payment row never
        // persists and the porteur can retry.
        if (!dep.ok) throw new PaymentFailedError();

        await tx.update(repaymentPayments).set({ ref: dep.ref }).where(eq(repaymentPayments.id, payment!.id));

        return { paymentId: payment!.id, amountMinor, depStatus: dep.status };
      });
    } catch (err) {
      const code = (err as Error)?.message;
      if (err instanceof ValidationError || code === "validation_error") {
        return reply.code(400).send({ error: { code: "validation_error", message: "amountMinor must be a positive integer" } });
      }
      if (err instanceof ExceedsRemainingError || code === "exceeds_remaining") {
        return reply
          .code(409)
          .send({ error: { code: "exceeds_remaining", message: "Amount exceeds the project remaining", details: { remainingMinor: remainingForError } } });
      }
      if (err instanceof InvalidStateError || code === "invalid_state") {
        return reply.code(409).send({ error: { code: "invalid_state", message: "Cannot repay in this state" } });
      }
      if (err instanceof PaymentFailedError || code === "payment_failed") {
        return reply.code(402).send({ error: { code: "payment_failed", message: "Repayment collection failed" } });
      }
      throw err;
    }

    // Phase 2, OUTSIDE the lock: a settled collection applies the whole cascade
    // (section 3). A `pending` collection applies nothing; the webhook settles it
    // later. graceCutoffMs is the #7 grace boundary for the settle's auto-lift.
    if (committed.depStatus === "settled") {
      await settlePayment(app.db, { paymentId: committed.paymentId, graceCutoffMs: Date.now() - app.config.defaultGraceDays * DAY_MS });
    }

    // Read back the ACTUAL state: settlePayment may have flipped the payment,
    // advanced paid_minor, and closed/lifted the project, so never hardcode either.
    const [pay] = await app.db.select({ status: repaymentPayments.status }).from(repaymentPayments).where(eq(repaymentPayments.id, committed.paymentId));
    const [proj] = await app.db.select({ status: projects.status }).from(projects).where(eq(projects.id, id));
    const applied = await app.db
      .select({ amountMinor: repaymentApplications.amountMinor })
      .from(repaymentApplications)
      .where(eq(repaymentApplications.paymentId, committed.paymentId));
    const appliedMinor = applied.reduce((s, a) => s + a.amountMinor, 0);

    return reply.code(201).send({
      paymentId: committed.paymentId,
      amountMinor: committed.amountMinor,
      status: pay!.status,
      appliedMinor,
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

    const rows = await app.db
      .select({
        seq: repaymentInstallments.seq,
        amountMinor: repaymentInstallments.amountMinor,
        paidMinor: repaymentInstallments.paidMinor,
        dueAt: repaymentInstallments.dueAt,
        status: repaymentInstallments.status,
        settledAt: repaymentInstallments.settledAt,
        remindedAt: repaymentInstallments.remindedAt,
      })
      .from(repaymentInstallments)
      .where(eq(repaymentInstallments.projectId, id))
      .orderBy(asc(repaymentInstallments.seq));

    // `overdue` is derived server-side (never stored, never from the body): a `due`
    // installment whose due date has passed. A paid or future installment is not
    // overdue. Matches the sweep's selection (status = 'due' AND due_at < now).
    const now = Date.now();
    const installments = rows.map((r) => ({
      seq: r.seq,
      amountMinor: r.amountMinor,
      paidMinor: r.paidMinor,
      remainingMinor: r.amountMinor - r.paidMinor,
      dueAt: r.dueAt,
      status: r.status,
      settledAt: r.settledAt,
      overdue: r.status === "due" && r.dueAt.getTime() < now,
      remindedAt: r.remindedAt,
    }));

    const totalOwedMinor = installments.reduce((sum, i) => sum + i.amountMinor, 0);
    const paidCount = installments.filter((i) => i.status === "paid").length;
    const totalCount = installments.length;

    return reply.send({ installments, totalOwedMinor, paidCount, totalCount });
  });

  // Escrow repayment settlement webhook. NO session auth: the provider calls this,
  // so it is verified by a shared secret carried in the x-escrow-signature header,
  // compared against config.escrowWebhookSecret. An unset secret (empty) rejects
  // every caller, the safe prod default until a real secret is configured. Mirrors
  // escrow/routes.ts POST /escrow/settlement. Resolves the two-phase collection by
  // the PAYMENT ref (spec section 6). Idempotent: the guarded transitions in
  // settlePayment/failPayment make a replay a wholesale no-op.
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

    const [payment] = await app.db
      .select({ id: repaymentPayments.id })
      .from(repaymentPayments)
      .where(eq(repaymentPayments.ref, repaymentRef));
    if (!payment) {
      return reply.code(404).send({ error: { code: "not_found", message: "Payment not found" } });
    }

    if (status === "failed") {
      await failPayment(app.db, { paymentId: payment.id });
      return reply.send({ ok: true });
    }

    await settlePayment(app.db, { paymentId: payment.id, graceCutoffMs: Date.now() - app.config.defaultGraceDays * DAY_MS });
    return reply.send({ ok: true });
  });
}
