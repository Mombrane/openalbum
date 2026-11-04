import type { FastifyBaseLogger } from "fastify";
import pg from "pg";
import type { LibraryDeps } from "./adapters/library/deps.js";
import type { LibraryLog } from "./domain/library/ports.js";
import { createPhotoRepository, createUploadSessionRepository } from "./dao/index.js";
import { createIdGenerator } from "./gateways/index.js";
import type { ObjectStorage } from "./domain/library/ports.js";

/**
 * 个人库组合根装配。禁止把本文件移进五层目录。
 */
export function createLibraryDeps(input: {
  pool: pg.Pool;
  storage: ObjectStorage;
  signedUrlTtlSeconds: number;
  log: LibraryLog;
}): LibraryDeps {
  return {
    photos: createPhotoRepository(input.pool),
    sessions: createUploadSessionRepository(input.pool),
    storage: input.storage,
    ids: createIdGenerator(),
    signedUrlTtlSeconds: input.signedUrlTtlSeconds,
    log: input.log,
  };
}

export function libraryLogFromFastify(logger: FastifyBaseLogger): LibraryLog {
  return {
    warn(message, fields) {
      logger.warn(
        {
          userId: fields.userId,
          photoId: fields.photoId,
          objectKey: fields.objectKey,
          uploadSessionId: fields.uploadSessionId,
          partNumber: fields.partNumber,
          byteSize: fields.byteSize,
          reason: fields.reason,
          errorName: fields.errorName,
        },
        message,
      );
    },
  };
}
