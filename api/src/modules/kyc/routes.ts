import type { FastifyInstance, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { kycDocKind, kycDocType, kycDocuments } from "../../db/schema";
import {
  createSubmission,
  getActiveSubmission,
  KycValidationError,
  type KycFileInput,
} from "./service";
import type { KycDocKind, KycDocType } from "./validate";

const DOC_TYPES = kycDocType.enumValues as readonly string[];
const DOC_KINDS = kycDocKind.enumValues as readonly string[];

function validationError(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: { code: "validation_error", message } });
}

// True only if `YYYY-MM-DD` names an existing calendar day. Date.UTC rolls an
// out-of-range month/day into a neighbouring date, so an impossible value fails
// the part-by-part round-trip comparison instead of silently normalising.
function isRealDate(dob: string): boolean {
  const y = Number(dob.slice(0, 4));
  const m = Number(dob.slice(5, 7));
  const d = Number(dob.slice(8, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export default async function kycRoutes(app: FastifyInstance) {
  app.post("/kyc/submission", { preHandler: app.requireAuth }, async (req, reply) => {
    const accountId = req.accountId;
    if (!accountId) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "Login required" } });
    }

    const fields: Record<string, string> = {};
    const files: KycFileInput[] = [];
    // Record the first validation problem but KEEP iterating: an early return
    // would leave later file parts unconsumed, and @fastify/multipart marks
    // req._consuming so Node won't auto-drain them — a paused stream can stall
    // body parsing until requestTimeout. Every part is consumed exactly once
    // (toBuffer for accepted files, resume() to drain rejected ones).
    let earlyError: string | null = null;

    for await (const part of req.parts()) {
      if (part.type === "file") {
        if (!DOC_KINDS.includes(part.fieldname)) {
          if (earlyError === null) earlyError = "unknown_file_field";
          part.file.resume();
          continue;
        }
        const buffer = await part.toBuffer();
        files.push({ kind: part.fieldname as KycDocKind, buffer, clientMime: part.mimetype });
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }

    if (earlyError !== null) {
      return validationError(reply, earlyError);
    }

    const docType = fields.doc_type;
    const docNumber = fields.doc_number;
    const dob = fields.dob;
    const nationality = fields.nationality;

    if (typeof docType !== "string" || !DOC_TYPES.includes(docType)) {
      return validationError(reply, "invalid_doc_type");
    }
    if (typeof docNumber !== "string" || docNumber.trim() === "") {
      return validationError(reply, "invalid_doc_number");
    }
    // dob feeds a Postgres `date` column: reject anything not YYYY-MM-DD so a bad
    // value surfaces as our 400 envelope, not a driver 500. The shape regex alone
    // lets impossible dates (e.g. 2026-99-99) through, so also confirm it is a
    // real calendar date by round-tripping through Date.UTC (which rolls invalid
    // months/days over instead of matching the input parts).
    if (typeof dob !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dob) || !isRealDate(dob)) {
      return validationError(reply, "invalid_dob");
    }
    if (typeof nationality !== "string" || nationality.trim() === "") {
      return validationError(reply, "invalid_nationality");
    }

    const maxBytes = app.config.kycMaxFileMb * 1024 * 1024;

    let submissionId: string;
    try {
      const result = await createSubmission(app.db, app.storage, {
        accountId,
        docType: docType as KycDocType,
        docNumber,
        dob,
        nationality,
        files,
        maxBytes,
      });
      submissionId = result.submissionId;
    } catch (err) {
      if (err instanceof KycValidationError) {
        return validationError(reply, err.message);
      }
      throw err;
    }

    await app.verifier.submitForReview(submissionId);
    return reply.code(201).send({ submissionId, status: "pending" });
  });

  app.get("/kyc/me", { preHandler: app.requireAuth }, async (req, reply) => {
    const accountId = req.accountId;
    if (!accountId) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "Login required" } });
    }

    const submission = await getActiveSubmission(app.db, accountId);
    if (!submission) {
      return reply.send({ submission: null, documents: [] });
    }

    // Ownership already enforced: getActiveSubmission scoped by accountId.
    const docs = await app.db
      .select()
      .from(kycDocuments)
      .where(eq(kycDocuments.submissionId, submission.id));

    const documents = await Promise.all(
      docs.map(async (d) => ({
        kind: d.kind,
        mime: d.mime,
        sizeBytes: d.sizeBytes,
        url: await app.storage.getSignedUrl(d.storageKey, app.config.kycUrlTtlSeconds),
      })),
    );

    // Project only user-facing columns: reviewedBy (an admin UUID), superseded,
    // and reviewedAt are internal review state and must not leak to the subject.
    const publicSubmission = {
      id: submission.id,
      docType: submission.docType,
      docNumber: submission.docNumber,
      dob: submission.dob,
      nationality: submission.nationality,
      status: submission.status,
      rejectReason: submission.rejectReason,
      createdAt: submission.createdAt,
    };

    return reply.send({ submission: publicSubmission, documents });
  });
}
