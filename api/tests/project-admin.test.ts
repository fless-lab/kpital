import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { buildTestApp, loginAs } from "./helpers/app";
import { buildMultipart } from "./helpers/multipart";
import { accounts, projects } from "../src/db/schema";
import type { Db } from "../src/db/client";
import type { FastifyInstance } from "fastify";
import type { Notifier } from "../src/lib/notifier";

const COOKIE = "kpital_sess";

// A minimal valid PNG header (magic bytes) so the doc-upload mime sniff passes.
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

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

async function makePorteur(app: FastifyInstance, db: Db, email: string): Promise<string> {
  const cookie = await loginAs(app, email);
  await db.update(accounts).set({ roles: ["investor", "porteur"] }).where(eq(accounts.email, email));
  return cookie;
}

async function makeAdmin(app: FastifyInstance, db: Db, email: string): Promise<string> {
  const cookie = await loginAs(app, email);
  await db.update(accounts).set({ isAdmin: true }).where(eq(accounts.email, email));
  return cookie;
}

// Create a project, attach one public (photo) + one private (rccm) document
// while still a draft, then submit. Returns the project id.
async function createSubmittedProject(app: FastifyInstance, porteur: string): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/projects",
    cookies: { [COOKIE]: porteur },
    payload: body,
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().id as string;

  for (const kind of ["photo", "rccm"]) {
    const form = buildMultipart({
      fields: { kind },
      files: [{ name: "file", filename: `${kind}.png`, contentType: "image/png", data: png }],
    });
    const up = await app.inject({
      method: "POST",
      url: `/projects/${id}/documents`,
      cookies: { [COOKIE]: porteur },
      headers: form.headers,
      payload: form.body,
    });
    expect(up.statusCode).toBe(201);
  }

  const sub = await app.inject({ method: "POST", url: `/projects/${id}/submit`, cookies: { [COOKIE]: porteur } });
  expect(sub.statusCode).toBe(200);
  return id;
}

