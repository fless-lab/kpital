# Frontend Lot 1 (Client + Auth) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the static Eleventy front to the real API (progressive enhancement): a vanilla `api.js` client, a same-origin dev proxy, and the 5 auth flows (register + KYC, login incl. OTP, logout, forgot, reset) plus a session guard on the dashboard.

**Architecture:** Keep every existing page's markup and its inline UX JS (wizard steps, password-strength, pane toggles). Add one shared `api.js` client + small per-flow scripts loaded via a new `pageJs` front-matter field. The Eleventy dev server proxies `/api/*` to Fastify (:3000) with the `/api` prefix stripped, so everything is one origin and the session cookie just works. No framework, no backend change.

**Tech Stack:** Eleventy 3.1.6 (`.eleventy.js`, CommonJS), Nunjucks includes, vanilla ES-module JS, `http-proxy-middleware` (dev only).

**Spec:** `docs/superpowers/specs/2026-08-29-frontend-lot1-auth-design.md`

## Global Constraints

- No frontend test framework exists. Each task ends with `npm run build` GREEN (Eleventy generates `_site/` with no error) PLUS a documented browser-verification checklist run against the live app (`docker compose up -d`, `cd api && npm run dev`, `npm run dev`). Do NOT claim a flow works without the browser step.
- Progressive enhancement: never remove a page's existing markup or inline UX JS; add API wiring on top. JS-off must not trigger a destructive server action.
- Same-origin: `api.js` calls `/api` + path with `credentials: "same-origin"`. The session cookie is httpOnly (never read/written by JS). No token in localStorage.
- Anti-enumeration in the UI: login and forgot show a GENERIC localized message; never reveal "unknown email" vs "wrong password".
- Bilingual FR/EN: one shared script per flow; read the language from `document.documentElement.lang`. Error copy is keyed by the backend error `code` (never show the raw English `message` on the FR page).
- NO em dashes anywhere in code, comments, strings, copy. Use commas, parentheses, colons.
- No backend (`api/`) change: the endpoints exist and fit.
- Every task ends committed on branch `frontend-lot1-auth` (do NOT push). Implementers write code + confirm the build; browser verification is the operator's consolidated pass.

---

### Task 1: Socle - api.js client + errors map + pageJs + dev proxy

**Files:**
- Create: `src/assets/js/api.js`, `src/assets/js/errors.js`
- Modify: `src/_includes/base.njk` (add `pageJs` script tag)
- Modify: `.eleventy.js` (dev proxy middleware)
- Modify: `package.json` (add `http-proxy-middleware` devDependency)

**Interfaces:**
- Produces: `api.js` exports `api` (with `.get/.post/.patch/.del`), `apiMultipart(path, formData)`, `session.getMe()`, `ApiError`. `errors.js` exports `localizeError(err, lang)` -> a localized string keyed by `err.code` with a generic fallback. `base.njk` renders `pageJs` as `<script type="module" src="/assets/js/{{ pageJs }}.js"></script>`.

- [ ] **Step 1: Add the dev proxy.** `npm install --save-dev http-proxy-middleware` at the repo root. In `.eleventy.js`, inside the exported function before `return`, add:
```js
const { createProxyMiddleware } = require("http-proxy-middleware");
eleventyConfig.setServerOptions({
  middleware: [
    createProxyMiddleware("/api", { target: "http://localhost:3000", changeOrigin: true, pathRewrite: { "^/api": "" } }),
  ],
});
```
(If `http-proxy-middleware` v3 changes the signature, use `createProxyMiddleware({ pathFilter: "/api", target: "http://localhost:3000", changeOrigin: true, pathRewrite: { "^/api": "" } })`. Pick whichever the installed version supports; verify the version with `node -e "console.log(require('http-proxy-middleware/package.json').version)"`.)

- [ ] **Step 2: Write `src/assets/js/api.js`** (ES module):
```js
export class ApiError extends Error {
  constructor(code, message, details, status) {
    super(message || code);
    this.code = code; this.details = details; this.status = status;
  }
}
async function request(path, { method = "GET", body, headers, multipart } = {}) {
  const opts = { method, credentials: "same-origin", headers: { ...(multipart ? {} : { "Content-Type": "application/json" }), ...headers } };
  if (body !== undefined) opts.body = multipart ? body : JSON.stringify(body);
  const res = await fetch("/api" + path, opts);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data && data.error && data.error.code || "unknown", data && data.error && data.error.message || "", data && data.error && data.error.details, res.status);
  return data;
}
export const api = {
  get: (p) => request(p),
  post: (p, body) => request(p, { method: "POST", body }),
  patch: (p, body) => request(p, { method: "PATCH", body }),
  del: (p) => request(p, { method: "DELETE" }),
};
export function apiMultipart(path, formData) { return request(path, { method: "POST", body: formData, multipart: true }); }
export const session = {
  async getMe() {
    try { return await api.get("/me"); }
    catch (e) { if (e instanceof ApiError && e.status === 401) return null; throw e; }
  },
};
```

