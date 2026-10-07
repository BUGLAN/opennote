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
  /*
   * 光标「偏下」的根因（用户 0.5.0 实测：「光标偏移? 偏下」）：
   * CodeMirror 给的 `.cm-cursor` 高度就是这一行的**字体盒**（16.5px 字号下 16px），而汉字的墨迹
   * 比字体盒**高 0.12em、下沿又短 0.12em** —— 和 `.cm-selectionBackground` 撑开 padding 是同一个
   * 成因（见 `editor.css` 那段注释）。于是汉字行上光标的**上沿落在字的上半截、下沿拖到字脚下面**，
   * 看着就是「光标比字低了一截」。拉丁字母没有这个错位（实测墨迹正好落在字体盒里）。
   *
   * 为什么是 `translateY(-15%)` 而不是 `margin-top: -2px`：
   * **`translateY` 的百分比按元素自身高度算，而那个高度正是这一行的字体盒** —— 所以这 15% 在任意
   * 字号、任意标题级别、任意字体预设下都正好等于要补的那 0.12em（实测：正文行光标 16px → 补 2.4px，
   * H1 行光标 30px → 补 4.5px；两处的量测结果见下）。写死像素值会在 H1 上不够、在小字号上过分。
   *
   * 实测（Windows / 默认字体栈 / 16.5px 正文 / 夜读主题，网页版截图上按像素量的；`--doc-*` 与
   * 字体预设都不影响结论，只有比例）：
   *   正文汉字行：墨迹 y 100–115，光标改前 101–117（上差 1px、下差 2px）⇒ 改后 100–114（上下各 1px）；
   *   H1 汉字行：墨迹 181–209，光标改前 185–214（上差 4px、下差 5px）⇒ 改后 181–209（上下各 0px）；
   *   拉丁行：墨迹 131–147，光标改前 131–147（本来就对齐）⇒ 改后 128–144（仍在字母上下沿内，
   *   不切 `j`/`q` 的降部）。
   * 复核办法：`pnpm dev` 起网页版，在浏览器控制台里取 `.cm-cursor` 的 `getBoundingClientRect()` 与
   * 同一行墨迹的像素范围对比（汉字墨迹比字体盒高 0.12em、下沿短 0.12em）。
   */
  ".cm-cursor, .cm-dropCursor": {
    borderLeft: "2px solid var(--accent)",
    borderRadius: "1px",
    transform: "translateY(-15%)",
  },
  /*
   * 选区底色见 `src/styles/editor.css` 的 `.cm-selectionLayer .cm-selectionBackground`：
   * CM 的 baseTheme 用一条**比这里更专一**的选择器画它自己的固定色（浅 `#d7d4f0` / 深 `#233`），
   * 而 `EditorView.theme()` 里既写不出 `&light`/`&dark`（会抛 `RangeError: Unsupported selector`），
   * 特异度也压不过它 —— 所以那条规则写在 CSS 里。
   * 这两条保留：编辑器**失焦**时用的是原生 `::selection`。
   */
  ".cm-selectionBackground, .cm-content ::selection": {
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
