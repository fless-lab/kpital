// Project fiche (/projet/<id>/, /en/projet/<id>/). The SSG markup rendered by
// projet.njk is the SEO + no-JS fallback (raw minor amounts, static progress);
// on load this fetches the live project, reformats amounts, renders the
// gallery/documents from short-lived signed URLs, and wires follow/upvote for
// signed-in visitors. The invest panel behavior itself is wired by Task 5 via
// window.__kpInvest, called at the very end once the live project is known.
import { api, session, ApiError } from "./api.js";
import { money, progressPct, escapeHtml } from "./fmt.js";
import { localizeError, pageLang } from "./errors.js";

const root = document.querySelector(".proj");
const id = root && root.dataset.projectId;
const lang = pageLang();
const isEn = lang === "en";

function setMoney(elId, minor) {
  const el = document.getElementById(elId);
  if (el) el.textContent = money(minor, lang);
}

function showNotFound(err) {
  const notice = document.getElementById("projNotFound");
  const msg = document.getElementById("projNotFoundMsg");
  const head = document.getElementById("projHead");
  const body = document.getElementById("projBody");
  if (msg) msg.textContent = localizeError(err, lang);
  if (notice) notice.hidden = false;
  if (head) head.hidden = true;
  if (body) body.hidden = true;
}

function renderGallery(imgs) {
  const g = document.getElementById("gallery");
  if (!g) return;
  g.innerHTML = imgs.map((d) => `<img class="gthumb" src="${escapeHtml(d.url)}" alt="" loading="lazy">`).join("");
}

function formatBytes(n) {
  const bytes = Number(n) || 0;
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toLocaleString(isEn ? "en-US" : "fr-FR", { maximumFractionDigits: 1 }) + (isEn ? " MB" : " Mo");
  if (bytes >= 1024) return Math.round(bytes / 1024) + " Ko";
  return bytes + (isEn ? " B" : " o");
}

function humanizeKind(kind) {
  const s = String(kind || "").replace(/_/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Document";
}

function renderDocs(pdfs) {
  const list = document.getElementById("docs");
  if (!list) return;
  list.innerHTML = pdfs
    .map(
      (d) => `<li class="doc">
        <svg class="doc-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <span class="doc-name">${escapeHtml(humanizeKind(d.kind))}</span>
        <span class="doc-meta">PDF · ${formatBytes(d.sizeBytes)}</span>
        <a class="doc-go" href="${escapeHtml(d.url)}" target="_blank" rel="noopener">${isEn ? "View" : "Consulter"} →</a>
      </li>`
    )
    .join("");
}

function renderProgress(p) {
  const pct = progressPct(p.raisedMinor, p.targetMinor);
  const remaining = Math.max(0, (Number(p.targetMinor) || 0) - (Number(p.raisedMinor) || 0));
  const pctEl = document.getElementById("investPct");
  const barEl = document.getElementById("investBar");
  const restEl = document.getElementById("investRest");
  const raisedEl = document.getElementById("investRaised");
  if (pctEl) pctEl.textContent = pct + "%";
  if (barEl) barEl.style.width = pct + "%";
  if (restEl) restEl.textContent = money(remaining, lang);
  if (raisedEl) raisedEl.textContent = money(p.raisedMinor, lang);
}

function reflectFollow(btn, on) {
  btn.classList.toggle("is-on", on);
  // Keep the SSG bookmark <svg>, only replace the trailing label text.
  const icon = btn.querySelector("svg");
  btn.textContent = "";
  if (icon) btn.appendChild(icon);
  btn.appendChild(document.createTextNode(on ? (isEn ? "Saved" : "Enregistré") : (isEn ? "Save" : "Sauvegarder")));
}

function reflectUpvote(btn, on, count) {
  btn.classList.toggle("is-on", on);
  const countEl = document.getElementById("upvoteCount");
  if (countEl) countEl.textContent = String(count);
}

async function wireEngagement(p) {
  const followBtn = document.getElementById("followBtn");
  const upvoteBtn = document.getElementById("upvoteBtn");
  let me;
  try {
    me = await session.getMe();
  } catch (_e) {
    return; // outage on /me: leave the buttons hidden, do not break the rest of hydration
  }
  if (!me) return; // engagement requires auth; leave buttons hidden

  let state;
  try {
    state = await api.get("/projects/" + id + "/me");
  } catch (_e) {
    return;
  }

  if (followBtn) {
    followBtn.hidden = false;
    reflectFollow(followBtn, state.following);
    followBtn.addEventListener("click", async () => {
      followBtn.disabled = true;
      try {
        const r = state.following ? await api.del("/projects/" + id + "/follow") : await api.post("/projects/" + id + "/follow");
        state.following = r.following;
        reflectFollow(followBtn, r.following);
      } catch (_e) {
        // leave state unchanged on failure
      } finally {
        followBtn.disabled = false;
      }
    });
  }

  if (upvoteBtn && p.status === "showcase") {
    let count = Number(p.upvoteCount) || 0;
    upvoteBtn.hidden = false;
    reflectUpvote(upvoteBtn, state.upvoted, count);
    upvoteBtn.addEventListener("click", async () => {
      upvoteBtn.disabled = true;
      try {
        const r = state.upvoted ? await api.del("/projects/" + id + "/upvote") : await api.post("/projects/" + id + "/upvote");
        state.upvoted = r.upvoted;
        count += r.upvoted ? 1 : -1;
        reflectUpvote(upvoteBtn, r.upvoted, Math.max(0, count));
      } catch (_e) {
        // 409 invalid_state (project left showcase) or transient failure: no local change
      } finally {
        upvoteBtn.disabled = false;
      }
    });
  }
}

async function hydrate() {
  if (!id) return;
  // Reformat SSG raw numbers immediately, before the live fetch resolves.
  setMoney("mTarget", root.querySelector("#mTarget")?.textContent);
  setMoney("mRaised", root.querySelector("#mRaised")?.textContent);

  let detail;
  try {
    detail = await api.get("/projects/" + id);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.code === "not_found")) showNotFound(e);
    // Any other error (outage, network): leave the static SSG content standing.
    return;
  }

  const p = detail.project;
  setMoney("mTarget", p.targetMinor);
  setMoney("mRaised", p.raisedMinor);
  renderProgress(p);
  renderGallery((detail.documents || []).filter((d) => (d.mime || "").startsWith("image/")));
  renderDocs((detail.documents || []).filter((d) => d.mime === "application/pdf"));
  await wireEngagement(p);

  // Invest panel wiring (amount input, quick amounts, ROI calc, source select,
  // KYC gate, submit) is added by Task 5.
  if (window.__kpInvest) window.__kpInvest(p);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hydrate);
else hydrate();
