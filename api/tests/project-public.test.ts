import { describe, it, expect } from "vitest";
import { buildTestApp } from "./helpers/app";
import { accounts, projects, projectDocuments } from "../src/db/schema";
import type { Db } from "../src/db/client";

// Seeds an owner account and returns its id. Public routes must never expose it.
async function seedOwner(db: Db, email: string): Promise<string> {
  const [owner] = await db
    .insert(accounts)
    .values({
      email,
      passwordHash: "x",
      firstName: "O",
      lastName: "A",
      country: "Togo",
      roles: ["porteur"],
    })
    .returning();
  return owner!.id;
}

// Minimal valid project payload, seeded directly at an arbitrary status.
function projectValues(ownerAccountId: string, status: string, overrides: Record<string, unknown> = {}) {
  return {
    ownerAccountId,
    category: "commerce" as const,
    title: "P",
    city: "Lomé",
    description: "d",
    targetMinor: 1_000_000,
    durationMonths: 6,
    roiPct: "16",
    fundsUsage: "u",
    cautionType: "a",
    status: status as never,
    ...overrides,
  };
}

describe("project public surfaces", () => {
  it("showcase and funding surfaces are mutually exclusive", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedOwner(db, "o@a.co");
    const [showP] = await db
      .insert(projects)
      .values(projectValues(owner, "showcase"))
      .returning();
    const [fundP] = await db
      .insert(projects)
      .values(projectValues(owner, "collecting", { category: "immobilier", roiPct: "12" }))
      .returning();

    const sc = await app.inject({ method: "GET", url: "/projects/showcase" });
    expect(sc.statusCode).toBe(200);
    expect(sc.json().projects.map((p: { id: string }) => p.id)).toEqual([showP!.id]);

    const fu = await app.inject({ method: "GET", url: "/projects/funding" });
    expect(fu.statusCode).toBe(200);
    expect(fu.json().projects.map((p: { id: string }) => p.id)).toEqual([fundP!.id]);
  });

  it("detail of a public project never exposes owner PII", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedOwner(db, "o2@a.co");
    const [showP] = await db.insert(projects).values(projectValues(owner, "showcase")).returning();

    const det = await app.inject({ method: "GET", url: `/projects/${showP!.id}` });
    expect(det.statusCode).toBe(200);
    const project = det.json().project;
    expect(project.id).toBe(showP!.id);
    expect(project).not.toHaveProperty("ownerAccountId");
    expect(project).not.toHaveProperty("reviewedBy");
    expect(project).not.toHaveProperty("rejectReason");
    // The enumerated public fields ARE present.
    expect(project).toHaveProperty("status", "showcase");
    expect(project).toHaveProperty("upvoteCount", 0);
    expect(project).toHaveProperty("followCount", 0);
  });

  it("a draft project is not visible on any public route (detail → 404)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedOwner(db, "o3@a.co");
    const [draftP] = await db.insert(projects).values(projectValues(owner, "draft")).returning();

    const det = await app.inject({ method: "GET", url: `/projects/${draftP!.id}` });
    expect(det.statusCode).toBe(404);
    expect(det.json().error.code).toBe("not_found");

    const sc = await app.inject({ method: "GET", url: "/projects/showcase" });
    expect(sc.json().projects.map((p: { id: string }) => p.id)).not.toContain(draftP!.id);
    const fu = await app.inject({ method: "GET", url: "/projects/funding" });
    expect(fu.json().projects.map((p: { id: string }) => p.id)).not.toContain(draftP!.id);
  });

  it("detail returns public (photo) documents only, never private legal docs, never raw keys", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedOwner(db, "o4@a.co");
    const [showP] = await db.insert(projects).values(projectValues(owner, "showcase")).returning();

    // A public photo and a private rccm doc, seeded directly (the upload route
    // only accepts draft|rejected, but detail requires a public status).
    const [photo] = await db
      .insert(projectDocuments)
      .values({
        projectId: showP!.id,
        kind: "photo",
        visibility: "public",
        storageKey: `projects/${showP!.id}/photo.png`,
        mime: "image/png",
        sizeBytes: 10,
      })
      .returning();
    await db.insert(projectDocuments).values({
      projectId: showP!.id,
      kind: "rccm",
      visibility: "private",
      storageKey: `projects/${showP!.id}/rccm.png`,
      mime: "image/png",
      sizeBytes: 20,
    });

    const det = await app.inject({ method: "GET", url: `/projects/${showP!.id}` });
    expect(det.statusCode).toBe(200);
    const docs = det.json().documents as Array<Record<string, unknown>>;
    expect(docs).toHaveLength(1);
    expect(docs[0]!.id).toBe(photo!.id);
    expect(docs[0]!.kind).toBe("photo");
    // A short-lived signed URL, never the raw storage key.
    expect(docs[0]!.url).toContain("signed");
    expect(docs[0]).not.toHaveProperty("storageKey");
    expect(docs.map((d) => d.kind)).not.toContain("rccm");
  });
});
