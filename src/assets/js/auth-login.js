// Wires /connexion to the API. The page's own inline script keeps owning the OTP
// UI toggles and localized UI strings; this module STACKS API handlers on top
// (both fire: the inline preventDefault stops navigation, these do the fetch), so
// the existing UX is untouched. Login is anti-enumeration: failures show a single
// generic message, never "unknown email" vs "wrong password".

import { api, ApiError } from "./api.js";
import { localizeError, pageLang } from "./errors.js";

const lang = pageLang();

// Only allow a same-site relative path as the post-login destination.
function nextTarget() {
  const n = new URLSearchParams(location.search).get("next");
  return n && n.startsWith("/") && !n.startsWith("//") ? n : "/dashboard";
}

// Find or create an error line inside a form, shown localized.
function showError(form, err) {
  let el = form.querySelector(".auth-error");
  if (!el) {
    el = document.createElement("p");
    el.className = "auth-error";
    el.setAttribute("role", "alert");
    form.appendChild(el);
  }
  el.textContent = err instanceof ApiError || err instanceof Error ? localizeError(err, lang) : String(err);
  el.hidden = false;
}
function clearError(form) {
  const el = form.querySelector(".auth-error");
  if (el) el.hidden = true;
}

const val = (id) => (document.getElementById(id)?.value || "").trim();

const pwForm = document.getElementById("pwForm");
if (pwForm) {
  pwForm.addEventListener("submit", async () => {
    clearError(pwForm);
    try {
      await api.post("/auth/login", { identifier: val("login-id"), password: document.getElementById("login-pw")?.value || "" });
      location.href = nextTarget();
    } catch (e) {
      showError(pwForm, e);
    }
  });
}

const otpForm = document.getElementById("otpForm");
if (otpForm) {
  const channel = () => (otpForm.querySelector(".otp-seg-btn.is-on")?.dataset.method === "phone" ? "sms" : "email");

  // Request: fires alongside the inline requestCode() UI reveal.
  document.getElementById("otpRequest")?.addEventListener("click", async () => {
    clearError(otpForm);
    const identifier = val("otp-id");
    if (!identifier) return;
    try {
      await api.post("/auth/otp/request", { identifier, channel: channel() });
    } catch (e) {
      showError(otpForm, e);
    }
  });
  document.getElementById("otpResend")?.addEventListener("click", async () => {
    clearError(otpForm);
    try {
      await api.post("/auth/otp/request", { identifier: val("otp-id"), channel: channel() });
    } catch (e) {
      showError(otpForm, e);
    }
  });

  otpForm.addEventListener("submit", async () => {
    clearError(otpForm);
    try {
      await api.post("/auth/otp/verify", { identifier: val("otp-id"), code: val("otp-code") });
      location.href = nextTarget();
    } catch (e) {
      showError(otpForm, e);
    }
  });
}
