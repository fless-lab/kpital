# KPITAL - Roadmap frontend (9 lots)

Programme de cablage du front statique Eleventy sur l'API reelle, decoupe en 9 lots.
2 faits et pousses, 7 restants. Ce document porte tout le contexte pour reprendre le
travail depuis un autre poste. Chaque lot restant passe par le meme cycle SDD :
brainstorming -> spec (`docs/superpowers/specs/`) -> plan (`docs/superpowers/plans/`)
-> execution subagent-driven (revue opus sur les chemins argent) -> merge sur `main`
+ push.

Date de redaction : 2026-08-31. Remote : https://github.com/fless-lab/kpital.git

---

## 0. Reprendre le projet sur un autre PC

```bash
git clone https://github.com/fless-lab/kpital.git && cd kpital
npm install                      # front (Eleventy) a la racine
cd api && npm install && cd ..   # backend
docker compose up -d             # kpital-postgres (5544, dbs kpital + kpital_test) + kpital-minio (9100/9101)
# api/.env est gitignore : le recreer (voir §1 "Env dev").
cd api && set -a && . ./.env && set +a && npx drizzle-kit migrate && cd ..   # applique les migrations (0019 incluse) sur la db dev
node api/scripts/seed-projects.mjs   # 1 showcase + 1 collecting (ids reimprimes a chaque run ; les lire live)
# Terminal A : cd api && set -a && . ./.env && set +a && npx tsx watch src/server.ts   (Fastify :3000)
# Terminal B : npm run dev            (Eleventy :8080, proxy /api -> :3000)
# Ouvrir http://localhost:8080
```

Tests backend : `cd api && npm test` (une seule execution a la fois contre `kpital_test`).
Verif front : `npm run build` (vert) + passe navigateur via le proxy + `curl` du HTML
statique pour le SEO. Pas de framework de test front.

### Env dev (`api/.env`, gitignore, valeurs dev)
```
DATABASE_URL=postgres://kpital:kpital@127.0.0.1:5544/kpital
MINIO_ENDPOINT=127.0.0.1
MINIO_PORT=9100
MINIO_ACCESS_KEY=... MINIO_SECRET_KEY=... MINIO_BUCKET=kpital-kyc MINIO_USE_SSL=false
STORAGE_SSE=                # vide en dev : desactive le SSE (MinIO sans KMS)
ESCROW_WEBHOOK_SECRET=dev-secret
DEFAULT_GRACE_DAYS=30
```
(Recopier les vraies valeurs MinIO depuis docker-compose.yml.) Note : `tsx watch`
recharge a chaud ; le harness de dev peut tuer les process node en arriere-plan
(exit 144), relancer au besoin.

---

## 1. Patterns a respecter (tous les lots)

- **SSG + hydratation** pour toute surface PUBLIQUE indexable (SEO) : Eleventy lit
  l'API au build (`src/_data/*.js`, repli `[]` si API absente), rend le HTML, le JS
  hydrate les donnees volatiles. Les surfaces AUTHENTIFIEES (dashboard) peuvent etre
  client-render pur derriere la garde de session (pas de SEO attendu).
- **`pageJs`** front-matter -> `base.njk` charge `<script type="module" src="/assets/js/<name>.js">`.
- **Client API** : `src/assets/js/api.js` (`api.get/post/patch/del` + `apiMultipart` +
  `session.getMe()`), same-origin, cookie httpOnly jamais lu en JS. `api.post/patch/del`
  acceptent un 3e arg `opts` (ex. `{ headers }`).
- **`langPrefix` LOCAL** dans chaque template de page (`{% set langPrefix = "/en" if lang == "en" else "" %}`),
  jamais depuis `base.njk` (hors scope du contenu de page). Nunjucks n'a PAS
  `{% for x in y if cond %}` -> `{% if %}` imbrique.
- **Erreurs localisees par CODE** via `src/assets/js/errors.js` (`localizeError`, `pageLang`),
  jamais le message anglais brut. Anti-enumeration cote auth.
