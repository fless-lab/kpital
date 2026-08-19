import { describe, it, expect } from "vitest";
import { buildTestApp } from "./helpers/app";

describe("password reset (email link)", () => {
  it("forgot then reset lets the new password log in", async () => {
    const { app, sentLinks } = await buildTestApp(); // sentLinks captures reset tokens
    const { registerAccount } = await import("../src/modules/accounts/register");
    await registerAccount((app as any).db, {
      email: "k@a.co",
      password: "Abcdef12",
      firstName: "K",
      lastName: "A",
      country: "Togo",
      roles: ["investor"],
    });
    await app.inject({
      method: "POST",
      url: "/auth/password/forgot",
      payload: { identifier: "k@a.co", channel: "email" },
    });
    const token = sentLinks.at(-1);
    // Establish a session on the OLD password; it must be killed by the reset.
    const preLogin = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { identifier: "k@a.co", password: "Abcdef12" },
    });
    expect(preLogin.statusCode).toBe(200);
    const preCookie = preLogin.cookies.find((c) => c.name === "kpital_sess")?.value ?? "";

    const rr = await app.inject({
      method: "POST",
      url: "/auth/password/reset",
      payload: { token, password: "Newpass12" },
    });
    expect(rr.statusCode).toBe(200);
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { identifier: "k@a.co", password: "Newpass12" },
    });
    expect(login.statusCode).toBe(200);

    // The reset token is single-use: reusing it returns 400 invalid_token.
    const reuse = await app.inject({
      method: "POST",
      url: "/auth/password/reset",
      payload: { token, password: "Newpass34" },
    });
    expect(reuse.statusCode).toBe(400);
    expect(reuse.json().error.code).toBe("invalid_token");

    // revokeAllSessions took effect: the pre-reset session no longer authorizes.
    const meAfter = await app.inject({
      method: "GET",
      url: "/me",
      cookies: { kpital_sess: preCookie },
    });
    expect(meAfter.statusCode).toBe(401);

    await app.close();
  });

  it("forgot for unknown identifier still returns sent:true", async () => {
    const { app } = await buildTestApp();
    const r = await app.inject({
      method: "POST",
      url: "/auth/password/forgot",
      payload: { identifier: "no@a.co", channel: "email" },
    });
    expect(r.json()).toEqual({ sent: true });
    await app.close();
  });
});
