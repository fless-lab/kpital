import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { projectDocKind, projectDocuments, projects } from "../../db/schema";
import type { StorageProvider } from "../../lib/storage";
import { extForMime, sniffMime } from "../kyc/validate";
import { InvalidStateError, NotOwnerError, ProjectNotFoundError } from "./service";

export const PROJECT_DOC_KINDS = projectDocKind.enumValues as readonly string[];
export type ProjectDocKind = (typeof projectDocKind.enumValues)[number];
export type ProjectDocVisibility = "public" | "private";

// Photos are shown publicly on the project page; legal documents (rccm, foncier,
// releves) are private and only ever released to reviewers via a signed URL.
export function visibilityForKind(kind: ProjectDocKind): ProjectDocVisibility {
  return kind === "photo" ? "public" : "private";
}

// Statuses from which the owner may still attach documents.
const EDITABLE_STATUSES = new Set<(typeof projects.$inferSelect)["status"]>(["draft", "rejected"]);

// A per-file content problem (unreadable magic bytes / too large). Routes map
// this to a 400 validation_error.
export class DocValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocValidationError";
  }
}

export interface AddProjectDocumentInput {
  accountId: string;
  projectId: string;
  // The client-supplied `kind` field, validated here against the enum.
  kind: string | undefined;
  // The single buffered upload, or null when the request carried no file part.
  buffer: Buffer | null;
  maxBytes: number;
}

function isProjectDocKind(v: string | undefined): v is ProjectDocKind {
  return typeof v === "string" && PROJECT_DOC_KINDS.includes(v);
}

// Attach one document to the caller's own draft|rejected project. Checks run in
// the order the brief mandates: ownership + state FIRST (403 / 409 / 404), then
// the `kind` enum, then the file's true type by magic bytes (never the client
// Content-Type), then its size. The storage key is server-generated as
// projects/{projectId}/{docId}.{ext} — a client filename is never used.
export async function addProjectDocument(
  db: Db,
  storage: StorageProvider,
  input: AddProjectDocumentInput,
): Promise<{ documentId: string; kind: ProjectDocKind; visibility: ProjectDocVisibility }> {
  const [project] = await db
    .select({ ownerAccountId: projects.ownerAccountId, status: projects.status })
    .from(projects)
    .where(eq(projects.id, input.projectId));
  if (!project) throw new ProjectNotFoundError();
  if (project.ownerAccountId !== input.accountId) throw new NotOwnerError();
  if (!EDITABLE_STATUSES.has(project.status)) throw new InvalidStateError();

  if (!isProjectDocKind(input.kind)) throw new DocValidationError("invalid_kind");
  const kind = input.kind;
  if (input.buffer === null) throw new DocValidationError("file_required");

  const mime = sniffMime(input.buffer);
  if (mime === null) throw new DocValidationError("unsupported_file_type");
  if (input.buffer.length > input.maxBytes) throw new DocValidationError("file_too_large");

  const visibility = visibilityForKind(kind);
  const documentId = randomUUID();
  const storageKey = `projects/${input.projectId}/${documentId}.${extForMime(mime)}`;

  // Upload before the DB insert using the minted id so the storage key and the
  // row id always match. A failed insert leaves an orphaned object (reclaimable
  // by a later sweep of unreferenced keys) — same trade-off as KYC.
  await storage.put(storageKey, input.buffer, mime);

  await db.insert(projectDocuments).values({
    id: documentId,
    projectId: input.projectId,
    kind,
    visibility,
    storageKey,
    mime,
    sizeBytes: input.buffer.length,
  });

  return { documentId, kind, visibility };
}
