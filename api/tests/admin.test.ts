import { describe, it, expect } from "vitest";
import { buildTestApp, loginAs } from "./helpers/app";
import { accounts } from "../src/db/schema";
import { eq } from "drizzle-orm";

const COOKIE = "kpital_sess";

describe("admin", () => {
  it("blocks non-admins and lets an admin set kyc_status", async () => {
    const { app, db } = await buildTestApp();

    const userCookie = await loginAs(app, "u@a.co");
    const blocked = await app.inject({
      method: "GET",
      url: "/admin/accounts",
      cookies: { [COOKIE]: userCookie },
    });
    expect(blocked.statusCode).toBe(403);

    // Unauthenticated must be 401, not 403.
    const anon = await app.inject({ method: "GET", url: "/admin/accounts" });
    expect(anon.statusCode).toBe(401);

    // Promote a second account to admin directly, then act as admin.
    const adminCookie = await loginAs(app, "admin@a.co");
    await db.update(accounts).set({ isAdmin: true }).where(eq(accounts.email, "admin@a.co"));

    const list = await app.inject({
      method: "GET",
      url: "/admin/accounts",
      cookies: { [COOKIE]: adminCookie },
    });
    expect(list.statusCode).toBe(200);
    const rows = list.json().accounts as Array<Record<string, unknown>>;
    expect(Array.isArray(rows)).toBe(true);
    // Never expose password_hash.
    expect(rows.every((r) => !("passwordHash" in r) && !("password_hash" in r))).toBe(true);

    // Find the normal user's id and flip its kyc_status via PATCH.
    const target = rows.find((r) => r.email === "u@a.co")!;
    expect(target).toBeDefined();
    const patched = await app.inject({
      method: "PATCH",
      url: `/admin/accounts/${target.id}`,
      cookies: { [COOKIE]: adminCookie },
      payload: { kyc_status: "verified" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().account.kycStatus).toBe("verified");

    // Invalid enum is rejected.
    const bad = await app.inject({
      method: "PATCH",
      url: `/admin/accounts/${target.id}`,
      cookies: { [COOKIE]: adminCookie },
      payload: { status: "banned" },
    });
    expect(bad.statusCode).toBe(400);

    await app.close();
  });
});
