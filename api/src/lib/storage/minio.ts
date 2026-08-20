import type { Readable } from "node:stream";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Config } from "../../config/env";
import type { StorageProvider } from "./index";

export class MinioStorage implements StorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;
  private ensureBucketPromise: Promise<void> | null = null;

  constructor(config: Config) {
    this.bucket = config.minioBucket;
    this.client = new S3Client({
      endpoint: config.minioEndpoint,
      region: config.minioRegion,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.minioAccessKey,
        secretAccessKey: config.minioSecretKey,
      },
    });
  }

  private ensureBucket(): Promise<void> {
    if (!this.ensureBucketPromise) {
      this.ensureBucketPromise = this.doEnsureBucket();
    }
    return this.ensureBucketPromise;
  }

  private async doEnsureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (err: unknown) {
      if (isNotFound(err)) {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        return;
      }
      throw err;
    }
  }

  async put(key: string, body: Buffer | Readable, contentType: string): Promise<void> {
    await this.ensureBucket();
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ServerSideEncryption: "AES256",
      }),
    );
  }

  async getSignedUrl(key: string, ttlSeconds: number): Promise<string> {
    await this.ensureBucket();
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }

  async delete(key: string): Promise<void> {
    await this.ensureBucket();
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
    Code?: string;
  };
  return (
    e.$metadata?.httpStatusCode === 404 ||
    e.name === "NotFound" ||
    e.name === "NoSuchBucket" ||
    e.Code === "NoSuchBucket"
  );
}
