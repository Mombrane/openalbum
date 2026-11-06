import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ObjectStorage } from "../../domain/library/ports.js";
import type { StorageConfig } from "./config.js";

export type S3CommandClient = {
  send(
    command: { constructor: { name: string }; input: Record<string, unknown> },
    options?: { abortSignal?: AbortSignal },
  ): Promise<Record<string, unknown>>;
};

const STORAGE_TIMEOUT_MS = 60_000;

async function sendCommand(client: S3CommandClient, command: { constructor: { name: string }; input: Record<string, unknown> }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STORAGE_TIMEOUT_MS);
  try {
    return await client.send(command, { abortSignal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function bytesOf(body: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body && typeof body === "object" && "transformToByteArray" in body && typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
    const array = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
    return Buffer.from(array);
  }
  throw Object.assign(new Error("hidden"), { name: "StorageError" });
}

export function createS3ObjectStorage(
  config: StorageConfig,
  client: S3CommandClient = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  }) as unknown as S3CommandClient,
  presign: (command: unknown, options: { expiresIn: number }) => Promise<string> = (command, options) =>
    getSignedUrl(client as never, command as never, options),
): ObjectStorage {
  const bucket = config.bucket;
  return {
    async createMultipartUpload(input) {
      const result = await sendCommand(client, new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: input.key,
        ContentType: input.contentType,
      }) as never);
      if (typeof result.UploadId !== "string" || result.UploadId.length === 0) {
        throw Object.assign(new Error("hidden"), { name: "StorageError" });
      }
      return { uploadId: result.UploadId };
    },
    async uploadPart(input) {
      const result = await sendCommand(client, new UploadPartCommand({
        Bucket: bucket,
        Key: input.key,
        UploadId: input.uploadId,
        PartNumber: input.partNumber,
        Body: input.body,
      }) as never);
      if (typeof result.ETag !== "string") throw Object.assign(new Error("hidden"), { name: "StorageError" });
      return { etag: result.ETag, byteSize: input.body.length };
    },
    async completeMultipartUpload(input) {
      await sendCommand(client, new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: input.key,
        UploadId: input.uploadId,
        MultipartUpload: {
          Parts: input.parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
        },
      }) as never);
    },
    async abortMultipartUpload(input) {
      try {
        await sendCommand(client, new AbortMultipartUploadCommand({ Bucket: bucket, Key: input.key, UploadId: input.uploadId }) as never);
      } catch (error) {
        if (!named(error, "NoSuchUpload")) throw error;
      }
    },
    async headObject(input) {
      try {
        const result = await sendCommand(client, new HeadObjectCommand({ Bucket: bucket, Key: input.key }) as never);
        return { byteSize: Number(result.ContentLength ?? 0) };
      } catch (error) {
        if (named(error, "NotFound")) return null;
        throw error;
      }
    },
    async deleteObject(input) {
      try {
        await sendCommand(client, new DeleteObjectCommand({ Bucket: bucket, Key: input.key }) as never);
      } catch (error) {
        if (!named(error, "NotFound")) throw error;
      }
    },
    async getObject(input) {
      try {
        const result = await sendCommand(client, new GetObjectCommand({ Bucket: bucket, Key: input.key }) as never);
        const body = await bytesOf(result.Body);
        return { body, byteSize: body.length };
      } catch (error) {
        if (named(error, "NotFound") || named(error, "NoSuchKey")) return null;
        throw error;
      }
    },
    async putObject(input) {
      await sendCommand(client, new PutObjectCommand({
        Bucket: bucket,
        Key: input.key,
        ContentType: input.contentType,
        Body: input.body,
      }) as never);
    },
    async presignGet(input) {
      const url = await presign(new GetObjectCommand({ Bucket: bucket, Key: input.key }), {
        expiresIn: input.expiresInSeconds,
      });
      return { url, expiresAt: new Date(input.now.getTime() + input.expiresInSeconds * 1000) };
    },
  };
}

function named(error: unknown, name: string): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === name;
}
