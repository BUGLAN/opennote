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
  { defineNodes: ["InlineMath", "MathBlock", "Highlight", "HighlightMark", "WikiLink", "WikiLinkMark"] },
  { parseInline: [MathInline, HighlightInline, WikiLinkInline] },
  { parseBlock: [MathBlock] },
];

/** The same parser the editor uses, without any CodeMirror dependency. */
export const opennoteParser = baseParser.configure([GFM, opennoteMarkdown] as MarkdownConfig[]);
