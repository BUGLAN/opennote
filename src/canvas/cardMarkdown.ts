/**
 * 画布卡片里的 Markdown：文本卡的正文、文件卡里笔记的正文。
 *
 * 和导出 / 阅读视图用同一个解析器配置（markdown-it + DOMPurify），只多两件卡片专属的事：
 *
 * 1. `[[双链]]` / `[[目标|别名]]` / `[[目标#标题]]` 渲染成可点的链接，目标放在 `data-wiki` 上
 *    （点击由卡片组件接住，交给宿主打开或新建那篇笔记）；
 * 2. 所有链接都带 `nodrag`：在链接上按下不能被 React Flow 当成拖卡片。
 *
 * 纯函数，不碰 DOM —— 图片的相对路径解析与点击处理在 `nodes.tsx` 的 `CardMarkdown` 里。
 */

import MarkdownIt from "markdown-it";
import type { RendererRule, StateInline } from "markdown-it";

type Md = InstanceType<typeof MarkdownIt>;
import { sanitizeHtml } from "../lib/markdown";
import { extractHeadings } from "../lib/outline";
import { splitFrontMatter } from "../lib/utils";

/** 文件卡最多渲染这么多字：再长的笔记在卡片里也看不完，双击打开全文。 */
export const CARD_PREVIEW_LIMIT = 30_000;

/** `[[...]]` 的 inline 规则：放在 `link` 之前，免得 `[[a]]` 被当成 `[` + 链接文本。 */
function wikiLinks(md: Md): void {
  md.inline.ruler.before("link", "wikilink", (state: StateInline, silent: boolean) => {
    const start = state.pos;
    const src = state.src;
    if (src.charCodeAt(start) !== 0x5b /* [ */ || src.charCodeAt(start + 1) !== 0x5b) return false;
    const end = src.indexOf("]]", start + 2);
    if (end < 0) return false;
    const inner = src.slice(start + 2, end);
    if (inner.trim() === "" || /[[\]\n]/.test(inner)) return false;
    if (!silent) {
      const bar = inner.indexOf("|");
      const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
      const alias = bar >= 0 ? inner.slice(bar + 1).trim() : "";
      // 打开的是那篇笔记；`#标题` 部分只影响显示（与 Obsidian 一样，别名优先）。
      const note = target.split("#")[0].trim() || target;
      const open = state.push("link_open", "a", 1);
      open.attrSet("href", "#");
      open.attrSet("data-wiki", note);
      open.attrSet("class", "canvas-md__wiki");
      const text = state.push("text", "", 0);
      text.content = alias || target;
      state.push("link_close", "a", -1);
    }
    state.pos = end + 2;
    return true;
  });
}

/** 链接一律加 `nodrag`（React Flow 按这个类放过指针事件）。 */
function noDragLinks(md: Md): void {
  const fallback: RendererRule = (tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options);
  const original = md.renderer.rules.link_open ?? fallback;
  md.renderer.rules.link_open = (tokens, idx, options, env, self): string => {
    tokens[idx].attrJoin("class", "nodrag");
    return original(tokens, idx, options, env, self);
  };
}

function createRenderer(breaks: boolean): Md {
  const md = new MarkdownIt({ html: true, linkify: true, breaks, typographer: false });
  md.use(wikiLinks);
  md.use(noDragLinks);
  return md;
}

/*
 * 两套换行规则：
 * - 文本卡：单个回车就是换行（以前卡片按原文显示，用户就是这么写的；Obsidian 画布也是这样）；
 * - 笔记正文：与导出 / 阅读视图一致（单个回车不换行）。
 */
const textCardRenderer = createRenderer(true);
const noteRenderer = createRenderer(false);

/** 文本卡正文 → 安全的 HTML。 */
export function renderTextCard(source: string): string {
  return sanitizeHtml(textCardRenderer.render(source));
}

/** 笔记正文（已经截好段）→ 安全的 HTML。 */
export function renderNoteCard(source: string): string {
  return sanitizeHtml(noteRenderer.render(source));
}

/**
 * 文件卡要显示的那段正文：去掉 front matter；有 `#标题` 时只取那一节；太长就截断。
 *
 * - 一节 = 从该标题起，到下一个**同级或更高级**的标题之前；
 * - Obsidian 的嵌套写法 `#一级#二级` 取最后一段；`#^块` 引用不认，退回整篇；
 * - 找不到那个标题也退回整篇（比显示一张空卡有用）。
 */
export function notePreviewSource(content: string, subpath?: string): { text: string; truncated: boolean } {
  let body = splitFrontMatter(content).body;
  const heading = subpath?.replace(/^#/, "").split("#").pop()?.trim();
  if (heading && !heading.startsWith("^")) {
    const headings = extractHeadings(body);
    const index = headings.findIndex((item) => item.text === heading);
    if (index >= 0) {
      const from = headings[index];
      const next = headings.slice(index + 1).find((item) => item.level <= from.level);
      body = body.slice(from.pos, next === undefined ? undefined : next.pos);
    }
  }
  if (body.length <= CARD_PREVIEW_LIMIT) return { text: body, truncated: false };
  return { text: body.slice(0, CARD_PREVIEW_LIMIT), truncated: true };
}
