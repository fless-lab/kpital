// Investment confirmation (/investir/confirmation/, /en/investir/confirmation/).
// The invest flow (project.js) never puts the amount or project in the URL:
// it hands this page a one-shot payload via sessionStorage, read and cleared
// here immediately so a reload or a shared link never replays stale figures.
// A direct visit with nothing stored (bookmarked link, back button after the
// storage key was already consumed) falls back to a neutral message instead
// of showing (or re-showing) any investment detail.
import { money, estRoi } from "./fmt.js";

const lang = document.documentElement.lang === "en" ? "en" : "fr";

let data = null;
try {
  data = JSON.parse(sessionStorage.getItem("kp.invest") || "null");
} catch (_e) {
  data = null;
}
sessionStorage.removeItem("kp.invest"); // one-shot, regardless of parse outcome

const details = document.getElementById("cDetails");
const fallback = document.getElementById("cFallback");

// Require a strictly positive, finite amount: Number(null) is 0 (finite),
// so a null/missing amountMinor (e.g. a 201 with an empty body, guarded in
// project.js) must fall back rather than render as "0 FCFA" success.
if (!data || !(Number.isFinite(Number(data.amountMinor)) && Number(data.amountMinor) > 0)) {
  if (details) details.hidden = true;
  if (fallback) fallback.hidden = false;
} else {
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v; // textContent: never interpreted as markup
  };
  set("cProject", data.title || (lang === "en" ? "This project" : "Ce projet"));
  set("cAmount", money(data.amountMinor, lang));
  const roiPct = Number(data.roiPct) || 0;
  const gain = estRoi(data.amountMinor, roiPct, data.durationMonths);
  set("cRoi", "+" + money(gain, lang) + (lang === "en" ? ` (${roiPct}% / year)` : ` (${roiPct}% / an)`));
}