- **Garde de session** : les pages `/dashboard*` chargent `dash-guard.js`
  (`session.getMe()` null -> `/connexion/?next=`, remplit nom + bandeau KYC, logout).
  ATTENTION : logout est dans `.dash-nav-side` masque < 768px (pas de nav mobile
  dashboard - a traiter, voir Lot 8).
- **Argent** : montants `*Minor` en FCFA (minor == FCFA). `fmt.js` (`money`,
  `progressPct`, `estRoi`). Jamais de montant/PII en URL. Idempotence sur les POST
  argent (cf. invest : header `Idempotency-Key`, cle stable par intention).
- **ZERO tiret cadratin** (—) nulle part (copie, commentaires) : lu comme genere par IA.
- **Bilingue FR/EN** : meme script par flux, langue via `document.documentElement.lang`.
  Pages FR `src/x.html` + EN `src/en/x.html` (les EN reprennent les slugs FR).
- **Commits/push uniquement sur demande. Jamais `git add docs` en bloc** (des docs
  strategie non suivis trainent a la racine : modele-financier.md, strategie-*.md, test.wav).
- Revues opus adversariales sur tout chemin argent (invest, wallet withdraw, repay).

---

## 2. Etat : fait + pousse sur `main`

Backend complet #1 -> #8 + durcissement, tous sur `main` :
- #1 Foundation (comptes/OTP/wallet/admin), #2 KYC, #3 Projects+showcase, #4 Invest,
  #5 Escrow, #6 Repayment, #7 Collections, #8 Partial/advance repayment.
- Durcissement invest idempotency : merge `deb6363` (header Idempotency-Key requis,
  dedup par (investor,key), migration 0019).

Frontend :
- **Lot 1 - Socle client + Auth** : merge `aedc961`. api.js/errors.js/proxy dev,
  login (password + OTP), inscription + KYC upload, mot de passe oublie/reset (email),
  garde de session + logout + bandeau KYC.
- **Lot 2 - Catalogue + fiche + invest** : merge `f8f5df2`. SSG+hydratation,
  `/projet/<id>/` pagines (SEO), 2 sections funding/showcase, follow/upvote, parcours
  invest (auth->KYC->invest->confirmation, latch anti double-charge).

---

## 3. Les 9 lots

### Lot 1 - Socle client + Auth  [FAIT, aedc961]
### Lot 2 - Catalogue + fiche + investissement  [FAIT, f8f5df2]

### Lot 3 - Dashboard investisseur : donnees (overview + portefeuille + investissements)  [A FAIRE]
Rendre reelles les pages authentifiees ou l'investisseur voit ce qu'il a fait.
- **Pages** : `src/dashboard.html` (overview), `src/dashboard/portefeuille.html`,
  `src/dashboard/investissements.html`, `src/dashboard/investissement.html` (detail) + miroirs `/en/`.
- **Endpoints** : `GET /me/investments` (liste, chaque item = {investment status,
  amountMinor, repaidMinor, project summary {id,title,category,status,roiPct}}),
  `GET /wallet` (solde + entrees `wallet_entry` : reinvestment/disbursement/refund/repayment...),
  `GET /projects/:id` (pour enrichir un detail). NB : le detail d'echeancier
  `GET /projects/:id/repayment-schedule` est OWNER-ONLY (porteur) : un investisseur
  ne le voit pas ; son detail montre son ticket + repaidMinor + le projet.
- **Client-render** derriere `dash-guard` (pas de SEO). Le detail investissement lit
  `?id=` ou l'id d'investissement. Formatage FCFA via fmt.js. Vider les mocks (Kofi A.,
  Villa Tokoin) au profit des donnees /me.
- **Verif** : seeder un investisseur verifie + quelques investissements (le seed +
  quelques POST /invest avec Idempotency-Key), puis parcourir overview/portefeuille/
  investissements/detail.

