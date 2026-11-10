export type Route =
  | { kind: "login" }
  | { kind: "register" }
  | { kind: "upload" }
  | { kind: "search" }
  | { kind: "keys" }
  | { kind: "account" }
  | { kind: "albumNew" }
  | { kind: "album"; id: string }
  | { kind: "albums" }
  | { kind: "photo"; id: string }
  | { kind: "join"; slug: string }
  | { kind: "library" }
  | { kind: "notFound" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseJoinSlug(pathname: string): string | null {
  if (!pathname.startsWith("/join/")) return null;
  const rest = pathname.slice("/join/".length);
  if (rest.length === 0 || rest.includes("/")) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(rest);
  } catch {
    return null;
  }
  if (slug.length === 0 || slug === "." || slug === "..") return null;
  const bytes = new TextEncoder().encode(slug).length;
  if (bytes < 1 || bytes > 200) return null;
  return slug;
}

export function matchPath(pathname: string): Route {
  if (pathname === "/login") return { kind: "login" };
  if (pathname === "/register") return { kind: "register" };
  if (pathname === "/upload") return { kind: "upload" };
  if (pathname === "/search") return { kind: "search" };
  if (pathname === "/keys") return { kind: "keys" };
  if (pathname === "/account") return { kind: "account" };
  if (pathname === "/albums/new") return { kind: "albumNew" };
  if (pathname.startsWith("/albums/")) {
    const id = pathname.slice("/albums/".length);
    if (UUID_RE.test(id)) return { kind: "album", id: id.toLowerCase() };
    return { kind: "notFound" };
  }
  if (pathname === "/albums") return { kind: "albums" };
  if (pathname.startsWith("/photos/")) {
    const id = pathname.slice("/photos/".length);
    if (UUID_RE.test(id)) return { kind: "photo", id: id.toLowerCase() };
    return { kind: "notFound" };
  }
  const joinSlug = parseJoinSlug(pathname);
  if (joinSlug !== null) return { kind: "join", slug: joinSlug };
  if (pathname === "/join/" || pathname.startsWith("/join/")) return { kind: "notFound" };
  if (pathname === "/") return { kind: "library" };
  return { kind: "notFound" };
}

export function isSafeReturnTo(pathname: string): boolean {
  if (pathname.length > 200) return false;
  if (!pathname.startsWith("/") || pathname.startsWith("//")) return false;
  if (pathname.includes("\\") || pathname.includes("://")) return false;
  if (pathname.includes("?") || pathname.includes("#")) return false;
  if (pathname === "/login" || pathname === "/register") return false;
  if (matchPath(pathname).kind === "notFound") return false;
  return true;
}

let pendingReturnTo: string | null = null;

export function rememberReturnTo(pathname: string): void {
  if (isSafeReturnTo(pathname)) {
    pendingReturnTo = pathname;
  }
}

export function consumeReturnTo(): string {
  const value = pendingReturnTo ?? "/";
  pendingReturnTo = null;
  return value;
}

export function isProtectedRoute(route: Route): boolean {
  return (
    route.kind !== "login" &&
    route.kind !== "register" &&
    route.kind !== "join" &&
    route.kind !== "notFound"
  );
}

export function navAriaCurrent(pathname: string): string | null {
  const route = matchPath(pathname);
  if (route.kind === "library") return "/";
  if (route.kind === "search") return "/search";
  if (route.kind === "upload") return "/upload";
  if (route.kind === "albums" || route.kind === "albumNew" || route.kind === "album") return "/albums";
  if (route.kind === "keys") return "/keys";
  if (route.kind === "account") return "/account";
  return null;
}
