import type { ReactNode } from "react";
import { navAriaCurrent } from "./router";

const PRODUCT_NAME = "AI Native 共享相册";

type ShellProps = {
  pathname: string;
  email: string;
  notice: string | null;
  onNavigate: (to: string, mode?: "push" | "replace") => void;
  onLogout: () => void;
  children: ReactNode;
};

type NavItem = { href: string; label: string; match: string | null };

const TOP_NAV: NavItem[] = [
  { href: "/", label: "照片", match: "/" },
  { href: "/search", label: "搜索", match: "/search" },
  { href: "/upload", label: "上传", match: "/upload" },
  { href: "/albums", label: "共享册", match: "/albums" },
  { href: "/keys", label: "API Key", match: "/keys" },
];

const BOTTOM_NAV: NavItem[] = [
  { href: "/", label: "照片", match: "/" },
  { href: "/search", label: "搜索", match: "/search" },
  { href: "/upload", label: "上传", match: "/upload" },
  { href: "/albums", label: "共享册", match: "/albums" },
  { href: "/account", label: "账户", match: "/account" },
];

function navLinkProps(pathname: string, item: NavItem) {
  const current = navAriaCurrent(pathname);
  const isCurrent =
    item.match !== null &&
    (item.match === "/" ? current === "/" : current !== null && current.startsWith(item.match));
  if (isCurrent) {
    return { "aria-current": "page" as const };
  }
  return {};
}

export function Shell({ pathname, email, notice, onNavigate, onLogout, children }: ShellProps) {
  const handleClick =
    (href: string) => (event: React.MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      onNavigate(href, "push");
    };

  return (
  <div className="app-shell">
    <a className="skip-link" href="#content">
      跳到内容
    </a>
    <header className="shell-header">
      <a className="product-name" href="/" onClick={handleClick("/")}>
        {PRODUCT_NAME}
      </a>
      <nav className="top-nav" aria-label="主导航">
        <ul>
          {TOP_NAV.map((item) => (
            <li key={item.href}>
              <a href={item.href} onClick={handleClick(item.href)} {...navLinkProps(pathname, item)}>
                {item.label}
              </a>
            </li>
          ))}
        </ul>
        <div className="top-nav-session">
          <span className="user-email">{email}</span>
          <button type="button" onClick={() => onLogout()}>
            退出
          </button>
        </div>
      </nav>
    </header>

    {notice !== null ? (
      <div className="shell-notice" role="status" aria-live="polite">
        {notice}
      </div>
    ) : null}

    <main id="content" className="shell-main">
      {children}
    </main>

    <nav className="bottom-nav" aria-label="底部导航">
      <ul>
        {BOTTOM_NAV.map((item) => (
          <li key={item.href}>
            <a href={item.href} onClick={handleClick(item.href)} {...navLinkProps(pathname, item)}>
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  </div>
  );
}
