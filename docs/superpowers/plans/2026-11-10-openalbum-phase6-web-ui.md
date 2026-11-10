# OpenAlbum Phase 6 — 网页实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**状态：** 已定稿（待实现）

**日期：** 2026-11-10

**Goal:** 在现有 Vite + React 脚手架上做成中文网页，让人能注册登录、浏览个人库、单文件上传、查看处理状态、改元数据、删除、创建并吊销 API Key，并在 Phase 4 已完成的前提下用 `POST /photos/search` 搜索。

**Architecture:** 浏览器只请求同源 `/api`。Access JWT 与 Refresh Token 只放在页面内存，刷新单飞。路由用手写 History API。`searchCallsEnabled` 在 Task 10 改为 `true`。`albumCallsEnabled` 保持 `false`，共享册只渲染设计第 6.8 节在常量关闭时的静态页，不发请求。网页不新增后端能力，不改 `apps/api`。

**Tech Stack:** 现有 `apps/web` 的 React 19、react-dom、Vite 7、TypeScript。不新增运行时依赖，不新增测试运行器。纯函数测试用仓库里已有的 `node:test` 与 `tsx`。验收用设计第 12 节手工脚本。

**依赖：**

- Phase 1、2、3 已是 `done`。批次 A（登录、个人库、上传、详情、API Key）现在可以做。
- Phase 4 已于 2026-11-08 squash 合并进 `main`（PR #13，`58d773e`）。`specs/phases/04-search.md` 为 `done`。批次 B 放在 Task 10，合同以已合并的 [`docs/superpowers/specs/2026-11-06-openalbum-phase4-search-design.md`](../specs/2026-11-06-openalbum-phase4-search-design.md) 为准。
- 不跟随实现偏差。尤其不要调用 `GET /photos/search`：该路径没有注册，请求会落到 `GET /photos/:id`。
- Phase 5 仍是 `planned`，仓库里没有 Phase 5 设计文件。共享册不设可执行的接通任务。阻塞条件写在文末「批次 C」：等 Phase 5 设计合并且 `specs/phases/05-shared-albums.md` 为 `done`。

**本计划提交只改文档。** 不改 `apps/**`（含 `apps/web` 实现）、`deploy/**`、测试与依赖。不把 `specs/SPEC.md` 或 `specs/phases/06-web-ui.md` 改成 `in_progress` 或 `done`。`06-web-ui.md` 可以增加指向本文件的计划链接，状态行保持 `planned`，验收框保持未勾。实现开始后，只有 Task 1 可以把这两处改成 `in_progress` 且仍然不勾验收。没有任何任务把它们改成 `done` 或勾上验收，因为设计第 12.3 节被 Phase 5 挡住。

## Global Constraints

下列约束每个任务都要遵守。数值与文案抄自 [`docs/superpowers/specs/2026-11-06-openalbum-phase6-web-ui-design.md`](../specs/2026-11-06-openalbum-phase6-web-ui-design.md)。未写进该设计、也未写进已合并的 Phase 1–4 合同的行为不得自行补充。

- 运行时依赖只有 `react` 与 `react-dom`。不新增路由库、组件库、状态库、国际化库、数据请求库。不新增 Playwright、Vitest、Jest、Testing Library、jsdom、happy-dom，也不把它们写进 `apps/web/package.json`。`npm test` 保持 `node scripts/check-layer-boundaries.mjs && npm run test -w apps/api`。网页单测用 `node --import tsx --test --test-concurrency=1 <文件>`，不接入根脚本。
- 不改 `apps/api`、`deploy/**`、`scripts/**`。不改 Nginx，不新增 CORS，不读 `PUBLIC_BASE_URL`、`CORS_ORIGIN`、`S3_PUBLIC_BASE_URL`、`VITE_API_URL`。浏览器路径一律以 `/api` 开头。Vite 开发服务器把该前缀去掉后代理到 `http://127.0.0.1:3000`。端口保持 `43123`。
- 路由用 `history.pushState` 与 `popstate`。用户点击用 `pushState`。守卫跳转用 `replaceState`。两者的 state 都传 `null`。不用 hash 路由。`index.html` 的 `lang` 保持 `zh-CN`。
- 断点只有 `40rem`。小于它是底部导航，大于等于它是顶部导航。个人库在窄屏一列，桌面为 `repeat(auto-fill, minmax(11rem, 1fr))`。缩略图 `aspect-ratio: 1`、`object-fit: cover`。不引入瀑布流库。内容区最大宽度 `72rem`。底部导航每项最小高度 `2.75rem`。保留现有颜色变量与字体族，不换主色，不加标志和插画，不加动画。窄屏正文字号不小于 `16px`。
- Access JWT 与 Refresh Token 只放在模块内存。不写 `localStorage`、`sessionStorage`、`IndexedDB`、Cookie、URL、`document.title`、`history.state`、`console`。整页刷新后必须重新登录。不用 API Key 或 Refresh Token 当网页的 Bearer。不调用 `GET /me`。邮箱只来自注册、登录或刷新响应里的 `user`。
- 全页只有一个在途 `POST /auth/refresh`。该请求不带 `Authorization`，正文只有 `{ "refreshToken" }`。到期前 60 秒主动刷新；`accessTokenExpiresIn` 小于等于 60 时改为 TTL 的一半，且不早于 1 秒之后。受保护请求遇到 401 时先等待这一次刷新，再用新的 Access JWT 重试原请求一次。刷新返回 401，或重试后仍是 401：清空内存，取消定时器，去 `/login`，显示「登录已失效」。不循环刷新。退出调用 `POST /auth/logout`，正文只有 `refreshToken`，不带 Bearer。204 或 401 才清空并去登录页。网络失败或 500 保留会话。
- 上传只做一个文件、一片。顺序是 `POST /photos/uploads`、`PUT /photos/uploads/:id/parts/1`、`POST /photos/uploads/:id/complete`，完成正文是 `{}`。不切多片，不在完成请求里提交 ETag，不展示 `objectKey` 与 `etag`。会话 id 只留在当次页面内存。没有会话列表，刷新不能续传。`completing` 期间不提供取消。
- 允许的 API 只有设计第 8 节那张表。不调用 `GET /health`、`GET /photos/search`，也不调用任何路径里含 `album` 的接口。`GET /photos` 的查询参数只有 `limit=50` 与可选的 `cursor`。
- 照片对象只读取设计第 6 节列出的键，搜索结果额外读取 `score`。其它键忽略。`originalUrl` 与 `thumbUrl` 只放进 `img` 的 `src`，不作为可见文字，不写进日志。
- 错误 `message` 比较前不 trim。只有与设计第 7 节允许列表逐字相同才展示服务端句子，否则按状态码兜底。搜索的 400 `validation_error` 按响应里的 `message` 展示，禁止先收成「请求不合法」。四句固定为「请求不合法」「标签不合法」「拍摄时间不合法」「时间范围不合法」。
- `score` 用 `JSON.parse` 之后的数字原样显示。`String(1)` 是 `1`。禁止 `toFixed`、`toPrecision`、四舍五入、截断和乘除。关键词的 `score` 为 `null` 时不显示相关度。
- API Key 明文 `secret` 只在创建成功的对话框里出现一次。关闭、Escape 或离开该页就从内存删除。不放进 URL、标题、history 或日志。网页自己的后续 `fetch` 仍用 Access JWT。
- 界面文案只用简体中文。服务端文案用 React 文本节点。禁止 `innerHTML` 与 `dangerouslySetInnerHTML`。不解析 JWT。不在浏览器里用角色或 owner 过滤代替 401、403、404。
- 不实现原生 App、新后端字段、Cookie 会话、记住我、国际化、管理后台、多文件、拖放、预签名直传、百分比进度、无限滚动、邮箱验证、找回密码、修改密码、验证码、Service Worker。
- 按任务编号顺序执行。后一个任务假设前一个任务已经提交。不要提前把 `searchCallsEnabled` 改成 `true`，不要把 `albumCallsEnabled` 改成 `true`。
- 实现本计划时，子代理使用 grok-4.7 high（模型标识 `grok-4.7-high`），不使用 fast 模式。
- 设计文件开头的「状态：已定稿（待实现）」不要改。写这份计划的提交不实现网页，也不改阶段状态。

**开工前阅读：**

- `docs/superpowers/specs/2026-11-06-openalbum-phase6-web-ui-design.md`
- `specs/phases/06-web-ui.md`
- `specs/SPEC.md`
- `docs/superpowers/specs/2026-11-03-openalbum-phase1-identity-auth-design.md` 第 3 节
- `docs/superpowers/specs/2026-11-04-openalbum-phase2-personal-library-design.md` 第 4、6 节
- `docs/superpowers/specs/2026-11-06-openalbum-phase3-processing-pipeline-design.md` 第 8 节
- `docs/superpowers/specs/2026-11-06-openalbum-phase4-search-design.md` 第 2、6、8 节
- `specs/phases/05-shared-albums.md`（只用来确认尚无 HTTP 合同）
- `apps/web/src/App.tsx`
- `apps/web/src/main.tsx`
- `apps/web/src/index.css`
- `apps/web/vite.config.ts`
- `apps/web/package.json`
- `deploy/nginx.example.conf`（只读；`location /api/` 已由 `proxy_pass http://photo_api/` 去掉前缀）

**开工前命令：** 下文命令都在仓库根目录执行。单测不需要数据库。手工脚本才需要下面的服务。

```bash
npm install
```

`node --import tsx` 使用仓库根 `node_modules` 里的 `tsx`（由 `apps/api` 提供）。不要为网页另装测试依赖。

---

## File Structure

