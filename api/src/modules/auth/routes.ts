import type { FastifyInstance } from "fastify";
import { eq, or } from "drizzle-orm";
import { accounts } from "../../db/schema";
import { hashPassword, isStrongPassword, verifyPassword } from "./password";
import { createSession, revokeSession, revokeAllSessions } from "./session";
import { registerAccount, WeakPasswordError } from "../accounts/register";
import { issueOtp, verifyOtp } from "./otp";
import { issueResetToken, consumeResetToken } from "./reset";

type LoginBody = { identifier?: string; password?: string };

type OtpRequestBody = { identifier?: unknown; channel?: unknown };
type OtpVerifyBody = { identifier?: unknown; code?: unknown };

type ForgotBody = { identifier?: unknown; channel?: unknown };
type ResetBody = { token?: unknown; identifier?: unknown; code?: unknown; password?: unknown };

type RegisterBody = {
  email?: unknown;
  phone?: unknown;
  password?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  country?: unknown;
  roles?: unknown;
};

const VALID_ROLES = new Set(["investor", "porteur"]);

// A duplicate email surfaces as a Postgres unique-violation (code 23505) thrown
// from inside registerAccount's transaction; the pg error may arrive bare or
// wrapped by drizzle, so check both the error and its cause.
function isUniqueViolation(err: unknown): boolean {
  const code = (e: unknown): string | undefined =>
    typeof e === "object" && e !== null && "code" in e
      ? (e as { code?: unknown }).code as string | undefined
      : undefined;
  if (code(err) === "23505") return true;
  const cause = typeof err === "object" && err !== null && "cause" in err ? (err as { cause?: unknown }).cause : undefined;
  return code(cause) === "23505";
}

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

  app.post("/auth/register", async (req, reply) => {
    const body = (req.body ?? {}) as RegisterBody;
    const str = (v: unknown): string => (typeof v === "string" ? v : "");

    const email = str(body.email).trim();
    const password = typeof body.password === "string" ? body.password : "";
    const firstName = str(body.firstName).trim();
    const lastName = str(body.lastName).trim();
    const country = str(body.country).trim();
    const phone = typeof body.phone === "string" ? body.phone.trim() : undefined;
    const roles = Array.isArray(body.roles) ? body.roles : [];

    const validationError = (message: string) =>
      reply.code(400).send({ error: { code: "validation_error", message } });

    if (!email || !firstName || !lastName || !country) {
      return validationError("email, firstName, lastName and country are required");
    }
    if (!roles.every((r) => typeof r === "string" && VALID_ROLES.has(r))) {
      return validationError("roles must contain only 'investor' or 'porteur'");
    }

    try {
      const { accountId } = await registerAccount(app.db, {
        email,
        ...(phone ? { phone } : {}),
        password,
        firstName,
        lastName,
        country,
        roles: roles as ("investor" | "porteur")[],
      });

      const { token } = await createSession(app.db, accountId, {
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

      return reply.code(201).send({ id: accountId });
    } catch (err) {
      if (err instanceof WeakPasswordError) {
        return validationError("Password does not meet strength requirements");
      }
      if (isUniqueViolation(err)) {
        return reply.code(409).send({ error: { code: "email_taken", message: "Email already registered" } });
      }
      throw err;
    }
  });

  app.post("/auth/logout", async (req, reply) => {
    const token = req.cookies?.[app.config.sessionCookieName];
    if (token) await revokeSession(app.db, token);
    reply.clearCookie(app.config.sessionCookieName, { path: "/" });
    return reply.code(200).send({ ok: true });
  });

  app.post("/auth/logout-all", { preHandler: app.requireAuth }, async (req, reply) => {
    const accountId = req.accountId;
    if (!accountId) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "Login required" } });
    }
    await revokeAllSessions(app.db, accountId);
    reply.clearCookie(app.config.sessionCookieName, { path: "/" });
    return reply.code(200).send({ ok: true });
  });

  const findByIdentifier = (identifier: string) =>
    app.db
      .select()
      .from(accounts)
      .where(or(eq(accounts.email, identifier), eq(accounts.phone, identifier)))
      .then((rows) => rows[0]);

  // POST /auth/otp/request — anti-enumeration: ALWAYS replies { sent: true }.
  // Only when the account exists do we issue a code and send it via the notifier.
  app.post("/auth/otp/request", async (req, reply) => {
    const body = (req.body ?? {}) as OtpRequestBody;
    const identifier = typeof body.identifier === "string" ? body.identifier : "";
    const channel = body.channel === "sms" ? "sms" : "email";

    if (identifier) {
      const account = await findByIdentifier(identifier);
      if (account) {
        const { code } = await issueOtp(app.db, {
          accountId: account.id,
          channel,
          purpose: "login",
          ttlMinutes: app.config.otpTtlMinutes,
        });
        await app.notifier.send(
          {
            ...(account.email ? { email: account.email } : {}),
            ...(account.phone ? { phone: account.phone } : {}),
          },
          { subject: "Your KPITAL login code", body: `Your login code is ${code}. It expires in ${app.config.otpTtlMinutes} minutes.` },
        );
      }
    }

    return reply.code(200).send({ sent: true });
  });

  // POST /auth/otp/verify — on success create a session cookie; else 401 otp_invalid.
  app.post("/auth/otp/verify", async (req, reply) => {
    const body = (req.body ?? {}) as OtpVerifyBody;
    const identifier = typeof body.identifier === "string" ? body.identifier : "";
    const code = typeof body.code === "string" ? body.code : "";

    const invalid = () =>
      reply.code(401).send({ error: { code: "otp_invalid", message: "Invalid or expired code" } });

    if (!identifier || !code) return invalid();

    const account = await findByIdentifier(identifier);
    if (!account) return invalid();

    const ok = await verifyOtp(app.db, { accountId: account.id, purpose: "login", code });
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

  // POST /auth/password/forgot — anti-enumeration: ALWAYS replies { sent: true }.
  // email channel -> reset link with a hashed, single-use, 30-min token.
  // phone channel -> OTP with purpose=password_reset.
  app.post("/auth/password/forgot", async (req, reply) => {
    const body = (req.body ?? {}) as ForgotBody;
    const identifier = typeof body.identifier === "string" ? body.identifier : "";
    const channel = body.channel === "phone" ? "phone" : "email";

    if (identifier) {
      const account = await findByIdentifier(identifier);
      if (account) {
        const to = {
          ...(account.email ? { email: account.email } : {}),
          ...(account.phone ? { phone: account.phone } : {}),
        };
        if (channel === "email") {
          const { token } = await issueResetToken(app.db, account.id);
          const link = `${app.config.corsOrigin}/nouveau-mot-de-passe?token=${token}`;
          await app.notifier.send(to, {
            subject: "Reset your KPITAL password",
            body: `Reset your password with this link: ${link} It expires in 30 minutes.`,
          });
        } else {
          const { code } = await issueOtp(app.db, {
            accountId: account.id,
            channel: "sms",
            purpose: "password_reset",
            ttlMinutes: app.config.otpTtlMinutes,
          });
          await app.notifier.send(to, {
            subject: "Your KPITAL password reset code",
            body: `Your password reset code is ${code}. It expires in ${app.config.otpTtlMinutes} minutes.`,
          });
        }
      }
    }

    return reply.code(200).send({ sent: true });
  });

  // POST /auth/password/reset — accepts { token, password } (email link path) or
  // { identifier, code, password } (phone OTP path). On a valid token/code the
  // password is rehashed, the account updated, and ALL sessions revoked.
  app.post("/auth/password/reset", async (req, reply) => {
    const body = (req.body ?? {}) as ResetBody;
    const token = typeof body.token === "string" ? body.token : "";
    const identifier = typeof body.identifier === "string" ? body.identifier : "";
    const code = typeof body.code === "string" ? body.code : "";
    const password = typeof body.password === "string" ? body.password : "";

    // Validate strength first so a weak attempt never burns a single-use token.
    if (!isStrongPassword(password)) {
      return reply
        .code(400)
        .send({ error: { code: "validation_error", message: "Password does not meet strength requirements" } });
    }

    const invalidToken = () =>
      reply.code(400).send({ error: { code: "invalid_token", message: "Invalid or expired reset token" } });

    let accountId: string | null = null;
    if (token) {
      accountId = await consumeResetToken(app.db, token);
    } else if (identifier && code) {
      const account = await findByIdentifier(identifier);
      if (account) {
        const ok = await verifyOtp(app.db, { accountId: account.id, purpose: "password_reset", code });
        if (ok) accountId = account.id;
      }
    }

    if (!accountId) return invalidToken();

    const passwordHash = await hashPassword(password);
    await app.db.update(accounts).set({ passwordHash, updatedAt: new Date() }).where(eq(accounts.id, accountId));
    await revokeAllSessions(app.db, accountId);

    return reply.code(200).send({ ok: true });
  });
}