### Lot 4 - Dashboard investisseur : parametres, notifications, documents  [A FAIRE]
- **Pages** : `src/dashboard/parametres.html`, `src/dashboard/notifications.html`,
  `src/dashboard/documents.html` (+ `/en/`).
- **Endpoints** : `GET/PATCH /me` (profil : firstName/lastName/country/phone),
  `POST /me/roles` (ajouter investor/porteur, cumulatif), `GET/PATCH /me/notification-pref`
  (channels email/sms + categories), `GET /kyc/me` (statut + docs KYC),
  `GET /wallet/payout-methods` + ajout (moyens de retrait), `POST /wallet/withdraw`
  (CHEMIN ARGENT -> revue opus : garde solde, idempotence a envisager).
- **TROU BACKEND a combler dans ce lot** : il n'existe AUCUN endpoint de LISTE de
  notifications (seulement les preferences). La page notifications a besoin d'un
  `GET /me/notifications` (+ marquage lu) cote backend, ou se limiter aux preferences.
  Decision a prendre au brainstorming : ajouter l'endpoint (petit sous-syst backend,
  table notification + envoi lors des events) OU reduire la page aux preferences.
- **Respecter `notification_pref`** cote affichage. Anti-enumeration hors sujet ici.

### Lot 5 - Flux porteur : soumettre un projet  [A FAIRE]
- **Pages** : `src/soumettre.html` (+ `/en/`) - wizard de creation de projet.
- **Endpoints** : `POST /projects` (create draft : category, title, city, quartier?,
  description, targetMinor, durationMonths, roiPct, fundsUsage, cautionType),
  `POST /projects/:id/documents` (multipart, photos publiques + docs prives rccm/foncier/
  releves, validation magic-byte cote serveur - reutilise le StorageProvider comme KYC),
  `POST /projects/:id/submit` (draft -> submitted, passe en moderation).
  `GET /projects/mine` pour relire.
