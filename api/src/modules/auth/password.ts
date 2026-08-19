import argon2 from "argon2";

// Explicit argon2id cost parameters (OWASP-recommended baseline). verifyPassword
// reads the parameters embedded in each stored hash, so older hashes (including
// the DECOY_HASH in routes.ts) keep verifying without change.
export const hashPassword = (pw: string) =>
  argon2.hash(pw, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
export const verifyPassword = (pw: string, hash: string) => argon2.verify(hash, pw);
export const isStrongPassword = (pw: string) =>
  pw.length >= 8 && /[A-Z]/.test(pw) && /[0-9]/.test(pw);
