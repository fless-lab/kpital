import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { buildTestApp, loginAs } from "./helpers/app";
import { buildMultipart } from "./helpers/multipart";
import { accounts } from "../src/db/schema";
import type { Db } from "../src/db/client";
import type { FastifyInstance } from "fastify";

const COOKIE = "kpital_sess";

const body = {
  category: "commerce",
  title: "Boutique",
  city: "Lomé",
  description: "d",
  targetMinor: 1500000,
  durationMonths: 6,
  roiPct: 16,
  fundsUsage: "stock",
  cautionType: "aval",
};

// A minimal valid PNG header (magic bytes) so sniffMime resolves to image/png.
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function makePorteur(app: FastifyInstance, db: Db, email: string): Promise<string> {
  const cookie = await loginAs(app, email);
  await db.update(accounts).set({ roles: ["investor", "porteur"] }).where(eq(accounts.email, email));
  return cookie;
}

async function createProject(app: FastifyInstance, cookie: string): Promise<string> {
  const c = await app.inject({ method: "POST", url: "/projects", cookies: { [COOKIE]: cookie }, payload: body });
  expect(c.statusCode).toBe(201);
  return c.json().id as string;
}

describe("project documents", () => {
  it("uploads a public photo and stores exactly one server-keyed object", async () => {
    const { app, db, storage } = await buildTestApp();
    const cookie = await makePorteur(app, db, "p@a.co");
    const id = await createProject(app, cookie);

    const form = buildMultipart({
      fields: { kind: "photo" },
      files: [{ name: "file", filename: "p.png", contentType: "image/png", data: png }],
    });
    const r = await app.inject({
      method: "POST",
      url: `/projects/${id}/documents`,
      cookies: { [COOKIE]: cookie },
      headers: form.headers,
      payload: form.body,
    });

    expect(r.statusCode).toBe(201);
    expect(r.json().visibility).toBe("public");
    expect(r.json().kind).toBe("photo");
    expect(storage.objects.size).toBe(1);
    // The storage key is server-generated from projectId + the returned documentId,
    // never the client filename ("p.png").
    const documentId = r.json().documentId as string;
    expect(storage.objects.has(`projects/${id}/${documentId}.png`)).toBe(true);
  });

  it("uploads an rccm legal doc as private", async () => {
    const { app, db } = await buildTestApp();
    const cookie = await makePorteur(app, db, "rccm@a.co");
    const id = await createProject(app, cookie);

    const form = buildMultipart({
      fields: { kind: "rccm" },
      files: [{ name: "file", filename: "rccm.png", contentType: "image/png", data: png }],
    });
    const r = await app.inject({
      method: "POST",
      url: `/projects/${id}/documents`,
      cookies: { [COOKIE]: cookie },
      headers: form.headers,
      payload: form.body,
    });

    expect(r.statusCode).toBe(201);
    expect(r.json().visibility).toBe("private");
  });

  it("rejects a file whose bytes do not match any allowed type (magic-byte sniff)", async () => {
    const { app, db, storage } = await buildTestApp();
    const cookie = await makePorteur(app, db, "garbage@a.co");
    const id = await createProject(app, cookie);

    // Bytes are garbage; the client lies with image/png. Magic-byte sniffing wins.
    const form = buildMultipart({
      fields: { kind: "photo" },
      files: [{ name: "file", filename: "x.png", contentType: "image/png", data: Buffer.from([1, 2, 3, 4]) }],
    });
    const r = await app.inject({
      method: "POST",
      url: `/projects/${id}/documents`,
      cookies: { [COOKIE]: cookie },
      headers: form.headers,
      payload: form.body,
    });

    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("validation_error");
    expect(storage.objects.size).toBe(0);
  });

  it("forbids a non-owner from adding documents (403)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await makePorteur(app, db, "owner@a.co");
    const other = await makePorteur(app, db, "other@a.co");
    const id = await createProject(app, owner);

    const form = buildMultipart({
      fields: { kind: "photo" },
      files: [{ name: "file", filename: "p.png", contentType: "image/png", data: png }],
    });
    const r = await app.inject({
      method: "POST",
      url: `/projects/${id}/documents`,
      cookies: { [COOKIE]: other },
      headers: form.headers,
      payload: form.body,
    });

    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("forbidden");
  });

  it("rejects adding documents to a non-editable (submitted) project with 409 invalid_state", async () => {
    const { app, db } = await buildTestApp();
    const cookie = await makePorteur(app, db, "submitted@a.co");
    const id = await createProject(app, cookie);
    const s = await app.inject({ method: "POST", url: `/projects/${id}/submit`, cookies: { [COOKIE]: cookie } });
    expect(s.statusCode).toBe(200);

    const form = buildMultipart({
      fields: { kind: "photo" },
      files: [{ name: "file", filename: "p.png", contentType: "image/png", data: png }],
    });
    const r = await app.inject({
      method: "POST",
      url: `/projects/${id}/documents`,
      cookies: { [COOKIE]: cookie },
      headers: form.headers,
      payload: form.body,
    });

    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("invalid_state");
  });

  it("rejects an invalid kind with 400 validation_error", async () => {
    const { app, db } = await buildTestApp();
    const cookie = await makePorteur(app, db, "badkind@a.co");
    const id = await createProject(app, cookie);

    const form = buildMultipart({
      fields: { kind: "bogus" },
      files: [{ name: "file", filename: "p.png", contentType: "image/png", data: png }],
    });
    const r = await app.inject({
      method: "POST",
      url: `/projects/${id}/documents`,
      cookies: { [COOKIE]: cookie },
      headers: form.headers,
      payload: form.body,
    });

    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("validation_error");
  });

  it("drains every part and still succeeds when an extra trailing file is sent (no hang)", async () => {
    const { app, db, storage } = await buildTestApp();
    const cookie = await makePorteur(app, db, "drain@a.co");
    const id = await createProject(app, cookie);

    // Two file parts: the loop must consume both (draining the extra) rather than
    // early-returning and leaving a paused stream that stalls body parsing.
    const form = buildMultipart({
      fields: { kind: "photo" },
      files: [
        { name: "file", filename: "a.png", contentType: "image/png", data: png },
        { name: "file", filename: "b.png", contentType: "image/png", data: png },
      ],
    });
    const r = await app.inject({
      method: "POST",
      url: `/projects/${id}/documents`,
      cookies: { [COOKIE]: cookie },
      headers: form.headers,
      payload: form.body,
    });

    expect(r.statusCode).toBe(201);
    // Only the first file is stored; the extra part is drained, not persisted.
    expect(storage.objects.size).toBe(1);
  });

  it("requires auth", async () => {
    const { app } = await buildTestApp();
    const form = buildMultipart({
      fields: { kind: "photo" },
      files: [{ name: "file", filename: "p.png", contentType: "image/png", data: png }],
    });
    const r = await app.inject({
      method: "POST",
      url: `/projects/00000000-0000-0000-0000-000000000000/documents`,
      headers: form.headers,
      payload: form.body,
    });
    expect(r.statusCode).toBe(401);
  });
});
