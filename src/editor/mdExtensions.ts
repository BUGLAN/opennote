import {
  GFM,
  parser as baseParser,
  type BlockContext,
  type BlockParser,
  type InlineContext,
  type InlineParser,
  type Line,
  type MarkdownConfig,
  type MarkdownExtension,
} from "@lezer/markdown";

/* ------------------------------------------------------------- inline math */

/** `$E = mc^2$` — the opening `$` must hug its content, the closing `$` must not follow a space. */
export const MathInline: InlineParser = {
  name: "MathInline",
  parse(cx: InlineContext, next: number, pos: number) {
    if (next !== 0x24 /* $ */) return -1;
    if (cx.char(pos + 1) === 0x24) return -1; // `$$` belongs to block math
    const after = cx.char(pos + 1);
    if (after === 32 || after === 9 || after === 10 || after < 0) return -1;
    let end = -1;
    // positions are document-relative: always read through cx.char()
    for (let i = pos + 1; i < cx.end; i += 1) {
      const code = cx.char(i);
      if (code === 0x0a) break;
      if (code === 0x5c /* \ */) {
        i += 1;
        continue;
      }
      if (code === 0x24) {
        if (cx.char(i - 1) === 32) break;
        end = i;
        break;
      }
    }
    if (end <= pos + 1) return -1;
    return cx.addElement(cx.elt("InlineMath", pos, end + 1));
  },
  before: "Emphasis",
};

/* -------------------------------------------------------------- block math */

/**
 * `$$ … $$` — one line or many. A closed block spans everything up to its closing
 * fence. An *unclosed* block stops at the first blank line instead of running to
 * the end of the document (D13): otherwise the whole rest of the note becomes a
 * single formula widget and its headings/paragraphs vanish from the rendered view.
 * A block that is never closed and has no blank line after it still runs to the
 * end, exactly like a code fence.
 */
export const MathBlock: BlockParser = {
  name: "MathBlock",
  parse(cx: BlockContext, line: Line) {
    const text = line.text.slice(line.pos);
    if (!text.startsWith("$$")) return false;
    const start = cx.lineStart + line.pos;
    const lineEnd = cx.lineStart + line.text.length;
    const sameLine = text.indexOf("$$", 2);

    if (sameLine > -1) {
      // `$$E = mc^2$$` on a single line
      cx.addElement(cx.elt("MathBlock", start, Math.min(start + sameLine + 2, lineEnd)));
      // an eager parser that returns true must consume the line, otherwise the
      // block context re-parses it for ever
      cx.nextLine();
      return true;
    }

    // multi-line: scan forward for the closing fence, then step past it so the
    // block context keeps tracking the right line (same dance as FencedCode).
    // A blank line ends the scan: it is the boundary between this (so far
    // unclosed) formula and the rest of the note.
    let to = -1;
    while (cx.nextLine()) {
      const rest = line.text.slice(line.pos);
      if (!rest.trim()) break;
      if (rest.indexOf("$$") > -1) {
        cx.nextLine();
        to = cx.prevLineEnd();
        break;
      }
    }
    if (to < 0 || to < start) to = Math.max(cx.prevLineEnd(), lineEnd);
    cx.addElement(cx.elt("MathBlock", start, to));
    return true;
  },
  endLeaf: (_cx, line) => line.text.slice(line.pos).startsWith("$$"),
};

/* ------------------------------------------------------------- front matter */

/**
 * 文件开头的 YAML front matter（剪藏的笔记一律带着它）。
 *
 * 不认它的话，`---` 被当成分隔线、`title: x` 加下一行的 `---` 成了**二级标题** —— 元数据
 * 直接被渲染成正文（排查报告特性 3）。
 *
 * 判定规则必须与 `lib/utils.ts` 的 `splitFrontMatter()` **逐字一致**（侧栏标签、阅读视图、
 * 自动改名都按它切）：文件最开头（允许 BOM）一行 `---`，之后至少一行，再以一行 `---`（可带
 * 行尾空白）收尾。没闭合就**不是** front matter —— 否则一个开头的分隔线会把整篇吞成元数据。
 *
 * 为什么要读 `cx.input`：块解析器一旦 `nextLine()` 就回不了头，而「有没有闭合」必须在消费任何
 * 一行之前就知道。`input` 在类型上是 `@internal`，拿不到就安静地不认 front matter（退回旧行为）。
 */
