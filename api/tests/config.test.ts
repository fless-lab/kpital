import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config/env";

const base = {
  DATABASE_URL: "postgres://x",
  CORS_ORIGIN: "http://localhost:8080",
  MINIO_ENDPOINT: "http://127.0.0.1:9100",
  MINIO_ACCESS_KEY: "kpital",
  MINIO_SECRET_KEY: "kpital-secret",
  MINIO_BUCKET: "kpital-kyc",
};

describe("loadConfig", () => {
  it("parses NOTIFY_CHANNELS into an array", () => {
    const c = loadConfig({ ...base, NOTIFY_CHANNELS: "email,sms" });
    expect(c.notifyChannels).toEqual(["email", "sms"]);
  });
  it("throws when DATABASE_URL is missing", () => {
    expect(() => loadConfig({ CORS_ORIGIN: "x" })).toThrow();
  });
  it("defaults NOTIFY_CHANNELS to [email]", () => {
    expect(loadConfig(base).notifyChannels).toEqual(["email"]);
  });
  it("parses TRUST_PROXY (unset -> false, '1' -> 1, 'true' -> true)", () => {
    expect(loadConfig(base).trustProxy).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: "false" }).trustProxy).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: "1" }).trustProxy).toBe(1);
    expect(loadConfig({ ...base, TRUST_PROXY: "true" }).trustProxy).toBe(true);
  });
  it("parses MinIO + KYC config with defaults", () => {
    const c = loadConfig({ DATABASE_URL: "postgres://x", CORS_ORIGIN: "http://localhost:8080",
      MINIO_ENDPOINT: "http://127.0.0.1:9100", MINIO_ACCESS_KEY: "kpital",
      MINIO_SECRET_KEY: "kpital-secret", MINIO_BUCKET: "kpital-kyc" });
    expect(c.minioBucket).toBe("kpital-kyc");
    expect(c.kycUrlTtlSeconds).toBe(120);
    expect(c.kycMaxFileMb).toBe(10);
  });
});
