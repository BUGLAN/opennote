import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

/**
 * Structural editor styling (things CodeMirror itself must own). The document's
 * visual language — headings, quotes, code blocks, widgets — lives in
 * `src/styles/editor.css`, which is written against the same CSS variables.
 */
const baseTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "transparent",
    color: "var(--ink)",
    fontSize: "var(--doc-fs)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-doc)",
    lineHeight: "var(--doc-lh)",
    overflowY: "auto",
    overflowX: "hidden",
    overscrollBehavior: "contain",
  },
  ".cm-content": {
    maxWidth: "var(--measure)",
    width: "100%",
    margin: "0 auto",
    padding: "56px 10px 45vh",
    caretColor: "var(--accent)",
    flexGrow: "0",
    flexShrink: "0",
    position: "relative",
  },
  ".cm-line": {
    padding: "0",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeft: "2px solid var(--accent)",
    borderRadius: "1px",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--sel)",
  },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "var(--ink-3)",
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
  },
  ".cm-selectionMatch": { backgroundColor: "var(--accent-soft)" },
  ".cm-searchMatch": {
    backgroundColor: "var(--mark)",
    outline: "1px solid var(--accent-line)",
    borderRadius: "2px",
  },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--accent-soft)" },
  ".cm-panels": {
    backgroundColor: "var(--paper-2)",
    color: "var(--ink)",
    borderColor: "var(--rule)",
    fontFamily: "var(--font-ui)",
    fontSize: "13px",
    zIndex: "30",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--rule)" },
  ".cm-panel input, .cm-panel button": {
    fontFamily: "var(--font-ui)",
    background: "var(--paper-2)",
    color: "var(--ink)",
    border: "1px solid var(--rule-strong)",
    borderRadius: "4px",
  },
  ".cm-tooltip": {
    border: "1px solid var(--rule-strong)",
    borderRadius: "var(--radius)",
    backgroundColor: "var(--paper-2)",
    color: "var(--ink)",
    boxShadow: "var(--shadow-2)",
    overflow: "hidden",
    fontFamily: "var(--font-ui)",
    fontSize: "13px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--font-ui)",
    maxHeight: "16em",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    padding: "3px 8px",
    lineHeight: "1.5",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--accent-soft)",
    color: "var(--ink)",
  },
  ".cm-completionLabel": { fontFamily: "inherit" },
  ".cm-completionMatchedText": {
    textDecoration: "none",
    color: "var(--accent)",
    fontWeight: "600",
  },
  ".cm-completionDetail": {
    fontStyle: "normal",
    color: "var(--ink-3)",
    marginLeft: "8px",
    fontSize: "0.9em",
  },
  ".cm-tooltip.cm-completionInfo": {
    padding: "6px 10px",
    maxWidth: "260px",
    color: "var(--ink-2)",
  },
  ".cm-placeholder": { color: "var(--ink-3)" },
});

/** Palette for fenced code, expressed through the shared token classes. */
const codeHighlight = HighlightStyle.define(
  [
    { tag: t.keyword, class: "tok-keyword" },
    { tag: [t.controlKeyword, t.moduleKeyword, t.operatorKeyword], class: "tok-keyword" },
    { tag: [t.string, t.special(t.string), t.regexp], class: "tok-string" },
    { tag: [t.number, t.bool, t.null, t.atom], class: "tok-number" },
    { tag: [t.lineComment, t.blockComment, t.docComment], class: "tok-comment" },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], class: "tok-func" },
    { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)], class: "tok-type" },
    { tag: [t.propertyName, t.attributeName], class: "tok-var" },
    { tag: [t.operator, t.punctuation, t.separator, t.bracket, t.derefOperator], class: "tok-punct" },
    { tag: [t.variableName, t.definition(t.variableName)], class: "tok-var" },
    { tag: t.invalid, class: "tok-keyword" },
    { tag: t.meta, class: "tok-comment" },
    { tag: [t.link, t.url], class: "tok-string" },
    { tag: t.heading, fontWeight: "600" },
    { tag: t.strong, fontWeight: "650" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: t.monospace, fontFamily: "var(--font-mono)" },
    { tag: t.quote, color: "inherit" },
    { tag: t.contentSeparator, color: "var(--ink-3)" },
    { tag: t.processingInstruction, color: "var(--ink-3)" },
  ],
);

/** Empty-document hint, drawn with CSS so it never touches the document. */
const emptyHint = EditorView.contentAttributes.of({ "data-placeholder": "开始写下这一刻…" });

export function editorTheme(): Extension {
  return [baseTheme, syntaxHighlighting(codeHighlight), emptyHint];
}

export const placeholderText = "开始写下这一刻…";
