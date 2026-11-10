import { SESSION_EXPIRED } from "./copy";

export type RefreshOutcome = "ok" | "unauthorized" | "error";

export type LogoutResult =
  | { ok: true }
  | { ok: false; kind: "network" }
  | {
      ok: false;
      kind: "http";
      status: number;
      code: string | null;
      serverMessage: string | null;
    };

export type SessionSnapshot = {
  user: { id: string; email: string } | null;
  notice: string | null;
};

export type SessionDeps = {
  fetch: typeof fetch;
  now: () => number;
  setTimer: (fn: () => void, delayMs: number) => unknown;
  clearTimer: (handle: unknown) => void;
};

export type SessionController = {
  getSnapshot: () => SessionSnapshot;
  getAccessToken: () => string | null;
  subscribe: (listener: () => void) => () => void;
  applyAuthBody: (body: unknown) => boolean;
  clear: (notice: string | null) => void;
  refreshSingleFlight: () => Promise<RefreshOutcome>;
  logout: () => Promise<LogoutResult>;
};

type AuthBody = {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  user: { id: string; email: string };
};

export function refreshDelayMs(expiresInSeconds: number): number {
  if (expiresInSeconds <= 60) return Math.max(1000, (expiresInSeconds * 1000) / 2);
  return expiresInSeconds * 1000 - 60_000;
}

function parseAuthBody(body: unknown): AuthBody | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const accessToken = record.accessToken;
  const refreshToken = record.refreshToken;
  const accessTokenExpiresIn = record.accessTokenExpiresIn;
  const user = record.user;
  if (typeof accessToken !== "string" || accessToken.length === 0) return null;
  if (typeof refreshToken !== "string" || refreshToken.length === 0) return null;
  if (
    typeof accessTokenExpiresIn !== "number" ||
    !Number.isFinite(accessTokenExpiresIn) ||
    accessTokenExpiresIn <= 0
  ) {
    return null;
  }
  if (typeof user !== "object" || user === null) return null;
  const userRecord = user as Record<string, unknown>;
  if (typeof userRecord.id !== "string" || typeof userRecord.email !== "string") return null;
  return {
    accessToken,
    accessTokenExpiresIn,
    refreshToken,
    user: { id: userRecord.id, email: userRecord.email },
  };
}

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

export function createSessionController(deps: SessionDeps): SessionController {
  let accessToken: string | null = null;
  let accessTokenExpiresAt: number | null = null;
  let refreshToken: string | null = null;
  let user: { id: string; email: string } | null = null;
  let notice: string | null = null;
  let snapshot: SessionSnapshot = { user, notice };
  let timerHandle: unknown = null;
  let generation = 0;
  let inflightRefresh: Promise<RefreshOutcome> | null = null;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const commitSnapshot = () => {
    if (snapshot.user === user && snapshot.notice === notice) return;
    snapshot = { user, notice };
    notify();
  };

  const cancelTimer = () => {
    if (timerHandle !== null) {
      deps.clearTimer(timerHandle);
      timerHandle = null;
    }
  };

  const schedule = () => {
    cancelTimer();
    if (accessTokenExpiresAt === null) return;
    const expiresInSeconds = Math.max(1, Math.round((accessTokenExpiresAt - deps.now()) / 1000));
    timerHandle = deps.setTimer(() => {
      void refreshSingleFlight();
    }, refreshDelayMs(expiresInSeconds));
  };

  const getSnapshot = (): SessionSnapshot => snapshot;

  const getAccessToken = (): string | null => accessToken;

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const clear = (nextNotice: string | null) => {
    generation++;
    cancelTimer();
    accessToken = null;
    accessTokenExpiresAt = null;
    refreshToken = null;
    user = null;
    notice = nextNotice;
    commitSnapshot();
  };

  const applyAuthBody = (body: unknown): boolean => {
    const parsed = parseAuthBody(body);
    if (parsed === null) return false;
    accessToken = parsed.accessToken;
    refreshToken = parsed.refreshToken;
    accessTokenExpiresAt = deps.now() + parsed.accessTokenExpiresIn * 1000;
    user = parsed.user;
    notice = null;
    schedule();
    commitSnapshot();
    return true;
  };

  const refreshSingleFlight = (): Promise<RefreshOutcome> => {
    if (inflightRefresh !== null) return inflightRefresh;
    const tokenForRefresh = refreshToken;
    if (tokenForRefresh === null) {
      return Promise.resolve("error");
    }
    const generationAtStart = generation;
    inflightRefresh = (async (): Promise<RefreshOutcome> => {
      try {
        const response = await deps.fetch("/api/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: tokenForRefresh }),
        });
        if (generation !== generationAtStart) return "error";
        if (response.status === 401) {
          clear(SESSION_EXPIRED);
          return "unauthorized";
        }
        if (!response.ok) return "error";
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          return "error";
        }
        if (generation !== generationAtStart) return "error";
        if (!applyAuthBody(body)) return "error";
        return "ok";
      } catch {
        if (generation !== generationAtStart) return "error";
        return "error";
      } finally {
        inflightRefresh = null;
      }
    })();
    return inflightRefresh;
  };

  const logout = async (): Promise<LogoutResult> => {
    if (inflightRefresh !== null) {
      await inflightRefresh;
    }
    const tokenForLogout = refreshToken;
    if (tokenForLogout === null) {
      clear(null);
      return { ok: true };
    }
    try {
      const response = await deps.fetch("/api/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: tokenForLogout }),
      });
      if (response.status === 204 || response.status === 401) {
        clear(null);
        return { ok: true };
      }
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
    } catch {
      return { ok: false, kind: "network" };
    }
  };

  return {
    getSnapshot,
    getAccessToken,
    subscribe,
    applyAuthBody,
    clear,
    refreshSingleFlight,
    logout,
  };
}

export const session = createSessionController({
  fetch: globalThis.fetch.bind(globalThis),
  now: () => Date.now(),
  setTimer: (fn, delayMs) => setTimeout(fn, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});
