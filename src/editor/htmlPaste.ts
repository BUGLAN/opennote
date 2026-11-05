import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
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

const PUNCT = /\p{P}/u;

/**
 * 给一段行内内容套上标记（`**`、`*`、`~~`、`==`）。
 *
 * 两条 CommonMark 边界规则必须在这里满足，否则标记会原样露出来：
 * - 标记必须贴着文字：`** 粗体 **` 不是粗体 —— 空白挪到标记外面；
 * - 标点结尾 / 开头时，收尾标记后面紧跟汉字就不成立（`**注意：**这里`）—— 中文网页里最常见的
 *   写法。把首尾的标点挪到标记外面（`**注意**：这里`），渲染结果只差那个标点不加粗（审查报告 B4）。
 */
function wrap(mark: string, inner: string): string {
  const trimmed = inner.trim();
  if (!trimmed) return inner;
  const lead = inner.slice(0, inner.length - inner.trimStart().length);
  const trail = inner.slice(inner.trimEnd().length);
  let head = "";
  let body = trimmed;
  let tail = "";
  while (body && PUNCT.test(body[0]) && !/^[\\`*_[\]<>|]/.test(body)) {
    head += body[0];
    body = body.slice(1);
  }
  while (body && PUNCT.test(body[body.length - 1]) && !/[\\`*_[\]<>|)]$/.test(body)) {
    tail = body[body.length - 1] + tail;
    body = body.slice(0, -1);
  }
  if (!body.trim()) return `${lead}${trimmed}${trail}`;
  return `${lead}${head}${mark}${body}${mark}${tail}${trail}`;
}