| 路径 | 职责 |
|------|------|
| `apps/web/vite.config.ts` | 开发服务器把 `/api` 代理到 `127.0.0.1:3000` 并去掉前缀。端口仍是 `43123` |
| `apps/web/src/features.ts` | `searchCallsEnabled` 与 `albumCallsEnabled`。Task 10 只把前者改为 `true` |
| `apps/web/src/copy.ts` | 允许列表、兜底句、搜索句、状态文案、字节与时间、`score` 的字符串 |
| `apps/web/src/session.ts` | 内存令牌、单飞刷新、退出。不触碰持久存储 |
| `apps/web/src/api.ts` | `fetch`、`/api` 前缀、错误外壳、设计第 8 节的路径。Task 10 才加入 `POST /photos/search` |
| `apps/web/src/router.tsx` | 路径表、`returnTo`、跳转。不发请求 |
| `apps/web/src/shell.tsx` | 跳过链接、顶部或底部导航 |
| `apps/web/src/App.tsx` | 按路由渲染。去掉 Phase 0 占位 |
| `apps/web/src/index.css` | 布局。保留第 9 节的颜色变量 |
| `apps/web/src/pages/auth-form.ts` | 邮箱与密码的本地校验 |
| `apps/web/src/pages/login.tsx` | 登录 |
| `apps/web/src/pages/register.tsx` | 注册 |
| `apps/web/src/pages/library.tsx` | 个人库、加载更多、处理中轮询 |
| `apps/web/src/pages/photo-card.tsx` | 列表与搜索共用的卡片 |
| `apps/web/src/pages/upload-machine.ts` | 类型、大小、失败后的按钮。纯函数 |
| `apps/web/src/pages/upload.tsx` | 单文件单片上传 |
| `apps/web/src/pages/photo-form.ts` | 元数据校验与 PATCH 正文 |
| `apps/web/src/pages/dialog.tsx` | 删除确认与 API Key 明文对话框的焦点循环 |
| `apps/web/src/pages/photo.tsx` | 详情、保存、删除、重试 |
| `apps/web/src/pages/key-form.ts` | API Key 名称校验 |
| `apps/web/src/pages/keys.tsx` | 创建、一次明文、吊销 |
| `apps/web/src/pages/account.tsx` | 邮箱、到 Key 页的链接、退出 |
| `apps/web/src/pages/search-query.ts` | 搜索正文。常量关闭时不产生请求 |
| `apps/web/src/pages/search.tsx` | 搜索页 |
| `apps/web/src/pages/albums-blocked.tsx` | 常量关闭时的共享册静态页。文件里不得出现 `fetch` |
| `apps/web/src/pages/not-found.tsx` | 「页面不存在」，不请求 API |
| `apps/web/test/*.test.ts` | `node:test` 纯函数与源码约束。不放进 `src/`，避免 Vite 打包 |
| `specs/SPEC.md` | 只有实现期的 Task 1 把阶段 6 改为 `in_progress`。本计划没有把它改为 `done` 的步骤 |
| `specs/phases/06-web-ui.md` | 与上一行相同。验收框保持 `- [ ]` |

不创建 `apps/web/src` 以外的新运行时文件。不修改 `apps/web/package.json`。不修改 `index.html` 的 `lang`。

---

### Task 1: 同源代理、功能开关、错误文案与阶段开工

**Files:**
- Modify: `apps/web/vite.config.ts`
- Create: `apps/web/src/features.ts`
- Create: `apps/web/src/copy.ts`
- Modify: `specs/SPEC.md`（只改阶段 6 的状态单元格）
- Modify: `specs/phases/06-web-ui.md`（只改状态行）
- Test: `apps/web/test/copy.test.ts`
- Test: `apps/web/test/web-scaffold.test.ts`

**Interfaces:**
- Consumes: 现有 Vite 配置的 `server.port` 为 `43123`。阶段 6 在本任务开始前是 `planned`
- Produces:
  - `searchCallsEnabled: false` 与 `albumCallsEnabled: false`，两个都是字面量，不读环境变量
  - `fallbackMessage(status: number): string`
  - `visibleMessage(input: { status: number; code: string | null; serverMessage: string | null; audience: "general" | "login" | "search" }): string`
  - `statusText(status: string, errorCode: string | null): string`
  - `formatByteSize(byteSize: number): string`
  - `formatLocalMinute(iso: string): string`
  - `formatScore(score: number): string`
  - `photoAlt(description: string | null): string`
  - 常量 `LOADING`、`NETWORK_MESSAGE`、`SESSION_EXPIRED`、`SEARCH_NOT_READY`、`ALBUM_NOT_READY`
  - `specs/SPEC.md` 阶段 6 为 `in_progress`。`specs/phases/06-web-ui.md` 状态为 `in_progress`，六条验收仍是 `- [ ]`。设计文件状态行仍是 `已定稿（待实现）`

- [ ] **Step 1: 写会失败的文案与脚手架测试**

创建 `apps/web/test/copy.test.ts`：

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import {
  fallbackMessage,
  formatByteSize,
  formatLocalMinute,
  formatScore,
  photoAlt,
  statusText,
  visibleMessage,
} from "../src/copy.ts";

test("兜底句按状态码，不展示自由文本", () => {
  assert.equal(fallbackMessage(400), "请求不合法");
  assert.equal(fallbackMessage(401), "未授权");
  assert.equal(fallbackMessage(403), "当前凭证不能执行该操作");
  assert.equal(fallbackMessage(404), "未找到");
  assert.equal(fallbackMessage(409), "请求冲突");
  assert.equal(fallbackMessage(413), "文件超过 32 MiB");
  assert.equal(fallbackMessage(500), "服务器错误");
  assert.equal(fallbackMessage(502), "嵌入被拒绝");
  assert.equal(fallbackMessage(503), "嵌入暂不可用");
  assert.equal(fallbackMessage(200), "服务器错误");
  assert.equal(fallbackMessage(418), "服务器错误");
});

test("允许列表逐字匹配，比较前不 trim", () => {
  assert.equal(
    visibleMessage({ status: 500, code: "internal_error", serverMessage: "上传未能完成", audience: "general" }),
    "上传未能完成",
  );
  assert.equal(
    visibleMessage({ status: 400, code: "validation_error", serverMessage: "查询为空 ", audience: "search" }),
    "请求不合法",
  );
});

test("搜索 validation_error 不收成同一句", () => {
  for (const message of ["请求不合法", "标签不合法", "拍摄时间不合法", "时间范围不合法"] as const) {
    assert.equal(
      visibleMessage({ status: 400, code: "validation_error", serverMessage: message, audience: "search" }),
      message,
    );
  }
  assert.equal(
    visibleMessage({ status: 400, code: "validation_error", serverMessage: "随便写的", audience: "search" }),
    "请求不合法",
  );
  assert.equal(
    visibleMessage({ status: 400, code: "empty_query", serverMessage: "查询为空", audience: "search" }),
    "查询为空",
  );
  assert.equal(
    visibleMessage({ status: 400, code: "query_too_long", serverMessage: "查询过长", audience: "search" }),
    "查询过长",
  );
  assert.equal(
    visibleMessage({ status: 502, code: "embed_rejected", serverMessage: "嵌入被拒绝", audience: "search" }),
    "嵌入被拒绝",
  );
  assert.equal(
    visibleMessage({ status: 503, code: "embed_unavailable", serverMessage: "嵌入暂不可用", audience: "search" }),
    "嵌入暂不可用",
  );
});

test("登录 401 invalid_credentials 固定为邮箱或密码错误", () => {
  assert.equal(
    visibleMessage({ status: 401, code: "invalid_credentials", serverMessage: "未授权", audience: "login" }),
    "邮箱或密码错误",
  );
});

test("处理状态有文字", () => {
  assert.equal(statusText("processing", null), "处理中");
  assert.equal(statusText("processing", "storage"), "处理中，将自动重试");
  assert.equal(statusText("processing", "vision_unavailable"), "处理中，将自动重试");
  assert.equal(statusText("processing", "embed_unavailable"), "处理中，将自动重试");
  assert.equal(statusText("failed", "storage"), "处理失败，可以重试");
  assert.equal(statusText("failed", "original_missing"), "原图缺失");
  assert.equal(statusText("failed", "thumbnail_failed"), "缩略图失败");
  assert.equal(statusText("failed", "vision_rejected"), "描述被拒绝");
  assert.equal(statusText("failed", "embed_rejected"), "嵌入被拒绝");
  assert.equal(statusText("failed", "dimension_mismatch"), "向量维度不符");
  assert.equal(statusText("failed", "invalid_embedding"), "向量无效");
  assert.equal(statusText("failed", "other"), "处理未完成");
  assert.equal(statusText("failed", null), "处理未完成");
  assert.equal(statusText("ready", "storage"), "已就绪");
});

test("字节与本地时间", () => {
  assert.equal(formatByteSize(1023), "1023 字节");
  assert.equal(formatByteSize(1024), "1 KiB");
  assert.equal(formatByteSize(1536), "2 KiB");
  assert.equal(formatByteSize(1048576), "1.0 MiB");
  assert.equal(formatByteSize(1572864), "1.5 MiB");
  const iso = "2026-11-10T00:30:00.000Z";
  const date = new Date(iso);
  const expected = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  assert.equal(formatLocalMinute(iso), expected);
  assert.match(formatLocalMinute(iso), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test("score 不二次舍入", () => {
  assert.equal(formatScore(1), "1");
  assert.equal(formatScore(0.333333), "0.333333");
  assert.equal(formatScore(-0.25), "-0.25");
});

test("图片替代文本", () => {
  assert.equal(photoAlt("  海边  "), "海边");
  assert.equal(photoAlt("   "), "照片");
  assert.equal(photoAlt(null), "照片");
});
```

创建 `apps/web/test/web-scaffold.test.ts`：

```typescript
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Vite 只做同源代理，不增加跨源变量", async () => {
  const source = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(source, /port:\s*43123/);
  assert.match(source, /target:\s*"http:\/\/127\.0\.0\.1:3000"/);
  assert.match(source, /replace\(\/\^\\\/api\/,\s*""\)/);
  assert.equal(source.includes("PUBLIC_BASE_URL"), false);
  assert.equal(source.includes("CORS_ORIGIN"), false);
  assert.equal(source.includes("VITE_"), false);
});

test("两个开关都是字面量 false，且不读环境", async () => {
  const source = await readFile(new URL("../src/features.ts", import.meta.url), "utf8");
  assert.match(source, /export const searchCallsEnabled = false;/);
  assert.match(source, /export const albumCallsEnabled = false;/);
  assert.equal(source.includes("import.meta.env"), false);
  assert.equal(source.includes("localStorage"), false);
});

test("网页不新增依赖，根测试脚本仍然只跑 API", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["react", "react-dom"]);
  for (const banned of ["playwright", "vitest", "@playwright/test", "jest", "jsdom", "happy-dom", "@testing-library/react"]) {
    assert.equal(Object.hasOwn(pkg.devDependencies, banned), false);
  }
  const root = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")) as {
    scripts: { test: string };
  };
  assert.equal(root.scripts.test, "node scripts/check-layer-boundaries.mjs && npm run test -w apps/api");
});

