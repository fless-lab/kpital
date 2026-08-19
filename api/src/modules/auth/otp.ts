import { randomInt, createHash } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
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
  const [row] = await db
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
    .orderBy(desc(otpCodes.createdAt))
    .limit(1);
  if (!row || row.attempts >= MAX_ATTEMPTS) return false;
  if (row.codeHash !== sha(p.code)) {
    await db.update(otpCodes).set({ attempts: row.attempts + 1 }).where(eq(otpCodes.id, row.id));
    return false;
  }
  await db.update(otpCodes).set({ consumedAt: new Date() }).where(eq(otpCodes.id, row.id));
  return true;
}
