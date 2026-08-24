import { describe, it, expect } from "vitest";
import { NoPenaltyPolicy } from "../src/lib/penalty";

describe("PenaltyPolicy", () => {
  it("NoPenaltyPolicy always returns 0", () => {
    const p = new NoPenaltyPolicy();
    expect(p.penaltyFor({ installmentId: "x", amountMinor: 100000, daysLate: 90 })).toBe(0);
  });
});
