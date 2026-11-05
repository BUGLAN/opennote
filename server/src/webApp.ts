/**
 * 同步服务器在 `/` 下托管网页版（issue #1，`app.ts` 模块头「一个 hostname 的四个面」第一行）。
 *
 * ## 为什么由同步服务器托管，而不是放开跨域
 *
 * 网页版与 `/v1/*` 同源后：服务端**不用发任何 CORS 头**，网页版的 CSP `connect-src` 也
 * **不用放开任何 https**（`'self'` 就够）。放开跨域则要给自托管用户的任意域名开口子，
 * 网页版只能把 `connect-src` 放宽到所有 `https:`，安全上差一截。
 *
 * ## 不碰的路径
 *
 * `/v1`、`/admin`、`/panel`、`/join`、`/reset`、`/auth` 这几个前缀**永远不**由这里回答，
 * 哪怕它们 404 —— 那样 API 的 404 仍是 `{error, code}` JSON，而不是一份 `index.html`。
 *
 * ## 目录
 *
 * `WEB_ROOT` 环境变量 > 与入口同层的 `web/`（产物里是 `server/dist/web/`，见
 * `scripts/build-server.mjs --with-web` 与 Dockerfile 的 `web` 阶段）。目录里没有 `index.html`
 * 就不托管（行为与以前一样：`/` 返回 404），启动日志如实说一声。
 *
 * ## 安全
 *
 * - 路径先解码、再 `resolve`，必须仍落在根目录之内（挡 `..` 与编码过的 `%2e%2e`）；
 *   以 `.` 开头的路径段一律不发（`.DS_Store`、`.git` 之类不该出现在产物里，出现了也不发）。
 * - 网页版自己用 `<meta>` 带着严格的 CSP（`vite.config.ts` 的 `contentSecurityPolicyPlugin`），
 *   这里只补一条 meta 里写不了的 `frame-ancestors 'self'`。
 * - `x-frame-options` 用 `SAMEORIGIN` 而不是全局的 `DENY`：网页版把 HTML 页面渲染在**同源**的
 *   `html-sandbox.html` 子框架里（`src/html/sandbox.ts`），`DENY` 会把它拦掉。
 */

import { existsSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type Context } from "hono";

/** 这些前缀属于 API / 控制台 / 公开页，网页版的回落绝不能盖住它们。 */
const RESERVED = /^\/(?:v1|admin|panel|join|reset|auth)(?:\/|$)/;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

/** 网页版产物默认所在：与入口同层的 `web/`（产物 `server/dist/web/`）。 */
function defaultWebRoot(): string {
  return fileURLToPath(new URL("./web/", import.meta.url));
}

/**
 * 决定托管哪个目录；没有可托管的产物就返回 null。
 *
 * `explicit`：`null` = 明确关掉（测试用），`undefined` = 按 `WEB_ROOT` / 默认目录找。
 */
export function resolveWebRoot(explicit: string | null | undefined, env: Record<string, string | undefined> = process.env): string | null {
  if (explicit === null) return null;
  const candidate = resolve(explicit ?? (env.WEB_ROOT?.trim() || defaultWebRoot()));
  try {
    return statSync(resolve(candidate, "index.html")).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

/** 只有不带扩展名的路径才回落到 `index.html`（`/settings` 是页面，`/foo.js` 不存在就该 404）。 */
function isPageLike(pathname: string): boolean {
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return last === "" || !last.includes(".");
}

/**
 * 把 URL 路径映射到根目录里的文件；越界 / 隐藏文件 / 非法编码返回 null。
 */
function fileFor(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  if (decoded.split("/").some((segment) => segment.startsWith("."))) return null;
  const target = resolve(root, `.${decoded.endsWith("/") ? `${decoded}index.html` : decoded}`);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

async function isFile(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : null;
  } catch {
    return null;
  }
}

/**
 * 缓存策略：`assets/` 下是带内容哈希的文件，可以永久缓存；其余（`index.html`、`sw.js`、
 * manifest、图标）跟着部署变，每次都向服务器确认（带 ETag，没变就 304）。
 */
function cacheControlFor(relativePath: string): string {
  return relativePath.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
}

async function serveFile(c: Context, root: string, path: string, info: { size: number; mtimeMs: number }): Promise<Response> {
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const relative = path.slice(root.length).split(sep).join("/");
  const contentType = CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
  const headers: Record<string, string> = {
    "content-type": contentType,
    "cache-control": cacheControlFor(relative),
    etag,
    // 全局默认是 DENY；网页版要能嵌自己的同源沙箱页（见模块头「安全」）。
    "x-frame-options": "SAMEORIGIN",
  };
  if (contentType.startsWith("text/html")) headers["content-security-policy"] = "frame-ancestors 'self'";
  if (c.req.header("if-none-match") === etag) return new Response(null, { status: 304, headers });
  const body = c.req.method === "HEAD" ? null : await readFile(path);
  return new Response(body, { status: 200, headers: { ...headers, "content-length": String(info.size) } });
}

/**
 * 网页版路由：静态文件 + SPA 回落。挂在所有其它路由**之后**。
 */
export function createWebAppRoutes(root: string): Hono {
  const routes = new Hono();
  const handler = async (c: Context): Promise<Response> => {
    const pathname = c.req.path;
    if (RESERVED.test(pathname)) return c.notFound();

    const path = fileFor(root, pathname);
    if (path) {
      const info = await isFile(path);
      if (info) return serveFile(c, root, path, info);
    }
    if (!isPageLike(pathname)) return c.notFound();

    const index = resolve(root, "index.html");
    const info = await isFile(index);
    return info ? serveFile(c, root, index, info) : c.notFound();
  };
  routes.get("*", handler);
  return routes;
}

/** 启动日志用：一句话说明网页版有没有托管。 */
export function describeWebRoot(root: string | null): string {
  if (root) return `网页版：托管 ${root}`;
  return existsSync(defaultWebRoot())
    ? `网页版：未托管（${defaultWebRoot()} 里没有 index.html）`
    : "网页版：未托管（没有网页版产物；见 scripts/build-server.mjs --with-web 或设 WEB_ROOT）";
}
