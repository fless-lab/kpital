import type { FastifyInstance } from "fastify";
import { eq, ilike, or } from "drizzle-orm";
import { accounts } from "../../db/schema";
import { listEntries, WalletNotFoundError } from "../wallet/service";

const KYC_STATUSES = ["pending", "verified", "rejected"] as const;
const ACCT_STATUSES = ["active", "suspended", "closed"] as const;
type KycStatus = (typeof KYC_STATUSES)[number];
type AcctStatus = (typeof ACCT_STATUSES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Public-ish projection: password_hash is never selected, so it is
// structurally impossible for it to leak through these routes.
const publicColumns = {
  id: accounts.id,
  email: accounts.email,
  phone: accounts.phone,
  firstName: accounts.firstName,
  lastName: accounts.lastName,
  country: accounts.country,
  roles: accounts.roles,
  kycStatus: accounts.kycStatus,
  status: accounts.status,
  isAdmin: accounts.isAdmin,
  createdAt: accounts.createdAt,
  updatedAt: accounts.updatedAt,
};

type PatchBody = {
  kyc_status?: unknown;
  status?: unknown;
};

export default async function adminRoutes(app: FastifyInstance) {
  const guard = { preHandler: [app.requireAuth, app.requireAdmin] };

  // GET /admin/accounts — list/search (simple limit; optional ?q= over email/name).
  app.get("/admin/accounts", guard, async (req, reply) => {
    const query = (req.query ?? {}) as { q?: unknown; limit?: unknown };
    const q = typeof query.q === "string" ? query.q.trim() : "";
    const rawLimit = typeof query.limit === "string" ? Number.parseInt(query.limit, 10) : NaN;
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 && rawLimit <= 200 ? rawLimit : 50;

    let builder = app.db.select(publicColumns).from(accounts).$dynamic();
    if (q) {
      const pattern = `%${q}%`;
      builder = builder.where(
        or(ilike(accounts.email, pattern), ilike(accounts.firstName, pattern), ilike(accounts.lastName, pattern)),
      );
    }
    const rows = await builder.limit(limit);
    return reply.send({ accounts: rows });
  });

  // GET /admin/accounts/:id — one account detail (no password_hash).
  app.get("/admin/accounts/:id", guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) {
      return reply.code(404).send({ error: { code: "not_found", message: "Account not found" } });
    }
    const [account] = await app.db.select(publicColumns).from(accounts).where(eq(accounts.id, id));
    if (!account) {
      return reply.code(404).send({ error: { code: "not_found", message: "Account not found" } });
    }
    return reply.send({ account });
  });

  // PATCH /admin/accounts/:id — set kyc_status and/or status (validated enums).
  app.patch("/admin/accounts/:id", guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) {
      return reply.code(404).send({ error: { code: "not_found", message: "Account not found" } });
    }
    const body = (req.body ?? {}) as PatchBody;
    const patch: { kycStatus?: KycStatus; status?: AcctStatus; updatedAt: Date } = { updatedAt: new Date() };

    if (body.kyc_status !== undefined) {
      if (!KYC_STATUSES.includes(body.kyc_status as KycStatus)) {
        return reply
          .code(400)
          .send({ error: { code: "validation_error", message: `kyc_status must be one of ${KYC_STATUSES.join(", ")}` } });
      }
      patch.kycStatus = body.kyc_status as KycStatus;
    }
    if (body.status !== undefined) {
      if (!ACCT_STATUSES.includes(body.status as AcctStatus)) {
        return reply
          .code(400)
          .send({ error: { code: "validation_error", message: `status must be one of ${ACCT_STATUSES.join(", ")}` } });
      }
      patch.status = body.status as AcctStatus;
    }
    if (patch.kycStatus === undefined && patch.status === undefined) {
      return reply
        .code(400)
        .send({ error: { code: "validation_error", message: "Provide kyc_status and/or status" } });
    }

    const [account] = await app.db.update(accounts).set(patch).where(eq(accounts.id, id)).returning(publicColumns);
    if (!account) {
      return reply.code(404).send({ error: { code: "not_found", message: "Account not found" } });
    }
    return reply.send({ account });
  });

  // GET /admin/accounts/:id/wallet — the account's wallet entries (read-only).
  app.get("/admin/accounts/:id/wallet", guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) {
      return reply.code(404).send({ error: { code: "not_found", message: "Account not found" } });
    }
    const [account] = await app.db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, id));
    if (!account) {
      return reply.code(404).send({ error: { code: "not_found", message: "Account not found" } });
    }
    try {
      const entries = await listEntries(app.db, id);
      return reply.send({ entries });
    } catch (err) {
      if (err instanceof WalletNotFoundError) {
        return reply.send({ entries: [] });
      }
      throw err;
    }
  });
}
