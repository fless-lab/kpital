import { desc, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { projects } from "../../db/schema";

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
