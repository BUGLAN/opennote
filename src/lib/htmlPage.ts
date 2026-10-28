/**
 * HTML 页面（只读页面类型）的**纯函数**。
 *
 * 这个模块存在的理由与 `src/lib/markdown.ts` 一样：把「从 HTML 里取一个字符串」这件事
 * 收成一个产地，别让扫描、搜索、侧栏摘要、标题派生各写一版正则。四处各写一版的结果不是
 * 编译错误，而是**同一个页面在四个地方叫四个名字**（搜索能搜到、侧栏说「无标题」）。
 *
 * ## 为什么全部用正则，不用 DOMParser
 *
 * 三个调用方里有两个根本不在浏览器里：
 *   1. `scanWorkspace()` 跑在渲染层，但 400 篇笔记的扫描是**批量**的 —— 每篇 new 一个
 *      `DOMParser` + 解析整棵树，比十条正则慢一个量级，而且要在一次扫描里做几百次；
 *   2. 单测环境是 `environment: "node"`（`vitest.config.ts`），**没有 DOMParser**；
 *   3. `shared/` 的宿主里更没有 DOM。
 *
 * 代价如实说明：正则**不是** HTML 解析器。它认不出「`<title>` 出现在 `<script>` 的字符串里」
 * 这种病态输入。但这里要的只是「一个够用的显示名」与「一段摘要」，
 * 取值出错只会让侧栏显示得难看一点，**不会影响渲染**（渲染走 iframe，与这里无关）。
 * 用 DOMParser 换来的那点准确度，不值得把一个纯函数变成只能在浏览器里跑的东西。
 */

import { baseName, extName, isHtmlPagePath, stripExtension } from "../fs/paths";
import type { PageKind } from "../data/types";

/** 这个路径是不是 HTML 页面（`isHtmlPagePath` 的语义包装，参数是页面 id = 工作区相对路径）。 */
export function isHtmlPage(path: string): boolean {
  return isHtmlPagePath(path);
}

/** 路径 → 页面类型。**唯一判据**：只看扩展名，不看内容。 */
export function pageKindOf(path: string): PageKind {
  return isHtmlPagePath(path) ? "html" : "md";
}

/** 标题的最大长度，与 `deriveTitle()` 的 `TITLE_LIMIT` 对齐（侧栏与标签栏的省略号按它排版）。 */
const TITLE_LIMIT = 90;

/** 去掉注释后的文本（注释里的文字不该成为标题或摘要）。 */
function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, " ");
}

/** 去掉 <script> / <style> 的**整段内容**：它们的文本不是用户要读的正文。 */
function stripNonContent(html: string): string {
  return stripComments(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, " ")
    .replace(/<template\b[^>]*>[\s\S]*?<\/template\s*>/gi, " ");
}

/**
 * 实体解码：只处理最常见的几个。
 *
 * 为什么不做全表：这里的结果只用于**显示**（标题 / 摘要），而 `&hellip;` 这类实体出现在
 * 标题里的概率极低；漏掉一个的后果是侧栏显示 `&hellip;` 而不是 `…`，不值得为此
 * 维护一张 2000 项的映射表。数字实体（`&#39;` / `&#x4E2D;`）是常见的，所以**做**。
 */
function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    mdash: "—",
    ndash: "–",
    hellip: "…",
    middot: "·",
    laquo: "«",
    raquo: "»",
  };
  return text
    .replace(/&#(\d{1,7});/g, (_match, digits: string) => {
      const code = Number(digits);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _match;
    })
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (_match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _match;
    })
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

/** HTML → 一行可读文本（标签去掉、实体解码、空白折叠）。 */
export function htmlToText(html: string): string {
  return decodeEntities(
    stripNonContent(html)
      // 换行类标签先换成空格：`<p>a</p><p>b</p>` 不该被读成 `ab`
      .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer)\b[^>]*>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** 取第一个匹配标签的文本内容（标签可以带属性）。 */
function firstTagText(html: string, tag: string): string {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "i");
  const match = pattern.exec(stripNonContent(html));
  if (!match) return "";
  return htmlToText(match[1]).trim();
}

