import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { buildTestApp, loginAs } from "./helpers/app";
import { accounts, projects, projectFollows, notificationPrefs } from "../src/db/schema";
import type { Db } from "../src/db/client";
import type { FastifyInstance } from "fastify";

const COOKIE = "kpital_sess";

async function makeAdmin(app: FastifyInstance, db: Db, email: string): Promise<string> {
  const cookie = await loginAs(app, email);
  await db.update(accounts).set({ isAdmin: true }).where(eq(accounts.email, email));
  return cookie;
}

// Register a follower, give it a phone number, and set its notification-pref
// channels. Returns the account id.
async function makeFollower(
  app: FastifyInstance,
  db: Db,
  email: string,
  phone: string,
  channels: string[],
): Promise<string> {
  await loginAs(app, email);
  const [acc] = await db
    .update(accounts)
    .set({ phone })
    .where(eq(accounts.email, email))
    .returning({ id: accounts.id });
  await db.insert(notificationPrefs).values({ accountId: acc!.id, channels });
  return acc!.id;
}

describe("open-collection notification prefs", () => {
  it("respects each follower's notification_pref channels", async () => {
    // Globally both channels are enabled; each follower's pref narrows it.
    const { app, db, sentMessages } = await buildTestApp({ env: { NOTIFY_CHANNELS: "email,sms" } });

    // Seed a showcase project directly (no porteur/upload flow needed here).
    const [owner] = await db
      .insert(accounts)
      .values({ email: "owner@notify.co", passwordHash: "x", firstName: "O", lastName: "A", country: "Togo", roles: ["porteur"] })
      .returning({ id: accounts.id });
    const [project] = await db
      .insert(projects)
      .values({
        ownerAccountId: owner!.id,
        category: "commerce",
        title: "Boutique",
        city: "Lomé",
        description: "d",
        targetMinor: 1_000_000,
        durationMonths: 6,
        roiPct: "16",
        fundsUsage: "u",
        cautionType: "a",
        status: "showcase",
      })
      .returning({ id: projects.id });
    const projectId = project!.id;

    // Both followers HAVE a phone, so the ONLY thing that can strip it from the
    // recipient is their pref: email-only vs email+sms.
    const emailOnly = await makeFollower(app, db, "emailonly@notify.co", "+22890000001", ["email"]);
    const bothChannels = await makeFollower(app, db, "both@notify.co", "+22890000002", ["email", "sms"]);
    await db.insert(projectFollows).values([
      { accountId: emailOnly, projectId },
      { accountId: bothChannels, projectId },
    ]);

    const admin = await makeAdmin(app, db, "admin@notify.co");
    const open = await app.inject({
      method: "POST",
      url: `/admin/projects/${projectId}/open-collection`,
      cookies: { [COOKIE]: admin },
    });
    expect(open.statusCode).toBe(200);

    const openMsgs = sentMessages.filter((m) => m.subject.includes("Collecte ouverte"));
    expect(openMsgs).toHaveLength(2);

    const emailOnlyMsg = openMsgs.find((m) => m.to.email === "emailonly@notify.co");
    const bothMsg = openMsgs.find((m) => m.to.email === "both@notify.co");
    expect(emailOnlyMsg).toBeDefined();
    expect(bothMsg).toBeDefined();

    // The email-only follower disabled sms: no phone must reach the notifier.
    expect(emailOnlyMsg!.to.phone).toBeUndefined();
    // The both-channels follower keeps their phone.
    expect(bothMsg!.to.phone).toBe("+22890000002");
  });
});
