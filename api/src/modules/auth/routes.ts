import type { FastifyInstance } from "fastify";
import { eq, or } from "drizzle-orm";
import { accounts } from "../../db/schema";
import { verifyPassword } from "./password";
import { createSession } from "./session";

type LoginBody = { identifier?: string; password?: string };

// Pre-computed argon2id hash of a throwaway value. Used to equalize work on the
// no-account path so every login attempt runs exactly one argon2 verify, closing
// the timing side-channel that would otherwise leak account existence.
const DECOY_HASH =
  "$argon2id$v=19$m=65536,p=4,t=3$9jpoHiuL86aa/z6hG95rJQ$atl0eoG7Xjq4B/KUdJk3K4x8/ok//948RIpJLUjHgLY";

export default async function authRoutes(app: FastifyInstance) {
  app.post("/auth/login", async (req, reply) => {
    const body = (req.body ?? {}) as LoginBody;
    const identifier = typeof body.identifier === "string" ? body.identifier : "";
    const password = typeof body.password === "string" ? body.password : "";

    const invalid = () =>
      reply.code(401).send({ error: { code: "invalid_credentials", message: "Invalid credentials" } });

    if (!identifier || !password) return invalid();

    const [account] = await app.db
      .select()
      .from(accounts)
      .where(or(eq(accounts.email, identifier), eq(accounts.phone, identifier)));

    if (!account || !account.passwordHash) {
      // Run one decoy verify so the no-account path costs the same as a wrong
      // password, then fail identically. Result is intentionally discarded.
      await verifyPassword(password, DECOY_HASH);
      return invalid();
    }

    const ok = await verifyPassword(password, account.passwordHash);
    if (!ok) return invalid();

    const { token } = await createSession(app.db, account.id, {
      ttlDays: app.config.sessionTtlDays,
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    });

    reply.setCookie(app.config.sessionCookieName, token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: app.config.sessionTtlDays * 24 * 60 * 60,
    });

    return reply.code(200).send({ ok: true });
  });
}
