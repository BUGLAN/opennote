/**
 * HTML 页面的「静态资源内联」——**唯一产地**。
 *
 * 一篇 HTML 页面在笔记本里是**一个** `.html` 文件：它引用的 CSS / JS / 图片 / 字体 / 音视频
 * 在入库时被内联进来（`<link rel=stylesheet>` → `<style>`，其余 → `data:` URL），于是：
 *
 * - 同步与 GitHub 只需要认 `.html` 一个扩展名（`shared/paths.ts` 的 `isHtmlPath`），
 *   散落的 `.css` / `.js` 永远不进物化判据（那会把仓库源码写进笔记本）；
 * - 页面在任何设备、任何浏览器里双击打开都是完整的；
 * - 渲染时（`HtmlView`）再跑一遍同一个函数，兜住「用户手工把整个目录拷进笔记本」的散装页面。
 *
 * 调用方：收件箱 / 本地桥入库（`lib/clip/receive.ts`，资源来自信封的 `resources[]`）、
 * 文件 / zip 导入（`lib/import.ts`，资源来自同一批文件）、渲染（`html/HtmlView.tsx`，
 * 资源来自工作区）、收件箱预览（`data/inbox.ts`）。四处共用这一份改写规则。
 *
 * **为什么不用 DOMParser**：单测跑在 node 环境（`vitest.config.ts`），没有 DOM；而且入库产物
 * 要尽量保留用户原文 —— DOM 往返会重排属性、补全标签、改掉空白。这里是一个只认标签边界与
 * 属性的小扫描器：不认识的东西**原样拷贝**，只改「能确定是本地资源引用」的那几处值。
 *
 * 安全边界（由 `resolveLocalRef` 一处把守）：
 * - 只解析**相对路径**：带协议（`https:` / `data:` / `javascript:` …）、协议相对（`//x`）、
 *   纯锚点（`#x`）一律不动；
 * - 不许 `..` 越过资源根（页面所在目录）：页面不能借相对引用读到笔记本里别处的东西；
 * - 不许任何一段以 `.` 开头（`.opennote/`、`.assets/`、`.git/` …）；
 * - 只内联白名单 MIME（`HTML_RESOURCE_MIME_BY_EXT`）：`.md` / `.canvas` / `.html` 不会被当成
 *   资源读进页面（否则一张恶意页面能把别的笔记读进自己、再经图片请求带出去）。
 */

/** 资源字节 + MIME（MIME 由扩展名决定，见 `htmlResourceMime`）。 */
export interface HtmlResource {
  bytes: Uint8Array;
  mime: string;
}

/**
 * 按「资源根相对路径」取一份资源；取不到返回 `null`（记进 `missing`，引用原样保留）。
 * 传进来的路径已经过 `resolveLocalRef` 归一与安全校验。
 */
export type HtmlResourceResolver = (path: string) => Promise<HtmlResource | null> | HtmlResource | null;

export interface InlineHtmlOptions {
  resolve: HtmlResourceResolver;
  /** 内联字节合计上限；超出的资源保留原引用并记进 `skipped`。缺省 24 MiB。 */
  maxBytes?: number;
}

export interface InlineHtmlResult {
  html: string;
  /** 实际内联进来的资源（资源根相对路径，去重、按首次出现排序）。 */
  inlined: string[];
  /** 引用了、但取不到的本地资源。 */
  missing: string[];
  /** 取到了、但因格式不在白名单或超过合计上限而没有内联的资源。 */
  skipped: string[];
}

/** 资源白名单：扩展名 → MIME。不在表里的扩展名一律不内联。 */
export const HTML_RESOURCE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".vtt": "text/vtt",
  ".txt": "text/plain",
  ".csv": "text/csv",
};

/** 白名单里的全部 MIME（信封 `resources[].mime` 的校验用它）。 */
export const HTML_RESOURCE_MIMES: readonly string[] = [...new Set(Object.values(HTML_RESOURCE_MIME_BY_EXT))];

const DEFAULT_MAX_BYTES = 24 * 1024 * 1024;
/** CSS `@import` 的递归深度上限（循环引用另有 visited 集合兜底）。 */
const MAX_CSS_DEPTH = 8;

