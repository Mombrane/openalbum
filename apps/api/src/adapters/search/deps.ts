import type { EmbedGateway, LibraryLog, ObjectStorage, PhotoRepository, UploadSessionRepository } from "../../domain/library/ports.js";
import type { SearchPort } from "../../domain/search/ports.js";

export type SearchLogFields = {
  userId?: string;
  mode?: "keyword" | "semantic";
  errorCode?: string;
  photoId?: string;
  objectKey?: string;
  errorName?: string;
};

export type SearchLog = {
  warn(message: string, fields: SearchLogFields): void;
};

export type SearchSigningDeps = {
  photos: PhotoRepository;
  sessions: UploadSessionRepository;
  storage: ObjectStorage;
  ids: { nextId(): string };
  signedUrlTtlSeconds: number;
  log: LibraryLog;
};

export type SearchDeps = {
  port: SearchPort;
  embed: EmbedGateway | null;
  embedModel: string | null;
  library: SearchSigningDeps;
  log: SearchLog;
};
