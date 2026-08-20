import type { FastifyInstance, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { accounts, projectCategory } from "../../db/schema";
import {
  createProject,
  updateProject,
  submitProject,
  listMine,
  listPublicProjects,
  getPublicProject,
  followProject,
  unfollowProject,
  upvoteProject,
  removeUpvote,
  getEngagement,
  NotOwnerError,
  InvalidStateError,
  ProjectNotFoundError,
  type CreateProjectInput,
  type ProjectCategory,
  type ProjectPatch,
  type PublicListFilters,
} from "./service";
import { projectScore } from "../../db/schema";
import { addProjectDocument, DocValidationError } from "./documents";

const CATEGORIES = projectCategory.enumValues as readonly string[];
const SCORES = projectScore.enumValues as readonly string[];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

// Parse the optional public list query params. Unknown enum values are rejected
// (a raw ?score=Z would otherwise reach pg as an invalid enum literal → 22P02 →
// 500). limit is clamped; a non-numeric limit falls back to the default.
function parsePublicFilters(query: Record<string, unknown>): Parsed<PublicListFilters> {
  const filters: PublicListFilters = { limit: DEFAULT_LIMIT };

  if (query.category !== undefined) {
    if (typeof query.category !== "string" || !CATEGORIES.includes(query.category)) {
      return { ok: false, message: "category must be one of immobilier, commerce, agriculture" };
    }
    filters.category = query.category as ProjectCategory;
  }
  if (query.score !== undefined) {
    if (typeof query.score !== "string" || !SCORES.includes(query.score)) {
      return { ok: false, message: "score must be one of A, B, C, D" };
    }
    filters.score = query.score as NonNullable<PublicListFilters["score"]>;
  }
  if (query.limit !== undefined) {
    const n = Number(query.limit);
    if (Number.isFinite(n) && Number.isInteger(n) && n > 0) {
      filters.limit = Math.min(n, MAX_LIMIT);
    }
  }
  return { ok: true, value: filters };
}
// Canonical UUID shape. A non-UUID :id would otherwise reach pg and throw
// 22P02, which the central handler turns into a 500 — reject it as a 400 first.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}
function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}
function isPositiveNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

function validateCreate(body: Record<string, unknown>): Parsed<CreateProjectInput> {
  if (typeof body.category !== "string" || !CATEGORIES.includes(body.category)) {
    return { ok: false, message: "category must be one of immobilier, commerce, agriculture" };
  }
  if (!isNonEmptyString(body.title)) return { ok: false, message: "title must be a non-empty string" };
  if (!isNonEmptyString(body.city)) return { ok: false, message: "city must be a non-empty string" };
  if (!isNonEmptyString(body.description)) return { ok: false, message: "description must be a non-empty string" };
  if (!isPositiveInt(body.targetMinor)) return { ok: false, message: "targetMinor must be a positive integer" };
  if (!isPositiveInt(body.durationMonths)) return { ok: false, message: "durationMonths must be a positive integer" };
  if (!isPositiveNumber(body.roiPct)) return { ok: false, message: "roiPct must be a positive number" };
  if (!isNonEmptyString(body.fundsUsage)) return { ok: false, message: "fundsUsage must be a non-empty string" };
  if (!isNonEmptyString(body.cautionType)) return { ok: false, message: "cautionType must be a non-empty string" };

  let quartier: string | null = null;
  if ("quartier" in body && body.quartier !== null && body.quartier !== undefined) {
    if (!isNonEmptyString(body.quartier)) return { ok: false, message: "quartier must be a non-empty string" };
    quartier = body.quartier.trim();
  }

  return {
    ok: true,
    value: {
      category: body.category as ProjectCategory,
      title: body.title.trim(),
      city: body.city.trim(),
      quartier,
      description: body.description.trim(),
      targetMinor: body.targetMinor,
      durationMonths: body.durationMonths,
      roiPct: body.roiPct,
      fundsUsage: body.fundsUsage.trim(),
      cautionType: body.cautionType.trim(),
    },
  };
}