/** 扩展名 → MIME；不在白名单里返回 `null`。 */
export function htmlResourceMime(path: string): string | null {
  const match = /\.[A-Za-z0-9]+$/.exec(path);
  if (!match) return null;
  return HTML_RESOURCE_MIME_BY_EXT[match[0].toLowerCase()] ?? null;
}

/* ============================== 路径 ============================== */

/** 资源根相对目录 `dir`（`""` = 根）下的引用 `ref` → 资源根相对路径；不是本地资源返回 `null`。 */
export function resolveLocalRef(dir: string, ref: string): string | null {
  let value = decodeEntities(ref).trim();
  if (!value) return null;
  // 锚点、带协议（含 Windows 盘符 `C:`——协议正则同样会命中它）、协议相对 → 不是本地资源。
  if (value.startsWith("#") || value.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return null;
  value = value.replace(/[?#].*$/, "");
  if (!value) return null;
  try {
    value = decodeURIComponent(value);
  } catch {
    /* 坏的百分号编码：按字面路径找 */
  }
  if (value.includes("\0") || value.includes("\\")) return null;
  const rooted = value.startsWith("/");
  const segments = rooted ? [] : dir.split("/").filter(Boolean);
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      // 越过资源根 → 拒绝（不是夹到根上：夹住会把 `../x.css` 悄悄解析成另一个文件）。
      if (!segments.length) return null;
      segments.pop();
      continue;
    }
    if (segment.startsWith(".")) return null;
    segments.push(segment);
  }
  return segments.length ? segments.join("/") : null;
}

/**
 * 资源**文件路径**（不是 URL：不做百分号解码）的归一：`./a/b.css` → `a/b.css`。
 * 与 `resolveLocalRef` 同一套拒绝项 —— 绝对路径、`..`、点开头的段、反斜杠、NUL、盘符/协议。
 * 信封的 `resources[].path`、导入时的同批文件都经它变成内联器认得的键。
 */
export function normalizeResourcePath(path: string): string | null {
  const value = path.trim();
  if (!value || value.startsWith("/") || value.includes("\0") || value.includes("\\") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    return null;
  }
  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === ".." || segment.startsWith(".")) return null;
    segments.push(segment);
  }
  return segments.length ? segments.join("/") : null;
}

function dirOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

/* ============================== 编码 ============================== */

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** 属性值里最常见的那几种字符实体（够用于路径；不认识的原样留着）。 */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITY[body.toLowerCase()] ?? whole;
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
}

function dataUrl(resource: HtmlResource): string {
  return `data:${resource.mime};base64,${bytesToBase64(resource.bytes)}`;
}

/* ============================== 内联器 ============================== */

class Inliner {
  private readonly cache = new Map<string, Promise<HtmlResource | null>>();
  private readonly inlined: string[] = [];
  private readonly missing: string[] = [];
  private readonly skipped: string[] = [];
  private bytes = 0;

  constructor(
    private readonly resolve: HtmlResourceResolver,
    private readonly maxBytes: number,
  ) {}

  result(html: string): InlineHtmlResult {
    return { html, inlined: [...this.inlined], missing: [...this.missing], skipped: [...this.skipped] };
  }

  /** 取一份可内联的资源：白名单、合计上限、去重都在这里；不可内联返回 `null`。 */
  async take(path: string): Promise<HtmlResource | null> {
    const mime = htmlResourceMime(path);
    if (!mime) {
      note(this.skipped, path);
      return null;
    }
    let pending = this.cache.get(path);
    const first = !pending;
    if (!pending) {
      pending = Promise.resolve()
        .then(() => this.resolve(path))
        .catch(() => null);
      this.cache.set(path, pending);
    }
    const found = await pending;
    if (!found) {
      // 超限被跳过的资源在缓存里也是 null：它已经记在 skipped 里，不要再算成「缺失」。
      if (!this.skipped.includes(path)) note(this.missing, path);
      return null;
    }
    if (first) {
      if (this.bytes + found.bytes.byteLength > this.maxBytes) {
        note(this.skipped, path);
        this.cache.set(path, Promise.resolve(null));
        return null;
      }
      this.bytes += found.bytes.byteLength;
      note(this.inlined, path);
    } else if (!this.inlined.includes(path)) {
      return null;
    }
    // MIME 以扩展名为准（解析器给的 mime 可能是 `application/octet-stream`）。
    return { bytes: found.bytes, mime };
  }

