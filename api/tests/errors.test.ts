import { describe, it, expect } from "vitest";
import { buildTestApp } from "./helpers/app";
import type { PaymentProvider } from "../src/lib/payments";

const COOKIE = "kpital_sess";

async function registerAndLogin(app: Awaited<ReturnType<typeof buildTestApp>>["app"], email: string) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email, password: "Abcdef12", firstName: "E", lastName: "R", country: "Togo", roles: ["investor"] },
  });
  expect(res.statusCode).toBe(201);
  const accountId = res.json().id as string;
  const cookie = res.cookies.find((c) => c.name === COOKIE)!;
  return { accountId, cookie: cookie.value };
}

describe("error normalization", () => {
  it("normalizes a domain error that reaches the global handler (payout failure -> 502 payout_failed)", async () => {
    // A payout provider that always fails makes withdraw throw PayoutFailedError,
    // which the wallet route intentionally does NOT catch, so it escapes to the
    // global handler and must come back as the uniform envelope.
    const failingPayments: PaymentProvider = {
      async payout() {
        return { ok: false, ref: "x" };
      },
      async initiateDeposit() {
        return { ok: false, ref: "x", status: "settled" as const };
      },
      async releaseEscrow() {
        return { ok: false, ref: "x" };
      },
      async refundEscrow() {
        return { ok: false, ref: "x" };
      },
      async initiateRepayment() {
        return { ok: false, ref: "", status: "settled" as const };
      },
    };
    const { app, db } = await buildTestApp({ payments: failingPayments });
    const { accountId, cookie } = await registerAndLogin(app, "err-payout@a.co");
    const { credit } = await import("../src/modules/wallet/service");
    await credit(db, { accountId, amountMinor: 100000, type: "repayment", reference: "prj1" });

    const res = await app.inject({
      method: "POST",
      url: "/wallet/withdraw",
      cookies: { [COOKIE]: cookie },
      payload: { amountMinor: 50000, method: { type: "tmoney" } },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: { code: "payout_failed", message: expect.any(String) } });

    await app.close();
  });

  it("returns 429 { error: { code: rate_limited } } when the /auth rate limit is exceeded", async () => {
    const { app } = await buildTestApp({ rateLimitMax: 2 });

    const hit = () =>
      app.inject({ method: "POST", url: "/auth/login", payload: { identifier: "nobody@a.co", password: "wrong" } });

    const first = await hit();
    const second = await hit();
    const third = await hit();

    expect(first.statusCode).toBe(401);
    expect(second.statusCode).toBe(401);
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({ error: { code: "rate_limited", message: expect.any(String) } });

    await app.close();
  });

  it("does NOT rate-limit non-/auth routes (limit is scoped to /auth/*)", async () => {
    const { app } = await buildTestApp({ rateLimitMax: 1 });
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
    }
    await app.close();
  });

  it("normalizes an unknown route to the uniform 404 not_found envelope", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
    await app.close();
  });
});
