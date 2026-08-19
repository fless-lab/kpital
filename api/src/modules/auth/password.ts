import argon2 from "argon2";

export const hashPassword = (pw: string) => argon2.hash(pw, { type: argon2.argon2id });
export const verifyPassword = (pw: string, hash: string) => argon2.verify(hash, pw);
export const isStrongPassword = (pw: string) =>
  pw.length >= 8 && /[A-Z]/.test(pw) && /[0-9]/.test(pw);
