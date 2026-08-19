import { describe, it, expect } from "vitest";
import { buildTestApp } from "./helpers/app";

describe("register + me", () => {
  it("registers, logs in via cookie, reads /me", async () => {
    const { app } = await buildTestApp();
    const reg = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "k@a.co",
        password: "Abcdef12",
        firstName: "Kofi",
        lastName: "A",
        country: "Togo",
        roles: ["investor"],
      },
    });
    expect(reg.statusCode).toBe(201);
    const cookie = reg.cookies.find((c) => c.name === "kpital_sess")!;
    const me = await app.inject({
      method: "GET",
      url: "/me",
      cookies: { kpital_sess: cookie.value },
    });
    expect(me.json().email).toBe("k@a.co");
    expect(me.json().kycStatus).toBe("pending");
    await app.close();
  });

  it("rejects a weak password with validation_error", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "w@a.co",
        password: "weak",
        firstName: "W",
        lastName: "W",
        country: "Togo",
        roles: ["investor"],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
    await app.close();
  });

  it("rejects a duplicate email with email_taken (409)", async () => {
    const { app } = await buildTestApp();
    const payload = {
      email: "dup@a.co",
      password: "Abcdef12",
      firstName: "D",
      lastName: "D",
      country: "Togo",
      roles: ["investor"],
    };
    const first = await app.inject({ method: "POST", url: "/auth/register", payload });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: "POST", url: "/auth/register", payload });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("email_taken");
    await app.close();
  });
});
