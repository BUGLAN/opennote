import { EditorSelection, type ChangeSpec } from "@codemirror/state";
import type { Command, EditorView } from "@codemirror/view";

/** Wrap (or unwrap) the selection with markdown delimiters. */
export function toggleWrap(before: string, after = before, placeholder = "文本"): Command {
  return (view) => {
    const { state } = view;
    const spec = state.changeByRange((range) => {
      const text = state.sliceDoc(range.from, range.to);
      const outerFrom = range.from - before.length;
      const outerTo = range.to + after.length;
      const wrappedOutside =
        outerFrom >= 0 &&
        outerTo <= state.doc.length &&
        state.sliceDoc(outerFrom, range.from) === before &&
        state.sliceDoc(range.to, outerTo) === after;

      if (wrappedOutside) {
        return {
          changes: [
            { from: outerFrom, to: range.from, insert: "" },
            { from: range.to, to: outerTo, insert: "" },
          ],
          range: EditorSelection.range(outerFrom, outerTo - before.length - after.length),
        };
      }
      if (text.length > before.length + after.length && text.startsWith(before) && text.endsWith(after)) {
        const inner = text.slice(before.length, text.length - after.length);
        return {
          changes: { from: range.from, to: range.to, insert: inner },
          range: EditorSelection.range(range.from, range.from + inner.length),
        };
      }
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

/* ------------------------------------------------------------------ headings */

export function setHeading(level: number): Command {
  return (view) => {
    const { state } = view;
    const spec = state.changeByRange((range) => {
      const line = state.doc.lineAt(range.from);
      const match = /^(#{1,6})[ \t]+/.exec(line.text);
      const strip = match ? match[0].length : 0;
      const current = match ? match[1].length : 0;
      const insert = current === level ? "" : `${"#".repeat(level)} `;
      const anchor = Math.max(line.from + insert.length, range.from - strip + insert.length);
      return {
        changes: { from: line.from, to: line.from + strip, insert },
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

const PREFIX_PATTERNS: Record<PrefixKind, RegExp> = {
  bullet: /^([ \t]*)[-*+][ \t]+/,
  ordered: /^([ \t]*)\d+[.)][ \t]+/,
  task: /^([ \t]*)[-*+][ \t]+\[[ xX]\][ \t]+/,
  quote: /^([ \t]*)>[ \t]?/,
};

export function toggleLinePrefix(kind: PrefixKind): Command {
  return (view) => {
    const { state } = view;
    const lines = selectedLines(state.doc, state.selection.main.from, state.selection.main.to);
    const pattern = PREFIX_PATTERNS[kind];
    const allPrefixed = lines.every((line) => pattern.test(line.text));
    const changes: ChangeSpec[] = [];
    let counter = 1;

    for (const line of lines) {
      const match = pattern.exec(line.text);
      if (allPrefixed) {
        if (match) changes.push({ from: line.from, to: line.from + match[0].length, insert: "" });
        continue;
      }
      const indent = /^[ \t]*/.exec(line.text)?.[0] ?? "";
      const rest = match ? line.text.slice(match[0].length) : line.text.slice(indent.length);
      const body = match ? rest : line.text.slice(indent.length);
      const prefix =
        kind === "bullet"
          ? "- "
          : kind === "ordered"
            ? `${counter++}. `
            : kind === "task"
              ? "- [ ] "
              : "> ";
      changes.push({
        from: line.from,
        to: line.from + (match ? match[0].length : indent.length),
        insert: indent + prefix,
      });
      void body;
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
