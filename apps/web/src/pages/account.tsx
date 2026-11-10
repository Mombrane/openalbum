import { useState, useSyncExternalStore } from "react";
import { session } from "../session";
import { performLogout } from "./logout";

type AccountPageProps = {
  onNavigate: (to: string, mode?: "push" | "replace") => void;
};

export function AccountPage({ onNavigate }: AccountPageProps) {
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const email = snapshot.user?.email ?? "";

  const handleLogout = () => {
    setNotice(null);
    void (async () => {
      const result = await performLogout(onNavigate);
      if (!result.ok) {
        setNotice(result.notice);
      }
    })();
  };

  const goKeys = (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    onNavigate("/keys", "push");
  };

  return (
    <section className="page-block">
      <h1>账户</h1>
      {notice !== null ? (
        <p className="form-summary" role="status" aria-live="polite">
          {notice}
        </p>
      ) : null}
      <p className="account-email">{email}</p>
      <p>
        <a href="/keys" onClick={goKeys}>
          API Key 管理
        </a>
      </p>
      <p>
        <button type="button" onClick={handleLogout}>
          退出
        </button>
      </p>
    </section>
  );
}
