import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { buildTestApp, loginAs } from "./helpers/app";
import { accounts } from "../src/db/schema";

const COOKIE = "kpital_sess";

describe("account status enforcement", () => {
  it("rejects login for a suspended account with 403 account_suspended", async () => {
    const { app, db } = await buildTestApp();
    const { registerAccount } = await import("../src/modules/accounts/register");
    await registerAccount(db, {
      email: "susp@a.co",
      password: "Abcdef12",
      firstName: "S",
      lastName: "S",
      country: "Togo",
      roles: ["investor"],
    });
    await db.update(accounts).set({ status: "suspended" }).where(eq(accounts.email, "susp@a.co"));

    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { identifier: "susp@a.co", password: "Abcdef12" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("account_suspended");
    expect(res.cookies.some((c) => c.name === COOKIE && c.value)).toBe(false);
    await app.close();
  });

  it("cuts off an already-established session once the account is suspended", async () => {
    const { app, db } = await buildTestApp();
    const cookie = await loginAs(app, "live@a.co");

    // Session works while active.
    const before = await app.inject({ method: "GET", url: "/me", cookies: { [COOKIE]: cookie } });
    expect(before.statusCode).toBe(200);

    await db.update(accounts).set({ status: "suspended" }).where(eq(accounts.email, "live@a.co"));

    const after = await app.inject({ method: "GET", url: "/me", cookies: { [COOKIE]: cookie } });
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe("unauthorized");
    await app.close();
  });
});
