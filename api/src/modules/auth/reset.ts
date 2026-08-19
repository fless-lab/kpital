import { randomBytes, createHash } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import { passwordResets } from "../../db/schema";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

const RESET_TTL_MINUTES = 30;

// Issues a random reset token for the email link path. Only the sha256 of the
// token is stored; the raw token travels in the emailed link and is never
// persisted. 30-min TTL, single-use (enforced by consumeResetToken).
export async function issueResetToken(db: Db, accountId: string): Promise<{ token: string }> {
  const token = randomBytes(32).toString("base64url");
  await db.insert(passwordResets).values({
    accountId,
    tokenHash: sha(token),
    expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000),
  });
  return { token };
}

// Consumes a reset token: if an unexpired, unconsumed row matches the hash it is
// atomically marked consumed and its accountId returned; otherwise null. The
// conditional UPDATE ... RETURNING guarantees single-use without a transaction.
export async function consumeResetToken(db: Db, token: string): Promise<string | null> {
  const rows = await db
    .update(passwordResets)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(passwordResets.tokenHash, sha(token)),
        isNull(passwordResets.consumedAt),
        gt(passwordResets.expiresAt, new Date()),
      ),
    )
    .returning({ accountId: passwordResets.accountId });
  return rows[0]?.accountId ?? null;
}
