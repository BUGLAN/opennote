import MarkdownIt, { type StateBlock, type StateInline } from "markdown-it";
import { sanitizeHtml } from "./markdown";
import { escapeHtml } from "./utils";

/**
 * 阅读视图的渲染：在导出同款 markdown-it 配置上，多认三样编辑器里本来就会渲染的东西 ——
 * 行内公式 `$…$`、块公式 `$$…$$`、```` ```mermaid ```` 图表。语法边界与编辑器的
 * `editor/mdExtensions.ts`（MathInline / MathBlock）一致，读和写看到的是同一篇文章。
 *
 * 这里只输出**占位**：`data-tex` / `data-mermaid` 的元素，正文是原文（KaTeX、Mermaid 都是
 * 懒加载的大包，没载好时读者至少看到公式原文）。真正的排版由 `ReadingView` 挂载后调用
 * `editor/math`、`editor/mermaid` 的同一套渲染与缓存完成。
 *
 * 不改 `renderMarkdown()`：导出 HTML 走那一条，产物里没有运行时去补渲染。
 */
const md = new MarkdownIt({ html: true, linkify: true, breaks: false, typographer: false });

function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const first = state.src.slice(start, max);
  if (!first.startsWith("$$")) return false;
  if (silent) return true;

  let tex: string;
  let next = startLine + 1;
  const sameLine = first.indexOf("$$", 2);
  if (sameLine > -1) {
    tex = first.slice(2, sameLine);
  } else {
    // 多行：找收尾的 `$$`；没收尾就停在第一个空行（与编辑器 D13 同一条规则）。
    const lines = [first.slice(2)];
    for (; next < endLine; next += 1) {
      const text = state.src.slice(state.bMarks[next] + state.tShift[next], state.eMarks[next]);
      if (!text.trim()) break;
      const close = text.indexOf("$$");
      if (close > -1) {
        lines.push(text.slice(0, close));
        next += 1;
        break;
      }
      lines.push(text);
    }
    tex = lines.join("\n");
  }

  state.line = next;
  const token = state.push("math_block", "div", 0);
  token.block = true;
  token.content = tex.trim();
  token.map = [startLine, next];
  return true;
}

function mathInline(state: StateInline, silent: boolean): boolean {
  const { src, pos, posMax } = state;
  if (src.charCodeAt(pos) !== 0x24) return false;
  const after = src.charCodeAt(pos + 1);
  // `$$` 归块公式；开头的 `$` 必须贴着内容。
  if (after === 0x24 || after === 32 || after === 9 || after === 10 || Number.isNaN(after)) return false;
  let end = -1;
  for (let i = pos + 1; i < posMax; i += 1) {
    const code = src.charCodeAt(i);
    if (code === 0x0a) break;
    if (code === 0x5c) {
      i += 1;
      continue;
    }
    if (code === 0x24) {
      if (src.charCodeAt(i - 1) === 32) break;
      end = i;
      break;
    }
  }
  if (end <= pos + 1) return false;
  if (!silent) {
    const token = state.push("math_inline", "span", 0);
    token.content = src.slice(pos + 1, end);
  }
  state.pos = end + 1;
  return true;
}

md.block.ruler.before("fence", "math_block", mathBlock, { alt: ["paragraph", "reference", "blockquote", "list"] });
md.inline.ruler.after("escape", "math_inline", mathInline);

md.renderer.rules.math_block = (tokens, idx) => {
  const tex = escapeHtml(tokens[idx].content);
  return `<div class="md-math math-block" data-tex="${tex}">${tex}</div>\n`;
};
md.renderer.rules.math_inline = (tokens, idx) => {
  const tex = escapeHtml(tokens[idx].content);
  return `<span class="md-math" data-tex="${tex}">${tex}</span>`;
};

const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token.info.trim().split(/\s+/)[0]?.toLowerCase() === "mermaid") {
    return `<div class="mermaid-block" data-mermaid="">${escapeHtml(token.content)}</div>\n`;
  }
  return defaultFence(tokens, idx, options, env, self);
};

/** 阅读视图用的 HTML（已过 DOMPurify）。公式、图表是占位，见文件头。 */
export function renderReadingMarkdown(source: string): string {
  return sanitizeHtml(md.render(source));
}
