# Frontend Lot 2 (Catalog + Invest) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the static Eleventy catalog + project fiche + invest flow to the real API, SEO-indexable via SSG-at-build plus client hydration.

**Architecture:** Eleventy reads the public API at build (`src/_data/projects.js`) and renders real HTML: a catalog with funding + showcase sections, and one paginated fiche per project at `/projet/<id>/` (+`/en/`). Client JS then hydrates volatile data (live amounts, gallery signed URLs, follow/upvote, the invest panel) over the same-origin dev proxy. Progressive enhancement: SEO text is in the static HTML; only live numbers, gallery and invest need JS.

**Tech Stack:** Eleventy 3 (CommonJS `.eleventy.js`, Nunjucks, `htmlTemplateEngine: njk`), Node 24 (global `fetch`), vanilla ES-module page scripts (`pageJs`), same-origin dev proxy (http-proxy-middleware). Backend: Node/TS/Fastify/Drizzle/Postgres/Vitest.

**Spec:** `docs/superpowers/specs/2026-08-31-frontend-lot2-catalog-invest-design.md`

## Global Constraints

- **No em dashes** anywhere (copy or comments): they read as AI-generated. Use commas, colons, or parentheses.
- **Bilingual FR/EN:** one script per flow; language read via `document.documentElement.lang`. Errors localized by **code** (never the raw English backend message). EN fiches may show French project content (porteur text is not translated); only the chrome is EN.
- **Money units:** `*Minor` fields are FCFA (no subdivision; minor == FCFA, factor 1). Format with grouped thousands + ` FCFA`.
- **Same-origin, httpOnly cookie:** the client never reads a token; `credentials: "same-origin"`. No secrets in JS.
- **No PII, no signed URLs baked at build:** photo signed URLs (short TTL) are only ever hydrated client-side, never written into static HTML. The public projection exposes no porteur identity.
- **Regulatory guardrail:** the funding catalog is never ordered by votes; funding cards show no upvote/follow (the API omits them).
- **Verification model:** no frontend test framework. Frontend tasks verify with `npm run build` green + a browser pass through the proxy + `curl` of the static HTML for SEO content. The backend task (Task 1) uses real Vitest TDD. Never run two suite-executing processes against the shared `kpital_test` DB.
- **Commit/push only when asked. Never `git add docs` broadly** (untracked strategy docs must stay untracked): stage exact paths.
- Implementers use opus. Task 5 (money path) gets an opus adversarial reviewer.

---

## File Structure

- `api/src/modules/projects/service.ts` (MODIFY) - add `fundsUsage`, `cautionType` to both public projections. Backend, Task 1.
- `api/src/modules/projects/routes.test.ts` or a new `projects-public.test.ts` (TEST) - assert the two fields appear and sensitive fields do not. Task 1.
- `src/_data/projects.js` (CREATE) - build-time fetch of funding+showcase, `surface` marker, `[]` fallback. Task 2.
- `src/assets/js/fmt.js` (CREATE) - pure formatters `money`, `progressPct`, `estRoi`, `escapeHtml`. Task 2.
- `scripts/seed-projects.mjs` (CREATE) - dev seed: one showcase + one collecting project via the API, prints their ids. Task 2.
- `src/projets.html` + `src/en/projets.html` (MODIFY) - Nunjucks templates rendering cards from `projects`, two sections, `pageJs: catalog`. Task 3.
- `src/assets/js/catalog.js` (CREATE) - live re-render + sector filter + sort. Task 3.
- `src/assets/js/errors.js` (MODIFY) - add Lot 2 error codes (Task 3: `not_found`; Task 5: invest codes).
- `src/projet.njk` + `src/en/projet.njk` (CREATE) - paginated fiche per project, `/projet/<id>/`. Task 4.
- `src/projet.html` + `src/en/projet.html` (DELETE) - replaced by the paginated templates. Task 4.
- `src/assets/js/project.js` (CREATE) - hydrate numbers + gallery + engagement; host the invest panel wiring added in Task 5. Task 4 (+5).
- `src/investir-confirmation.html` + `src/en/investir-confirmation.html` (MODIFY) - `pageJs: confirmation`, id hooks. Task 5.
- `src/assets/js/confirmation.js` (CREATE) - read sessionStorage, fill the success card. Task 5.

---

### Task 1: Backend - expose fundsUsage + cautionType on the public projections

