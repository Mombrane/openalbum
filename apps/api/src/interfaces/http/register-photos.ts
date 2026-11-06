import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  abortUpload,
  completeUpload,
  createUpload,
  deletePhoto,
  getPhoto,
  isPrincipal,
  listPhotos,
  patchPhoto,
  requirePrincipal,
  retryPhoto,
  searchPhotos,
  uploadPart,
  type IdentityDeps,
  type LibraryDeps,
  type SearchDeps,
} from "../../adapters/index.js";
import type { LibraryActor } from "../../domain/library/model.js";
import type { Principal } from "../../domain/identity/model.js";
import type { Clock } from "../../domain/identity/ports.js";
import { decodePhotoCursor, parsePhotoLimit } from "../../domain/library/index.js";
import { normalizeMetadataPatch } from "../../domain/library/metadata-patch.js";
import { LIBRARY_MESSAGES } from "../../adapters/library/messages.js";
import { sendAuthError, sendInvalid } from "./send-auth-error.js";
import { sendLibraryResult } from "./send-library-error.js";
import { sendSearchResult } from "./send-search-result.js";
import { parseUuid } from "./validation.js";

const principals = new WeakMap<FastifyRequest, Principal>();

const uploadBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["contentType", "byteSize"],
  properties: {
    contentType: { type: "string" },
    byteSize: { type: "integer" },
  },
};

const photosQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "string" },
    cursor: { type: "string" },
  },
};

const patchBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    description: {},
    tags: {},
    takenAt: {},
    locationText: {},
    latitude: {},
    longitude: {},
  },
};

const PART_NUMBER_RE = /^[1-9][0-9]{0,4}$/;
const PART_BODY_LIMIT = 33_554_432;
const SEARCH_BODY_LIMIT = 16 * 1024;

function toLibraryActor(principal: Principal): LibraryActor {
  return {
    userId: principal.userId,
    credentialKind: principal.credentialKind,
    credentialId: principal.credentialId,
  };
}

function authorizationHeader(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? undefined : raw;
}

function parsePartNumber(raw: string): number | { message: string } {
  if (!PART_NUMBER_RE.test(raw)) return { message: LIBRARY_MESSAGES.badPart };
  const value = Number(raw);
  if (value < 1 || value > 10_000) return { message: LIBRARY_MESSAGES.badPart };
  return value;
}

function isOctetStream(contentType: string | string[] | undefined): boolean {
  const raw = Array.isArray(contentType) ? contentType[0] : contentType;
  if (!raw) return false;
  return raw.split(";")[0]?.trim().toLowerCase() === "application/octet-stream";
}

function isAllowedEmptyJson(raw: unknown): boolean {
  if (raw === undefined || raw === null) return true;
  if (typeof raw === "object" && !Array.isArray(raw) && !(raw instanceof Buffer) && Object.keys(raw).length === 0) {
    return true;
  }
  return false;
}

function registerPartRoute(
  app: FastifyInstance,
  method: "put" | "post",
  identity: IdentityDeps,
  library: LibraryDeps,
  clock: Clock,
): void {
  app[method](
    "/photos/uploads/:id/parts/:partNumber",
    { bodyLimit: PART_BODY_LIMIT },
    async (request, reply) => {
      const principal = await requirePrincipal(identity, authorizationHeader(request.headers.authorization));
      if (!isPrincipal(principal)) return sendAuthError(reply, principal);
      const sessionId = parseUuid((request.params as { id: string }).id);
      if (typeof sessionId !== "string") return sendInvalid(reply, sessionId.message);
      const partNumber = parsePartNumber((request.params as { partNumber: string }).partNumber);
      if (typeof partNumber !== "number") return sendInvalid(reply, partNumber.message);
      if (!isOctetStream(request.headers["content-type"])) return sendInvalid(reply, LIBRARY_MESSAGES.badPart);
      const payload = request.body;
      if (!Buffer.isBuffer(payload) || payload.length === 0) return sendInvalid(reply, LIBRARY_MESSAGES.badPart);
      const result = await uploadPart(
        library,
        toLibraryActor(principal),
        { sessionId, partNumber, body: payload },
        clock.now(),
      );
      return sendLibraryResult(reply, result);
    },
  );
}

