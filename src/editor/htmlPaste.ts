import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { renderMarkdown } from "../lib/markdown";

/**
 * 剪贴板与富文本之间的两件事（排查报告特性 1）：
 *
 * 1. **粘贴网页 / 文档里的富文本 ⇒ 变成 Markdown**。原来只认纯文本：从网页复制一段带标题、
 *    列表、链接的内容，粘进来只剩一坨文字。Typora 的做法是按 HTML 结构转成对应的 Markdown。
 * 2. **复制 ⇒ 同时给一份 HTML**。纯文本那份仍是 Markdown 源码（粘回编辑器、粘进代码编辑器
 *    都是原样），富文本那份是渲染结果 —— 粘进邮件、文档里是排好版的，而不是一堆 `**`。
 *
 * 只在「值得转」的时候转：粘贴进代码块 / 行内代码 / 表格时、HTML 里没有任何结构性标签时
 * （VS Code 之类复制出来的只是带颜色的 `<div><span>`，转了反而丢缩进）、以及 HTML 是我们
 * 自己复制出去的那份时，都走纯文本。
 */

/* ------------------------------------------------------------ HTML → Markdown */

/** 转换只用到 DOM 的这一小部分 —— 浏览器里就是真 DOM，单测里可以手搭一棵假树。 */
export interface HtmlNode {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<HtmlNode>;
  getAttribute?(name: string): string | null;
}

const TEXT = 3;
const ELEMENT = 1;

const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DETAILS", "DIALOG", "DD", "DIV", "DL", "DT", "FIELDSET",
  "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HGROUP", "HR",
  "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE", "UL",
]);
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "META", "LINK", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "BUTTON", "SVG"]);

/** 结构性标签：HTML 里一个都没有，就说明它只是「带样式的纯文本」，不值得转。 */
const STRUCTURAL = /<(?:h[1-6]|p|li|ul|ol|a\s|strong|b|em|i|img|table|blockquote|pre|code|hr|del|s|mark)\b/i;

function children(node: HtmlNode): HtmlNode[] {
  return Array.from(node.childNodes);
}

function attr(node: HtmlNode, name: string): string {
  return node.getAttribute?.(name) ?? "";
}

/** 正文里会被当成 Markdown 语法的字符转义掉（粘进来的是**文字**，不该意外变成粗体或链接）。 */
function escapeText(text: string): string {
  return text.replace(/([\\`*_[\]<>|])/g, "\\$1");
}

/** 围栏要比内容里最长的一串同字符还长（行内代码至少 1 个，代码块至少 3 个）。 */
function fenceFor(content: string, char: string, block: boolean): string {
  let longest = 0;
  for (const match of content.matchAll(new RegExp(`\\${char}+`, "g"))) longest = Math.max(longest, match[0].length);
  return char.repeat(Math.max(block ? 3 : 1, longest + 1));
}

function wrap(mark: string, inner: string): string {
  const trimmed = inner.trim();
  if (!trimmed) return inner;
  // 标记必须贴着文字：`** 粗体 **` 不是粗体。空白挪到标记外面。
  const lead = inner.slice(0, inner.length - inner.trimStart().length);
  const trail = inner.slice(inner.trimEnd().length);
  return `${lead}${mark}${trimmed}${mark}${trail}`;
}

function inline(node: HtmlNode): string {
  if (node.nodeType === TEXT) return escapeText((node.textContent ?? "").replace(/\s+/g, " "));
  if (node.nodeType !== ELEMENT) return "";
  const tag = node.nodeName.toUpperCase();
  if (SKIP_TAGS.has(tag)) return "";
  const inner = () => children(node).map(inline).join("");
  switch (tag) {
    case "BR":
      return "\n";
    case "STRONG":
    case "B":
      return wrap("**", inner());
    case "EM":
    case "I":
      return wrap("*", inner());
    case "DEL":
    case "S":
    case "STRIKE":
      return wrap("~~", inner());
    case "MARK":
      return wrap("==", inner());
    case "CODE": {
      const text = (node.textContent ?? "").replace(/\n/g, " ");
      if (!text) return "";
      const fence = fenceFor(text, "`", false);
      const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
      return `${fence}${pad}${text}${pad}${fence}`;
    }
    case "A": {
      const text = inner().trim();
      const href = attr(node, "href").trim();
      if (!href || /^javascript:/i.test(href) || href.startsWith("#")) return text;
      if (!text) return "";
      const title = attr(node, "title");
      return `[${text}](${href.replace(/\s/g, "%20")}${title ? ` "${title.replace(/"/g, '\\"')}"` : ""})`;
    }
    case "IMG": {
      const src = attr(node, "src").trim();
      if (!src) return "";
      return `![${escapeText(attr(node, "alt"))}](${src.replace(/\s/g, "%20")})`;
    }
    case "INPUT":
      return "";
    default:
      return inner();
  }
}

