import { randomUUID } from "node:crypto";

export interface MultipartFile {
  name: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface MultipartInput {
  fields?: Record<string, string>;
  files?: MultipartFile[];
}

// Build a real multipart/form-data body as a Buffer. String concatenation would
// mangle binary file bytes (e.g. PNG's 0x89 magic byte is not valid UTF-8), so
// everything is assembled via Buffer.concat with CRLF separators.
export function buildMultipart(input: MultipartInput): { body: Buffer; headers: Record<string, string> } {
  const boundary = `----kpital${randomUUID()}`;
  const chunks: Buffer[] = [];

  for (const [name, value] of Object.entries(input.fields ?? {})) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
    );
  }

  for (const f of input.files ?? []) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: ${f.contentType}\r\n\r\n`,
      ),
    );
    chunks.push(f.data);
    chunks.push(Buffer.from("\r\n"));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    body: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}
