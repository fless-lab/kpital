import type { Readable } from "node:stream";
import type { StorageProvider } from "./index";

export class MemoryStorage implements StorageProvider {
  objects = new Map<string, { body: Buffer; contentType: string }>();

  async put(key: string, body: Buffer | Readable, contentType: string): Promise<void> {
    this.objects.set(key, {
      body: Buffer.isBuffer(body) ? body : Buffer.from([]),
      contentType,
    });
  }

  async getSignedUrl(key: string, ttlSeconds: number): Promise<string> {
    return `memory://signed/${key}?ttl=${ttlSeconds}`;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}
