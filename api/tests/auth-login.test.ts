import { describe, it, expect } from "vitest";
import { buildTestApp } from "./helpers/app";

describe("POST /auth/login", () => {
  it("logs in with correct password and sets a cookie", async () => {
    const { app, db } = await buildTestApp();
    const { registerAccount } = await import("../src/modules/accounts/register");
    await registerAccount(db, {
      email: "k@a.co",
      password: "Abcdef12",
      firstName: "K",
      lastName: "A",
      country: "Togo",
      roles: ["investor"],
    });
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { identifier: "k@a.co", password: "Abcdef12" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.cookies.some((c) => c.name === "kpital_sess")).toBe(true);
    await app.close();
  });

  it("rejects wrong password with invalid_credentials", async () => {
    const { app, db } = await buildTestApp();
    const { registerAccount } = await import("../src/modules/accounts/register");
    await registerAccount(db, {
      email: "k@a.co",
      password: "Abcdef12",
      firstName: "K",
      lastName: "A",
      country: "Togo",
      roles: ["investor"],
    });
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { identifier: "k@a.co", password: "nope" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_credentials");
    await app.close();
  });

  it("rejects an unknown identifier via the decoy-hash path", async () => {
    const { app } = await buildTestApp();
    // No account exists: login must run the DECOY_HASH verify (not throw) and
    // return the same invalid_credentials envelope as a wrong password.
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { identifier: "nobody@a.co", password: "Abcdef12" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_credentials");
    await app.close();
  });
});
