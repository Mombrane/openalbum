import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Photo } from "../api";
import {
  LOADING,
  NETWORK_MESSAGE,
  visibleMessage,
} from "../copy";
import { PhotoCard } from "./photo-card";

const POLL_INTERVAL_MS = 5000;

export function nextPollIds(
  ids: readonly string[],
  offset: number,
): { ids: string[]; nextOffset: number } {
  if (ids.length <= 4) {
    return { ids: [...ids], nextOffset: 0 };
  }
  const batch: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    batch.push(ids[(offset + i) % ids.length]!);
  }
  return { ids: batch, nextOffset: (offset + 4) % ids.length };
}

function mergePhotos(existing: Photo[], incoming: Photo[]): Photo[] {
  const indexById = new Map(existing.map((photo, index) => [photo.id, index] as const));
  const merged = [...existing];
  for (const photo of incoming) {
    const index = indexById.get(photo.id);
    if (index !== undefined) {
      merged[index] = photo;
    } else {
      indexById.set(photo.id, merged.length);
      merged.push(photo);
    }
  }
  return merged;
}

type LibraryPageProps = {
  onNavigate: (to: string, mode?: "push" | "replace") => void;
};

type ListError =
  | { kind: "network" }
  | { kind: "http"; status: number; code: string | null; serverMessage: string | null };

export function LibraryPage({ onNavigate }: LibraryPageProps) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<ListError | null>(null);
  const [retryTarget, setRetryTarget] = useState<"initial" | "more" | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const pollOffsetRef = useRef(0);
  const photosRef = useRef(photos);
  photosRef.current = photos;

  const applyListSuccess = useCallback((incoming: Photo[], cursor: string | null, append: boolean) => {
    setListError(null);
    setRetryTarget(null);
    setNextCursor(cursor);
    setPhotos((prev) => (append ? mergePhotos(prev, incoming) : incoming));
  }, []);

  const fetchPage = useCallback(async (cursor: string | null, append: boolean, signal: AbortSignal) => {
    const result = await api.listPhotos(cursor, signal);
    if (signal.aborted) return;
    if (result.ok) {
      applyListSuccess(result.data.photos, result.data.nextCursor, append);
      return;
    }
    if (result.kind === "aborted") return;
    if (result.kind === "network") {
      setListError({ kind: "network" });
      setRetryTarget(append ? "more" : "initial");
      return;
    }
    setListError({
      kind: "http",
      status: result.status,
      code: result.code,
      serverMessage: result.serverMessage,
    });
    setRetryTarget(append ? "more" : "initial");
  }, [applyListSuccess]);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    setInitialLoading(true);
  void (async () => {
      await fetchPage(null, false, controller.signal);
      if (!controller.signal.aborted) {
        setInitialLoading(false);
      }
    })();
    return () => {
      controller.abort();
    };
  }, [fetchPage]);

  const handleLoadMore = () => {
    if (nextCursor === null || loadingMore) return;
    const controller = abortRef.current;
    const signal = controller?.signal ?? new AbortController().signal;
    setLoadingMore(true);
    void (async () => {
      await fetchPage(nextCursor, true, signal);
      if (!signal.aborted) {
        setLoadingMore(false);
      }
    })();
  };

  const handleRetry = () => {
    const controller = abortRef.current;
    if (controller === null) return;
    const signal = controller.signal;
    if (retryTarget === "more" && nextCursor !== null) {
      setLoadingMore(true);
      void (async () => {
        await fetchPage(nextCursor, true, signal);
        if (!signal.aborted) setLoadingMore(false);
      })();
      return;
    }
    if (retryTarget === "initial") {
      setInitialLoading(true);
      void (async () => {
        await fetchPage(null, false, signal);
        if (!signal.aborted) setInitialLoading(false);
      })();
    }
  };

  const replacePhoto = useCallback((updated: Photo) => {
    setPhotos((prev) => {
      const index = prev.findIndex((p) => p.id === updated.id);
      if (index === -1) return prev;
      const next = [...prev];
      next[index] = updated;
      return next;
    });
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      const processingIds = photosRef.current
        .filter((p) => p.status === "processing")
        .map((p) => p.id);
      if (processingIds.length === 0) {
        pollOffsetRef.current = 0;
        return;
      }
      const batch = nextPollIds(processingIds, pollOffsetRef.current);
      pollOffsetRef.current = batch.nextOffset;
      const controller = abortRef.current;
      const signal = controller?.signal;
      for (const id of batch.ids) {
        void (async () => {
          const result = await api.getPhoto(id, signal);
          if (signal?.aborted) return;
          if (!result.ok && result.kind === "aborted") return;
          if (result.ok) {
            replacePhoto(result.data);
          }
        })();
      }
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [replacePhoto]);

  const errorMessage =
    listError === null
      ? null
      : listError.kind === "network"
        ? NETWORK_MESSAGE
        : visibleMessage({
            status: listError.status,
            code: listError.code,
            serverMessage: listError.serverMessage,
            audience: "general",
          });

  const showEmpty =
    !initialLoading && listError === null && photos.length === 0 && nextCursor === null;

  return (
    <section className="page-block">
      <h1>个人库</h1>
      {initialLoading ? <p>{LOADING}</p> : null}
      {errorMessage !== null ? (
        <div className="banner" role="alert">
          <p>{errorMessage}</p>
          {retryTarget !== null ? (
            <button type="button" onClick={handleRetry}>
              重试
            </button>
          ) : null}
        </div>
      ) : null}
      {showEmpty ? (
        <p>
          还没有照片{" "}
          <a
            href="/upload"
            onClick={(event) => {
              event.preventDefault();
              onNavigate("/upload", "push");
            }}
          >
            上传
          </a>
        </p>
      ) : null}
      {photos.length > 0 ? (
        <div className="library-grid">
          {photos.map((photo) => (
            <PhotoCard
              key={photo.id}
              photo={photo}
              score={null}
              showScore={false}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      ) : null}
      {nextCursor !== null ? (
        <p>
          <button type="button" disabled={loadingMore} onClick={handleLoadMore}>
            加载更多
          </button>
        </p>
      ) : null}
    </section>
  );
}