  async dataUrlFor(dir: string, ref: string): Promise<string | null> {
    const path = resolveLocalRef(dir, ref);
    if (!path) return null;
    const resource = await this.take(path);
    if (!resource) return null;
    if (resource.mime === "text/css") {
      // CSS 里还可能有 url() / @import：先递归改写再编码，否则 data: 里的相对引用全部失效。
      const css = await this.css(decodeText(resource.bytes), dirOf(path), 1, new Set([path]));
      return `data:text/css;base64,${bytesToBase64(new TextEncoder().encode(css))}`;
    }
    return dataUrl(resource);
  }

  /** 改写 CSS：`@import` 与 `url()` 里的本地引用换成 `data:` URL（相对 CSS 文件自己的目录）。 */
  async css(text: string, dir: string, depth: number, visited: Set<string>): Promise<string> {
    const pattern = /@import\s+(?:url\(\s*(["']?)([^"')]+)\1\s*\)|(["'])([^"']+)\3)|url\(\s*(["']?)([^"')]*?)\5\s*\)/gi;
    let out = "";
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      out += text.slice(last, index);
      last = index + match[0].length;
      const isImport = match[0].slice(0, 7).toLowerCase() === "@import";
      const ref = isImport ? (match[2] ?? match[4] ?? "") : (match[6] ?? "");
      const replacement = isImport ? await this.cssImport(ref, dir, depth, visited) : await this.dataUrlForCss(ref, dir);
      out += replacement === null ? match[0] : isImport ? `@import url("${replacement}")` : `url("${replacement}")`;
    }
    return out + text.slice(last);
  }

  private async dataUrlForCss(ref: string, dir: string): Promise<string | null> {
    const path = resolveLocalRef(dir, ref);
    if (!path) return null;
    // url() 指向另一份 CSS 的情况几乎不存在；按普通资源处理（不递归），避免二次进入 css()。
    const resource = await this.take(path);
    return resource ? dataUrl(resource) : null;
  }

  private async cssImport(ref: string, dir: string, depth: number, visited: Set<string>): Promise<string | null> {
    const path = resolveLocalRef(dir, ref);
    if (!path || visited.has(path) || depth > MAX_CSS_DEPTH) return null;
    const resource = await this.take(path);
    if (!resource) return null;
    const nested = await this.css(decodeText(resource.bytes), dirOf(path), depth + 1, new Set([...visited, path]));
    return `data:text/css;base64,${bytesToBase64(new TextEncoder().encode(nested))}`;
  }
}

function note(list: string[], path: string): void {
  if (!list.includes(path)) list.push(path);
}

/* ============================== 扫描器 ============================== */

interface Attr {
  name: string;
  value: string;
  /** 整个 `name="value"` 片段在标签文本里的起止（替换整段，统一写成双引号）。 */
  start: number;
  end: number;
}

