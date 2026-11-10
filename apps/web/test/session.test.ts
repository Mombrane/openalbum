import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SESSION_EXPIRED } from "../src/copy.ts";
import { createSessionController, refreshDelayMs } from "../src/session.ts";

const VALID_AUTH_BODY = {
  tokenType: "Bearer",
  accessToken: "access-1",
  accessTokenExpiresIn: 900,
  refreshToken: "oalr_one",
  refreshTokenExpiresAt: "2026-12-03T07:50:00.000Z",
  user: { id: "11111111-1111-4111-8111-111111111111", email: "a@example.com" },
} as const;

type TimerEntry = { fn: () => void; delayMs: number; id: number };

function createHarness(fetchImpl: typeof fetch) {
  const timers: TimerEntry[] = [];
  let nextTimerId = 1;
  let nowMs = 1_000_000;
  let setTimerCalls = 0;
  let lastScheduledDelay = -1;
  const controller = createSessionController({
    fetch: fetchImpl,
    now: () => nowMs,
    setTimer: (fn, delayMs) => {
      setTimerCalls++;
      lastScheduledDelay = delayMs;
      const id = nextTimerId++;
      timers.push({ fn, delayMs, id });
      return id;
    },
    clearTimer: (handle) => {
      const idx = timers.findIndex((t) => t.id === handle);
      if (idx >= 0) timers.splice(idx, 1);
    },
  });
  return {
    controller,
    timers,
    setTimerCalls: () => setTimerCalls,
    lastScheduledDelay: () => lastScheduledDelay,
    setNow: (ms: number) => {
      nowMs = ms;
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("refreshDelayMs 按 TTL 规则计算", () => {
  assert.equal(refreshDelayMs(900), 840_000);
  assert.equal(refreshDelayMs(60), 30_000);
  assert.equal(refreshDelayMs(10), 5_000);
  assert.equal(refreshDelayMs(1), 1_000);
});

test("applyAuthBody 写入会话并刷新单飞只发一次 POST", async () => {
  let refreshPosts = 0;
  const { controller } = createHarness(async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    assert.equal(url, "/api/auth/refresh");
    refreshPosts++;
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Authorization"), null);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["refreshToken"]);
    assert.equal(body.refreshToken, "oalr_one");
    return jsonResponse(200, {
      ...VALID_AUTH_BODY,
      accessToken: "access-2",
      refreshToken: "oalr_two",
    });
  });

  assert.equal(controller.applyAuthBody(VALID_AUTH_BODY), true);
  assert.equal(controller.getAccessToken(), "access-1");
  assert.equal(controller.getSnapshot().user?.email, "a@example.com");

  const [a, b] = await Promise.all([
    controller.refreshSingleFlight(),
    controller.refreshSingleFlight(),
  ]);
  assert.equal(refreshPosts, 1);
  assert.equal(a, "ok");
  assert.equal(b, "ok");
});

test("刷新 200 替换两枚令牌与邮箱并登记新定时器", async () => {
  const refreshBody = {
    ...VALID_AUTH_BODY,
    accessToken: "access-new",
    refreshToken: "oalr_new",
    accessTokenExpiresIn: 120,
    user: {
      id: "22222222-2222-4222-8222-222222222222",
      email: "b@example.com",
    },
  };
  const { controller, setTimerCalls, lastScheduledDelay } = createHarness(async () =>
    jsonResponse(200, refreshBody),
  );

  assert.equal(controller.applyAuthBody(VALID_AUTH_BODY), true);
  assert.ok(setTimerCalls() >= 1);
  const outcome = await controller.refreshSingleFlight();
  assert.equal(outcome, "ok");
  assert.equal(controller.getAccessToken(), "access-new");
  assert.equal(controller.getSnapshot().user?.email, "b@example.com");
  assert.ok(setTimerCalls() >= 2);
  assert.equal(lastScheduledDelay(), refreshDelayMs(120));
});

test("刷新 401 清空会话并标记登录已失效", async () => {
  const { controller } = createHarness(async () => new Response(null, { status: 401 }));
  assert.equal(controller.applyAuthBody(VALID_AUTH_BODY), true);
  const outcome = await controller.refreshSingleFlight();
  assert.equal(outcome, "unauthorized");
  assert.equal(controller.getAccessToken(), null);
  assert.equal(controller.getSnapshot().notice, SESSION_EXPIRED);
});

test("进行中的第二次 refreshSingleFlight 不再发 POST", async () => {
  let fetchCount = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { controller } = createHarness(async () => {
    fetchCount++;
    await gate;
    return jsonResponse(200, VALID_AUTH_BODY);
  });
  assert.equal(controller.applyAuthBody(VALID_AUTH_BODY), true);
  const first = controller.refreshSingleFlight();
  const second = controller.refreshSingleFlight();
  assert.equal(fetchCount, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(fetchCount, 1);
});

test("logout 等待在途刷新后用最新 Refresh Token 退出", async () => {
  let refreshDone = false;
  let logoutBody: Record<string, unknown> | null = null;
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const { controller } = createHarness(async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url === "/api/auth/refresh") {
      await refreshGate;
      refreshDone = true;
      return jsonResponse(200, {
        ...VALID_AUTH_BODY,
        refreshToken: "oalr_after_refresh",
      });
    }
    if (url === "/api/auth/logout") {
      assert.equal(refreshDone, true);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("Authorization"), null);
      logoutBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected url ${url}`);
  });

  assert.equal(controller.applyAuthBody(VALID_AUTH_BODY), true);
  const refreshing = controller.refreshSingleFlight();
  const logoutPromise = controller.logout();
  releaseRefresh();
  await refreshing;
  const result = await logoutPromise;
  assert.deepEqual(logoutBody, { refreshToken: "oalr_after_refresh" });
  assert.equal(result.ok, true);
  assert.equal(controller.getAccessToken(), null);
  assert.equal(controller.getSnapshot().notice, null);
});

test("logout 204 与 401 清空会话且 notice 为 null", async () => {
  for (const status of [204, 401] as const) {
    const { controller } = createHarness(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/auth/logout") {
        return new Response(null, { status });
      }
      throw new Error(`unexpected url ${url}`);
    });
    assert.equal(controller.applyAuthBody(VALID_AUTH_BODY), true);
    const result = await controller.logout();
    assert.equal(result.ok, true);
    assert.equal(controller.getAccessToken(), null);
    assert.equal(controller.getSnapshot().notice, null);
  }
});

test("logout 网络失败或 500 保留令牌", async () => {
  const { controller: netController } = createHarness(async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url === "/api/auth/logout") throw new Error("offline");
    throw new Error(`unexpected url ${url}`);
  });
  assert.equal(netController.applyAuthBody(VALID_AUTH_BODY), true);
  const netResult = await netController.logout();
  assert.deepEqual(netResult, { ok: false, kind: "network" });
  assert.equal(netController.getAccessToken(), "access-1");

  const { controller: httpController } = createHarness(async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url === "/api/auth/logout") {
      return jsonResponse(500, {
        error: { code: "internal_error", message: "服务器错误" },
      });
    }
    throw new Error(`unexpected url ${url}`);
  });
  assert.equal(httpController.applyAuthBody(VALID_AUTH_BODY), true);
  const httpResult = await httpController.logout();
  assert.equal(httpResult.ok, false);
  if (!httpResult.ok && httpResult.kind === "http") {
    assert.equal(httpResult.status, 500);
    assert.equal(httpResult.code, "internal_error");
    assert.equal(httpResult.serverMessage, "服务器错误");
  }
  assert.equal(httpController.getAccessToken(), "access-1");
});

test("applyAuthBody 形状不完整时不改写已有会话", () => {
  const { controller } = createHarness(async () => new Response(null, { status: 500 }));
  assert.equal(controller.applyAuthBody(VALID_AUTH_BODY), true);
  const snapshotBefore = controller.getSnapshot();
  const tokenBefore = controller.getAccessToken();

  assert.equal(controller.applyAuthBody({ ...VALID_AUTH_BODY, accessToken: undefined }), false);
  assert.equal(controller.getAccessToken(), tokenBefore);
  assert.deepEqual(controller.getSnapshot(), snapshotBefore);

  assert.equal(controller.applyAuthBody({ ...VALID_AUTH_BODY, refreshToken: 1 }), false);
  assert.equal(controller.applyAuthBody({ ...VALID_AUTH_BODY, accessTokenExpiresIn: 0 }), false);
  assert.equal(controller.applyAuthBody({ ...VALID_AUTH_BODY, accessTokenExpiresIn: Number.NaN }), false);
});

test("刷新 200 正文不能用时返回 error 且保留令牌", async () => {
  const { controller, timers } = createHarness(async () =>
    jsonResponse(200, { ...VALID_AUTH_BODY, accessToken: undefined }),
  );
  assert.equal(controller.applyAuthBody(VALID_AUTH_BODY), true);
  const timersBefore = timers.length;
  const outcome = await controller.refreshSingleFlight();
  assert.equal(outcome, "error");
  assert.equal(controller.getAccessToken(), "access-1");
  assert.equal(timers.length, timersBefore);
});

test("clear 后完成的刷新不得写回登录态", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { controller } = createHarness(async () => {
    await gate;
    return jsonResponse(200, {
      ...VALID_AUTH_BODY,
      accessToken: "access-after-clear",
    });
  });
  assert.equal(controller.applyAuthBody(VALID_AUTH_BODY), true);
  const refreshing = controller.refreshSingleFlight();
  controller.clear(null);
  release();
  const outcome = await refreshing;
  assert.equal(outcome, "error");
  assert.equal(controller.getAccessToken(), null);
});

test("getSnapshot 在会话未变时返回同一引用", () => {
  const { controller } = createHarness(async () => jsonResponse(500, {}));
  const initial = controller.getSnapshot();
  assert.equal(controller.getSnapshot(), initial);
  assert.equal(initial.user, null);
  assert.equal(initial.notice, null);
  assert.equal(controller.applyAuthBody(VALID_AUTH_BODY), true);
  const signedIn = controller.getSnapshot();
  assert.notEqual(signedIn, initial);
  assert.equal(signedIn.user?.email, "a@example.com");
  assert.equal(controller.getSnapshot(), signedIn);
  controller.clear(SESSION_EXPIRED);
  const expired = controller.getSnapshot();
  assert.equal(expired.user, null);
  assert.equal(expired.notice, SESSION_EXPIRED);
  assert.equal(controller.getSnapshot(), expired);
});

test("session.ts 不得使用持久化存储或 console", () => {
  const sessionPath = fileURLToPath(new URL("../src/session.ts", import.meta.url));
  const source = readFileSync(sessionPath, "utf8");
  for (const forbidden of [
    "localStorage",
    "sessionStorage",
    "indexedDB",
    "document.cookie",
    "console.",
  ] as const) {
    assert.equal(source.includes(forbidden), false, `forbidden token: ${forbidden}`);
  }
});
