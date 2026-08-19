import type { FastifyInstance, FastifyReply } from "fastify";
import { eq, sql } from "drizzle-orm";
import { accounts, notificationPrefs, payoutMethods } from "../../db/schema";

const VALID_ROLES = new Set(["investor", "porteur"]);
const VALID_PAYOUT_TYPES = new Set(["tmoney", "flooz", "bank"]);

// A phone collision on PATCH /me surfaces as a Postgres unique-violation (23505),
// bare or wrapped by drizzle; check both the error and its cause.
function isUniqueViolation(err: unknown): boolean {
  const code = (e: unknown): string | undefined =>
    typeof e === "object" && e !== null && "code" in e
      ? ((e as { code?: unknown }).code as string | undefined)
      : undefined;
  if (code(err) === "23505") return true;
  const cause = typeof err === "object" && err !== null && "cause" in err ? (err as { cause?: unknown }).cause : undefined;
  return code(cause) === "23505";
}

const accountPublic = {
  id: accounts.id,
  email: accounts.email,
  firstName: accounts.firstName,
  lastName: accounts.lastName,
  country: accounts.country,
  phone: accounts.phone,
  roles: accounts.roles,
  kycStatus: accounts.kycStatus,
};

export default async function accountsRoutes(app: FastifyInstance) {
  // Every route here is behind requireAuth, so accountId is always present; the
  // null guard keeps TypeScript honest and returns the uniform 401 envelope.
  const requireAccount = (accountId: string | null, reply: FastifyReply): accountId is string => {
    if (!accountId) {
      reply.code(401).send({ error: { code: "unauthorized", message: "Login required" } });
      return false;
    }
    return true;
  };

  const validationError = (reply: FastifyReply, message: string) =>
    reply.code(400).send({ error: { code: "validation_error", message } });

  app.get("/me", { preHandler: app.requireAuth }, async (req, reply) => {
    const accountId = req.accountId;
    if (!requireAccount(accountId, reply)) return;

    const [account] = await app.db.select(accountPublic).from(accounts).where(eq(accounts.id, accountId));
    if (!account) {
      return reply.code(404).send({ error: { code: "not_found", message: "Account not found" } });
    }
    return reply.send(account);
  });

  // PATCH /me — updates only whitelisted profile fields. email/roles/kycStatus
  // are never accepted from the body.
  app.patch("/me", { preHandler: app.requireAuth }, async (req, reply) => {
    const accountId = req.accountId;
    if (!requireAccount(accountId, reply)) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const updates: { firstName?: string; lastName?: string; country?: string; phone?: string } = {};

    for (const field of ["firstName", "lastName", "country", "phone"] as const) {
      if (field in body) {
        const value = body[field];
        if (typeof value !== "string" || value.trim() === "") {
          return validationError(reply, `${field} must be a non-empty string`);
        }
        updates[field] = value.trim();
      }
    }

    if (Object.keys(updates).length === 0) {
      return validationError(reply, "No updatable fields provided");
    }

    try {
      const [account] = await app.db
        .update(accounts)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(accounts.id, accountId))
        .returning(accountPublic);
      if (!account) {
        return reply.code(404).send({ error: { code: "not_found", message: "Account not found" } });
      }
      return reply.send(account);
    } catch (err) {
      if (isUniqueViolation(err)) {
        return reply.code(409).send({ error: { code: "phone_taken", message: "Phone already in use" } });
      }
      throw err;
    }
  });

  // POST /me/roles — cumulative + idempotent in a single atomic UPDATE. The
  // CASE appends the role only when absent, so concurrent adds cannot lose a
  // write (no read-modify-write race) and re-adding an existing role is a no-op
  // that preserves the current order. Returns the updated roles.
  app.post("/me/roles", { preHandler: app.requireAuth }, async (req, reply) => {
    const accountId = req.accountId;
    if (!requireAccount(accountId, reply)) return;

    const body = (req.body ?? {}) as { role?: unknown };
    const role = body.role;
    if (typeof role !== "string" || !VALID_ROLES.has(role)) {
      return validationError(reply, "role must be 'investor' or 'porteur'");
    }

    const [updated] = await app.db
      .update(accounts)
      .set({
        roles: sql`case when ${role} = any(${accounts.roles}) then ${accounts.roles} else ${accounts.roles} || array[${role}]::text[] end`,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId))
      .returning({ roles: accounts.roles });

    if (!updated) {
      return reply.code(404).send({ error: { code: "not_found", message: "Account not found" } });
    }
    return reply.send({ roles: updated.roles });
  });

  // GET /me/notification-pref — returns the stored row or sensible defaults.
  app.get("/me/notification-pref", { preHandler: app.requireAuth }, async (req, reply) => {
    const accountId = req.accountId;
    if (!requireAccount(accountId, reply)) return;

    const [pref] = await app.db
      .select({ channels: notificationPrefs.channels, categories: notificationPrefs.categories })
      .from(notificationPrefs)
      .where(eq(notificationPrefs.accountId, accountId));

    return reply.send(pref ?? { channels: ["email"], categories: {} });
  });

  // PATCH /me/notification-pref — upsert keyed by accountId; writes channels
  // and/or categories.
  app.patch("/me/notification-pref", { preHandler: app.requireAuth }, async (req, reply) => {
    const accountId = req.accountId;
    if (!requireAccount(accountId, reply)) return;

    const body = (req.body ?? {}) as { channels?: unknown; categories?: unknown };
    const updates: { channels?: string[]; categories?: Record<string, unknown> } = {};

    if ("channels" in body) {
      const channels = body.channels;
      if (!Array.isArray(channels) || !channels.every((c) => typeof c === "string")) {
        return validationError(reply, "channels must be an array of strings");
      }
      updates.channels = channels as string[];
    }
    if ("categories" in body) {
      const categories = body.categories;
      if (typeof categories !== "object" || categories === null || Array.isArray(categories)) {
        return validationError(reply, "categories must be an object");
      }
      updates.categories = categories as Record<string, unknown>;
    }

    if (Object.keys(updates).length === 0) {
      return validationError(reply, "No updatable fields provided");
    }

    const [pref] = await app.db
      .insert(notificationPrefs)
      .values({ accountId, ...updates })
      .onConflictDoUpdate({ target: notificationPrefs.accountId, set: updates })
      .returning({ channels: notificationPrefs.channels, categories: notificationPrefs.categories });

    return reply.send(pref);
  });

  // GET /wallet/payout-methods — lists the caller's payout methods.
  app.get("/wallet/payout-methods", { preHandler: app.requireAuth }, async (req, reply) => {
    const accountId = req.accountId;
    if (!requireAccount(accountId, reply)) return;

    const methods = await app.db
      .select({
        id: payoutMethods.id,
        type: payoutMethods.type,
        details: payoutMethods.details,
        verified: payoutMethods.verified,
        createdAt: payoutMethods.createdAt,
      })
      .from(payoutMethods)
      .where(eq(payoutMethods.accountId, accountId));

    return reply.send(methods);
  });

  // POST /wallet/payout-methods — adds one. verified is server-controlled and
  // always starts false; it is never read from the body.
  app.post("/wallet/payout-methods", { preHandler: app.requireAuth }, async (req, reply) => {
    const accountId = req.accountId;
    if (!requireAccount(accountId, reply)) return;

    const body = (req.body ?? {}) as { type?: unknown; details?: unknown };
    const type = body.type;
    if (typeof type !== "string" || !VALID_PAYOUT_TYPES.has(type)) {
      return validationError(reply, "type must be 'tmoney', 'flooz' or 'bank'");
    }
    const details = body.details;
    if (typeof details !== "object" || details === null || Array.isArray(details)) {
      return validationError(reply, "details must be an object");
    }

    const [method] = await app.db
      .insert(payoutMethods)
      .values({ accountId, type: type as "tmoney" | "flooz" | "bank", details })
      .returning({
        id: payoutMethods.id,
        type: payoutMethods.type,
        details: payoutMethods.details,
        verified: payoutMethods.verified,
        createdAt: payoutMethods.createdAt,
      });

    return reply.code(201).send(method);
  });
}
