import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ObjectStorage } from "../../domain/library/ports.js";
import type { StorageConfig } from "./config.js";

export type S3CommandClient = {
  send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<Record<string, unknown>>;
};

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