test("阶段 6 已开工且设计状态未被改掉", async () => {
  const phase = await readFile(new URL("../../../specs/phases/06-web-ui.md", import.meta.url), "utf8");
  assert.match(phase, /\*\*状态：\*\* in_progress/);
  assert.equal((phase.match(/- \[x\]/g) ?? []).length, 0);
  assert.ok((phase.match(/- \[ \]/g) ?? []).length >= 6);
  const spec = await readFile(new URL("../../../specs/SPEC.md", import.meta.url), "utf8");
  assert.match(spec, /\| 6 \|.*\| in_progress \|/);
  const design = await readFile(
    new URL("../../../docs/superpowers/specs/2026-11-06-openalbum-phase6-web-ui-design.md", import.meta.url),
    "utf8",
  );
  assert.match(design, /状态：已定稿（待实现）/);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
node --import tsx --test --test-concurrency=1 apps/web/test/copy.test.ts apps/web/test/web-scaffold.test.ts
```

Expected: FAIL。模块不存在，或阶段状态仍是 `planned`。退出码非 0。

- [ ] **Step 3: 写代理、开关和文案**

`apps/web/vite.config.ts` 保持插件、`host`、`preview` 不变，只在 `server` 里加上代理：

```typescript
server: {
  host: "0.0.0.0",
  port: 43123,
  proxy: {
    "/api": {
      target: "http://127.0.0.1:3000",
      rewrite: (path) => path.replace(/^\/api/, ""),
    },
  },
},
```

`apps/web/src/features.ts`：

```typescript
/** 批次 B 由 Task 10 改为 true。在那之前搜索页不得发检索请求。 */
export const searchCallsEnabled = false;

/** 批次 C 阻塞。本计划的任何任务都不得把它改为 true。 */
export const albumCallsEnabled = false;
```

`apps/web/src/copy.ts` 按下面实现。`formatScore` 只能 `return String(score)`。`formatByteSize` 的 MiB 分支才可以使用 `toFixed(1)`。

```typescript
export const LOADING = "正在加载";
export const NETWORK_MESSAGE = "网络不可用，请重试";
export const SESSION_EXPIRED = "登录已失效";
export const SEARCH_NOT_READY = "检索接口尚未就绪";
export const ALBUM_NOT_READY = "共享册接口尚未接通。";

const ALLOWED_MESSAGES = new Set<string>([
  "请求不合法",
  "邮箱格式不正确",
  "密码长度须为 8 到 128",
  "名称不合法",
  "标识不合法",
  "未授权",
  "邮箱或密码错误",
  "当前凭证不能执行该操作",
  "该邮箱已注册",
  "未找到",
  "不支持的文件类型",
  "文件大小须为 1 字节到 32 MiB",
  "分片不合法",
  "描述不合法",
  "标签不合法",
  "地点不合法",
  "拍摄时间不合法",
  "经纬度须成对出现",
  "经纬度超出范围",
  "上传已结束",
  "上传正在完成",
  "上传已完成",
  "文件超过 32 MiB",
  "对象存储不可用",
  "上传未能完成",
  "删除未能完成",
  "修改未能完成",
  "照片不在失败状态",
  "查询为空",
  "查询过长",
  "时间范围不合法",
  "嵌入被拒绝",
  "嵌入暂不可用",
  "服务器错误",
]);

const SEARCH_MESSAGES = new Set<string>([
  "未授权",
  "请求不合法",
  "查询为空",
  "查询过长",
  "标签不合法",
  "拍摄时间不合法",
  "时间范围不合法",
  "嵌入被拒绝",
  "嵌入暂不可用",
  "对象存储不可用",
  "服务器错误",
]);

export function fallbackMessage(status: number): string {
  switch (status) {
    case 400:
      return "请求不合法";
    case 401:
      return "未授权";
    case 403:
      return "当前凭证不能执行该操作";
    case 404:
      return "未找到";
    case 409:
      return "请求冲突";
    case 413:
      return "文件超过 32 MiB";
    case 500:
      return "服务器错误";
    case 502:
      return "嵌入被拒绝";
    case 503:
      return "嵌入暂不可用";
    default:
      return "服务器错误";
  }
}

export function visibleMessage(input: {
  status: number;
  code: string | null;
  serverMessage: string | null;
  audience: "general" | "login" | "search";
}): string {
  if (input.audience === "login" && input.status === 401 && input.code === "invalid_credentials") {
    return "邮箱或密码错误";
  }
  const allowed = input.audience === "search" ? SEARCH_MESSAGES : ALLOWED_MESSAGES;
  if (input.serverMessage !== null && allowed.has(input.serverMessage)) return input.serverMessage;
  return fallbackMessage(input.status);
}

const RETRYABLE = new Set(["storage", "vision_unavailable", "embed_unavailable"]);

const ERROR_CODE_TEXT: Record<string, string> = {
  original_missing: "原图缺失",
  thumbnail_failed: "缩略图失败",
  vision_rejected: "描述被拒绝",
  embed_rejected: "嵌入被拒绝",
  dimension_mismatch: "向量维度不符",
  invalid_embedding: "向量无效",
};

export function statusText(status: string, errorCode: string | null): string {
  if (status === "ready") return "已就绪";
  if (errorCode !== null && RETRYABLE.has(errorCode)) {
    return status === "failed" ? "处理失败，可以重试" : "处理中，将自动重试";
  }
  if (errorCode !== null && ERROR_CODE_TEXT[errorCode] !== undefined) return ERROR_CODE_TEXT[errorCode];
  if (status === "processing" && errorCode === null) return "处理中";
  return "处理未完成";
}

export function formatByteSize(byteSize: number): string {
  if (byteSize >= 1048576) {
    const value = Math.round((byteSize / 1048576) * 10) / 10;
    return `${value.toFixed(1)} MiB`;
  }
  if (byteSize >= 1024) return `${Math.round(byteSize / 1024)} KiB`;
  return `${byteSize} 字节`;
}

export function formatLocalMinute(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day} ${hour}:${minute}`;
}

export function formatScore(score: number): string {
  return String(score);
}

export function photoAlt(description: string | null): string {
  if (description !== null && description.trim() !== "") return description.trim();
  return "照片";
}
```

`specs/phases/06-web-ui.md` 只把状态行改为 `**状态：** in_progress`。不要勾选验收，不要改计划链接。

`specs/SPEC.md` 只把阶段 6 那一行的状态改为 `in_progress`：

```markdown
| 6 | [phases/06-web-ui.md](phases/06-web-ui.md) | in_progress | React 界面与端到端主路径 |
```

不要勾选「任何阶段的完成定义」。不要改设计文件的状态行。

- [ ] **Step 4: 运行测试与类型检查**

Run:

```bash
node --import tsx --test --test-concurrency=1 apps/web/test/copy.test.ts apps/web/test/web-scaffold.test.ts
npm run typecheck -w apps/web
```

Expected: 测试 `# fail 0`，退出码 0。`typecheck` 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add apps/web/vite.config.ts apps/web/src/features.ts apps/web/src/copy.ts apps/web/test/copy.test.ts apps/web/test/web-scaffold.test.ts specs/SPEC.md specs/phases/06-web-ui.md
git commit -m "feat: 接通网页同源代理与固定文案"
```

---

### Task 2: 内存会话与单飞刷新

**Files:**
- Create: `apps/web/src/session.ts`
- Test: `apps/web/test/session.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `SESSION_EXPIRED`。刷新路径是 `/api/auth/refresh`，退出路径是 `/api/auth/logout`
- Produces:
  - `createSessionController(deps: SessionDeps): SessionController`
  - `session: SessionController`，给页面使用的单例
  - `SessionDeps` 含 `fetch`、`now`、`setTimer`、`clearTimer`
  - `SessionController` 含 `getSnapshot`、`getAccessToken`、`subscribe`、`applyAuthBody`、`clear`、`refreshSingleFlight`、`logout`
  - `refreshDelayMs(expiresInSeconds: number): number`
  - `RefreshOutcome = "ok" | "unauthorized" | "error"`
  - `LogoutResult = { ok: true } | { ok: false; kind: "network" } | { ok: false; kind: "http"; status: number; code: string | null; serverMessage: string | null }`

内存字段只有 `accessToken`、`accessTokenExpiresAt`、`refreshToken`、`user.id`、`user.email`，外加界面用的 `notice`。不保存密码，不解码 JWT。

- [ ] **Step 1: 写会失败的会话测试**

创建 `apps/web/test/session.test.ts`。用注入的 `fetch` 和定时器，不要调用真实网络，也不要使用真实 `setTimeout` 等待。

断言：

1. `refreshDelayMs(900)` 为 `840000`。`refreshDelayMs(60)` 为 `30000`。`refreshDelayMs(10)` 为 `5000`。`refreshDelayMs(1)` 为 `1000`。
2. `applyAuthBody` 写入后，`getAccessToken()` 等于响应里的 Access JWT，`getSnapshot().user.email` 等于 `user.email`。第二个并发的 `refreshSingleFlight()` 只产生一次 `POST /api/auth/refresh`。该请求没有 `Authorization` 头，正文 `JSON.parse` 后只有 `refreshToken` 一个键。
3. 刷新响应 200 后，内存中的两枚令牌都被替换，邮箱更新为新响应里的邮箱，并且重新登记一个定时器。
4. 刷新响应 401 时结果是 `unauthorized`，`getAccessToken()` 为 `null`，`notice` 为「登录已失效」。
5. 受保护请求的重试由调用方做。本文件只要保证：刷新进行中第二次调用不会发出第二个 POST。可以用一个直到测试调用 `release()` 才返回的 fetch 证明 `fetch` 计数保持为 1。
6. `logout` 在有在途刷新时先等待那个 Promise，然后用等待结束后的 Refresh Token 发 `POST /api/auth/logout`，不带 `Authorization`。204 与 401 都清空会话且 `notice` 为 `null`。网络抛错或响应 500 时令牌仍在，返回 `{ ok: false }`。
7. 源码扫描 `session.ts`：不得包含 `localStorage`、`sessionStorage`、`indexedDB`、`document.cookie`、`console.`。

注册成功体使用：

```json
{
  "tokenType": "Bearer",
  "accessToken": "access-1",
  "accessTokenExpiresIn": 900,
  "refreshToken": "oalr_one",
  "refreshTokenExpiresAt": "2026-12-03T07:50:00.000Z",
  "user": { "id": "11111111-1111-4111-8111-111111111111", "email": "a@example.com" }
}
```

缺 `accessToken`、`refreshToken` 不是字符串、或 `accessTokenExpiresIn` 不是有限正数时，`applyAuthBody` 返回 `false` 并且不改掉已有会话。

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
node --import tsx --test --test-concurrency=1 apps/web/test/session.test.ts
```

Expected: FAIL。`session.ts` 不存在。退出码非 0。

- [ ] **Step 3: 实现会话控制器**

`refreshDelayMs`：

```typescript
export function refreshDelayMs(expiresInSeconds: number): number {
  if (expiresInSeconds <= 60) return Math.max(1000, (expiresInSeconds * 1000) / 2);
  return expiresInSeconds * 1000 - 60_000;
}
```

`createSessionController` 的规则：

- `applyAuthBody` 只在形状完整时替换令牌、过期时刻（`deps.now() + accessTokenExpiresIn * 1000`）和用户，清掉 `notice`，并调用 `schedule()`。过期时刻用客户端时钟，不读 `refreshTokenExpiresAt`。
- `schedule` 先清掉上一个定时器，再按 `refreshDelayMs` 登记。定时器回调只调用 `refreshSingleFlight`。不要监听 `document.hidden`。标签页隐藏时定时器继续存在。
- `refreshSingleFlight` 把进行中的 Promise 放在控制器字段上。字段非空时直接返回它。`finally` 里把字段设回 `null`。
- 刷新的 `fetch` 是 `POST /api/auth/refresh`，头只有 `Content-Type: application/json`，正文 `JSON.stringify({ refreshToken })`。不要把页面的 `AbortSignal` 传进来。
- 刷新网络失败、非 401 的 HTTP、或 200 但正文形状不对：返回 `error`，保留现有令牌，不安排新的定时器。下一次 401 仍可再刷新。
- 刷新 401，或 200 的正文不能用：`clear(SESSION_EXPIRED)`，返回 `unauthorized`。
- `clear` 递增一个代数。已经发出的刷新在写回前发现代数变了，就丢弃响应，不得把退出后的用户再写回登录态。`logout` 若看到进行中的刷新，先 `await` 它，再读取当时的 `refreshToken`。没有令牌则 `clear(null)` 并返回 `{ ok: true }`。
- `logout` 的 204 与 401 调用 `clear(null)`。不要把退出显示成「登录已失效」。500 或网络失败不调用 `clear`。
- 单例：

```typescript
export const session = createSessionController({
  fetch: globalThis.fetch.bind(globalThis),
  now: () => Date.now(),
  setTimer: (fn, delayMs) => setTimeout(fn, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});
```

不要在模块顶层调用 `applyAuthBody` 或 `refreshSingleFlight`。

- [ ] **Step 4: 运行测试**

Run:

```bash
node --import tsx --test --test-concurrency=1 apps/web/test/session.test.ts
npm run typecheck -w apps/web
```

Expected: 测试与 `typecheck` 退出码都是 0。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/session.ts apps/web/test/session.test.ts
git commit -m "feat: 将网页会话保持在内存并单飞刷新"
```

---

### Task 3: API 客户端

**Files:**
- Create: `apps/web/src/api.ts`
- Test: `apps/web/test/api.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `SessionController`。`refreshSingleFlight` 返回 `ok` 时 `getAccessToken()` 已是新令牌
- Produces:
  - `createApi(deps: { session: SessionController; fetch: typeof fetch }): Api`
  - `api: Api` 单例，内部使用 `session` 与 `globalThis.fetch`
  - `ApiResult<T>`：`{ ok: true; status: number; data: T }`、`{ ok: false; kind: "aborted" }`、`{ ok: false; kind: "network" }`、`{ ok: false; kind: "http"; status: number; code: string | null; serverMessage: string | null }`
  - `Photo` 类型，键为设计第 6 节列出的那些，外加 `status: "processing" | "ready" | "failed"`
  - 方法：`register`、`login`、`listPhotos`、`getPhoto`、`createUpload`、`putPart`、`completeUpload`、`abortUpload`、`patchPhoto`、`deletePhoto`、`retryPhoto`、`listKeys`、`createKey`、`revokeKey`
  - 本任务不提供搜索方法。`api.ts` 源码不得出现 `photos/search` 或 `album`

`code` 与 `message` 必须同时是字符串，才把 `message` 放进 `serverMessage`。缺一则两者都当 `null`。不要 trim `message`。204 的 `data` 为 `null`。`AbortError` 返回 `aborted`，不要当成网络失败。

- [ ] **Step 1: 写会失败的客户端测试**

`apps/web/test/api.test.ts` 注入假的 session 与 fetch，断言：

1. `listPhotos(null)` 请求 `GET /api/photos?limit=50`，带 `Authorization: Bearer <access>`。有游标时再加 `&cursor=` 与 `encodeURIComponent` 之后的游标，没有其它查询参数。
2. 第一次响应 401、`refreshSingleFlight` 返回 `ok` 且令牌已换成 `access-2` 时，第二次请求使用 `Bearer access-2`，刷新只被调用一次。第二次仍是 401 时，调用 `session.clear`，参数为「登录已失效」，并且不再发第三次。
3. `register` 与 `login` 是 `POST /api/auth/register` 与 `POST /api/auth/login`，正文只有 `email` 与 `password`，没有 `Authorization`。成功后调用 `applyAuthBody`，不再额外请求登录。
4. `putPart` 是 `PUT /api/photos/uploads/<id>/parts/1`，头是 `Content-Type: application/octet-stream`，正文是传入的 `Blob`。路径里的片号只能是 `1`。
5. `completeUpload` 与 `abortUpload` 的正文是 `{}`。`retryPhoto` 的正文是 `{}`。`patchPhoto` 原样发送调用方给出的对象。
6. 非 JSON 正文得到 `serverMessage: null`。JSON 错误 `{ "error": { "code": "validation_error", "message": "标签不合法" } }` 保持这句原文。
7. 照片解析只留下白名单键。多余的 `objectKey` 不出现在结果上。`listPhotos` 缺少 `photos` 数组时返回 `ok: false`。
8. 源码没有 `photos/search`、`album`、`GET /me`、`localStorage`。

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
node --import tsx --test --test-concurrency=1 apps/web/test/api.test.ts
```

Expected: FAIL。退出码非 0。

- [ ] **Step 3: 实现客户端**

受保护请求在 401 且这次还没重试过时：`await session.refreshSingleFlight()`。结果是 `ok` 才用新令牌重试一次。结果不是 `ok` 则把刷新函数已经做过的清空保留下来；若结果是 `error`（刷新没有清空会话）并且重试后的响应仍是 401，再 `session.clear(SESSION_EXPIRED)`。重试后的 401 也清空。不要第三次请求。

`register` 与 `login` 在 HTTP 成功后把响应正文交给 `applyAuthBody`。形状不被接受时返回 `ok: false` 的 http 结果，状态沿用 HTTP 状态，不写入半截令牌。

`createKey` 的成功数据类型是 `{ apiKey: ApiKey; secret: string }`。`listKeys` 的成功数据是 `{ apiKeys: ApiKey[] }`。`ApiKey` 只有 `id`、`name`、`keyPrefix`、`createdAt`、`lastUsedAt`、`revokedAt`。列表响应里的 `secret` 丢掉，不放进 `ApiKey`。

`createUpload` 成功时读取 `upload.id` 与 `upload.photoId`，两者都要是字符串。不把 `objectKey` 放进返回值。返回 `{ uploadId, photoId }`。

`completeUpload` 成功时读取 `photo.id`。用与 `getPhoto` 相同的解析得到 `Photo`。201 与 200 都算成功。

路径里的 id 由调用方传入。调用方负责已经是小写 UUID。本文件不改写签名 URL。

- [ ] **Step 4: 运行测试**

Run:

```bash
node --import tsx --test --test-concurrency=1 apps/web/test/api.test.ts apps/web/test/session.test.ts
npm run typecheck -w apps/web
```

Expected: 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api.ts apps/web/test/api.test.ts
git commit -m "feat: 添加只走同源前缀的网页 API 客户端"
```

---

### Task 4: 路由、外壳、占位替换，以及常量关闭时的静态页

**Files:**
- Create: `apps/web/src/router.tsx`
- Create: `apps/web/src/shell.tsx`
- Create: `apps/web/src/pages/not-found.tsx`
- Create: `apps/web/src/pages/search.tsx`
- Create: `apps/web/src/pages/albums-blocked.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/index.css`
- Test: `apps/web/test/router.test.ts`

**Interfaces:**
- Consumes: `session.getSnapshot()`、`SEARCH_NOT_READY`、`ALBUM_NOT_READY`、`albumCallsEnabled`
- Produces:
  - `matchPath(pathname: string): Route`
  - `isSafeReturnTo(pathname: string): boolean`
  - `rememberReturnTo(pathname: string): void` 与 `consumeReturnTo(): string`
  - `Route` 为 `login`、`register`、`upload`、`search`、`keys`、`account`、`albumNew`、`album`（含小写 `id`）、`albums`、`photo`（含小写 `id`）、`join`（含解码后的 `slug`）、`library`、`notFound`
  - `Shell` 与改写后的 `App`

本任务的搜索页只渲染一个表单外壳：模式、查询、提交。提交时不调用 `api`，只显示 `SEARCH_NOT_READY`。共享册页面只实现设计第 6.8 节在 `albumCallsEnabled === false` 时的静态行为。这是批次 A 手工脚本第 13 步要用的占位，不是共享册功能。禁止在这些文件里写 `fetch`、`/api` 或角色控件。

- [ ] **Step 1: 写会失败的路由测试**

`apps/web/test/router.test.ts` 断言匹配顺序：

| 路径 | 结果 |
|------|------|
| `/login` | `login` |
| `/register` | `register` |
| `/upload` | `upload` |
| `/search` | `search` |
| `/keys` | `keys` |
| `/account` | `account` |
| `/albums/new` | `albumNew` |
| `/albums/11111111-1111-4111-8111-111111111111` | `album`，id 为小写 |
| `/albums/NOT-A-UUID` | `notFound` |
| `/albums` | `albums` |
| `/photos/11111111-1111-4111-8111-111111111111` | `photo` |
| `/photos/uploads` | `notFound` |
| `/join/demo` | `join`，slug 为 `demo` |
| `/join/.`、`/join/..`、`/join/a/b` | `notFound` |
| `/` | `library` |
| `/nope`、`/upload/` | `notFound` |

`isSafeReturnTo`：`/upload` 为真；`/login`、`/register`、`//evil`、`/\\x`、`/a://b`、超过 200 字符、带 `?` 或 `#` 的字符串为假。`/photos/uploads` 为假，因为它不是 UUID。

slug 的 UTF-8 字节长度用 `TextEncoder`。201 字节为 `notFound`。`decodeURIComponent` 抛错时为 `notFound`。

另外读取源码：

- `src/App.tsx`、`src/pages` 不得再出现 `Phase 0 · 脚手架` 或 `尚未开始`。
- `albums-blocked.tsx` 不得出现 `fetch` 或 `/api`。
- `index.css` 仍含 `--bg: #f3efe6`、`--ink: #1d1a16`、`--muted: #5e584e`、`--line: #d8d0c2`、`--accent: #8a3d2f`、`--paper: #faf7f1`，并含 `40rem`、`72rem`、`minmax(11rem, 1fr)`、`2.75rem`。
- `index.html` 仍有 `lang="zh-CN"`。

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
node --import tsx --test --test-concurrency=1 apps/web/test/router.test.ts
```

Expected: FAIL。退出码非 0。

- [ ] **Step 3: 实现路由、外壳和静态页**

`matchPath` 按设计第 4 节的顺序写 `if`。UUID 使用 `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`，放进路由前 `toLowerCase()`。不要为了无效 id 发请求。

`App`：

- 用 `useState` 保存 `window.location.pathname`，监听 `popstate`。
- `navigate(to, mode)`：`pushState` 或 `replaceState` 的 state 为 `null`，然后更新 state。不要改 `document.title`。
- 订阅 `session`。未登录渲染受保护页之前就 `replace` 到 `/login`，并用 `rememberReturnTo` 记下当前路径。受保护页是除 `login`、`register`、`join`、`notFound` 以外的路由。未登录时不要挂载会发 `GET /photos` 的组件。
- 已登录打开登录或注册页时 `replace` 到 `/`。
- 登录与注册路由在本任务只渲染互相指向的文字链接，不发 `POST /auth/login` 或 `POST /auth/register`。Task 5 再用 `login.tsx` 与 `register.tsx` 换上表单。`/join/:slug` 未登录时只显示产品名「AI Native 共享相册」（链到 `/`）和「登录」链接。
- 已登录时渲染 `Shell`。产品名链到 `/`。`main` 的 `id="content"`。第一个可聚焦元素是「跳到内容」，`href="#content"`。
- 视口用 CSS 而不是 `User-Agent`。桌面导航链接为「照片」「搜索」「上传」「共享册」「API Key」，另有当前邮箱和「退出」按钮。窄屏底部五项为「照片」「搜索」「上传」「共享册」「账户」，顶部只留产品名。当前项 `aria-current="page"`：`/` 对应照片，`/search` 对应搜索，`/upload` 对应上传，`/albums`、`/albums/new`、册详情对应共享册，`/keys` 对应 API Key，`/account` 对应账户。照片详情不点亮导航项。
- 「退出」调用 Task 2 的 `logout`。`ok: true` 时 `replace` 到 `/login`。`ok: false` 且 `kind: "network"` 时在外壳的 `aria-live="polite"` 区域显示「网络不可用，请重试」。HTTP 失败用 `visibleMessage`，`audience: "general"`，人仍保持登录。

`index.css` 重写布局，保留 `:root` 变量和现有字体族。`body` 字号 `16px`。桌面（`min-width: 40rem`）显示顶部导航、隐藏底部导航，内容最大宽度 `72rem` 并水平居中。窄屏相反，底部导航固定在视口底部，每项 `min-height: 2.75rem`，`main` 留出底部空隙。个人库网格按 Global Constraints。图片 `max-width: 100%`。长的 Key 前缀使用 `overflow-wrap: anywhere`。不要用 `overflow-x: hidden` 掩盖溢出，也不要写 `transition` 或 `@keyframes`。

`not-found.tsx` 显示「页面不存在」。未登录链到「登录」，已登录链到「照片」。不请求 API。

`search.tsx` 在本任务提交时：默认选中「关键词」，说明文字使用设计第 6.5 节的三句（「匹配描述或标签里的连续文字，不分词。」「在已就绪的照片里按语义查找。」「只检索已就绪的照片。」）。提交阻止默认事件，显示 `SEARCH_NOT_READY`，不 import `api`。

`albums-blocked.tsx` 按路径渲染：

- `/albums`：横幅 `ALBUM_NOT_READY`、文字「还没有共享册」、到 `/albums/new` 的链接。
- `/albums/new`：标题、说明、口令、再输入一次口令、可清空的过期时间。口令框 `type="password"`。标题 trim 后长度小于 1 时显示「请填写标题」。两遍口令 trim 后为空或不相等时显示「两次口令不一致」。两项都失败时两句都显示。本地校验通过后的提交只显示横幅并清空两个口令框，不发请求。不写标题上限、口令字符集或过期时间的 JSON。
- 册详情：横幅和标题「共享册」。不显示册名、成员、照片、「已过期」或「只读纪念册」。
- `/join/:slug`：显示解码后的 slug 文本、一个口令框和「进入」。不显示册标题。提交不发请求，显示 `ALBUM_NOT_READY`，并清空口令框。本页没有第二遍口令，不套用创建页的「请填写标题」「两次口令不一致」，也不另写空口令文案。

不要渲染册主、可上传、只读的按钮。不要显示「还没有其他成员」。

- [ ] **Step 4: 运行测试**

Run:

```bash
node --import tsx --test --test-concurrency=1 apps/web/test/router.test.ts apps/web/test/web-scaffold.test.ts
npm run typecheck -w apps/web
```

Expected: 退出码 0。页面正文不再依赖 Phase 0 占位。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/router.tsx apps/web/src/shell.tsx apps/web/src/App.tsx apps/web/src/index.css apps/web/src/pages/not-found.tsx apps/web/src/pages/search.tsx apps/web/src/pages/albums-blocked.tsx apps/web/test/router.test.ts
git commit -m "feat: 用手写 History API 替换网页占位"
```

本任务做完后可以人工打开 `http://127.0.0.1:43123/`：未登录看到登录入口，正文没有 `Phase 0 · 脚手架`。未登录打开 `/search` 或 `/albums` 会到登录页，并且不发检索或共享册请求。未登录打开 `/join/demo` 看到「共享册接口尚未接通。」，提交后口令框被清空，网络面板没有路径中含 `album` 的请求。登录成功后的搜索横幅放到批次 A 第 12 步。

---

### Task 5: 注册与登录

**Files:**
- Create: `apps/web/src/pages/auth-form.ts`
- Create: `apps/web/src/pages/login.tsx`
- Create: `apps/web/src/pages/register.tsx`
- Modify: `apps/web/src/App.tsx`（把登录和注册路由接到这两个页面）
- Test: `apps/web/test/auth-form.test.ts`

**Interfaces:**
- Consumes: `api.register`、`api.login`、`consumeReturnTo`、`visibleMessage`、`SESSION_EXPIRED`
- Produces:
  - `validateEmail(raw: string): { ok: true; email: string } | { ok: false; message: "邮箱格式不正确" }`
  - `validatePassword(password: string): { ok: true } | { ok: false; message: "密码长度须为 8 到 128" }`

邮箱先 trim，不改大小写。正则 `^[^\s@]+@[^\s@]+\.[^\s@]+$`，长度 1–320。密码不 trim，按 JavaScript 字符串长度 8–128。不合法时不发请求。

- [ ] **Step 1: 写会失败的校验测试**

断言：`"  A@Example.com  "` 通过且结果仍是 `A@Example.com`；`"a@b"`、空串、321 个字符的本地部分加 `@x.com` 失败。密码 `"1234567"` 与 129 个字符失败；`"12345678"` 与前后有空格但长度仍在范围内的字符串通过，并且不裁掉空格。

源码断言：登录邮箱 `autoComplete="username"`，密码 `autoComplete="current-password"`。注册邮箱 `autoComplete="email"`，密码 `autoComplete="new-password"`。两个密码框都是 `type="password"`。

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
node --import tsx --test --test-concurrency=1 apps/web/test/auth-form.test.ts
```

Expected: FAIL。退出码非 0。

- [ ] **Step 3: 实现两个页面**

字段只有邮箱和密码。每个输入都有可见的 `<label>`。错误摘要 `aria-live="polite"`，失败时把焦点移到摘要（`tabIndex={-1}`）。提交进行中按钮不可再次点击。

成功后 `consumeReturnTo()`，`replace` 到返回值。注册成功不再调用登录。注册得到 409 且可见句为「该邮箱已注册」时，额外给出到 `/login` 的链接。其它失败用 `visibleMessage`，`audience: "login"`。网络失败显示「网络不可用，请重试」，不自动再请求。

若 `session.getSnapshot().notice` 为「登录已失效」，登录页在第一次渲染就显示这句。用户开始输入时可以保留它，直到下一次提交结果替换摘要。

不在渲染函数里调用 `register` 或 `login`。

- [ ] **Step 4: 运行测试**

Run:

```bash
node --import tsx --test --test-concurrency=1 apps/web/test/auth-form.test.ts
npm run typecheck -w apps/web
```

Expected: 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/auth-form.ts apps/web/src/pages/login.tsx apps/web/src/pages/register.tsx apps/web/src/App.tsx apps/web/test/auth-form.test.ts
git commit -m "feat: 接通注册与登录页面"
```

人工确认：错误密码显示「邮箱或密码错误」。正确登录后整页刷新回到登录页。开发者工具里的 `localStorage`、`sessionStorage` 和控制台没有 Access JWT、Refresh Token、`oalr_` 或 `oalb_`。

---

### Task 6: 个人库、卡片与处理中轮询

**Files:**
- Create: `apps/web/src/pages/photo-card.tsx`
- Create: `apps/web/src/pages/library.tsx`
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/test/library-poll.test.ts`

**Interfaces:**
- Consumes: `api.listPhotos`、`api.getPhoto`、`Photo`、`statusText`、`formatByteSize`、`formatLocalMinute`、`photoAlt`、`LOADING`、`NETWORK_MESSAGE`、`visibleMessage`
- Produces:
  - `nextPollIds(ids: readonly string[], offset: number): { ids: string[]; nextOffset: number }`
  - `PhotoCard`，props 为 `{ photo: Photo; score: number | null; showScore: boolean }`

`nextPollIds` 每次最多取 4 个。不足 4 个时原样返回，`nextOffset` 为 0。多于 4 个时从 `offset` 起环形取 4 个，`nextOffset` 为 `(offset + 4) % ids.length`。

- [ ] **Step 1: 写会失败的轮询批次测试**

5 个 id、offset 0 得到前 4 个且 `nextOffset` 为 4。下一次从第 5 个再绕回前 3 个。2 个 id 时两个都在，`nextOffset` 为 0。

源码断言 `library.tsx` 含 `limit` 只通过 `listPhotos`，含 `document.hidden`，含 5000 毫秒间隔，不含 `photos/search`。

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
node --import tsx --test --test-concurrency=1 apps/web/test/library-poll.test.ts
```

Expected: FAIL。退出码非 0。

- [ ] **Step 3: 实现列表**

进入页面后请求第一页。返回前显示「正在加载」，不要显示「还没有照片」。空数组且 `nextCursor` 为 `null` 时显示「还没有照片」和到 `/upload` 的链接。

卡片是到 `/photos/<id>` 的链接。`thumbUrl` 非空时显示图片，替代文本用 `photoAlt`。没有缩略图时只显示 `statusText`，不放一张会裂开的图片。卡片还显示 `formatByteSize(byteSize)` 与 `formatLocalMinute(createdAt)`。状态文字使用 `--ink`，不要只靠颜色。

`nextCursor` 非空时显示「加载更多」。点击后用同一个 limit 和该游标把结果接在后面。已有 id 就地替换，新 id 追加，不重排。按钮在请求中不可点。`nextCursor` 为 `null` 时不显示按钮。不用无限滚动。

已加载卡片里 `status === "processing"` 的 id 才轮询。每 5 秒调用 `nextPollIds`，对选出的 id 各发一次 `GET /photos/:id`，用返回值替换该卡片。`document.hidden` 为真时这一轮不发请求，也不要把错过的轮次补发。状态不再是 `processing` 后，该 id 自然离开下一批。不因为轮询移动焦点。

页面卸载时 `AbortController.abort()`。忽略 `aborted`。网络失败显示「网络不可用，请重试」，按钮只重做刚刚失败的那一次列表或「加载更多」，不重做已经成功的页。HTTP 失败用 `visibleMessage`，`audience: "general"`。

`showScore` 在个人库为 `false`。组件仍接受 `score`，供 Task 10 使用。`showScore` 为真且 `score` 不为 `null` 时，文字是 `相关度 ` 加上 `formatScore(score)`。

图片 `error` 与签名 URL 提前 60 秒刷新放在卡片里：同一张卡片因 `error` 最多再 `getPhoto` 一次；第二次仍失败则显示「图片暂时无法显示」，并保留状态文字。换 `photo.id` 时重置这次计数。过期刷新使用 `thumbUrlExpiresAt` 与 `originalUrlExpiresAt` 里较早的一个减去 60 秒，到点再 `getPhoto` 一次。不要把 URL 写进文字。

- [ ] **Step 4: 运行测试**

Run:

```bash
node --import tsx --test --test-concurrency=1 apps/web/test/library-poll.test.ts
npm run typecheck -w apps/web
```

Expected: 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/photo-card.tsx apps/web/src/pages/library.tsx apps/web/src/App.tsx apps/web/test/library-poll.test.ts
git commit -m "feat: 显示个人库与处理中状态"
```

---

### Task 7: 单文件单片上传

**Files:**
- Create: `apps/web/src/pages/upload-machine.ts`
- Create: `apps/web/src/pages/upload.tsx`
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/test/upload-machine.test.ts`

**Interfaces:**
- Consumes: `api.createUpload`、`api.putPart`、`api.completeUpload`、`api.abortUpload`、`visibleMessage`、`NETWORK_MESSAGE`
- Produces:
  - `contentTypeForFile(type: string, name: string): string | null`
  - `validateFileSize(size: number): { ok: true } | { ok: false; message: "文件大小须为 1 字节到 32 MiB" }`
  - `onCompleting(attemptsLeft: number): { kind: "schedule"; delayMs: 1000; attemptsLeft: number } | { kind: "button" }`
  - `uploadFailure(step: "create" | "part" | "complete" | "abort", failure: { network: boolean; status: number | null; code: string | null; serverMessage: string | null }): UploadAction`

`UploadAction` 只使用这些按钮文案：「重新上传」「重试分片」「继续完成」「重试」。另外三个结果没有按钮：`closed` 的可见句固定「上传已结束」；`cancelled` 固定「已取消上传」；`enter-auto-complete` 的可见句固定「上传正在完成」；`finish-via-complete` 表示再调用一次完成。

- [ ] **Step 1: 写会失败的上传规则测试**

`contentTypeForFile("image/jpeg; charset=binary", "a.txt")` 先去掉参数并小写后得到 `image/jpeg`。`type` 为空时 `.JPEG` 得到 `image/jpeg`，`.cr2` 得到 `image/x-canon-cr2`，`.nef`、`.arw`、`.dng`、`.png`、`.webp`、`.heic`、`.heif` 按设计第 6.3 节的表。两边都不中返回 `null`。

`validateFileSize(0)` 与 `33554433` 失败，`1` 与 `33554432` 通过。

`onCompleting(3)`、`(2)`、`(1)` 都是 `schedule` 且 delay 为 `1000`，剩余次数依次为 2、1、0。`onCompleting(0)` 为 `button`。

`uploadFailure`：

| 步骤 | 输入 | 结果 |
|------|------|------|
| create | 网络失败 | 「重新上传」，从创建开始 |
| create | 500 | 「重新上传」 |
| part | 网络失败或 500 且 `code` 为 `storage_error` | 「重试分片」 |
| part | 409 `upload_completing` | `enter-auto-complete` |
| part | 409 `upload_completed` | `finish-via-complete` |
| part | 409 `upload_closed` 或 404 | 「上传已结束」 |
| complete | 409 `upload_completing` | `enter-auto-complete` |
| complete | 500 且 `serverMessage` 为「上传未能完成」 | 「继续完成」，不新建会话 |
| complete | 网络失败 | 可见句「网络不可用，请重试」，动作为再调用完成，按钮「重试」 |
| complete | 409 `upload_closed` 或 404 | 「上传已结束」 |
| abort | 409 `upload_completing` | `enter-auto-complete`，不得返回「已取消上传」 |
| abort | 409 `upload_completed` | `finish-via-complete` |
| abort | 网络失败或 500 | 按钮「重试」，动作仍是中止，不新建会话 |

完成阶段的「上传未能完成」必须逐字比较，不 trim。完成阶段其它 500（例如 `serverMessage` 为「对象存储不可用」）按钮是「重试」，动作只再调用完成。创建阶段其它 HTTP 也是「重新上传」。分片阶段其它 HTTP 按钮是「重试」，动作是对同一 `upload.id` 再 `PUT` 第 1 片，然后完成。

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
node --import tsx --test --test-concurrency=1 apps/web/test/upload-machine.test.ts
```

Expected: FAIL。退出码非 0。

- [ ] **Step 3: 实现上传页**

文件控件不是 `multiple`，不要求拖放。本地类型或大小不合法时显示「不支持的文件类型」或「文件大小须为 1 字节到 32 MiB」，不发请求。

通过后依次创建、上传第 1 片、完成。步骤文字为「正在创建上传」「正在上传」「正在完成」。不显示百分比、`objectKey`、`etag`。

创建响应里同时留下 `uploadId` 与 `photoId`，只放在组件 state。完成得到 `photo.id` 后 `push` 到 `/photos/` 加这个 id。

自动完成从 `attemptsLeft = 3` 开始，用 `onCompleting`。定时器 1 秒后再调用完成。用尽后显示「继续完成」，只调用完成。`completing` 期间不渲染「取消」。

「取消」只在创建或上传步骤出现。还没有 `uploadId` 时不发中止，回到空表单并显示「已取消上传」。已有 id 时中止正文为 `{}`。中止 204 同样回到空表单并显示「已取消上传」。按 `uploadFailure` 处理 409。

`finish-via-complete` 再调用一次完成。完成响应里有 `photo.id` 就进入详情。若完成响应是 409 `upload_completed` 且没有照片正文，使用创建时保存的 `photoId` 进入 `/photos/<photoId>`。除此之外不要用这个 id 提前跳转。

刷新页面会卸载组件，会话 id 消失。不要把它写进任何存储。

网络失败的可见句使用 `NETWORK_MESSAGE`。其它 HTTP 失败的可见句用 `visibleMessage`，`audience: "general"`，但按钮种类仍由 `uploadFailure` 决定。

- [ ] **Step 4: 运行测试**

Run:

```bash
node --import tsx --test --test-concurrency=1 apps/web/test/upload-machine.test.ts
npm run typecheck -w apps/web
```

Expected: 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/upload-machine.ts apps/web/src/pages/upload.tsx apps/web/src/App.tsx apps/web/test/upload-machine.test.ts
git commit -m "feat: 接通单文件单片上传"
```

---

### Task 8: 详情、元数据、删除与重试

**Files:**
- Create: `apps/web/src/pages/photo-form.ts`
- Create: `apps/web/src/pages/dialog.tsx`
- Create: `apps/web/src/pages/photo.tsx`
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/test/photo-form.test.ts`

**Interfaces:**
- Consumes: `api.getPhoto`、`api.patchPhoto`、`api.deletePhoto`、`api.retryPhoto`、`Photo`、`statusText`
- Produces:
  - `validateDescription`、`validateLocation`、`validateTags`、`validateCoordinatePair`、`takenAtFromLocalInput`
  - `buildPatch(input, original): { ok: true; body: PatchBody; descriptionChanged: boolean; tagsChanged: boolean } | { ok: false; message: string }`
  - `saveNotice(status: string, descriptionChanged: boolean, tagsChanged: boolean): string`
  - `Dialog`，打开时焦点进入，Tab 留在对话框内，Escape 调用 `onClose`

`PatchBody` 恰好六个键：`description`、`tags`、`takenAt`、`locationText`、`latitude`、`longitude`。

- [ ] **Step 1: 写会失败的表单测试**

描述 trim 后为空则 `description: null`。长度 4001 或含 U+0001 时失败，消息「描述不合法」。制表符和换行允许。地点上限 500，消息「地点不合法」。

标签：空白项丢掉；重复项保留第一次；第 33 个失败；含换行失败；消息都是「标签不合法」。

经纬度都空则两个 `null`。只填一个为「经纬度须成对出现」。`91` 或非有限数字为「经纬度超出范围」。`-90` 与 `180` 通过。

`takenAtFromLocalInput("")` 为 `null`。`"not-a-date"` 失败。合法的 `datetime-local` 值等于 `new Date(value).toISOString()`。

`buildPatch` 的正文没有 `status`、`errorCode`、`contentType`、`byteSize`、`id`。描述相对打开页面时的值有变化时 `descriptionChanged` 为真。

`saveNotice("ready", true, false)` 为「已保存。描述或标签变更后会重新嵌入，状态保持已就绪。」`saveNotice("ready", false, false)` 为「已保存」。`saveNotice("processing", true, false)` 为「已保存」。

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
node --import tsx --test --test-concurrency=1 apps/web/test/photo-form.test.ts
```

Expected: FAIL。退出码非 0。

- [ ] **Step 3: 实现详情页**

路由 id 不是 UUID 时不会挂载本页（Task 4 已做成「页面不存在」）。挂载后 `GET /photos/:id`。404 的可见句为「未找到」，不解释是不是别人的照片。

页面顺序：原图、状态、内容类型、字节大小、创建时间，然后是表单。原图规则与卡片相同（替代文本、裂图文案、签名 URL 提前 60 秒、`error` 最多重取一次）。`processing` 时每 5 秒轮询这一张，`document.hidden` 时跳过。卸载时取消这次 GET，不取消会话刷新。

描述是多行文本。标签是逐个添加的芯片，不是逗号语法。拍摄时间是 `datetime-local`，清空则提交 `null`。每个输入都有可见 `<label>`。本地校验失败时不发请求，焦点到错误摘要。

保存成功后用响应替换页面。说明文字用 `saveNotice`。不因为描述变更去轮询，也不要发明任务查询。

只有 `status === "failed"` 时显示「重试」。点击发送 `POST /photos/:id/retry`，正文 `{}`。200 后替换页面；若仍是 `processing` 就恢复轮询。409 且可见句「照片不在失败状态」时只显示这句，不改本地 `status`。

「删除」打开 `Dialog`。正文「删除这张照片？此操作不能撤销。」确认按钮的可见文字是「删除」，取消是「取消」。确认后 `DELETE`。204 则 `replace` 到 `/`。对话框打开时焦点进入，Tab 循环在内部，Escape 等于取消，关闭后焦点回到触发删除的按钮。

状态变化放在 `aria-live="polite"` 里，包括从「处理中」变成「已就绪」或失败文案。

- [ ] **Step 4: 运行测试**

Run:

```bash
node --import tsx --test --test-concurrency=1 apps/web/test/photo-form.test.ts
npm run typecheck -w apps/web
```

Expected: 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/photo-form.ts apps/web/src/pages/dialog.tsx apps/web/src/pages/photo.tsx apps/web/src/App.tsx apps/web/test/photo-form.test.ts
git commit -m "feat: 接通照片详情、修改、删除与重试"
```

---

### Task 9: API Key 与账户

**Files:**
- Create: `apps/web/src/pages/key-form.ts`
- Create: `apps/web/src/pages/keys.tsx`
- Create: `apps/web/src/pages/account.tsx`
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/test/key-form.test.ts`

**Interfaces:**
- Consumes: `api.listKeys`、`api.createKey`、`api.revokeKey`、Task 8 的 `Dialog`、`formatLocalMinute`、`visibleMessage`
- Produces: `validateKeyName(raw: string): { ok: true; name: string } | { ok: false; message: "名称不合法" }`

- [ ] **Step 1: 写会失败的名称测试**

trim 后长度 1–64 通过。空串、65 个字符、含 U+0000 或 U+007F 失败，消息「名称不合法」。通过时返回 trim 后的名称。

源码断言 `keys.tsx`：创建成功后的明文放在只读输入框；关闭路径会把保存明文的 state 设为 `null`；文件中没有 `localStorage` 与 `document.title =`。账户页有到 `/keys` 的链接和「退出」。

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
node --import tsx --test --test-concurrency=1 apps/web/test/key-form.test.ts
```

Expected: FAIL。退出码非 0。

- [ ] **Step 3: 实现两个页面**

进入 `/keys` 后 `GET /api-keys`。加载中显示「正在加载」。空数组显示「还没有 API Key」。列表按接口顺序显示 `name`、`keyPrefix`、`formatLocalMinute(createdAt)`。`lastUsedAt === null` 显示「从未使用」，否则显示本地时间。`revokedAt` 非空显示「已吊销」，并且不渲染「吊销」。未吊销的行点击「吊销」后 `DELETE /api-keys/:id`，204 后重新 `GET` 列表。不拼接假的完整 Key。

创建前用 `validateKeyName`。失败不发请求。201 时把 `secret` 放进 `Dialog` 的只读文本框，说明「关闭后无法再次查看。」按钮「复制」调用 `navigator.clipboard.writeText`。失败时显示「复制失败，请手动选择」，文本框保持可选。关闭、Escape、或离开本页的清理函数里把 `secret` state 设为 `null`。不要写进 URL、`history.state`、`document.title` 或 `console`。

页面上其它请求继续走现有的 `api` 单例，也就是 Access JWT。不要把 `secret` 传给 `api`。

403 用 `visibleMessage` 显示「当前凭证不能执行该操作」。

`/account` 显示 `session.getSnapshot().user.email`、到 `/keys` 的链接，以及「退出」。退出行为沿用 Task 4 外壳里的同一函数，可以把该函数从 `shell.tsx` 抽成 `src/pages/logout.ts` 的 `performLogout(navigate)`，两边都调用它。不要写第二套退出规则。

- [ ] **Step 4: 运行测试**

Run:

```bash
node --import tsx --test --test-concurrency=1 apps/web/test/key-form.test.ts
npm run typecheck -w apps/web
```

Expected: 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/key-form.ts apps/web/src/pages/keys.tsx apps/web/src/pages/account.tsx apps/web/src/pages/logout.ts apps/web/src/shell.tsx apps/web/src/App.tsx apps/web/test/key-form.test.ts
git commit -m "feat: 接通 API Key 与账户页"
```

到这里批次 A 的页面都在。`searchCallsEnabled` 仍是 `false`。按文末「手工验收」第 12.1 节做一遍并记在实现 PR 说明里。不要把阶段改成 `done`，不要勾选 `06-web-ui.md`。

---

### Task 10: 接通搜索

**Files:**
- Modify: `apps/web/src/features.ts`（只把 `searchCallsEnabled` 改为 `true`）
- Modify: `apps/web/src/api.ts`（增加 `searchPhotos`）
- Create: `apps/web/src/pages/search-query.ts`
- Modify: `apps/web/src/pages/search.tsx`
- Modify: `apps/web/test/web-scaffold.test.ts`（开关断言改为搜索为 `true`、共享册仍为 `false`）
- Test: `apps/web/test/search-query.test.ts`
- Test: `apps/web/test/api.test.ts`（补一条 POST 搜索）

**Interfaces:**
- Consumes: `formatScore`、`visibleMessage` 的 `audience: "search"`、`PhotoCard`、`validateTags`、`takenAtFromLocalInput`
- Produces:
  - `planSearchSubmit(enabled: boolean, input: SearchFormInput): SearchPlan`
  - `api.searchPhotos(body: SearchRequestBody): Promise<ApiResult<{ photos: Array<Photo & { score: number | null }>; nextCursor: string | null }>>`

`SearchPlan` 为 `{ type: "disabled" }`、`{ type: "error"; message: "查询为空" | "查询过长" | "标签不合法" | "拍摄时间不合法" | "时间范围不合法" }` 或 `{ type: "send"; body: SearchRequestBody }`。

`SearchRequestBody` 只有 `mode`（`keyword` 或 `semantic`）、`q`、`limit`（字面量 20），以及可选的 `tags`、`takenFrom`、`takenTo`、`cursor`。没有 `status`、`offset`、`topK`、`albumId`。

- [ ] **Step 1: 写会失败的搜索测试**

`planSearchSubmit(false, 任意输入)` 为 `disabled`，即使查询为空。

`enabled` 为真时：trim 后空串是「查询为空」；501 个码元是「查询过长」；500 个 `a` 通过；`"🙂".repeat(251)` 的长度是 502，失败。开始时间晚于结束时间是「时间范围不合法」，相等通过。没有标签时正文没有 `tags`。没有的那一端时间不出现在正文里。`cursor` 只在调用方传入非空字符串时出现。

`api.searchPhotos` 发 `POST /api/photos/search`，没有查询字符串，带 Bearer。解析要求每条都有 `score`，值为 `null` 或有限数字。数字 `1` 保持为 `1`，不要 `toFixed`。

源码断言：

- `features.ts` 含 `searchCallsEnabled = true` 与 `albumCallsEnabled = false`。
- `api.ts` 含 `"/photos/search"`，且该文件没有 `` method: "GET" `` 与 `photos/search` 组合而成的 GET。搜索方法的 `method` 是 `POST`。
- `api.ts` 不含 `album`。
- `search.tsx` 在发送前调用 `planSearchSubmit`。常量仍会被读到；因为常量已是 `true`，单测直接调用 `planSearchSubmit(false, ...)` 保住关闭分支。

更新 `web-scaffold.test.ts` 里「两个开关都是 false」那条，改成搜索为 `true`、共享册为 `false`。不要放宽对 `import.meta.env` 和 `localStorage` 的禁止。

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
node --import tsx --test --test-concurrency=1 apps/web/test/search-query.test.ts apps/web/test/web-scaffold.test.ts
```

Expected: FAIL。开关仍是 `false`，或 `planSearchSubmit` 不存在。退出码非 0。

- [ ] **Step 3: 接通搜索页**

把 `searchCallsEnabled` 改为 `true`。不要改 `albumCallsEnabled`。

`searchPhotos` 使用 Task 3 的同一套 401 重试和错误外壳。不要新增 `GET` 方法。

搜索页保留 Task 4 的三句说明和默认「关键词」。提交时先 `planSearchSubmit(searchCallsEnabled, input)`。`disabled` 显示「检索接口尚未就绪」并且不调用 `api`。`error` 显示该句并且不调用 `api`。`send` 才 `POST`。

结果用 `PhotoCard`，`showScore` 仅当 `mode === "semantic"`。`score === null` 时卡片不显示相关度。`status !== "ready"` 的元素不渲染，也不要改去请求 `GET /photos` 做替补。空数组显示「没有匹配的照片」，这是成功，不是错误。

「加载更多」把上一页 `nextCursor` 放进 JSON 的 `cursor`，并带上当前表单的 `mode`、`q` 和过滤器。游标不放进 URL。用户改变模式、查询或过滤器后再次提交时传 `cursor: null`。

503、502 和其它 HTTP 都走 `visibleMessage`，`audience: "search"`。查询文字留在输入框里。不展示向量或上游正文。

网络失败显示「网络不可用，请重试」，按钮只重发刚刚那一次搜索。

不要把阶段改为 `done`。不要勾选验收。`albumCallsEnabled` 保持 `false`。

- [ ] **Step 4: 运行测试**

Run:

```bash
node --import tsx --test --test-concurrency=1 apps/web/test/search-query.test.ts apps/web/test/api.test.ts apps/web/test/copy.test.ts apps/web/test/web-scaffold.test.ts
npm run typecheck -w apps/web
npm test
```

Expected: 网页单测与 `typecheck` 退出码 0。`npm test` 仍先打印分层检查通过，再跑 API 测试，`# fail 0`。API 测试不需要为了本任务修改。若工作区里没有数据库，不要为了本任务去改 API 测试；把网页命令的结果记在实现说明里，并在有 `DATABASE_URL` 的环境补跑 `npm test`。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features.ts apps/web/src/api.ts apps/web/src/pages/search-query.ts apps/web/src/pages/search.tsx apps/web/test/search-query.test.ts apps/web/test/api.test.ts apps/web/test/web-scaffold.test.ts
git commit -m "feat: 接通个人库搜索页面"
```

然后按第 12.2 节做手工验收。相关度必须看见 `1`，不是 `1.000000`。

---

## 手工验收

自动化单测不代替本节。每一批的实现 PR 说明里贴执行记录，列步骤编号、通过或失败、失败时的可见文案和 HTTP 状态。没有记录的批次不算通过。不要把结果写进 `06-web-ui.md` 的勾选框。

共同前提：

```bash
docker compose up -d
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
```

按仓库已有方式准备对象存储环境变量。`NODE_ENV` 不要设为 `production`，这样未配置真实嵌入时走现有假嵌入。三个进程分开开：

```bash
npm run dev:api
npm run dev:web
npm run worker -w apps/api
```

浏览器打开 `http://127.0.0.1:43123`。另开一个隐私窗口留给以后的批次 C。桌面宽度 1280，窄屏宽度 375。curl 直接打 API `http://127.0.0.1:3000`，不要加 `/api` 前缀，也不要在浏览器里改用 API Key。

### 12.1 批次 A

在 Task 9 完成、Task 10 尚未把搜索开关打开时执行。两个常量都是 `false`。

1. 未登录打开 `/`。看到登录页。正文没有 `Phase 0 · 脚手架`，也没有「尚未开始」。
2. 注册一个新邮箱。进入个人库，看到「还没有照片」。
3. 退出后用错误密码登录，看到「邮箱或密码错误」。再用正确密码登录，进入个人库。
4. 刷新浏览器。回到登录页。`localStorage`、`sessionStorage` 和控制台输出都没有 Access JWT、Refresh Token、`oalr_` 或 `oalb_`。
5. 重新登录。上传一张小于 32 MiB 的 JPEG。依次看到「正在创建上传」「正在上传」「正在完成」，并进入详情。worker 完成前看得到「处理中」。
6. 停留在详情。假视觉配置下最终描述是「未配置视觉模型」。通过标准是状态变为「已就绪」，并且缩略图或原图可见。若变为失败文案，页面上必须有「重试」；这一结果记为失败，不用它代替「已就绪」。
7. 把描述改为 `海边灯塔验收` 并保存。看到「已保存。描述或标签变更后会重新嵌入，状态保持已就绪。」状态仍是「已就绪」。这张照片留到批次 B，不删除。
8. 再上传一张小的 PNG，在详情里删除。对话框出现「删除这张照片？此操作不能撤销。」确认后回到个人库，PNG 不见，JPEG 还在。
9. 打开 API Key 页，创建名称 `验收 Agent`。对话框里的明文以 `oalb_` 开头。把它记在终端里，不要记进网页。关闭对话框后再进入此页，明文不再出现。列表有前缀，没有完整秘密。先不要吊销。
10. 用记下来的 Key 在终端调用下面四步。完成响应里有照片，`PATCH` 为 200。然后回到网页吊销这枚 Key，该行显示「已吊销」。

```bash
curl -sS -D - http://127.0.0.1:3000/photos/uploads \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"contentType\":\"image/jpeg\",\"byteSize\":$BYTES}"
curl -sS -D - -X PUT "http://127.0.0.1:3000/photos/uploads/$UPLOAD_ID/parts/1" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@$FILE"
curl -sS -D - -X POST "http://127.0.0.1:3000/photos/uploads/$UPLOAD_ID/complete" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
curl -sS -D - -X PATCH "http://127.0.0.1:3000/photos/$PHOTO_ID" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"description":"key 验收"}'
```

11. 在 1280 与 375 各走一遍登录、个人库、上传入口和一张照片的详情。375 下底部五项可见，这四个页面没有横向滚动条。1280 下是顶部导航，没有底部导航。
12. 打开搜索页并提交。看到「检索接口尚未就绪」。网络面板没有 `/api/photos/search`。
13. 打开共享册列表、创建页和 `/join/demo` 并提交。看到「共享册接口尚未接通。」网络面板没有路径中含 `album` 的请求。

第 10 步的 Key 已经被吊销。批次 B 若要测 Key 搜索，再创建一枚，用完再吊销。

### 12.2 批次 B

Task 10 之后执行。`searchCallsEnabled` 为 `true`，`albumCallsEnabled` 仍为 `false`。批次 A 留下的描述 `海边灯塔验收` 必须已经是 `ready`。worker 要在跑。

1. 关键词查询 `灯塔`。结果里有这张照片，没有相关度数字。
2. 关键词查询 `红 船`。这张照片不在结果里。空结果的文案是「没有匹配的照片」。
3. 查询框只输入空格后提交。看到「查询为空」。网络面板没有新的搜索请求。
4. 自然语言查询的文本就是 `海边灯塔验收`。没有标签时，嵌入文本就是这句描述。结果里有这张照片，相关度为 `1`。不要改用另一句来要求分数为 `1`。网页不为重新嵌入自动轮询。人工等待上限 3 分钟：相关度还不是 `1` 时，每隔 5 秒再提交一次。超过 3 分钟仍不是 `1`，这一步失败。
5. 再上传一张新照片，确认详情是「处理中」并记下 `id`。用关键词 `灯塔` 搜索。结果里有第 1 步那张，没有这个仍在处理中的 `id`。个人库里仍看得到「处理中」。
6. 新建一枚 API Key。用 curl 发两次 `POST /photos/search`，不要发 GET：

```bash
curl -sS -D - http://127.0.0.1:3000/photos/search \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"mode":"keyword","q":"灯塔","limit":20}'
curl -sS -D - http://127.0.0.1:3000/photos/search \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"mode":"semantic","q":"海边灯塔验收","limit":20}'
```

两次响应都包含那张照片的 id。然后在网页上吊销这枚 Key。

7. 在 1280 与 375 各提交一次关键词搜索。两种宽度都没有横向滚动条，结果可以点进详情。

### 12.3 批次 C

本节不是任务。现在不能执行，也不能把失败记成网页缺陷后自行补接口。

阻塞：等 Phase 5 设计文件出现在默认分支，并且 `specs/phases/05-shared-albums.md` 为 `done`。在那之前 `albumCallsEnabled` 保持 `false`。接通时只允许调用那份设计写明的方法与路径；没写的控件不渲染，也不要在 `apps/api` 加隐藏路由。若某条可见结果依赖的写操作不在 Phase 5 设计里，把该条记为阻塞，阶段保持 `in_progress`。

将来可以执行的步骤，原文留在设计第 12.3 节：创建册与不含口令的 `/join/` 链接、错误口令不显示「不存在」或册标题、正确口令进入、只读与可上传与册主的控件差异、照片同时出现在册内和上传者个人库、过期或只读锁后可上传角色失去添加与上传、1280 与 375 都没有横向滚动条。口令失败的可见句在接通前不要改成两种会泄露册是否存在的句子。

批次 A 与 B 都有通过记录之后，仍然不要把阶段标成 `done`，不要勾选验收。三条记录齐了才允许另一次提交去改 `specs/phases/06-web-ui.md` 与 `specs/SPEC.md`。

---

## 范围外

- 原生 App、小程序，以及 `apps/web` 以外的客户端
- 新的后端路由、字段、Cookie、CORS、限流
- 修改 `apps/api` 与 `deploy/**`（实现期的 Task 1 只改两处阶段状态，除此之外规格文件也不要顺手改写）
- 品牌、标志、插画、暗色模式、国际化、管理后台
- 评论、点赞、人脸、地图、以图搜图、共享册内搜索
- 用 `GET /photos` 在浏览器里过滤来冒充搜索
- 记住我、多文件、拖放、预签名直传、百分比、无限滚动、不规则瀑布流
- 邮箱验证、找回密码、修改密码、验证码、Service Worker
- Playwright 或任何网页测试框架
- 把 Refresh Token 放进 `Authorization`，或并发两次 `POST /auth/refresh`
- 在界面或日志里展示令牌、口令、API Key 明文、签名 URL 和 `objectKey`

产品设计第 9 节的新加坡 HTTPS 部署不属于本计划。

---

## 自检（计划作者已完成，实现时不要重做这一节）

实现代理跳过本节。

| 设计 | 落点 | 结论 |
|------|------|------|
| §2 History API、`40rem`、等宽网格 | Task 4 | 已覆盖 |
| §2 / §5 令牌只在内存，刷新单飞，整页刷新重新登录 | Task 2、Task 5 的手工第 4 步 | 已覆盖 |
| §2 / §6.3 单文件单片，同页可重试，刷新不续传 | Task 7 | 已覆盖 |
| §2 / §6.5 / §8 `POST /photos/search`，不调用 GET | Task 10。Task 3 明确还不提供该方法 | 已覆盖 |
| §6.5 `score` 与 JSON 数字一致 | Task 1 `formatScore`；Task 10 展示 | 已覆盖 |
| §6.6 明文只出现一次 | Task 9 | 已覆盖 |
| §2 / §8 同源 `/api`，不新增 CORS，不读 `PUBLIC_BASE_URL` | Task 1 代理；Task 3 客户端 | 已覆盖 |
| §7 搜索 validation 四句分开 | Task 1 `visibleMessage` | 已覆盖 |
| §6.1–§6.4 登录、个人库、上传、详情 | Task 5–8 | 已覆盖 |
| §6.7 账户 | Task 9 | 已覆盖 |
| §6.8 常量关闭时的静态共享册 | Task 4。没有接通 HTTP 的任务 | 已覆盖 |
| §9 无障碍与 375 / 1280 | Task 4 的 CSS；手工脚本写明两种宽度 | 已覆盖 |
| §11 文件划分与依赖限制 | File Structure；Task 1 依赖测试 | 已覆盖 |
| §12.1 批次 A | Task 9 结束时执行 | 已覆盖 |
| §12.2 批次 B | Task 10 | 已覆盖，Phase 4 已是 `done` |
| §12.3 批次 C | 「批次 C」阻塞，无 Task | 不在本计划实施 |
| §13 阶段验收勾选 | 没有任何任务去勾 | 保持未勾，直到 C 也有通过记录 |
| §14 明确不做 | Global Constraints 与「范围外」 | 已覆盖 |
| 子代理使用 grok-4.7 high，不用 fast | Global Constraints 与执行交接 | 已覆盖 |

占位符扫描：任务步骤里的函数名在产出它们的任务中写了签名和规则。`searchCallsEnabled` 只在 Task 10 变为 `true`。`albumCallsEnabled` 没有任何任务改为 `true`。`formatScore` 不调用 `toFixed`。搜索客户端没有 GET。

## 执行交接

计划保存在 `docs/superpowers/plans/2026-11-10-openalbum-phase6-web-ui.md`。实现时二选一：

1. **Subagent-Driven（推荐）**：每个任务一个新的子代理，任务之间做审查。子代理使用 grok-4.7 high，不用 fast 模式。所需技能是 `superpowers:subagent-driven-development`。
2. **Inline Execution**：在同一会话里按 `superpowers:executing-plans` 批量执行，并在检查点停下来审查。

写这份计划的提交不实现网页代码，也不把阶段改成 `in_progress` 或 `done`。
