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
