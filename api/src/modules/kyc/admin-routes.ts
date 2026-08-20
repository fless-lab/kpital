import type { FastifyInstance, FastifyReply } from "fastify";
import { desc, eq } from "drizzle-orm";
import { accounts, kycDocuments, kycSubmissions, kycSubStatus } from "../../db/schema";

const SUB_STATUSES = kycSubStatus.enumValues as readonly string[];
const DECISIONS = ["verified", "rejected"] as const;
type Decision = (typeof DECISIONS)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Metadata-only projection for the queue and detail view: files live behind
// signed URLs, and password_hash is structurally unreachable (different table).
const submissionColumns = {
  id: kycSubmissions.id,
  accountId: kycSubmissions.accountId,
  docType: kycSubmissions.docType,
  docNumber: kycSubmissions.docNumber,
  dob: kycSubmissions.dob,
  nationality: kycSubmissions.nationality,
  status: kycSubmissions.status,
  rejectReason: kycSubmissions.rejectReason,
  reviewedBy: kycSubmissions.reviewedBy,
  reviewedAt: kycSubmissions.reviewedAt,
  createdAt: kycSubmissions.createdAt,
};

function validationError(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: { code: "validation_error", message } });
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ error: { code: "not_found", message: "Submission not found" } });
}

// Sentinel thrown inside the decision transaction when the target submission
// does not exist, so the txn rolls back and we translate it to a 404 outside.
class SubmissionNotFoundError extends Error {}

export default async function kycAdminRoutes(app: FastifyInstance) {
  const guard = { preHandler: [app.requireAuth, app.requireAdmin] };

  // GET /admin/kyc?status=pending — queue, metadata only. Default pending;
  // an off-enum status is a 400 (never reaches the enum column → no 22P02).
  app.get("/admin/kyc", guard, async (req, reply) => {
    const query = (req.query ?? {}) as { status?: unknown; limit?: unknown };
    const status = query.status === undefined ? "pending" : String(query.status);
    if (!SUB_STATUSES.includes(status)) {
      return validationError(reply, `status must be one of ${SUB_STATUSES.join(", ")}`);
    }
    const rawLimit = typeof query.limit === "string" ? Number.parseInt(query.limit, 10) : NaN;
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 && rawLimit <= 200 ? rawLimit : 50;

    const submissions = await app.db
      .select(submissionColumns)
      .from(kycSubmissions)
      .where(eq(kycSubmissions.status, status as Decision | "pending"))
      // Deterministic order: newest first, id as tiebreak (no arbitrary row order).
      .orderBy(desc(kycSubmissions.createdAt), desc(kycSubmissions.id))
      .limit(limit);

    return reply.send({ submissions });
  });

  // GET /admin/kyc/:id — submission detail + documents[] with short-TTL signed
  // URLs. Emits an audit line. 404 for a non-UUID or absent id.
  app.get("/admin/kyc/:id", guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) {
      return notFound(reply);
    }
    const [submission] = await app.db
      .select(submissionColumns)
      .from(kycSubmissions)
      .where(eq(kycSubmissions.id, id));
    if (!submission) {
      return notFound(reply);
    }

    // AUDIT: who viewed which submission's documents.
    req.log.info({ adminId: req.accountId, submissionId: id, action: "kyc_view" });

    const docs = await app.db
      .select()
      .from(kycDocuments)
      .where(eq(kycDocuments.submissionId, id));

    const documents = await Promise.all(
      docs.map(async (d) => ({
        kind: d.kind,
        mime: d.mime,
        sizeBytes: d.sizeBytes,
        url: await app.storage.getSignedUrl(d.storageKey, app.config.kycUrlTtlSeconds),
      })),
    );

    return reply.send({ submission, documents });
  });

  // POST /admin/kyc/:id/decision — { decision, reason? }. Validates body BEFORE
  // touching the DB (so "reject w/o reason" is 400 even for an absent id), then
  // in ONE transaction updates the submission and mirrors accounts.kyc_status.
  app.post("/admin/kyc/:id/decision", guard, async (req, reply) => {
    const adminId = req.accountId;
    if (!adminId) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "Login required" } });
    }
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { decision?: unknown; reason?: unknown };

    const decision = body.decision;
    if (typeof decision !== "string" || !DECISIONS.includes(decision as Decision)) {
      return validationError(reply, `decision must be one of ${DECISIONS.join(", ")}`);
    }
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (decision === "rejected" && reason === "") {
      return validationError(reply, "reason is required when rejecting");
    }

    if (!UUID_RE.test(id)) {
      return notFound(reply);
    }

    try {
      await app.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(kycSubmissions)
          .set({
            status: decision as Decision,
            reviewedBy: adminId,
            reviewedAt: new Date(),
            rejectReason: decision === "rejected" ? reason : null,
          })
          .where(eq(kycSubmissions.id, id))
          .returning({ accountId: kycSubmissions.accountId });

        if (!updated) {
          throw new SubmissionNotFoundError();
        }

        await tx
          .update(accounts)
          .set({ kycStatus: decision as Decision, updatedAt: new Date() })
          .where(eq(accounts.id, updated.accountId));
      });
    } catch (err) {
      if (err instanceof SubmissionNotFoundError) {
        return notFound(reply);
      }
      throw err;
    }

    return reply.code(200).send({ id, status: decision });
  });
}
