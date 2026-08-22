import { describe, it, expect } from "vitest";
import { buildTestApp } from "./helpers/app";
import { accounts, projects } from "../src/db/schema";

describe("investment progress", () => {
  it("funding surface and detail expose raisedMinor", async () => {
    const { app, db } = await buildTestApp();
    const [owner] = await db
      .insert(accounts)
      .values({
        email: "o@a.co",
        passwordHash: "x",
        firstName: "O",
        lastName: "A",
        country: "Togo",
        roles: ["porteur"],
      })
      .returning();
    const [p] = await db
      .insert(projects)
      .values({
        ownerAccountId: owner!.id,
        category: "commerce",
        title: "P",
        city: "L",
        description: "d",
        targetMinor: 1000000,
        durationMonths: 6,
        roiPct: "16",
        fundsUsage: "u",
        cautionType: "a",
        status: "collecting",
        raisedMinor: 250000,
      })
      .returning();

    const fu = await app.inject({ method: "GET", url: "/projects/funding" });
    const card = fu.json().projects.find((x: { id: string }) => x.id === p!.id);
    expect(card.raisedMinor).toBe(250000);
    expect(card).not.toHaveProperty("upvoteCount");
    expect(card).not.toHaveProperty("followCount");

    const det = await app.inject({ method: "GET", url: `/projects/${p!.id}` });
    expect(det.json().project.raisedMinor).toBe(250000);
  });
});
