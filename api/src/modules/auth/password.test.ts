import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, isStrongPassword } from "./password";

describe("password", () => {
  it("hashes and verifies", async () => {
    const h = await hashPassword("Abcdef12");
    expect(await verifyPassword("Abcdef12", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
  });
  it("enforces policy", () => {
    expect(isStrongPassword("Abcdef12")).toBe(true);
    expect(isStrongPassword("short1")).toBe(false);
    expect(isStrongPassword("alllower123")).toBe(false);
  });
});
