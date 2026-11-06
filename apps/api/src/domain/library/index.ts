/** 照片库上下文（Phase 2–3）：个人照片、元数据、处理状态。 */
export const LIBRARY_CONTEXT = "library" as const;

export { CONTENT_TYPES, normalizeContentType } from "./content-type.js";
export { MAX_COMPLETE_PARTS, MAX_PART_NUMBER, MAX_PHOTO_BYTES, MIN_NON_FINAL_PART_BYTES, UPLOAD_TTL_MS } from "./constants.js";
export { decodePhotoCursor, encodePhotoCursor, parsePhotoLimit } from "./cursor.js";
export { normalizeMetadataPatch } from "./metadata-patch.js";
export { photoObjectKey } from "./object-key.js";
export { validatePartsForComplete } from "./parts.js";
export { isVisiblePhoto } from "./visibility.js";
export {
  PIPELINE_LEASE_MS,
  PIPELINE_MAX_ATTEMPTS,
  ThumbnailEncodeError,
  checkEmbedding,
  embeddingInput,
  exifFill,
  failureDisposition,
  normalizeVisionDescription,
  normalizeVisionTags,
  parseJobStep,
  parsePhotoStatus,
  semanticChanged,
  shouldCallVision,
  thumbObjectKey,
  visionWrite,
} from "./pipeline.js";
export type {
  ActiveJob,
  ClaimedJob,
  EmbedGateway,
  EmbeddingPlan,
  ExifReader,
  JobRecord,
  PipelineLog,
  PipelineLogFields,
  PipelineStore,
  ReclaimedJob,
  ThumbnailEncoder,
  VisionGateway,
} from "./ports.js";
export type {
  ExifFill,
  ExifReading,
  JobStatus,
  JobType,
  PhotoStatus,
  PipelineErrorCode,
  PipelineStep,
} from "./pipeline.js";
export type {
  CompletionLock,
  InsertCompletedPhoto,
  LibraryLog,
  LibraryLogFields,
  NewUploadSession,
  ObjectStorage,
  PhotoRepository,
  UploadSessionRepository,
  UploadSessionTx,
} from "./ports.js";
export type {
  LibraryActor,
  MetadataPatch,
  PartSize,
  Photo,
  UploadPartRecord,
  UploadSession,
  UploadStatus,
} from "./model.js";
