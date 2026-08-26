import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  SESSION_COOKIE_NAME: z.string().default("kpital_sess"),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  OTP_TTL_MINUTES: z.coerce.number().int().positive().default(10),
  NOTIFY_CHANNELS: z.string().default("email"),
  CORS_ORIGIN: z.string().min(1),
  TRUST_PROXY: z.string().optional(),
  MINIO_ENDPOINT: z.string().min(1),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
  MINIO_BUCKET: z.string().min(1),
  MINIO_REGION: z.string().default("us-east-1"),
  KYC_URL_TTL_SECONDS: z.coerce.number().int().positive().default(120),
  KYC_MAX_FILE_MB: z.coerce.number().int().positive().default(10),
  ESCROW_WEBHOOK_SECRET: z.string().default(""),
  DEFAULT_GRACE_DAYS: z.coerce.number().int().positive().default(30),
});

export type Config = {
  databaseUrl: string;
  sessionCookieName: string;
  sessionTtlDays: number;
  otpTtlMinutes: number;
  notifyChannels: ("email" | "sms")[];
  corsOrigin: string;
  // Fastify trustProxy: false (default, safe when reachable directly), true, or
  // a hop count. Behind a reverse proxy set TRUST_PROXY=1 so req.ip is the real
  // client and /auth/* rate-limiting keys on it instead of the proxy.
  trustProxy: boolean | number;
  minioEndpoint: string;
  minioAccessKey: string;
  minioSecretKey: string;
  minioBucket: string;
  minioRegion: string;
  kycUrlTtlSeconds: number;
  kycMaxFileMb: number;
  // Empty by default: an unset secret means the escrow webhook rejects all
  // callers, which is the safe prod default until a real secret is configured.
  escrowWebhookSecret: string;
  defaultGraceDays: number;
};

// Parse TRUST_PROXY: unset/""/"false" -> false; "true" -> true; digits -> hop
// count (number); anything else -> false. Off by default because trustProxy:true
// trusts the whole X-Forwarded-For chain and lets a direct client spoof its IP.
function parseTrustProxy(v: string | undefined): boolean | number {
  if (v === undefined || v === "" || v === "false") return false;
  if (v === "true") return true;
  if (/^\d+$/.test(v)) return Number(v);
  return false;
}

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
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    minioEndpoint: e.MINIO_ENDPOINT,
    minioAccessKey: e.MINIO_ACCESS_KEY,
    minioSecretKey: e.MINIO_SECRET_KEY,
    minioBucket: e.MINIO_BUCKET,
    minioRegion: e.MINIO_REGION,
    kycUrlTtlSeconds: e.KYC_URL_TTL_SECONDS,
    kycMaxFileMb: e.KYC_MAX_FILE_MB,
    escrowWebhookSecret: e.ESCROW_WEBHOOK_SECRET,
    defaultGraceDays: e.DEFAULT_GRACE_DAYS,
  };
}
