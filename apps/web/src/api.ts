import { SESSION_EXPIRED } from "./copy";
import { session, type SessionController } from "./session";

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; kind: "aborted" }
  | { ok: false; kind: "network" }
  | {
      ok: false;
      kind: "http";
      status: number;
      code: string | null;
      serverMessage: string | null;
    };

export type Photo = {
  id: string;
  contentType: string;
  byteSize: number;
  takenAt: string | null;
  locationText: string | null;
  latitude: number | null;
  longitude: number | null;
  description: string | null;
  tags: string[];
  status: "processing" | "ready" | "failed";
  errorCode: string | null;
  originalUrl: string;
  originalUrlExpiresAt: string;
  thumbUrl: string | null;
  thumbUrlExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ApiKey = {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type PhotoPatchBody = {
  description?: string | null;
  tags?: string[];
  takenAt?: string | null;
  locationText?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

export type Api = {
  register: (email: string, password: string) => Promise<ApiResult<null>>;
  login: (email: string, password: string) => Promise<ApiResult<null>>;
  listPhotos: (
    cursor: string | null,
  ) => Promise<ApiResult<{ photos: Photo[]; nextCursor: string | null }>>;
  getPhoto: (id: string) => Promise<ApiResult<Photo>>;
  createUpload: (
    contentType: string,
    byteSize: number,
  ) => Promise<ApiResult<{ uploadId: string; photoId: string }>>;
  putPart: (uploadId: string, body: Blob) => Promise<ApiResult<null>>;
  completeUpload: (uploadId: string) => Promise<ApiResult<Photo>>;
  abortUpload: (uploadId: string) => Promise<ApiResult<null>>;
  patchPhoto: (id: string, body: PhotoPatchBody) => Promise<ApiResult<Photo>>;
  deletePhoto: (id: string) => Promise<ApiResult<null>>;
  retryPhoto: (id: string) => Promise<ApiResult<Photo | null>>;
  listKeys: () => Promise<ApiResult<{ apiKeys: ApiKey[] }>>;
  createKey: (name: string) => Promise<ApiResult<{ apiKey: ApiKey; secret: string }>>;
  revokeKey: (id: string) => Promise<ApiResult<null>>;
};

type HttpFail = Extract<ApiResult<never>, { kind: "http" }>;

function parseErrorBody(body: unknown): { code: string | null; serverMessage: string | null } {
  if (typeof body !== "object" || body === null) {
    return { code: null, serverMessage: null };
  }
  const error = (body as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null) {
    return { code: null, serverMessage: null };
  }
  const code = (error as Record<string, unknown>).code;
  const message = (error as Record<string, unknown>).message;
  if (typeof code === "string" && typeof message === "string") {
    return { code, serverMessage: message };
  }
  return { code: null, serverMessage: null };
}

function parseString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parsePhoto(raw: unknown): Photo | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const status = record.status;
  if (status !== "processing" && status !== "ready" && status !== "failed") return null;
  const id = parseString(record.id);
  const contentType = parseString(record.contentType);
  const originalUrl = parseString(record.originalUrl);
  const originalUrlExpiresAt = parseString(record.originalUrlExpiresAt);
  const createdAt = parseString(record.createdAt);
  const updatedAt = parseString(record.updatedAt);
  if (
    id === null ||
    contentType === null ||
    originalUrl === null ||
    originalUrlExpiresAt === null ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null;
  }
  if (typeof record.byteSize !== "number" || !Number.isFinite(record.byteSize)) return null;
  const takenAt =
    record.takenAt === null ? null : parseString(record.takenAt);
  const locationText =
    record.locationText === null ? null : parseString(record.locationText);
  const description =
    record.description === null ? null : parseString(record.description);
  const errorCode = record.errorCode === null ? null : parseString(record.errorCode);
  const thumbUrl = record.thumbUrl === null ? null : parseString(record.thumbUrl);
  const thumbUrlExpiresAt =
    record.thumbUrlExpiresAt === null ? null : parseString(record.thumbUrlExpiresAt);
  if (record.latitude !== null && (typeof record.latitude !== "number" || !Number.isFinite(record.latitude))) {
    return null;
  }
  if (
    record.longitude !== null &&
    (typeof record.longitude !== "number" || !Number.isFinite(record.longitude))
  ) {
    return null;
  }
  const latitude = record.latitude === null ? null : (record.latitude as number);
  const longitude = record.longitude === null ? null : (record.longitude as number);
  if (record.takenAt !== null && takenAt === null) return null;
  if (record.locationText !== null && locationText === null) return null;
  if (record.description !== null && description === null) return null;
  if (record.errorCode !== null && errorCode === null) return null;
  if (record.thumbUrl !== null && thumbUrl === null) return null;
  if (record.thumbUrlExpiresAt !== null && thumbUrlExpiresAt === null) return null;
  if (!Array.isArray(record.tags) || record.tags.some((tag) => typeof tag !== "string")) {
    return null;
  }
  return {
    id,
    contentType,
    byteSize: record.byteSize,
    takenAt,
    locationText,
    latitude,
    longitude,
    description,
    tags: record.tags,
    status,
    errorCode,
    originalUrl,
    originalUrlExpiresAt,
    thumbUrl,
    thumbUrlExpiresAt,
    createdAt,
    updatedAt,
  };
}

function photoRoot(body: unknown): unknown {
  if (typeof body === "object" && body !== null && "photo" in body) {
    return (body as Record<string, unknown>).photo;
  }
  return body;
}

function parseApiKey(raw: unknown): ApiKey | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const id = parseString(record.id);
  const name = parseString(record.name);
  const keyPrefix = parseString(record.keyPrefix);
  const createdAt = parseString(record.createdAt);
  if (id === null || name === null || keyPrefix === null || createdAt === null) return null;
  const lastUsedAt = record.lastUsedAt === null ? null : parseString(record.lastUsedAt);
  const revokedAt = record.revokedAt === null ? null : parseString(record.revokedAt);
  if (record.lastUsedAt !== null && lastUsedAt === null) return null;
  if (record.revokedAt !== null && revokedAt === null) return null;
  return { id, name, keyPrefix, createdAt, lastUsedAt, revokedAt };
}

async function responseToHttpFail(response: Response): Promise<HttpFail> {
  let parsed = { code: null as string | null, serverMessage: null as string | null };
  try {
    parsed = parseErrorBody(await response.json());
  } catch {
    parsed = { code: null, serverMessage: null };
  }
  return {
    ok: false,
    kind: "http",
    status: response.status,
    code: parsed.code,
    serverMessage: parsed.serverMessage,
  };
}

function malformedHttp(status: number): HttpFail {
  return { ok: false, kind: "http", status, code: null, serverMessage: null };
}

export function createApi(deps: { session: SessionController; fetch: typeof fetch }): Api {
  const performFetch = async (
    url: string,
    init: RequestInit,
    protectedRequest: boolean,
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
  if (protectedRequest) {
      const token = deps.session.getAccessToken();
      if (token !== null) {
        headers.set("Authorization", `Bearer ${token}`);
      }
    }
    return deps.fetch(url, { ...init, headers });
  };

  const request = async (
    url: string,
    init: RequestInit,
    protectedRequest: boolean,
  ): Promise<Response> => {
    let response = await performFetch(url, init, protectedRequest);
    if (protectedRequest && response.status === 401) {
      const outcome = await deps.session.refreshSingleFlight();
      if (outcome === "ok") {
        response = await performFetch(url, init, protectedRequest);
        if (response.status === 401) {
          deps.session.clear(SESSION_EXPIRED);
        }
      }
    }
    return response;
  };

  const runProtected = async <T>(
    url: string,
    init: RequestInit,
    parseSuccess: (response: Response) => Promise<ApiResult<T>>,
  ): Promise<ApiResult<T>> => {
    try {
      const response = await request(url, init, true);
      if (!response.ok) {
        return responseToHttpFail(response);
      }
      return parseSuccess(response);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { ok: false, kind: "aborted" };
      }
      return { ok: false, kind: "network" };
    }
  };

  const runJson = async <T>(
    url: string,
    init: RequestInit,
    protectedRequest: boolean,
    parseSuccess: (body: unknown, status: number) => ApiResult<T>,
  ): Promise<ApiResult<T>> => {
    try {
      const response = await request(url, init, protectedRequest);
      if (!response.ok) {
        return responseToHttpFail(response);
      }
      if (response.status === 204) {
        return { ok: true, status: 204, data: null as T };
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return malformedHttp(response.status);
      }
      return parseSuccess(body, response.status);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { ok: false, kind: "aborted" };
      }
      return { ok: false, kind: "network" };
    }
  };

  const runAuth = async (url: string, email: string, password: string): Promise<ApiResult<null>> => {
    try {
      const response = await deps.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) {
        return responseToHttpFail(response);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return malformedHttp(response.status);
      }
      if (!deps.session.applyAuthBody(body)) {
        return { ok: false, kind: "http", status: response.status, code: null, serverMessage: null };
      }
      return { ok: true, status: response.status, data: null };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { ok: false, kind: "aborted" };
      }
      return { ok: false, kind: "network" };
    }
  };

  return {
    register: (email, password) => runAuth("/api/auth/register", email, password),
    login: (email, password) => runAuth("/api/auth/login", email, password),

    listPhotos: (cursor) => {
      let url = "/api/photos?limit=50";
      if (cursor !== null) {
        url += `&cursor=${encodeURIComponent(cursor)}`;
      }
      return runJson(url, { method: "GET" }, true, (body, status) => {
        if (typeof body !== "object" || body === null) return malformedHttp(status);
        const record = body as Record<string, unknown>;
        if (!Array.isArray(record.photos)) return malformedHttp(status);
        const photos: Photo[] = [];
        for (const item of record.photos) {
          const photo = parsePhoto(item);
          if (photo === null) return malformedHttp(status);
          photos.push(photo);
        }
        const nextCursor =
          record.nextCursor === null
            ? null
            : typeof record.nextCursor === "string"
              ? record.nextCursor
              : null;
        return { ok: true, status, data: { photos, nextCursor } };
      });
    },

    getPhoto: (id) =>
      runJson(`/api/photos/${id}`, { method: "GET" }, true, (body, status) => {
        const photo = parsePhoto(photoRoot(body));
        if (photo === null) return malformedHttp(status);
        return { ok: true, status, data: photo };
      }),

    createUpload: (contentType, byteSize) =>
      runJson(
        "/api/photos/uploads",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contentType, byteSize }),
        },
        true,
        (body, status) => {
          if (typeof body !== "object" || body === null) return malformedHttp(status);
          const upload = (body as Record<string, unknown>).upload;
          if (typeof upload !== "object" || upload === null) return malformedHttp(status);
          const uploadRecord = upload as Record<string, unknown>;
          const uploadId = parseString(uploadRecord.id);
          const photoId = parseString(uploadRecord.photoId);
          if (uploadId === null || photoId === null) return malformedHttp(status);
          return { ok: true, status, data: { uploadId, photoId } };
        },
      ),

    putPart: (uploadId, body) =>
      runProtected(`/api/photos/uploads/${uploadId}/parts/1`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body,
      }, async (response) => {
        if (response.status === 204) {
          return { ok: true, status: 204, data: null };
        }
        return responseToHttpFail(response);
      }),

    completeUpload: (uploadId) =>
      runJson(
        `/api/photos/uploads/${uploadId}/complete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
        true,
        (body, status) => {
          const photo = parsePhoto(photoRoot(body));
          if (photo === null) return malformedHttp(status);
          return { ok: true, status, data: photo };
        },
      ),

    abortUpload: (uploadId) =>
      runJson(
        `/api/photos/uploads/${uploadId}/abort`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
        true,
        (_body, status) => ({ ok: true, status, data: null }),
      ),

    patchPhoto: (id, body) =>
      runJson(
        `/api/photos/${id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        true,
        (responseBody, status) => {
          const photo = parsePhoto(photoRoot(responseBody));
          if (photo === null) return malformedHttp(status);
          return { ok: true, status, data: photo };
        },
      ),

    deletePhoto: (id) =>
      runJson(`/api/photos/${id}`, { method: "DELETE" }, true, (_body, status) => ({
        ok: true,
        status,
        data: null,
      })),

    retryPhoto: (id) =>
      runJson(
        `/api/photos/${id}/retry`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
        true,
        (body, status) => {
          if (status === 204) {
            return { ok: true, status: 204, data: null };
          }
          const photo = parsePhoto(photoRoot(body));
          if (photo === null) return malformedHttp(status);
          return { ok: true, status, data: photo };
        },
      ),

    listKeys: () =>
      runJson("/api/api-keys", { method: "GET" }, true, (body, status) => {
        if (typeof body !== "object" || body === null) return malformedHttp(status);
        const rawKeys = (body as Record<string, unknown>).apiKeys;
        if (!Array.isArray(rawKeys)) return malformedHttp(status);
        const apiKeys: ApiKey[] = [];
        for (const item of rawKeys) {
          const key = parseApiKey(item);
          if (key === null) return malformedHttp(status);
          apiKeys.push(key);
        }
        return { ok: true, status, data: { apiKeys } };
      }),

    createKey: (name) =>
      runJson(
        "/api/api-keys",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        },
        true,
        (body, status) => {
          if (typeof body !== "object" || body === null) return malformedHttp(status);
          const record = body as Record<string, unknown>;
          const apiKey = parseApiKey(record.apiKey);
          const secret = parseString(record.secret);
          if (apiKey === null || secret === null) return malformedHttp(status);
          return { ok: true, status, data: { apiKey, secret } };
        },
      ),

    revokeKey: (id) =>
      runJson(`/api/api-keys/${id}`, { method: "DELETE" }, true, (_body, status) => ({
        ok: true,
        status,
        data: null,
      })),
  };
}

export const api = createApi({
  session,
  fetch: globalThis.fetch.bind(globalThis),
});
