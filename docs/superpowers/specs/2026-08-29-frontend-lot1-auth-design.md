# KPITAL Frontend, Lot 1 : Socle client + Auth

> Document de conception (spec). Statut : brouillon a relire.
> Date : 2026-08-29. Branche le front statique (Eleventy, `src/`) sur l'API reelle (Fastify, `api/`, sous-systemes #1-#8 sur `main`).

---

## 1. Objectif et perimetre

Rendre le front fonctionnel en construisant la **couche client d'integration** qui n'existe pas (aujourd'hui : Eleventy 100% statique, `app.js` = 21 lignes de drawer mobile, zero appel API). Lot 1 = le socle (client API + proxy dev) + l'**auth complete** ; les donnees metier (catalogue, portefeuille, investissements) viennent aux lots suivants.

Decisions de cadrage (validees) :
- **Enhancement progressif** : le HTML statique Eleventy reste la coquille ; un client JS vanilla parle a l'API ; pas de React/Next, clean URLs conservees.
- **Meme origine via proxy** : le serveur de dev Eleventy proxy `/api/*` -> Fastify (:3000), prefixe retire -> cookies same-origin, zero CORS.
- **Decoupage en lots** : Lot 1 = socle + auth. Suivants (ordre) : catalogue public, parcours invest, dashboard investisseur, dashboard porteur, admin.

**Dans le perimetre (Lot 1) :**
- `src/assets/js/api.js` : client fetch (base `/api`, credentials same-origin, enveloppe d'erreur normalisee, multipart, session).
- Proxy dev (`.eleventy.js` middleware) + champ front-matter `pageJs`.
- 5 flux auth : inscription (register + upload KYC), connexion, deconnexion, mot de passe oublie, nouveau mot de passe.
- Garde de session sur `/dashboard*` + squelette authentifie (nom/roles/statut KYC, bandeau KYC-pending) + bouton deconnexion.
- Bilingue FR/EN (scripts partages, messages localises par code d'erreur).

**Hors perimetre (lots suivants, section 9) :** catalogue projets, parcours invest, donnees dashboard (portefeuille/investissements/notifs), dashboard porteur (soumettre/repay), admin ; deploiement prod (nginx/Caddy documente, pas code).

---

## 2. Topologie dev / prod

**Dev :** `docker compose up -d` (Postgres/MinIO) + `cd api && npm run dev` (Fastify :3000) + `npm run dev` a la racine (Eleventy :8080 en watch). Le serveur de dev Eleventy monte un **middleware de proxy** : toute requete `/api/*` est forwardee vers `http://localhost:3000` avec le prefixe `/api` retire (l'API route en `/auth/login`, pas `/api/auth/login`). Tout est servi depuis `http://localhost:8080` -> cookies same-origin (SameSite=Lax marche), zero CORS.

Implementation : `.eleventy.js` `eleventyConfig.setServerOptions({ middleware: [proxyMiddleware] })` ou `proxyMiddleware = createProxyMiddleware({ target: "http://localhost:3000", changeOrigin: true, pathRewrite: { "^/api": "" } })` (`http-proxy-middleware`, ajoute en devDependency racine).

**Prod (documente, non code en Lot 1) :** un reverse proxy (nginx/Caddy) sert `_site/` (statique) et route `/api` -> Fastify (meme origine). Le backend `CORS_ORIGIN` et les cookies (SameSite=Lax, Secure en prod) conviennent sans changement.

---

## 3. Le client `api.js`

Module ES unique, importe par les pages qui en ont besoin.

```js
// enveloppe d'erreur backend : { error: { code, message, details? } }
class ApiError extends Error { constructor(code, message, details, status) { ... } }

async function api(path, { method = "GET", body, headers } = {}) {
  const res = await fetch("/api" + path, {
    method, credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error?.code ?? "unknown", data?.error?.message ?? "", data?.error?.details, res.status);
  return data;
}
api.get/post/patch/del  // helpers
async function apiMultipart(path, formData) { /* fetch sans Content-Type (le navigateur pose le boundary), meme normalisation d'erreur */ }
const session = { async getMe() { try { return await api.get("/me"); } catch (e) { if (e.status === 401) return null; throw e; } } };
export { api, apiMultipart, session, ApiError };
```

`api.js` est charge en `<script type="module">` (le champ `pageJs`, section 4). Les scripts de page l'importent (`import { api } from "/assets/js/api.js"`).

---

## 4. Accroche Eleventy (`pageJs`) + bilingue

- `base.njk` : apres `app.js`, ajouter `{% if pageJs %}<script type="module" src="/assets/js/{{ pageJs }}.js"></script>{% endif %}`. Une page declare `pageJs: auth-login` dans son front-matter (comme `pageCss`). `api.js` est importe par ces scripts, pas charge globalement.
- **Bilingue** : chaque flux a une page FR (`src/inscription.html`) et EN (`src/en/inscription.html`), mais **le meme script** (`auth-register.js`). Le script lit la langue via un attribut `document.documentElement.lang` (deja `lang="fr"|"en"`). Les messages d'erreur : `api.js` expose le **code** ; chaque script a une petite table `{ code -> { fr, en } }` + un fallback generique localise. On n'affiche jamais le message brut anglais du backend sur la page FR.
- Les scripts progressive-enhancement : le `<form>` garde son markup ; le script fait `form.addEventListener("submit", e => { e.preventDefault(); ... })`. Si JS est absent, le formulaire ne fait rien de destructeur (pas d'action serveur cablee) -> degradation sure.

---

## 5. Parcours auth

Endpoints (verifies dans `api/src/modules/auth|kyc`) : `POST /auth/register`, `/auth/login`, `/auth/logout`, `/auth/password/forgot`, `/auth/password/reset`, `POST /kyc/submission` (multipart, requireAuth), `GET /me` (requireAuth).

**Inscription (`/inscription`, `pageJs: auth-register`) - wizard 3 etapes existant.** Submit final :
1. `POST /auth/register { email, password, firstName, lastName, country, phone?, roles[] }` (roles cumulables `investor`/`porteur` selon les cases). Succes -> compte + session (cookie).
2. `apiMultipart("/kyc/submission", fd)` avec `doc_type`, `doc_number`, `dob` (YYYY-MM-DD), `nationality` + fichiers (cles `front`/`back` pour CNI/titre, `passport_page` pour passeport ; l'upload dynamique par type existe deja). KYC obligatoire a l'inscription.
3. Erreurs : register echoue (`validation_error`, email pris) -> message localise sur l'etape ; register OK + KYC echoue (`file_too_large`, MIME) -> le compte existe (`kyc pending`), redirection `/dashboard` + bandeau « terminez votre verification » (retry en parametres, lot ulterieur). Jamais de compte fantome.

**Connexion (`/connexion`, `pageJs: auth-login`).** `POST /auth/login { identifier, password }` (`identifier` = email OU telephone). Succes -> `location = "/dashboard"` (ou `?next=`). Echec -> message generique localise (anti-enumeration : le backend renvoie un echec uniforme). Lien « Mot de passe oublie ».

**Deconnexion.** Bouton dans `dash-nav.njk` -> `POST /auth/logout` -> `location = "/connexion"`.

**Mot de passe oublie (`/mot-de-passe-oublie`, `pageJs: auth-reset`).** `POST /auth/password/forgot { identifier }` -> ecran neutre « si un compte existe, un lien/code a ete envoye » (anti-enumeration, toujours succes cote UI).

**Nouveau mot de passe (`/nouveau-mot-de-passe`).** Lit `token` de l'URL (`?token=`). `POST /auth/password/reset { token, password }` (force + confirmation cote client, deja dans l'UI). Succes -> etat succes + lien connexion ; token invalide/expire -> etat « lien invalide » (deja prevu dans l'UI).

**Garde de session (`/dashboard*`, `pageJs: dash-guard` sur chaque page dashboard, ou dans `dash-nav`).** Au chargement : `session.getMe()`. `null` (401) -> `location = "/connexion?next=" + encodeURIComponent(path)`. Sinon : garder l'objet compte, remplir le nom (nav), afficher le statut KYC ; si `kyc_status !== "verified"` -> bandeau « verification en cours / a terminer ». Lot 1 ne charge AUCUNE donnee metier ; juste garde + squelette + logout.

---

## 6. Securite / integrite

- Same-origin -> cookie de session `httpOnly` inaccessible au JS (deja ainsi cote backend) ; le client ne stocke aucun token, ne lit jamais le cookie ; l'auth est portee par le cookie same-origin.
- Anti-enumeration respectee cote UI : login et forgot affichent des messages generiques ; on ne revele jamais « email inconnu » vs « mauvais mot de passe ».
- `credentials: "same-origin"` (pas `include`, inutile same-origin). Aucun secret dans le JS client.
- KYC : le client envoie les fichiers en multipart ; le backend valide MIME (magic-byte) / taille -> le client se contente d'afficher l'erreur par code, ne fait pas confiance a l'extension.
- Le proxy dev ne s'active qu'en dev ; prod = reverse proxy externe. Pas de CORS ouvert.
- Degradation JS-off sure (les formulaires n'ont pas d'action serveur destructive cablee).

---

## 7. Reutilisation / structure

- `src/assets/js/api.js` (nouveau, partage par tous les lots). Scripts de flux : `auth-register.js`, `auth-login.js`, `auth-reset.js`, `dash-guard.js` (+ un petit `i18n`/table de codes commun, ex. `src/assets/js/errors.js`).
- Front-matter `pageJs` (nouveau) dans `base.njk`. `dash-nav.njk` : bouton deconnexion + emplacement nom.
- `.eleventy.js` : middleware proxy dev ; `http-proxy-middleware` en devDependency racine. `npm run dev` inchange dans son invocation.
- Aucune modification du backend `api/` (les endpoints existent deja et conviennent).

---

## 8. Verification (pas de framework de test front)

Le front n'a pas de harnais de test. Verification = **manuelle, dans l'app qui tourne** (skills `run` / claude-in-chrome), plus des controles cibles :
- `npm run build` (Eleventy) reste vert ; les pages se generent, `pageJs` injecte le bon script.
- Parcours bout-en-bout dans le navigateur avec l'API + Postgres up : inscription (register+KYC) -> session -> `/dashboard` (garde OK, nom affiche) ; connexion email et telephone ; mauvais identifiants -> message generique ; logout -> `/connexion` ; forgot -> ecran neutre ; reset avec un token (recupere via le notifier mock / logs) -> succes ; garde : `/dashboard` sans session -> redirige `/connexion?next=`.
- Verifier au moins un flux en FR et en EN (message d'erreur localise).
- Le plan detaillera un checklist de verification par flux ; chaque tache se termine par un build vert + une verification navigateur documentee.

---

## 9. Lots suivants (hors #Lot 1, references)

1. **Catalogue public** : `/projets` (financement + showcase via `GET /projects/funding` et `/projects/showcase`), `/projet/:id` (detail), follow/upvote (showcase).
2. **Parcours invest** : panneau invest sur un projet en financement (gate KYC, source wallet/paiement, UX confirm-cap si > reste), `/investir/confirmation`.
3. **Dashboard investisseur** : overview, portefeuille (wallet + txns), investissements (+ detail avec echeancier/repaidMinor), notifications, parametres (profil, KYC, roles, prefs notif, moyens de retrait).
4. **Dashboard porteur** : mes-projets, soumettre (create/submit + documents), remboursement (`/repay`).
5. **Admin** : back-office (KYC queue, moderation projets, defaut/annulation) - surface minimale, peut etre un lot a part.
6. **Deploiement** : reverse proxy prod (nginx/Caddy), build/serve.
