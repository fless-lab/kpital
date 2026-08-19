import { describe, it, expect } from "vitest";
import { buildTestApp } from "./helpers/app";
import { registerAccount } from "../src/modules/accounts/register";

describe("otp login", () => {
  it("requests a code, then logs in with it", async () => {
    const { app, db, sentCodes } = await buildTestApp();
    await registerAccount(db, {
      email: "k@a.co",
      password: "Abcdef12",
      firstName: "K",
      lastName: "A",
      country: "Togo",
      roles: ["investor"],
    });

    const r = await app.inject({
      method: "POST",
      url: "/auth/otp/request",
      payload: { identifier: "k@a.co", channel: "email" },
    });
    expect(r.json()).toEqual({ sent: true });

    const code = sentCodes.at(-1);
    expect(code).toMatch(/^\d{6}$/);

    const v = await app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      payload: { identifier: "k@a.co", code },
    });
    expect(v.statusCode).toBe(200);
    expect(v.cookies.some((c) => c.name === "kpital_sess")).toBe(true);

    await app.close();
  });

  it("returns sent:true even for an unknown identifier and sends nothing", async () => {
    const { app, sentCodes } = await buildTestApp();
    const r = await app.inject({
      method: "POST",
      url: "/auth/otp/request",
      payload: { identifier: "nobody@a.co", channel: "email" },
    });
    expect(r.json()).toEqual({ sent: true });
    expect(sentCodes.length).toBe(0);
    await app.close();
  });

  it("rejects a wrong code with 401 otp_invalid", async () => {
    const { app, db, sentCodes } = await buildTestApp();
    await registerAccount(db, {
      email: "j@a.co",
      password: "Abcdef12",
      firstName: "J",
      lastName: "A",
      country: "Togo",
      roles: ["investor"],
    });
    await app.inject({
      method: "POST",
      url: "/auth/otp/request",
      payload: { identifier: "j@a.co", channel: "email" },
    });
    // Guarantee a code that differs from the real one, so this never flakes.
    const wrong = sentCodes.at(-1) === "000000" ? "111111" : "000000";
    const v = await app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      payload: { identifier: "j@a.co", code: wrong },
    });
    expect(v.statusCode).toBe(401);
    expect(v.json()).toEqual({ error: { code: "otp_invalid", message: "Invalid or expired code" } });
    await app.close();
  });
});
