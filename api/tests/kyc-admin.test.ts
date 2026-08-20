import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { buildTestApp, loginAs } from "./helpers/app";
import { buildMultipart } from "./helpers/multipart";
import { accounts } from "../src/db/schema";

const COOKIE = "kpital_sess";

// A minimal valid PNG header (magic bytes) so sniffMime resolves to image/png.
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function submitKyc(app: Awaited<ReturnType<typeof buildTestApp>>["app"], cookie: string): Promise<string> {
  const form = buildMultipart({
    fields: { doc_type: "cni", doc_number: "TG-1", dob: "1990-01-01", nationality: "Togolaise" },
    files: [
      { name: "front", filename: "f.png", contentType: "image/png", data: png },
      { name: "back", filename: "b.png", contentType: "image/png", data: png },
    ],
  });
  const res = await app.inject({
    method: "POST",
    url: "/kyc/submission",
    cookies: { [COOKIE]: cookie },
    headers: form.headers,
    payload: form.body,
  });
  expect(res.statusCode).toBe(201);
  return res.json().submissionId as string;
}

async function promoteAdmin(app: Awaited<ReturnType<typeof buildTestApp>>["app"], email: string): Promise<string> {
  return loginAs(app, email);
}

describe("kyc admin", () => {
  it("non-admin gets 403 on /admin/kyc", async () => {
    const { app } = await buildTestApp();
    const userCookie = await loginAs(app, "u@kycadm.co");
    const res = await app.inject({ method: "GET", url: "/admin/kyc", cookies: { [COOKIE]: userCookie } });
    expect(res.statusCode).toBe(403);
  });

  it("unauthenticated gets 401 on /admin/kyc", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/admin/kyc" });
    expect(res.statusCode).toBe(401);
  });

  it("admin lists pending, views detail with signed urls, and verifies (mirrors kyc_status)", async () => {
    const { app, db } = await buildTestApp();
    const userCookie = await loginAs(app, "u@kycadm.co");
    const submissionId = await submitKyc(app, userCookie);

    const adminCookie = await promoteAdmin(app, "admin@kycadm.co");
    await db.update(accounts).set({ isAdmin: true }).where(eq(accounts.email, "admin@kycadm.co"));

    // Queue: filtered by status, metadata only (no documents, no password_hash).
    const list = await app.inject({
      method: "GET",
      url: "/admin/kyc?status=pending",
      cookies: { [COOKIE]: adminCookie },
    });
    expect(list.statusCode).toBe(200);
    const rows = list.json().submissions as Array<Record<string, unknown>>;
    expect(Array.isArray(rows)).toBe(true);
    const row = rows.find((r) => r.id === submissionId);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("documents");
    expect(row).not.toHaveProperty("passwordHash");
    expect(row).not.toHaveProperty("password_hash");
    expect(row!.docType).toBe("cni");

    // Detail: submission + documents[] each carrying a signed url.
    const detail = await app.inject({
      method: "GET",
      url: `/admin/kyc/${submissionId}`,
      cookies: { [COOKIE]: adminCookie },
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.submission.id).toBe(submissionId);
    expect(body.documents).toHaveLength(2);
    for (const d of body.documents) {
      expect(typeof d.url).toBe("string");
      expect(d.url.length).toBeGreaterThan(0);
    }

    // Decision: verified → 200, and the submitting user's account is mirrored.
    const dec = await app.inject({
      method: "POST",
      url: `/admin/kyc/${submissionId}/decision`,
      cookies: { [COOKIE]: adminCookie },
      payload: { decision: "verified" },
    });
    expect(dec.statusCode).toBe(200);

    const [acct] = await db
      .select({ kycStatus: accounts.kycStatus })
      .from(accounts)
      .where(eq(accounts.email, "u@kycadm.co"));
    expect(acct!.kycStatus).toBe("verified");
  });

  it("reject requires a non-empty reason (400)", async () => {
    const { app, db } = await buildTestApp();
    const userCookie = await loginAs(app, "u@kycadm.co");
    const submissionId = await submitKyc(app, userCookie);

    const adminCookie = await promoteAdmin(app, "admin@kycadm.co");
    await db.update(accounts).set({ isAdmin: true }).where(eq(accounts.email, "admin@kycadm.co"));

    const dec = await app.inject({
      method: "POST",
      url: `/admin/kyc/${submissionId}/decision`,
      cookies: { [COOKIE]: adminCookie },
      payload: { decision: "rejected" },
    });
    expect(dec.statusCode).toBe(400);
    expect(dec.json().error.code).toBe("validation_error");
  });

  it("rejects a submission with a reason and mirrors kyc_status to rejected", async () => {
    const { app, db } = await buildTestApp();
    const userCookie = await loginAs(app, "u@kycadm.co");
    const submissionId = await submitKyc(app, userCookie);

    const adminCookie = await promoteAdmin(app, "admin@kycadm.co");
    await db.update(accounts).set({ isAdmin: true }).where(eq(accounts.email, "admin@kycadm.co"));

    const dec = await app.inject({
      method: "POST",
      url: `/admin/kyc/${submissionId}/decision`,
      cookies: { [COOKIE]: adminCookie },
      payload: { decision: "rejected", reason: "blurry document" },
    });
    expect(dec.statusCode).toBe(200);

    const [acct] = await db
      .select({ kycStatus: accounts.kycStatus })
      .from(accounts)
      .where(eq(accounts.email, "u@kycadm.co"));
    expect(acct!.kycStatus).toBe("rejected");
  });

  it("returns 404 for an unknown submission id (valid uuid, absent)", async () => {
    const { app, db } = await buildTestApp();
    const adminCookie = await promoteAdmin(app, "admin@kycadm.co");
    await db.update(accounts).set({ isAdmin: true }).where(eq(accounts.email, "admin@kycadm.co"));
    const missing = "00000000-0000-0000-0000-000000000000";
    const res = await app.inject({
      method: "GET",
      url: `/admin/kyc/${missing}`,
      cookies: { [COOKIE]: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects an invalid ?status enum with 400", async () => {
    const { app, db } = await buildTestApp();
    const adminCookie = await promoteAdmin(app, "admin@kycadm.co");
    await db.update(accounts).set({ isAdmin: true }).where(eq(accounts.email, "admin@kycadm.co"));
    const res = await app.inject({
      method: "GET",
      url: "/admin/kyc?status=bogus",
      cookies: { [COOKIE]: adminCookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });
});
