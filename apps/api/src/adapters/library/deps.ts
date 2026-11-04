import type { LibraryLog, ObjectStorage, PhotoRepository, UploadSessionRepository } from "../../domain/library/ports.js";

export type LibraryDeps = {
  photos: PhotoRepository;
  sessions: UploadSessionRepository;
  storage: ObjectStorage;
  ids: { nextId(): string };
  signedUrlTtlSeconds: number;
  log: LibraryLog;
};
