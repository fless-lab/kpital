import { describe, it, expect } from "vitest";
import { buildTestApp, loginAs } from "./helpers/app";
import { buildMultipart } from "./helpers/multipart";
import type { MemoryStorage } from "../src/lib/storage/memory";

const COOKIE = "kpital_sess";

// A minimal valid PNG header (magic bytes) so sniffMime resolves to image/png.
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("kyc routes", () => {
  it("submits KYC docs and reads them back via /kyc/me", async () => {
    const { app, storage } = await buildTestApp();
    const mem = storage as MemoryStorage;
    const cookie = await loginAs(app, "k@a.co");
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
    expect(res.json().status).toBe("pending");
    expect(typeof res.json().submissionId).toBe("string");
    expect(mem.objects.size).toBe(2);

    const me = await app.inject({ method: "GET", url: "/kyc/me", cookies: { [COOKIE]: cookie } });
    expect(me.statusCode).toBe(200);
    const body = me.json();
    expect(body.submission.status).toBe("pending");
    expect(body.documents).toHaveLength(2);
    for (const d of body.documents) {
      expect(typeof d.url).toBe("string");
    }
  });

  it("rejects a submission with a bad doc_type via 400 validation_error", async () => {
    const { app } = await buildTestApp();
    const cookie = await loginAs(app, "k2@a.co");
    const form = buildMultipart({
      fields: { doc_type: "bogus", doc_number: "TG-2", dob: "1990-01-01", nationality: "Togolaise" },
      files: [{ name: "front", filename: "f.png", contentType: "image/png", data: png }],
    });
    const res = await app.inject({
      method: "POST",
      url: "/kyc/submission",
      cookies: { [COOKIE]: cookie },
      headers: form.headers,
      payload: form.body,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("requires auth", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/kyc/me" });
    expect(res.statusCode).toBe(401);
  });

  it("returns null submission when the caller has none", async () => {
    const { app } = await buildTestApp();
    const cookie = await loginAs(app, "k3@a.co");
    const me = await app.inject({ method: "GET", url: "/kyc/me", cookies: { [COOKIE]: cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().submission).toBeNull();
    expect(me.json().documents).toEqual([]);
  });
});
