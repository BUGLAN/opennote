/**
 * HTML 页面的沙箱渲染协议（应用 ⇄ `public/html-sandbox.html`）。
 *
 * ## 为什么不是 `<iframe srcdoc>`
 *
 * `srcdoc` / `blob:` / `data:` 文档会**继承父页面的 CSP**。应用自己的策略（网页版
 * `vite.config.ts` 的 meta、桌面版 `electron/main.cjs` 的 `cspPolicy()`）不放行内联脚本，
 * 于是页面里的 JS 一行都跑不起来。而为了 HTML 页面给应用放开 `'unsafe-inline'`，等于拆掉
 * 整个应用的 XSS 防线。
 *
 * 所以页面渲染在一个**独立加载的宿主页**里：`html-sandbox.html` 是随包分发的静态文件，
 * 作为普通导航加载（不继承父 CSP），自带一份**只给页面内容用**的宽松策略
 * （`HTML_SANDBOX_CSP`）。父页面经 `postMessage` 把整篇文档交给它，它 `document.write` 进去。
 *
 * ## 隔离靠什么
 *
 * - `<iframe sandbox="allow-scripts">`：**没有** `allow-same-origin`，
 *   页面是不透明源 —— 读不到应用的 localStorage / IndexedDB / Cookie，碰不到父页面 DOM，
 *   桌面版的 preload 桥只注入主框架，页面里不存在 `window.opennote`；
 * - 没有 `allow-top-navigation`：页面不能把整个应用导航走；
 * - 没有 `allow-forms` + CSP `form-action 'none'`：表单提交不出去；
 * - CSP `connect-src` 不放行任何远端：`fetch` / XHR / WebSocket 发不出去；
 * - 外链：注入的点击拦截脚本把 `http(s)` / `mailto` 链接交给父页面，父页面只在
 *   **真实用户点击**（`navigator.userActivation`）时才打开 —— 页面脚本自己不能弹窗。
 *
 * 这份策略的**唯一产地**是本文件的 `HTML_SANDBOX_CSP`；`public/html-sandbox.html` 的 meta
 * 与 `electron/main.cjs` 的 `HTML_SANDBOX_CSP` 是副本，由 `sandbox.test.ts` 逐字钉住。
 */

/** 宿主页文件名（`public/` 下，构建后在产物根目录）。 */
export const HTML_SANDBOX_PAGE = "html-sandbox.html";

/** iframe 的 sandbox 令牌：**绝不能**出现 `allow-same-origin` / `allow-top-navigation`。 */
export const HTML_SANDBOX_FLAGS = "allow-scripts";

/**
 * 页面内容的 CSP。允许：内联与 `data:` / `blob:` 脚本样式（内联后的资源全是这种形态）、
 * 经 https 加载的脚本/样式/图片/字体/音视频（AI 生成的页面大量用 CDN 上的图表库与字体）。
 * 不允许：任何 `connect-src` 远端、嵌套框架、插件、表单提交。
 */
export const HTML_SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' data: blob: https:",
  "style-src 'unsafe-inline' data: blob: https:",
  "img-src data: blob: https:",
  "font-src data: blob: https:",
  "media-src data: blob: https:",
  "connect-src data: blob:",
  "worker-src data: blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
].join("; ");

/** 宿主页 → 父页面：宿主脚本已就绪，可以发文档了。 */
export const MSG_READY = "opennote:html:ready";
/** 父页面 → 宿主页：渲染这篇文档（`{ type, html }`）。 */
export const MSG_RENDER = "opennote:html:render";
/** 页面 → 父页面：用户点了一个外链（`{ type, url }`）。 */
export const MSG_OPEN = "opennote:html:open";

/**
 * 页面里的点击拦截（运行在沙箱里）：
 * - `#锚点` 放行（页内跳转）；
 * - `http(s)` / `mailto` → 交给父页面打开（沙箱没有 `allow-popups`，页面自己开不了）；
 * - 其余（相对链接、`javascript:`、`file:` …）一律拦下：沙箱里没有「下一页」可去，
 *   放行只会把框架导航到一个空白/报错页，用户回不来。
 * 冒泡阶段注册：页面自己的点击处理先跑，它 `preventDefault()` 过的我们不再插手。
 */
const LINK_GUARD = `(function(){document.addEventListener("click",function(e){if(e.defaultPrevented)return;var t=e.target;var a=t&&t.closest?t.closest("a[href]"):null;if(!a)return;var h=a.getAttribute("href")||"";if(h.charAt(0)==="#")return;e.preventDefault();if(/^(https?:|mailto:)/i.test(h))parent.postMessage({type:${JSON.stringify(MSG_OPEN)},url:a.href},"*");},false);})();`;

/**
 * 交给宿主页之前的最后一步：在文档最前面（`<head>` 里，没有就在 doctype/`<html>` 之后）
 * 注入 CSP meta 与点击拦截脚本。**只在渲染时注入，不写回文件**。
 *
 * CSP 在宿主页上已经有一份；这里再注入一次是兜底：`document.open()` 之后策略是否保留，
 * 各引擎的历史行为并不一致，而 parser 读到 `<head>` 里的 CSP meta 一定生效。
 */
export function prepareSandboxDocument(html: string): string {
  const inject = `<meta http-equiv="Content-Security-Policy" content="${HTML_SANDBOX_CSP}"><meta name="referrer" content="no-referrer"><script>${LINK_GUARD}</script>`;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) return insertAt(html, head.index + head[0].length, inject);
  const root = /<html\b[^>]*>/i.exec(html);
  if (root) return insertAt(html, root.index + root[0].length, `<head>${inject}</head>`);
  // 没有 `<html>`：放在 doctype 之后（doctype 必须是第一个记号，否则会掉进怪异模式）；
  // 没有 doctype 的页面原本就是怪异模式，前置不改变这一点。
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return insertAt(html, doctype[0].length, inject);
  return inject + html;
}

function insertAt(text: string, index: number, insert: string): string {
  return text.slice(0, index) + insert + text.slice(index);
}

/** 宿主页的绝对 URL：随 `base`（网页版子路径 / 桌面版 `./`）走，开发与打包同一条规则。 */
export function htmlSandboxUrl(): string {
  return new URL(`${import.meta.env.BASE_URL}${HTML_SANDBOX_PAGE}`, window.location.href).href;
}

/** 外链放行判据：只开 `http(s)` 与 `mailto`。 */
export function isOpenableUrl(url: unknown): url is string {
  return typeof url === "string" && /^(https?:|mailto:)/i.test(url) && url.length <= 4096;
}
