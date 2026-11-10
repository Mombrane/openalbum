import { useState } from "react";
import { SEARCH_NOT_READY } from "../copy";

export function SearchPage() {
  const [mode, setMode] = useState<"keyword" | "semantic">("keyword");
  const [banner, setBanner] = useState<string | null>(null);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBanner(SEARCH_NOT_READY);
  };

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
          <input type="search" name="q" autoComplete="off" />
        </label>
        <button type="submit">检索</button>
      </form>
      {banner !== null ? (
        <p className="banner" role="status" aria-live="polite">
          {banner}
        </p>
      ) : null}
    </section>
  );
}
