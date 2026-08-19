import { describe, it, expect } from "vitest";
import { buildTestApp } from "./helpers/app";

describe("GET /health", () => {
  it("returns ok", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });
});
