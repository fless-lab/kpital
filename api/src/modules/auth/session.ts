import { randomBytes, createHash } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import { accounts, sessions } from "../../db/schema";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

export type SessionMeta = {
  ttlDays: number;
  userAgent?: string | undefined;
  ip?: string | undefined;
};

export async function createSession(db: Db, accountId: string, meta: SessionMeta): Promise<{ token: string }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + meta.ttlDays * 864e5);
  await db.insert(sessions).values({
    accountId,
    tokenHash: sha(token),
    expiresAt,
    userAgent: meta.userAgent,
    ip: meta.ip,
  });
  return { token };
}

export async function resolveSession(db: Db, token: string): Promise<{ accountId: string } | null> {
  // Join the account so a session belonging to a suspended/closed account is
  // rejected even if it was established while the account was still active.
  const [row] = await db
    .select({ accountId: sessions.accountId, status: accounts.status })
    .from(sessions)
    .innerJoin(accounts, eq(accounts.id, sessions.accountId))
    .where(and(eq(sessions.tokenHash, sha(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())));
  return row && row.status === "active" ? { accountId: row.accountId } : null;
}

export const revokeSession = (db: Db, token: string) =>
  db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.tokenHash, sha(token)));

export const revokeAllSessions = (db: Db, accountId: string) =>
  db.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.accountId, accountId), isNull(sessions.revokedAt)));
