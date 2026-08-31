# Frontend Lot 2 - Catalogue + Fiche projet + Investissement (design)

**Date:** 2026-08-31
**Statut:** design valide, en attente de relecture avant plan
**Predecesseur:** Lot 1 (socle client + auth), merge aedc961. Reutilise `api.js`,
`errors.js`, le proxy dev same-origin, le pattern `pageJs`, la garde de session.

## 0. But

Rendre publiquement navigable et investissable le coeur du produit : parcourir les
projets (vitrine de decouverte + catalogue en collecte), consulter une fiche, suivre
/ voter, et investir un ticket. Contrainte forte ajoutee par rapport au Lot 1 : le
catalogue et les fiches sont des surfaces **publiques indexables (SEO)**, pas
seulement des ecrans authentifies.

## 1. Modele de rendu : SSG au build + hydratation client

Les projets sont des donnees runtime (Postgres) ; Eleventy genere du HTML au build.
Pour un SEO reel, le HTML doit exister a la requete. Modele retenu :

1. **Au build**, Eleventy lit l'API publique (`/projects/funding` + `/projects/showcase`)
   via un fichier de donnees `src/_data/projects.js`, et genere du **vrai HTML** :
   - la page catalogue avec toutes les cartes rendues (SEO complet) ;
   - **une fiche par projet** via la pagination Eleventy -> `/projet/<id>/` (FR) et
     `/en/projet/<id>/` (EN), vrais fichiers, URLs propres, aucune reecriture serveur.
2. **Au chargement**, le JS **hydrate** uniquement les donnees volatiles depuis l'API
   live : montant collecte / restant / progression, nombre d'investisseurs, etat
   follow/upvote du visiteur connecte, URLs signees fraiches des photos, panneau
   d'investissement. Le texte SEO (titre, description, categorie, ROI, ville,
   utilisation des fonds, garantie) est deja dans le HTML statique.

**Fraicheur.** Le HTML statique est un instantane ; les chiffres qui bougent sont
re-hydrates en live, donc jamais perimes a l'ecran. Le *set* de projets publics ne
change que par moderation admin (rare, controle) -> on redeclenche un build a ce
moment-la. Split : rebuild sur changement d'appartenance (rare, admin), hydratation
sur changement de valeur (frequent, client).

**Repli sans API.** Si l'API est injoignable au build (ex. CI frontend seul),
`src/_data/projects.js` renvoie `[]` : le catalogue se construit en coquille et le
client remplit en live (voir §7). `npm run build` reste vert sans l'API. Consequence
assumee : un build sans API ne genere aucune fiche `/projet/<id>/` (0 page paginee) ;
seul un build contre une API vivante produit les fiches SEO. C'est le comportement
voulu (le deploiement reel build contre l'API de prod ; la CI front seule teste la
coquille).

**Non retenu : SSR a la requete.** Fraicheur+SEO parfaits mais impose un moteur
serveur/framework pour ces routes, ce qui abandonne le statique Eleventy (decision
produit contraire). Ecarte.

## 2. Topologie (rappel Lot 1) + nouveaute build

- **Dev :** `docker compose up -d` + `cd api && npm run dev` (Fastify :3000) +
  `npm run dev` racine (Eleventy :8080, proxy `/api/*` -> :3000, prefixe retire).
  Le build/watch Eleventy lit l'API sur `BUILD_API_URL` (defaut `http://localhost:3000`)
  pour `_data/projects.js`. L'API doit tourner pour un build avec donnees.
- **Prod (documente) :** reverse proxy sert `_site/` + route `/api` -> Fastify.
  Le pipeline de build lit l'API de prod (`BUILD_API_URL`) pour generer les fiches.

## 3. Formes API (verifiees dans `api/src`)

Enveloppe d'erreur uniforme `{ error: { code, message, details? } }` (comme Lot 1).
Unites : les montants `*Minor` sont en FCFA (le FCFA n'a pas de subdivision -> minor
== FCFA, facteur 1). Categories : `immobilier | commerce | agriculture`. Scores :
`A | B | C | D`. Ticket minimum : `10000` FCFA.