interface Ctx {
  /** 列表嵌套时每一行前面要补的缩进。 */
  indent: string;
}

function isBlock(node: HtmlNode): boolean {
  return node.nodeType === ELEMENT && BLOCK_TAGS.has(node.nodeName.toUpperCase());
}

/** 一串兄弟节点 → Markdown 块（块之间空一行）。行内的连续节点攒成一段。 */
function blocks(nodes: HtmlNode[], ctx: Ctx): string[] {
  const out: string[] = [];
  let buffer = "";
  const flush = () => {
    const text = buffer.replace(/[ \t]*\n[ \t]*/g, "\n").replace(/ {2,}/g, " ").trim();
    if (text) out.push(text);
    buffer = "";
  };
  for (const node of nodes) {
    if (node.nodeType === ELEMENT && SKIP_TAGS.has(node.nodeName.toUpperCase())) continue;
    if (!isBlock(node)) {
      buffer += inline(node);
      continue;
    }
    flush();
    const block = blockOf(node, ctx);
    if (block) out.push(block);
  }
  flush();
  return out;
}

function prefixLines(text: string, prefix: string, first = prefix): string {
  return text
    .split("\n")
    .map((line, i) => (i === 0 ? first : line ? prefix : prefix.trimEnd()) + line)
    .join("\n");
}

function listOf(node: HtmlNode, ctx: Ctx, ordered: boolean): string {
  const items: string[] = [];
  let index = Number.parseInt(attr(node, "start"), 10);
  if (!Number.isFinite(index)) index = 1;
  for (const child of children(node)) {
    if (child.nodeType !== ELEMENT || child.nodeName.toUpperCase() !== "LI") continue;
    const box = children(child).find((c) => c.nodeType === ELEMENT && c.nodeName.toUpperCase() === "INPUT" && attr(c, "type") === "checkbox");
    const task = box ? (box.getAttribute?.("checked") != null ? "[x] " : "[ ] ") : "";
    const marker = ordered ? `${index++}. ` : "- ";
    const pad = " ".repeat(marker.length);
    const body = blocks(children(child), ctx).join("\n\n") || "";
    items.push(prefixLines(body, pad, marker + task));
  }
  return items.join("\n");
}