function parseAttrs(tag: string): Attr[] {
  const attrs: Attr[] = [];
  const nameEnd = /^<[A-Za-z][A-Za-z0-9-]*/.exec(tag)?.[0].length ?? 1;
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  pattern.lastIndex = nameEnd;
  for (let match = pattern.exec(tag); match; match = pattern.exec(tag)) {
    attrs.push({
      name: match[1].toLowerCase(),
      value: match[2] ?? match[3] ?? match[4] ?? "",
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return attrs;
}

function attrOf(attrs: Attr[], name: string): Attr | undefined {
  return attrs.find((attr) => attr.name === name);
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** 按 `edits` 改写标签文本里的若干属性（`null` = 删除该属性）。 */
function applyAttrEdits(tag: string, edits: Array<{ attr: Attr; value: string | null }>): string {
  const sorted = [...edits].sort((a, b) => b.attr.start - a.attr.start);
  let out = tag;
  for (const { attr, value } of sorted) {
    const replacement = value === null ? "" : `${attr.name}="${escapeAttr(value)}"`;
    out = out.slice(0, attr.start) + replacement + out.slice(attr.end);
  }
  return out;
}

/** `>` 的位置（跳过引号里的 `>`）；没有闭合时返回最后一个字符。 */
function findTagEnd(html: string, from: number): number {
  let quote = "";
  for (let index = from + 1; index < html.length; index += 1) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index;
    }
  }
  return html.length - 1;
}

function indexOfInsensitive(html: string, needle: string, from: number): number {
  const index = html.toLowerCase().indexOf(needle, from);
  return index;
}

/** `srcset` 逐候选改写（URL 里可能含逗号，所以按规范的「URL 到空白为止」切分）。 */
async function rewriteSrcset(value: string, rewrite: (url: string) => Promise<string | null>): Promise<string> {
  const parts: string[] = [];
  let index = 0;
  let changed = false;
  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value[index])) index += 1;
    if (index >= value.length) break;
    let end = index;
    while (end < value.length && !/\s/.test(value[end])) end += 1;
    let url = value.slice(index, end);
    let descriptor = "";
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
      index = end;
    } else {
      let depth = 0;
      let cursor = end;
      while (cursor < value.length && !(value[cursor] === "," && depth === 0)) {
        if (value[cursor] === "(") depth += 1;
        if (value[cursor] === ")") depth -= 1;
        cursor += 1;
      }
      descriptor = value.slice(end, cursor).trim();
      index = cursor + 1;
    }
    const next = await rewrite(url);
    if (next !== null) changed = true;
    parts.push(descriptor ? `${next ?? url} ${descriptor}` : (next ?? url));
  }
  return changed ? parts.join(", ") : value;
}

/** 每种标签上「值是一个资源 URL」的属性。 */
const URL_ATTRS: Record<string, readonly string[]> = {
  img: ["src"],
  source: ["src"],
  video: ["src", "poster"],
  audio: ["src"],
  track: ["src"],
  input: ["src"],
  embed: ["src"],
  image: ["href", "xlink:href"],
  feimage: ["href", "xlink:href"],
};
const SRCSET_TAGS = new Set(["img", "source"]);

/**
 * 把 `html` 里引用的本地资源内联进来。不认识、取不到、越界的引用一律**原样保留**，
 * 所以对一个已经内联过的页面再跑一遍是幂等的（`data:` 本来就被跳过）。
 */
export async function inlineHtmlResources(html: string, options: InlineHtmlOptions): Promise<InlineHtmlResult> {
  const inliner = new Inliner(options.resolve, options.maxBytes ?? DEFAULT_MAX_BYTES);
  let out = "";
  let index = 0;
  while (index < html.length) {
    const lt = html.indexOf("<", index);
    if (lt < 0) {
      out += html.slice(index);
      break;
    }
    out += html.slice(index, lt);
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      const stop = close < 0 ? html.length : close + 3;
      out += html.slice(lt, stop);
      index = stop;
      continue;
    }
    const name = /^<([A-Za-z][A-Za-z0-9:-]*)/.exec(html.slice(lt, lt + 64))?.[1]?.toLowerCase();
    if (!name) {
      // `</x>`、`<!doctype>`、孤立的 `<`：原样拷贝到 `>` 为止。
      const end = html[lt + 1] === "/" || html[lt + 1] === "!" ? findTagEnd(html, lt) : lt;
      out += html.slice(lt, end + 1);
      index = end + 1;
      continue;
    }
    const end = findTagEnd(html, lt);
    const tag = html.slice(lt, end + 1);
    index = end + 1;

    if (name === "script" || name === "style" || name === "textarea" || name === "title") {
      // 原始文本元素：内容里的 `<` 不是标签，一直拷到对应的闭合标签。
      const close = indexOfInsensitive(html, `</${name}`, index);
      const bodyEnd = close < 0 ? html.length : close;
      const inner = html.slice(index, bodyEnd);
      index = bodyEnd;
      if (name === "script") out += await rewriteScriptTag(tag, inner, inliner);
      else if (name === "style") out += tag + escapeStyleText(await inliner.css(inner, "", 1, new Set()));
      else out += tag + inner;
      continue;
    }

    if (name === "link") {
      out += await rewriteLinkTag(tag, inliner);
      continue;
    }

    out += await rewriteGenericTag(name, tag, inliner);
  }
  return inliner.result(out);
}

