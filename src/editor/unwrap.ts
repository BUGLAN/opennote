import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import type { EditorState } from "@codemirror/state";
import { keymap, type Command, type EditorView } from "@codemirror/view";
import { livePreviewField, unwrapSource } from "./livePreview";

/**
 * 「光标停在边界按删除 ⇒ 先拆开这一段，而不是删内容」。
 *
 * ## 它补的是哪一块
 *
 * 默认模型是**渲染态持久**：`**粗体**` 渲染成粗体、`![图](x.png)` 渲染成图片之后，
 * 光标停上去**不会**把它们换成源码。于是就有了一个新问题 —— **怎么改它？**
 *
 * 答案就是这里：把光标放到那一段的**边界**上按删除，第一下先把它的源码露出来
 * （「我要拆这一块」），再按一下才真的删内容。
 *
 * 这也正是 `showMarks: false` 下唯一「主动看见标记」的入口，所以它必须**零学习成本**：
 * 想删掉粗体，本能就是光标移到粗体后面按 Backspace —— 那一下刚好就是拆开。
 *
 * ## 为什么基本只收行内元素
 *
 * 块级标记（`# `、`> `、`- `、代码围栏）走的是另一条规则：**块还没成立就显示源码**
 * （见 `livePreview.ts` 的 `isEmptyBlock`）。敲下 `##` 看得见、敲进文字就消失、
 * 把文字删空又回来 —— 全靠那一条，不需要按键参与，也不该两套机制打架。
 *
 * **表格是唯一的块级例外**：渲染态是一张不可直接编辑的表，编辑态是「源码行按表格
 * 排出来」（`renderTableInPlace`）。于是「整块删掉这张表」也需要一个入口 ——
 * 光标停在表格末尾按 Backspace（或表格开头按 Delete），第一下先把它拆成源码，
 * 再按一下才真删。判定用的是 `Table` 节点的边界，与行内元素共用同一套走法。
 */
const UNWRAPPABLE = new Set([
  "Emphasis",
  "StrongEmphasis",
  "Strikethrough",
  "Highlight",
  "InlineCode",
  "InlineMath",
  "Link",
  "Image",
  "WikiLink",
]);

/** 块级例外：只有表格（见文件头「为什么基本只收行内元素」）。 */
const UNWRAPPABLE_BLOCKS = new Set(["Table"]);

/**
 * 从 `pos` 出发，沿父链找**恰好结束在 `pos`** 的可拆元素。
 *
 * 先取 `pos` 处最内层的节点（多半是收尾的 `**` 那种 `EmphasisMark`），再往上走：
 * 只要还满足「结束在 pos」就继续；一旦某个祖先的结束位置越过 `pos`，说明 `pos`
 * 落在它内部 —— 那不是边界，停。
 */
function unwrappableEndingAt(state: EditorState, pos: number): SyntaxNode | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
  while (node && node.to === pos) {
    if (UNWRAPPABLE.has(node.name) || UNWRAPPABLE_BLOCKS.has(node.name)) return node;
    node = node.parent;
  }
  return null;
}

/** 同上，方向相反：找**恰好起始于 `pos`** 的可拆元素。 */
function unwrappableStartingAt(state: EditorState, pos: number): SyntaxNode | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);
  while (node && node.from === pos) {
    if (UNWRAPPABLE.has(node.name) || UNWRAPPABLE_BLOCKS.has(node.name)) return node;
    node = node.parent;
  }
  return null;
}

/**
 * 光标与元素之间可能只隔空白（块级图片独占一行时行尾常有空格）。
 * 往回跳过空白再判定边界。
 */
function skipSpaceBackwards(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos);
  let p = pos;
  while (p > line.from && /\s/.test(state.doc.sliceString(p - 1, p))) p -= 1;
  return p;
}

/**
 * 拆开这一段：露源码、吃掉这次按键。
 *
 * **已经拆开过的再按一次就放行**（返回 `false`）—— 那一下才是真的删内容。
 * 「先按一下 = 拆掉渲染，再按 = 删」的手感就是从这一行来的。
 */
function unwrap(view: EditorView, node: SyntaxNode): boolean {
  const current = view.state.field(livePreviewField, false)?.unwrapped;
  if (current && current.from === node.from && current.to === node.to) return false;
  const head = view.state.selection.main.head;
  // 光标本来就在这个元素边界上（行内元素、表格自己的末尾）⇒ 位置不动。
  // 光标在**表格下面那一行的行首**时离得远，露出的源码会被「光标一离开就收起来」
  // 立刻收掉 —— 所以把光标一起挪到表格末尾：这一下本来就等于「我开始拆这张表了」。
  const atEdge = head >= node.from - 1 && head <= node.to + 1;
  view.dispatch({
    effects: unwrapSource.of({ from: node.from, to: node.to }),
    ...(atEdge ? {} : { selection: { anchor: node.to } }),
  });
  return true;
}


/**
 * 光标在表格**后面**的行首（中间只隔着空行）时按 Backspace：先拆表格。
 *
 * 为什么需要：表格的下一行按 Backspace 会删掉那个换行，markdown 于是把下面
 * 那一整段并进表格的最后一行 —— 结构当场被改写（用户实测：一段话被灌进一个
 * 格子，整张表塌成竖排）。所以这一下必须先换成「把表格拆成源码」。
 */
function tableEndingBeforeLineStart(state: EditorState, pos: number): SyntaxNode | null {
  const doc = state.doc;
  const line = doc.lineAt(pos);
  if (pos !== line.from) return null;
  const tree = syntaxTree(state);
  let n = line.number - 1;
  while (n >= 1) {
    const prev = doc.line(n);
    if (prev.text.trim().length === 0) {
      n -= 1;
      continue;
    }
    let node: SyntaxNode | null = tree.resolveInner(prev.to, -1);
    while (node && node.parent && node.parent.name !== "Document") node = node.parent;
    return node && node.name === "Table" && node.to === prev.to ? node : null;
  }
  return null;
}

/** 光标正好停在这张表格最后一行的末尾（按 Delete 会把下一行并进表格）。 */
function tableEndingAt(state: EditorState, pos: number): SyntaxNode | null {
  const doc = state.doc;
  if (pos !== doc.lineAt(pos).to) return null;
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
  while (node && node.to === pos) {
    if (node.name === "Table") return node;
    node = node.parent;
  }
  return null;
}
/** Backspace：光标贴在某个已渲染元素的**末尾**时，先把它拆成源码。 */
export const unwrapBackspace: Command = (view) => {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const pos = skipSpaceBackwards(view.state, selection.head);
  const node = unwrappableEndingAt(view.state, pos);
  if (node) return unwrap(view, node);
  const table = tableEndingBeforeLineStart(view.state, selection.head);
  return table ? unwrap(view, table) : false;
};

/** Delete：光标贴在某个已渲染元素的**开头**时，先把它拆成源码。 */
export const unwrapDelete: Command = (view) => {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const node = unwrappableStartingAt(view.state, selection.head);
  if (node) return unwrap(view, node);
  const table = tableEndingAt(view.state, selection.head);
  return table ? unwrap(view, table) : false;
};

/**
 * 必须排在 `defaultKeymap` **之前**：它要抢在 CodeMirror 默认的 Backspace/Delete 前面
 * 决定「这一下是拆开，还是删除」。
 */
export const unwrapKeymap = keymap.of([
  { key: "Backspace", run: unwrapBackspace },
  { key: "Delete", run: unwrapDelete },
]);
