// Session guard for every /dashboard* page. Loaded as a module (pageJs).
// - Redirects to the login page (with a ?next= return path) when unauthenticated.
// - Fills the visible user name once the session is confirmed.
// - Reflects the real KYC status (pending/verified/rejected) in the header flag,
//   the nav pill, and a pending banner.
// - Wires the logout button.
// Progressive enhancement: the server ships mock placeholders; this only runs
// when the module loads, so a no-JS visitor still sees a coherent (static) page.

import { api, session } from "./api.js";
import { pageLang } from "./errors.js";

const lang = pageLang();
const isEn = lang === "en";
const prefix = isEn ? "/en" : "";

// Trailing slash matches Eleventy's clean-URL output; without it the dev server
// 301-redirects /connexion -> /connexion/ and drops the ?next query.
function loginUrl(withNext) {
  const base = prefix + "/connexion/";
  if (!withNext) return base;
  return base + "?next=" + encodeURIComponent(location.pathname + location.search);
}

function displayName(me) {
  return [me.firstName, me.lastName].filter(Boolean).join(" ").trim();
}

const KYC = {
  verified: { fr: "Vérifié", en: "Verified", flag: "is-ok" },
  pending: { fr: "En vérification", en: "In review", flag: "is-pending" },
  rejected: { fr: "À corriger", en: "Action needed", flag: "is-warn" },
};

const BANNER = {
  pending: {
    fr: "Votre vérification d'identité est en cours. Certaines actions restent limitées le temps de la validation.",
    en: "Your identity verification is in progress. Some actions stay limited until it is approved.",
  },
  rejected: {
    fr: "Votre vérification d'identité n'a pas abouti. Renvoyez vos documents depuis vos paramètres.",
    en: "Your identity verification did not go through. Resubmit your documents from your settings.",
  },
};

function applyKyc(status) {
  const meta = KYC[status] || KYC.pending;
  const label = isEn ? meta.en : meta.fr;

  // Header flag ("Statut KYC")
  const flag = document.querySelector(".dash-kyc-flag");
  if (flag) {
    // Keep the leading <i></i> dot, replace only the trailing text node.
    const dot = flag.querySelector("i");
    flag.textContent = "";
    if (dot) flag.appendChild(dot);
    flag.appendChild(document.createTextNode(label));
  }

  // Nav pill
  const pill = document.getElementById("kyc-pill");
  if (pill) {
    pill.className = "pill " + meta.flag;
    const dot = pill.querySelector("i");
    pill.textContent = "";
    if (dot) pill.appendChild(dot);
    pill.appendChild(document.createTextNode(label));
    pill.hidden = status === "verified";
  }

  // Pending / rejected banner
  const banner = document.getElementById("kyc-banner");
  if (banner) {
    if (status === "verified") {
      banner.hidden = true;
    } else {
      const copy = BANNER[status] || BANNER.pending;
      banner.textContent = isEn ? copy.en : copy.fr;
      banner.hidden = false;
    }
  }
}

async function guard() {
  const me = await session.getMe();
  if (!me) {
    location.replace(loginUrl(true));
    return;
  }

  const name = displayName(me);

  // Greeting in the page header ("Bonjour, Kofi A.")
  const greet = document.querySelector(".dash-greet h1");
  if (greet && name) {
    greet.textContent = (isEn ? "Hello, " : "Bonjour, ") + name;
  }

  // Optional dedicated name slot (e.g. in the nav)
  const nameSlot = document.getElementById("dash-user-name");
  if (nameSlot && name) nameSlot.textContent = name;

  applyKyc(me.kycStatus);

  const logout = document.getElementById("logout-btn");
  if (logout) {
    logout.addEventListener("click", async function () {
      logout.disabled = true;
      try {
        await api.post("/auth/logout");
      } catch (_e) {
        // Even if the call fails, the cookie is httpOnly and short-lived; send
        // the user to the login page regardless.
      }
      location.href = prefix + "/connexion/";
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", guard);
} else {
  guard();
}
