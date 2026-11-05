import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type ChangeSpec, type EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import type { Command, EditorView } from "@codemirror/view";

/**
 * 每种行内标记对应的语法节点。判断「这段已经是粗体了吗」必须问语法树，不能看两边的字符：
 * `**粗体**` 里的「粗体」两边各有一个 `*`，按字符判就会以为它是斜体、把粗体拆成 `*粗体*`
 * （排查报告问题 7）。
 */
const WRAP_NODES: Record<string, string> = {
  "**": "StrongEmphasis",
  "*": "Emphasis",
  "~~": "Strikethrough",
  "==": "Highlight",
  "`": "InlineCode",
};

/** 节点首尾两个标记子节点（`**`…`**`），拿不到就是 null。 */
function wrapMarks(node: SyntaxNode): { open: SyntaxNode; close: SyntaxNode } | null {
  const open = node.firstChild;
  const close = node.lastChild;
  if (!open || !close || open === close || !/Mark$/.test(open.name) || !/Mark$/.test(close.name)) return null;
  return { open, close };
}

/**
 * 包住 `[from, to]` 的那个 `type` 节点。没有选区时要求光标在**内容**里（`**粗|体**`），
 * 光标贴在收尾标记后面（`**粗体**|`）不算 —— 那里按 ⌘B 是要开始一段新的粗体。
 */
function enclosingNode(state: EditorState, from: number, to: number, type: string): SyntaxNode | null {
  const tree = syntaxTree(state);
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(from, side); node; node = node.parent) {
      if (node.name !== type || node.from > from || node.to < to) continue;
      const marks = wrapMarks(node);
      if (!marks) continue;
      if (from === to && (from < marks.open.to || from > marks.close.from)) continue;
      return node;
    }
  }
  return null;
}

/** Wrap (or unwrap) the selection with markdown delimiters. */
export function toggleWrap(before: string, after = before, placeholder = "文本"): Command {
  return (view) => {
    const { state } = view;
    const type = WRAP_NODES[before];
    const spec = state.changeByRange((range) => {
      const node = type ? enclosingNode(state, range.from, range.to, type) : null;
      const marks = node ? wrapMarks(node) : null;
      if (marks) {
        // 已经是这种格式 ⇒ 去掉首尾标记；选区跟着内容走
        const changes = state.changes([
          { from: marks.open.from, to: marks.open.to },
          { from: marks.close.from, to: marks.close.to },
        ]);
        return {
          changes,
          range: EditorSelection.range(changes.mapPos(range.anchor, -1), changes.mapPos(range.head, -1)),
        };
      }
      const text = state.sliceDoc(range.from, range.to);
      const body = text || placeholder;
      return {
        changes: { from: range.from, to: range.to, insert: before + body + after },
        range: EditorSelection.range(range.from + before.length, range.from + before.length + body.length),
      };
    });
    view.dispatch(spec, { userEvent: "input.format", scrollIntoView: true });
    view.focus();
    return true;
  };
}

export const toggleBold = toggleWrap("**", "**", "粗体");
export const toggleItalic = toggleWrap("*", "*", "斜体");
export const toggleStrike = toggleWrap("~~", "~~", "删除线");
export const toggleHighlight = toggleWrap("==", "==", "高亮");
export const toggleInlineCode = toggleWrap("`", "`", "code");

/* ------------------------------------------------------------- line anatomy */

/**
 * 一行的块级结构：`<缩进><引用 >…><列表标记><## >正文`。
 *
 * 设标题、换列表类型都只该动**自己那一段**：在 `- 项` 上设二级标题是 `- ## 项`（标题在
 * 列表项里），不是 `## - 项`；把 `- 项` 换成有序列表是替换掉 `- `，不是在前面再叠一个
 * `1. `（排查报告问题 8）。
 */
