import MarkdownIt, { type StateBlock, type StateInline } from "markdown-it";
import DOMPurify from "dompurify";
import { splitFrontMatter } from "./utils";

const md = new MarkdownIt({
  html: true,
  linkify: true,
  /*
   * 单个换行就是换行（排查报告问题 6，方案 A）。
   *
   * 编辑器里回车只插一个 `\n`，屏幕上就是两行；`breaks: false` 却会在阅读视图 / 导出里把它们
   * 合成一段 —— 所见不等于所得。打开它之后，现有笔记在编辑器里的样子与渲染结果完全一致，
   * 代价是导出的 HTML 与严格遵守 CommonMark 的工具在「单换行」上表现不同。
   */
  breaks: true,
  typographer: false,
});

/* ------------------------------------------------------------------ 扩展语法
 *
 * 编辑器（lezer，`editor/mdExtensions.ts`）认得 `==高亮==`、`[[wiki 链接]]`、`$公式$`，
 * 而渲染管线原来不认 —— 渲染态表格、阅读视图、导出里这三样全是原文（排查报告问题 15）。
 * 这里按**同一套边界规则**补上（逐条对照 mdExtensions.ts）：
 *
 * - 公式输出 `<span class="math" data-tex>` / `<div class="math math-block" data-tex>`，里面
 *   留着原文 —— 需要排版的地方（表格 widget、阅读视图）拿 `data-tex` 交给 KaTeX，
 *   导出的 HTML 没有 KaTeX 也照样看得见公式原文。
 * - wiki 链接输出 `<span class="wikilink" data-wiki>`：它不是网址，交给宿主决定怎么打开。
 */
type InlineState = StateInline;
type BlockState = StateBlock;

const DOLLAR = 0x24;
const EQUALS = 0x3d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const BACKSLASH = 0x5c;
const NEWLINE = 0x0a;
const SPACE = 32;
const TAB = 9;

/**
 * `==高亮==`：与编辑器（lezer 的分隔符解析）同一条边界 —— 标记必须贴着文字（`== x ==` 不是），
 * 里面照常解析粗体、链接；可以跨软换行（同一段里）。
 */
function highlightRule(state: InlineState, silent: boolean): boolean {
  const start = state.pos;
  const src = state.src;
  if (src.charCodeAt(start) !== EQUALS || src.charCodeAt(start + 1) !== EQUALS || src.charCodeAt(start + 2) === EQUALS) return false;
  const close = src.indexOf("==", start + 2);
  if (close < 0 || close + 2 > state.posMax) return false;
  const inner = src.slice(start + 2, close);
  if (!inner.trim() || /^\s/.test(inner) || /\s$/.test(inner)) return false;
  if (!silent) {
    state.push("mark_open", "mark", 1);
    const max = state.posMax;
    state.pos = start + 2;
    state.posMax = close;
    state.md.inline.tokenize(state);
    state.posMax = max;
    state.push("mark_close", "mark", -1);
  }
  state.pos = close + 2;
  return true;
}

function wikiRule(state: InlineState, silent: boolean): boolean {
  const start = state.pos;
  const src = state.src;
  if (src.charCodeAt(start) !== OPEN_BRACKET || src.charCodeAt(start + 1) !== OPEN_BRACKET) return false;
  let close = -1;
  for (let i = start + 2; i < state.posMax - 1; i += 1) {
    const code = src.charCodeAt(i);
    if (code === NEWLINE || code === OPEN_BRACKET) break;
    if (code === CLOSE_BRACKET && src.charCodeAt(i + 1) === CLOSE_BRACKET) {
      close = i;
      break;
    }
  }
  if (close < 0) return false;
  const label = src.slice(start + 2, close);
  if (!label.trim()) return false;
  if (!silent) state.push("wikilink", "span", 0).content = label;
  state.pos = close + 2;
  return true;
}

function mathInlineRule(state: InlineState, silent: boolean): boolean {
  const start = state.pos;
  const src = state.src;
  if (src.charCodeAt(start) !== DOLLAR || src.charCodeAt(start + 1) === DOLLAR) return false;
  const after = src.charCodeAt(start + 1);
  if (Number.isNaN(after) || after === SPACE || after === TAB || after === NEWLINE) return false;
  let end = -1;
  for (let i = start + 1; i < state.posMax; i += 1) {
    const code = src.charCodeAt(i);
    if (code === NEWLINE) break;
    if (code === BACKSLASH) {
      i += 1;
      continue;
    }
    if (code === DOLLAR) {
      if (src.charCodeAt(i - 1) === SPACE) break;
      end = i;
      break;
    }
  }
  if (end <= start + 1) return false;
  if (!silent) state.push("math_inline", "span", 0).content = src.slice(start + 1, end);
  state.pos = end + 1;
  return true;
}