async function rewriteScriptTag(tag: string, inner: string, inliner: Inliner): Promise<string> {
  const attrs = parseAttrs(tag);
  const src = attrOf(attrs, "src");
  if (!src) return tag + inner;
  const url = await inliner.dataUrlFor("", src.value);
  // `src` 换成 `data:` 而不是把代码搬进标签体：`defer` / `async` / `type=module` 的语义
  // 只对外部脚本成立，搬成内联脚本会改变执行时机；也不必担心代码里的 `</script>`。
  return url ? applyAttrEdits(tag, [{ attr: src, value: url }]) + inner : tag + inner;
}

async function rewriteLinkTag(tag: string, inliner: Inliner): Promise<string> {
  const attrs = parseAttrs(tag);
  const href = attrOf(attrs, "href");
  if (!href) return tag;
  const rel = (attrOf(attrs, "rel")?.value ?? "").toLowerCase().split(/\s+/);
  if (rel.includes("stylesheet")) {
    const path = resolveLocalRef("", href.value);
    if (!path) return tag;
    const resource = await inliner.take(path);
    if (!resource || resource.mime !== "text/css") return tag;
    const css = await inliner.css(decodeText(resource.bytes), dirOf(path), 1, new Set([path]));
    // `<link>` → `<style>`：`media` 保留；其余属性（integrity 之类）对内联样式没有意义。
    const media = attrOf(attrs, "media");
    const mediaAttr = media ? ` media="${escapeAttr(media.value)}"` : "";
    return `<style data-opennote-href="${escapeAttr(path)}"${mediaAttr}>${escapeStyleText(css)}</style>`;
  }
  if (rel.some((value) => value === "icon" || value === "apple-touch-icon" || value === "mask-icon")) {
    const url = await inliner.dataUrlFor("", href.value);
    return url ? applyAttrEdits(tag, [{ attr: href, value: url }]) : tag;
  }
  return tag;
}

async function rewriteGenericTag(name: string, tag: string, inliner: Inliner): Promise<string> {
  const attrs = parseAttrs(tag);
  const edits: Array<{ attr: Attr; value: string | null }> = [];
  for (const attrName of URL_ATTRS[name] ?? []) {
    const attr = attrOf(attrs, attrName);
    if (!attr) continue;
    if (name === "input" && (attrOf(attrs, "type")?.value ?? "").toLowerCase() !== "image") continue;
    const url = await inliner.dataUrlFor("", attr.value);
    if (url) edits.push({ attr, value: url });
  }
  if (SRCSET_TAGS.has(name)) {
    const srcset = attrOf(attrs, "srcset");
    if (srcset) {
      const next = await rewriteSrcset(decodeEntities(srcset.value), (url) => inliner.dataUrlFor("", url));
      if (next !== decodeEntities(srcset.value)) edits.push({ attr: srcset, value: next });
    }
  }
  const style = attrOf(attrs, "style");
  if (style && /url\(/i.test(style.value)) {
    const raw = decodeEntities(style.value);
    const next = await inliner.css(raw, "", 1, new Set());
    if (next !== raw) edits.push({ attr: style, value: next });
  }
  return edits.length ? applyAttrEdits(tag, edits) : tag;
}

/** 内联进 `<style>` 的 CSS 不能提前闭合标签：`</style` → `<\/style`（CSS 里 `\/` 就是 `/`）。 */
function escapeStyleText(css: string): string {
  return css.replace(/<\/(style)/gi, "<\\/$1");
}

/* ============================== 元信息 ============================== */

/** `<title>` 的文本（实体解码、空白折叠）；没有或为空返回 `null`。 */
export function htmlDocumentTitle(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  const text = match ? decodeEntities(match[1]).replace(/\s+/g, " ").trim() : "";
  return text || null;
}

/**
 * 页面的纯文本（搜索用）：去掉注释、`<script>` / `<style>` / `<template>` / `<svg>` 整块，
 * 其余标签换成空白，实体解码、空白折叠。`data:` 里的 base64 随标签一起消失，不会污染搜索。
 */
export function htmlPlainText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|template|svg|noscript)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}
