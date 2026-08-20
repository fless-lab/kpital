import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { buildTestApp, loginAs } from "./helpers/app";
import { buildMultipart } from "./helpers/multipart";
import { accounts, kycSubmissions } from "../src/db/schema";

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
    const [admin] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.email, "admin@kycadm.co"));

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

    // The submission row itself is updated (status + review audit fields).
    const [sub] = await db
      .select({
        status: kycSubmissions.status,
        reviewedBy: kycSubmissions.reviewedBy,
        reviewedAt: kycSubmissions.reviewedAt,
        rejectReason: kycSubmissions.rejectReason,
      })
      .from(kycSubmissions)
      .where(eq(kycSubmissions.id, submissionId));
    expect(sub!.status).toBe("verified");
    expect(sub!.reviewedBy).toBe(admin!.id);
    expect(sub!.reviewedAt).not.toBeNull();
    expect(sub!.rejectReason).toBeNull();
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

    const reason = "blurry document";
    const dec = await app.inject({
      method: "POST",
      url: `/admin/kyc/${submissionId}/decision`,
      cookies: { [COOKIE]: adminCookie },
      payload: { decision: "rejected", reason },
    });
    expect(dec.statusCode).toBe(200);

    const [acct] = await db
      .select({ kycStatus: accounts.kycStatus })
      .from(accounts)
      .where(eq(accounts.email, "u@kycadm.co"));
    expect(acct!.kycStatus).toBe("rejected");

    // The submission row records the rejection + reason.
    const [sub] = await db
      .select({ status: kycSubmissions.status, rejectReason: kycSubmissions.rejectReason })
      .from(kycSubmissions)
      .where(eq(kycSubmissions.id, submissionId));
    expect(sub!.status).toBe("rejected");
    expect(sub!.rejectReason).toBe(reason);
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

  it("decision on an unknown submission id → 404 and rolls back (no account changes)", async () => {
    const { app, db } = await buildTestApp();
    const userCookie = await loginAs(app, "u@kycadm.co");
    await submitKyc(app, userCookie); // an unrelated submission → account is "pending"

    const adminCookie = await promoteAdmin(app, "admin@kycadm.co");
    await db.update(accounts).set({ isAdmin: true }).where(eq(accounts.email, "admin@kycadm.co"));

    // A well-formed but nonexistent uuid: the txn updates zero rows, throws the
    // sentinel, rolls back, and maps to 404 — no account's kyc_status flips.
    const missing = "11111111-2222-4333-8444-555555555555";
    const dec = await app.inject({
      method: "POST",
      url: `/admin/kyc/${missing}/decision`,
      cookies: { [COOKIE]: adminCookie },
      payload: { decision: "verified" },
    });
    expect(dec.statusCode).toBe(404);

    const [acct] = await db
      .select({ kycStatus: accounts.kycStatus })
      .from(accounts)
      .where(eq(accounts.email, "u@kycadm.co"));
    expect(acct!.kycStatus).toBe("pending");
  });

  it("queue excludes superseded submissions (only the latest shows)", async () => {
    const { app, db } = await buildTestApp();
    const userCookie = await loginAs(app, "u@kycadm.co");
    const firstId = await submitKyc(app, userCookie); // becomes superseded on resubmit
    const secondId = await submitKyc(app, userCookie); // the current, non-superseded one

    const adminCookie = await promoteAdmin(app, "admin@kycadm.co");
    await db.update(accounts).set({ isAdmin: true }).where(eq(accounts.email, "admin@kycadm.co"));

    const list = await app.inject({
      method: "GET",
      url: "/admin/kyc?status=pending",
      cookies: { [COOKIE]: adminCookie },
    });
    expect(list.statusCode).toBe(200);
    const rows = list.json().submissions as Array<{ id: string; accountId: string }>;
    // Exactly one row for this account: the latest, non-superseded submission.
    const [me] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.email, "u@kycadm.co"));
    const mine = rows.filter((r) => r.accountId === me!.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.id).toBe(secondId);
    expect(rows.some((r) => r.id === firstId)).toBe(false);
  });

  it("decision on a superseded submission id → 404 and leaves account + row untouched", async () => {
    const { app, db } = await buildTestApp();
    const userCookie = await loginAs(app, "u@kycadm.co");
    const firstId = await submitKyc(app, userCookie); // becomes superseded on resubmit
    await submitKyc(app, userCookie); // the current, non-superseded submission

    const adminCookie = await promoteAdmin(app, "admin@kycadm.co");
    await db.update(accounts).set({ isAdmin: true }).where(eq(accounts.email, "admin@kycadm.co"));

    // Deciding the STALE (superseded) id must not clobber the account's kyc_status
    // while the current submission is still unreviewed: the UPDATE matches zero
    // rows (superseded excluded), throws the sentinel, rolls back → 404.
    const dec = await app.inject({
      method: "POST",
      url: `/admin/kyc/${firstId}/decision`,
      cookies: { [COOKIE]: adminCookie },
      payload: { decision: "verified" },
    });
    expect(dec.statusCode).toBe(404);

    // Account kyc_status unchanged (still pending from the second submission).
    const [acct] = await db
      .select({ kycStatus: accounts.kycStatus })
      .from(accounts)
      .where(eq(accounts.email, "u@kycadm.co"));
    expect(acct!.kycStatus).toBe("pending");

    // The superseded row itself is untouched: never marked verified, no reviewer.
    const [sub] = await db
      .select({ status: kycSubmissions.status, reviewedBy: kycSubmissions.reviewedBy })
      .from(kycSubmissions)
      .where(eq(kycSubmissions.id, firstId));
    expect(sub!.status).toBe("pending");
    expect(sub!.reviewedBy).toBeNull();
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
