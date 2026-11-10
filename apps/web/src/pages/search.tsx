import {
  useCallback,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { api, type SearchPhoto } from "../api";
import {
  LOADING,
  NETWORK_MESSAGE,
  SEARCH_NOT_READY,
  visibleMessage,
} from "../copy";
import { searchCallsEnabled } from "../features";
import { PhotoCard } from "./photo-card";
import { validateTags } from "./photo-form";
import { planSearchSubmit, type SearchFormInput, type SearchRequestBody } from "./search-query";

type SearchPageProps = {
  onNavigate?: (to: string, mode?: "push" | "replace") => void;
};

function defaultNavigate(to: string, mode: "push" | "replace" = "push") {
  if (mode === "replace") {
    window.history.replaceState(null, "", to);
  } else {
    window.history.pushState(null, "", to);
  }
  window.dispatchEvent(new PopStateEvent("popstate"));
}

type SearchError =
  | { kind: "network" }
  | { kind: "http"; status: number; code: string | null; serverMessage: string | null };

type ResultRow = {
  photo: SearchPhoto;
  score: number | null;
};

export function SearchPage({ onNavigate = defaultNavigate }: SearchPageProps) {
  const [mode, setMode] = useState<"keyword" | "semantic">("keyword");
  const [q, setQ] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState("");
  const [takenFromLocal, setTakenFromLocal] = useState("");
  const [takenToLocal, setTakenToLocal] = useState("");
  const [banner, setBanner] = useState<string | null>(null);
  const [results, setResults] = useState<ResultRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchError, setSearchError] = useState<SearchError | null>(null);
  const [searched, setSearched] = useState(false);
  const lastModeRef = useRef<"keyword" | "semantic">("keyword");
  const lastBodyRef = useRef<SearchRequestBody | null>(null);

  const formInput = useCallback(
    (cursor?: string): SearchFormInput => ({
      mode,
      q,
      tags,
      takenFromLocal,
      takenToLocal,
      ...(cursor !== undefined ? { cursor } : {}),
    }),
    [mode, q, tags, takenFromLocal, takenToLocal],
  );

  const applySuccess = useCallback(
    (photos: SearchPhoto[], cursor: string | null, append: boolean, activeMode: "keyword" | "semantic") => {
      setSearchError(null);
      setNextCursor(cursor);
      const rows: ResultRow[] = photos
        .filter((photo) => photo.status === "ready")
        .map((photo) => ({ photo, score: photo.score }));
      setResults((prev) => (append ? [...prev, ...rows] : rows));
      lastModeRef.current = activeMode;
    },
    [],
  );

  const runSearch = useCallback(
    async (body: SearchRequestBody, append: boolean) => {
      lastBodyRef.current = body;
      const result = await api.searchPhotos(body);
      if (result.ok) {
        applySuccess(result.data.photos, result.data.nextCursor, append, body.mode);
        return;
      }
      if (result.kind === "aborted") return;
      if (result.kind === "network") {
        setSearchError({ kind: "network" });
        return;
      }
      setSearchError({
        kind: "http",
        status: result.status,
        code: result.code,
        serverMessage: result.serverMessage,
      });
    },
    [applySuccess],
  );

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBanner(null);
    setSearchError(null);
    const plan = planSearchSubmit(searchCallsEnabled, formInput());
    if (plan.type === "disabled") {
      setBanner(SEARCH_NOT_READY);
      setResults([]);
      setNextCursor(null);
      setSearched(false);
      return;
    }
    if (plan.type === "error") {
      setBanner(plan.message);
      return;
    }
    setSearching(true);
    setSearched(true);
    void (async () => {
      await runSearch(plan.body, false);
      setSearching(false);
    })();
  };

  const handleLoadMore = () => {
    if (nextCursor === null || loadingMore || lastBodyRef.current === null) return;
    const plan = planSearchSubmit(searchCallsEnabled, formInput(nextCursor));
    if (plan.type !== "send") return;
    setLoadingMore(true);
    void (async () => {
      await runSearch(plan.body, true);
      setLoadingMore(false);
    })();
  };

  const handleRetry = () => {
    const body = lastBodyRef.current;
    if (body === null || searchError === null) return;
    setSearchError(null);
    const append = results.length > 0 && body.cursor !== undefined;
    if (append) {
      setLoadingMore(true);
      void (async () => {
        await runSearch(body, true);
        setLoadingMore(false);
      })();
      return;
    }
    setSearching(true);
    void (async () => {
      await runSearch(body, false);
      setSearching(false);
    })();
  };

  const addTag = () => {
    const trimmed = tagDraft.trim();
    if (trimmed === "") return;
    const validated = validateTags([...tags, trimmed]);
    if (!validated.ok) {
      setBanner(validated.message);
      return;
    }
    setBanner(null);
    setTags(validated.tags);
    setTagDraft("");
  };

  const removeTag = (index: number) => {
    setTags((prev) => prev.filter((_, i) => i !== index));
  };

  const errorMessage =
    searchError === null
      ? null
      : searchError.kind === "network"
        ? NETWORK_MESSAGE
        : visibleMessage({
            status: searchError.status,
            code: searchError.code,
            serverMessage: searchError.serverMessage,
            audience: "search",
          });

  const showEmpty =
    searched && !searching && searchError === null && results.length === 0 && nextCursor === null;

  const showScore = lastModeRef.current === "semantic";

  return (
    <section className="page-block">
      <h1>搜索</h1>
      <p className="page-hint">只检索已就绪的照片。</p>
      <form className="stack-form" onSubmit={handleSubmit}>
        <fieldset>
          <legend>模式</legend>
          <label>
            <input
              type="radio"
              name="mode"
              value="keyword"
              checked={mode === "keyword"}
              onChange={() => setMode("keyword")}
            />
            关键词
          </label>
          <label>
            <input
              type="radio"
              name="mode"
              value="semantic"
              checked={mode === "semantic"}
              onChange={() => setMode("semantic")}
            />
            自然语言
          </label>
        </fieldset>
        <p className="mode-hint">
          {mode === "keyword"
            ? "匹配描述或标签里的连续文字，不分词。"
            : "在已就绪的照片里按语义查找。"}
        </p>
        <label>
          查询
          <input
            type="search"
            name="q"
            autoComplete="off"
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
        </label>
        <div className="tag-field">
          <label>
            标签
            <input
              type="text"
              value={tagDraft}
              onChange={(event) => setTagDraft(event.target.value)}
              onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addTag();
                }
              }}
            />
          </label>
          <button type="button" onClick={addTag}>
            添加标签
          </button>
          <ul className="tag-chips">
            {tags.map((tag, index) => (
              <li key={`${tag}-${index}`}>
                <span>{tag}</span>
                <button type="button" aria-label={`移除 ${tag}`} onClick={() => removeTag(index)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
        <label>
          开始时间
          <input
            type="datetime-local"
            value={takenFromLocal}
            onChange={(event) => setTakenFromLocal(event.target.value)}
          />
        </label>
        <label>
          结束时间
          <input
            type="datetime-local"
            value={takenToLocal}
            onChange={(event) => setTakenToLocal(event.target.value)}
          />
        </label>
        <button type="submit" disabled={searching}>
          检索
        </button>
      </form>
      {banner !== null ? (
        <p className="banner" role="status" aria-live="polite">
          {banner}
        </p>
      ) : null}
      {searching ? <p>{LOADING}</p> : null}
      {errorMessage !== null ? (
        <div className="banner" role="alert">
          <p>{errorMessage}</p>
          {lastBodyRef.current !== null ? (
            <button type="button" onClick={handleRetry}>
              重试
            </button>
          ) : null}
        </div>
      ) : null}
      {showEmpty ? <p>没有匹配的照片</p> : null}
      {results.length > 0 ? (
        <div className="library-grid">
          {results.map((row) => (
            <PhotoCard
              key={row.photo.id}
              photo={row.photo}
              score={row.score}
              showScore={showScore}
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
