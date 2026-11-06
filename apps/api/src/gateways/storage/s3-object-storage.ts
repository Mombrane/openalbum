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

function abortError(): Error {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

async function sendWithStorageTimeout(
  client: S3CommandClient,
  command: { constructor: { name: string }; input: Record<string, unknown> },
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STORAGE_TIMEOUT_MS);
  try {
    return await client.send(command, { abortSignal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readWithAbortSignal<T>(promise: Promise<T>, signal: AbortSignal, body?: unknown): Promise<T> {
  if (signal.aborted) {
    const error = abortError();
    destroyBody(body, error);
    promise.catch(() => undefined);
    throw error;
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      const error = abortError();
      destroyBody(body, error);
      reject(error);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function destroyBody(body: unknown, error: Error): void {
  if (body && typeof body === "object" && "destroy" in body && typeof (body as { destroy?: unknown }).destroy === "function") {
    (body as { destroy: (error: Error) => void }).destroy(error);
  }
}

async function bytesOf(body: unknown, signal?: AbortSignal): Promise<Buffer> {
  if (Buffer.isBuffer(body)) {
    if (signal) await readWithAbortSignal(Promise.resolve(body), signal);
    return Buffer.from(body);
  }
  if (body instanceof Uint8Array) {
    if (signal) await readWithAbortSignal(Promise.resolve(body), signal);
    return Buffer.from(body);
  }
  if (body && typeof body === "object" && "transformToByteArray" in body && typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
    const stream = body as { transformToByteArray: (options?: { abortSignal?: AbortSignal }) => Promise<Uint8Array> };
    const read = stream.transformToByteArray(signal ? { abortSignal: signal } : undefined);
    const array = signal ? await readWithAbortSignal(read, signal, body) : await read;
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
  getTimeoutMs = STORAGE_TIMEOUT_MS,
): ObjectStorage {
  const bucket = config.bucket;
  return {
    async createMultipartUpload(input) {
      const result = await client.send(new CreateMultipartUploadCommand({
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
      const result = await client.send(new UploadPartCommand({
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
      await client.send(new CompleteMultipartUploadCommand({
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
        await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: input.key, UploadId: input.uploadId }) as never);
      } catch (error) {
        if (!named(error, "NoSuchUpload")) throw error;
      }
    },
    async headObject(input) {
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: input.key }) as never);
        return { byteSize: Number(result.ContentLength ?? 0) };
      } catch (error) {
        if (named(error, "NotFound")) return null;
        throw error;
      }
    },
    async deleteObject(input) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: input.key }) as never);
      } catch (error) {
        if (!named(error, "NotFound")) throw error;
      }
    },
    async getObject(input) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), getTimeoutMs);
      try {
        try {
          const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: input.key }) as never, {
            abortSignal: controller.signal,
          });
          const body = await bytesOf(result.Body, controller.signal);
          return { body, byteSize: body.length };
        } catch (error) {
          if (named(error, "NotFound") || named(error, "NoSuchKey")) return null;
          throw error;
        }
      } finally {
        clearTimeout(timer);
      }
    },
    async putObject(input) {
      await sendWithStorageTimeout(client, new PutObjectCommand({
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
