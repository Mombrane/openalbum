import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SESSION_EXPIRED } from "../src/copy.ts";
import { createApi } from "../src/api.ts";
import type { RefreshOutcome, SessionController } from "../src/session.ts";

const VALID_AUTH_BODY = {
  accessToken: "access-1",
  accessTokenExpiresIn: 900,
  refreshToken: "oalr_one",
  user: { id: "11111111-1111-4111-8111-111111111111", email: "a@example.com" },
} as const;

const PHOTO_RAW = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  contentType: "image/jpeg",
  byteSize: 1024,
  takenAt: null,
  locationText: null,
  latitude: null,
  longitude: null,
  description: "desc",
  tags: ["tag"],
  status: "ready",
  errorCode: null,
  originalUrl: "https://example.com/original",
  originalUrlExpiresAt: "2026-12-01T00:00:00.000Z",
  thumbUrl: "https://example.com/thumb",
  thumbUrlExpiresAt: "2026-12-01T00:00:00.000Z",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  objectKey: "should-drop",
  extra: 1,
} as const;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type MockSessionOptions = {
  accessToken?: string | null;
  refreshOutcome?: RefreshOutcome;
  tokenAfterRefresh?: string;
};

function createMockSession(
  options: MockSessionOptions & {
    applyAuthBody?: (body: unknown) => boolean;
    onClear?: (notice: string | null) => void;
    onRefresh?: () => void;
  } = {},
): SessionController {
  let accessToken = options.accessToken ?? "access-1";
  let notice: string | null = null;
  let refreshCalls = 0;
  const applyAuthBody =
    options.applyAuthBody ??
    ((body: unknown) => {
      if (typeof body !== "object" || body === null) return false;
      const record = body as Record<string, unknown>;
      if (typeof record.accessToken === "string") {
        accessToken = record.accessToken;
        return true;
      }
      return false;
    });

  return {
    getSnapshot: () => ({ user: null, notice }),
    getAccessToken: () => accessToken,
    subscribe: () => () => {},
    applyAuthBody,
    clear: (nextNotice) => {
      notice = nextNotice;
      accessToken = null;
      options.onClear?.(nextNotice);
    },
    refreshSingleFlight: async () => {
      refreshCalls++;
      options.onRefresh?.();
      const outcome = options.refreshOutcome ?? "ok";
      if (outcome === "ok" && options.tokenAfterRefresh) {
        accessToken = options.tokenAfterRefresh;
      }
      return outcome;
    },
    logout: async () => ({ ok: true }),
    _refreshCalls: () => refreshCalls,
  } as SessionController & { _refreshCalls: () => number };
}

test("1. listPhotos 请求 URL、Bearer 与游标", async () => {
  const calls: { url: string; auth: string | null }[] = [];
  const session = createMockSession({ accessToken: "my-access" });
  const api = createApi({
    session,
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      const auth = new Headers(init?.headers).get("Authorization");
      calls.push({ url, auth });
      return jsonResponse(200, { photos: [], nextCursor: null });
    },
  });

  await api.listPhotos(null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/photos?limit=50");
  assert.equal(calls[0].auth, "Bearer my-access");

  const cursor = "cur/sor+special";
  await api.listPhotos(cursor);
  assert.equal(calls[1].url, `/api/photos?limit=50&cursor=${encodeURIComponent(cursor)}`);
  assert.equal(calls[1].auth, "Bearer my-access");
});

test("2. 401 刷新后重试一次；重试仍 401 则 clear 且不发第三次", async () => {
  let fetchCount = 0;
  const clearNotices: (string | null)[] = [];
  let refreshCalls = 0;
  const session = createMockSession({
    accessToken: "access-1",
    refreshOutcome: "ok",
    tokenAfterRefresh: "access-2",
    onClear: (n) => clearNotices.push(n),
    onRefresh: () => {
      refreshCalls++;
    },
  });

  const api = createApi({
    session,
    fetch: async (_input, init) => {
      fetchCount++;
      const auth = new Headers(init?.headers).get("Authorization");
      if (fetchCount === 1) {
        assert.equal(auth, "Bearer access-1");
        return new Response(null, { status: 401 });
      }
      assert.equal(fetchCount, 2);
      assert.equal(auth, "Bearer access-2");
      return new Response(null, { status: 401 });
    },
  });

  const result = await api.listPhotos(null);
  assert.equal(fetchCount, 2);
  assert.equal(refreshCalls, 1);
  assert.equal(result.ok, false);
  if (!result.ok && result.kind === "http") {
    assert.equal(result.status, 401);
  }
  assert.deepEqual(clearNotices, [SESSION_EXPIRED]);
});

test("3. register 与 login POST 正文无 Authorization，成功后 applyAuthBody", async () => {
  const authBodies: unknown[] = [];
  const session = createMockSession({
    applyAuthBody: (body) => {
      authBodies.push(body);
      return true;
    },
  });

  for (const method of ["register", "login"] as const) {
    const calls: { url: string; body: unknown; auth: string | null }[] = [];
    const api = createApi({
      session,
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        const auth = new Headers(init?.headers).get("Authorization");
        const body = JSON.parse(String(init?.body));
        calls.push({ url, body, auth });
        return jsonResponse(200, VALID_AUTH_BODY);
      },
    });

    const result =
      method === "register"
        ? await api.register("a@example.com", "password123")
        : await api.login("a@example.com", "password123");
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `/api/auth/${method}`);
    assert.equal(calls[0].auth, null);
    assert.deepEqual(calls[0].body, { email: "a@example.com", password: "password123" });
    assert.ok(authBodies.length >= 1);
  }
});

