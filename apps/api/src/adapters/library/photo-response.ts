import type { Photo } from "../../domain/library/model.js";
import type { LibraryDeps } from "./deps.js";

export type PhotoResponse = {
  id: string;
  contentType: string;
  byteSize: number;
  takenAt: string | null;
  locationText: string | null;
  latitude: number | null;
  longitude: number | null;
  description: string | null;
  tags: string[];
  status: string;
  originalUrl: string;
  originalUrlExpiresAt: string;
  createdAt: string;
  updatedAt: string;
};

export async function toPhotoResponse(deps: LibraryDeps, photo: Photo, now: Date): Promise<PhotoResponse> {
  const signed = await deps.storage.presignGet({
    key: photo.objectKey,
    expiresInSeconds: deps.signedUrlTtlSeconds,
    now,
  });
  return {
    id: photo.id,
    contentType: photo.contentType,
    byteSize: photo.byteSize,
    takenAt: photo.takenAt?.toISOString() ?? null,
    locationText: photo.locationText,
    latitude: photo.latitude,
    longitude: photo.longitude,
    description: photo.description,
    tags: photo.tags,
    status: photo.status,
    originalUrl: signed.url,
    originalUrlExpiresAt: signed.expiresAt.toISOString(),
    createdAt: photo.createdAt.toISOString(),
    updatedAt: photo.updatedAt.toISOString(),
  };
}