**Files:**
- Modify: `api/src/modules/projects/service.ts` (the `PUBLIC_PROJECT_COLUMNS` and `FUNDING_PROJECT_COLUMNS` consts near line 175-215)
- Test: `api/tests/modules/projects/public-projection.test.ts` (new; match the existing tests' import style and `buildTestApp` helper)

**Interfaces:**
- Consumes: existing `projects.fundsUsage`, `projects.cautionType` columns (already in schema, non-null text).
- Produces: `GET /projects/funding`, `/projects/showcase`, `/projects/:id` responses now include `fundsUsage: string` and `cautionType: string` on each project. No other field added; no schema/migration change.

- [ ] **Step 1: Read** `api/src/modules/projects/service.ts` lines ~175-260 to confirm the exact shape of `PUBLIC_PROJECT_COLUMNS`, `FUNDING_PROJECT_COLUMNS`, and that `getPublicProject` selects `PUBLIC_PROJECT_COLUMNS`. Read one existing projects test (e.g. under `api/tests/modules/projects/`) to copy the seeding + `buildTestApp` + inject pattern.

- [ ] **Step 2: Write the failing test** `api/tests/modules/projects/public-projection.test.ts`. Seed one collecting project and one showcase project with distinct `fundsUsage`/`cautionType` values, then assert the three public endpoints expose them and never leak sensitive columns:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { buildTestApp } from "../../helpers/app";
// ... plus whatever seeding helpers the sibling tests use.

describe("public project projection exposes fundsUsage + cautionType", () => {
  it("funding list, showcase list and detail all include the two public trust fields and no sensitive ones", async () => {
    const app = await buildTestApp();
    // Seed a collecting project and a showcase project with known values.
    // (Reuse the sibling test's project-creation helper; set
    //  fundsUsage: "Achat de stock et amenagement", cautionType: "Caution solidaire".)
    const collectingId = await seedProject(app, { status: "collecting", fundsUsage: "Achat de stock", cautionType: "Caution solidaire" });
    const showcaseId  = await seedProject(app, { status: "showcase",   fundsUsage: "Travaux",        cautionType: "Nantissement" });

    const funding = await app.inject({ method: "GET", url: "/projects/funding" });
    const fundingBody = funding.json();
    const fp = fundingBody.projects.find((p: any) => p.id === collectingId);
    expect(fp.fundsUsage).toBe("Achat de stock");
    expect(fp.cautionType).toBe("Caution solidaire");
    expect(fp).not.toHaveProperty("ownerAccountId");
    expect(fp).not.toHaveProperty("rejectReason");

    const showcase = await app.inject({ method: "GET", url: "/projects/showcase" });
    const sp = showcase.json().projects.find((p: any) => p.id === showcaseId);
    expect(sp.fundsUsage).toBe("Travaux");
    expect(sp.cautionType).toBe("Nantissement");

    const detail = await app.inject({ method: "GET", url: `/projects/${collectingId}` });
    const dp = detail.json().project;
    expect(dp.fundsUsage).toBe("Achat de stock");
    expect(dp.cautionType).toBe("Caution solidaire");
    expect(dp).not.toHaveProperty("ownerAccountId");
    expect(dp).not.toHaveProperty("storageKey");
  });
});
```

Adapt `seedProject` to the sibling tests' actual helper (they already create projects and move them through moderation). If no reusable helper exists, insert rows directly via `app.db` using the schema, setting status and the two fields.

- [ ] **Step 3: Run the test to confirm it fails** - `cd api && npx vitest run tests/modules/projects/public-projection.test.ts` - Expected: FAIL (`fp.fundsUsage` is `undefined`).

- [ ] **Step 4: Add the two columns** to both consts in `service.ts`:

```ts
export const PUBLIC_PROJECT_COLUMNS = {
  // ... existing columns ...
  fundsUsage: projects.fundsUsage,
  cautionType: projects.cautionType,
} as const;

export const FUNDING_PROJECT_COLUMNS = {
  // ... existing columns ...
  fundsUsage: projects.fundsUsage,
  cautionType: projects.cautionType,
} as const;
```

- [ ] **Step 5: Run the test to confirm it passes** - `npx vitest run tests/modules/projects/public-projection.test.ts` - Expected: PASS.

- [ ] **Step 6: Run the full backend suite** - `cd api && npm test` (timeout >= 200s) - Expected: all green (no snapshot/shape test elsewhere breaks on the added fields; if one asserts an exact object shape, update it to include the two fields).

- [ ] **Step 7: Commit** - `git add api/src/modules/projects/service.ts api/tests/modules/projects/public-projection.test.ts && git commit -m "feat(api): expose fundsUsage + cautionType on the public project projection"`

---

### Task 2: Build data source + shared formatters + seed tooling

**Files:**
- Create: `src/_data/projects.js`
- Create: `src/assets/js/fmt.js`
- Create: `scripts/seed-projects.mjs`

**Interfaces:**
- Produces: a global `projects` array available to all templates, each item = one API project plus `surface: "funding" | "showcase"`. Empty `[]` when the API is unreachable.
- Produces: `fmt.js` exports `money(minor, lang)`, `progressPct(raisedMinor, targetMinor)`, `estRoi(amountMinor, roiPct, months)`, `escapeHtml(s)`.
- Produces: `scripts/seed-projects.mjs` prints `SHOWCASE_ID=<uuid>` and `COLLECTING_ID=<uuid>` for browser verification in later tasks.

- [ ] **Step 1: Write `src/_data/projects.js`.** Build-time fetch of both public lists, tolerant of an absent API:

```js
// Build-time data: fetch the public catalog so Eleventy can render SEO HTML for
// the catalog and one fiche per project. If the API is unreachable (frontend-only
// CI), return [] so `npm run build` stays green and the client hydrates live.
const BASE = process.env.BUILD_API_URL || "http://localhost:3000";

async function fetchList(surface) {
  try {
    const res = await fetch(`${BASE}/projects/${surface}`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.projects || []).map((p) => ({ ...p, surface }));
  } catch {
    return []; // API down at build: the page ships as a shell, client fills it.
  }
}

module.exports = async function () {
  const [funding, showcase] = await Promise.all([fetchList("funding"), fetchList("showcase")]);
  // Dedupe by id defensively (a project is only ever on one surface).
  const seen = new Set();
  return [...funding, ...showcase].filter((p) => (seen.has(p.id) ? false : seen.add(p.id)));
};
```

- [ ] **Step 2: Verify the data file both ways.**
  - API up (dev API running): `BUILD_API_URL=http://localhost:3000 node -e "require('./src/_data/projects.js')().then(p=>console.log('count', p.length, p[0] && Object.keys(p[0])))"` - Expected: a count and keys including `surface`, `fundsUsage`, `cautionType`.
  - API down: `BUILD_API_URL=http://127.0.0.1:59999 node -e "require('./src/_data/projects.js')().then(p=>console.log('fallback', p.length))"` - Expected: `fallback 0`.

- [ ] **Step 3: Write `src/assets/js/fmt.js`** (pure, no imports):

```js
// Shared formatters. Amounts are FCFA (minor == FCFA, no subdivision).
export function money(minor, lang) {
  const n = Number(minor) || 0;
  // Grouped thousands with a narrow no-break space, then the currency.
  const grouped = n.toLocaleString(lang === "en" ? "en-US" : "fr-FR").replace(/,/g, " ");
  return grouped + " FCFA";
}
export function progressPct(raisedMinor, targetMinor) {
  const t = Number(targetMinor) || 0;
  if (t <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((Number(raisedMinor) / t) * 100)));
}
// Indicative estimated gain (client-side only, not authoritative): capital * roi% * years.
export function estRoi(amountMinor, roiPct, months) {
  const gain = (Number(amountMinor) || 0) * (Number(roiPct) / 100) * ((Number(months) || 0) / 12);
  return Math.round(gain);
}
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
```

- [ ] **Step 4: Smoke-test fmt.js** - `node --input-type=module -e "import('./src/assets/js/fmt.js').then(m=>{console.log(m.money(1250000,'fr'), '|', m.progressPct(3300000,4500000)+'%', '|', m.estRoi(50000,11,24))})"` - Expected: a grouped `1 250 000 FCFA`-style string, `73%`, and `11000`.

- [ ] **Step 5: Write `scripts/seed-projects.mjs`.** A dev-only script that registers a porteur, creates a project, uploads a public photo, submits it, then (as admin) approves it to showcase and opens one to collecting. Use the same endpoints Lot 1 used through the proxy or hit `BUILD_API_URL` directly. Model each request on `api/src/modules/projects/routes.ts` + `admin-routes.ts` request shapes (read them first). Print `SHOWCASE_ID=<uuid>` and `COLLECTING_ID=<uuid>` at the end. Keep credentials/dev values inline (dev only). If a fully-scripted admin path is impractical, script through the moderation endpoints the admin tests exercise. This script is verification tooling, not shipped in `_site`.

- [ ] **Step 6: Run the seed** - `node scripts/seed-projects.mjs` (API + Postgres up) - Expected: prints the two ids and the projects are visible via `curl -s localhost:3000/projects/showcase` / `funding`.

- [ ] **Step 7: Build green** - `npm run build` (API up) - Expected: GREEN, and `_site` now contains catalog data (verified in Task 3). Commit - `git add src/_data/projects.js src/assets/js/fmt.js scripts/seed-projects.mjs && git commit -m "feat(front): build-time projects data source, shared formatters, seed script"`

---

### Task 3: Catalog - SSG cards (two sections) + live re-render + filter/sort

**Files:**
- Modify: `src/projets.html`, `src/en/projets.html`
- Create: `src/assets/js/catalog.js`
- Modify: `src/assets/js/errors.js` (add `not_found`)

**Interfaces:**
- Consumes: the `projects` global (Task 2), `fmt.js`, `api` from `api.js`.
- Produces: `/projets/` and `/en/projets/` with real SSG cards (SEO) that the client re-renders from live data; sector filter + sort work on the live set. Cards link to `/projet/<id>/` (+`/en/`).

- [ ] **Step 1: Read** the current `src/projets.html` (card markup, `#grid`, `.chip[data-filter]`, `#sort`, `#results`, `#empty`, and the inline filter/sort IIFE) so the template and `catalog.js` reproduce the same classes/attributes and the same filter/sort behavior.

- [ ] **Step 2: Template the catalog.** In `src/projets.html`, add `pageJs: catalog` to the front-matter and replace the 6 hardcoded cards with two Nunjucks sections rendered from `projects`. A funding card (with progress) and a showcase card (with follow/upvote counts, no progress). Emit the same `data-*` hooks the sort/filter read. Funding section:

```njk
<div class="projects" id="grid-funding">
{%- for p in projects if p.surface == "funding" %}
  <a class="pcard" href="{{ langPrefix }}/projet/{{ p.id }}/" data-type="{{ p.category }}" data-roi="{{ p.roiPct }}" data-progress="{{ ((p.raisedMinor / p.targetMinor) * 100) | round }}" data-duration="{{ p.durationMonths }}">
    <div class="pcard-head">
      <span class="pcard-sector">{{ p.category | capitalize }}</span>
      {%- if p.score %}<span class="tag tag-green">Note {{ p.score }}</span>{% endif %}
    </div>
    <h3 class="pcard-name">{{ p.title }}</h3>
    <p class="pcard-meta">{{ p.city }}{% if p.quartier %}, {{ p.quartier }}{% endif %} &middot; <span class="num">{{ p.durationMonths }}</span> {{ "months" if isEn else "mois" }}</p>
    <div class="pcard-roi"><span class="v num">{{ p.roiPct }}%</span><span class="u">{{ "est. ROI / yr" if isEn else "ROI estimé / an" }}</span></div>
    <div class="pcard-progress" data-raised="{{ p.raisedMinor }}" data-target="{{ p.targetMinor }}">
      <div class="pbar"><i style="width:{{ ((p.raisedMinor / p.targetMinor) * 100) | round }}%"></i></div>
      <div class="pmeta"><span class="pmeta-pct"><span class="num">{{ ((p.raisedMinor / p.targetMinor) * 100) | round }}%</span> {{ "raised" if isEn else "collecté" }}</span></div>
    </div>
    <div class="pcard-foot"><span class="ticket">{{ "Min ticket" if isEn else "Ticket min" }} &middot; <strong class="num">10 000 FCFA</strong></span><span class="pcard-go">{{ "View →" if isEn else "Voir la fiche →" }}</span></div>
  </a>
{%- else %}
{%- endfor %}
</div>
```

Add a parallel `#grid-showcase` section under a heading ("À découvrir" / "Discover") looping `if p.surface == "showcase"`, rendering `upvoteCount`/`followCount` instead of a progress bar. Add loading + `#empty` states. Mirror all copy in `src/en/projets.html` (English strings; `langPrefix` handles the `/en` link prefix). Remove the old inline filter/sort IIFE (it moves into `catalog.js`).

- [ ] **Step 3: Write `catalog.js`.** On load: render from the live API (replacing the SSG cards for freshness; the SSG HTML remains the SEO + no-JS fallback), then wire filter + sort:

```js
import { api } from "./api.js";
import { money, progressPct } from "./fmt.js";

const lang = document.documentElement.lang || "fr";
const isEn = lang === "en";
const prefix = isEn ? "/en" : "";

function fundingCard(p) {
  const pct = progressPct(p.raisedMinor, p.targetMinor);
  // Build the same markup as the njk template (kept in sync intentionally).
  return `<a class="pcard" href="${prefix}/projet/${p.id}/" data-type="${p.category}" data-roi="${p.roiPct}" data-progress="${pct}" data-duration="${p.durationMonths}"> ... </a>`;
}
function showcaseCard(p) { /* upvote/follow counts, no progress */ }

async function render() {
  try {
    const [f, s] = await Promise.all([api.get("/projects/funding"), api.get("/projects/showcase")]);
    const gf = document.getElementById("grid-funding");
    const gs = document.getElementById("grid-showcase");
    if (gf) gf.innerHTML = f.projects.map(fundingCard).join("");
    if (gs) gs.innerHTML = s.projects.map(showcaseCard).join("");
  } catch (_e) {
    // Keep the SSG cards on failure; just wire filter/sort over what is there.
  }
  wireFilterSort();
}
function wireFilterSort() { /* port the old IIFE: chips toggle card.hidden by data-type; #sort reorders by data-roi/-progress/-duration; update #results and #empty */ }

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", render);
else render();
```

Fill in `fundingCard`/`showcaseCard` to mirror the njk markup exactly (same classes/data attrs), and port the filter/sort logic verbatim from the old inline script.

- [ ] **Step 4: Add `not_found` to `errors.js`** MAP: `{ fr: "Projet introuvable.", en: "Project not found." }`.

- [ ] **Step 5: SSG verification (SEO)** - with the API seeded (Task 2) run `npm run build`, then `grep -o '<h3 class="pcard-name">[^<]*' _site/projets/index.html | head` - Expected: real seeded project titles present in the static HTML (proves catalog is indexable without JS).

- [ ] **Step 6: Browser verification** - serve (`npm run dev`), open `http://localhost:8080/projets/`: both sections render, sector chips filter, sort reorders, `#results` updates; cards link to `/projet/<id>/`. Repeat `/en/projets/`.

- [ ] **Step 7: Build green + commit** - `npm run build` GREEN. `git add src/projets.html src/en/projets.html src/assets/js/catalog.js src/assets/js/errors.js && git commit -m "feat(front): catalog SSG cards + live re-render + filter/sort"`

---

### Task 4: Fiche - paginated per-project pages + hydration + engagement

**Files:**
- Create: `src/projet.njk`, `src/en/projet.njk`
- Delete: `src/projet.html`, `src/en/projet.html`
- Create: `src/assets/js/project.js`

**Interfaces:**
- Consumes: `projects` global (pagination source), `fmt.js`, `api`, `session` from `api.js`, `localizeError` from `errors.js`.
- Produces: `/projet/<id>/` and `/en/projet/<id>/` static pages with SEO text (title, description, fundsUsage, cautionType, metrics), hydrated live (amounts, gallery, follow/upvote). Invest panel markup present but wired in Task 5.

- [ ] **Step 1: Read** the current `src/projet.html` to reuse its section markup (`.proj-head`, `.metrics`, `.gallery`, description block, score block, `.docs`, invest `.invest-card`, `#amount`, `.quick-amt`, `#investBtn`, the ROI IIFE) and its CSS classes (`pageCss: projet`). Note the sections to DROP per spec §9 (tranches, experts, named porteur).

- [ ] **Step 2: Create `src/projet.njk`** paginating `projects`, one fiche per project, SEO via `eleventyComputed`:

```njk
---
layout: base.njk
pagination:
  data: projects
  size: 1
  alias: project
permalink: "/projet/{{ project.id }}/"
pageCss: projet
pageJs: project
ogType: article
eleventyComputed:
  title: "{{ project.title }} | KPITAL"
  description: "{{ project.description | striptags | truncate(155, true, '') }}"
---
<article class="proj" data-project-id="{{ project.id }}" data-roi="{{ project.roiPct }}" data-duration="{{ project.durationMonths }}" data-surface="{{ project.surface }}">
  <section class="proj-head">
    <h1 class="proj-title">{{ project.title }}</h1>
    <div class="proj-facts">
      <span>{{ project.city }}{% if project.quartier %}, {{ project.quartier }}{% endif %}</span>
      <span class="num">{{ project.durationMonths }}</span> mois
      {% if project.score %}<span class="tag tag-green">Note {{ project.score }}</span>{% endif %}
    </div>
    <div class="proj-head-actions">
      <button type="button" class="btn btn-ghost btn-sm" id="followBtn" hidden>Sauvegarder</button>
      {% if project.surface == "showcase" %}<button type="button" class="btn btn-ghost btn-sm" id="upvoteBtn" hidden>Soutenir (<span id="upvoteCount">{{ project.upvoteCount }}</span>)</button>{% endif %}
    </div>
    <div class="metrics">
      <div class="metric"><span class="k">ROI</span><span class="v num">{{ project.roiPct }}%</span></div>
      <div class="metric"><span class="k">Objectif</span><span class="v num" id="mTarget">{{ project.targetMinor }}</span></div>
      <div class="metric"><span class="k">Collecté</span><span class="v num" id="mRaised">{{ project.raisedMinor }}</span></div>
    </div>
  </section>
  <div class="proj-grid">
    <div class="proj-main">
      <div class="block gallery" id="gallery"><!-- hydrated with signed photo URLs --></div>
      <div class="block"><h2>Le projet</h2><p>{{ project.description }}</p></div>
      <div class="block"><h2>Utilisation des fonds</h2><p>{{ project.fundsUsage }}</p></div>
      <div class="block"><h2>Garantie</h2><p>{{ project.cautionType }}</p></div>
      <div class="block"><h2>Documents</h2><ul class="docs" id="docs"><!-- hydrated --></ul></div>
    </div>
    <aside class="invest">
      {% include "invest-panel.njk" %}
    </aside>
  </div>
</article>
```

Keep the invest panel markup inline (or as an include) from the old page: `#amount`, `.quick-amt`, the ROI rows (`#roiCapital`/`#roiGain`/`#roiTotal`), plus a NEW source selector (`<select id="investSource"><option value="payment">...<option value="wallet">`), and `#investBtn` WITHOUT the old `onclick`. Add a `#investMsg` element for errors and a `#kycGate` hidden banner. Metrics render raw minor values into `#mTarget`/`#mRaised`; `project.js` reformats them with `fmt.money` on load (so no-JS shows a number, JS shows grouped FCFA).

- [ ] **Step 3: Create `src/en/projet.njk`** - same pagination over `projects`, `permalink: "/en/projet/{{ project.id }}/"`, English chrome copy. (Project text stays French.)

- [ ] **Step 4: Delete** `src/projet.html` and `src/en/projet.html`.

- [ ] **Step 5: Write `project.js`** (render/hydration + engagement; invest wiring stubbed for Task 5):

```js
import { api, session } from "./api.js";
import { money, progressPct } from "./fmt.js";

const root = document.querySelector(".proj");
const id = root && root.dataset.projectId;
const lang = document.documentElement.lang || "fr";

function setMoney(elId, minor) { const el = document.getElementById(elId); if (el) el.textContent = money(minor, lang); }

async function hydrate() {
  if (!id) return;
  // Reformat SSG raw numbers immediately.
  setMoney("mTarget", root.querySelector("#mTarget")?.textContent);
  setMoney("mRaised", root.querySelector("#mRaised")?.textContent);
  let detail;
  try { detail = await api.get("/projects/" + id); }
  catch (e) { /* 404 -> show a not_found notice + link to /projets; return */ return; }
  const p = detail.project;
  setMoney("mTarget", p.targetMinor);
  setMoney("mRaised", p.raisedMinor);
  // progress bar, remaining, investor count if present
  renderGallery(detail.documents.filter(d => d.mime.startsWith("image/")));
  renderDocs(detail.documents.filter(d => d.mime === "application/pdf"));
  await wireEngagement(p);
  // invest panel wiring added in Task 5:
  if (window.__kpInvest) window.__kpInvest(p);
}
function renderGallery(imgs) { const g = document.getElementById("gallery"); if (g) g.innerHTML = imgs.map(d => `<img class="gthumb" src="${d.url}" alt="" loading="lazy">`).join(""); }
function renderDocs(pdfs) { /* list links with d.url */ }
async function wireEngagement(p) {
  const me = await session.getMe();
  const followBtn = document.getElementById("followBtn");
  const upvoteBtn = document.getElementById("upvoteBtn");
  if (!me) return; // engagement requires auth; leave buttons hidden
  const state = await api.get("/projects/" + id + "/me");
  if (followBtn) { followBtn.hidden = false; reflectFollow(followBtn, state.following);
    followBtn.addEventListener("click", async () => { const r = state.following ? await api.del("/projects/"+id+"/follow") : await api.post("/projects/"+id+"/follow"); state.following = r.following; reflectFollow(followBtn, r.following); }); }
  if (upvoteBtn && p.surface === "showcase") { upvoteBtn.hidden = false; reflectUpvote(upvoteBtn, state.upvoted);
    upvoteBtn.addEventListener("click", async () => { const r = state.upvoted ? await api.del("/projects/"+id+"/upvote") : await api.post("/projects/"+id+"/upvote"); state.upvoted = r.upvoted; reflectUpvote(upvoteBtn, r.upvoted); }); }
}
function reflectFollow(btn, on) { btn.classList.toggle("is-on", on); btn.textContent = on ? (lang==="en"?"Saved":"Enregistré") : (lang==="en"?"Save":"Sauvegarder"); }
function reflectUpvote(btn, on) { btn.classList.toggle("is-on", on); }

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hydrate);
else hydrate();
```

Keep the invest ROI calculator from the old inline script inside the panel wiring (reused in Task 5). Flesh out the 404 notice, remaining/investor-count rendering, and doc list.

- [ ] **Step 6: SSG verification (SEO)** - `npm run build` (seeded API), then for a seeded id: `grep -c "Utilisation des fonds" _site/projet/<COLLECTING_ID>/index.html` and `grep -o "<title>[^<]*" _site/projet/<COLLECTING_ID>/index.html` - Expected: the fundsUsage block and a per-project `<title>` are in the static HTML.

- [ ] **Step 7: Browser verification** - open `http://localhost:8080/projet/<COLLECTING_ID>/`: metrics reformat to grouped FCFA, gallery loads via signed URLs, description/fundsUsage/cautionType shown; logged in, follow toggles and reflects state; on a showcase id, upvote toggles. Repeat `/en/projet/<id>/`.

- [ ] **Step 8: Build green + commit** - `npm run build` GREEN. `git add src/projet.njk src/en/projet.njk src/assets/js/project.js && git rm src/projet.html src/en/projet.html && git commit -m "feat(front): paginated project fiches (SSG + hydration + engagement)"`

---

### Task 5: Invest money path + confirmation

**Files:**
- Modify: `src/assets/js/project.js` (add the invest panel wiring: `window.__kpInvest`)
- Modify: `src/investir-confirmation.html`, `src/en/investir-confirmation.html`
- Create: `src/assets/js/confirmation.js`
- Modify: `src/assets/js/errors.js` (invest codes)

**Interfaces:**
- Consumes: `api`, `session`, `fmt.estRoi`, `localizeError`.
- Produces: a working invest flow (auth gate -> KYC gate -> invest -> sessionStorage -> confirmation), and a confirmation page populated from sessionStorage.

- [ ] **Step 1: Add invest error codes to `errors.js`** MAP (FR/EN): `below_min_ticket` ("Montant sous le ticket minimum de 10 000 FCFA." / "Amount is below the 10,000 FCFA minimum ticket."), `exceeds_remaining` ("Le montant depasse le restant a collecter." / "Amount exceeds the remaining to collect."), `insufficient_funds` ("Solde insuffisant." / "Insufficient balance."), `payment_failed` ("Le paiement a echoue. Reessayez." / "Payment failed. Try again."), `invalid_state` ("Ce projet n'est pas en collecte." / "This project is not collecting."). `kyc_required` already exists.

- [ ] **Step 2: Wire the invest panel** in `project.js` as `window.__kpInvest = function(p) {...}` (called by `hydrate()` with the live project). Reuse the ROI calculator (`#amount`, `.quick-amt`, `#roiCapital/#roiGain/#roiTotal` via `fmt.estRoi`). On `#investBtn` click, apply the gate:

```js
window.__kpInvest = function (p) {
  const amountEl = document.getElementById("amount");
  const sourceEl = document.getElementById("investSource");
  const btn = document.getElementById("investBtn");
  const msg = document.getElementById("investMsg");
  const gate = document.getElementById("kycGate");
  // ... reuse ROI calc + quick amounts ...

  async function gateAndCheck() {
    const me = await session.getMe();
    if (!me) { location.href = prefix + "/connexion/?next=" + encodeURIComponent(location.pathname); return null; }
    if (me.kycStatus !== "verified") { if (gate) gate.hidden = false; btn.disabled = true; return null; }
    return me;
  }

  async function submit(confirmCap) {
    const me = await gateAndCheck(); if (!me) return;
    const amountMinor = parseInt(amountEl.value, 10);
    const source = sourceEl.value; // "payment" | "wallet"
    try {
      const r = await api.post("/projects/" + p.id + "/invest", { amountMinor, source, ...(confirmCap ? { confirmCapToRemaining: true } : {}) });
      sessionStorage.setItem("kp.invest", JSON.stringify({ projectId: p.id, title: p.title, amountMinor: r.amountMinor, roiPct: p.roiPct, durationMonths: p.durationMonths, status: r.status }));
      location.href = prefix + "/investir/confirmation/";
    } catch (e) {
      if (e.code === "exceeds_remaining") {
        const rem = e.details && e.details.remainingMinor;
        // confirm "il ne reste que <rem> - investir <rem> ?" then submit(true)
        if (rem != null && confirmInline(rem)) { amountEl.value = String(rem); return submit(true); }
        return;
      }
      showInvestError(msg, e); // localizeError by code
    }
  }
  btn.addEventListener("click", () => submit(false));
};
```

Add `prefix`/`session`/`localizeError` imports at the top of `project.js` as needed. `confirmInline` renders an inline confirm affordance (not a browser `confirm()` dialog).

- [ ] **Step 3: Add id hooks to the invest panel markup** (in `projet.njk` from Task 4, or here): `#investSource` selector, `#investMsg`, `#kycGate` hidden banner with localized "terminez votre verification" + link to `/dashboard/`. (If simpler, these were already added in Task 4 Step 2; ensure they exist.)

- [ ] **Step 4: Wire the confirmation page.** In `src/investir-confirmation.html` add `pageJs: confirmation` and give the dynamic values ids (`#cProject`, `#cAmount`, `#cRoi`, `#cDue`, plus a neutral fallback block `#cFallback` hidden). Mirror in `src/en/`. Write `src/assets/js/confirmation.js`:

```js
import { money, estRoi } from "./fmt.js";
const lang = document.documentElement.lang || "fr";
let data = null;
try { data = JSON.parse(sessionStorage.getItem("kp.invest") || "null"); sessionStorage.removeItem("kp.invest"); } catch (_e) {}
if (!data) {
  const fb = document.getElementById("cFallback"); if (fb) fb.hidden = false;
  // hide the details card
} else {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set("cProject", data.title);
  set("cAmount", money(data.amountMinor, lang));
  set("cRoi", "+" + money(estRoi(data.amountMinor, data.roiPct, data.durationMonths), lang));
}
```

- [ ] **Step 5: Browser verification (the money path)** - with a seeded collecting project and the dev servers up:
  - Logged out, click Investir -> redirected to `/connexion/?next=/projet/<id>/`.
  - Logged in, KYC pending -> `#kycGate` shown, button disabled.
  - Logged in + verified (verify a seeded account via admin, or reuse the dashboard test flow), invest a valid amount -> `201` -> lands on `/investir/confirmation/` with project/amount/ROI populated.
  - Invest an amount above the remaining -> `exceeds_remaining` -> inline "invest the remaining?" -> confirm -> success.
  - Direct visit `/investir/confirmation/` with empty sessionStorage -> neutral fallback.
  - Repeat the happy path in `/en/`.

- [ ] **Step 6: Build green + commit** - `npm run build` GREEN. `git add src/assets/js/project.js src/assets/js/confirmation.js src/assets/js/errors.js src/investir-confirmation.html src/en/investir-confirmation.html && git commit -m "feat(front): invest money path + confirmation"`

- [ ] **Step 7: Opus adversarial review** of the invest path: confirm the gate order (auth before KYC before invest), that `exceeds_remaining` re-submit caps correctly and cannot loop, that no amount is placed in a URL, that a failed invest never navigates to confirmation, and that sessionStorage is cleared one-shot. Address findings before finishing.

---

## Self-review notes

- **Spec coverage:** §1 SSG+hydration (T2 data + T3/T4 templates + JS hydration); §3 API shapes (all tasks, verified against `api/src`); §4 files (T2-T5 create the listed files); §5 invest path (T5); §6 security (no URL amounts T5, signed URLs hydrated only T4, no PII T1/T4, guardrail T3); §8 backend projection (T1); §9 dropped sections (T4 Step 1/2); §10 verification (build+curl+browser each task; T1 Vitest). §11 deferred items are not implemented by design.
- **No automated frontend tests (honest):** each frontend task ends with `npm run build` green + a `curl` SSG check (SEO) + a browser checklist. Task 1 is real backend TDD. The browser passes need the API + Postgres up and seeded (Task 2's `scripts/seed-projects.mjs`). Consider inline execution for the interactive browser verification.
- **Consistency:** `projects` global (T2) consumed by T3/T4 templates; `fmt.js` (T2) by T3/T4/T5; `api`/`session`/`ApiError` (Lot 1) by all JS; `errors.js` extended additively (T3 `not_found`, T5 invest codes); `pageJs` (Lot 1) by all pages; card markup is intentionally duplicated between the njk template and `catalog.js` (kept in sync) because the catalog re-renders live for freshness while the SSG HTML serves SEO + no-JS.
- **Backend touch is minimal and isolated (T1):** two columns added to two projection consts, real Vitest coverage, no schema/migration.
- **URL decision:** clean `/projet/<id>/` via pagination supersedes the earlier `?id=` (SSG makes real files, so no rewrite is needed and it is better for SEO). `project.js` reads the id from `data-project-id`, not the path.
