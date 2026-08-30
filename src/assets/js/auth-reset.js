// Exposes the API client to the reset pages' inline scripts, which own the UX
// (password strength, show/hide, match check, pane toggles, token read). The
// inline submit handlers call window.__kpAuth.api so the pane transitions are
// gated on the real result instead of faking success. Loaded as a module (pageJs)
// so it is present by the time the user submits.

import { api } from "./api.js";
import { pageLang } from "./errors.js";

window.__kpAuth = { api, lang: pageLang() };
