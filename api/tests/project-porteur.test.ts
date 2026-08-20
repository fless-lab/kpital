import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { buildTestApp, loginAs } from "./helpers/app";
import { accounts } from "../src/db/schema";
import type { Db } from "../src/db/client";
import type { FastifyInstance } from "fastify";

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

describe("porteur projects", () => {
  it("porteur creates a draft, submits, and sees it in /projects/mine", async () => {
    const { app, db } = await buildTestApp();
    const cookie = await makePorteur(app, db, "p@a.co");

    const c = await app.inject({ method: "POST", url: "/projects", cookies: { kpital_sess: cookie }, payload: body });
    expect(c.statusCode).toBe(201);
    const id = c.json().id as string;
    expect(typeof id).toBe("string");

    const s = await app.inject({ method: "POST", url: `/projects/${id}/submit`, cookies: { kpital_sess: cookie } });
    expect(s.statusCode).toBe(200);

    const mine = await app.inject({ method: "GET", url: "/projects/mine", cookies: { kpital_sess: cookie } });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().projects[0].status).toBe("submitted");
  });

  it("a non-porteur cannot create", async () => {
    const { app } = await buildTestApp();
    const cookie = await loginAs(app, "i@a.co"); // default role ["investor"]
    const c = await app.inject({ method: "POST", url: "/projects", cookies: { kpital_sess: cookie }, payload: body });
    expect(c.statusCode).toBe(403);
    expect(c.json().error.code).toBe("forbidden");
  });

  it("editing after submit is rejected with 409 invalid_state", async () => {
    const { app, db } = await buildTestApp();
    const cookie = await makePorteur(app, db, "p@a.co");

    const c = await app.inject({ method: "POST", url: "/projects", cookies: { kpital_sess: cookie }, payload: body });
    expect(c.statusCode).toBe(201);
    const id = c.json().id as string;

    const s = await app.inject({ method: "POST", url: `/projects/${id}/submit`, cookies: { kpital_sess: cookie } });
    expect(s.statusCode).toBe(200);

    const edit = await app.inject({
      method: "PATCH",
      url: `/projects/${id}`,
      cookies: { kpital_sess: cookie },
      payload: { title: "New title" },
    });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error.code).toBe("invalid_state");
  });

  it("a porteur cannot edit another porteur's project (403 forbidden)", async () => {
    const { app, db } = await buildTestApp();
    const ownerCookie = await makePorteur(app, db, "owner@a.co");
    const otherCookie = await makePorteur(app, db, "other@a.co");

    const c = await app.inject({
      method: "POST",
      url: "/projects",
      cookies: { kpital_sess: ownerCookie },
      payload: body,
    });
    expect(c.statusCode).toBe(201);
    const id = c.json().id as string;

    const edit = await app.inject({
      method: "PATCH",
      url: `/projects/${id}`,
      cookies: { kpital_sess: otherCookie },
      payload: { title: "Hijacked" },
    });
    expect(edit.statusCode).toBe(403);
    expect(edit.json().error.code).toBe("forbidden");
  });
});