/**
 * 公式块，规则与编辑器（`mdExtensions.ts` 的 MathBlock）逐条一致：
 * - 单行 `$$…$$`，且这一行以 `$$` 结尾（`$$a$$ 尾巴` 不是公式块）
 * - 多行：收尾行以 `$$` 结尾
 * - 没闭合：到空行或文末为止（D13：不吞后文）
 */
function mathBlockRule(state: BlockState, startLine: number, endLine: number, silent: boolean): boolean {
  const lineText = (line: number) => state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const fence = "$".repeat(2);
  const first = lineText(startLine);
  if (!first.startsWith(fence)) return false;
  const rest = first.slice(2).trimEnd();
  let content: string;
  let last = startLine;
  if (rest.includes(fence)) {
    if (!rest.endsWith(fence)) return false;
    content = rest.slice(0, -2);
  } else {
    const body = [rest];
    for (let line = startLine + 1; line < endLine; line += 1) {
      const text = lineText(line);
      if (!text.trim()) break;
      last = line;
      if (text.trimEnd().endsWith(fence)) {
        body.push(text.trimEnd().slice(0, -2));
        break;
      }
      body.push(text);
    }
    content = body.join("\n");
  }
  if (silent) return true;
  state.line = last + 1;
  const token = state.push("math_block", "div", 0);
  token.block = true;
  token.content = content.trim();
  token.map = [startLine, state.line];
  return true;
}

md.inline.ruler.before("emphasis", "mark", highlightRule);
md.inline.ruler.before("link", "wikilink", wikiRule);
md.inline.ruler.after("backticks", "math_inline", mathInlineRule);
md.block.ruler.before("fence", "math_block", mathBlockRule, { alt: ["paragraph", "reference", "blockquote", "list"] });

const escapeAttr = (value: string) => md.utils.escapeHtml(value);
md.renderer.rules.wikilink = (tokens, idx) =>
  `<span class="wikilink" data-wiki="${escapeAttr(tokens[idx].content)}">${escapeAttr(tokens[idx].content)}</span>`;
md.renderer.rules.math_inline = (tokens, idx) => {
  const tex = escapeAttr(tokens[idx].content);
  return `<span class="math" data-tex="${tex}">${"$"}${tex}${"$"}</span>`;
};
md.renderer.rules.math_block = (tokens, idx) => {
  const tex = escapeAttr(tokens[idx].content);
  return `<div class="math math-block" data-tex="${tex}">${"$$"}${tex}${"$$"}</div>\n`;
};

/** Render markdown to HTML with the exact same pipeline used for export. */
export function renderMarkdown(source: string): string {
  // 文件头的 front matter 是元数据，不是正文（否则 `---` 成了分隔线、`title: x` 成了二级标题）。
  // 规则与编辑器（`mdExtensions.ts` 的 FrontMatter）同一个：`splitFrontMatter()`。
  return sanitizeHtml(md.render(splitFrontMatter(source).body));
}

export function renderInline(source: string): string {
  return sanitizeHtml(md.renderInline(source));
}

export function sanitizeHtml(html: string): string {
  if (typeof window === "undefined" || typeof DOMPurify.sanitize !== "function") return html;
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ["target", "rel", "align", "colspan", "rowspan", "data-asset"],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|data|blob|asset):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  });
}

export { md as markdownIt };

/**
 * `renderMarkdown()` 的输出里，图片与链接的目标会被 markdown-it 的 `normalizeLink`
 * **百分号编码**：`![x](assets/计算机启动过程/a.png)` → `src="assets/%E8%AE%A1.../a.png"`。
 *
 * 拿 `<img src>` 去读磁盘之前必须解回来 —— 否则就是「编辑器里能显示的图（它读的是 Markdown
 * 原文），换成渲染出来的 HTML 之后变成裂图」（0.4.0 用户实测：只读阅读视图里的本机图片全丢）。
 * 解不动的**原样返回**（不是每个含 `%` 的字符串都是合法编码）。
 */
export function decodeMarkdownHref(value: string): string {
  const raw = String(value || "");
  if (!raw.includes("%")) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