/**
 * 页面标题：`<title>` → 第一个 `<h1>` → 文件名。
 *
 * 顺序为什么是这样：`<title>` 是作者**显式**给这份文档起的名字（浏览器标签页显示的
 * 就是它）；`<h1>` 是正文的第一个标题，可能只是页面里的一节；文件名是最后的兜底。
 * 与 Markdown 的 `deriveTitle()`（正文 H1 赢、文件名兜底）**故意不同** ——
 * Markdown 没有 `<title>` 这个位置，两者能比较的只有 H1。
 */
export function htmlTitle(html: string, fallback = "无标题"): string {
  const fromTitle = firstTagText(html, "title");
  if (fromTitle) return fromTitle.slice(0, TITLE_LIMIT);
  const fromH1 = firstTagText(html, "h1");
  if (fromH1) return fromH1.slice(0, TITLE_LIMIT);
  return fallback;
}

/**
 * 页面文件名（去扩展名）—— 标题派生与「文件名」兜底共用一处。
 *
 * `..html` 这种「去掉扩展名之后只剩点」的名字要退回到「无标题」：`extName()` 明确不把
 * 开头就是点的段当扩展名（`.gitignore` 没有扩展名），所以 `baseName(".html")` 本身就是
 * `.html`，`stripExtension` 一格不动。留着它，侧栏就会出现一条标题叫「.html」的笔记。
 */
export function htmlFallbackTitle(path: string): string {
  const stem = stripExtension(baseName(path)).replace(/^\.+/, "").trim();
  // 只剩扩展名的名字（`.html` / `.htm`）没有可用的显示名：显示成「html」比显示「无标题」更糟。
  return stem && !/^html?$/i.test(stem) ? stem : "无标题";
}

/** 这个扩展名是不是 HTML（给导入分流用，避免各处再写一次正则）。 */
export function hasHtmlExtension(path: string): boolean {
  return extName(path) === ".html" || extName(path) === ".htm";
}

/**
 * 页面是不是「空的」。
 *
 * 判据比「`trim()` 之后为空」更严一点，因为**生成器产出的空壳**长这样：
 * `<!doctype html><html><head><meta charset="utf-8"><title>x</title></head><body></body></html>`
 * —— 它有 `<title>`、有 `<head>`，但用户看到的是一片白。把这种也算空，
 * 界面才会给出「这个页面没有内容」而不是让用户对着一片白猜是不是加载失败。
 *
 * 判定：去掉 `<head>` 整段、注释、脚本与样式之后，**没有可读文本也没有成对的内容元素**
 * （`<img>` / `<svg>` / `<canvas>` / `<video>` / `<iframe>`）即为空。
 */
export function isHtmlEmpty(html: string): boolean {
  const body = stripNonContent(html)
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, " ")
    .replace(/<!doctype[^>]*>/gi, " ")
    // 结构壳标签本身不算内容
    .replace(/<\/?(?:html|body|head|main|div|span|p|section|article)\b[^>]*>/gi, " ");
  if (htmlToText(body)) return false;
  // 没有文本，但有「有实际画面的元素」也不算空 —— 一张全屏海报就是这种页面。
  return !/<(?:img|svg|canvas|video|iframe|picture|object|embed)\b/i.test(body);
}

/**
 * 页面摘要（侧栏的列表视图 / 搜索结果的次行）。
 *
 * `limit` 按**码点**截断，不是 `slice(0, limit)`：后者会把一个 emoji（代理对）劈成
 * 两个孤立代理项，React 渲染出来就是一个替换符。中文标题里 emoji 不算罕见，
 * 而「摘要最后一个字变成 口」这种缺陷很难被归因回 `slice`。
 */
export function htmlExcerpt(html: string, limit = 120): string {
  const text = htmlToText(html);
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  return `${chars.slice(0, limit).join("")}…`;
}
