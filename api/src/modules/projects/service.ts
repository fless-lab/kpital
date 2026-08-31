import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { projectDocuments, projectFollows, projectUpvotes, projects } from "../../db/schema";

// Owner mismatch — the caller is not the project's owner. Routes map this to 403.
export class NotOwnerError extends Error {
  constructor(message = "not_owner") {
    super(message);
    this.name = "NotOwnerError";
  }
}

// The project's current status forbids the attempted transition. Routes map this
// to 409 invalid_state. Edit/submit are allowed only while status ∈ {draft, rejected}.
export class InvalidStateError extends Error {
  constructor(message = "invalid_state") {
    super(message);
    this.name = "InvalidStateError";
  }
}

// The referenced project id does not exist. Routes map this to 404.
export class ProjectNotFoundError extends Error {
  constructor(message = "not_found") {
    super(message);
    this.name = "ProjectNotFoundError";
  }
}

export type Project = typeof projects.$inferSelect;
export type ProjectCategory = (typeof projects.$inferSelect)["category"];

// The porteur-supplied create payload, already validated by the route.
// roiPct is a NUMBER at the API boundary; it is stored as a numeric string.
export interface CreateProjectInput {
  category: ProjectCategory;
  title: string;
  city: string;
  quartier: string | null;
  description: string;
  targetMinor: number;
  durationMonths: number;
  roiPct: number;
  fundsUsage: string;
  cautionType: string;
}

// A partial edit. Only the fields present are applied; the service ignores any
// other keys (defence in depth against a route that forgets to strip them).
export type ProjectPatch = Partial<{
  category: ProjectCategory;
  title: string;
  city: string;
  quartier: string | null;
  description: string;
  targetMinor: number;
  durationMonths: number;
  roiPct: number;
  fundsUsage: string;
  cautionType: string;
}>;

// Statuses from which a porteur may still edit or submit their own project.
const EDITABLE_STATUSES = new Set<Project["status"]>(["draft", "rejected"]);

// Insert a new project owned by ownerId in the draft state. ownerAccountId is
// always the authenticated caller — never taken from the request body.
export async function createProject(
  db: Db,
  ownerId: string,
  input: CreateProjectInput,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(projects)
    .values({
      ownerAccountId: ownerId,
      category: input.category,
      title: input.title,
      city: input.city,
      quartier: input.quartier,
      description: input.description,
      targetMinor: input.targetMinor,
      durationMonths: input.durationMonths,
      // numeric column: store the number as its string representation.
      roiPct: String(input.roiPct),
      fundsUsage: input.fundsUsage,
      cautionType: input.cautionType,
      status: "draft",
    })
    .returning({ id: projects.id });
  if (!row) throw new Error("project insert returned no row");
  return { id: row.id };
}

// Apply an allowlisted patch to the caller's own project. The read + state check
// + write run in one transaction with a row lock so two concurrent edits cannot
// both pass the state check.
export async function updateProject(
  db: Db,
  ownerId: string,
  id: string,
  patch: ProjectPatch,
): Promise<Project> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(projects).where(eq(projects.id, id)).for("update");
    if (!row) throw new ProjectNotFoundError();
    if (row.ownerAccountId !== ownerId) throw new NotOwnerError();
    if (!EDITABLE_STATUSES.has(row.status)) throw new InvalidStateError();

    // Explicit allowlist: only these editable fields are ever written. status,
    // ownerAccountId, score, rejectReason, reviewedBy/At, publishedAt, counts,
    // etc. are intentionally NOT assignable here.
    const updates: Partial<typeof projects.$inferInsert> = {};
    if (patch.category !== undefined) updates.category = patch.category;
    if (patch.title !== undefined) updates.title = patch.title;
    if (patch.city !== undefined) updates.city = patch.city;
    if (patch.quartier !== undefined) updates.quartier = patch.quartier;
    if (patch.description !== undefined) updates.description = patch.description;
    if (patch.targetMinor !== undefined) updates.targetMinor = patch.targetMinor;
    if (patch.durationMonths !== undefined) updates.durationMonths = patch.durationMonths;
    if (patch.roiPct !== undefined) updates.roiPct = String(patch.roiPct);
    if (patch.fundsUsage !== undefined) updates.fundsUsage = patch.fundsUsage;
    if (patch.cautionType !== undefined) updates.cautionType = patch.cautionType;
    updates.updatedAt = new Date();

    const [updated] = await tx.update(projects).set(updates).where(eq(projects.id, id)).returning();
    if (!updated) throw new ProjectNotFoundError();
    return updated;
  });
}

// Transition draft|rejected → submitted for the caller's own project. Locked
// read + write in one transaction so a double-submit cannot race the check.
export async function submitProject(db: Db, ownerId: string, id: string): Promise<Project> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(projects).where(eq(projects.id, id)).for("update");
    if (!row) throw new ProjectNotFoundError();
    if (row.ownerAccountId !== ownerId) throw new NotOwnerError();
    if (!EDITABLE_STATUSES.has(row.status)) throw new InvalidStateError();

    const [updated] = await tx
      .update(projects)
      .set({ status: "submitted", updatedAt: new Date() })
      .where(eq(projects.id, id))
      .returning();
    if (!updated) throw new ProjectNotFoundError();
    return updated;
  });
}