- **Auth** : role `porteur` requis (POST /me/roles pour l'ajouter au besoin). Progressive
  enhancement + upload multipart via `apiMultipart` (comme l'inscription KYC du Lot 1).
- **Verif** : creer un projet en draft, uploader une photo + un doc prive, soumettre,
  verifier via GET /projects/mine + la file admin.

### Lot 6 - Flux porteur : mes projets + remboursement  [A FAIRE]
- **Pages** : `src/dashboard/mes-projets.html` (+ `/en/`) - cote porteur : etat collecte,
  echeancier, remboursement.
- **Endpoints** : `GET /projects/mine` (mes projets + statut : draft/submitted/showcase/
  collecting/funded/repaying/defaulted/closed/cancelled), `GET /projects/:id/repayment-schedule`
  (OWNER-ONLY : tranches, dueAt, amountMinor, paidMinor, remainingMinor, status, overdue,
  remindedAt), `POST /projects/:id/repay` (CHEMIN ARGENT -> revue opus : {amountMinor,
  confirmCapToRemaining?}, un seul payment pending par projet, cap au restant, idempotence
  a envisager comme invest).
- **Verif** : un projet finance (funded->repaying), afficher l'echeancier, faire un
  remboursement partiel + un anticipe, verifier paidMinor/remainingMinor et la relance.

### Lot 7 - Admin back-office  [A FAIRE]
Surface interne (pas de SEO, garde admin `requireAdmin`). Il n'y a pas encore de page
admin front : a creer (nouvelles pages sous `src/admin/` + une nav admin dediee).
- **Endpoints KYC** : `GET /admin/kyc` (file), `GET /admin/kyc/:id` (detail + URLs
  signees + audit), `POST /admin/kyc/:id/decision` (verified/rejected, raison requise).
- **Endpoints projets** : `GET /admin/projects` (file moderation), `GET /admin/projects/:id`
  (detail + URLs signees + audit), `POST /admin/projects/:id/decision` (approve+score A-D
  -> showcase / reject+raison), `POST /admin/projects/:id/open-collection` (showcase ->
  collecting + notifie les followers), `POST /admin/projects/:id/cancel` (annule + rembourse),
  `POST /admin/projects/:id/default` + `/undefault` (defaut manuel sticky),
  `POST /admin/repayment/sweep` (cron manuel retards/defauts).
- **Comment devenir admin** : pas d'endpoint public de promotion. Un compte admin se
  marque en base (voir comment `requireAdmin` determine l'admin : flag/role sur account).
  Documenter/scripter la promotion (comme le seed fait des INSERT directs).
- **Chemins argent** (cancel/refund, open-collection notifie) : revue opus.

### Lot 8 - Durcissements & polish  [A FAIRE]
Regrouper les items reportes des lots precedents (triage revue finale) :
- **Logout mobile inaccessible** (`.dash-nav-side{display:none}` < 768px) : ajouter une
  nav/menu dashboard mobile OU sortir le logout de la zone masquee. Priorite haute
  (fintech = mobile-first Togo).
- **Cartes funding sans montant FCFA** (que le %) : restaurer une ligne montant
  raised/target via fmt.money (les champs existent).
- **No-JS sur les fiches** : le SSG montre les entiers minor bruts avant hydratation ;
  formatter cote build (le texte SEO est deja present, c'est cosmetique sans JS).
- **SEO fiches** : OpenGraph par projet est deja gere par head-seo.njk ; ajouter un
  sitemap des fiches + eventuellement og:image par projet.
- **Reset par SMS** : le flux forgot cote API supporte channel=phone (OTP) ; le front
  masque le toggle telephone (dead-end). Cabler le parcours code+reset-par-code.
- **Rebuild-on-publish** : declencher un rebuild statique quand un projet devient public
  (evenement moderation admin) - ops, sinon une fiche creee entre 2 builds fait 404.
- **Catch-all `/projet/*`** (reverse proxy -> template client-render de repli) pour un
  projet public non encore build - durcissement optionnel.
- **Cle idempotence provider** : la cle deposit derive d'un randomUUID par requete ; a
  rederiver de la cle client si on deplace l'initiation hors du verrou (provider async reel).

### Lot 9 - Deploiement prod  [A FAIRE]
- Reverse proxy (nginx/Caddy) : sert `_site/` statique + route `/api` -> Fastify (meme
  origine). Cookies `SameSite=Lax` + `Secure` en prod ; `CORS_ORIGIN` inchange.
- Pipeline de build : `BUILD_API_URL` pointe l'API de prod pour generer le SSG (catalogue
  + fiches). Rebuild declenche sur moderation (cf. Lot 8).
- Env de prod (secrets DB/MinIO/escrow), HTTPS, sauvegardes, CI (build front + `npm test`
  backend). Ce lot est surtout de la config/doc, peu de code.

---

## 4. Trous backend a combler (identifies)

- **Liste de notifications** : aucun `GET /me/notifications` (seulement les preferences).
  Necessaire pour la page notifications (Lot 4). Decision au brainstorming du Lot 4.
- **Promotion admin** : pas d'endpoint pour rendre un compte admin (INSERT/UPDATE direct
  requis ; a scripter pour le Lot 7).
- Le reste des endpoints existe (verifie contre `api/src`).

## 5. Ordre suggere

3 (dashboard donnees) -> 4 (parametres/notifs, + endpoint notifications) -> 5 (soumettre)
-> 6 (mes projets + repay) -> 7 (admin) -> 8 (durcissements) -> 9 (prod). Les chemins
argent des lots 4 (withdraw) et 6 (repay) meritent une revue opus comme l'invest.

## 6. Memoire

Le contexte detaille de chaque sous-systeme vit dans la memoire projet
`~/.claude/.../memory/kpital-redesign-project.md` (recap des merges, decisions,
patterns). Ce fichier-ci est le plan de reprise cote depot.
