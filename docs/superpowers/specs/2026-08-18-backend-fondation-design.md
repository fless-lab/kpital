# KPITAL Backend, sous-système 1 : Fondation (Comptes, Auth, Wallet, Back-office)

> Document de conception (spec). Statut : brouillon à relire.
> Date : 2026-08-18.
> Périmètre : la première brique buildable du backend, celle sur laquelle tous les autres sous-systèmes se greffent. Ne dépend d'aucun partenaire externe signé.

---

## 1. Objectif et périmètre

Construire le socle transactionnel de KPITAL : création de compte, authentification (mot de passe + code OTP), sessions, portefeuille interne (wallet), et un back-office minimal pour l'administration. Le mouvement d'argent réel reste derrière une interface simulée jusqu'à la signature d'un partenaire de paiement agréé.

**Dans le périmètre :**
- Comptes utilisateurs (rôles cumulables investisseur et/ou porteur).
- Authentification : mot de passe, et code OTP par email ou téléphone.
- Sessions (connexion, déconnexion, révocation).
- Réinitialisation de mot de passe (lien email, code téléphone).
- Wallet interne par utilisateur (grand livre en écriture seule), créé automatiquement.
- Couche notification unique pilotée par `NOTIFY_CHANNELS`.
- Interface paiement `PaymentProvider` avec une implémentation mock.
- Back-office : liste des utilisateurs, statut KYC, actions admin de base.
- Statut KYC porté par le compte (`kyc_status`), initialisé à `pending`.

**Hors périmètre (sous-systèmes ultérieurs, référencés seulement) :**
- #2 KYC : upload et stockage des pièces, revue et validation. La Fondation crée le compte en `kyc_pending` et expose un point d'accroche ; le traitement documentaire est le #2.
- #3 Soumission et catalogue de projets.
- #4 Intention d'investissement.
- #5 Paiement et séquestre réels (branchement du partenaire agréé).

---

## 2. Contraintes et décisions (issues du cadrage)

| Décision | Choix | Raison |
|---|---|---|
| Objectif | Vrai produit transactionnel | Décidé |
| Partenaires argent | Rien de signé | Paiement mocké derrière interface |
| Stack | Node.js + PostgreSQL | Contrôle total, même langage que le front |
| Rôles | Cumulables (invest et/ou porteur) | On gate l'action, pas le compte |
| Wallet | Créé auto à l'inscription, wallet-first | Moyen de retrait choisi plus tard |
| KYC | Obligatoire à l'inscription | Filtre les utilisateurs sérieux |
| OTP / notifications | Canal par env `NOTIFY_CHANNELS` (`email` \| `sms` \| `email,sms`) | Une abstraction, la conf choisit la voie |
| Nommage partenaire | Rôle neutre côté public | Rien de signé (voir site) |

---

## 3. Vue d'ensemble de l'architecture

```
Front Eleventy (statique)  ──HTTP(JSON)──▶  API KPITAL (Node/Fastify)
                                              │
      ┌───────────────────────────────────────┼─────────────────────────────┐
      ▼                    ▼                    ▼               ▼             ▼
  Auth service        Account service      Wallet service   Notifier    PaymentProvider
  (password, OTP,     (profil, rôles,      (grand livre     (email/sms   (interface,
   sessions, reset)    kyc_status)          append-only)     via env)     impl. MOCK)
      │                    │                    │
      └───────────────┬────┴─────────┬──────────┘
                      ▼              ▼
                  PostgreSQL     Admin (back-office protégé role=admin)
```

Principe : chaque service a une responsabilité unique, une interface claire, testable isolément. Les services communiquent via des fonctions/modules, pas via HTTP interne (monolithe modulaire au départ ; découpe possible plus tard).

---

## 4. Stack technique