// The caller's own projects, newest first.
export async function listMine(db: Db, ownerId: string): Promise<Project[]> {
  return db
    .select()
    .from(projects)
    .where(eq(projects.ownerAccountId, ownerId))
    .orderBy(desc(projects.createdAt));
}

// ---------------------------------------------------------------------------
// Public surfaces (showcase, funding, detail)
// ---------------------------------------------------------------------------

// A project is publicly visible only in these states. draft/submitted/in_review/
// rejected are internal and must never surface on a public route.
export const PUBLIC_STATUSES = ["showcase", "collecting", "funded", "repaying", "closed"] as const;
export type PublicStatus = (typeof PUBLIC_STATUSES)[number];
const PUBLIC_STATUS_SET = new Set<Project["status"]>(PUBLIC_STATUSES);

// The single source of truth for what the public may see of a project. It
// deliberately OMITS ownerAccountId, reviewedBy, reviewedAt and rejectReason
// (porteur PII / internal review data) and the internal-only fields
// (fundsUsage, cautionType, collectingOpenedAt, updatedAt). Every public route
// selects exactly these columns so the public field set is defined once.
export const PUBLIC_PROJECT_COLUMNS = {
  id: projects.id,
  category: projects.category,
  title: projects.title,
  city: projects.city,
  quartier: projects.quartier,
  description: projects.description,
  targetMinor: projects.targetMinor,
  raisedMinor: projects.raisedMinor,
  durationMonths: projects.durationMonths,
  roiPct: projects.roiPct,
  fundsUsage: projects.fundsUsage,
  cautionType: projects.cautionType,
  status: projects.status,
  score: projects.score,
  upvoteCount: projects.upvoteCount,
  followCount: projects.followCount,
  publishedAt: projects.publishedAt,
  createdAt: projects.createdAt,
} as const;

export type PublicProject = {
  [K in keyof typeof PUBLIC_PROJECT_COLUMNS]: Project[K];
};

// The funding surface (status=collecting) deliberately DROPS upvoteCount and
// followCount: votes/follows are a Showcase-only social signal and must not
// appear on the funding catalog cards (a regulatory guardrail). Everything else
// the card needs is kept. Showcase and the detail route keep the full projection.
export const FUNDING_PROJECT_COLUMNS = {
  id: projects.id,
  category: projects.category,
  title: projects.title,
  city: projects.city,
  quartier: projects.quartier,
  description: projects.description,
  targetMinor: projects.targetMinor,
  raisedMinor: projects.raisedMinor,
  durationMonths: projects.durationMonths,
  roiPct: projects.roiPct,
  fundsUsage: projects.fundsUsage,
  cautionType: projects.cautionType,
  status: projects.status,
  score: projects.score,
  publishedAt: projects.publishedAt,
  createdAt: projects.createdAt,
} as const;

export type FundingProject = {
  [K in keyof typeof FUNDING_PROJECT_COLUMNS]: Project[K];
};

// Only the fields the detail route needs to build a public document entry.
// storageKey is fetched so the route can mint a signed URL, then dropped — it is
// NEVER returned to the client.
export interface PublicDocumentRow {
  id: string;
  kind: (typeof projectDocuments.$inferSelect)["kind"];
  mime: string;
  sizeBytes: number;
  createdAt: Date;
  storageKey: string;
}

export interface PublicListFilters {
  category?: ProjectCategory;
  score?: NonNullable<Project["score"]>;
  limit: number;
}

// List public projects at exactly one status. The caller passes a single status
// so /showcase and /funding stay mutually exclusive. The sort is deterministic
// and FACTUAL — never by upvoteCount (a regulatory guardrail for the funding
// catalog): newest-published first, then createdAt, with an id tiebreak for a
// total order (rows seeded directly have publishedAt = null → DESC floats them
// first, which is acceptable for a not-yet-published collecting row).
function publicListConds(status: PublicStatus, filters: PublicListFilters) {
  const conds = [eq(projects.status, status)];
  if (filters.category !== undefined) conds.push(eq(projects.category, filters.category));
  if (filters.score !== undefined) conds.push(eq(projects.score, filters.score));
  return conds;
}

export async function listPublicProjects(
  db: Db,
  status: PublicStatus,
  filters: PublicListFilters,
): Promise<PublicProject[]> {
  return db
    .select(PUBLIC_PROJECT_COLUMNS)
    .from(projects)
    .where(and(...publicListConds(status, filters)))
    .orderBy(desc(projects.publishedAt), desc(projects.createdAt), asc(projects.id))
    .limit(filters.limit);
}

// The funding catalog (status=collecting) with the FUNDING projection — same
// factual ordering, minus the Showcase-only vote/follow counts.
export async function listFundingProjects(
  db: Db,
  filters: PublicListFilters,
): Promise<FundingProject[]> {
  return db
    .select(FUNDING_PROJECT_COLUMNS)
    .from(projects)
    .where(and(...publicListConds("collecting", filters)))
    .orderBy(desc(projects.publishedAt), desc(projects.createdAt), asc(projects.id))
    .limit(filters.limit);
}

