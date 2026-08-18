import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config/env";

const base = { DATABASE_URL: "postgres://x", CORS_ORIGIN: "http://localhost:8080" };

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
});
