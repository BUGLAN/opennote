/**
 * 公开分享的只读网页（`GET /s/:id`）—— 服务端渲染的一整页 HTML。
 *
 * ## 样子
 *
 * 不另起视觉风格：页面用控制台那几张样式表（`/panel/tokens.css`、`console.css`，即客户端
 * `src/styles/tokens.css` 的副本与控制台组件），正文用 `/panel/prose.css` —— 那是客户端
 * `src/styles/prose.css` 的**原样副本**，所以一篇笔记在这里和在应用的阅读视图里排版一致。
 * 只有页面骨架（顶栏、正文列、页脚）在 `share.css` 里，全部取自既有令牌。
 *
 * ## 安全
 *
 * - 这一页与 `/v1/*`、控制台、网页版**同源**，所以它绝不能执行快照里的任何东西：
 *   Markdown 用 `html: false` 渲染（原文里的 HTML 标签按文字显示），其它字符串一律转义；
 *   CSP 只放行同源脚本（`theme.js` / `share.js`）与样式，没有 `unsafe-inline`。
 * - HTML 文件不在这一页里展开，而是放进 `<iframe sandbox>` 指向 `/s/<id>/raw`，
 *   那个响应自己带 `sandbox` CSP（不透明源，碰不到本站的存储与 cookie）。
 */

import MarkdownIt from "markdown-it";
import { formatBytes } from "./activity";
import { extensionOf, type ShareRow } from "./shares";

/** 这一页的 CSP：与控制台同一套，额外放行快照里的图片（data: / https:）与同源的 HTML 预览框。 */
export const SHARE_PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https:",
  "media-src 'self'",
  "frame-src 'self'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * `/s/<id>/raw` 的 CSP：与应用里渲染 HTML 页面的沙箱（`public/html-sandbox.html`）同一套放行，
 * 再加一条 `sandbox` —— 浏览器把它当成不透明源，脚本能跑（HTML 页面要它），但拿不到本站的
 * localStorage / cookie，也发不出带凭据的同源请求。对图片、文本等其它类型同样无害。
 */
export const SHARE_RAW_CSP = [
  "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox",
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
  "frame-ancestors 'self'",
].join("; ");

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });

/* 外链：新窗口打开，且不把这条公开链接（它本身就是访问凭据）当 Referer 带出去。 */
const defaultLinkOpen =
  markdown.renderer.rules.link_open ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index]!;
  const href = String(token.attrGet("href") ?? "");
  if (/^https?:/i.test(href)) {
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noopener noreferrer nofollow");
  }
  return defaultLinkOpen(tokens, index, options, env, self);
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

const MARKDOWN = new Set(["md", "markdown"]);
const TEXT = new Set(["txt", "csv", "log", "json"]);
const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"]);
const HTML = new Set(["html", "htm"]);

/** 文件名去掉扩展名（页面大标题用；与客户端「标题就是文件名」一致）。 */
export function titleOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** 字节 → 文本；不是合法 UTF-8 时返回 null（按二进制处理）。 */
function decodeText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ 各类型的正文 */

