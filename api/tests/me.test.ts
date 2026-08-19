import { describe, it, expect } from "vitest";
import { buildTestApp, loginAs } from "./helpers/app";

const COOKIE = "kpital_sess";

describe("account self-service", () => {
  it("adds the porteur role idempotently", async () => {
    const { app } = await buildTestApp();
    const cookie = await loginAs(app, "k@a.co");

    const first = await app.inject({
      method: "POST",
      url: "/me/roles",
      cookies: { [COOKIE]: cookie },
      payload: { role: "porteur" },
    });
    expect(first.statusCode).toBe(200);
    expect([...(first.json().roles as string[])].sort()).toEqual(["investor", "porteur"]);

    // Adding an existing role is a no-op — no duplicates.
    const second = await app.inject({
      method: "POST",
      url: "/me/roles",
      cookies: { [COOKIE]: cookie },
      payload: { role: "porteur" },
    });
    expect(second.statusCode).toBe(200);
    expect([...(second.json().roles as string[])].sort()).toEqual(["investor", "porteur"]);

    const me = await app.inject({ method: "GET", url: "/me", cookies: { [COOKIE]: cookie } });
    expect((me.json().roles as string[]).sort()).toEqual(["investor", "porteur"]);

    await app.close();
  });

  it("round-trips notification preferences and defaults", async () => {
    const { app } = await buildTestApp();
    const cookie = await loginAs(app, "np@a.co");

    const defaults = await app.inject({
      method: "GET",
      url: "/me/notification-pref",
      cookies: { [COOKIE]: cookie },
    });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json().channels).toEqual(["email"]);
    expect(defaults.json().categories).toEqual({});

    const updated = await app.inject({
      method: "PATCH",
      url: "/me/notification-pref",
      cookies: { [COOKIE]: cookie },
      payload: { channels: ["email", "sms"], categories: { repayment: false } },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().channels).toEqual(["email", "sms"]);
    expect(updated.json().categories).toEqual({ repayment: false });

    const after = await app.inject({
      method: "GET",
      url: "/me/notification-pref",
      cookies: { [COOKIE]: cookie },
    });
    expect(after.json().channels).toEqual(["email", "sms"]);
    expect(after.json().categories).toEqual({ repayment: false });

    await app.close();
  });

  it("updates profile fields but not roles/email, and adds payout methods", async () => {
    const { app } = await buildTestApp();
    const cookie = await loginAs(app, "pm@a.co");

    const patched = await app.inject({
      method: "PATCH",
      url: "/me",
      cookies: { [COOKIE]: cookie },
      payload: { firstName: "Ama", lastName: "Doe", country: "Ghana", email: "hacker@a.co", roles: ["porteur"] },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().firstName).toBe("Ama");
    expect(patched.json().country).toBe("Ghana");
    expect(patched.json().email).toBe("pm@a.co");
    expect((patched.json().roles as string[])).toEqual(["investor"]);

    const empty = await app.inject({
      method: "GET",
      url: "/wallet/payout-methods",
      cookies: { [COOKIE]: cookie },
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual([]);

    const added = await app.inject({
      method: "POST",
      url: "/wallet/payout-methods",
      cookies: { [COOKIE]: cookie },
      payload: { type: "tmoney", details: { msisdn: "22890000000" }, verified: true },
    });
    expect(added.statusCode).toBe(201);
    // verified must never be settable from the request body.
    expect(added.json().verified).toBe(false);
    expect(added.json().type).toBe("tmoney");

    const list = await app.inject({
      method: "GET",
      url: "/wallet/payout-methods",
      cookies: { [COOKIE]: cookie },
    });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].details).toEqual({ msisdn: "22890000000" });

    await app.close();
  });

  it("requires auth", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/me/roles", payload: { role: "porteur" } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
