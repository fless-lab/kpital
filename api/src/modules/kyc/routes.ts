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

export default async function kycRoutes(app: FastifyInstance) {
  app.post("/kyc/submission", { preHandler: app.requireAuth }, async (req, reply) => {
    const accountId = req.accountId;
    if (!accountId) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "Login required" } });
    }

    const fields: Record<string, string> = {};
    const files: KycFileInput[] = [];

    // Consume each part's stream inside the loop (toBuffer before advancing the
    // async iterator), or later parts hang / yield empty buffers.
    for await (const part of req.parts()) {
      if (part.type === "file") {
        if (!DOC_KINDS.includes(part.fieldname)) {
          // Drain the un-consumed file stream before returning: @fastify/multipart
          // marks req._consuming, so Node won't auto-drain the body and a paused
          // stream can hang the socket until requestTimeout.
          part.file.resume();
          return validationError(reply, "unknown_file_field");
        }
        const buffer = await part.toBuffer();
        files.push({ kind: part.fieldname as KycDocKind, buffer, clientMime: part.mimetype });
      } else {
        fields[part.fieldname] = String(part.value);
      }
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
    // value surfaces as our 400 envelope, not a driver 500.
    if (typeof dob !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
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

    return reply.send({ submission, documents });
  });
}
