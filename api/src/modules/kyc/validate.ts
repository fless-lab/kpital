import { kycDocKind, kycDocType } from "../../db/schema";

export type KycDocKind = (typeof kycDocKind.enumValues)[number];
export type KycDocType = (typeof kycDocType.enumValues)[number];

export type SniffedMime = "image/jpeg" | "image/png" | "application/pdf";

const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF_SIG = Buffer.from([0x25, 0x50, 0x44, 0x46]); // "%PDF"

// Identify a file by its leading magic bytes, ignoring any client-supplied
// extension or Content-Type. Returns null when the bytes match no allowed type.
export function sniffMime(buf: Buffer): SniffedMime | null {
  if (buf.length >= PNG_SIG.length && buf.subarray(0, PNG_SIG.length).equals(PNG_SIG)) {
    return "image/png";
  }
  if (buf.length >= JPEG_SIG.length && buf.subarray(0, JPEG_SIG.length).equals(JPEG_SIG)) {
    return "image/jpeg";
  }
  if (buf.length >= PDF_SIG.length && buf.subarray(0, PDF_SIG.length).equals(PDF_SIG)) {
    return "application/pdf";
  }
  return null;
}

export function extForMime(mime: SniffedMime): "jpg" | "png" | "pdf" {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "application/pdf":
      return "pdf";
  }
}

// The exact document kinds a submission of this doc type must provide.
// passeport → a single page; cni/sejour → both sides.
export function expectedKinds(docType: KycDocType): KycDocKind[] {
  switch (docType) {
    case "passeport":
      return ["passport_page"];
    case "cni":
    case "sejour":
      return ["front", "back"];
  }
}