function validatePatch(body: Record<string, unknown>): Parsed<ProjectPatch> {
  const patch: ProjectPatch = {};

  if ("category" in body) {
    if (typeof body.category !== "string" || !CATEGORIES.includes(body.category)) {
      return { ok: false, message: "category must be one of immobilier, commerce, agriculture" };
    }
    patch.category = body.category as ProjectCategory;
  }
  if ("title" in body) {
    if (!isNonEmptyString(body.title)) return { ok: false, message: "title must be a non-empty string" };
    patch.title = body.title.trim();
  }
  if ("city" in body) {
    if (!isNonEmptyString(body.city)) return { ok: false, message: "city must be a non-empty string" };
    patch.city = body.city.trim();
  }
  if ("quartier" in body) {
    if (body.quartier === null) {
      patch.quartier = null;
    } else if (isNonEmptyString(body.quartier)) {
      patch.quartier = body.quartier.trim();
    } else {
      return { ok: false, message: "quartier must be a non-empty string or null" };
    }
  }
  if ("description" in body) {
    if (!isNonEmptyString(body.description)) return { ok: false, message: "description must be a non-empty string" };
    patch.description = body.description.trim();
  }
  if ("targetMinor" in body) {
    if (!isPositiveInt(body.targetMinor)) return { ok: false, message: "targetMinor must be a positive integer" };
    patch.targetMinor = body.targetMinor;
  }
  if ("durationMonths" in body) {
    if (!isPositiveInt(body.durationMonths)) return { ok: false, message: "durationMonths must be a positive integer" };
    patch.durationMonths = body.durationMonths;
  }
  if ("roiPct" in body) {
    if (!isPositiveNumber(body.roiPct)) return { ok: false, message: "roiPct must be a positive number" };
    patch.roiPct = body.roiPct;
  }
  if ("fundsUsage" in body) {
    if (!isNonEmptyString(body.fundsUsage)) return { ok: false, message: "fundsUsage must be a non-empty string" };
    patch.fundsUsage = body.fundsUsage.trim();
  }
  if ("cautionType" in body) {
    if (!isNonEmptyString(body.cautionType)) return { ok: false, message: "cautionType must be a non-empty string" };
    patch.cautionType = body.cautionType.trim();
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, message: "No updatable fields provided" };
  }
  return { ok: true, value: patch };
}

function mapProjectError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof NotOwnerError) {
    return reply.code(403).send({ error: { code: "forbidden", message: "Not your project" } });
  }
  if (err instanceof InvalidStateError) {
    return reply
      .code(409)
      .send({ error: { code: "invalid_state", message: "Project cannot be modified in its current state" } });
  }
  if (err instanceof ProjectNotFoundError) {
    return reply.code(404).send({ error: { code: "not_found", message: "Project not found" } });
  }
  throw err;
}

