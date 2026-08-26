import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { projects } from "../../db/schema";
import { runRepaymentSweep, notifyProjectDefaulted } from "./service";

// Canonical UUID shape. A non-UUID :id would otherwise reach pg and throw 22P02
// (-> 500), so reject it as a 404 (unknown project) first, mirroring escrow/routes.ts.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Admin collections endpoints: run the repayment sweep, and default / undefault a
// project by hand. All require [requireAuth, requireAdmin] (requireAdmin runs after
// requireAuth, which populates req.accountId), matching escrow/routes.ts admin-cancel.
export default async function collectionsRoutes(app: FastifyInstance) {
  // POST /admin/repayment/sweep: run the daily-cron mock now, return its summary.
  app.post("/admin/repayment/sweep", { preHandler: [app.requireAuth, app.requireAdmin] }, async (_req, reply) => {
    const summary = await runRepaymentSweep(app.db, app.notifier, app.penalty, {
      graceDays: app.config.defaultGraceDays,
      notifyChannels: app.config.notifyChannels,
    });
    return reply.code(200).send(summary);
  });

  // POST /admin/projects/:id/default: force a repaying project to defaulted. The
  // marker admin_defaulted=true makes it STICKY, so the sweep's auto-recovery cannot
  // silently lift it (only undefault clears the marker). Guarded transition -> 409
  // when the project is not repaying; investors notified best-effort after commit.
  app.post("/admin/projects/:id/default", { preHandler: [app.requireAuth, app.requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) {
      return reply.code(404).send({ error: { code: "not_found", message: "Project not found" } });
    }

    const [project] = await app.db.select({ id: projects.id }).from(projects).where(eq(projects.id, id));
    if (!project) {
      return reply.code(404).send({ error: { code: "not_found", message: "Project not found" } });
    }

    const now = new Date();
    const changed = await app.db
      .update(projects)
      .set({ status: "defaulted", defaultedAt: now, adminDefaulted: true, updatedAt: now })
      .where(and(eq(projects.id, id), eq(projects.status, "repaying")))
      .returning({ id: projects.id });
    if (changed.length === 0) {
      return reply.code(409).send({ error: { code: "invalid_state", message: "project is not repaying" } });
    }

    await notifyProjectDefaulted(app.db, app.notifier, id, app.config.notifyChannels);
    return reply.code(200).send({ ok: true });
  });

  // POST /admin/projects/:id/undefault: return a defaulted project to repaying and
  // clear the sticky marker. Guarded transition -> 409 when it is not defaulted.
  app.post("/admin/projects/:id/undefault", { preHandler: [app.requireAuth, app.requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) {
      return reply.code(404).send({ error: { code: "not_found", message: "Project not found" } });
    }

    const [project] = await app.db.select({ id: projects.id }).from(projects).where(eq(projects.id, id));
    if (!project) {
      return reply.code(404).send({ error: { code: "not_found", message: "Project not found" } });
    }

    const now = new Date();
    const changed = await app.db
      .update(projects)
      .set({ status: "repaying", defaultedAt: null, adminDefaulted: false, updatedAt: now })
      .where(and(eq(projects.id, id), eq(projects.status, "defaulted")))
      .returning({ id: projects.id });
    if (changed.length === 0) {
      return reply.code(409).send({ error: { code: "invalid_state", message: "project is not defaulted" } });
    }

    return reply.code(200).send({ ok: true });
  });
}
