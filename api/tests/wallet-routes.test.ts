import { describe, it, expect } from "vitest";
import { buildTestApp } from "./helpers/app";

const COOKIE = "kpital_sess";

async function registerAndLogin(app: Awaited<ReturnType<typeof buildTestApp>>["app"], email: string) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email, password: "Abcdef12", firstName: "W", lastName: "A", country: "Togo", roles: ["investor"] },
  });
  expect(res.statusCode).toBe(201);
  const accountId = res.json().id as string;
  const cookie = res.cookies.find((c) => c.name === COOKIE);
  expect(cookie).toBeDefined();
  return { accountId, cookie: cookie!.value };
}

describe("wallet HTTP routes", () => {
  it("GET /wallet returns balance and entries for the logged-in user", async () => {
    const { app, db } = await buildTestApp();
    const { accountId, cookie } = await registerAndLogin(app, "wg@a.co");
    const { credit } = await import("../src/modules/wallet/service");
    await credit(db, { accountId, amountMinor: 230000, type: "repayment", reference: "prj1" });

    const res = await app.inject({ method: "GET", url: "/wallet", cookies: { [COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.balance).toBe(230000);
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].amountMinor).toBe(230000);

    await app.close();
  });

  it("GET /wallet requires auth", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/wallet" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("POST /wallet/withdraw debits the wallet on the happy path", async () => {
    const { app, db } = await buildTestApp();
    const { accountId, cookie } = await registerAndLogin(app, "ww@a.co");
    const { credit } = await import("../src/modules/wallet/service");
    await credit(db, { accountId, amountMinor: 230000, type: "repayment", reference: "prj1" });

    const res = await app.inject({
      method: "POST",
      url: "/wallet/withdraw",
      cookies: { [COOKIE]: cookie },
      payload: { amountMinor: 100000, method: { type: "tmoney" } },
    });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().entryId).toBe("string");

    const after = await app.inject({ method: "GET", url: "/wallet", cookies: { [COOKIE]: cookie } });
    expect(after.json().balance).toBe(130000);

    await app.close();
  });

  it("POST /wallet/withdraw over balance returns 400 insufficient_funds", async () => {
    const { app, db } = await buildTestApp();
    const { accountId, cookie } = await registerAndLogin(app, "wi@a.co");
    const { credit } = await import("../src/modules/wallet/service");
    await credit(db, { accountId, amountMinor: 50000, type: "repayment", reference: "prj1" });

    const res = await app.inject({
      method: "POST",
      url: "/wallet/withdraw",
      cookies: { [COOKIE]: cookie },
      payload: { amountMinor: 999999, method: { type: "tmoney" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("insufficient_funds");

    await app.close();
  });
});
