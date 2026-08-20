import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  InsufficientFundsError,
  WalletNotFoundError,
  PayoutFailedError,
} from "../../modules/wallet/service";
import { WeakPasswordError } from "../../modules/accounts/register";

// The uniform error envelope every route ultimately emits: { error: { code, message, details? } }.
// Most routes already build this shape inline; this handler is the safety net that
// normalizes anything that escapes as a thrown error (notably PayoutFailedError,
// Fastify schema-validation errors, malformed-body errors, and rate-limit 429s).

// Known domain codes → HTTP status. The code is what the client keys off.
const CODE_STATUS: Record<string, number> = {
  validation_error: 400,
  invalid_token: 400,
  insufficient_funds: 400,
  invalid_credentials: 401,
  otp_invalid: 401,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  wallet_not_found: 404,
  invalid_state: 409,
  email_taken: 409,
  phone_taken: 409,
  rate_limited: 429,
  payout_failed: 502,
};

// Fastify's default statusCode (set on malformed-JSON, unsupported-media-type,
// missing-route, etc.) → a uniform code, so existing 4xx behavior is preserved
// rather than being collapsed into 500.
const STATUS_CODE: Record<number, string> = {
  400: "validation_error",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  415: "validation_error",
  429: "rate_limited",
};

type Mapped = { status: number; code: string; message: string };

function resolveDomain(error: FastifyError): Mapped | undefined {
  // Primary: match the concrete class. The wallet errors are thrown through
  // drizzle's ROLLBACK, and WeakPasswordError carries an empty message, so a
  // name/message lookup alone is unreliable, so instanceof is the source of truth.
  if (error instanceof InsufficientFundsError) {
    return { status: 400, code: "insufficient_funds", message: "Insufficient funds" };
  }
  if (error instanceof WalletNotFoundError) {
    return { status: 404, code: "not_found", message: "Wallet not found" };
  }
  if (error instanceof PayoutFailedError) {
    return { status: 502, code: "payout_failed", message: "Payout failed" };
  }
  if (error instanceof WeakPasswordError) {
    return { status: 400, code: "validation_error", message: "Password does not meet strength requirements" };
  }
  // Fallback: the error message may itself be a known code (some domain errors
  // are thrown as bare Errors whose message is the code, possibly wrapped).
  const byMessage = error.message && CODE_STATUS[error.message] ? error.message : undefined;
  const byCause =
    !byMessage && typeof error.cause === "object" && error.cause !== null && "message" in error.cause
      ? CODE_STATUS[(error.cause as { message?: string }).message ?? ""]
        ? (error.cause as { message: string }).message
        : undefined
      : undefined;
  const code = byMessage ?? byCause;
  if (code) {
    const status = CODE_STATUS[code];
    if (status) return { status, code, message: error.message || code };
  }
  return undefined;
}

export function registerErrorHandler(app: FastifyInstance): void {
  // Unknown routes go through Fastify's not-found path (not the error handler),
  // so normalize them here too for a uniform envelope across every response.
  app.setNotFoundHandler((_req: FastifyRequest, reply: FastifyReply) => {
    return reply.code(404).send({ error: { code: "not_found", message: "Route not found" } });
  });

  app.setErrorHandler((error: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    // Rate-limit responses from @fastify/rate-limit arrive with statusCode 429.
    if (error.statusCode === 429) {
      return reply
        .code(429)
        .send({ error: { code: "rate_limited", message: error.message || "Too many requests" } });
    }

    // Fastify schema/validation errors (body/query/params against a JSON schema).
    if (error.validation) {
      return reply.code(400).send({ error: { code: "validation_error", message: error.message } });
    }

    const domain = resolveDomain(error);
    if (domain) {
      return reply.code(domain.status).send({ error: { code: domain.code, message: domain.message } });
    }

    // Preserve existing 4xx behavior (malformed JSON, unsupported media type,
    // 404 not-found route, etc.) rather than masking it as an internal error.
    const status = error.statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      const code = STATUS_CODE[status] ?? "error";
      return reply.code(status).send({ error: { code, message: error.message } });
    }

    // Anything unrecognized: log server-side, never leak the raw message/stack.
    req.log.error({ err: error }, "unhandled error");
    return reply.code(500).send({ error: { code: "internal_error", message: "Internal server error" } });
  });
}