export default async function projectRoutes(app: FastifyInstance) {
  const requireAccount = (accountId: string | null, reply: FastifyReply): accountId is string => {
    if (!accountId) {
      reply.code(401).send({ error: { code: "unauthorized", message: "Login required" } });
      return false;
    }
    return true;
  };
  const validationError = (reply: FastifyReply, message: string) =>
    reply.code(400).send({ error: { code: "validation_error", message } });

  // POST /projects — create a draft. Requires the porteur role, read from the DB
  // (never the session) so a role granted after login still takes effect.
  app.post("/projects", { preHandler: app.requireAuth }, async (req, reply) => {
    const accountId = req.accountId;
    if (!requireAccount(accountId, reply)) return;

    const [account] = await app.db
      .select({ roles: accounts.roles })
      .from(accounts)
      .where(eq(accounts.id, accountId));
    if (!account) {
      return reply.code(404).send({ error: { code: "not_found", message: "Account not found" } });
    }
    if (!account.roles.includes("porteur")) {
      return reply.code(403).send({ error: { code: "forbidden", message: "Porteur role required" } });
    }

    const parsed = validateCreate((req.body ?? {}) as Record<string, unknown>);
    if (!parsed.ok) return validationError(reply, parsed.message);

    const { id } = await createProject(app.db, accountId, parsed.value);
    return reply.code(201).send({ id });
  });

  // PATCH /projects/:id — edit own project while draft|rejected.
  app.patch("/projects/:id", { preHandler: app.requireAuth }, async (req, reply) => {
    const accountId = req.accountId;
    if (!requireAccount(accountId, reply)) return;

    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return validationError(reply, "invalid project id");

    const parsed = validatePatch((req.body ?? {}) as Record<string, unknown>);
    if (!parsed.ok) return validationError(reply, parsed.message);

    try {
      const project = await updateProject(app.db, accountId, id, parsed.value);
      return reply.send({ project });
    } catch (err) {
      return mapProjectError(err, reply);
    }
  });

  // POST /projects/:id/submit — draft|rejected → submitted.
  app.post("/projects/:id/submit", { preHandler: app.requireAuth }, async (req, reply) => {
    const accountId = req.accountId;
    if (!requireAccount(accountId, reply)) return;

    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return validationError(reply, "invalid project id");

    try {
      const project = await submitProject(app.db, accountId, id);
      return reply.code(200).send({ project });
    } catch (err) {
      return mapProjectError(err, reply);
    }
  });

  // POST /projects/:id/documents — attach one file (multipart) to the caller's
  // own draft|rejected project. Photos are public; legal docs (rccm/foncier/
  // releves) are private.
  app.post("/projects/:id/documents", { preHandler: app.requireAuth }, async (req, reply) => {
    const accountId = req.accountId;
    if (!requireAccount(accountId, reply)) return;

    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return validationError(reply, "invalid project id");

    // Consume EVERY multipart part before doing anything else. An early return
    // inside this loop would leave a later part's stream paused, and
    // @fastify/multipart's _consuming flag stops Node from auto-draining it —
    // the request would then stall until requestTimeout. So: buffer the first
    // file, drain any extra file parts, read the `kind` field, and only run the
    // owner/state/validation checks AFTER the loop (this ordering still satisfies
    // "verify owner + state first" — that governs error precedence, not I/O).
    let kind: string | undefined;
    let fileBuffer: Buffer | null = null;
    for await (const part of req.parts()) {
      if (part.type === "file") {
        if (fileBuffer !== null) {
          part.file.resume();
          continue;
        }
        fileBuffer = await part.toBuffer();
      } else if (part.fieldname === "kind") {
        kind = String(part.value);
      }
    }

    // The service runs the checks in the mandated order: owner + state (403 /
    // 409 / 404) first, then the `kind` enum and the file's magic bytes + size
    // (all DocValidationError → 400). So the possibly-invalid kind and a missing
    // file are handed straight to it rather than pre-checked here.
    try {
      const stored = await addProjectDocument(app.db, app.storage, {
        accountId,
        projectId: id,
        kind,
        buffer: fileBuffer,
        maxBytes: app.config.kycMaxFileMb * 1024 * 1024,
      });
      return reply.code(201).send(stored);
    } catch (err) {
      if (err instanceof DocValidationError) return validationError(reply, err.message);
      return mapProjectError(err, reply);
    }
  });

  // GET /projects/mine — the caller's own projects, newest first.
  app.get("/projects/mine", { preHandler: app.requireAuth }, async (req, reply) => {
    const accountId = req.accountId;
    if (!requireAccount(accountId, reply)) return;

    const mine = await listMine(app.db, accountId);
    return reply.send({ projects: mine });
  });

  // GET /projects/showcase — PUBLIC (no auth). The Showcase list: ONLY projects
  // in status=showcase, with the public projection (never owner PII). Mutually
  // exclusive with /funding.
  app.get("/projects/showcase", async (req, reply) => {
    const parsed = parsePublicFilters((req.query ?? {}) as Record<string, unknown>);
    if (!parsed.ok) return validationError(reply, parsed.message);
    const list = await listPublicProjects(app.db, "showcase", parsed.value);
    return reply.send({ projects: list });
  });

  // GET /projects/funding — PUBLIC (no auth). The Funding catalog: ONLY projects
  // in status=collecting. NEVER ordered by upvoteCount (regulatory guardrail);
  // the service sorts by publishedAt/createdAt. Mutually exclusive with /showcase.
  app.get("/projects/funding", async (req, reply) => {
    const parsed = parsePublicFilters((req.query ?? {}) as Record<string, unknown>);
    if (!parsed.ok) return validationError(reply, parsed.message);
    const list = await listPublicProjects(app.db, "collecting", parsed.value);
    return reply.send({ projects: list });
  });

  // GET /projects/:id — PUBLIC (no auth). Detail of a publicly-visible project.
  // 404 unless the project exists AND its status is public. Returns the public
  // projection plus ONLY public (photo) documents, each with a short-lived signed
  // URL — never the raw storage key, never a private legal doc. A malformed id
  // is a 404 (a public route doesn't distinguish malformed from unknown).
  app.get("/projects/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const notFound = () => reply.code(404).send({ error: { code: "not_found", message: "Project not found" } });
    if (!UUID_RE.test(id)) return notFound();

    const result = await getPublicProject(app.db, id);
    if (!result) return notFound();

    const documents = await Promise.all(
      result.documents.map(async (d) => ({
        id: d.id,
        kind: d.kind,
        mime: d.mime,
        sizeBytes: d.sizeBytes,
        createdAt: d.createdAt,
        url: await app.storage.getSignedUrl(d.storageKey, app.config.kycUrlTtlSeconds),
      })),
    );
    return reply.send({ project: result.project, documents });
  });

  // POST /projects/:id/follow — "notify me when it opens". Authenticated,
  // idempotent, unique per (account, project); increments followCount atomically
  // only on a genuinely new follow. Allowed while the project is publicly visible.
  app.post("/projects/:id/follow", { preHandler: app.requireAuth }, async (req, reply) => {
    const accountId = req.accountId;
    if (!requireAccount(accountId, reply)) return;

    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return validationError(reply, "invalid project id");

    try {
      await followProject(app.db, accountId, id);
      return reply.code(200).send({ following: true });
    } catch (err) {
      return mapProjectError(err, reply);
    }
  });

  // DELETE /projects/:id/follow — unfollow. Idempotent; decrements followCount
  // atomically only when a follow was actually removed. No status guard.
  app.delete("/projects/:id/follow", { preHandler: app.requireAuth }, async (req, reply) => {
    const accountId = req.accountId;
    if (!requireAccount(accountId, reply)) return;

    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return validationError(reply, "invalid project id");

    try {
      await unfollowProject(app.db, accountId, id);
      return reply.code(200).send({ following: false });
    } catch (err) {
      return mapProjectError(err, reply);
    }
  });

  // POST /projects/:id/upvote — authenticated, idempotent, unique per account.
  // Increments upvoteCount atomically only on a new upvote. 409 invalid_state
  // unless status=showcase.
  app.post("/projects/:id/upvote", { preHandler: app.requireAuth }, async (req, reply) => {
    const accountId = req.accountId;
    if (!requireAccount(accountId, reply)) return;

    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return validationError(reply, "invalid project id");

    try {
      await upvoteProject(app.db, accountId, id);
      return reply.code(200).send({ upvoted: true });
    } catch (err) {
      return mapProjectError(err, reply);
    }
  });

  // DELETE /projects/:id/upvote — remove an upvote. Idempotent; decrements
  // atomically only when a row was actually removed. No status guard.
  app.delete("/projects/:id/upvote", { preHandler: app.requireAuth }, async (req, reply) => {
    const accountId = req.accountId;
    if (!requireAccount(accountId, reply)) return;

    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return validationError(reply, "invalid project id");

    try {
      await removeUpvote(app.db, accountId, id);
      return reply.code(200).send({ upvoted: false });
    } catch (err) {
      return mapProjectError(err, reply);
    }
  });

  // GET /projects/:id/me — the caller's own engagement state for a project.
  app.get("/projects/:id/me", { preHandler: app.requireAuth }, async (req, reply) => {
    const accountId = req.accountId;
    if (!requireAccount(accountId, reply)) return;

    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return validationError(reply, "invalid project id");

    const state = await getEngagement(app.db, accountId, id);
    return reply.send(state);
  });
}