/** JSON Canvas（`.canvas`）：按位置从上到下、从左到右列出卡片（这一页不画画布）。 */
function renderCanvas(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const nodes = (parsed as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return null;
  type Node = { type?: unknown; text?: unknown; file?: unknown; url?: unknown; label?: unknown; x?: unknown; y?: unknown };
  const sorted = (nodes as Node[])
    .filter((node) => node && typeof node === "object" && node.type !== "group")
    .sort((a, b) => Number(a.y ?? 0) - Number(b.y ?? 0) || Number(a.x ?? 0) - Number(b.x ?? 0));
  const groups = (nodes as Node[]).filter((node) => node && node.type === "group" && typeof node.label === "string");
  const cards = sorted.map((node) => {
    if (node.type === "text" && typeof node.text === "string") {
      return `<li class="share-card prose">${markdown.render(node.text)}</li>`;
    }
    if (node.type === "file" && typeof node.file === "string") {
      return `<li class="share-card share-card--ref"><span class="muted">引用的文件</span> <span class="mono break">${escapeHtml(node.file)}</span><span class="hint">（不在这份快照里）</span></li>`;
    }
    if (node.type === "link" && typeof node.url === "string" && /^https?:/i.test(node.url)) {
      const url = escapeHtml(node.url);
      return `<li class="share-card share-card--ref"><span class="muted">链接</span> <a class="break" href="${url}" target="_blank" rel="noopener noreferrer nofollow">${url}</a></li>`;
    }
    return "";
  });
  const body = cards.filter(Boolean).join("");
  const head = `<p class="share__aside">这是一张画布。网页里按位置从上到下列出它的卡片${groups.length ? `（分组：${groups.map((group) => escapeHtml(String(group.label))).join("、")}）` : ""}；完整的画布请下载原文件，用 Opennote 打开。</p>`;
  return head + (body ? `<ul class="share-cards">${body}</ul>` : `<p class="share__aside">画布里没有卡片。</p>`);
}

/** 不能在网页里展开的文件：说清楚，给下载。 */
function noPreview(share: ShareRow, reason: string): string {
  return `<div class="share-empty"><p>${escapeHtml(reason)}</p><p><a class="btn btn--primary" href="/s/${share.id}/raw?download=1">下载 ${escapeHtml(share.name)}</a></p></div>`;
}

export function renderShareBody(share: ShareRow, bytes: Uint8Array): string {
  const ext = extensionOf(share.name);
  const raw = `/s/${share.id}/raw`;
  if (IMAGES.has(ext)) {
    return `<figure class="share-figure"><img src="${raw}" alt="${escapeHtml(share.name)}" /></figure>`;
  }
  if (HTML.has(ext)) {
    return (
      `<p class="share__aside">这是一个 HTML 页面，下面按原样显示（在隔离的沙箱里，碰不到这个网站的任何数据）。</p>` +
      `<iframe class="share-frame" src="${raw}" title="${escapeHtml(share.name)}" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" loading="lazy"></iframe>`
    );
  }
  const text = decodeText(bytes);
  if (text === null) return noPreview(share, "这个文件不能在网页里预览。");
  if (MARKDOWN.has(ext)) return `<article class="prose share__doc">${markdown.render(text)}</article>`;
  if (ext === "canvas") return renderCanvas(text) ?? `<pre class="share-pre">${escapeHtml(text)}</pre>`;
  if (TEXT.has(ext) || ext === "") return `<pre class="share-pre">${escapeHtml(text)}</pre>`;
  // 其它能按 UTF-8 解开的文件（代码等）：按纯文本显示。
  return `<pre class="share-pre">${escapeHtml(text)}</pre>`;
}

/* ------------------------------------------------------------ 整页 */

function head(title: string): string {
  return [
    "<!doctype html>",
    '<html lang="zh-CN" data-theme="paper" data-accent="seal">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    // 公开链接是给拿到它的人看的，不是给搜索引擎的。
    '<meta name="robots" content="noindex, nofollow" />',
    '<meta name="referrer" content="no-referrer" />',
    '<meta name="color-scheme" content="light dark" />',
    `<title>${escapeHtml(title)}</title>`,
    '<link rel="stylesheet" href="/panel/tokens.css" />',
    '<link rel="stylesheet" href="/panel/console.css" />',
    '<link rel="stylesheet" href="/panel/prose.css" />',
    '<link rel="stylesheet" href="/panel/share.css" />',
    // 同步执行：先定主题再画（与控制台同一份，跟随系统 / 记住的选择）。
    '<script src="/panel/theme.js"></script>',
    '<script src="/panel/share.js" defer></script>',
    "</head>",
  ].join("\n");
}

function brand(): string {
  return '<a class="share__brand" href="/"><span class="seal">記</span><b>Opennote</b></a>';
}

/** UTC 的「YYYY-MM-DD HH:mm」（`share.js` 会换成读者本地时间）。 */
function utcStamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * Markdown 笔记的第一行就是同名的 `# 标题` 时，不再另画一个大标题（否则同一句话上下出现两遍）。
 * 这和应用里的阅读视图一致：那里也只有正文自己的标题。
 */
function opensWithOwnTitle(share: ShareRow, bytes: Uint8Array): boolean {
  if (!MARKDOWN.has(extensionOf(share.name))) return false;
  const first = (decodeText(bytes) ?? "").split(/\r?\n/).find((line) => line.trim() !== "");
  const match = first ? /^#\s+(.+?)\s*#*\s*$/.exec(first.trim()) : null;
  return match !== null && match[1]!.trim() === titleOf(share.name).trim();
}

export function renderSharePage(share: ShareRow, bytes: Uint8Array, options: { host: string }): string {
  const raw = `/s/${share.id}/raw`;
  const when = new Date(share.created_at).toISOString();
  return [
    head(`${titleOf(share.name)} · Opennote 分享`),
    "<body>",
    '<div class="share">',
    '<header class="share__bar">',
    brand(),
    '<span class="tag tag--solid">只读快照</span>',
    '<span class="grow"></span>',
    `<a class="btn btn--sm" href="${raw}" target="_blank" rel="noopener">查看原文件</a>`,
    `<a class="btn btn--sm btn--primary" href="${raw}?download=1">下载</a>`,
    "</header>",
    '<main class="share__main">',
    opensWithOwnTitle(share, bytes) ? "" : `<h1 class="share__title">${escapeHtml(titleOf(share.name))}</h1>`,
    `<p class="share__meta"><span class="mono break">${escapeHtml(share.name)}</span><span aria-hidden="true">·</span><span>${formatBytes(share.size)}</span><span aria-hidden="true">·</span><span>分享于 <time datetime="${when}">${utcStamp(share.created_at)}</time></span></p>`,
    '<div class="callout callout--attn share__notice">',
    "<b>这是一份一次性快照。</b>内容停在分享的那一刻：作者之后的修改不会出现在这里，这个页面也不参与同步，只能看、不能改。",
    "</div>",
    renderShareBody(share, bytes),
    "</main>",
    `<footer class="share__foot">${escapeHtml(options.host)} · 由 Opennote 同步服务提供的公开快照</footer>`,
    "</div>",
    "</body>",
    "</html>",
  ].join("\n");
}

/** 链接无效 / 已撤销 / 作者账号已删除：同一张卡（不区分原因，免得泄露「这个 id 存在过」）。 */
export function renderShareMissing(): string {
  return [
    head("链接已失效 · Opennote 分享"),
    "<body>",
    '<div class="center-card">',
    '<div class="center-card__head"><span class="seal">記</span><b>这个分享链接已失效</b></div>',
    '<p class="message">链接可能输错了，或者分享它的人已经撤销了这份快照。</p>',
    '<p class="note">如果你还需要这个文件，请联系发给你链接的人，请对方重新分享一次。</p>',
    "</div>",
    "</body>",
    "</html>",
  ].join("\n");
}
