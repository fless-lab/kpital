// Localized copy for the backend error codes the auth + KYC flows can surface.
// The backend messages are English; the site is FR/EN, so pages localize by the
// error CODE and never display the raw message. Anything unmapped falls back to a
// generic localized line. Keep this in sync with the codes returned by
// api/src/modules/auth/routes.ts and api/src/modules/kyc/routes.ts.

const MAP = {
  validation_error: { fr: "Certaines informations sont invalides.", en: "Some information is invalid." },
  invalid_credentials: { fr: "Identifiant ou mot de passe incorrect.", en: "Incorrect identifier or password." },
  otp_invalid: { fr: "Code invalide ou expire.", en: "Invalid or expired code." },
  email_taken: { fr: "Cet email est deja utilise.", en: "This email is already registered." },
  account_suspended: { fr: "Ce compte n'est pas actif.", en: "This account is not active." },
  kyc_required: { fr: "Verification d'identite requise.", en: "Identity verification required." },
  rate_limited: { fr: "Trop de tentatives, reessayez plus tard.", en: "Too many attempts, try again later." },
  not_found: { fr: "Projet introuvable.", en: "Project not found." },
};

export function pageLang() {
  return document.documentElement.lang === "en" ? "en" : "fr";
}

export function localizeError(err, lang) {
  const l = lang || pageLang();
  // A 429 (rate limit) can arrive with a code the plugin sets rather than our
  // own envelope, so treat the status as a fallback signal.
  const code = (err && err.code) || (err && err.status === 429 ? "rate_limited" : null);
  const entry = code && MAP[code];
  if (entry) return l === "en" ? entry.en : entry.fr;
  return l === "en" ? "Something went wrong, please try again." : "Une erreur est survenue, reessayez.";
}