describe("admin project moderation", () => {
  it("non-admin gets 403 on /admin/projects", async () => {
    const { app } = await buildTestApp();
    const user = await loginAs(app, "u@padm.co");
    const res = await app.inject({ method: "GET", url: "/admin/projects", cookies: { [COOKIE]: user } });
    expect(res.statusCode).toBe(403);
  });

  it("unauthenticated gets 401 on /admin/projects", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/admin/projects" });
    expect(res.statusCode).toBe(401);
  });

  it("admin queue lists submitted projects (metadata only, no docs/password_hash)", async () => {
    const { app, db } = await buildTestApp();
    const porteur = await makePorteur(app, db, "p1@padm.co");
    const id = await createSubmittedProject(app, porteur);
    const admin = await makeAdmin(app, db, "a1@padm.co");

    const list = await app.inject({
      method: "GET",
      url: "/admin/projects?status=submitted",
      cookies: { [COOKIE]: admin },
    });
    expect(list.statusCode).toBe(200);
    const rows = list.json().projects as Array<Record<string, unknown>>;
    const row = rows.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("documents");
    expect(row).not.toHaveProperty("passwordHash");
    expect(row).not.toHaveProperty("password_hash");

    // The default/in_review filter is a valid enum and returns 200 (empty is fine:
    // nothing transitions submitted → in_review yet).
    const inReview = await app.inject({
      method: "GET",
      url: "/admin/projects?status=in_review",
      cookies: { [COOKIE]: admin },
    });
    expect(inReview.statusCode).toBe(200);
    expect(Array.isArray(inReview.json().projects)).toBe(true);
  });

  it("rejects an invalid ?status enum with 400", async () => {
    const { app, db } = await buildTestApp();
    const admin = await makeAdmin(app, db, "a2@padm.co");
    const res = await app.inject({
      method: "GET",
      url: "/admin/projects?status=bogus",
      cookies: { [COOKIE]: admin },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("detail returns EVERY document (public + private) with signed urls, no storageKey", async () => {
    const { app, db } = await buildTestApp();
    const porteur = await makePorteur(app, db, "p3@padm.co");
    const id = await createSubmittedProject(app, porteur);
    const admin = await makeAdmin(app, db, "a3@padm.co");

    const detail = await app.inject({
      method: "GET",
      url: `/admin/projects/${id}`,
      cookies: { [COOKIE]: admin },
    });
    expect(detail.statusCode).toBe(200);
    const d = detail.json();
    expect(d.project.id).toBe(id);
    expect(d.documents).toHaveLength(2);
    for (const doc of d.documents) {
      expect(typeof doc.url).toBe("string");
      expect(doc.url.length).toBeGreaterThan(0);
      expect(doc).not.toHaveProperty("storageKey");
    }
    // Includes the private legal doc (rccm) — admin sees all.
    expect(d.documents.some((doc: any) => doc.kind === "rccm")).toBe(true);
    expect(d.documents.some((doc: any) => doc.kind === "photo")).toBe(true);
  });

  it("detail 404 for unknown or malformed id", async () => {
    const { app, db } = await buildTestApp();
    const admin = await makeAdmin(app, db, "a4@padm.co");
    const missing = await app.inject({
      method: "GET",
      url: "/admin/projects/00000000-0000-0000-0000-000000000000",
      cookies: { [COOKIE]: admin },
    });
    expect(missing.statusCode).toBe(404);
    const bad = await app.inject({ method: "GET", url: "/admin/projects/not-a-uuid", cookies: { [COOKIE]: admin } });
    expect(bad.statusCode).toBe(404);
  });

  it("approve+score → showcase, then open-collection → collecting + notifies followers", async () => {
    // Capture every notification so we can assert the follower fan-out. Filter by
    // the collection-open subject — registration/OTP flows also drive the notifier.
    const sent: Array<{ to: { email?: string; phone?: string }; subject: string; body: string }> = [];
    const notifier: Notifier = {
      async send(to, m) {
        sent.push({ to, subject: m.subject, body: m.body });
      },
    };
    const { app, db } = await buildTestApp({ notifier });
    const porteur = await makePorteur(app, db, "p5@padm.co");
    const id = await createSubmittedProject(app, porteur);
    const followerA = await loginAs(app, "f5a@padm.co");
    const followerB = await loginAs(app, "f5b@padm.co");
    const admin = await makeAdmin(app, db, "a5@padm.co");
    const [adm] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.email, "a5@padm.co"));

    const dec = await app.inject({
      method: "POST",
      url: `/admin/projects/${id}/decision`,
      cookies: { [COOKIE]: admin },
      payload: { decision: "approve", score: "B" },
    });
    expect(dec.statusCode).toBe(200);

    // Review audit fields written (unobservable via any public route → check DB).
    const [approved] = await db
      .select({
        status: projects.status,
        score: projects.score,
        publishedAt: projects.publishedAt,
        reviewedBy: projects.reviewedBy,
        reviewedAt: projects.reviewedAt,
      })
      .from(projects)
      .where(eq(projects.id, id));
    expect(approved!.status).toBe("showcase");
    expect(approved!.score).toBe("B");
    expect(approved!.publishedAt).not.toBeNull();
    expect(approved!.reviewedBy).toBe(adm!.id);
    expect(approved!.reviewedAt).not.toBeNull();

    // Now on the public showcase with score B.
    const show = await app.inject({ method: "GET", url: "/projects/showcase?limit=100" });
    const showRow = (show.json().projects as any[]).find((p) => p.id === id);
    expect(showRow).toBeDefined();
    expect(showRow.score).toBe("B");

    // Two followers follow the showcased project, then admin opens collection.
    for (const f of [followerA, followerB]) {
      const fol = await app.inject({ method: "POST", url: `/projects/${id}/follow`, cookies: { [COOKIE]: f } });
      expect(fol.statusCode).toBe(200);
    }

    const open = await app.inject({
      method: "POST",
      url: `/admin/projects/${id}/open-collection`,
      cookies: { [COOKIE]: admin },
    });
    expect(open.statusCode).toBe(200);

    // collectingOpenedAt written (also unobservable via public routes).
    const [collecting] = await db
      .select({ status: projects.status, collectingOpenedAt: projects.collectingOpenedAt })
      .from(projects)
      .where(eq(projects.id, id));
    expect(collecting!.status).toBe("collecting");
    expect(collecting!.collectingOpenedAt).not.toBeNull();

    // Both followers were notified that collection is open, the message names the project.
    const openMsgs = sent.filter((m) => m.subject.includes("Collecte ouverte") && m.body.includes("Boutique"));
    expect(openMsgs).toHaveLength(2);
    const recipients = openMsgs.map((m) => m.to.email).sort();
    expect(recipients).toEqual(["f5a@padm.co", "f5b@padm.co"]);

    // Moved to funding, gone from showcase (mutually exclusive surfaces).
    const funding = await app.inject({ method: "GET", url: "/projects/funding?limit=100" });
    expect((funding.json().projects as any[]).map((p) => p.id)).toContain(id);
    const show2 = await app.inject({ method: "GET", url: "/projects/showcase?limit=100" });
    expect((show2.json().projects as any[]).map((p) => p.id)).not.toContain(id);
  });

  it("queue lists in_review projects and approving from in_review → showcase", async () => {
    const { app, db } = await buildTestApp();
    const porteur = await makePorteur(app, db, "p12@padm.co");
    const id = await createSubmittedProject(app, porteur);
    // Simulate an intake step moving submitted → in_review (no route does this yet).
    await db.update(projects).set({ status: "in_review" }).where(eq(projects.id, id));
    const admin = await makeAdmin(app, db, "a12@padm.co");

    const list = await app.inject({
      method: "GET",
      url: "/admin/projects?status=in_review",
      cookies: { [COOKIE]: admin },
    });
    expect(list.statusCode).toBe(200);
    expect((list.json().projects as any[]).map((p) => p.id)).toContain(id);

    // The in_review arm of the decision guard also approves.
    const dec = await app.inject({
      method: "POST",
      url: `/admin/projects/${id}/decision`,
      cookies: { [COOKIE]: admin },
      payload: { decision: "approve", score: "C" },
    });
    expect(dec.statusCode).toBe(200);
    const [p] = await db.select({ status: projects.status }).from(projects).where(eq(projects.id, id));
    expect(p!.status).toBe("showcase");
  });

  it("reject without a reason → 400", async () => {
    const { app, db } = await buildTestApp();
    const porteur = await makePorteur(app, db, "p6@padm.co");
    const id = await createSubmittedProject(app, porteur);
    const admin = await makeAdmin(app, db, "a6@padm.co");

    const dec = await app.inject({
      method: "POST",
      url: `/admin/projects/${id}/decision`,
      cookies: { [COOKIE]: admin },
      payload: { decision: "reject" },
    });
    expect(dec.statusCode).toBe(400);
    expect(dec.json().error.code).toBe("validation_error");
  });

  it("reject with a reason → rejected + reason recorded", async () => {
    const { app, db } = await buildTestApp();
    const porteur = await makePorteur(app, db, "p7@padm.co");
    const id = await createSubmittedProject(app, porteur);
    const admin = await makeAdmin(app, db, "a7@padm.co");

    const dec = await app.inject({
      method: "POST",
      url: `/admin/projects/${id}/decision`,
      cookies: { [COOKIE]: admin },
      payload: { decision: "reject", reason: "insufficient collateral" },
    });
    expect(dec.statusCode).toBe(200);
    // Owner sees it back in their list as rejected.
    const mine = await app.inject({ method: "GET", url: "/projects/mine", cookies: { [COOKIE]: porteur } });
    const row = (mine.json().projects as any[]).find((p) => p.id === id);
    expect(row.status).toBe("rejected");
    expect(row.rejectReason).toBe("insufficient collateral");
  });

  it("approve from a non-submitted state → 409 (approving twice)", async () => {
    const { app, db } = await buildTestApp();
    const porteur = await makePorteur(app, db, "p8@padm.co");
    const id = await createSubmittedProject(app, porteur);
    const admin = await makeAdmin(app, db, "a8@padm.co");

    const first = await app.inject({
      method: "POST",
      url: `/admin/projects/${id}/decision`,
      cookies: { [COOKIE]: admin },
      payload: { decision: "approve", score: "A" },
    });
    expect(first.statusCode).toBe(200);

    // Second approve: status is now showcase, not submitted|in_review → 409.
    const second = await app.inject({
      method: "POST",
      url: `/admin/projects/${id}/decision`,
      cookies: { [COOKIE]: admin },
      payload: { decision: "approve", score: "A" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("invalid_state");
  });

  it("approve without a score → 400", async () => {
    const { app, db } = await buildTestApp();
    const porteur = await makePorteur(app, db, "p9@padm.co");
    const id = await createSubmittedProject(app, porteur);
    const admin = await makeAdmin(app, db, "a9@padm.co");

    const dec = await app.inject({
      method: "POST",
      url: `/admin/projects/${id}/decision`,
      cookies: { [COOKIE]: admin },
      payload: { decision: "approve" },
    });
    expect(dec.statusCode).toBe(400);
    expect(dec.json().error.code).toBe("validation_error");
  });

  it("decision on a well-formed but nonexistent id → 409 (guarded update matches no row)", async () => {
    const { app, db } = await buildTestApp();
    const admin = await makeAdmin(app, db, "a10@padm.co");
    const missing = "11111111-2222-4333-8444-555555555555";
    const dec = await app.inject({
      method: "POST",
      url: `/admin/projects/${missing}/decision`,
      cookies: { [COOKIE]: admin },
      payload: { decision: "approve", score: "A" },
    });
    expect(dec.statusCode).toBe(409);
  });

  it("open-collection on a non-showcase (submitted) project → 409", async () => {
    const { app, db } = await buildTestApp();
    const porteur = await makePorteur(app, db, "p11@padm.co");
    const id = await createSubmittedProject(app, porteur);
    const admin = await makeAdmin(app, db, "a11@padm.co");

    const open = await app.inject({
      method: "POST",
      url: `/admin/projects/${id}/open-collection`,
      cookies: { [COOKIE]: admin },
    });
    expect(open.statusCode).toBe(409);
    expect(open.json().error.code).toBe("invalid_state");
  });
});