- [ ] **Step 3: Write `src/assets/js/errors.js`** (code -> FR/EN copy + generic fallback):
```js
const MAP = {
  validation_error: { fr: "Certaines informations sont invalides.", en: "Some information is invalid." },
  invalid_credentials: { fr: "Identifiant ou mot de passe incorrect.", en: "Incorrect identifier or password." },
  kyc_required: { fr: "Verification d'identite requise.", en: "Identity verification required." },
  file_too_large: { fr: "Un fichier depasse la taille maximale.", en: "A file exceeds the maximum size." },
  rate_limited: { fr: "Trop de tentatives, reessayez plus tard.", en: "Too many attempts, try again later." },
};
export function localizeError(err, lang) {
  const code = err && err.code;
  const entry = code && MAP[code];
  if (entry) return lang === "en" ? entry.en : entry.fr;
  return lang === "en" ? "Something went wrong, please try again." : "Une erreur est survenue, reessayez.";
}
export function pageLang() { return document.documentElement.lang === "en" ? "en" : "fr"; }
```
(The exact set of codes: read the backend error codes the auth/kyc routes return, e.g. in `api/src/modules/auth/routes.ts` and `api/src/lib/http`. Add any that these flows can surface. Login's uniform failure returns a single code, verify it and map it under `invalid_credentials` or its actual code.)

- [ ] **Step 4: Add `pageJs` to `base.njk`.** After the existing `<script src="/assets/js/app.js" defer></script>` line, add:
```njk
{% if pageJs %}<script type="module" src="/assets/js/{{ pageJs }}.js"></script>{% endif %}
```

- [ ] **Step 5: Build + verify.** `npm run build` -> GREEN (Eleventy writes `_site`, no error). Browser check (API + Postgres up, `npm run dev`): open the network tab, run in the devtools console on `localhost:8080`: `fetch("/api/health").then(r=>r.json()).then(console.log)` -> the proxy reaches Fastify and returns `{ status: "ok" }` (the API has `GET /health`). This proves the same-origin proxy works.

- [ ] **Step 6: Commit** - `git add src/assets/js/api.js src/assets/js/errors.js src/_includes/base.njk .eleventy.js package.json package-lock.json && git commit -m "feat(front): api.js client + error map + pageJs + same-origin dev proxy"`

---

### Task 2: Connexion (password + OTP login)

**Files:**
- Create: `src/assets/js/auth-login.js`
- Modify: `src/connexion.html` (+ `src/en/connexion.html`): add `pageJs: auth-login` to front-matter; ensure form field ids match
- Test: browser verification

**Interfaces:**
- Consumes: `api`, `session`, `localizeError`, `pageLang` from Task 1.
- The existing markup (read it first): password form `#pwForm` with `#login-id` (email or phone) + `#login-pw`; an OTP form `#otpForm` with a method toggle (`data-method="email|phone"`), `#otp-id`, `#otpRequest`, `#otp-code`, `#otpRequest`/`#otpResend`, `#otpStart` to reveal it.

- [ ] **Step 1: Read** `src/connexion.html` fully to confirm the element ids and the OTP sub-flow wiring.

- [ ] **Step 2: Write `auth-login.js`.** Import from `./api.js` and `./errors.js`.
  - Password path: on `#pwForm` submit (preventDefault), `await api.post("/auth/login", { identifier: value("#login-id"), password: value("#login-pw") })`. Success -> `location.href = nextParam() || "/dashboard"`. On `ApiError` -> show a GENERIC localized message (do not branch on code beyond the map) in the form's error slot.
  - OTP path: `#otpStart` reveals `#otpForm`; the method toggle sets email/phone; `#otpRequest` -> `await api.post("/auth/otp/request", { identifier, channel })` (verify the exact body the backend `POST /auth/otp/request` expects in `api/src/modules/auth/routes.ts`); reveal the code field; `#otpCode` submit -> `await api.post("/auth/otp/verify", { identifier, code })` -> success redirect. Generic error copy on failure. `#otpResend` re-requests.
  - `nextParam()` reads `?next=` from the URL and only allows a same-site path (starts with `/`, not `//`).
- [ ] **Step 3: Add `pageJs: auth-login`** to both connexion front-matters.
- [ ] **Step 4: Build + verify.** `npm run build` GREEN. Browser: seed a verified account (register one first via Task 3 or a DB insert), log in with email -> lands on `/dashboard`; log in with the phone number -> same; wrong password -> generic message, no leak; OTP request -> the code appears in the API dev logs (mock notifier) -> verify -> logged in.
- [ ] **Step 5: Commit** - `git add src/assets/js/auth-login.js src/connexion.html src/en/connexion.html && git commit -m "feat(front): wire connexion (password + OTP login)"`

---

### Task 3: Inscription + KYC upload

**Files:**
- Create: `src/assets/js/auth-register.js`
- Modify: `src/inscription.html` (+ `src/en/inscription.html`): add `pageJs: auth-register`
- Test: browser verification

**Interfaces:**
- Consumes: `api`, `apiMultipart`, `localizeError`, `pageLang`.
- The existing 3-step wizard (read it first): step 1 account (email, password, firstName, lastName, country, phone?, role checkboxes investor/porteur), step 2 identity (doc type selector driving a dynamic file upload: CNI/titre = recto+verso, passeport = single page; + doc number, dob, nationality), step 3 review + final submit.

- [ ] **Step 1: Read** `src/inscription.html` fully: the field ids/names for each step, the doc-type selector, the dynamic file inputs, and the final submit button.

- [ ] **Step 2: Write `auth-register.js`.** Keep the existing wizard step navigation JS intact (do not rewrite it); only wire the FINAL submit:
  - Gather step-1 fields -> `await api.post("/auth/register", { email, password, firstName, lastName, country, phone, roles })` where `roles` is the checked set (`investor`/`porteur`). On `ApiError` (validation_error / email taken) -> show a localized message on step 1, stop (no KYC attempt).
  - On register success (session now set), build a `FormData`: append `doc_type`, `doc_number`, `dob` (YYYY-MM-DD), `nationality`, and the file inputs under the exact field names the backend expects (`front`/`back` for CNI/titre, `passport_page` for passeport; verify `DOC_KINDS` in `api/src/modules/kyc/routes.ts`). `await apiMultipart("/kyc/submission", fd)`.
  - KYC success -> `location.href = "/dashboard"`. KYC failure (file_too_large / bad MIME) -> the account exists (kyc pending): redirect to `/dashboard?kyc=pending` (Task 5 shows the banner), do NOT re-run register. Show the localized KYC error briefly before redirect, or carry it via the query param.
- [ ] **Step 3: Add `pageJs: auth-register`** to both inscription front-matters.
- [ ] **Step 4: Build + verify.** `npm run build` GREEN. Browser end-to-end: fill step 1 (both roles), step 2 (a CNI with two small valid images + doc fields), submit -> account created, KYC submitted, lands on `/dashboard` (guard passes, name shown once Task 5 lands). Duplicate email -> localized error on step 1. An oversized file -> lands on dashboard with kyc=pending.
- [ ] **Step 5: Commit** - `git add src/assets/js/auth-register.js src/inscription.html src/en/inscription.html && git commit -m "feat(front): wire inscription (register + KYC upload)"`

---

### Task 4: Mot de passe oublie + nouveau mot de passe

**Files:**
- Create: `src/assets/js/auth-reset.js`
- Modify: `src/mot-de-passe-oublie.html` (+ `/en/`), `src/nouveau-mot-de-passe.html` (+ `/en/`): add `pageJs: auth-reset`
- Test: browser verification

**Interfaces:**
- Consumes: `api`, `localizeError`, `pageLang`.
- Existing markup (read first): forgot page has an identifier form (email or phone). New-password page has `#resetForm` (`#pw1`, `#pw2`), `#resetPane`, `#successPane`, `#invalidPane`, plus EXISTING inline JS for the strength meter, show/hide, match check, and pane toggles - keep it.

- [ ] **Step 1: Read** both pages, especially `nouveau-mot-de-passe.html`'s existing inline `<script>` (strength/panes), to wire the API without breaking it.

- [ ] **Step 2: Write `auth-reset.js`.**
  - Forgot page: on the identifier form submit -> `await api.post("/auth/password/forgot", { identifier })`. ALWAYS show the neutral "if an account exists, a link/code was sent" state regardless of result (anti-enumeration); only a network/rate_limited error shows a generic retry message.
  - New-password page: read `token` from `?token=` on load; if absent -> show `#invalidPane`. On `#resetForm` submit (after the existing client-side match/strength checks pass) -> `await api.post("/auth/password/reset", { token, password: value("#pw1") })`. Success -> show `#successPane` (with the connexion link). `ApiError` (invalid/expired token) -> show `#invalidPane`. Coexist with the page's inline UX JS: only attach the submit handler and the token read; do not touch the strength/pane code.
  - The script must detect which page it is on (presence of `#resetForm` vs the forgot form) since both pages share `pageJs: auth-reset`.
- [ ] **Step 3: Add `pageJs: auth-reset`** to all four front-matters.
- [ ] **Step 4: Build + verify.** `npm run build` GREEN. Browser: forgot with any identifier -> neutral screen; grab the reset token from the API dev logs (mock notifier) -> open `/nouveau-mot-de-passe?token=...` -> set a new password -> success pane -> log in with it. Open `/nouveau-mot-de-passe` with no/garbage token -> invalid pane.
- [ ] **Step 5: Commit** - `git add src/assets/js/auth-reset.js src/mot-de-passe-oublie.html src/en/mot-de-passe-oublie.html src/nouveau-mot-de-passe.html src/en/nouveau-mot-de-passe.html && git commit -m "feat(front): wire forgot + reset password"`

---

### Task 5: Session guard + dashboard skeleton + logout

**Files:**
- Create: `src/assets/js/dash-guard.js`
- Modify: `src/_includes/dash-nav.njk` (logout button + name slot + KYC banner slot), and add `pageJs: dash-guard` to the dashboard pages (`src/dashboard.html` + `src/dashboard/*.html` + their `/en/` mirrors)
- Test: browser verification

**Interfaces:**
- Consumes: `api`, `session`, `pageLang`.
- Produces: on every `/dashboard*` page, a guard that redirects to `/connexion?next=<path>` when unauthenticated, fills the user name, and shows a KYC-pending banner.

- [ ] **Step 1: Read** `dash-nav.njk` to place the logout button and a name element + a banner container.

- [ ] **Step 2: Write `dash-guard.js`.** On DOMContentLoaded: `const me = await session.getMe();` if `!me` -> `location.replace("/connexion?next=" + encodeURIComponent(location.pathname))`. Else: set the name element (`me.firstName` + `me.lastName`), and if `me.kycStatus !== "verified"` (verify the field name from `GET /me` shape in `api/src/modules/accounts/routes.ts`) show the KYC banner (localized copy: "Verification en cours" / pending). Wire the logout button: on click -> `await api.post("/auth/logout")` -> `location.href = "/connexion"`.
- [ ] **Step 3: dash-nav.njk:** add a logout `<button id="logout-btn">` (localized label via the existing `isEn` pattern), a name span (`id="dash-user-name"`), and a hidden banner container (`id="kyc-banner"`) with localized text. Add `pageJs: dash-guard` to each dashboard page's front-matter.
- [ ] **Step 4: Build + verify.** `npm run build` GREEN. Browser: visit `/dashboard` logged out -> redirected to `/connexion?next=%2Fdashboard`; log in -> back to a dashboard showing your name; a kyc-pending account shows the banner; click logout -> back to `/connexion`, and `/dashboard` again redirects (session gone).
- [ ] **Step 5: Commit** - `git add src/assets/js/dash-guard.js src/_includes/dash-nav.njk src/dashboard.html src/dashboard/ src/en/dashboard.html src/en/dashboard/ && git commit -m "feat(front): dashboard session guard, name, KYC banner, logout"`

---

## Self-review notes

- **Spec coverage:** socle client + proxy + pageJs + error map (T1); connexion password + OTP (T2); inscription + KYC (T3); forgot + reset (T4); session guard + skeleton + logout (T5). Security section: same-origin cookie (T1), anti-enumeration copy (T2/T4), no token in JS (T1), progressive-enhancement safe (all).
- **No automated tests (honest):** each task ends with `npm run build` green + a concrete browser checklist. Execution note: subagents can write the JS/Njk and confirm the build; the browser verification is a consolidated operator pass (the app must be running with the API + Postgres). Consider inline execution given the interactive verification.
- **Deferred (spec section 9, next lots):** catalog, invest, dashboard data, porteur flows, admin, prod deploy.
- **Consistency:** `api`/`apiMultipart`/`session.getMe`/`ApiError` (T1) consumed by T2-T5; `localizeError(err, lang)`/`pageLang()` (T1) used by all flow scripts; `pageJs` front-matter (T1) used by T2-T5. Backend endpoint bodies (`identifier`/`password`, register fields, KYC multipart field names, `/me` shape, otp request body) must be verified against `api/src` by each implementer before wiring (the plan flags each spot).
- **Reused existing UX JS:** T3 keeps the wizard nav, T4 keeps the strength/pane JS, T2 keeps the OTP toggle markup - the scripts only ADD API calls, never replace the page's own JS.