export function registerPhotoRoutes(
  app: FastifyInstance,
  identity: IdentityDeps,
  library: LibraryDeps,
  clock: Clock,
  search: SearchDeps,
): void {
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: PART_BODY_LIMIT },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.post(
    "/photos/search",
    {
      bodyLimit: SEARCH_BODY_LIMIT,
      onRequest: async (request, reply) => {
        const principal = await requirePrincipal(identity, authorizationHeader(request.headers.authorization));
        if (!isPrincipal(principal)) return sendAuthError(reply, principal);
        principals.set(request, principal);
      },
    },
    async (request, reply) => {
      if (reply.sent) return;
      const principal = principals.get(request);
      if (!principal) return reply.code(401).send({ error: { code: "unauthorized", message: "未授权" } });
      const query = request.query;
      if (query && typeof query === "object" && Object.keys(query as object).length > 0) {
        return reply.code(400).send({ error: { code: "validation_error", message: "请求不合法" } });
      }
      const parsed = request.body;
      if (
        parsed === null ||
        parsed === undefined ||
        typeof parsed !== "object" ||
        Object.getPrototypeOf(parsed) !== Object.prototype
      ) {
        return reply.code(400).send({ error: { code: "validation_error", message: "请求不合法" } });
      }
      const result = await searchPhotos(search, toLibraryActor(principal), parsed as Record<string, unknown>, clock.now());
      return sendSearchResult(reply, result);
    },
  );

  app.post("/photos/uploads", { schema: { body: uploadBodySchema } }, async (request, reply) => {
    const principal = await requirePrincipal(identity, authorizationHeader(request.headers.authorization));
    if (!isPrincipal(principal)) return sendAuthError(reply, principal);
    const body = request.body as { contentType: unknown; byteSize: unknown };
    if (typeof body.contentType !== "string" || typeof body.byteSize !== "number" || !Number.isInteger(body.byteSize)) {
      return sendInvalid(reply, LIBRARY_MESSAGES.invalidBody);
    }
    const result = await createUpload(
      library,
      toLibraryActor(principal),
      { contentType: body.contentType, byteSize: body.byteSize },
      clock.now(),
    );
    return sendLibraryResult(reply, result);
  });

  registerPartRoute(app, "put", identity, library, clock);
  registerPartRoute(app, "post", identity, library, clock);

  app.post("/photos/uploads/:id/complete", async (request, reply) => {
    const principal = await requirePrincipal(identity, authorizationHeader(request.headers.authorization));
    if (!isPrincipal(principal)) return sendAuthError(reply, principal);
    if (!isAllowedEmptyJson(request.body)) return sendInvalid(reply, LIBRARY_MESSAGES.invalidBody);
    const sessionId = parseUuid((request.params as { id: string }).id);
    if (typeof sessionId !== "string") return sendInvalid(reply, sessionId.message);
    const result = await completeUpload(library, toLibraryActor(principal), sessionId, clock.now());
    return sendLibraryResult(reply, result);
  });

  app.post("/photos/uploads/:id/abort", async (request, reply) => {
    const principal = await requirePrincipal(identity, authorizationHeader(request.headers.authorization));
    if (!isPrincipal(principal)) return sendAuthError(reply, principal);
    if (!isAllowedEmptyJson(request.body)) return sendInvalid(reply, LIBRARY_MESSAGES.invalidBody);
    const sessionId = parseUuid((request.params as { id: string }).id);
    if (typeof sessionId !== "string") return sendInvalid(reply, sessionId.message);
    const result = await abortUpload(library, toLibraryActor(principal), sessionId, clock.now());
    return sendLibraryResult(reply, result);
  });

  app.get("/photos", { schema: { querystring: photosQuerySchema } }, async (request, reply) => {
    const principal = await requirePrincipal(identity, authorizationHeader(request.headers.authorization));
    if (!isPrincipal(principal)) return sendAuthError(reply, principal);
    const query = request.query as { limit?: string; cursor?: string };
    const limit = parsePhotoLimit(query.limit);
    if (limit === "invalid") return sendInvalid(reply, LIBRARY_MESSAGES.invalidBody);
    let cursor: { createdAt: Date; id: string } | null = null;
    if (query.cursor !== undefined) {
      const decoded = decodePhotoCursor(query.cursor);
      if (!decoded) return sendInvalid(reply, LIBRARY_MESSAGES.invalidBody);
      cursor = decoded;
    }
    const result = await listPhotos(library, toLibraryActor(principal), { limit, cursor }, clock.now());
    return sendLibraryResult(reply, result);
  });

  app.get("/photos/:id", async (request, reply) => {
    const principal = await requirePrincipal(identity, authorizationHeader(request.headers.authorization));
    if (!isPrincipal(principal)) return sendAuthError(reply, principal);
    const photoId = parseUuid((request.params as { id: string }).id);
    if (typeof photoId !== "string") return sendInvalid(reply, photoId.message);
    const result = await getPhoto(library, toLibraryActor(principal), photoId, clock.now());
    return sendLibraryResult(reply, result);
  });

  app.patch("/photos/:id", { schema: { body: patchBodySchema } }, async (request, reply) => {
    const principal = await requirePrincipal(identity, authorizationHeader(request.headers.authorization));
    if (!isPrincipal(principal)) return sendAuthError(reply, principal);
    const photoId = parseUuid((request.params as { id: string }).id);
    if (typeof photoId !== "string") return sendInvalid(reply, photoId.message);
    const normalized = normalizeMetadataPatch(request.body as Record<string, unknown>);
    if (!normalized.ok) return sendInvalid(reply, normalized.message);
    const result = await patchPhoto(library, toLibraryActor(principal), photoId, normalized.patch, clock.now());
    return sendLibraryResult(reply, result);
  });

  app.post("/photos/:id/retry", async (request, reply) => {
    const principal = await requirePrincipal(identity, authorizationHeader(request.headers.authorization));
    if (!isPrincipal(principal)) return sendAuthError(reply, principal);
    if (!isAllowedEmptyJson(request.body)) return sendInvalid(reply, LIBRARY_MESSAGES.invalidBody);
    const photoId = parseUuid((request.params as { id: string }).id);
    if (typeof photoId !== "string") return sendInvalid(reply, photoId.message);
    const result = await retryPhoto(library, toLibraryActor(principal), photoId, clock.now());
    return sendLibraryResult(reply, result);
  });

  app.delete("/photos/:id", async (request, reply) => {
    const principal = await requirePrincipal(identity, authorizationHeader(request.headers.authorization));
    if (!isPrincipal(principal)) return sendAuthError(reply, principal);
    const photoId = parseUuid((request.params as { id: string }).id);
    if (typeof photoId !== "string") return sendInvalid(reply, photoId.message);
    const result = await deletePhoto(library, toLibraryActor(principal), photoId);
    return sendLibraryResult(reply, result);
  });
}
