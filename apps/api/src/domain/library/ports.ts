import type { LibraryActor, MetadataPatch, Photo, UploadPartRecord, UploadSession, UploadStatus } from "./model.js";

export type ObjectStorage = {
  createMultipartUpload(input: { key: string; contentType: string }): Promise<{ uploadId: string }>;
  uploadPart(input: { key: string; uploadId: string; partNumber: number; body: Buffer }): Promise<{ etag: string; byteSize: number }>;
  completeMultipartUpload(input: {
    key: string;
    uploadId: string;
    parts: { partNumber: number; etag: string }[];
  }): Promise<void>;
  abortMultipartUpload(input: { key: string; uploadId: string }): Promise<void>;
  headObject(input: { key: string }): Promise<{ byteSize: number } | null>;
  deleteObject(input: { key: string }): Promise<void>;
  presignGet(input: { key: string; expiresInSeconds: number; now: Date }): Promise<{ url: string; expiresAt: Date }>;
};

export type PhotoRepository = {
  findById(id: string): Promise<Photo | null>;
  listOwned(input: { ownerId: string; limit: number; cursor: { createdAt: Date; id: string } | null }): Promise<Photo[]>;
  updateOwned(id: string, ownerId: string, patch: MetadataPatch, updatedAt: Date): Promise<Photo | null>;
  deleteOwned(id: string, ownerId: string): Promise<{ objectKey: string; thumbKey: string | null } | null>;
};

export type NewUploadSession = {
  id: string;
  ownerId: string;
  photoId: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  s3UploadId: string;
  expiresAt: Date;
  createdAt: Date;
};

export type UploadSessionTx = {
  listParts(sessionId: string): Promise<UploadPartRecord[]>;
  upsertPart(sessionId: string, part: UploadPartRecord): Promise<void>;
  setCompleting(sessionId: string, now: Date): Promise<void>;
  markAborted(sessionId: string, now: Date): Promise<void>;
};

export type CompletionLock = { release(): Promise<void> };

export type InsertCompletedPhoto = {
  sessionId: string;
  photoId: string;
  ownerId: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  sourceUserId: string;
  sourceKeyId: string | null;
  now: Date;
};

export type UploadSessionRepository = {
  insert(session: NewUploadSession): Promise<void>;
  listExpiredOpen(ownerId: string, now: Date): Promise<UploadSession[]>;
  transactById(id: string, mutate: (row: UploadSession | null, tx: UploadSessionTx) => Promise<void>): Promise<void>;
  tryCompletionLock(sessionId: string): Promise<CompletionLock | null>;
  markObjectCompleted(id: string, at: Date): Promise<void>;
  reopenIfNoObject(id: string, now: Date): Promise<"reopened" | "kept">;
  insertPhotoAndComplete(input: InsertCompletedPhoto): Promise<"inserted" | "exists">;
};

export type LibraryLogFields = {
  userId?: string;
  photoId?: string;
  objectKey?: string;
  uploadSessionId?: string;
  partNumber?: number;
  byteSize?: number;
  reason?: "client" | "expired";
  errorName?: string;
};

export type LibraryLog = {
  warn(message: string, fields: LibraryLogFields): void;
};

export type { LibraryActor, UploadStatus };
