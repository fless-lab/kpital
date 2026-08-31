// Shared formatters. Amounts are FCFA (minor == FCFA, no subdivision).
export function money(minor, lang) {
  const n = Number(minor) || 0;
  // Grouped thousands with a narrow no-break space, then the currency.
  const grouped = n.toLocaleString(lang === "en" ? "en-US" : "fr-FR").replace(/,/g, " ");
  return grouped + " FCFA";
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
