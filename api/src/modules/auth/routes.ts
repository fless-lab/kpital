import type { FastifyInstance } from "fastify";
import { eq, or } from "drizzle-orm";
import { accounts } from "../../db/schema";
import { verifyPassword } from "./password";
import { createSession } from "./session";

type LoginBody = { identifier?: string; password?: string };

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

    if (!account) return invalid();

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
