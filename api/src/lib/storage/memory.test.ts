import { describe, it, expect } from "vitest";
import { MemoryStorage } from "./memory";

describe("MemoryStorage", () => {
  it("puts, signs, and deletes", async () => {
    const s = new MemoryStorage();
    await s.put("k/1.png", Buffer.from("x"), "image/png");
    expect(s.objects.get("k/1.png")?.contentType).toBe("image/png");
    const url = await s.getSignedUrl("k/1.png", 60);
    expect(url).toContain("k/1.png");
    await s.delete("k/1.png");
    expect(s.objects.has("k/1.png")).toBe(false);
  });
});
