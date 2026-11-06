import type { PhotoStatus } from "./pipeline.js";

export type LibraryActor = {
  userId: string;
  credentialKind: "password_session" | "api_key";
  credentialId: string;
};

export type UploadStatus = "open" | "completing" | "completed" | "aborted";

export type Photo = {
  id: string;
  ownerId: string;
  objectKey: string;
  thumbKey: string | null;
  contentType: string;
  byteSize: number;
  takenAt: Date | null;
  locationText: string | null;
  latitude: number | null;
  longitude: number | null;
  description: string | null;
  tags: string[];
  status: PhotoStatus;
  sourceUserId: string | null;
  sourceKeyId: string | null;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MetadataPatch = {
  description?: string | null;
  tags?: string[];
  takenAt?: Date | null;
  locationText?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

export type UploadSession = {
  id: string;
  ownerId: string;
  photoId: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  s3UploadId: string;
  status: UploadStatus;
  objectCompletedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type UploadPartRecord = {
  partNumber: number;
  etag: string;
  byteSize: number;
};

export type PartSize = { partNumber: number; byteSize: number };
