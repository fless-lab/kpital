# KPITAL Backend, sous-système 2 : KYC (pièces d'identité, stockage, revue)

> Document de conception (spec). Statut : brouillon à relire.
> Date : 2026-08-20. Se greffe sur la Fondation (sous-système 1, mergée dans `main`).

---

## 1. Objectif et périmètre

Permettre à un compte de soumettre ses pièces d'identité, les stocker de façon sécurisée, et laisser un admin les vérifier manuellement pour faire passer `account.kyc_status` de `pending` à `verified` ou `rejected`.

**Dans le périmètre :**
- Upload multipart des pièces (métadonnées + fichiers) via un endpoint authentifié, appelé par le wizard d'inscription juste après la création du compte.
- Stockage des fichiers dans **MinIO (S3-compatible)**, bucket privé, chiffré au repos, derrière une interface `StorageProvider`.
- Modèle `kyc_submission` + `kyc_document` ; `account.kyc_status` reflète la soumission active.
- Back-office admin : file d'attente, détail avec **URLs signées à TTL court** pour visionner les pièces, décision (approuver / rejeter avec motif).
- Contrôle d'accès strict (propriétaire ou admin), audit des accès aux pièces, validations serveur (nombre de fichiers, type MIME par magic-bytes, taille).
- Interface `KycVerifier` avec une implémentation `ManualVerifier` (l'admin décide).

**Hors périmètre (référencé) :**
- Prestataire KYC automatique (OCR/liveness/sanctions) : l'interface `KycVerifier` est prête, l'implémentation viendra plus tard.
- Gating d'investissement selon `kyc_status` : sous-système #4.
- Scan antivirus des fichiers : noté, non implémenté (accroche possible via `StorageProvider`/pipeline).
- Rétention/suppression automatique programmée : politique documentée, non automatisée.

---

## 2. Décisions (issues du cadrage)

| Décision | Choix |
|---|---|
| Stockage des fichiers | **MinIO / S3-compatible**, conteneur dédié `kpital-minio`, bucket privé |
| Abstraction | Interface `StorageProvider` (impl `MinioStorage` + fake mémoire pour tests) |
| Vérification | **Revue manuelle admin**, derrière l'interface `KycVerifier` (impl `ManualVerifier`) |
| Timing | Endpoint authentifié séparé, appelé après `register` (register reste JSON) |
| Resoumission | Une nouvelle soumission remplace la précédente `pending`/`rejected` |

---

## 3. Architecture

```
Front (wizard inscription) ──register(JSON)──▶ compte créé (kyc_status=pending)
        │
        └── POST /kyc/submission (multipart, session cookie)
                 │  valide (count/MIME/size) → stream fichiers → MinIO (privé, SSE)
                 ▼
        kyc_submission (pending) + kyc_document[]   ── account.kyc_status=pending
        │
Admin ──GET /admin/kyc?status=pending──▶ file d'attente
      ──GET /admin/kyc/:id──▶ détail + URLs signées (TTL court) pour visionner
      ──POST /admin/kyc/:id/decision──▶ verified|rejected(+motif)
                 │
                 ▼  met à jour submission (reviewed_by/at) + account.kyc_status (miroir)
```

Nouveaux modules (dans `api/`, patron de la Fondation) :
- `src/lib/storage/` : interface `StorageProvider` + `MinioStorage` + fake.
- `src/lib/kyc/` : interface `KycVerifier` + `ManualVerifier`.
- `src/modules/kyc/` : service (submission + décision) + routes utilisateur (`/kyc/*`) et admin (`/admin/kyc/*`).
- `src/db/schema.ts` : tables `kyc_submission`, `kyc_document` (+ migration).

---

## 4. Infra (docker-compose)

Ajouter un service **`kpital-minio`** (image `minio/minio`), ports hôte **9100→9000** (API S3) et **9101→9001** (console), volume dédié, `restart: unless-stopped`, identifiants root via variables. Un init crée le bucket privé **`kpital-kyc`** (job `mc` ou création à la première écriture par l'appli si absent). Ne réutilise PAS les conteneurs MinIO d'autres projets.

Nouvelles variables d'env (validées dans `config/env.ts`) :
```
MINIO_ENDPOINT=http://127.0.0.1:9100
MINIO_ACCESS_KEY=kpital
MINIO_SECRET_KEY=kpital-secret
MINIO_BUCKET=kpital-kyc
MINIO_REGION=us-east-1
KYC_URL_TTL_SECONDS=120        # TTL des URLs signées de visionnage
KYC_MAX_FILE_MB=10
```

---

## 5. Interface StorageProvider

```
interface StorageProvider {
  put(key: string, body: Buffer|Readable, contentType: string): Promise<void>
  getSignedUrl(key: string, ttlSeconds: number): Promise<string>   // GET signé, expirant
  delete(key: string): Promise<void>
}
```
- `MinioStorage` : SDK S3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, ou le SDK `minio`). Bucket privé, SSE-S3 activé. Clés : `kyc/{accountId}/{submissionId}/{kind}.{ext}` (nos clés, jamais le nom de fichier client).
- Fake mémoire pour les tests (Map clé→bytes ; `getSignedUrl` renvoie une URL factice déterministe).
- Le provider concret est choisi par une factory selon la config (comme `PaymentProvider`/`Notifier`).

---

## 6. Modèle de données

**kyc_submission**
- `id` uuid pk
- `account_id` uuid fk → account
- `doc_type` enum : `cni` | `passeport` | `sejour`
- `doc_number` text
- `dob` date
- `nationality` text
- `status` enum `kyc_sub_status` : `pending` | `verified` | `rejected`, défaut `pending`
- `reject_reason` text null
- `reviewed_by` uuid null (fk → account admin)
- `reviewed_at` timestamptz null
- `created_at` timestamptz défaut now()

**kyc_document**
- `id` uuid pk
- `submission_id` uuid fk → kyc_submission (on delete cascade)
- `kind` enum `kyc_doc_kind` : `front` | `back` | `passport_page`
- `storage_key` text (clé objet MinIO)
- `mime` text
- `size_bytes` bigint
- `created_at` timestamptz défaut now()

`account.kyc_status` (déjà existant) reste la source de vérité au niveau compte ; il est mis à jour à la création d'une soumission (`pending`) et à la décision admin (`verified`/`rejected`).

Contraintes attendues (fichiers par type) : `passeport` → exactement 1 doc `passport_page` ; `cni`/`sejour` → exactement 2 docs `front` + `back`.

---

## 7. Endpoints

**Utilisateur (auth via session)**
- `POST /kyc/submission` (multipart/form-data) : champs `doc_type`, `doc_number`, `dob`, `nationality` + fichiers selon le type. Le serveur :
  1. valide les métadonnées (enum, formats) et le **nombre de fichiers** attendu par `doc_type` ;
  2. pour chaque fichier : vérifie le **type MIME par magic-bytes** (jpg/png/pdf), la **taille** ≤ `KYC_MAX_FILE_MB` ; rejette sinon `400 validation_error` ;
  3. crée `kyc_submission` (pending) puis streame chaque fichier vers MinIO et insère `kyc_document` ;
  4. passe `account.kyc_status=pending` ; une soumission antérieure `pending`/`rejected` est marquée superseded (ou simplement remplacée comme « active = la plus récente ») ;
  5. répond `201 { submissionId, status: "pending" }`.
- `GET /kyc/me` (auth) : la soumission active du caller + statut (et, optionnellement, des URLs signées vers SES propres pièces). Jamais les pièces d'autrui.

**Admin (`requireAuth` + `requireAdmin`)**
- `GET /admin/kyc?status=pending` : file d'attente paginée (métadonnées, pas les fichiers).
- `GET /admin/kyc/:id` : détail d'une soumission + pour chaque document une **URL signée** (`getSignedUrl`, TTL `KYC_URL_TTL_SECONDS`). L'accès est **audité** (log applicatif : quel admin a consulté quelle soumission, horodatage).
- `POST /admin/kyc/:id/decision` : body `{ decision: "verified" | "rejected", reason? }`. Met à jour la soumission (`status`, `reviewed_by`, `reviewed_at`, `reject_reason`) et **le miroir `account.kyc_status`**, dans une transaction. `rejected` exige un `reason`.

Enveloppe d'erreur uniforme `{ error: { code, message } }`. Nouveaux codes : `validation_error` (déjà), `not_found`, `forbidden` (déjà).

---

## 8. Sécurité

- Bucket **privé**, aucune URL publique. Visionnage uniquement via **URL signée à TTL court**, délivrée seulement au **propriétaire** (ses propres pièces) ou à un **admin**.
- **Chiffrement au repos** (SSE-S3 MinIO).
- **Validation MIME par magic-bytes** (ne pas se fier à l'extension ni au Content-Type client) ; extensions autorisées jpg/png/pdf ; taille plafonnée ; limite multipart (nombre de fichiers, taille par fichier) au niveau `@fastify/multipart`.
- Nos propres **clés de stockage** (jamais le nom de fichier client, qui pourrait contenir des chemins).
- **Aucun contenu de pièce loggé** ; les accès admin aux pièces sont **audités**.
- Le `doc_number`, `dob`, `nationality` sont des PII : accès restreint (propriétaire/admin), non renvoyés dans des listes publiques.
- Rétention : documenter que les pièces d'un compte fermé/rejeté devraient être purgées après un délai légal (non automatisé ici ; accroche via `StorageProvider.delete`).

---

## 9. Interface KycVerifier

```
interface KycVerifier {
  // Foundation: no-op manual flow (admin decides). Future: automated provider.
  submitForReview(submission): Promise<void>
}
```
`ManualVerifier.submitForReview` ne fait rien (la soumission attend la décision humaine). L'interface existe pour brancher un prestataire automatique plus tard sans toucher les routes.

---

## 10. Tests

- **Fake `StorageProvider`** (mémoire) injecté dans `buildTestApp` — aucun vrai MinIO en test unitaire/intégration.
- Multipart via `app.inject({ payload: form })` (ou un helper form-data).
- Cas : submission valide (cni 2 fichiers / passeport 1 fichier) → 201 + `kyc_status=pending` + docs en base + objets « stockés » dans le fake ; mauvais **nombre de fichiers** → 400 ; **mauvais MIME** (magic-bytes) → 400 ; **trop gros** → 400 ; décision admin `verified`/`rejected` → miroir `kyc_status` + `reviewed_by/at` (+ `reason` requis si rejet) ; **contrôle d'accès** : non-admin sur `/admin/kyc*` → 403, `GET /kyc/me` ne renvoie que ses pièces ; resoumission remplace l'active.

---

## 11. Questions ouvertes / défauts

1. **Init du bucket** : job `mc` dans le compose vs création paresseuse par l'appli au boot si le bucket manque. Défaut : création paresseuse par `MinioStorage` (plus simple, pas de conteneur d'init en plus).
2. **URLs signées pour l'utilisateur** dans `GET /kyc/me` : incluses ou pas. Défaut : oui, seulement vers ses propres pièces, même TTL court.
3. **Superseded vs supprimé** : garder l'historique des soumissions (superseded) plutôt que supprimer. Défaut : garder l'historique ; « active = la plus récente non superseded ».
