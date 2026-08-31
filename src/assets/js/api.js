// KPITAL API client. Same-origin: the dev server proxies /api/* to Fastify, prod
// serves both behind one reverse proxy, so the session cookie (httpOnly) rides
// along and is never read or stored by this code. The backend uses a uniform
// error envelope { error: { code, message, details? } }, normalized here into an
// ApiError so pages can localize by code (never showing the raw English message).

export class ApiError extends Error {
  constructor(code, message, details, status) {
    super(message || code);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

async function request(path, { method = "GET", body, headers, multipart } = {}) {
  const hasBody = body !== undefined;
  const opts = {
    method,
    credentials: "same-origin",
    // Only declare a JSON content-type when we actually send a JSON body: Fastify
    // rejects an empty body when content-type is application/json (a bodyless
    // POST like /auth/logout would 400). Multipart lets the browser set its own.
    headers: { ...(hasBody && !multipart ? { "Content-Type": "application/json" } : {}), ...headers },
  };
  if (hasBody) opts.body = multipart ? body : JSON.stringify(body);
  const res = await fetch("/api" + path, opts);
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data && data.error;
    throw new ApiError((err && err.code) || "unknown", (err && err.message) || "", err && err.details, res.status);
  }
  return data;
}

export const api = {
  get: (p) => request(p),
  post: (p, body, opts) => request(p, { method: "POST", body, ...opts }),
  patch: (p, body, opts) => request(p, { method: "PATCH", body, ...opts }),
  del: (p, opts) => request(p, { method: "DELETE", ...opts }),
};

// Multipart upload (KYC): let the browser set the multipart boundary, so no
// Content-Type header is sent. Same error normalization.
export function apiMultipart(path, formData) {
  return request(path, { method: "POST", body: formData, multipart: true });
}

export const session = {
  // The current account, or null when unauthenticated (401). Any other error
  // propagates so callers do not mistake an outage for a logged-out state.
  async getMe() {
    try {
      return await api.get("/me");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null;
      throw e;
    }
  },
};
