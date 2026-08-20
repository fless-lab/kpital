import { describe, it, expect } from "vitest";
import { sniffMime, expectedKinds, extForMime } from "./validate";

describe("sniffMime", () => {
  it("recognizes a PNG magic-byte buffer", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    expect(sniffMime(png)).toBe("image/png");
  });

  it("recognizes a JPEG magic-byte buffer", () => {
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    expect(sniffMime(jpg)).toBe("image/jpeg");
  });

  it("recognizes a PDF magic-byte buffer", () => {
    const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]); // %PDF-1
    expect(sniffMime(pdf)).toBe("application/pdf");
  });

  it("returns null for garbage bytes", () => {
    expect(sniffMime(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBeNull();
  });

  it("does not false-positive on a buffer shorter than the PNG signature", () => {
    // First 4 bytes match PNG but the full 8-byte signature is absent.
    expect(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });
});

describe("expectedKinds", () => {
  it("passeport → one passport page", () => {
    expect(expectedKinds("passeport")).toEqual(["passport_page"]);
  });

  it("cni → front + back", () => {
    expect(expectedKinds("cni")).toEqual(["front", "back"]);
  });

  it("sejour → front + back", () => {
    expect(expectedKinds("sejour")).toEqual(["front", "back"]);
  });
});

describe("extForMime", () => {
  it("maps mimes to extensions", () => {
    expect(extForMime("image/jpeg")).toBe("jpg");
    expect(extForMime("image/png")).toBe("png");
    expect(extForMime("application/pdf")).toBe("pdf");
  });
});