function tableOf(node: HtmlNode): string {
  const rows: string[][] = [];
  const walk = (n: HtmlNode) => {
    for (const child of children(n)) {
      if (child.nodeType !== ELEMENT) continue;
      const tag = child.nodeName.toUpperCase();
      if (tag === "TR") {
        rows.push(
          children(child)
            .filter((c) => c.nodeType === ELEMENT && /^(TD|TH)$/i.test(c.nodeName))
            .map((c) => children(c).map(inline).join("").replace(/\s*\n\s*/g, " ").trim()),
        );
      } else if (/^(THEAD|TBODY|TFOOT)$/.test(tag)) walk(child);
    }
  };
  walk(node);
  if (!rows.length) return "";
  const columns = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]) => `| ${Array.from({ length: columns }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  return [line(rows[0]), `| ${new Array(columns).fill("---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
}

function blockOf(node: HtmlNode, ctx: Ctx): string {
  const tag = node.nodeName.toUpperCase();
  const heading = /^H([1-6])$/.exec(tag);
  if (heading) {
    const text = children(node).map(inline).join("").replace(/\s*\n\s*/g, " ").trim();
    return text ? `${"#".repeat(Number(heading[1]))} ${text}` : "";
  }
  switch (tag) {
    case "HR":
      return "---";
    case "PRE": {
      const code = children(node).find((c) => c.nodeType === ELEMENT && c.nodeName.toUpperCase() === "CODE");
      const lang = /(?:^|\s)(?:language|lang)-([\w+#-]+)/.exec(attr(code ?? node, "class"))?.[1] ?? "";
      const text = (node.textContent ?? "").replace(/\n$/, "");
      const fence = fenceFor(text, "`", true);
      return `${fence}${lang}\n${text}\n${fence}`;
    }
    case "BLOCKQUOTE":
      return prefixLines(blocks(children(node), ctx).join("\n\n"), "> ");
    case "UL":
      return listOf(node, ctx, false);
    case "OL":
      return listOf(node, ctx, true);
    case "TABLE":
      return tableOf(node);
    default:
      return blocks(children(node), ctx).join("\n\n");
  }
}

/** HTML 片段（已解析成节点树）→ Markdown。 */
export function htmlToMarkdown(root: HtmlNode): string {
  return blocks(children(root), { indent: "" })
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 这份 HTML 值得按结构转成 Markdown 吗（见文件头）。 */
export function worthConverting(html: string): boolean {
  if (!html || html.includes("data-opennote-md")) return false;
  return STRUCTURAL.test(html);
}

/** 光标在代码里 / 表格里：粘贴一律走纯文本。 */
function plainOnly(state: EditorState): boolean {
  const pos = state.selection.main.from;
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (/^(?:FencedCode|CodeBlock|InlineCode|Table|MathBlock|InlineMath|FrontMatter)$/.test(node.name)) return true;
  }
  return false;
}

/* ------------------------------------------------------------ 扩展 */

export const htmlClipboard: Extension = EditorView.domEventHandlers({
  paste(event, view) {
    const data = event.clipboardData;
    if (!data || typeof DOMParser === "undefined") return false;
    // 有文件（截图、拖进来的图片）交给 media.ts —— 它注册在前面，这里只是兜底
    if (data.files?.length) return false;
    const html = data.getData("text/html");
    if (!worthConverting(html) || plainOnly(view.state)) return false;
    const body = new DOMParser().parseFromString(html, "text/html").body as unknown as HtmlNode;
    const markdown = htmlToMarkdown(body);
    if (!markdown) return false;
    event.preventDefault();
    view.dispatch(view.state.replaceSelection(markdown), { userEvent: "input.paste", scrollIntoView: true });
    return true;
  },
  copy(event, view) {
    return copyWithHtml(event, view, false);
  },
  cut(event, view) {
    return copyWithHtml(event, view, true);
  },
});

/**
 * 有选区时复制：纯文本是 Markdown 源码（与 CodeMirror 默认一致），再附一份渲染好的 HTML。
 * 没有选区（CodeMirror 的「整行复制」）照旧交给默认处理。
 */
function copyWithHtml(event: ClipboardEvent, view: EditorView, cut: boolean): boolean {
  const data = event.clipboardData;
  const { state } = view;
  if (!data || state.selection.ranges.every((range) => range.empty)) return false;
  const text = state.selection.ranges
    .filter((range) => !range.empty)
    .map((range) => state.sliceDoc(range.from, range.to))
    .join(state.lineBreak);
  event.preventDefault();
  data.clearData();
  data.setData("text/plain", text);
  data.setData("text/html", `<div data-opennote-md="">${renderMarkdown(text)}</div>`);
  if (cut && !state.readOnly) {
    view.dispatch({ changes: state.selection.ranges.map((range) => ({ from: range.from, to: range.to })), scrollIntoView: true, userEvent: "delete.cut" });
  }
  return true;
}
