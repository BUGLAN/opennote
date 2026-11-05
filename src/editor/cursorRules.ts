import { EditorSelection, EditorState, Prec, type Extension, type SelectionRange, type Transaction } from "@codemirror/state";
import { EditorView, keymap, type Command } from "@codemirror/view";
import { atomsOf, hasAtomIn } from "./livePreview";

/**
 * 光标与「看不见的源码」之间的三条规则。
 *
 * 渲染态是常驻的（`320c7d2` 起）：`**`、`# `、`> `、链接的 `](url)` 一直藏着。藏起来的
 * 字符仍然在文档里，CodeMirror 的光标默认**照样一格一格走进去** —— 方向键按了不动、
 * 打字写进看不见的 URL、Home 之后打字写到 `##` 前面把标题打坏。这里补上：
 *
 * 1. **原子范围**（`EditorView.atomicRanges`）：隐藏的源码与行内 widget 对光标是一整块，
 *    方向键一步跨过，删除键也不会停在中间（删除碰到它们时由 `unwrap.ts` 先拆开）。
 * 2. **行首前缀吸附**：块级前缀（`## `、`> `、`- `、`- [ ] `）被隐藏时，光标不许停在
 *    前缀里或前缀前面 —— 点行首、按 Home、上下键落到第 0 列，都吸到文字开头。
 * 3. **标题的按键**：文字开头按退格 = 变回段落；按回车 = 上方插空行；上一段末尾按
 *    Delete = 把标题文字并上来（不留下字面的 `## `）。与 Typora 一致。
 */

/** 块级前缀：缩进、引用、列表（含任务）、标题，按这个顺序可以叠在一起。 */
const BLOCK_PREFIX =
  /^[ \t]*(?:(?:>[ \t]?)+[ \t]*)?(?:(?:[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+))?(?:#{1,6}(?:[ \t]+|$))?/;

/** 这一行块级前缀的结束位置（文档坐标）。没有前缀就是行首。 */
export function blockPrefixEnd(state: EditorState, lineFrom: number): number {
  const line = state.doc.lineAt(lineFrom);
  const match = BLOCK_PREFIX.exec(line.text);
  return line.from + (match ? match[0].length : 0);
}

/** 这一行的块级前缀是不是**被隐藏**着（里面有原子）。可见的前缀（空标题、显示标记）不吸附。 */
function prefixHidden(state: EditorState, lineFrom: number, prefixEnd: number): boolean {
  return prefixEnd > lineFrom && hasAtomIn(state, lineFrom, prefixEnd);
}

/* ------------------------------------------------------------ 1. 原子范围 */

const atomicMarks = EditorView.atomicRanges.of((view) => atomsOf(view.state));

/* ------------------------------------------------------------ 2. 行首吸附 */

/**
 * 光标落在被隐藏的块级前缀里 ⇒ 吸到文字开头。
 *
 * 唯一的例外是**往左走**：光标本来就在文字开头、这一下要往前，吸回原地就卡死了 ——
 * 这时送去上一行末尾（第一行则留在原地）。
 */
function snapRange(tr: Transaction, range: SelectionRange, index: number): SelectionRange {
  if (!range.empty) return range;
  const state = tr.state;
  const line = state.doc.lineAt(range.head);
  if (range.head >= line.to && line.length > 0) return range;
  const prefixEnd = blockPrefixEnd(state, line.from);
  if (range.head >= prefixEnd || !prefixHidden(state, line.from, prefixEnd)) return range;

  const before = tr.startState.selection.ranges[index] ?? tr.startState.selection.main;
  const previous = tr.docChanged ? tr.changes.mapPos(before.head, 1) : before.head;
  if (!tr.docChanged && before.empty && previous === prefixEnd && range.head < prefixEnd) {
    return line.number > 1 ? EditorSelection.cursor(line.from - 1) : EditorSelection.cursor(prefixEnd);
  }
  return EditorSelection.cursor(prefixEnd);
}

/** 便宜的预检：新选区里有没有哪个光标可能落在前缀里（只看文本，不算装饰）。 */
function mayNeedSnap(tr: Transaction): boolean {
  const doc = tr.newDoc;
  for (const range of tr.newSelection.ranges) {
    if (!range.empty) continue;
    const line = doc.lineAt(range.head);
    const match = BLOCK_PREFIX.exec(line.text);
    if (match && match[0].length > 0 && range.head < line.from + match[0].length) return true;
  }
  return false;
}

const prefixSnap = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection && !tr.docChanged) return tr;
  if (!mayNeedSnap(tr)) return tr;
  const ranges = tr.newSelection.ranges.map((range, index) => snapRange(tr, range, index));
  if (ranges.every((range, index) => range.eq(tr.newSelection.ranges[index]))) return tr;
  return [tr, { selection: EditorSelection.create(ranges, tr.newSelection.mainIndex), sequential: true }];
});

