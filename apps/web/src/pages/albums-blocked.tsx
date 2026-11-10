import { useState } from "react";
import { ALBUM_NOT_READY } from "../copy";

export type AlbumsBlockedVariant = "list" | "new" | "detail" | "join";

type AlbumsBlockedProps = {
  variant: AlbumsBlockedVariant;
  slug?: string;
  onNavigate: (to: string, mode?: "push" | "replace") => void;
};

export function AlbumsBlocked({ variant, slug, onNavigate }: AlbumsBlockedProps) {
  const [banner, setBanner] = useState<string | null>(variant === "list" ? ALBUM_NOT_READY : null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [titleError, setTitleError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [joinPassword, setJoinPassword] = useState("");

  const go =
    (href: string) => (event: React.MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      onNavigate(href, "push");
    };

  if (variant === "list") {
    return (
      <section className="page-block">
        {banner !== null ? (
          <p className="banner" role="status">
            {banner}
          </p>
        ) : null}
        <p>还没有共享册</p>
        <p>
          <a href="/albums/new" onClick={go("/albums/new")}>
            创建共享册
          </a>
        </p>
      </section>
    );
  }

  if (variant === "new") {
    const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmedTitle = title.trim();
      const pass = password.trim();
      const pass2 = passwordConfirm.trim();
      const nextTitleError = trimmedTitle.length < 1 ? "请填写标题" : null;
      const nextPasswordError = pass.length === 0 || pass2.length === 0 || pass !== pass2 ? "两次口令不一致" : null;
      setTitleError(nextTitleError);
      setPasswordError(nextPasswordError);
      if (nextTitleError !== null || nextPasswordError !== null) return;
      setBanner(ALBUM_NOT_READY);
      setPassword("");
      setPasswordConfirm("");
    };

    return (
      <section className="page-block">
        {banner !== null ? (
          <p className="banner" role="status">
            {banner}
          </p>
        ) : null}
        <h1>创建共享册</h1>
        <form className="stack-form" onSubmit={handleSubmit}>
          <label>
            标题
            <input type="text" name="title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          {titleError !== null ? <p className="field-error">{titleError}</p> : null}
          <label>
            说明
            <textarea name="description" value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label>
            口令
            <input
              type="password"
              name="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          <label>
            再输入一次口令
            <input
              type="password"
              name="passwordConfirm"
              value={passwordConfirm}
              onChange={(e) => setPasswordConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          {passwordError !== null ? <p className="field-error">{passwordError}</p> : null}
          <label>
            过期时间
            <input
              type="datetime-local"
              name="expiresAt"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </label>
          <button type="submit">创建</button>
        </form>
      </section>
    );
  }

  if (variant === "detail") {
    return (
      <section className="page-block">
        <p className="banner" role="status">
          {ALBUM_NOT_READY}
        </p>
        <h1>共享册</h1>
      </section>
    );
  }

  const handleJoin = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBanner(ALBUM_NOT_READY);
    setJoinPassword("");
  };

  return (
    <section className="page-block">
      {banner !== null ? (
        <p className="banner" role="status" aria-live="polite">
          {banner}
        </p>
      ) : null}
      <p className="join-slug">{slug ?? ""}</p>
      <form className="stack-form" onSubmit={handleJoin}>
        <label>
          口令
          <input
            type="password"
            name="password"
            value={joinPassword}
            onChange={(e) => setJoinPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        <button type="submit">进入</button>
      </form>
    </section>
  );
}