const LINE_ANATOMY =
  /^([ \t]*(?:(?:>[ \t]?)+[ \t]*)?)((?:[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+)?)((?:#{1,6}(?:[ \t]+|$))?)/;

interface LineAnatomy {
  /** 列表标记的起止（没有列表时两者相等，落在容器前缀之后）。 */
  listFrom: number;
  listTo: number;
  list: "bullet" | "task" | "ordered" | null;
  /** 标题标记的起止与级别（0 = 不是标题）。 */
  headingFrom: number;
  headingTo: number;
  level: number;
}

function anatomy(line: { from: number; text: string }): LineAnatomy {
  const match = LINE_ANATOMY.exec(line.text);
  const container = match?.[1] ?? "";
  const listText = match?.[2] ?? "";
  const headingText = match?.[3] ?? "";
  const listFrom = line.from + container.length;
  const listTo = listFrom + listText.length;
  const list = !listText ? null : /^\d/.test(listText) ? "ordered" : /\[[ xX]\]/.test(listText) ? "task" : "bullet";
  return {
    listFrom,
    listTo,
    list,
    headingFrom: listTo,
    headingTo: listTo + headingText.length,
    level: (/^#+/.exec(headingText)?.[0].length ?? 0),
  };
}

/* ------------------------------------------------------------------ headings */

export function setHeading(level: number): Command {
  return (view) => {
    const { state } = view;
    const spec = state.changeByRange((range) => {
      const line = state.doc.lineAt(range.from);
      const parts = anatomy(line);
      const insert = parts.level === level ? "" : `${"#".repeat(level)} `;
      const strip = parts.headingTo - parts.headingFrom;
      const anchor = Math.max(parts.headingFrom + insert.length, range.from - strip + insert.length);
      return {
        changes: { from: parts.headingFrom, to: parts.headingTo, insert },
        range: EditorSelection.cursor(anchor),
      };
    });
    view.dispatch(spec, { userEvent: "input.format", scrollIntoView: true });
    view.focus();
    return true;
  };
}

/* --------------------------------------------------------------- line prefixes */

type PrefixKind = "bullet" | "ordered" | "task" | "quote";

const QUOTE_PATTERN = /^([ \t]*)>[ \t]?/;

export function toggleLinePrefix(kind: PrefixKind): Command {
  return (view) => {
    const { state } = view;
    const lines = selectedLines(state.doc, state.selection.main.from, state.selection.main.to);
    const changes: ChangeSpec[] = [];

    if (kind === "quote") {
      const allQuoted = lines.every((line) => QUOTE_PATTERN.test(line.text));
      for (const line of lines) {
        const match = QUOTE_PATTERN.exec(line.text);
        if (allQuoted) {
          if (match) changes.push({ from: line.from + match[1].length, to: line.from + match[0].length, insert: "" });
          continue;
        }
        const indent = /^[ \t]*/.exec(line.text)?.[0] ?? "";
        changes.push({ from: line.from + indent.length, insert: "> " });
      }
    } else {
      const allPrefixed = lines.every((line) => anatomy(line).list === kind);
      let counter = 1;
      for (const line of lines) {
        const parts = anatomy(line);
        if (allPrefixed) {
          changes.push({ from: parts.listFrom, to: parts.listTo, insert: "" });
          continue;
        }
        const marker = kind === "bullet" ? "- " : kind === "ordered" ? `${counter++}. ` : "- [ ] ";
        // 已经是另一种列表 ⇒ 换掉它的标记；不是列表 ⇒ 插在容器前缀（缩进、引用）之后
        changes.push({ from: parts.listFrom, to: parts.listTo, insert: marker });
      }
    }

    if (!changes.length) return false;
    view.dispatch({ changes, userEvent: "input.format", scrollIntoView: true });
    view.focus();
    return true;
  };
}

function selectedLines(doc: EditorView["state"]["doc"], from: number, to: number) {
  const first = doc.lineAt(from).number;
  const last = doc.lineAt(to).number;
  const lines = [];
  for (let n = first; n <= last; n += 1) lines.push(doc.line(n));
  return lines;
}

/* --------------------------------------------------------------- block inserts */

/** Insert a block of markdown, keeping a blank line around it when needed. */
export function insertBlock(text: string, cursorOffset?: number, selectLength = 0): Command {
  return (view) => {
    const { state } = view;
    const range = state.selection.main;
    const line = state.doc.lineAt(range.from);
    const atLineStart = line.from === range.from;
    const before = atLineStart ? "" : "\n";
    const insert = `${before}${text}`;
    const cursor = range.from + before.length + (cursorOffset ?? text.length);
    view.dispatch({
      changes: { from: range.from, to: range.to, insert },
      selection: { anchor: cursor, head: cursor + selectLength },
      userEvent: "input.format",
      scrollIntoView: true,
    });
    view.focus();
    return true;
  };
}

export const insertCodeBlock = insertBlock("```\n\n```", 4);
export const insertMathBlock = insertBlock("$$\n\n$$", 3);
export const insertMermaidBlock = insertBlock(
  "```mermaid\ngraph TD\n  A[开始] --> B[结束]\n```",
  25,
);
export const insertTable = insertBlock(
  "| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |",
  2,
  3,
);
export const insertHorizontalRule = insertBlock("---\n");
export const insertTaskItem = insertBlock("- [ ] ");

export function insertLink(): Command {
  return (view) => {
    const { state } = view;
    const range = state.selection.main;
    const text = state.sliceDoc(range.from, range.to);
    const looksLikeUrl = /^(https?:\/\/|mailto:)\S+$/i.test(text.trim());
    const label = looksLikeUrl ? text.trim() : text || "链接文字";
    const url = looksLikeUrl ? "" : "https://";
    const insert = `[${label}](${url})`;
    const urlStart = range.from + 1 + label.length + 2;
    view.dispatch({
      changes: { from: range.from, to: range.to, insert },
      selection: looksLikeUrl
        ? { anchor: range.from, head: range.from + insert.length }
        : { anchor: urlStart, head: urlStart + url.length },
      userEvent: "input.format",
      scrollIntoView: true,
    });
    view.focus();
    return true;
  };
}

export function insertWikiLink(): Command {
  return insertBlock("[[]]", 2, 0);
}

/** Strip markdown syntax from the selection — handy when pasting formatted text. */
export function clearFormatting(): Command {
  return (view) => {
    const { state } = view;
    const spec = state.changeByRange((range) => {
      if (range.empty) return { range };
      const text = state.sliceDoc(range.from, range.to);
      const plain = text
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/(\*\*|__|\*|_|~~|==|`)/g, "")
        .replace(/^#{1,6}[ \t]+/gm, "")
        .replace(/^[ \t]*>[ \t]?/gm, "");
      return {
        changes: { from: range.from, to: range.to, insert: plain },
        range: EditorSelection.range(range.from, range.from + plain.length),
      };
    });
    view.dispatch(spec, { userEvent: "input.format" });
    view.focus();
    return true;
  };
}

export const markdownCommands: Record<string, Command> = {
  bold: toggleBold,
  italic: toggleItalic,
  strike: toggleStrike,
  highlight: toggleHighlight,
  inlineCode: toggleInlineCode,
  h1: setHeading(1),
  h2: setHeading(2),
  h3: setHeading(3),
  h4: setHeading(4),
  h5: setHeading(5),
  h6: setHeading(6),
  bullet: toggleLinePrefix("bullet"),
  ordered: toggleLinePrefix("ordered"),
  task: toggleLinePrefix("task"),
  quote: toggleLinePrefix("quote"),
  codeBlock: insertCodeBlock,
  mathBlock: insertMathBlock,
  mermaid: insertMermaidBlock,
  table: insertTable,
  hr: insertHorizontalRule,
  link: insertLink(),
  wikiLink: insertWikiLink(),
  clearFormatting: clearFormatting(),
};
