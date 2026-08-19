import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  SESSION_COOKIE_NAME: z.string().default("kpital_sess"),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  OTP_TTL_MINUTES: z.coerce.number().int().positive().default(10),
  NOTIFY_CHANNELS: z.string().default("email"),
  CORS_ORIGIN: z.string().min(1),
});

export type Config = {
  databaseUrl: string;
  sessionCookieName: string;
  sessionTtlDays: number;
  otpTtlMinutes: number;
  notifyChannels: ("email" | "sms")[];
  corsOrigin: string;
};

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const e = schema.parse(source);
  const channels = e.NOTIFY_CHANNELS.split(",").map((s) => s.trim()).filter(Boolean);
  for (const c of channels) if (c !== "email" && c !== "sms") throw new Error(`bad channel: ${c}`);
  return {
    databaseUrl: e.DATABASE_URL,
    sessionCookieName: e.SESSION_COOKIE_NAME,
    sessionTtlDays: e.SESSION_TTL_DAYS,
    otpTtlMinutes: e.OTP_TTL_MINUTES,
    notifyChannels: channels as ("email" | "sms")[],
    corsOrigin: e.CORS_ORIGIN,
  };
}
