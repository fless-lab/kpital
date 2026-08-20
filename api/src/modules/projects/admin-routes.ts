import type { FastifyInstance, FastifyReply } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { accounts, notificationPrefs, projectDocuments, projectFollows, projectScore, projectStatus, projects } from "../../db/schema";
import { InvalidStateError } from "./service";
import { resolveEffectiveChannels } from "../../lib/notifier";

const STATUSES = projectStatus.enumValues as readonly string[];
const SCORES = projectScore.enumValues as readonly string[];
type Score = (typeof projectScore.enumValues)[number];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Canonical UUID shape. A non-UUID :id would otherwise reach pg as an invalid
// uuid literal (22P02) and surface as a 500 — reject it up front instead.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validationError(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: { code: "validation_error", message } });
}
function notFound(reply: FastifyReply) {
  return reply.code(404).send({ error: { code: "not_found", message: "Project not found" } });
}
function invalidState(reply: FastifyReply) {
  return reply
    .code(409)
    .send({ error: { code: "invalid_state", message: "Project cannot be transitioned in its current state" } });
}

export default async function projectAdminRoutes(app: FastifyInstance) {
  const guard = { preHandler: [app.requireAuth, app.requireAdmin] };

  // GET /admin/projects?status=in_review — moderation queue, metadata only (no
  // documents). Default in_review; an off-enum status is a 400 (never reaches the
  // enum column → no 22P02). The `project` row carries no password_hash (that
  // lives on a different table), so a full row select stays PII-safe here.
  app.get("/admin/projects", guard, async (req, reply) => {
    const query = (req.query ?? {}) as { status?: unknown; limit?: unknown };
    const status = query.status === undefined ? "in_review" : String(query.status);
    if (!STATUSES.includes(status)) {
      return validationError(reply, `status must be one of ${STATUSES.join(", ")}`);
    }
    const rawLimit = typeof query.limit === "string" ? Number.parseInt(query.limit, 10) : NaN;
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 && rawLimit <= MAX_LIMIT ? rawLimit : DEFAULT_LIMIT;

    const rows = await app.db
      .select()
      .from(projects)
      .where(eq(projects.status, status as (typeof projectStatus.enumValues)[number]))
      .orderBy(desc(projects.createdAt), desc(projects.id))
      .limit(limit);

    return reply.send({ projects: rows });
  });

  // GET /admin/projects/:id — detail + documents[] with short-TTL signed URLs for
  // EVERY document (private legal docs included — the admin reviews them). Emits
  // an audit line. 404 for a malformed or absent id. storageKey is never returned.
  app.get("/admin/projects/:id", guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return notFound(reply);

    const [project] = await app.db.select().from(projects).where(eq(projects.id, id));
    if (!project) return notFound(reply);

    // AUDIT: who viewed which project's (incl. private) documents.
    req.log.info({ adminId: req.accountId, projectId: id, action: "project_view" });

    const docs = await app.db
      .select()
      .from(projectDocuments)
      .where(eq(projectDocuments.projectId, id))
      .orderBy(desc(projectDocuments.createdAt), desc(projectDocuments.id));

    const documents = await Promise.all(
      docs.map(async (d) => ({
        id: d.id,
        kind: d.kind,
        visibility: d.visibility,
        mime: d.mime,
        sizeBytes: d.sizeBytes,
        createdAt: d.createdAt,
        url: await app.storage.getSignedUrl(d.storageKey, app.config.kycUrlTtlSeconds),
      })),
    );

    return reply.send({ project, documents });
  });

  // POST /admin/projects/:id/decision — { decision:"approve", score } |
  // { decision:"reject", reason }. Body validated BEFORE touching the DB (so
  // reject-without-reason is 400 even for an absent id). One transaction, guarded
  // on the current status ∈ {submitted, in_review}: no matching row → 409 (covers
  // both a wrong state and a nonexistent id), rolled back.
  app.post("/admin/projects/:id/decision", guard, async (req, reply) => {
    const adminId = req.accountId;
    if (!adminId) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "Login required" } });
    }
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { decision?: unknown; score?: unknown; reason?: unknown };

    const decision = b.decision;
    if (decision !== "approve" && decision !== "reject") {
      return validationError(reply, "decision must be one of approve, reject");
    }

    let score: Score | null = null;
    let reason: string | null = null;
    if (decision === "approve") {
      if (typeof b.score !== "string" || !SCORES.includes(b.score)) {
        return validationError(reply, `score must be one of ${SCORES.join(", ")}`);
      }
      score = b.score as Score;
    } else {
      const r = typeof b.reason === "string" ? b.reason.trim() : "";
      if (r === "") return validationError(reply, "reason is required when rejecting");
      reason = r;
    }

    if (!UUID_RE.test(id)) return notFound(reply);

    const now = new Date();
    try {
      await app.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(projects)
          .set(
            decision === "approve"
              ? {
                  status: "showcase",
                  score,
                  publishedAt: now,
                  reviewedBy: adminId,
                  reviewedAt: now,
                  updatedAt: now,
                }
              : {
                  status: "rejected",
                  rejectReason: reason,
                  reviewedBy: adminId,
                  reviewedAt: now,
                  updatedAt: now,
                },
          )
          .where(and(eq(projects.id, id), inArray(projects.status, ["submitted", "in_review"])))
          .returning({ id: projects.id });
        if (!updated) throw new InvalidStateError();
      });
    } catch (err) {
      if (err instanceof InvalidStateError) return invalidState(reply);
      throw err;
    }

    return reply.code(200).send({ id, status: decision === "approve" ? "showcase" : "rejected" });
  });

  // POST /admin/projects/:id/open-collection — showcase → collecting. Guarded in
  // one transaction; no matching row → 409. AFTER commit, notify every follower
  // that the collection is open. A notifier failure must NOT undo the committed
  // transition, so the notify loop is best-effort (caught + logged).
  app.post("/admin/projects/:id/open-collection", guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return notFound(reply);

    const now = new Date();
    let title: string;
    try {
      title = await app.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(projects)
          .set({ status: "collecting", collectingOpenedAt: now, updatedAt: now })
          .where(and(eq(projects.id, id), eq(projects.status, "showcase")))
          .returning({ title: projects.title });
        if (!updated) throw new InvalidStateError();
        return updated.title;
      });
    } catch (err) {
      if (err instanceof InvalidStateError) return invalidState(reply);
      throw err;
    }

    // Fetch followers' contact details and notify each that collection is open.
    // Runs after commit and never fails the request (the transition is durable).
    try {
      // LEFT JOIN the pref so a follower with no pref row still surfaces (channels
      // = null → default to ["email"]). An explicit empty array means the follower
      // opted out of everything and gets nothing.
      const followers = await app.db
        .select({ email: accounts.email, phone: accounts.phone, channels: notificationPrefs.channels })
        .from(projectFollows)
        .innerJoin(accounts, eq(projectFollows.accountId, accounts.id))
        .leftJoin(notificationPrefs, eq(notificationPrefs.accountId, accounts.id))
        .where(eq(projectFollows.projectId, id));

      const message = {
        subject: `Collecte ouverte : ${title}`,
        body: `Le projet "${title}" que vous suivez est maintenant ouvert au financement sur KPITAL.`,
      };
      await Promise.all(
        followers.map((f) => {
          const followerChannels = f.channels ?? ["email"];
          const effective = resolveEffectiveChannels(followerChannels, app.config.notifyChannels);
          const to = {
            ...(effective.includes("email") && f.email ? { email: f.email } : {}),
            ...(effective.includes("sms") && f.phone ? { phone: f.phone } : {}),
          };
          if (!to.email && !to.phone) return Promise.resolve();
          return app.notifier.send(to, message);
        }),
      );
    } catch (err) {
      req.log.error({ err, projectId: id, action: "open_collection_notify" }, "follower notification failed");
    }

    return reply.code(200).send({ id, status: "collecting" });
  });
}