- **Runtime** : Node.js (LTS), TypeScript (typage = filet de sécurité pour du code financier).
- **Framework HTTP** : Fastify (rapide, validation de schéma intégrée, plugins). *Alternative écartée : Express (plus verbeux, validation à ajouter).*
- **Base** : PostgreSQL.
- **Accès DB + migrations** : Drizzle ORM (SQL-first, typé, migrations versionnées). *Alternative : `pg` brut + `node-pg-migrate` si tu préfères zéro ORM.*
- **Hash mot de passe** : argon2id.
- **Validation d'entrée** : schémas (zod ou schémas Fastify) à la frontière HTTP.
- **Tests** : Vitest (unitaire + intégration) + une base Postgres de test (conteneur ou base dédiée).
- **Email (dev)** : transport SMTP ou sortie console ; **SMS** : provider stub pour l'instant.

---

## 5. Structure de dossiers (proposée)

```
api/
  src/
    config/            env, chargement/validation des variables
    db/                schema Drizzle, migrations, client
    modules/
      auth/            password, otp, sessions, reset (service + routes + tests)
      accounts/        profil, rôles, kyc_status
      wallet/          grand livre, solde, écritures
      admin/           back-office (routes protégées role=admin)
    lib/
      notifier/        interface Notifier + EmailProvider + SmsProvider + factory (NOTIFY_CHANNELS)
      payments/        interface PaymentProvider + MockPaymentProvider
      http/            plugins Fastify, gestion erreurs, auth middleware
    server.ts          bootstrap
  tests/               intégration
  drizzle/             fichiers de migration générés
  package.json
```

Le front Eleventy reste à la racine tel quel ; l'API vit dans `api/` (déploiement séparé, appelée en JSON par le front).

---

## 6. Modèle de données (tables principales)

**account**
- `id` (uuid, pk)
- `email` (citext, unique, nullable si inscription par téléphone seul, sinon requis)
- `phone` (text, unique, nullable)
- `password_hash` (text, argon2id)
- `first_name`, `last_name` (text)
- `country` (text)
- `roles` (text[] : `['investor']`, `['porteur']`, ou les deux)
- `kyc_status` (enum : `pending` | `verified` | `rejected`), défaut `pending`
- `status` (enum : `active` | `suspended` | `closed`)
- `is_admin` (bool, défaut false)
- `created_at`, `updated_at`

**session**
- `id` (uuid, pk)
- `account_id` (fk)
- `token_hash` (text, hash du token opaque de session)
- `user_agent`, `ip` (text, pour "sessions actives")
- `expires_at`, `created_at`, `revoked_at` (nullable)

