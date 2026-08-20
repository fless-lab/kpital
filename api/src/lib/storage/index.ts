import type { Readable } from "node:stream";
import type { Config } from "../../config/env";
import { MinioStorage } from "./minio";

export interface StorageProvider {
  put(key: string, body: Buffer | Readable, contentType: string): Promise<void>;
  getSignedUrl(key: string, ttlSeconds: number): Promise<string>;
  delete(key: string): Promise<void>;
}

export function makeStorage(config: Config): StorageProvider {
  return new MinioStorage(config);
}