/** 链接 / 图片地址：空白与括号百分号编码 —— `)` 会提前结束 `(…)`，`https://x.com/a)b` 就断了。 */
function encodeUrl(url: string): string {
  return url.replace(/\s/g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** 再大的 data: 图片就不内联进 .md 了（一张截图就是几百 KB 的一行 base64）。 */
const MAX_INLINE_DATA_URL = 4096;

/** `<pre>` 里的文字：`<br>` 也是换行（`textContent` 会把它吞掉）。 */
function preText(node: HtmlNode): string {
  if (node.nodeType === TEXT) return node.textContent ?? "";
  if (node.nodeType !== ELEMENT) return "";
  if (node.nodeName.toUpperCase() === "BR") return "\n";
  return children(node).map(preText).join("");
}

/** KaTeX / 本应用渲染出来的公式：取回 TeX 原文，而不是 MathML 与字形拼出来的乱码。 */
function texOf(node: HtmlNode): { tex: string; display: boolean } | null {
  const dataTex = node.getAttribute?.("data-tex");
  const cls = attr(node, "class");
  if (dataTex != null) return { tex: dataTex, display: /\bmath-block\b/.test(cls) };
  if (!/\bkatex(?:-display)?\b/.test(cls)) return null;
  const find = (n: HtmlNode): string | null => {
    if (n.nodeType === ELEMENT && n.nodeName.toUpperCase() === "ANNOTATION" && attr(n, "encoding") === "application/x-tex") {
      return n.textContent ?? "";
    }
    for (const child of children(n)) {
      const hit = find(child);
      if (hit != null) return hit;
    }
    return null;
  };
  const tex = find(node);
  return tex == null ? null : { tex: tex.trim(), display: /\bkatex-display\b/.test(cls) };
}

function inline(node: HtmlNode): string {
  if (node.nodeType === TEXT) return escapeText((node.textContent ?? "").replace(/\s+/g, " "));
  if (node.nodeType !== ELEMENT) return "";
  const tag = node.nodeName.toUpperCase();
  if (SKIP_TAGS.has(tag)) return "";
  const math = texOf(node);
  if (math) return math.display ? `\n$$\n${math.tex}\n$$\n` : `$${math.tex}$`;
  const inner = () => children(node).map(inline).join("");
  switch (tag) {
    case "BR":
      return "\n";
    case "STRONG":
    case "B":
      // Google Docs 把整篇包在 `<b style="font-weight:normal">` 里 —— 那不是加粗
      if (/font-weight\s*:\s*(?:normal|400)/i.test(attr(node, "style"))) return inner();
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
      if (!href || /^(?:javascript|vbscript|data):/i.test(href) || href.startsWith("#")) return text;
      if (!text) return "";
      const title = attr(node, "title");
      return `[${text}](${encodeUrl(href)}${title ? ` "${title.replace(/"/g, '\\"')}"` : ""})`;
    }
    case "IMG": {
      const src = attr(node, "src").trim();
      const alt = escapeText(attr(node, "alt"));
      if (!src) return "";
      if (/^data:/i.test(src) && src.length > MAX_INLINE_DATA_URL) return alt;
      return `![${alt}](${encodeUrl(src)})`;
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

/** 这个行内元素里面包着块级元素吗（`<b><p>…</p><p>…</p></b>`、`<a><div>标题</div><p>描述</p></a>`）。 */
function containsBlock(node: HtmlNode): boolean {
  if (node.nodeType !== ELEMENT) return false;
  return children(node).some((child) => isBlock(child) || containsBlock(child));
}

/**
 * 段落里每一行的行首：会被当成块级语法的写法转义掉 —— 粘进来的是**文字**，
 * `2024. 是个好年` 不该变成有序列表，`- 号` 不该变成列表项，`# 号` 不该变成标题。
 */
function escapeLineStarts(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/^(\d+)([.)])(?=\s|$)/, "$1\\$2")
        .replace(/^([-+*])(?=\s|$)/, "\\$1")
        .replace(/^(#{1,6})(?=\s|$)/, "\\$1")
        .replace(/^>/, "\\>"),
    )
    .join("\n");
}

/** 一串兄弟节点 → Markdown 块（块之间空一行）。行内的连续节点攒成一段。 */
function blocks(nodes: HtmlNode[], ctx: Ctx): string[] {
  const out: string[] = [];
  let buffer = "";
  const flush = () => {
    const text = buffer.replace(/[ \t]*\n[ \t]*/g, "\n").replace(/ {2,}/g, " ").trim();
    if (text) out.push(escapeLineStarts(text));
    buffer = "";
  };
  for (const node of nodes) {
    if (node.nodeType === ELEMENT && SKIP_TAGS.has(node.nodeName.toUpperCase())) continue;
    if (!isBlock(node)) {
      // 包着块的行内元素当成透明容器：按块展开它的子节点（审查报告 B2，Google Docs / 网页卡片）
      if (containsBlock(node)) {
        flush();
        out.push(...blocks(children(node), ctx));
        continue;
      }
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
  let lastPad = "  ";
  for (const child of children(node)) {
    if (child.nodeType !== ELEMENT) continue;
    const tag = child.nodeName.toUpperCase();
    // 不规范的嵌套（很多所见即所得编辑器这么写）：`<ul><li>a</li><ul>…</ul></ul>` ——
    // 嵌套列表直接挂在 `<ul>` 下面。挂到上一项里，而不是静默丢掉（审查报告 B9）
    if (tag === "UL" || tag === "OL") {
      const nested = listOf(child, ctx, tag === "OL");
      if (!nested) continue;
      if (items.length) items[items.length - 1] += `\n${prefixLines(nested, lastPad)}`;
      else items.push(nested);
      continue;
    }
    if (tag !== "LI") continue;
    const box = children(child).find((c) => c.nodeType === ELEMENT && c.nodeName.toUpperCase() === "INPUT" && attr(c, "type") === "checkbox");
    const task = box ? (box.getAttribute?.("checked") != null ? "[x] " : "[ ] ") : "";
    const marker = ordered ? `${index++}. ` : "- ";
    lastPad = " ".repeat(marker.length);
    const body = blocks(children(child), ctx).join("\n\n") || "";
    items.push(prefixLines(body, lastPad, marker + task));
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
        const cells: string[] = [];
        for (const c of children(child)) {
          if (c.nodeType !== ELEMENT || !/^(TD|TH)$/i.test(c.nodeName)) continue;
          const text = children(c)
            .map(inline)
            .join("")
            .replace(/\s*\n\s*/g, " ")
            .trim()
            // 格子里没转义的 `|`（行内代码里的）也会把格子拆开 —— GFM 允许在代码里写 `\|`
            .replace(/(\\*)\|/g, (all, slashes: string) => (slashes.length % 2 ? all : `${slashes}\\|`));
          cells.push(text);
          // 合并单元格：后面补空格子，列才对得上
          const span = Number.parseInt(attr(c, "colspan"), 10);
          for (let i = 1; Number.isFinite(span) && i < Math.min(span, 50); i += 1) cells.push("");
        }
        rows.push(cells);
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
    const text = children(node)
      .map(inline)
      .join("")
      .replace(/\s*\n\s*/g, " ")
      .trim()
      // 结尾的 ` #` 会被当成 ATX 的收尾标记吞掉（`## C #` 显示成 `C`）
      .replace(/(\s)(#+)$/, "$1\\$2");
    return text ? `${"#".repeat(Number(heading[1]))} ${text}` : "";
  }
  const math = texOf(node);
  if (math) return math.display ? `$$\n${math.tex}\n$$` : `$${math.tex}$`;
  switch (tag) {
    case "HR":
      return "---";
    case "PRE": {
      const code = children(node).find((c) => c.nodeType === ELEMENT && c.nodeName.toUpperCase() === "CODE");
      const lang = /(?:^|\s)(?:language|lang)-([\w+#-]+)/.exec(attr(code ?? node, "class"))?.[1] ?? "";
      const text = preText(node).replace(/\n$/, "");
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

const CODE_LIKE = /^(?:FencedCode|CodeBlock|InlineCode|MathBlock|InlineMath|FrontMatter)$/;

/** `pos` 落在代码 / 公式 / 元数据（以及表格，粘贴时）里吗。 */
function insideCode(state: EditorState, pos: number, side: -1 | 1, alsoTable: boolean): boolean {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); node; node = node.parent) {
    if (CODE_LIKE.test(node.name) || (alsoTable && node.name === "Table")) return true;
  }
  return false;
}

/** 光标在代码里 / 表格里：粘贴一律走纯文本。 */
function plainOnly(state: EditorState): boolean {
  return insideCode(state, state.selection.main.from, -1, true);
}

/* ------------------------------------------------------------ 复制附带 HTML */

/**
 * 复制 / 剪切：**纯文本那份仍由 CodeMirror 自己写**（整行复制、`lastLinewiseCopy` 这些内部
 * 状态都由它维护），我们只在它写完之后补一份 `text/html`。
 *
 * 所以分两段：捕获阶段（在 CodeMirror 的处理器之前）记下选区与「是不是代码」—— 剪切时
 * CodeMirror 会当场删掉选区，之后就看不到了；冒泡阶段（在它之后）读出它写好的纯文本、补上 HTML。
 *
 * 选区在代码 / 公式里时不补 HTML：代码按 Markdown 渲染，`# 注释` 会变成标题、`__init__` 变成
 * 粗体，粘进 Slack / 邮件这类优先读 HTML 的地方就坏了（审查报告 B3）。
 */
const copyHtml = ViewPlugin.fromClass(
  class {
    private pendingCode: boolean | null = null;
    private readonly capture = (event: Event) => {
      const { state } = this.view;
      const ranges = state.selection.ranges.filter((range) => !range.empty);
      this.pendingCode = ranges.length
        ? ranges.some((range) => insideCode(state, range.from, 1, false) || insideCode(state, range.to, -1, false))
        : null;
      void event;
    };
    private readonly bubble = (event: Event) => {
      const code = this.pendingCode;
      this.pendingCode = null;
      const data = (event as ClipboardEvent).clipboardData;
      if (code !== false || !data || !event.defaultPrevented) return;
      const text = data.getData("text/plain");
      if (!text) return;
      data.setData("text/html", `<div data-opennote-md="">${renderMarkdown(text)}</div>`);
    };

    constructor(readonly view: EditorView) {
      for (const type of ["copy", "cut"]) {
        view.dom.addEventListener(type, this.capture, true);
        view.dom.addEventListener(type, this.bubble);
      }
    }

    destroy() {
      for (const type of ["copy", "cut"]) {
        this.view.dom.removeEventListener(type, this.capture, true);
        this.view.dom.removeEventListener(type, this.bubble);
      }
    }
  },
);

/* ------------------------------------------------------------ 扩展 */

const pasteHtml = EditorView.domEventHandlers({
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
});

export const htmlClipboard: Extension = [pasteHtml, copyHtml];