**Liste funding** `GET /projects/funding?category?&score?&limit?` -> `{ projects: [...] }`.
Projection funding : `{ id, category, title, city, quartier, description, targetMinor,
raisedMinor, durationMonths, roiPct, status, score }` + (apres §8) `fundsUsage,
cautionType`. **Pas** de upvote/follow (garde-fou reglementaire : la liste funding
n'est jamais triee ni ornee de votes).

**Liste showcase** `GET /projects/showcase?category?&score?&limit?` -> `{ projects: [...] }`.
Projection publique : la funding + `upvoteCount, followCount` (et `raisedMinor` = 0,
un showcase ne collecte pas).

**Fiche** `GET /projects/:id` -> `{ project: <projection publique>, documents: [{ id,
kind, mime, sizeBytes, createdAt, url }] }`. `url` = URL **signee courte** (TTL
`kycUrlTtlSeconds`) -> **jamais** cuite dans le HTML statique, toujours hydratee.
404 si id malforme ou projet non public. Apres §8 : `project` porte aussi
`fundsUsage, cautionType`.

**Investir** `POST /projects/:id/invest { amountMinor, source: "wallet"|"payment",
confirmCapToRemaining? }` (auth) -> `201 { investmentId, amountMinor, status
("escrowed"|"pending"), raisedMinor, projectStatus, depositRef }`. Erreurs :
`unauthorized` 401 · `kyc_required` 403 · `invalid_state` 409 · `below_min_ticket`
400 · `exceeds_remaining` 409 (+ `details.remainingMinor`) · `insufficient_funds`
400 · `payment_failed` 402 · `not_found` 404.

**Engagement** (auth) : `GET /projects/:id/me` -> `{ following, upvoted }` ;
`POST|DELETE /projects/:id/follow` -> `{ following }` ; `POST|DELETE /projects/:id/upvote`
-> `{ upvoted }` (upvote **showcase-only** : 409 `invalid_state` sinon).

## 4. Fichiers

**Backend (§8) :** `api/src/modules/projects/service.ts` (ajout `fundsUsage`,
`cautionType` aux deux projections).

**Donnees build :** `src/_data/projects.js` (fetch funding+showcase, repli `[]`,
marque `surface: "funding"|"showcase"` par projet, dedoublonne par id au cas ou).

**Formatters partages :** `src/assets/js/fmt.js` : `money(minor, lang)` (groupage +
` FCFA`), `progressPct(raised, target)`, `estRoi(amountMinor, roiPct, months)`
(gain estime), `escapeHtml` si besoin de rendu client. Pur, sans dependance.

**Catalogue :** `src/projets.html` + `src/en/projets.html` deviennent des templates
Nunjucks : deux sections rendues depuis `projects` (funding puis showcase), cartes
avec les `data-*` que le filtre/tri lisent. `src/assets/js/catalog.js` (`pageJs:
catalog`) : filtre par puce secteur + tri (reprend la logique inline actuelle sur le
DOM rendu), puis hydrate (re-fetch live -> maj progression, ajoute les projets
apparus depuis le build, etats vides/chargement).

**Fiche :** `src/projet.njk` + `src/en/projet.njk` (paginent `projects`, `size: 1`,
`permalink: /projet/{{ project.id }}/` et `/en/projet/{{ project.id }}/`), rendent le
texte SEO (titre, metrics, description, utilisation des fonds, garantie, score) et
ecrivent l'id dans un attribut (`data-project-id`). L'ancien `src/projet.html`
statique est **remplace**. `src/assets/js/project.js` (`pageJs: project`) : hydrate
(fetch `/projects/:id` -> progression/restant live + galerie photos via URLs signees
fraiches ; si connecte, `/projects/:id/me` -> etat follow/upvote), cable follow (+
upvote si showcase), et pilote le panneau d'investissement (§5).

**Confirmation :** `src/investir-confirmation.html` + `/en/` gagnent `pageJs:
confirmation`. `src/assets/js/confirmation.js` lit le resultat d'investissement en
**sessionStorage** (jamais de montant en query string), remplit la carte succes ;
visite directe sans resultat -> etat neutre + lien `/projets`.

**Erreurs :** `src/assets/js/errors.js` etendu avec les codes invest (`below_min_ticket`,
`exceeds_remaining`, `insufficient_funds`, `payment_failed`, `invalid_state`,
`not_found`) + `kyc_required` (deja present) en FR/EN.

## 5. Parcours d'investissement (chemin argent)

Le bouton "Investir" applique cette garde, dans l'ordre :

1. **Non connecte** (`session.getMe()` null) -> `location = "/connexion/?next=" +
   encodeURIComponent("/projet/<id>/")` (retour sur la fiche apres login).
2. **Connecte, `kycStatus !== "verified"`** -> panneau desactive + message localise
   "terminez votre verification" avec lien dashboard (l'API renverrait 403 de toute
   facon ; on evite l'aller-retour).
3. **Connecte + verifie** -> `POST /projects/:id/invest { amountMinor, source }`.
   - `exceeds_remaining` (409, `details.remainingMinor`) -> proposer "il ne reste que
     `X` - investir `X` ?" ; a la confirmation, renvoyer avec `confirmCapToRemaining:
     true`.
   - `below_min_ticket` / `insufficient_funds` / `payment_failed` / `invalid_state`
     -> message localise par code sur le panneau.
   - **201** -> stocker `{ projectId, title, amountMinor, roiPct, durationMonths,
     status }` en sessionStorage sous une cle dediee, puis `location =
     "/investir/confirmation/"` (FR) / `/en/investir/confirmation/` (EN).

**Selecteur de source.** Le panneau ajoute un choix `wallet` / `payment` (l'API exige
`source`). Defaut : `payment` (parcours grand public). Le calcul ROI live existant
(`amount * roiPct/100 * months/12` cote client, purement indicatif) est conserve et
reutilise `fmt.estRoi`.

## 6. Securite / integrite

- Same-origin, cookie de session `httpOnly` inaccessible au JS (Lot 1). Aucun secret
  ni token cote client.
- **Anti-enumeration** : deja porte par l'API ; les messages invest sont generiques
  par code.
- **Aucune donnee personnelle en query string** : le resultat d'investissement
  transite par sessionStorage, pas par l'URL de confirmation.
- **URLs signees jamais cuites** : les photos ont un TTL court ; elles sont hydratees
  a chaque chargement, jamais ecrites dans le HTML de build (sinon 403 apres TTL).
- **Pas de PII exposee** : la projection publique n'expose pas le porteur ; la fiche
  ne nomme aucun porteur (section porteur retiree ou anonymisee, voir §9).
- **Garde-fou reglementaire** : la liste funding n'est jamais triee par votes ; les
  cartes funding n'affichent ni upvote ni follow (l'API ne les fournit deja pas).
- **Degradation** : sans JS, les fiches et le catalogue restent lisibles (texte SEO
  present) ; seuls les chiffres live, la galerie et l'investissement necessitent JS.
  Aucune action serveur destructive n'est cablee sans JS.

## 7. Etats et hydratation (detail)

**Catalogue.** Rendu build = cartes avec progression a l'instant du build. `catalog.js`
au chargement : re-fetch `/projects/funding` + `/projects/showcase`, met a jour la
progression/montants des cartes existantes (par id), **ajoute** les cartes des projets
apparus depuis le build, retire celles qui ne sont plus publiques, applique
filtre+tri. Etat de chargement discret ; etat vide si zero projet (message localise).

**Fiche.** Rendu build = texte + metrics avec collecte a l'instant du build.
`project.js` : fetch `/projets/:id` -> maj progression/restant/nb investisseurs,
injecte la galerie (URLs signees fraiches), et si `getMe()` non-null, fetch
`/projects/:id/me` pour l'etat follow/upvote. Follow (bouton "Sauvegarder") : toggle
`POST|DELETE /follow`, maj compteur+libelle. Upvote (showcase seulement) : toggle
`POST|DELETE /upvote`. Un 404 au fetch (projet retire entre build et visite) ->
message + lien `/projets`.

**Confirmation.** `confirmation.js` lit sessionStorage, remplit projet/montant/ROI/
echeance estimee ; efface la cle apres lecture (one-shot) ; visite directe -> neutre.

## 8. Changement backend (minimal)

Ajouter `fundsUsage: projects.fundsUsage` et `cautionType: projects.cautionType` a
**`PUBLIC_PROJECT_COLUMNS`** et **`FUNDING_PROJECT_COLUMNS`** dans
`api/src/modules/projects/service.ts`. Ce sont des champs texte que le porteur redige
pour le public (a quoi servent les fonds, quelle garantie). Consequences : showcase,
funding et la fiche les renvoient ; le build les a donc pour toutes les fiches (SEO).
**Aucune migration** (colonnes existantes), **aucun schema** modifie, **aucune PII**
(pas d'owner). Tests : la reponse showcase/funding/detail contient les deux champs ;
aucun champ sensible (owner, storageKey, rejectReason) ne fuit.

## 9. Sections de fiche retirees / anonymisees (pas de donnees backend)

Le mock a des sections sans support API : **plan de decaissement (tranches)**,
**"validation experts"**, **porteur nomme**. Il n'existe pas de modele de tranches
pre-financement, et le nom du porteur est une PII non exposee. Ces sections sont
**retirees** de la fiche wiree (le score KPITAL, lui, existe et est conserve). Une
section porteur generique **sans nom** peut rester (ex. "Porteur verifie par KPITAL")
si utile ; aucune identite affichee.

## 10. Tests / verification

Pas de framework de test frontend (comme Lot 1) : verification = `npm run build` vert
+ passe navigateur via le proxy, contre des projets **seedes** (un showcase + un
collecting, crees via l'API porteur/admin). Cote backend, §8 ajoute des tests unitaires
(projection). Checklist navigateur : catalogue affiche les deux sections (SSG puis
hydrate), filtre/tri OK ; fiche `/projet/<id>/` rend le texte SEO au build (verifiable
`curl` du HTML statique) puis hydrate chiffres+galerie ; follow/upvote refletent l'etat ;
invest non-connecte -> `/connexion/?next=` ; invest non-KYC -> bloque ; invest verifie
-> 201 -> confirmation peuplee ; `exceeds_remaining` -> cap propose. FR + EN.

## 11. Reporte (lots suivants / durcissement)

- **Rebuild-on-publish** : cabler le declencheur de rebuild sur les evenements de
  moderation admin (projet approuve, collecte ouverte/fermee) - ops, hors code Lot 2.
- **Repli catch-all** `/projet/*` (reverse proxy -> template client-render) pour un
  projet devenu public entre deux builds (evite un 404) - durcissement prod optionnel.
- **OpenGraph / sitemap** des fiches - amelioration SEO ulterieure.
- **Donnees dashboard investisseur** (portefeuille, mes investissements, notifs),
  **flux porteur** (soumettre/repay), **admin**, **deploiement prod** - lots suivants
  (spec Lot 1 §9).
- **Exposition porteur** (nom/affichage public non-PII) si le produit le decide -
  necessiterait un choix backend dedie.

## 12. Contraintes globales (verbatim, portee projet)

- **Zero tiret cadratin** nulle part (copie, commentaires) - lu comme "genere par IA".
- Respecter `notification_pref` cote backend (inchange ici).
- Progressive enhancement : le HTML SEO reste lisible sans JS.
- Bilingue FR/EN : meme script par flux, langue lue via `document.documentElement.lang` ;
  erreurs localisees par **code**, jamais le message brut anglais.
- Ne jamais `git add docs` en bloc (des docs strategie non suivis trainent).
- Commits/push uniquement sur demande.