test("4. putPart 为 PUT parts/1、octet-stream、Blob 正文", async () => {
  const session = createMockSession();
  let captured: { url: string; contentType: string | null; body: unknown } | null = null;
  const blob = new Blob([new Uint8Array([1, 2, 3])]);
  const api = createApi({
    session,
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      captured = {
        url,
        contentType: new Headers(init?.headers).get("Content-Type"),
        body: init?.body,
      };
      return new Response(null, { status: 204 });
    },
  });

  const result = await api.putPart("upload-id-11111111-1111-4111-8111-111111111111", blob);
  assert.equal(result.ok, true);
  assert.ok(captured);
  assert.equal(
    captured.url,
    "/api/photos/uploads/upload-id-11111111-1111-4111-8111-111111111111/parts/1",
  );
  assert.equal(captured.contentType, "application/octet-stream");
  assert.equal(captured.body, blob);
});

test("5. completeUpload、abortUpload、retryPhoto 正文 {}；patchPhoto 原样", async () => {
  const session = createMockSession();
  const bodies: { path: string; body: unknown }[] = [];
  const uploadId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const photoId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  const api = createApi({
    session,
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      const body = init?.body === undefined || init.body === "" ? null : JSON.parse(String(init.body));
      bodies.push({ path: url, body });
      if (url.includes("/complete")) {
        return jsonResponse(201, { photo: { ...PHOTO_RAW, id: photoId } });
      }
      if (url.includes("/abort") || url.includes("/retry")) {
        return new Response(null, { status: 204 });
      }
      if (url.includes("/photos/") && init?.method === "PATCH") {
        return jsonResponse(200, { ...PHOTO_RAW, ...JSON.parse(String(init.body)) });
      }
      return new Response(null, { status: 204 });
    },
  });

  const patchBody = {
    description: "new",
    tags: ["a"],
    takenAt: null,
    locationText: null,
    latitude: null,
    longitude: null,
  };
  await api.completeUpload(uploadId);
  await api.abortUpload(uploadId);
  await api.retryPhoto(photoId);
  await api.patchPhoto(photoId, patchBody);

  const complete = bodies.find((b) => b.path.includes("/complete"));
  const abort = bodies.find((b) => b.path.includes("/abort"));
  const retry = bodies.find((b) => b.path.includes("/retry"));
  const patch = bodies.find((b) => b.path.endsWith(photoId));
  assert.deepEqual(complete?.body, {});
  assert.deepEqual(abort?.body, {});
  assert.deepEqual(retry?.body, {});
  assert.deepEqual(patch?.body, patchBody);
});

test("6. 非 JSON 错误 serverMessage 为 null；JSON 校验错误保留原文", async () => {
  const session = createMockSession();
  const api = createApi({
    session,
    fetch: async () => new Response("not json", { status: 400 }),
  });
  const plain = await api.getPhoto("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(plain.ok, false);
  if (!plain.ok && plain.kind === "http") {
    assert.equal(plain.serverMessage, null);
    assert.equal(plain.code, null);
  }

  const api2 = createApi({
    session,
    fetch: async () =>
      jsonResponse(400, {
        error: { code: "validation_error", message: "标签不合法" },
      }),
  });
  const validation = await api2.getPhoto("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(validation.ok, false);
  if (!validation.ok && validation.kind === "http") {
    assert.equal(validation.code, "validation_error");
    assert.equal(validation.serverMessage, "标签不合法");
  }
});

test("7. 照片白名单键；listPhotos 缺少 photos 返回 ok:false", async () => {
  const session = createMockSession();
  const api = createApi({
    session,
    fetch: async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/photos?")) {
        return jsonResponse(200, { nextCursor: null });
      }
      return jsonResponse(200, PHOTO_RAW);
    },
  });

  const list = await api.listPhotos(null);
  assert.equal(list.ok, false);

  const api2 = createApi({
    session,
    fetch: async () => jsonResponse(200, PHOTO_RAW),
  });
  const one = await api2.getPhoto("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(one.ok, true);
  if (one.ok) {
    assert.equal("objectKey" in one.data, false);
    assert.equal("extra" in one.data, false);
    assert.equal(one.data.id, PHOTO_RAW.id);
    assert.equal(one.data.status, "ready");
  }
});

test("8. api.ts 源码不含禁止字符串", () => {
  const apiPath = fileURLToPath(new URL("../src/api.ts", import.meta.url));
  const source = readFileSync(apiPath, "utf8");
  for (const forbidden of ["album", "GET /me", "localStorage"] as const) {
    assert.equal(source.includes(forbidden), false, `forbidden token: ${forbidden}`);
  }
});

test("9. searchPhotos 发 POST /api/photos/search、Bearer、解析 score", async () => {
  const calls: { url: string; method: string | undefined; auth: string | null; body: unknown }[] =
    [];
  const session = createMockSession({ accessToken: "tok-search" });
  const api = createApi({
    session,
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      const auth = new Headers(init?.headers).get("Authorization");
      const body = init?.body === undefined ? null : JSON.parse(String(init.body));
      calls.push({ url, method: init?.method, auth, body });
      return jsonResponse(200, {
        photos: [
          { ...PHOTO_RAW, score: null },
          { ...PHOTO_RAW, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", score: 1 },
        ],
        nextCursor: "nc1",
      });
    },
  });

  const result = await api.searchPhotos({
    mode: "semantic",
    q: "海边",
    limit: 20,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/photos/search");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].auth, "Bearer tok-search");
  assert.deepEqual(calls[0].body, { mode: "semantic", q: "海边", limit: 20 });
  assert.equal(calls[0].url.includes("?"), false);
  if (result.ok) {
    assert.equal(result.data.photos.length, 2);
    assert.equal(result.data.photos[0]!.score, null);
    assert.equal(result.data.photos[1]!.score, 1);
    assert.equal(result.data.nextCursor, "nc1");
  }
});
