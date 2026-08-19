import { randomInt, createHash, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { otpCodes } from "../../db/schema";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const MAX_ATTEMPTS = 5;

export async function issueOtp(
  db: Db,
  p: {
    accountId: string;
    channel: "email" | "sms";
    purpose: "login" | "password_reset" | "verify_contact";
    ttlMinutes: number;
  },
): Promise<{ code: string }> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.insert(otpCodes).values({
    accountId: p.accountId,
    channel: p.channel,
    purpose: p.purpose,
    codeHash: sha(code),
    expiresAt: new Date(Date.now() + p.ttlMinutes * 60_000),
  });
  return { code };
}

export async function verifyOtp(
  db: Db,
  p: {
    accountId: string;
    purpose: "login" | "password_reset" | "verify_contact";
    code: string;
  },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(otpCodes)
      .where(
        and(
          eq(otpCodes.accountId, p.accountId),
          eq(otpCodes.purpose, p.purpose),
          isNull(otpCodes.consumedAt),
          gt(otpCodes.expiresAt, new Date()),
        ),
      )
      // Secondary sort on id makes selection deterministic when several codes
      // share a transaction-start now() createdAt (id is random, so this is a
      // stable-but-arbitrary tiebreak, not a newest-first guarantee).
      .orderBy(desc(otpCodes.createdAt), desc(otpCodes.id))
      .limit(1)
      .for("update");
    if (!row || row.attempts >= MAX_ATTEMPTS) return false;
    const expected = Buffer.from(row.codeHash);
    const actual = Buffer.from(sha(p.code));
    const matches = expected.length === actual.length && timingSafeEqual(expected, actual);
    if (!matches) {
      await tx
        .update(otpCodes)
        .set({ attempts: sql`${otpCodes.attempts} + 1` })
        .where(eq(otpCodes.id, row.id));
      return false;
    }
    await tx.update(otpCodes).set({ consumedAt: new Date() }).where(eq(otpCodes.id, row.id));
    return true;
  });
}