/* ------------------------------------------------------------ 3. 标题的按键 */

/** `<容器前缀>(## )` —— 容器是缩进 / 引用 / 列表，标题标记跟在后面。 */
const HEADING_IN_LINE =
  /^([ \t]*(?:(?:>[ \t]?)+[ \t]*)?(?:(?:[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+))?)(#{1,6}[ \t]+)(?=\S)/;

interface HeadingAt {
  /** `#` 的起点。 */
  markFrom: number;
  /** 文字的起点（`## ` 之后）。 */
  textFrom: number;
  /** `#` 前面有没有容器前缀（引用 / 列表）。 */
  contained: boolean;
}

function headingAt(state: EditorState, pos: number): HeadingAt | null {
  const line = state.doc.lineAt(pos);
  const match = HEADING_IN_LINE.exec(line.text);
  if (!match) return null;
  const markFrom = line.from + match[1].length;
  return { markFrom, textFrom: markFrom + match[2].length, contained: match[1].length > 0 };
}

/** 文字开头按退格：去掉 `## `，变回普通段落（标记可见时就是普通的删一个字符）。 */
const headingBackspace: Command = (view) => {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty || state.selection.ranges.length > 1) return false;
  const heading = headingAt(state, range.head);
  if (!heading || range.head !== heading.textFrom) return false;
  if (!hasAtomIn(state, heading.markFrom, heading.textFrom)) return false;
  view.dispatch({
    changes: { from: heading.markFrom, to: heading.textFrom },
    selection: { anchor: heading.markFrom },
    userEvent: "delete.backward",
    scrollIntoView: true,
  });
  return true;
};

/** 文字开头按回车：在标题**上方**插一个空行，标题与光标都不动。 */
const headingEnter: Command = (view) => {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty || state.selection.ranges.length > 1) return false;
  const heading = headingAt(state, range.head);
  // 引用 / 列表里的标题交给 markdown 自带的「续写容器」去处理
  if (!heading || heading.contained || range.head !== heading.textFrom) return false;
  const line = state.doc.lineAt(range.head);
  view.dispatch({
    changes: { from: line.from, insert: "\n" },
    selection: { anchor: range.head + 1 },
    userEvent: "input",
    scrollIntoView: true,
  });
  return true;
};

/**
 * 段落末尾按 Delete、下一行的块级前缀是隐藏的：把下一行的**文字**并上来，前缀一起删掉。
 * 不这么做，`前一行## 标题` 里那个 `##` 就成了字面文字。当前行是空行时不管 ——
 * 默认的 Delete 把空行删掉、标题原样上移，正是想要的。
 */
const joinNextBlock: Command = (view) => {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty || state.selection.ranges.length > 1) return false;
  const line = state.doc.lineAt(range.head);
  if (range.head !== line.to || line.number >= state.doc.lines || line.text.trim() === "") return false;
  const next = state.doc.line(line.number + 1);
  const prefixEnd = blockPrefixEnd(state, next.from);
  if (!prefixHidden(state, next.from, prefixEnd)) return false;
  view.dispatch({
    changes: { from: line.to, to: prefixEnd },
    selection: { anchor: line.to },
    userEvent: "delete.forward",
    scrollIntoView: true,
  });
  return true;
};

/**
 * 必须排在 markdown 自带键位（`Prec.high`）之前：标题开头的回车不该被
 * 「续写列表 / 引用」那条逻辑先抢走。
 */
const headingKeymap = Prec.highest(
  keymap.of([
    { key: "Backspace", run: headingBackspace },
    { key: "Enter", run: headingEnter },
    { key: "Delete", run: joinNextBlock },
  ]),
);

export const cursorRules: Extension = [atomicMarks, prefixSnap, headingKeymap];
