import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, loginAs } from "./helpers/app";
import { accounts, projects } from "../src/db/schema";
import type { Db } from "../src/db/client";

// Seeds an owner account and returns its id. Emails are unique to this file:
// buildTestApp shares a single DB with no per-test rollback, so state persists
// across tests and across files.
async function seedOwner(db: Db, email: string): Promise<string> {
  const [owner] = await db
    .insert(accounts)
    .values({ email, passwordHash: "x", firstName: "O", lastName: "A", country: "Togo", roles: ["porteur"] })
    .returning();
  return owner!.id;
}

// Seeds one project directly at the given status and returns its id.
async function seedProject(db: Db, ownerAccountId: string, status: string): Promise<string> {
  const [p] = await db
    .insert(projects)
    .values({
      ownerAccountId,
      category: "commerce" as const,
      title: "S",
      city: "Lomé",
      description: "d",
      targetMinor: 1_000_000,
      durationMonths: 6,
      roiPct: "16",
      fundsUsage: "u",
      cautionType: "a",
      status: status as never,
    })
    .returning();
  return p!.id;
}

// upvoteCount from the public detail route.
async function detailUpvoteCount(app: FastifyInstance, projectId: string): Promise<number> {
  const det = await app.inject({ method: "GET", url: `/projects/${projectId}` });
  expect(det.statusCode).toBe(200);
  return det.json().project.upvoteCount as number;
}

describe("project engagement", () => {
  it("upvote is unique and idempotent and moves the counter", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedOwner(db, "eng-owner1@a.co");
    const pid = await seedProject(db, owner, "showcase");
    const cookie = await loginAs(app, "eng-a1@a.co");

    const first = await app.inject({ method: "POST", url: `/projects/${pid}/upvote`, cookies: { kpital_sess: cookie } });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: `/projects/${pid}/upvote`, cookies: { kpital_sess: cookie } });
    expect(second.statusCode).toBe(200); // idempotent

    const me = await app.inject({ method: "GET", url: `/projects/${pid}/me`, cookies: { kpital_sess: cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().upvoted).toBe(true);

    expect(await detailUpvoteCount(app, pid)).toBe(1); // not 2
  });

  it("removing an upvote moves the counter back to 0 and clears my-state", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedOwner(db, "eng-owner2@a.co");
    const pid = await seedProject(db, owner, "showcase");
    const cookie = await loginAs(app, "eng-a2@a.co");

    await app.inject({ method: "POST", url: `/projects/${pid}/upvote`, cookies: { kpital_sess: cookie } });
    expect(await detailUpvoteCount(app, pid)).toBe(1);

    const del = await app.inject({ method: "DELETE", url: `/projects/${pid}/upvote`, cookies: { kpital_sess: cookie } });
    expect(del.statusCode).toBe(200);
    // Idempotent delete: a second removal is still 200 and does not go negative.
    const del2 = await app.inject({ method: "DELETE", url: `/projects/${pid}/upvote`, cookies: { kpital_sess: cookie } });
    expect(del2.statusCode).toBe(200);

    expect(await detailUpvoteCount(app, pid)).toBe(0);
    const me = await app.inject({ method: "GET", url: `/projects/${pid}/me`, cookies: { kpital_sess: cookie } });
    expect(me.json().upvoted).toBe(false);
  });

  it("two different accounts upvoting yields a count of 2", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedOwner(db, "eng-owner3@a.co");
    const pid = await seedProject(db, owner, "showcase");
    const cookieA = await loginAs(app, "eng-a3@a.co");
    const cookieB = await loginAs(app, "eng-b3@a.co");

    const a = await app.inject({ method: "POST", url: `/projects/${pid}/upvote`, cookies: { kpital_sess: cookieA } });
    expect(a.statusCode).toBe(200);
    const b = await app.inject({ method: "POST", url: `/projects/${pid}/upvote`, cookies: { kpital_sess: cookieB } });
    expect(b.statusCode).toBe(200);

    expect(await detailUpvoteCount(app, pid)).toBe(2);
  });

  it("upvoting a collecting project is rejected with 409 invalid_state", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedOwner(db, "eng-owner4@a.co");
    const pid = await seedProject(db, owner, "collecting");
    const cookie = await loginAs(app, "eng-a4@a.co");

    const res = await app.inject({ method: "POST", url: `/projects/${pid}/upvote`, cookies: { kpital_sess: cookie } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("invalid_state");
  });

  it("following a collecting project is allowed and moves followCount", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedOwner(db, "eng-owner5@a.co");
    const pid = await seedProject(db, owner, "collecting");
    const cookie = await loginAs(app, "eng-a5@a.co");

    const first = await app.inject({ method: "POST", url: `/projects/${pid}/follow`, cookies: { kpital_sess: cookie } });
    expect(first.statusCode).toBe(200);
    // Idempotent: repeated follow does not double the counter.
    const second = await app.inject({ method: "POST", url: `/projects/${pid}/follow`, cookies: { kpital_sess: cookie } });
    expect(second.statusCode).toBe(200);

    const me = await app.inject({ method: "GET", url: `/projects/${pid}/me`, cookies: { kpital_sess: cookie } });
    expect(me.json().following).toBe(true);

    const det = await app.inject({ method: "GET", url: `/projects/${pid}` });
    expect(det.json().project.followCount).toBe(1);
  });

  it("unfollowing moves followCount back to 0 and stays idempotent", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedOwner(db, "eng-owner7@a.co");
    const pid = await seedProject(db, owner, "showcase");
    const cookie = await loginAs(app, "eng-a7@a.co");

    const follow = await app.inject({ method: "POST", url: `/projects/${pid}/follow`, cookies: { kpital_sess: cookie } });
    expect(follow.statusCode).toBe(200);

    const det1 = await app.inject({ method: "GET", url: `/projects/${pid}` });
    expect(det1.json().project.followCount).toBe(1);
    const me1 = await app.inject({ method: "GET", url: `/projects/${pid}/me`, cookies: { kpital_sess: cookie } });
    expect(me1.json().following).toBe(true);

    const del = await app.inject({ method: "DELETE", url: `/projects/${pid}/follow`, cookies: { kpital_sess: cookie } });
    expect(del.statusCode).toBe(200);

    const det2 = await app.inject({ method: "GET", url: `/projects/${pid}` });
    expect(det2.json().project.followCount).toBe(0);
    const me2 = await app.inject({ method: "GET", url: `/projects/${pid}/me`, cookies: { kpital_sess: cookie } });
    expect(me2.json().following).toBe(false);

    // Idempotent: a second unfollow is still 200 and does not go below zero.
    const del2 = await app.inject({ method: "DELETE", url: `/projects/${pid}/follow`, cookies: { kpital_sess: cookie } });
    expect(del2.statusCode).toBe(200);
    const det3 = await app.inject({ method: "GET", url: `/projects/${pid}` });
    expect(det3.json().project.followCount).toBe(0);
  });

  it("requires authentication", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedOwner(db, "eng-owner6@a.co");
    const pid = await seedProject(db, owner, "showcase");

    const res = await app.inject({ method: "POST", url: `/projects/${pid}/upvote` });
    expect(res.statusCode).toBe(401);
  });
});
