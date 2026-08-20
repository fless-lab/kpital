import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { accounts, kycDocuments, kycSubmissions } from "../../db/schema";
import type { StorageProvider } from "../../lib/storage";
import { expectedKinds, extForMime, sniffMime, type KycDocKind, type KycDocType } from "./validate";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export class KycValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KycValidationError";
  }
}

export type KycSubmission = typeof kycSubmissions.$inferSelect;

export interface KycFileInput {
  kind: KycDocKind;
  buffer: Buffer;
  clientMime: string;
}

export interface CreateSubmissionInput {
  accountId: string;
  docType: KycDocType;
  docNumber: string;
  dob: string;
  nationality: string;
  files: KycFileInput[];
  // Optional cap; the HTTP route (Task 5) passes config.kycMaxFileMb * 1024 * 1024.
  maxBytes?: number;
}

// Validate the provided file set against the doc type's required kinds. The
// clientMime is advisory only — actual type is decided by magic bytes at upload.
function validateFileSet(docType: KycDocType, files: KycFileInput[]): void {
  const expected = [...expectedKinds(docType)].sort();
  const got = files.map((f) => f.kind).sort();
  if (expected.length !== got.length || expected.some((k, i) => k !== got[i])) {
    throw new KycValidationError("bad_file_set");
  }
}

export async function createSubmission(
  db: Db,
  storage: StorageProvider,
  input: CreateSubmissionInput,
): Promise<{ submissionId: string }> {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;

  // 1. File-set check (count + kinds) before touching any file contents.
  validateFileSet(input.docType, input.files);

  // 2. Per-file magic-byte sniff + size. Resolve the true mime here so it is
  //    used both for storage metadata and the stored kyc_document.mime.
  const prepared = input.files.map((f) => {
    const mime = sniffMime(f.buffer);
    if (mime === null) throw new KycValidationError("unsupported_file_type");
    if (f.buffer.length > maxBytes) throw new KycValidationError("file_too_large");
    return { kind: f.kind, buffer: f.buffer, mime };
  });

  // 3. Mint the submission id up front so storage keys are server-generated and
  //    never derived from a client filename.
  const submissionId = randomUUID();
  const objects = prepared.map((p) => ({
    kind: p.kind,
    buffer: p.buffer,
    mime: p.mime,
    key: `kyc/${input.accountId}/${submissionId}/${p.kind}.${extForMime(p.mime)}`,
  }));

  // Uploads happen BEFORE the DB transaction using the minted id. If the txn
  // below fails the uploaded objects are orphaned in storage — acceptable for
  // now (a later sweep/GC can reclaim them by unreferenced key).
  for (const o of objects) {
    await storage.put(o.key, o.buffer, o.mime);
  }

  // 4. One transaction: supersede prior active submissions, insert the new
  //    submission + its documents, and mirror the account's kyc_status.
  await db.transaction(async (tx) => {
    await tx
      .update(kycSubmissions)
      .set({ superseded: true })
      .where(and(eq(kycSubmissions.accountId, input.accountId), eq(kycSubmissions.superseded, false)));

    await tx.insert(kycSubmissions).values({
      id: submissionId,
      accountId: input.accountId,
      docType: input.docType,
      docNumber: input.docNumber,
      dob: input.dob,
      nationality: input.nationality,
      status: "pending",
    });

    await tx.insert(kycDocuments).values(
      objects.map((o) => ({
        submissionId,
        kind: o.kind,
        storageKey: o.key,
        mime: o.mime,
        sizeBytes: o.buffer.length,
      })),
    );

    await tx.update(accounts).set({ kycStatus: "pending" }).where(eq(accounts.id, input.accountId));
  });

  return { submissionId };
}

// The account's current, non-superseded submission (newest first), or undefined.
export async function getActiveSubmission(db: Db, accountId: string): Promise<KycSubmission | undefined> {
  const [row] = await db
    .select()
    .from(kycSubmissions)
    .where(and(eq(kycSubmissions.accountId, accountId), eq(kycSubmissions.superseded, false)))
    .orderBy(desc(kycSubmissions.createdAt))
    .limit(1);
  return row;
}