**otp_code**
- `id` (uuid, pk)
- `account_id` (fk, nullable au moment d'une demande par identifiant)
- `channel` (enum : `email` | `sms`)
- `purpose` (enum : `login` | `password_reset` | `verify_contact`)
- `code_hash` (text), `expires_at`, `consumed_at` (nullable)
- `attempts` (int, pour le rate-limit), `created_at`

**password_reset** (si lien email plutôt que code)
- `id`, `account_id` (fk), `token_hash`, `expires_at`, `consumed_at`, `created_at`

**wallet**
- `id` (uuid, pk), `account_id` (fk, unique), `currency` (défaut `XOF`), `created_at`

**wallet_entry** (grand livre, append-only)
- `id` (uuid, pk)
- `wallet_id` (fk)
- `type` (enum : `repayment` | `withdrawal` | `reinvestment` | `adjustment`)
- `amount_minor` (bigint, montant en plus petite unité, signé : + entrant, - sortant)
- `reference` (text, ex : id projet/remboursement)
- `metadata` (jsonb)
- `created_at`

> Le solde d'un wallet = SUM(`amount_minor`) sur ses `wallet_entry`. Pas de colonne solde mutable : le grand livre en écriture seule est la source de vérité (règle fintech, évite les états incohérents).

**payout_method** (moyen de retrait, choisi après inscription, wallet-first)
- `id`, `account_id` (fk), `type` (enum : `tmoney` | `flooz` | `bank`), `details` (jsonb), `verified` (bool), `created_at`

**notification_pref**
- `account_id` (fk), `channels` (text[] : override utilisateur, sinon défaut global), `categories` (jsonb : remboursements, jalons, projets suggérés, actualités)

---

## 7. Authentification

**Mot de passe**
- Hash argon2id à l'inscription. Politique : min 8, une majuscule, un chiffre (aligné sur le front).
- Connexion : identifiant = email OU téléphone (aligné sur `/connexion`).

**OTP (code unique)**
- 6 chiffres, généré aléatoirement, **hashé au repos** (jamais stocké en clair).
- TTL court (ex : 10 min), usage unique (`consumed_at`), rate-limité (`attempts` + fenêtre par identifiant/IP).
- Envoyé via la couche `Notifier` selon `NOTIFY_CHANNELS`.
- Usages : connexion sans mot de passe, réinitialisation par téléphone, vérification de contact.

**Réinitialisation de mot de passe** (aligné sur les pages déjà construites)
- Email : lien signé `/nouveau-mot-de-passe?token=…`, token hashé en base, TTL 30 min, usage unique.
- Téléphone : code OTP `purpose=password_reset`.
- Réponse anti-énumération : toujours "si un compte existe…".

**Sessions**
- Token opaque aléatoire, **hashé en base**, transmis en **cookie httpOnly, Secure, SameSite=Lax**.
- Révocable (déconnexion, "se déconnecter partout" = révoquer toutes les sessions du compte).
- Expiration glissante ou fixe (à trancher, défaut : fixe 30 jours, "se souvenir de moi" prolonge).
- *Choix : sessions serveur (révocables) plutôt que JWT auto-portant, plus sûr pour une fintech.*

---

## 8. Wallet (grand livre)

- Créé automatiquement à la création du compte (solde 0).
- Non rechargeable directement (wallet-first) : alimenté uniquement par des `wallet_entry` de type `repayment` (remboursements), diminué par `withdrawal` / `reinvestment`.
- Solde disponible = somme des entrées.
- Un retrait crée une entrée négative ET déclenche `PaymentProvider.payout(...)` (mocké aujourd'hui).
- Toute opération monétaire passe par une transaction DB ; les écritures sont immuables (corrections via une entrée `adjustment`, jamais en modifiant/supprimant).

---

## 9. Couche notification (`NOTIFY_CHANNELS`)

```
interface Notifier {
  send(to: Recipient, message: NotificationMessage): Promise<void>
}
```
- Une factory lit `NOTIFY_CHANNELS` (`email` | `sms` | `email,sms`) et compose les providers actifs.
- Providers : `EmailProvider` (SMTP ou console en dev), `SmsProvider` (stub, prêt à brancher un agrégateur plus tard).
- Utilisé pour l'OTP **et** les notifications de compte (remboursements, jalons, etc.).
- Les préférences utilisateur (`notification_pref`) peuvent restreindre les canaux/catégories par compte.

---

## 10. Interface paiement (mockée)

```
interface PaymentProvider {
  payout(params): Promise<PayoutResult>     // retrait vers Mobile Money / banque
  // plus tard : collectFunds, escrowDeposit, escrowRelease (sous-système #5)
}
```
- Implémentation `MockPaymentProvider` : simule succès/échec, aucune vraie transaction.
- Le reste du code ne connaît que l'interface : le jour où le partenaire agréé est signé, on ajoute `RealPaymentProvider` sans toucher aux services.

---

## 11. Back-office (admin)

Minimal pour la Fondation, protégé par `is_admin` :
- Liste/recherche des comptes, détail d'un compte.
- Voir et changer le `kyc_status` (le vrai flux de revue documentaire arrive avec #2).
- Suspendre/réactiver un compte.
- Voir le grand livre d'un wallet (lecture seule).

Forme : routes API protégées + pages admin simples (rendu serveur léger ou petite SPA interne). À trancher : rendu serveur minimal vs page protégée. Défaut proposé : routes JSON + une page admin sobre.

---

## 12. Surface API (aperçu)

```
POST   /auth/register            créer un compte (+ wallet auto), roles, kyc_status=pending
POST   /auth/login               email|téléphone + mot de passe -> session
POST   /auth/otp/request         demande un code (login|reset) via NOTIFY_CHANNELS
POST   /auth/otp/verify          vérifie le code -> session (ou étape reset)
POST   /auth/logout              révoque la session courante
POST   /auth/logout-all          révoque toutes les sessions du compte
POST   /auth/password/forgot     déclenche lien email ou code téléphone (anti-énumération)
POST   /auth/password/reset      applique le nouveau mot de passe (token|code)

GET    /me                       profil + rôles + kyc_status
PATCH  /me                       maj profil
POST   /me/roles                 activer le rôle porteur (rôles cumulables)
GET    /me/notification-pref     lire préférences
PATCH  /me/notification-pref     maj préférences (canaux, catégories)

GET    /wallet                   solde + entrées
POST   /wallet/withdraw          crée une entrée négative + PaymentProvider.payout (mock)
GET    /wallet/payout-methods    lister
POST   /wallet/payout-methods    ajouter un moyen de retrait

# admin
GET    /admin/accounts           liste/recherche
GET    /admin/accounts/:id       détail
PATCH  /admin/accounts/:id       kyc_status / status
GET    /admin/accounts/:id/wallet
```

Toutes les entrées validées par schéma ; toutes les réponses en JSON ; erreurs normalisées (voir §14).

---

## 13. Sécurité

- Mots de passe argon2id ; OTP et tokens **hashés au repos**.
- Cookies de session httpOnly + Secure + SameSite.
- Rate-limiting sur login, OTP request/verify, forgot-password.
- Réponses anti-énumération sur les flux d'identifiant.
- Validation stricte des entrées ; jamais de SQL concaténé (requêtes paramétrées / ORM).
- CORS restreint à l'origine du front.
- Journalisation des événements sensibles (connexion, reset, retrait, action admin).
- Secrets via variables d'environnement, jamais commités.

---

## 14. Erreurs et validation

- Un format d'erreur unique : `{ error: { code, message, details? } }`.
- Codes stables (ex : `invalid_credentials`, `otp_expired`, `rate_limited`, `validation_error`).
- Validation à la frontière HTTP ; les services supposent des entrées déjà validées.

---

## 15. Stratégie de test

- **Unitaire** : logique OTP (génération, expiration, tentatives), calcul de solde wallet, factory `Notifier` selon `NOTIFY_CHANNELS`, politique mot de passe.
- **Intégration** : parcours complets sur une base Postgres de test : register -> login -> session ; otp login ; forgot/reset ; withdraw (mock) ; garde admin.
- **Approche TDD** recommandée pour les services financiers (wallet, auth).
- Providers externes (email/sms/paiement) remplacés par des fakes en test.

---

## 16. Configuration (env)

```
DATABASE_URL=postgres://...
SESSION_COOKIE_NAME=kpital_sess
SESSION_TTL_DAYS=30
OTP_TTL_MINUTES=10
NOTIFY_CHANNELS=email          # email | sms | email,sms
SMTP_URL=...                   # ou mode console en dev
CORS_ORIGIN=https://kpital.finance
```

---

## 17. Hors périmètre (rappel)

KYC documentaire (#2), projets (#3), intention d'investissement (#4), paiement/séquestre réels (#5). La Fondation expose les points d'accroche (`kyc_status`, `PaymentProvider`, `Notifier`) sur lesquels ces sous-systèmes se brancheront.

---

## 18. Décisions confirmées (2026-08-18)

1. **ORM** : **Drizzle** (typé, migrations versionnées).
2. **Frontière KYC** : le sous-système **#2 gère les pièces** (upload, stockage, revue). La Fondation initialise et porte seulement `kyc_status` (défaut `pending`), et expose le point d'accroche.
3. **Back-office** : **routes JSON protégées + une page admin sobre** (pas de mini-front admin élaboré pour l'instant).
4. **Hébergement** : non tranché, sans impact sur le code. À décider au moment du déploiement (VPS, conteneur, ou Postgres managé).
5. **Monorepo** : **même dépôt**, dossier **`api/`** à côté du front Eleventy.