const FRONT_MATTER_RE = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
/** front matter 不会长到这个程度；只读文件头这一段，不把整篇读进来。 */
const FRONT_MATTER_SCAN = 64 * 1024;

export const FrontMatter: BlockParser = {
  name: "FrontMatter",
  parse(cx: BlockContext, line: Line) {
    if (cx.lineStart !== 0 || line.text.replace(/^\uFEFF/, "") !== "---") return false;
    const input = (cx as unknown as { input?: { length: number; read(from: number, to: number): string } }).input;
    if (!input || typeof input.read !== "function") return false;
    const head = input.read(0, Math.min(input.length, FRONT_MATTER_SCAN));
    const match = FRONT_MATTER_RE.exec(head);
    if (!match) return false;
    const end = match[0].replace(/\r?\n$/, "").length;
    const marks = [cx.elt("FrontMatterMark", 0, line.text.length)];
    let closeFrom = -1;
    while (cx.nextLine()) {
      const lineEnd = cx.lineStart + line.text.length;
      if (lineEnd >= end) {
        closeFrom = cx.lineStart;
        cx.nextLine();
        break;
      }
    }
    if (closeFrom >= 0) marks.push(cx.elt("FrontMatterMark", closeFrom, closeFrom + 3));
    cx.addElement(cx.elt("FrontMatter", 0, end, marks));
    return true;
  },
  before: "HorizontalRule",
};

/* --------------------------------------------------------------- highlight */

/** `==重要==` — markdown has no highlight; Typora users expect it anyway. */
export const HighlightInline: InlineParser = {
  name: "Highlight",
  parse(cx: InlineContext, next: number, pos: number) {
    if (next !== 0x3d /* = */ || cx.char(pos + 1) !== 0x3d) return -1;
    let close = -1;
    for (let i = pos + 2; i < cx.end - 1; i += 1) {
      const code = cx.char(i);
      if (code === 0x0a) break;
      if (code === 0x3d && cx.char(i + 1) === 0x3d) {
        close = i;
        break;
      }
    }
    if (close < 0) return -1;
    const label = cx.slice(pos + 2, close);
    if (!label.trim()) return -1;
    return cx.addElement(
      cx.elt("Highlight", pos, close + 2, [
        cx.elt("HighlightMark", pos, pos + 2),
        cx.elt("HighlightMark", close, close + 2),
      ]),
    );
  },
  before: "Emphasis",
};

/* -------------------------------------------------------------- wiki links */

/** `[[笔记标题]]` — links between notes without leaving markdown. */
export const WikiLinkInline: InlineParser = {
  name: "WikiLink",
  parse(cx: InlineContext, next: number, pos: number) {
    if (next !== 0x5b /* [ */ || cx.char(pos + 1) !== 0x5b) return -1;
    let close = -1;
    for (let i = pos + 2; i < cx.end - 1; i += 1) {
      const code = cx.char(i);
      if (code === 0x0a || code === 0x5b /* [ */) break;
      if (code === 0x5d /* ] */ && cx.char(i + 1) === 0x5d) {
        close = i;
        break;
      }
    }
    if (close < 0) return -1;
    const label = cx.slice(pos + 2, close);
    if (!label.trim()) return -1;
    return cx.addElement(
      cx.elt("WikiLink", pos, close + 2, [
        cx.elt("WikiLinkMark", pos, pos + 2),
        cx.elt("WikiLinkMark", close, close + 2),
      ]),
    );
  },
  before: "Link",
};

export const opennoteMarkdown: MarkdownExtension = [
  {
    defineNodes: [
      "InlineMath",
      "MathBlock",
      "Highlight",
      "HighlightMark",
      "WikiLink",
      "WikiLinkMark",
      { name: "FrontMatter", block: true },
      "FrontMatterMark",
    ],
  },
  { parseInline: [MathInline, HighlightInline, WikiLinkInline] },
  { parseBlock: [FrontMatter, MathBlock] },
];

/** The same parser the editor uses, without any CodeMirror dependency. */
export const opennoteParser = baseParser.configure([GFM, opennoteMarkdown] as MarkdownConfig[]);
