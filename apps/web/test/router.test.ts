import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  consumeReturnTo,
  isSafeReturnTo,
  matchPath,
  rememberReturnTo,
  type Route,
} from "../src/router.tsx";

const UUID_LOWER = "11111111-1111-4111-8111-111111111111";

function routeKind(route: Route): string {
  return route.kind;
}

test("matchPath 按设计顺序匹配固定路径", () => {
  const cases: Array<[string, Route]> = [
    ["/login", { kind: "login" }],
    ["/register", { kind: "register" }],
    ["/upload", { kind: "upload" }],
    ["/search", { kind: "search" }],
    ["/keys", { kind: "keys" }],
    ["/account", { kind: "account" }],
    ["/albums/new", { kind: "albumNew" }],
    ["/albums/11111111-1111-4111-8111-111111111111", { kind: "album", id: UUID_LOWER }],
    ["/albums/NOT-A-UUID", { kind: "notFound" }],
    ["/albums", { kind: "albums" }],
    ["/photos/11111111-1111-4111-8111-111111111111", { kind: "photo", id: UUID_LOWER }],
    ["/photos/uploads", { kind: "notFound" }],
    ["/join/demo", { kind: "join", slug: "demo" }],
    ["/", { kind: "library" }],
    ["/nope", { kind: "notFound" }],
    ["/upload/", { kind: "notFound" }],
  ];
  for (const [pathname, expected] of cases) {
    assert.deepEqual(matchPath(pathname), expected, pathname);
  }
});

test("matchPath 拒绝非法 join slug", () => {
  assert.equal(routeKind(matchPath("/join/.")), "notFound");
  assert.equal(routeKind(matchPath("/join/..")), "notFound");
  assert.equal(routeKind(matchPath("/join/a/b")), "notFound");
  const slug201 = "a".repeat(201);
  assert.equal(routeKind(matchPath(`/join/${slug201}`)), "notFound");
  assert.equal(routeKind(matchPath("/join/%")), "notFound");
});

test("matchPath 将 UUID id 规范为小写", () => {
  const upper = "/albums/11111111-1111-4111-8111-111111111111".toUpperCase().replace(
    "11111111",
    "AAAAAAAA",
  );
  const mixed =
    "/albums/AAAAAAAA-1111-4111-8111-111111111111".replace("AAAAAAAA", "Aaaaaaaa");
  const route = matchPath(mixed);
  assert.equal(route.kind, "album");
  if (route.kind === "album") {
    assert.equal(route.id, route.id.toLowerCase());
    assert.match(route.id, /^[0-9a-f-]+$/);
  }
});

test("isSafeReturnTo 只接受合规站内路径", () => {
  assert.equal(isSafeReturnTo("/upload"), true);
  for (const bad of [
    "/login",
    "/register",
    "//evil",
    "/\\x",
    "/a://b",
    "/photos/uploads",
    "/foo?bar=1",
    "/foo#hash",
    `/${"x".repeat(201)}`,
  ]) {
    assert.equal(isSafeReturnTo(bad), false, bad);
  }
});

test("rememberReturnTo 与 consumeReturnTo 只在模块内存", () => {
  while (consumeReturnTo() !== "/") {
    /* drain */
  }
  rememberReturnTo("/search");
  assert.equal(consumeReturnTo(), "/search");
  assert.equal(consumeReturnTo(), "/");
});

test("源码扫描：占位文案与静态页约束", async () => {
  const webRoot = new URL("../", import.meta.url);
  const banned = ["Phase 0 · 脚手架", "尚未开始"];
  const appSource = await readFile(new URL("src/App.tsx", webRoot), "utf8");
  for (const phrase of banned) {
    assert.equal(appSource.includes(phrase), false, `App.tsx 含 ${phrase}`);
  }
  const pagesDir = fileURLToPath(new URL("src/pages", webRoot));
  for (const name of await readdir(pagesDir)) {
    if (!name.endsWith(".tsx")) continue;
    const source = await readFile(join(pagesDir, name), "utf8");
    for (const phrase of banned) {
      assert.equal(source.includes(phrase), false, `${name} 含 ${phrase}`);
    }
  }
  const albumsBlocked = await readFile(new URL("src/pages/albums-blocked.tsx", webRoot), "utf8");
  assert.equal(/\bfetch\b/.test(albumsBlocked), false);
  assert.equal(albumsBlocked.includes("/api"), false);

  const css = await readFile(new URL("src/index.css", webRoot), "utf8");
  for (const token of [
    "--bg: #f3efe6",
    "--ink: #1d1a16",
    "--muted: #5e584e",
    "--line: #d8d0c2",
    "--accent: #8a3d2f",
    "--paper: #faf7f1",
    "40rem",
    "72rem",
    "minmax(11rem, 1fr)",
    "2.75rem",
  ]) {
    assert.ok(css.includes(token), `index.css 缺少 ${token}`);
  }
  assert.match(
    css,
    /\.library-grid[\s\S]*?grid-template-columns:\s*1fr;/,
    "index.css 个人库窄屏应为单列 grid-template-columns: 1fr",
  );

  const html = await readFile(new URL("index.html", webRoot), "utf8");
  assert.match(html, /lang="zh-CN"/);
});
