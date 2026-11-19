import { EditorSelection, type ChangeSpec, type EditorState } from "@codemirror/state";
import type { Command, EditorView } from "@codemirror/view";

function delimiterRunBefore(state: EditorState, position: number, delimiter: string): number {
  const text = state.doc.sliceString(0, position);
  let count = 0;
  while (count < text.length && text[text.length - count - 1] === delimiter) count += 1;
  return count;
}

function delimiterRunAfter(state: EditorState, position: number, delimiter: string): number {
  const text = state.doc.sliceString(position);
  let count = 0;
  while (count < text.length && text[count] === delimiter) count += 1;
  return count;
}

function leadingDelimiterRun(text: string, delimiter: string): number {
  let count = 0;
  while (count < text.length && text[count] === delimiter) count += 1;
  return count;
}

function trailingDelimiterRun(text: string, delimiter: string): number {
  let count = 0;
  while (count < text.length && text[text.length - count - 1] === delimiter) count += 1;
  return count;
}

function hasDelimiterLayer(left: number, right: number, width: number): boolean {
  if (left !== right || left < width) return false;
  return width === 1 ? left % 2 === 1 : left === width || left === width + 1;
}

/** Wrap (or unwrap) the selection with markdown delimiters. */
export function toggleWrap(before: string, after = before, placeholder = "文本"): Command {
  return (view) => {
    if (view.state.readOnly) return false;
    const { state } = view;
    const spec = state.changeByRange((range) => {
      const text = state.sliceDoc(range.from, range.to);
      const repeated = before === after && [...before].every((char) => char === before[0]);

      if (repeated) {
        const delimiter = before[0];
        const width = before.length;
        const outsideLeft = delimiterRunBefore(state, range.from, delimiter);
        const outsideRight = delimiterRunAfter(state, range.to, delimiter);

        if (outsideLeft > 0 && outsideRight > 0) {
          if (hasDelimiterLayer(outsideLeft, outsideRight, width)) {
            return {
              changes: [
                { from: range.from - width, to: range.from, insert: "" },
                { from: range.to, to: range.to + width, insert: "" },
              ],
              range: EditorSelection.range(range.from - width, range.to - width),
            };
          }
          return {
            changes: [
              { from: range.from, insert: before },
              { from: range.to, insert: after },
            ],
            range: EditorSelection.range(range.from + width, range.to + width),
          };
        }

        const insideLeft = leadingDelimiterRun(text, delimiter);
        const insideRight = trailingDelimiterRun(text, delimiter);
        if (insideLeft > 0 && insideRight > 0 && text.length > insideLeft + insideRight) {
          if (hasDelimiterLayer(insideLeft, insideRight, width)) {
            const inner = text.slice(width, text.length - width);
            return {
              changes: { from: range.from, to: range.to, insert: inner },
              range: EditorSelection.range(range.from, range.from + inner.length),
            };
          }
          return {
            changes: { from: range.from, to: range.to, insert: before + text + after },
            range: EditorSelection.range(range.from + width, range.to + width),
          };
        }
      }

      const outerFrom = range.from - before.length;
      const outerTo = range.to + after.length;
      const wrappedOutside =
        outerFrom >= 0 &&
        outerTo <= state.doc.length &&
        state.sliceDoc(outerFrom, range.from) === before &&
        state.sliceDoc(range.to, outerTo) === after &&
        state.sliceDoc(outerFrom - 1, outerFrom) !== before.slice(-1) &&
        state.sliceDoc(outerTo, outerTo + 1) !== after[0];

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
    if (view.state.readOnly) return false;
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

const QUOTE_PATTERN = /^([ \t]*)>[ \t]?/;
const LIST_PREFIX = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\](?:[ \t]+|$))?/;

type ListPrefixInfo = { kind: Exclude<PrefixKind, "quote">; indent: number; length: number };

function parseListPrefix(text: string): ListPrefixInfo | null {
  const match = LIST_PREFIX.exec(text);
  if (!match) return null;
  const marker = match[0].slice(match[1].length);
  const kind = /^\d/.test(marker) ? "ordered" : /\[[ xX]\]/.test(marker) ? "task" : "bullet";
  return { kind, indent: match[1].length, length: match[0].length };
}

export function toggleLinePrefix(kind: PrefixKind): Command {
  return (view) => {
    if (view.state.readOnly) return false;
    const { state } = view;
    const lines = selectedLines(state.doc, state.selection.main.from, state.selection.main.to);
    const changes: ChangeSpec[] = [];

    if (kind === "quote") {
      const allQuoted = lines.every((line) => QUOTE_PATTERN.test(line.text));
      for (const line of lines) {
        const match = QUOTE_PATTERN.exec(line.text);
        if (allQuoted) {
          if (match) changes.push({ from: line.from, to: line.from + match[0].length, insert: "" });
          continue;
        }
        const indent = /^[ \t]*/.exec(line.text)?.[0] ?? "";
        changes.push({ from: line.from, to: line.from + indent.length, insert: indent + "> " });
      }
    } else {
      const prefixes = lines.map((line) => parseListPrefix(line.text));
      const allPrefixed = prefixes.every((prefix) => prefix?.kind === kind);
      let counter = 1;

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const existing = prefixes[index];
        if (allPrefixed) {
          if (existing) {
            changes.push({ from: line.from + existing.indent, to: line.from + existing.length, insert: "" });
          }
          continue;
        }
        const indent = existing
          ? line.text.slice(0, existing.indent)
          : (/^[ \t]*/.exec(line.text)?.[0] ?? "");
        const prefix = kind === "bullet" ? "- " : kind === "ordered" ? `${counter++}. ` : "- [ ] ";
        changes.push({
          from: line.from,
          to: line.from + (existing?.length ?? indent.length),
          insert: indent + prefix,
        });
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
    if (view.state.readOnly) return false;
    const { state } = view;
    const range = state.selection.main;
    const line = state.doc.lineAt(range.from);
    const atLineStart = line.from === range.from;
    const previousLine = atLineStart && line.number > 1 ? state.doc.line(line.number - 1) : null;
    const before = !atLineStart ? "\n\n" : previousLine?.text.trim() ? "\n" : "";
    const endLine = state.doc.lineAt(range.to);
    const hasTextAfter = range.to < endLine.to && state.sliceDoc(range.to, endLine.to).trim().length > 0;
    const nextLine =
      !hasTextAfter && endLine.number < state.doc.lines ? state.doc.line(endLine.number + 1) : null;
    const textEndsWithBreak = /\r?\n$/.test(text);
    const after = hasTextAfter
      ? textEndsWithBreak
        ? "\n"
        : "\n\n"
      : nextLine?.text.trim()
        ? textEndsWithBreak
          ? ""
          : "\n"
        : "";
    const insert = `${before}${text}${after}`;
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

function insertInline(text: string, cursorOffset?: number, selectLength = 0): Command {
  return (view) => {
    if (view.state.readOnly) return false;
    const { state } = view;
    const range = state.selection.main;
    const cursor = range.from + (cursorOffset ?? text.length);
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: text },
      selection: { anchor: cursor, head: cursor + selectLength },
      userEvent: "input.format",
      scrollIntoView: true,
    });
    view.focus();
    return true;
  };
}

export function insertLink(): Command {
  return (view) => {
    if (view.state.readOnly) return false;
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
  return insertInline("[[]]", 2, 0);
}

/** Strip markdown syntax from the selection — handy when pasting formatted text. */
export function clearFormatting(): Command {
  return (view) => {
    if (view.state.readOnly) return false;
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
