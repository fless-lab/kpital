// Catalog page (/projets/, /en/projets/). The SSG cards rendered by projets.html
// are the SEO + no-JS fallback; on load this re-renders both grids from the live
// API for freshness, then wires the sector chips + sort over whatever cards end
// up in the DOM (freshly fetched, or the SSG cards if the fetch failed).
import { api } from "./api.js";
import { progressPct, escapeHtml } from "./fmt.js";

const lang = document.documentElement.lang || "fr";
const isEn = lang === "en";
const prefix = isEn ? "/en" : "";

const CAT_LABELS = isEn
  ? { immobilier: "Real estate", commerce: "Trade", agriculture: "Agriculture" }
  : { immobilier: "Immobilier", commerce: "Commerce", agriculture: "Agriculture" };

function catLabel(category) {
  return CAT_LABELS[category] || escapeHtml(category);
}

// Same rating-tag rule as the njk template: grade A (and A-, A+...) gets the
// green tag, everything else the plain one.
function scoreTag(p) {
  if (!p.score) return "";
  const cls = String(p.score)[0] === "A" ? "tag tag-green" : "tag";
  const label = (isEn ? "Rating" : "Note") + " " + escapeHtml(p.score);
  return `<span class="${cls}">${label}</span>`;
}

function metaLine(p) {
  const place = p.quartier ? `${escapeHtml(p.city)}, ${escapeHtml(p.quartier)}` : escapeHtml(p.city);
  const unit = isEn ? "months" : "mois";
  return `${place} · <span class="num">${Number(p.durationMonths) || 0}</span> ${unit}`;
}

// Platform-wide minimum ticket, not per-project data: kept literal (not routed
// through fmt.money) so the njk and JS output are byte-identical regardless of
// Intl formatting quirks.
function minTicket() {
  return isEn ? "10,000 FCFA" : "10 000 FCFA";
}

function fundingCard(p) {
  const pct = progressPct(p.raisedMinor, p.targetMinor);
  return `<a class="pcard" href="${prefix}/projet/${p.id}/" data-type="${escapeHtml(p.category)}" data-roi="${p.roiPct}" data-progress="${pct}" data-duration="${p.durationMonths}">
    <div class="pcard-head">
      <span class="pcard-sector">${catLabel(p.category)}</span>
      ${scoreTag(p)}
    </div>
    <h3 class="pcard-name">${escapeHtml(p.title)}</h3>
    <p class="pcard-meta">${metaLine(p)}</p>
    <div class="pcard-roi">
      <span class="v num">${p.roiPct}%</span>
      <span class="u">${isEn ? "Estimated ROI / year" : "ROI estimé / an"}</span>
    </div>
    <div class="pcard-progress" data-raised="${p.raisedMinor}" data-target="${p.targetMinor}">
      <div class="pbar"><i style="width:${pct}%"></i></div>
      <div class="pmeta">
        <span class="pmeta-pct"><span class="num">${pct}%</span> ${isEn ? "raised" : "collecté"}</span>
      </div>
    </div>
    <div class="pcard-foot">
      <span class="ticket">${isEn ? "Min. ticket" : "Ticket min"} · <strong class="num">${minTicket()}</strong></span>
      <span class="pcard-go">${isEn ? "View details →" : "Voir la fiche →"}</span>
    </div>
  </a>`;
}

// Showcase cards never show a progress bar (these projects are not collecting
// funds yet) and never show ROI/progress-relevant amounts as "raised": they
// show community traction (upvotes/follows) instead. Regulatory guardrail:
// funding cards must never show upvote/follow counts (the funding API omits
// them), and showcase cards must never show a fundraising progress bar.
function showcaseCard(p) {
  return `<a class="pcard" href="${prefix}/projet/${p.id}/" data-type="${escapeHtml(p.category)}" data-roi="${p.roiPct}" data-progress="0" data-duration="${p.durationMonths}">
    <div class="pcard-head">
      <span class="pcard-sector">${catLabel(p.category)}</span>
      ${scoreTag(p)}
    </div>
    <h3 class="pcard-name">${escapeHtml(p.title)}</h3>
    <p class="pcard-meta">${metaLine(p)}</p>
    <div class="pcard-roi">
      <span class="v num">${p.roiPct}%</span>
      <span class="u">${isEn ? "Estimated ROI / year" : "ROI estimé / an"}</span>
    </div>
    <div class="pcard-votes">
      <span class="pvote"><span class="num">${Number(p.upvoteCount) || 0}</span> ${isEn ? "upvotes" : "votes"}</span>
      <span class="pvote"><span class="num">${Number(p.followCount) || 0}</span> ${isEn ? "following" : "abonnés"}</span>
    </div>
    <div class="pcard-foot">
      <span class="ticket">${isEn ? "Discovery" : "Découverte"}</span>
      <span class="pcard-go">${isEn ? "View details →" : "Voir la fiche →"}</span>
    </div>
  </a>`;
}

