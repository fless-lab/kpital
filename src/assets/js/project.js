// Project fiche (/projet/<id>/, /en/projet/<id>/). The SSG markup rendered by
// projet.njk is the SEO + no-JS fallback (raw minor amounts, static progress);
// on load this fetches the live project, reformats amounts, renders the
// gallery/documents from short-lived signed URLs, and wires follow/upvote for
// signed-in visitors. The invest panel behavior (window.__kpInvest, defined
// below) is invoked last by hydrate(), once the live project is known: it
// gates the invest button on auth then KYC before ever calling the API.
import { api, session, ApiError } from "./api.js";
import { money, progressPct, estRoi, escapeHtml } from "./fmt.js";
import { localizeError, pageLang } from "./errors.js";

const root = document.querySelector(".proj");
const id = root && root.dataset.projectId;
const lang = pageLang();
const isEn = lang === "en";
const prefix = isEn ? "/en" : "";

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
  const block = document.getElementById("docsBlock");
  if (block) block.hidden = pdfs.length === 0;
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

// Invest panel: only present in the DOM on a collecting-status fiche (a
// showcase fiche renders a "not open yet" note instead and none of these
// elements exist), so every lookup here is guarded. Defined before hydrate()
// is ever invoked below so `window.__kpInvest` is always ready by the time
// hydrate() reaches its `if (window.__kpInvest) window.__kpInvest(p);` call.
window.__kpInvest = function (p) {
  const amountEl = document.getElementById("amount");
  const sourceEl = document.getElementById("investSource");
  const btn = document.getElementById("investBtn");
  const msg = document.getElementById("investMsg");
  const gate = document.getElementById("kycGate");
  if (!amountEl || !sourceEl || !btn) return; // showcase fiche: nothing to wire

  const btnAmount = btn.querySelector(".num");

  function moneyNum(minor) {
    // Grouped digits only, no " FCFA" suffix, for the button label span
    // (the surrounding "FCFA →" text already lives in the static markup).
    return money(minor, lang).replace(/ FCFA$/, "");
  }

  function updateRoi() {
    const amount = Math.max(0, parseInt(amountEl.value, 10) || 0);
    const gain = estRoi(amount, p.roiPct, p.durationMonths);
    const total = amount + gain;
    const capitalEl = document.getElementById("roiCapital");
    const gainEl = document.getElementById("roiGain");
    const totalEl = document.getElementById("roiTotal");
    if (capitalEl) capitalEl.textContent = money(amount, lang);
    if (gainEl) gainEl.textContent = "+ " + money(gain, lang);
    if (totalEl) totalEl.textContent = money(total, lang);
    if (btnAmount) btnAmount.textContent = moneyNum(amount);
  }

  amountEl.addEventListener("input", updateRoi);
  document.querySelectorAll(".quick-amt").forEach((qb) => {
    qb.addEventListener("click", () => {
      amountEl.value = qb.dataset.amt;
      document.querySelectorAll(".quick-amt").forEach((x) => x.classList.remove("is-active"));
      qb.classList.add("is-active");
      updateRoi();
    });
  });
  updateRoi();

  let submitting = false;
  // True only while the inline exceeds_remaining prompt is on screen. Kept
  // separate from `submitting` (which is false again once the request that
  // raised the prompt has settled) so the submit button stays disabled and
  // cannot be clicked with the stale, over-limit amount while the prompt is
  // up (a click there would just re-raise the same prompt).
  let capOpen = false;

  function hideCapPrompt() {
    const el = document.getElementById("investCapPrompt");
    if (el) el.remove();
    capOpen = false;
    // Only re-enable here when nothing else currently owns the disabled
    // state: a submit() in flight will set the final state itself in its
    // `finally`, and the KYC gate keeps the button disabled permanently.
    if (!submitting && (!gate || gate.hidden)) btn.disabled = false;
  }

  // Inline "invest the remaining amount instead?" affordance for
  // exceeds_remaining. Never the browser confirm() dialog.
  function showCapPrompt(remainingMinor, onAccept) {
    hideCapPrompt();
    capOpen = true;
    btn.disabled = true;
    const wrap = document.createElement("div");
    wrap.id = "investCapPrompt";
    wrap.setAttribute("role", "group");
    wrap.style.cssText = "display:flex;flex-direction:column;gap:8px;margin:-6px 0 14px";

    const text = document.createElement("p");
    text.className = "invest-msg";
    text.style.color = "inherit";
    text.hidden = false;
    text.textContent = isEn
      ? "Only " + money(remainingMinor, lang) + " remain to be raised. Invest that amount instead?"
      : "Il ne reste que " + money(remainingMinor, lang) + " à collecter. Investir ce montant ?";

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:8px;flex-wrap:wrap";

    const yes = document.createElement("button");
    yes.type = "button";
    yes.className = "btn btn-primary btn-sm";
    yes.textContent = isEn ? "Invest the remaining amount" : "Investir le montant restant";
    yes.addEventListener("click", () => {
      hideCapPrompt();
      onAccept();
    });

    const no = document.createElement("button");
    no.type = "button";
    no.className = "btn btn-ghost btn-sm";
    no.textContent = isEn ? "Cancel" : "Annuler";
    no.addEventListener("click", hideCapPrompt);

    actions.appendChild(yes);
    actions.appendChild(no);
    wrap.appendChild(text);
    wrap.appendChild(actions);
    if (msg) msg.insertAdjacentElement("afterend", wrap);
    else btn.insertAdjacentElement("beforebegin", wrap);
  }

  function showInvestError(err) {
    hideCapPrompt();
    if (!msg) return;
    msg.textContent = localizeError(err, lang);
    msg.hidden = false;
  }

  // confirmCap === true marks a resubmit already capped to the server's
  // remainingMinor: exceeds_remaining on THAT response is never re-prompted
  // (the `!confirmCap` guard below), so this can trigger at most one inline
  // prompt per submit chain and cannot loop.
  async function submit(amountOverride, confirmCap) {
    if (submitting) return;
    submitting = true;
    btn.disabled = true;
    if (msg) msg.hidden = true;
    hideCapPrompt();
    let gateShown = false;
    try {
      let me;
      try {
        me = await session.getMe();
      } catch (e) {
        showInvestError(e);
        return;
      }
      if (!me) {
        location.href = prefix + "/connexion/?next=" + encodeURIComponent(location.pathname);
        return;
      }
      if (me.kycStatus !== "verified") {
        gateShown = true;
        if (gate) gate.hidden = false;
        return;
      }

      const amountMinor = amountOverride != null ? amountOverride : parseInt(amountEl.value, 10);
      const source = sourceEl.value; // "payment" | "wallet"
      const body = { amountMinor, source };
      if (confirmCap) body.confirmCapToRemaining = true;

      let r;
      try {
        r = await api.post("/projects/" + p.id + "/invest", body);
      } catch (e) {
        if (!confirmCap && e instanceof ApiError && e.code === "exceeds_remaining") {
          const rem = e.details && e.details.remainingMinor;
          if (rem != null && rem > 0) {
            showCapPrompt(rem, () => {
              amountEl.value = String(rem);
              updateRoi();
              submit(rem, true);
            });
            return;
          }
        }
        showInvestError(e);
        return;
      }

      // Success: hand the confirmation page only what it needs via
      // sessionStorage (never the URL), then navigate. Any failure above
      // returns before this point, so a failed invest never reaches
      // /investir/confirmation/.
      sessionStorage.setItem(
        "kp.invest",
        JSON.stringify({
          projectId: p.id,
          title: p.title,
          amountMinor: r.amountMinor,
          roiPct: p.roiPct,
          durationMonths: p.durationMonths,
          status: r.status,
        })
      );
      location.href = prefix + "/investir/confirmation/";
    } finally {
      submitting = false;
      // Disabled while the KYC gate is up, or while the cap prompt raised by
      // this very call is on screen (showCapPrompt already disabled it;
      // this just keeps the two states from fighting over the final value).
      btn.disabled = gateShown || capOpen;
    }
  }

  btn.addEventListener("click", () => submit(null, false));
};

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
  // KYC gate, submit) is defined above and called last, once the live project
  // (with its real roiPct/durationMonths/status) is known.
  if (window.__kpInvest) window.__kpInvest(p);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hydrate);
else hydrate();
