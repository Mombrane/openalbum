import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { NETWORK_MESSAGE, visibleMessage } from "./copy";
import { AlbumsBlocked } from "./pages/albums-blocked";
import { LoginPage } from "./pages/login";
import { NotFound } from "./pages/not-found";
import { RegisterPage } from "./pages/register";
import { LibraryPage } from "./pages/library";
import { UploadPage } from "./pages/upload";
import { SearchPage } from "./pages/search";
import { PhotoPage } from "./pages/photo";
import {
  isProtectedRoute,
  matchPath,
  rememberReturnTo,
  type Route,
} from "./router";
import { session } from "./session";
import { Shell } from "./shell";

const PRODUCT_NAME = "AI Native 共享相册";

export function App() {
  const [pathname, setPathname] = useState(() => window.location.pathname);
  const [shellNotice, setShellNotice] = useState<string | null>(null);
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );

  const navigate = useCallback((to: string, mode: "push" | "replace" = "push") => {
    if (mode === "replace") {
      window.history.replaceState(null, "", to);
    } else {
      window.history.pushState(null, "", to);
    }
    setPathname(to);
  }, []);

  useEffect(() => {
    const onPopState = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const route = matchPath(pathname);
  const loggedIn = snapshot.user !== null;

  useLayoutEffect(() => {
    if (!loggedIn && isProtectedRoute(route) && pathname !== "/login") {
      rememberReturnTo(pathname);
      window.history.replaceState(null, "", "/login");
      setPathname("/login");
      return;
    }
    if (loggedIn && (route.kind === "login" || route.kind === "register") && pathname !== "/") {
      window.history.replaceState(null, "", "/");
      setPathname("/");
    }
  }, [loggedIn, pathname, route]);

  const handleLogout = async () => {
    setShellNotice(null);
    const result = await session.logout();
    if (result.ok) {
      navigate("/login", "replace");
      return;
    }
    if (result.kind === "network") {
      setShellNotice(NETWORK_MESSAGE);
      return;
    }
    setShellNotice(
      visibleMessage({
        status: result.status,
        code: result.code,
        serverMessage: result.serverMessage,
        audience: "general",
      }),
    );
  };

  if (!loggedIn && isProtectedRoute(route)) {
    return null;
  }

  const notice = shellNotice ?? snapshot.notice;

  const content = renderRoute(route, loggedIn, navigate);

  if (route.kind === "login" || route.kind === "register") {
    return (
      <div className="auth-shell">
        <main id="content" className="shell-main">
          <h1>{route.kind === "login" ? "登录" : "注册"}</h1>
          {content}
          <AuthLinks kind={route.kind} onNavigate={navigate} />
        </main>
      </div>
    );
  }

  if (route.kind === "join" && !loggedIn) {
    return (
      <div className="guest-join">
        <header className="guest-join-header">
          <a
            href="/"
            onClick={(event) => {
              event.preventDefault();
              navigate("/", "push");
            }}
          >
            {PRODUCT_NAME}
          </a>
          <a
            href="/login"
            onClick={(event) => {
              event.preventDefault();
              navigate("/login", "push");
            }}
          >
            登录
          </a>
        </header>
        <main id="content" className="shell-main">
          {content}
        </main>
      </div>
    );
  }

  if (loggedIn) {
    return (
      <Shell
        pathname={pathname}
        email={snapshot.user?.email ?? ""}
        notice={notice}
        onNavigate={navigate}
        onLogout={() => void handleLogout()}
      >
        {content}
      </Shell>
    );
  }

  return (
    <main id="content" className="shell-main">
      {content}
    </main>
  );
}

function AuthLinks({
  kind,
  onNavigate,
}: {
  kind: "login" | "register";
  onNavigate: (to: string, mode?: "push" | "replace") => void;
}) {
  const go = (href: string) => (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    onNavigate(href, "push");
  };
  return (
    <p>
      {kind === "login" ? (
        <>
          没有账户？{" "}
          <a href="/register" onClick={go("/register")}>
            注册
          </a>
        </>
      ) : (
        <>
          已有账户？{" "}
          <a href="/login" onClick={go("/login")}>
            登录
          </a>
        </>
      )}
    </p>
  );
}

function renderRoute(
  route: Route,
  loggedIn: boolean,
  onNavigate: (to: string, mode?: "push" | "replace") => void,
) {
  switch (route.kind) {
    case "login":
      return <LoginPage onNavigate={onNavigate} />;
    case "register":
      return <RegisterPage onNavigate={onNavigate} />;
    case "library":
      return <LibraryPage onNavigate={onNavigate} />;
    case "upload":
      return <UploadPage onNavigate={onNavigate} />;
    case "search":
      return <SearchPage />;
    case "keys":
      return (
        <section className="page-block">
          <h1>API Key</h1>
          <p className="page-hint">密钥管理将在后续任务接入。</p>
          <code className="key-prefix">oalk_demo_prefix_only</code>
        </section>
      );
    case "account":
      return (
        <section className="page-block">
          <h1>账户</h1>
          <p className="page-hint">账户详情将在后续任务完善。</p>
        </section>
      );
    case "albums":
      return <AlbumsBlocked variant="list" onNavigate={onNavigate} />;
    case "albumNew":
      return <AlbumsBlocked variant="new" onNavigate={onNavigate} />;
    case "album":
      return <AlbumsBlocked variant="detail" onNavigate={onNavigate} />;
    case "join":
      return <AlbumsBlocked variant="join" slug={route.slug} onNavigate={onNavigate} />;
    case "photo":
      return <PhotoPage id={route.id} onNavigate={onNavigate} />;
    case "notFound":
      return <NotFound loggedIn={loggedIn} onNavigate={onNavigate} />;
    default:
      return <NotFound loggedIn={loggedIn} onNavigate={onNavigate} />;
  }
}
