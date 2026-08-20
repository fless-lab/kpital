# KPITAL Backend, sous-système 3 : Projets + Vitrine

> Document de conception (spec). Statut : brouillon à relire.
> Date : 2026-08-20. Se greffe sur la Fondation + KYC (mergés dans `main`).

---

## 1. Objectif et périmètre

Gérer le cycle de vie d'un projet à financer : soumission par le porteur (avec pièces), modération + notation A-D par l'admin, puis exposition publique sur **deux surfaces mutuellement exclusives** — la **Vitrine** (découverte façon Product Hunt : follow / upvote / « prévenez-moi ») en phase pré-collecte, et le **Catalogue de financement** (investir) une fois la collecte ouverte. L'investissement réel est le sous-système #4.

**Dans le périmètre :**
- Soumission porteur (rôle porteur requis) : métadonnées + pièces (RCCM/foncier/relevés = privés ; photos = publiques), brouillon éditable, soumission pour revue.
- Modération admin : file d'attente, consultation des pièces privées (URLs signées + audit), décision approuver (+ note A-D) / rejeter (+ motif), ouverture de collecte.
- Machine à états et deux surfaces publiques distinctes (Vitrine `showcase`, Catalogue `collecting`), jamais mélangées.
- Engagement authentifié sur la Vitrine : follow (= « prévenez-moi à l'ouverture »), upvote (unique par compte).
- Notification des followers à l'ouverture de la collecte (via le notifier existant).

**Hors périmètre (référencé) :**
- Investissement réel / panneau « investir » : sous-système #4 (la phase `collecting` existe, l'action d'investir est #4).
- Commentaires (+ modération anti-abus) : différé.
- Moteur de scoring automatique : la note est posée manuellement par l'admin ; un hook d'interface est prévu.
- Remboursement / clôture financière (états `funded/repaying/closed`) : le champ d'état existe, le pilotage financier est #5.

---

## 2. Décisions (issues du cadrage)

| Décision | Choix |
|---|---|
| Vitrine vs financement | **Même objet `project`, deux surfaces mutuellement exclusives** par état (showcase / collecting), jamais mélangées |
| Gate vitrine | Public **seulement après modération admin** (rien de non-vetté n'est public) |
| Scoring A-D | **Manuel admin** à la modération (hook d'interface pour un moteur auto plus tard) |
| Engagement | **Authentifié seulement** (anti-gaming) ; follow = notify-me (fusionnés) ; upvote unique par compte |
| Garde-fou | Upvotes/follows = signal d'**engagement**, jamais de qualité d'investissement ; on ne classe jamais le financement par votes |
| Pièces | Photos **publiques** (via URL signée, bucket privé) ; RCCM/foncier/relevés **privés admin-only** |
| Stockage | Réutilise le `StorageProvider`/MinIO du KYC (même bucket, préfixe de clé `projects/{projectId}/…`) |

---

## 3. Machine à états

```
draft ──submit──▶ submitted ──(admin prend en revue)──▶ in_review
                                   │
                     ┌─────────────┴─────────────┐
                 rejected(motif)             showcase  ◀── VITRINE (public: follow/upvote/notify)
                     │ (porteur peut corriger)      │
                     └──resubmit──▶ submitted   (admin ouvre la collecte)
                                                     ▼
                                               collecting  ◀── CATALOGUE FINANCEMENT (public: investir #4)
                                                     ▼
                                    funded ──▶ repaying ──▶ closed   (piloté par #4/#5)
```

**Visibilité publique** : un projet apparaît publiquement à partir de `showcase`. Surfaces :
- **Vitrine** = projets en `showcase` uniquement.
- **Catalogue financement** = projets en `collecting` uniquement.
- `funded/repaying/closed` = historique (accessibles en fiche détail ; liste « réalisés » optionnelle, hors #3).
- `draft/submitted/in_review/rejected` = visibles seulement par le porteur (le sien) et l'admin.

Un projet n'est jamais sur les deux surfaces à la fois.

---

## 4. Modèle de données

**project**
- `id` uuid pk
- `owner_account_id` uuid fk → account
- `category` enum `project_category` : `immobilier` | `commerce` | `agriculture`
- `title` text, `city` text, `quartier` text null
- `description` text
- `target_minor` bigint (montant cible en plus petite unité)
- `duration_months` int
- `roi_pct` numeric (ROI proposé, %)
- `funds_usage` text (usage des fonds / tranches en clair)
- `caution_type` text
- `status` enum `project_status` : `draft|submitted|in_review|rejected|showcase|collecting|funded|repaying|closed`, défaut `draft`
- `score` enum `project_score` : `A|B|C|D`, null jusqu'à notation
- `reject_reason` text null
- `reviewed_by` uuid null fk → account, `reviewed_at` timestamptz null
- `published_at` timestamptz null (passage en showcase), `collecting_opened_at` timestamptz null
- `upvote_count` int défaut 0 (dénormalisé, maj à l'upvote/retrait), `follow_count` int défaut 0
- `created_at`/`updated_at` timestamptz

**project_document**
- `id` uuid pk, `project_id` fk (on delete cascade)
- `kind` enum `project_doc_kind` : `rccm` | `foncier` | `releves` | `photo`
- `visibility` enum `project_doc_visibility` : `public` | `private`
- `storage_key` text, `mime` text, `size_bytes` bigint, `created_at` timestamptz
- Règle : `photo` → public ; `rccm|foncier|releves` → private. Pièces privées jamais exposées en public.

**project_follow** : (`account_id`, `project_id`) pk composite (unique). Un follow = suivi + notification à l'ouverture.
**project_upvote** : (`account_id`, `project_id`) pk composite (unique).

---

## 5. Endpoints

**Porteur (auth ; rôle `porteur` requis, sinon 403)**
- `POST /projects` : crée un `draft` (métadonnées). Propriétaire = session.
- `PATCH /projects/:id` : édite (uniquement si `draft` ou `rejected`, et propriétaire).
- `POST /projects/:id/documents` (multipart) : ajoute une pièce (kind + fichier). Validation MIME magic-bytes + taille (réutilise la logique KYC). `visibility` déduite du `kind`. Clé serveur `projects/{projectId}/{docId}.{ext}`.
- `POST /projects/:id/submit` : `draft|rejected` → `submitted`.
- `GET /projects/mine` : mes projets (tous états).

**Public (pas d'auth requise)**
- `GET /projects/showcase` : liste des projets en `showcase` (Vitrine). Champs publics + `upvote_count`/`follow_count`, filtres (catégorie, score), tri (récents / plus suivis). **Ne mélange pas** avec le financement.
- `GET /projects/funding` : liste des projets en `collecting` (Catalogue financement). Champs publics + note A-D, ROI, durée, montant cible, avancement. **Ne mélange pas** avec la vitrine.
- `GET /projects/:id` : fiche détail (tout état publiquement visible). Champs publics, **photos** via URLs signées courtes, `upvote_count`/`follow_count`, l'état. **Jamais** les pièces privées ni la PII du porteur (au plus un nom d'affichage public).

**Engagement (auth)**
- `POST /projects/:id/follow` / `DELETE /projects/:id/follow` : suit / ne suit plus (idempotent ; maj `follow_count`). Autorisé sur un projet publiquement visible.
- `POST /projects/:id/upvote` / `DELETE /projects/:id/upvote` : vote / retire (unique par compte ; maj `upvote_count`).
- `GET /projects/:id/me` : mon état (following ? upvoted ?).

**Admin (`requireAuth` + `requireAdmin`)**
- `GET /admin/projects?status=in_review` : file de modération (métadonnées).
- `GET /admin/projects/:id` : détail + **URLs signées** vers les pièces privées + ligne d'audit `{adminId, projectId, action:"project_view"}`.
- `POST /admin/projects/:id/decision` : `{ decision: "approve", score } | { decision: "reject", reason }`. `approve` → `showcase` (+ `score`, `published_at`, `reviewed_by/at`). `reject` → `rejected` (+ `reason`). Transition valide seulement depuis `submitted`/`in_review`.
- `POST /admin/projects/:id/open-collection` : `showcase` → `collecting` (+ `collecting_opened_at`) et **notifie tous les followers** (« le projet X est ouvert à l'investissement ») via le notifier. Transition valide seulement depuis `showcase`.

Enveloppe d'erreur uniforme `{ error: { code, message } }`. Transitions d'état invalides → `409 invalid_state` (ou `400`).

---

## 6. Sécurité

- **Autorisation** : porteur n'édite/soumet que SES projets (owner = `req.accountId`) ; création réservée au rôle `porteur` ; routes admin derrière `requireAdmin`.
- **Pièces privées** (RCCM/foncier/relevés) : jamais renvoyées en public ; accès admin uniquement via URL signée courte + audit (comme KYC). Photos publiques : servies aussi via URL signée (bucket privé, pas d'URL publique en dur).
- **Anti-gaming** : follow/upvote authentifiés, unique par compte (pk composite) ; compteurs mis à jour de façon atomique.
- **Garde-fou réglementaire** : upvotes/follows = engagement, jamais un signal de qualité d'investissement ; **le catalogue de financement n'est jamais classé par votes** ; le tri du financement se fait sur des critères factuels (récence, note, avancement).
- **Validation** stricte des entrées (enums, montants entiers, MIME magic-bytes) ; clés de stockage serveur (jamais le nom de fichier client) ; aucune PII porteur ni pièce privée dans les listes publiques.
- **Notifier** : l'ouverture de collecte notifie les followers selon leurs préférences/canaux (`NOTIFY_CHANNELS` + `notification_pref`).

---

## 7. Réutilisation

`StorageProvider`/MinIO + logique de validation MIME (KYC) ; `requireAuth`/`requireAdmin` ; enveloppe d'erreur + error handler ; `buildTestApp` (fake storage) ; notifier. Mêmes patrons de transaction (une transaction pour décision/ouverture qui touche plusieurs lignes).

---

## 8. Tests

- Fake `StorageProvider` (mémoire). Multipart via le helper existant.
- Parcours : création draft → ajout pièces (photo publique + rccm privée) → submit → admin approuve+note → apparaît en Vitrine (`/projects/showcase`), PAS en financement ; follow/upvote (auth, unique, compteurs) ; admin ouvre la collecte → apparaît en `/projects/funding`, PLUS en vitrine, followers notifiés (notifier capturé) ; contrôle d'accès (non-porteur ne crée pas ; non-propriétaire n'édite pas ; non-admin n'accède pas à `/admin/projects*` ni aux pièces privées ; public ne voit pas les pièces privées) ; transitions invalides rejetées.

---

## 9. Questions ouvertes / défauts

1. **Compteurs upvote/follow** : dénormalisés sur `project` (maj atomique) vs `count(*)` à la lecture. Défaut : dénormalisés (perf lecture), mis à jour dans la même transaction que l'insert/delete du vote.
2. **`funded/repaying/closed`** : hors surfaces live de #3 ; accessibles en fiche détail. Une liste « réalisés » viendra plus tard.
3. **Follow/upvote après passage en collecting** : le follow persiste (historique/notif) ; l'upvote reste un signal de la phase vitrine (non affiché comme signal d'investissement). Défaut : autoriser follow tant que public ; upvote seulement en phase showcase.
