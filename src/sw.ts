/**
 * Service Worker（网页版 / `injectManifest`）。
 *
 * 这个文件是**手工 SW**，不是 `generateSW` 生成的：网页版 HTML 页面需要在
 * `/__page/<token>` 上返回一个**自带 CSP** 的响应，而 `generateSW` 的
 * `runtimeCaching` 只能选内置策略（CacheFirst / NetworkFirst…），没法合成响应。
 *
 * 它做两件事：
 *   1. 正常的离线预缓存（原来 `vite.config.ts` 里那段 `workbox` 配置搬到这里，规则逐条保留）；
 *   2. `/__page/<token>` 路由：把页面侧 stage 进来的 HTML 用**独立 CSP** 返回。
 *
 * ⚠️ 页面内容只活在这个 worker 的**内存**里：不写 Cache Storage、不落 IndexedDB。
 * 一旦 worker 被系统回收，页面下次打开会重新 stage 一遍 —— 这是有意的，
 * 「笔记正文不出现在缓存里」比「省一次 stage」重要。
 */

import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { CacheFirst, StaleWhileRevalidate } from "workbox-strategies";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

/** 与 `src/lib/pageStage.ts` 的常量**必须**逐字一致。 */
const PAGE_STAGE_MESSAGE = "opennote:page:stage";
const PAGE_ROUTE_PREFIX = "/__page/";

/**
 * 页面的独立 CSP —— 与桌面端 `electron/pageProtocol.cjs` 的 `PAGE_CSP` 同一套语义。
 *
 * 差异只有一处、且有理由：`frame-ancestors` 这里写 `'self'`。桌面端写成
 * `file:` 是因为主窗口是 `file://`；网页版主页面与这条路由**同源**，
 * `'self'` 才是正确且更窄的写法。
 */
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data: blob:",
  "media-src data: blob:",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

/**
 * stage 进来的页面内容（token → HTML）。
 *
 * 上限 20 条：一个用户同时打开的标签远少于这个数；超出时按插入顺序丢最老的，
 * 于是 leak 也不会无限增长。
 */
const stagedPages = new Map<string, string>();
const MAX_STAGED_PAGES = 20;

function rememberPage(token: string, html: string): void {
  stagedPages.set(token, html);
  while (stagedPages.size > MAX_STAGED_PAGES) {
    const oldest = stagedPages.keys().next();
    if (oldest.done) break;
    stagedPages.delete(oldest.value);
  }
}

/* ---------------------------------------------------------------- 安装 / 激活 */

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

self.addEventListener("install", (event) => {
  // 立刻进入 waiting → activate，页面侧不用等一次刷新才拿到 controller。
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  // 接管已经打开的页面。没有这一句，首次安装后当前页面一直没有 controller，
  // stage 消息发出去**没人收**（症状是「页面模式一直说没准备好」）。
  event.waitUntil(self.clients.claim());
});

/* ------------------------------------------------------------------- 消息 */

self.addEventListener("message", (event) => {
  const data = event.data as { type?: string; token?: string; html?: string | null } | null;
  if (!data || data.type !== PAGE_STAGE_MESSAGE) return;
  const token = typeof data.token === "string" ? data.token : "";
  if (!token) return;
  const reply = (ok: boolean, reason?: string) => {
    try {
      event.source?.postMessage({ type: PAGE_STAGE_MESSAGE, token, ok, ...(reason ? { reason } : {}) });
    } catch {
      /* 页面已经关掉了：没有回执也无所谓 */
    }
  };
  // `html: null` = 释放这条：页面关掉 / 切标签时调用。
  if (data.html === null) {
    stagedPages.delete(token);
    reply(true);
    return;
  }
  if (typeof data.html !== "string") {
    reply(false, "页面内容格式不对");
    return;
  }
  rememberPage(token, data.html);
  reply(true);
});

/* ------------------------------------------------------------------- 路由 */

/** 从请求 URL 里取 `/__page/` 后面的 token（不在这个前缀下返回 null）。 */
function tokenOf(url: URL): string | null {
  const base = self.registration.scope;
  const index = url.pathname.indexOf(PAGE_ROUTE_PREFIX);
  if (index < 0) return null;
  // 路径必须在 scope 之内：子路径部署（`VITE_BASE=/opennote/`）时，前缀对但 scope 外的一律不服务。
  if (!url.href.startsWith(base) && !url.pathname.startsWith(new URL(base).pathname)) return null;
  const raw = url.pathname.slice(index + PAGE_ROUTE_PREFIX.length);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.includes(PAGE_ROUTE_PREFIX)) return;
  const token = tokenOf(url);
  event.respondWith(
    (async () => {
      if (!token) {
        return new Response("页面地址不完整", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      const html = stagedPages.get(token);
      if (html === undefined) {
        // 没 stage 过 / 已被释放 / worker 被回收过：404 而不是「随便给点什么」。
        return new Response("页面内容已失效，请重新打开这个标签", {
          status: 404,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      return new Response(html, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": PAGE_CSP,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    })(),
  );
});

/* ------------------------------------------------- 离线缓存（原 vite 配置搬来） */

registerRoute(
  /\/assets\/(?:lazy\/)?(?:mermaid|katex)[\w.-]*\.js$/,
  new StaleWhileRevalidate({
    cacheName: "opennote-on-demand",
    plugins: [],
  }),
);

registerRoute(
  /\/assets\/lazy\/[\w.-]+\.js$/,
  new CacheFirst({ cacheName: "opennote-languages" }),
);

registerRoute(/\.(?:woff2?|ttf)$/, new CacheFirst({ cacheName: "opennote-fonts" }));
