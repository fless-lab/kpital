// Dev seed script for the frontend catalog/invest work (Lot 2).
//
// Why direct DB insert instead of the HTTP porteur -> admin-approve flow the
// brief originally sketched: there is no public HTTP path to mint an admin
// account, so scripting register -> submit -> admin-approve over HTTP is not
// feasible from outside the DB. Instead this script inserts directly with the
// `pg` client, using the exact non-null columns from api/src/db/schema.ts
// (account, project). This is dev-only tooling, never shipped in `_site`.
//
// Idempotency: every run first deletes prior seed rows by a fixed marker
// (title prefix "KPITAL_SEED::"), owned by a fixed seed account email, then
// inserts fresh rows. Safe to re-run any number of times, including after a
// later task has invested against COLLECTING_ID or posted repayments against
// either seed project: investment, repayment_payment and repayment_installment
// all FK to project.id WITHOUT ON DELETE CASCADE (and repayment_distribution /
// repayment_application FK to those without cascade either), so the cleanup
// deletes that whole non-cascading subtree, scoped to the seed project ids,
// before deleting the projects themselves. project_document, project_follow
// and project_upvote DO cascade on project_id, so they need no explicit delete.
//
// Usage: node api/scripts/seed-projects.mjs
// Reads DATABASE_URL from the environment, falling back to the dev default
// used in api/.env.

import pg from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://kpital:kpital@127.0.0.1:5544/kpital";

const SEED_EMAIL = "seed-porteur@kpital.dev";
const SEED_TITLE_PREFIX = "KPITAL_SEED::";

// Not a real argon2 hash (this account is never logged into) but shaped like
// one so nothing downstream chokes on an obviously-wrong format.
const PLACEHOLDER_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=3,p=4$c2VlZC1zYWx0LXZhbHVl$c2VlZC1wbGFjZWhvbGRlci1oYXNoLXZhbHVlLW5vdC1yZWFs";

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    await client.query("BEGIN");

    // Clean up any prior seed rows. Find the seed project ids first so every
    // downstream delete can be scoped to them, then walk the non-cascading FK
    // subtree leaf-first: repayment_distribution (references investment,
    // repayment_installment and repayment_application) before
    // repayment_application (references repayment_payment) before the direct
    // non-cascading children of project (investment, repayment_installment,
    // repayment_payment) before project itself. project.owner_account_id has
    // no cascade either, so the account is deleted last.
    const priorIdsRes = await client.query(
      `SELECT id FROM project WHERE title LIKE $1`,
      [`${SEED_TITLE_PREFIX}%`],
    );
    const priorProjectIds = priorIdsRes.rows.map((r) => r.id);

    if (priorProjectIds.length > 0) {
      await client.query(
        `DELETE FROM repayment_distribution
         WHERE investment_id IN (SELECT id FROM investment WHERE project_id = ANY($1::uuid[]))
            OR installment_id IN (SELECT id FROM repayment_installment WHERE project_id = ANY($1::uuid[]))
            OR application_id IN (
                 SELECT id FROM repayment_application
                 WHERE payment_id IN (SELECT id FROM repayment_payment WHERE project_id = ANY($1::uuid[]))
               )`,
        [priorProjectIds],
      );
      await client.query(
        `DELETE FROM repayment_application
         WHERE payment_id IN (SELECT id FROM repayment_payment WHERE project_id = ANY($1::uuid[]))`,
        [priorProjectIds],
      );
      await client.query(
        `DELETE FROM repayment_installment WHERE project_id = ANY($1::uuid[])`,
        [priorProjectIds],
      );
      await client.query(
        `DELETE FROM repayment_payment WHERE project_id = ANY($1::uuid[])`,
        [priorProjectIds],
      );
      await client.query(
        `DELETE FROM investment WHERE project_id = ANY($1::uuid[])`,
        [priorProjectIds],
      );
      await client.query(`DELETE FROM project WHERE id = ANY($1::uuid[])`, [priorProjectIds]);
    }
    await client.query(`DELETE FROM account WHERE email = $1`, [SEED_EMAIL]);

    // 1. Owner account (role: porteur).
    const ownerRes = await client.query(
      `INSERT INTO account
         (email, phone, password_hash, first_name, last_name, country, roles, kyc_status, status, is_admin)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        SEED_EMAIL,
        "+22890000001",
        PLACEHOLDER_PASSWORD_HASH,
        "Seed",
        "Porteur",
        "TG",
        ["porteur"],
        "verified",
        "active",
        false,
      ],
    );
    const ownerId = ownerRes.rows[0].id;

    // 2. Showcase project (status = showcase, not currently collecting funds).
    const showcaseRes = await client.query(
      `INSERT INTO project
         (owner_account_id, category, title, city, quartier, description,
          target_minor, duration_months, roi_pct, funds_usage, caution_type,
          status, score, published_at, raised_minor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), $14)
       RETURNING id`,
      [
        ownerId,
        "immobilier",
        `${SEED_TITLE_PREFIX}Renovation d'un immeuble locatif a Lome`,
        "Lome",
        "Adidogome",
        "Renovation complete d'un immeuble de 6 logements locatifs dans le quartier d'Adidogome, avec mise aux normes electriques et plomberie.",
        45_000_000,
        18,
        "12.5",
        "Materiaux de construction, main d'oeuvre qualifiee, mise aux normes electriques et plomberie.",
        "Hypotheque de premier rang sur le bien immobilier renove.",
        "showcase",
        "A",
        0,
      ],
    );
    const showcaseId = showcaseRes.rows[0].id;

    // 3. Collecting project (status = collecting, raised ~65% of target).
    const targetMinor = 30_000_000;
    const raisedMinor = Math.round(targetMinor * 0.65);
    const collectingRes = await client.query(
      `INSERT INTO project
         (owner_account_id, category, title, city, quartier, description,
          target_minor, duration_months, roi_pct, funds_usage, caution_type,
          status, score, published_at, collecting_opened_at, raised_minor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), now(), $14)
       RETURNING id`,
      [
        ownerId,
        "commerce",
        `${SEED_TITLE_PREFIX}Extension d'une boutique de gros a Kara`,
        "Kara",
        "Tomdome",
        "Extension d'un entrepot de vente en gros de produits alimentaires, achat de stock et amenagement d'un espace de stockage refrigere.",
        targetMinor,
        12,
        "9.8",
        "Achat de stock initial, amenagement d'un espace de stockage refrigere, recrutement de deux employes.",
        "Nantissement du stock et caution personnelle du porteur.",
        "collecting",
        "B",
        raisedMinor,
      ],
    );
    const collectingId = collectingRes.rows[0].id;

    await client.query("COMMIT");

    console.log(`SHOWCASE_ID=${showcaseId}`);
    console.log(`COLLECTING_ID=${collectingId}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