// Fetch one project for the public detail route. Returns null when the id is
// unknown OR its status is not publicly visible (both map to 404). Documents are
// filtered to visibility="public" here so a private legal doc can never be
// selected in the first place.
export async function getPublicProject(
  db: Db,
  id: string,
): Promise<{ project: PublicProject; documents: PublicDocumentRow[] } | null> {
  const [project] = await db
    .select(PUBLIC_PROJECT_COLUMNS)
    .from(projects)
    .where(eq(projects.id, id));
  if (!project || !PUBLIC_STATUS_SET.has(project.status)) return null;

  const documents = await db
    .select({
      id: projectDocuments.id,
      kind: projectDocuments.kind,
      mime: projectDocuments.mime,
      sizeBytes: projectDocuments.sizeBytes,
      createdAt: projectDocuments.createdAt,
      storageKey: projectDocuments.storageKey,
    })
    .from(projectDocuments)
    .where(and(eq(projectDocuments.projectId, id), eq(projectDocuments.visibility, "public")))
    .orderBy(asc(projectDocuments.createdAt), asc(projectDocuments.id));

  return { project, documents };
}

// ---------------------------------------------------------------------------
// Engagement (follow, upvote, my-state)
// ---------------------------------------------------------------------------

// Follow a project ("notify me when it opens"). Allowed only while the project
// is publicly visible. The membership row and the counter move together in ONE
// transaction: insert-on-conflict-do-nothing, and increment followCount with a
// SQL expression ONLY when a row was actually inserted — so a repeated follow is
// idempotent and never double-counts. The status is read WITHOUT a row lock: the
// counter UPDATE takes its own lock and the composite PK is what makes the count
// exact, so locking the status read would needlessly serialize concurrent
// followers of the same project.
export async function followProject(db: Db, accountId: string, projectId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [project] = await tx
      .select({ status: projects.status })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) throw new ProjectNotFoundError();
    if (!PUBLIC_STATUS_SET.has(project.status)) throw new InvalidStateError();

    const inserted = await tx
      .insert(projectFollows)
      .values({ accountId, projectId })
      .onConflictDoNothing()
      .returning();
    if (inserted.length > 0) {
      await tx
        .update(projects)
        .set({ followCount: sql`${projects.followCount} + 1` })
        .where(eq(projects.id, projectId));
    }
  });
}

// Unfollow. Symmetric to follow and always idempotent: no status guard and no
// existence check — removing your own follow must succeed even after the project
// has left the publicly-visible states. Decrement ONLY when a row was actually
// removed.
export async function unfollowProject(db: Db, accountId: string, projectId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const removed = await tx
      .delete(projectFollows)
      .where(and(eq(projectFollows.accountId, accountId), eq(projectFollows.projectId, projectId)))
      .returning();
    if (removed.length > 0) {
      await tx
        .update(projects)
        .set({ followCount: sql`${projects.followCount} - 1` })
        .where(eq(projects.id, projectId));
    }
  });
}

// Upvote a project. Allowed ONLY while status=showcase (regulatory guardrail);
// any other status → InvalidStateError (409). Same atomic, idempotent counter
// mechanism as followProject.
export async function upvoteProject(db: Db, accountId: string, projectId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [project] = await tx
      .select({ status: projects.status })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) throw new ProjectNotFoundError();
    if (project.status !== "showcase") throw new InvalidStateError();

    const inserted = await tx
      .insert(projectUpvotes)
      .values({ accountId, projectId })
      .onConflictDoNothing()
      .returning();
    if (inserted.length > 0) {
      await tx
        .update(projects)
        .set({ upvoteCount: sql`${projects.upvoteCount} + 1` })
        .where(eq(projects.id, projectId));
    }
  });
}

// Remove an upvote. Symmetric to upvote: no status guard, no existence check,
// always idempotent. Decrement ONLY when a row was actually removed.
export async function removeUpvote(db: Db, accountId: string, projectId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const removed = await tx
      .delete(projectUpvotes)
      .where(and(eq(projectUpvotes.accountId, accountId), eq(projectUpvotes.projectId, projectId)))
      .returning();
    if (removed.length > 0) {
      await tx
        .update(projects)
        .set({ upvoteCount: sql`${projects.upvoteCount} - 1` })
        .where(eq(projects.id, projectId));
    }
  });
}

// The caller's engagement state for one project: whether they follow it and
// whether they have upvoted it.
export async function getEngagement(
  db: Db,
  accountId: string,
  projectId: string,
): Promise<{ following: boolean; upvoted: boolean }> {
  const [follow] = await db
    .select({ projectId: projectFollows.projectId })
    .from(projectFollows)
    .where(and(eq(projectFollows.accountId, accountId), eq(projectFollows.projectId, projectId)));
  const [upvote] = await db
    .select({ projectId: projectUpvotes.projectId })
    .from(projectUpvotes)
    .where(and(eq(projectUpvotes.accountId, accountId), eq(projectUpvotes.projectId, projectId)));
  return { following: follow !== undefined, upvoted: upvote !== undefined };
}
