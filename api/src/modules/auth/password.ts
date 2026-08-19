import argon2 from "argon2";

// Explicit, pinned argon2id params so cost is not left to library defaults
// (which can drift between versions). memoryCost/timeCost match the previous
// implicit defaults (64 MiB, 3 iterations); parallelism pinned to 1 for
// portability. verifyPassword reads the params embedded in each stored hash, so
// existing hashes stay compatible. The DECOY_HASH in routes.ts is generated with
// these same params so the no-account login path costs the same as a real verify.
export const hashPassword = (pw: string) =>
  argon2.hash(pw, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });
export const verifyPassword = (pw: string, hash: string) => argon2.verify(hash, pw);
export const isStrongPassword = (pw: string) =>
  pw.length >= 8 && /[A-Z]/.test(pw) && /[0-9]/.test(pw);
