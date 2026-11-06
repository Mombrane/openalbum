import type { FastifyBaseLogger } from "fastify";
import pg from "pg";
import type { LibraryDeps } from "./adapters/library/deps.js";
import type { SearchDeps, SearchLog } from "./adapters/search/deps.js";
import { createSearchRepository } from "./dao/index.js";
import type { EmbedGateway } from "./domain/library/ports.js";

/**
 * 检索组合根装配。禁止把本文件移进五层目录。
 */
export function searchLogFromFastify(logger: FastifyBaseLogger): SearchLog {
  return {
    warn(message, fields) {
      logger.warn(
        {
          userId: fields.userId,
          mode: fields.mode,
          errorCode: fields.errorCode,
          photoId: fields.photoId,
          objectKey: fields.objectKey,
          errorName: fields.errorName,
        },
        message,
      );
    },
  };
}

export function createSearchDeps(input: {
  pool: pg.Pool;
  library: LibraryDeps;
  embed: EmbedGateway | null;
  embedModel: string | null;
  log: SearchLog;
}): SearchDeps {
  return {
    port: createSearchRepository(input.pool),
    embed: input.embed,
    embedModel: input.embedModel,
    library: input.library,
    log: input.log,
  };
}
