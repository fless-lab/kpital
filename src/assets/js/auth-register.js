// Wires /inscription to the API. The page's inline script keeps owning the wizard
// (toggleProfile, updateDocUpload, goStep on window). This module only owns the
// final "create account" action: register, then submit KYC (mandatory at signup),
// then reveal the existing success pane via window.goStep(4). File inputs and role
// state are read from the existing markup, so the wizard UI is untouched.

import { api, apiMultipart, ApiError } from "./api.js";
import { localizeError, pageLang } from "./errors.js";

const lang = pageLang();
const val = (id) => (document.getElementById(id)?.value || "").trim();

function showError(paneId, err) {
  const pane = document.getElementById(paneId);
  if (!pane) return;
  let el = pane.querySelector(".auth-error");
  if (!el) {
    el = document.createElement("p");
    el.className = "auth-error";
    el.setAttribute("role", "alert");
    pane.appendChild(el);
  }
  el.textContent = err instanceof Error ? localizeError(err, lang) : String(err);
  el.hidden = false;
}
function clearErrors() {
  document.querySelectorAll(".auth-error").forEach((el) => (el.hidden = true));
}

// Roles are cumulable: read the pressed state of the two profile buttons.
function selectedRoles() {
  const roles = [];
  if (document.getElementById("prof-invest")?.getAttribute("aria-pressed") === "true") roles.push("investor");
  if (document.getElementById("prof-porteur")?.getAttribute("aria-pressed") === "true") roles.push("porteur");
  return roles;
}

// The KYC file inputs have no ids: front is the upload input that is not the
// (possibly hidden) back one; back lives inside #field-back.
function fileInputs() {
  const back = document.querySelector("#field-back input[type=file]");
  const all = Array.from(document.querySelectorAll("#docUploads input[type=file]"));
  const front = all.find((i) => i !== back) || null;
  return { front, back };
}

function buildKycForm() {
  const fd = new FormData();
  fd.append("doc_type", val("doc-type"));
  fd.append("doc_number", val("doc-num"));
  fd.append("dob", val("dob")); // a date input yields YYYY-MM-DD
  fd.append("nationality", val("nat"));
  const { front, back } = fileInputs();
  const isPassport = val("doc-type") === "passeport";
  if (isPassport) {
    if (front?.files[0]) fd.append("passport_page", front.files[0]);
  } else {
    if (front?.files[0]) fd.append("front", front.files[0]);
    if (back?.files[0]) fd.append("back", back.files[0]);
  }
  return fd;
}

const btn = document.getElementById("createAccountBtn");
if (btn) {
  btn.addEventListener("click", async () => {
    clearErrors();
    btn.disabled = true;
    try {
      // 1. Create the account (this also opens the session cookie).
      await api.post("/auth/register", {
        email: val("email"),
        password: document.getElementById("password")?.value || "",
        firstName: val("prenom"),
        lastName: val("nom"),
        country: val("pays"),
        roles: selectedRoles(),
      });
    } catch (e) {
      // Register failed (validation, email taken): stay on the profile step.
      window.goStep(1);
      showError("pane1", e);
      btn.disabled = false;
      return;
    }
    try {
      // 2. Submit KYC (mandatory at signup). Session is set from register.
      await apiMultipart("/kyc/submission", buildKycForm());
      window.goStep(4); // success pane
    } catch (e) {
      // The account exists (kyc pending). Do not re-register. Send them to the
      // dashboard, where a banner prompts finishing verification.
      if (e instanceof ApiError) {
        location.href = "/dashboard?kyc=pending";
        return;
      }
      showError("pane2", e);
      window.goStep(2);
      btn.disabled = false;
    }
  });
}
