import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "../../../tests/helpers/db";
import { accounts, kycDocuments, kycSubmissions } from "../../db/schema";
import { MemoryStorage } from "../../lib/storage/memory";
import { createSubmission, getActiveSubmission, KycValidationError } from "./service";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function seedAccount(db: Parameters<Parameters<typeof withTestDb>[0]>[0]) {
  const [a] = await db
    .insert(accounts)
    .values({
      email: "k@a.co",
      passwordHash: "x",
      firstName: "K",
      lastName: "A",
      country: "Togo",
      roles: ["investor"],
      // Seed a non-pending status so the kyc_status mirror is actually observable.
      kycStatus: "rejected",
    })
    .returning();
  if (!a) throw new Error("account seed failed");
  return a;
}

describe("createSubmission", () => {
  it("creates a pending submission, stores files, mirrors kyc_status", async () => {
    await withTestDb(async (db) => {
      const storage = new MemoryStorage();
      const a = await seedAccount(db);

      const { submissionId } = await createSubmission(db, storage, {
        accountId: a.id,
        docType: "cni",
        docNumber: "TG-1",
        dob: "1990-01-01",
        nationality: "Togolaise",
        files: [
          { kind: "front", buffer: PNG, clientMime: "image/png" },
          { kind: "back", buffer: PNG, clientMime: "image/png" },
        ],
      });

      const [sub] = await db.select().from(kycSubmissions).where(eq(kycSubmissions.id, submissionId));
      expect(sub?.status).toBe("pending");
      expect(sub?.superseded).toBe(false);

      const docs = await db.select().from(kycDocuments).where(eq(kycDocuments.submissionId, submissionId));
      expect(docs).toHaveLength(2);

      // Storage keys are server-generated from account/submission ids, not client filenames.
      expect(storage.objects.size).toBe(2);
      expect(storage.objects.has(`kyc/${a.id}/${submissionId}/front.png`)).toBe(true);
      expect(storage.objects.has(`kyc/${a.id}/${submissionId}/back.png`)).toBe(true);
      // Sniffed mime, not clientMime, is stored.
      expect(docs.every((d) => d.mime === "image/png")).toBe(true);

      const [acc] = await db.select().from(accounts).where(eq(accounts.id, a.id));
      expect(acc?.kycStatus).toBe("pending");
    });
  });

  it("supersedes a prior active submission", async () => {
    await withTestDb(async (db) => {
      const storage = new MemoryStorage();
      const a = await seedAccount(db);
      const base = {
        accountId: a.id,
        docType: "cni" as const,
        docNumber: "TG-1",
        dob: "1990-01-01",
        nationality: "Togolaise",
        files: [
          { kind: "front" as const, buffer: PNG, clientMime: "image/png" },
          { kind: "back" as const, buffer: PNG, clientMime: "image/png" },
        ],
      };
      const first = await createSubmission(db, storage, base);
      const second = await createSubmission(db, storage, base);

      const [oldSub] = await db.select().from(kycSubmissions).where(eq(kycSubmissions.id, first.submissionId));
      expect(oldSub?.superseded).toBe(true);

      const active = await getActiveSubmission(db, a.id);
      expect(active?.id).toBe(second.submissionId);
    });
  });

  it("rejects wrong file count", async () => {
    await withTestDb(async (db) => {
      const storage = new MemoryStorage();
      const a = await seedAccount(db);
      await expect(
        createSubmission(db, storage, {
          accountId: a.id,
          docType: "cni",
          docNumber: "TG-1",
          dob: "1990-01-01",
          nationality: "Togolaise",
          files: [{ kind: "front", buffer: PNG, clientMime: "image/png" }],
        }),
      ).rejects.toBeInstanceOf(KycValidationError);
      // Nothing uploaded when validation fails first.
      expect(storage.objects.size).toBe(0);
    });
  });

  it("rejects a non-image buffer via magic bytes", async () => {
    await withTestDb(async (db) => {
      const storage = new MemoryStorage();
      const a = await seedAccount(db);
      const garbage = Buffer.from([0x00, 0x01, 0x02, 0x03]);
      // Correct file SET (front+back) so validation reaches the magic-byte check.
      await expect(
        createSubmission(db, storage, {
          accountId: a.id,
          docType: "cni",
          docNumber: "TG-1",
          dob: "1990-01-01",
          nationality: "Togolaise",
          files: [
            { kind: "front", buffer: garbage, clientMime: "image/png" },
            { kind: "back", buffer: garbage, clientMime: "image/png" },
          ],
        }),
      ).rejects.toBeInstanceOf(KycValidationError);
      expect(storage.objects.size).toBe(0);
    });
  });

  it("rejects a file exceeding maxBytes", async () => {
    await withTestDb(async (db) => {
      const storage = new MemoryStorage();
      const a = await seedAccount(db);
      await expect(
        createSubmission(db, storage, {
          accountId: a.id,
          docType: "cni",
          docNumber: "TG-1",
          dob: "1990-01-01",
          nationality: "Togolaise",
          files: [
            { kind: "front", buffer: PNG, clientMime: "image/png" },
            { kind: "back", buffer: PNG, clientMime: "image/png" },
          ],
          maxBytes: 4,
        }),
      ).rejects.toBeInstanceOf(KycValidationError);
    });
  });
});