async function render() {
  const gridFunding = document.getElementById("grid-funding");
  const gridShowcase = document.getElementById("grid-showcase");
  // Mark busy only while the fetch is actually pending: the SSG cards already
  // sitting in these grids are real content (SEO + no-JS fallback), not a
  // placeholder, so they must never be announced as "loading" by default.
  if (gridFunding) gridFunding.setAttribute("aria-busy", "true");
  if (gridShowcase) gridShowcase.setAttribute("aria-busy", "true");
  try {
    const [f, s] = await Promise.all([api.get("/projects/funding"), api.get("/projects/showcase")]);
    if (gridFunding) gridFunding.innerHTML = (f.projects || []).map(fundingCard).join("");
    if (gridShowcase) gridShowcase.innerHTML = (s.projects || []).map(showcaseCard).join("");
  } catch (_e) {
    // API unreachable or errored: keep the SSG cards standing (they are the
    // SEO + no-JS fallback) and just wire filter/sort over what is there.
  } finally {
    if (gridFunding) gridFunding.removeAttribute("aria-busy");
    if (gridShowcase) gridShowcase.removeAttribute("aria-busy");
  }
  wireFilterSort();
}

// Port of the old inline filter/sort IIFE, extended to operate over the two
// grids (funding + showcase) that share one filter bar.
function wireFilterSort() {
  const gridFunding = document.getElementById("grid-funding");
  const gridShowcase = document.getElementById("grid-showcase");
  const showcaseSection = document.getElementById("showcase-section");
  const grids = [gridFunding, gridShowcase].filter(Boolean);
  if (!grids.length) return;

  const chips = Array.prototype.slice.call(document.querySelectorAll(".chip"));
  const sort = document.getElementById("sort");
  const results = document.getElementById("results");
  const empty = document.getElementById("empty");
  let current = "all";
  // Baseline order per grid, captured once cards are final (fetched or SSG),
  // so "Par défaut/Default" can restore it.
  const orders = grids.map((g) => Array.prototype.slice.call(g.querySelectorAll(".pcard")));

  function apply() {
    let visible = 0;
    let showcaseVisible = 0;
    grids.forEach((g) => {
      const cards = Array.prototype.slice.call(g.querySelectorAll(".pcard"));
      cards.forEach((c) => {
        const show = current === "all" || c.dataset.type === current;
        c.hidden = !show;
        if (show) {
          visible++;
          if (g === gridShowcase) showcaseVisible++;
        }
      });
    });
    if (showcaseSection) showcaseSection.hidden = showcaseVisible === 0;
    if (results) {
      const word = isEn ? "project" : "projet";
      results.innerHTML = '<span class="num">' + visible + "</span> " + word + (visible > 1 ? "s" : "");
    }
    if (empty) empty.hidden = visible !== 0;
  }

  function reorder(mode) {
    grids.forEach((g, i) => {
      const arr = orders[i].slice();
      if (mode === "roi") arr.sort((a, b) => b.dataset.roi - a.dataset.roi);
      else if (mode === "progress") arr.sort((a, b) => b.dataset.progress - a.dataset.progress);
      else if (mode === "duration") arr.sort((a, b) => a.dataset.duration - b.dataset.duration);
      arr.forEach((c) => g.appendChild(c));
    });
  }

  chips.forEach((chip) => {
    chip.addEventListener("click", () => {
      chips.forEach((c) => {
        c.classList.remove("active");
        c.setAttribute("aria-pressed", "false");
      });
      chip.classList.add("active");
      chip.setAttribute("aria-pressed", "true");
      current = chip.dataset.filter;
      apply();
    });
  });

  if (sort) sort.addEventListener("change", () => reorder(sort.value));

  apply();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", render);
else render();
