import type { LibraryActor, MetadataPatch, Photo, UploadPartRecord, UploadSession, UploadStatus } from "./model.js";
import type {
  ExifFill,
  ExifReading,
  JobStatus,
  JobType,
  PipelineErrorCode,
  PipelineStep,
} from "./pipeline.js";

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
  getObject(input: { key: string }): Promise<{ body: Buffer; byteSize: number } | null>;
  putObject(input: { key: string; contentType: string; body: Buffer }): Promise<void>;
  presignGet(input: { key: string; expiresInSeconds: number; now: Date }): Promise<{ url: string; expiresAt: Date }>;
};

export type PhotoMutation = {
  update(patch: MetadataPatch, now: Date): Promise<Photo | null>;
  activeJobs(): Promise<ActiveJob[]>;
  insertReembed(job: { id: string; runAfter: Date; now: Date }): Promise<"inserted" | "conflict">;
  insertProcessPhoto(job: { id: string; runAfter: Date; now: Date }): Promise<"inserted" | "conflict">;
  deletePendingReembed(): Promise<void>;
  resetForRetry(now: Date): Promise<Photo | null>;
};

export type PhotoRepository = {
  findById(id: string): Promise<Photo | null>;
  listOwned(input: { ownerId: string; limit: number; cursor: { createdAt: Date; id: string } | null }): Promise<Photo[]>;
  updateOwned(id: string, ownerId: string, patch: MetadataPatch, updatedAt: Date): Promise<Photo | null>;
  deleteOwned(id: string, ownerId: string): Promise<{ objectKey: string; thumbKey: string | null } | null>;
  ensureProcessPhoto(input: { photoId: string; jobId: string; now: Date }): Promise<"inserted" | "skipped">;
  transactOwned(
    photoId: string,
    ownerId: string,
    mutate: (photo: Photo | null, tx: PhotoMutation) => Promise<void>,
  ): Promise<void>;
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
  jobId: string;
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

export type ExifReader = {
  read(bytes: Buffer): Promise<ExifReading>;
};

export type ThumbnailEncoder = {
  encode(bytes: Buffer): Promise<{ bytes: Buffer; contentType: "image/jpeg" }>;
};

export type VisionGateway = {
  describe(input: {
    model: string;
    contentType: string;
    bytes: Buffer;
  }): Promise<
    | { ok: true; description: string | null; tags: string[] }
    | { ok: false; kind: "vision_unavailable" | "vision_rejected" }
  >;
};

export type EmbedGateway = {
  embed(input: { model: string; text: string }): Promise<
    | { ok: true; values: number[] }
    | { ok: false; kind: "embed_unavailable" | "embed_rejected" }
  >;
};

export type ClaimedJob = {
  id: string;
  type: JobType;
  photoId: string;
  step: PipelineStep;
  attempts: number;
  lockedAt: Date;
};

export type ReclaimedJob = {
  id: string;
  type: JobType;
  photoId: string;
  attempts: number;
  lastError: string | null;
};

export type ActiveJob = { type: JobType; status: "pending" | "running" };

export type JobRecord = {
  id: string;
  type: JobType;
  photoId: string;
  step: PipelineStep;
  status: JobStatus;
  attempts: number;
  lastError: string | null;
  runAfter: Date;
  lockedAt: Date | null;
};

export type EmbeddingPlan = "write" | "text_changed" | "need_thumbnail";

export type PipelineStore = {
  reclaimExpired(now: Date): Promise<ReclaimedJob[]>;
  claim(now: Date, limit: number): Promise<ClaimedJob[]>;
  readPhoto(photoId: string): Promise<Photo | null>;
  listForPhoto(photoId: string): Promise<JobRecord[]>;
  applyExif(input: { jobId: string; lockedAt: Date; photoId: string; fill: ExifFill; now: Date }): Promise<"ok" | "lost">;
  noteThumbPresent(input: { jobId: string; lockedAt: Date; now: Date }): Promise<"ok" | "lost">;
  commitThumb(input: {
    jobId: string;
    lockedAt: Date;
    photoId: string;
    thumbKey: string;
    now: Date;
  }): Promise<"ok" | "missing" | "conflict" | "lost">;
  skipVision(input: { jobId: string; lockedAt: Date; now: Date }): Promise<"ok" | "lost">;
  applyVision(input: {
    jobId: string;
    lockedAt: Date;
    photoId: string;
    description: string | null;
    tags: string[];
    now: Date;
  }): Promise<"ok" | "lost">;
  commitEmbedding(
    input: {
      jobId: string;
      lockedAt: Date;
      photoId: string;
      jobType: JobType;
      values: number[];
      dimensions: number;
      model: string;
      now: Date;
    },
    plan: (photo: Photo) => EmbeddingPlan,
  ): Promise<"written" | "text_changed" | "need_thumbnail" | "missing" | "lost">;
  rewindToThumbnail(input: { jobId: string; lockedAt: Date; now: Date }): Promise<"ok" | "lost">;
  retryJob(input: {
    jobId: string;
    lockedAt: Date;
    photoId: string;
    jobType: JobType;
    code: PipelineErrorCode;
    runAfter: Date;
    now: Date;
  }): Promise<"ok" | "lost">;
  failJob(input: {
    jobId: string;
    lockedAt: Date;
    photoId: string;
    jobType: JobType;
    code: PipelineErrorCode;
    now: Date;
  }): Promise<"ok" | "lost">;
  releaseRunning(input: { jobId: string; lockedAt: Date; now: Date }): Promise<"ok" | "lost">;
};

export type PipelineLogFields = {
  userId?: string;
  photoId?: string;
  objectKey?: string;
  jobId?: string;
  jobType?: JobType;
  step?: PipelineStep;
  attempt?: number;
  errorCode?: PipelineErrorCode | "interrupted";
  errorName?: string;
};

export type PipelineLog = {
  info(message: string, fields: PipelineLogFields): void;
  warn(message: string, fields: PipelineLogFields): void;
};
