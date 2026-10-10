import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode, Tree } from "@lezer/common";
import { type EditorState, type Range, StateEffect, StateField, type Transaction } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, type WidgetType } from "@codemirror/view";
import { renderMarkdown } from "../lib/markdown";
import { setBlockPad } from "./blockHeight";
import { bridge } from "./bridge";
import { stripMathDollars, stripMathFence } from "./math";
import {
  defaultEditorSettings,
  editorSettingsField,
  type EditorSettings,
  refreshDecorations,
  setEditorSettings,
} from "./settings";
import {
  BulletWidget,
  CheckboxWidget,
  HrWidget,
  ImageWidget,
  MathWidget,
  MermaidWidget,
  TableWidget,
  WikiLinkWidget,
} from "./widgets";

/** Above this size we stop decorating and fall back to plain markdown highlighting. */
const MAX_DECORATED_LENGTH = 800_000;

/**
 * D24: below this document size every transaction rebuilds the whole decoration
 * set. A full pass over a small document is cheaper than the bookkeeping that
 * reusing the previous result needs. Above it the field maps the previous set
 * through the change and re-decorates only the top-level blocks the change or
 * the cursor touched.
 *
 * Threshold: a full decoration pass costs ≈0.06–0.09 ms per 1k characters
 * (measured with `D24_BENCH=1 npx vitest run src/editor/perfD24.test.ts`:
 * ≈1.1 ms at 17.8k and ≈11 ms at 135.8k characters), i.e. well under a frame at
 * 20k while growing linearly past it — and 20k characters is still far more
 * than a typical note, so ordinary notes keep the simpler full-rebuild path.
 */
export const FULL_REBUILD_LENGTH = 20_000;

/**
 * D13 safeguard: a formula block that is not closed normally still renders as a
 * widget, but when it is huge (the parser could not find a blank line to stop
 * at) replacing it would hide a large part of the note. Keep those lines as
 * visible source instead.
 */
const MAX_UNCLOSED_MATH_LINES = 60;

const MARK_RE = /^(?:EmphasisMark|StrikethroughMark|HighlightMark|LinkMark|ImageMark|CodeMark|WikiLinkMark)$/;
const LINK_MARK_RE = /^(?:LinkMark|ImageMark)$/;

type Span = { from: number; to: number };
type SelectionSpan = readonly [number, number];

/** What the live-preview state field stores. */
interface LivePreviewValue {
  set: DecorationSet;
  /** Selection line spans the set was built for — blocks that stop being active are found through them. */
  active: readonly SelectionSpan[];
  /** Length of the syntax tree the set was built from; when the parser catches up we re-decorate the new part. */
  parsedTo: number;
  /**
   * 每次重算 +1。`blockPadPlugin` 用它判断「装饰换过一轮」—— 换过就意味着
   * 某个块可能换了形态、高度变了，该去量一量要不要补白。
   */
  epoch: number;
  /**
   * 源码态补白：块原文 → 要补的 `padding-bottom`（px）。见 `blockHeight.ts`。
   *
   * 它解决的是一条**无法绕开**的算术：块级内容在「渲染态 ↔ 源码态」之间换形态时，
   * 两种形态高度不同（表格差 92px、mermaid 差 143px），而「块下方内容不动」
   * 等价于「块的高度不变」—— 所以源码态必须把差额补成留白。
   */
  pads: ReadonlyMap<string, number>;
  /**
   * 被用户**显式拆开**的那一段（见 `unwrapSource`）：光标停在已渲染元素的边界上按删除时，
   * 先露出它的源码，而不是直接删内容。
   *
   * 只留**一段**：这是「我正在拆这一个」的临时状态，不是一份清单。
   */
  unwrapped: Span | null;
}

/**
 * 「把这一段源码露出来」。
 *
 * 由 `unwrap.ts` 的删除键处理器发出：光标停在某个**已渲染行内元素**（`**粗体**`、
 * `` `代码` ``、链接、图片…）的边界上按删除时，先露源码、吃掉这次按键 —— 这就是
 * 「删掉这个粗体这一块」的手感；再按一次才真的删内容。
 */
export const unwrapSource = StateEffect.define<{ from: number; to: number }>();

function selectionSpans(state: EditorState): SelectionSpan[] {
  const doc = state.doc;
  return state.selection.ranges.map((range) => [doc.lineAt(range.from).from, doc.lineAt(range.to).to] as const);
}

/** The top-level block (a child of Document) that contains `pos`. */
function topBlockAt(tree: Tree, state: EditorState, pos: number): Span {
  const doc = state.doc;
  const p = Math.max(0, Math.min(pos, doc.length));
  let node: SyntaxNode | null = tree.resolveInner(p, 1);
  while (node && node.parent && node.parent.name !== "Document") node = node.parent;
  if (!node || node.name === "Document") {
    // whitespace between blocks belongs to no node — use the line it sits on
    const line = doc.lineAt(p);
    return { from: line.from, to: line.to };
  }
  return { from: node.from, to: node.to };
}

/** Expand a range so that it holds complete top-level blocks. */
function blockSpan(tree: Tree, state: EditorState, from: number, to: number): Span {
  const doc = state.doc;
  const f = Math.max(0, Math.min(from, doc.length));
  const t = Math.max(f, Math.min(to, doc.length));
  // the neighbours matter: a change can split or merge the block it touches
  const probes = [f, t, f > 0 ? f - 1 : 0, t < doc.length ? t + 1 : doc.length];
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const probe of probes) {
    const span = topBlockAt(tree, state, probe);
    lo = Math.min(lo, span.from);
    hi = Math.max(hi, span.to);
  }
  return { from: lo, to: hi };
}

/** Merge spans that touch or overlap; keep the ones that are far apart separate. */
function mergeSpans(spans: Span[]): Span[] {
  const sorted = spans
    .filter((span) => span.to >= span.from)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.from <= last.to + 1) last.to = Math.max(last.to, span.to);
    else merged.push({ from: span.from, to: span.to });
  }
  return merged;
}

/**
 * Turn the markdown syntax tree into live-preview decorations for the given
 * document spans. Everything that needs a block widget (tables, formulas,
 * diagrams, rules) lives here, because CodeMirror only allows block decorations
 * from a state field.
 */
function decorate(
  state: EditorState,
  settings: EditorSettings,
  spans: readonly Span[],
  active: readonly SelectionSpan[],
  decorations: Range<Decoration>[],
  pads: ReadonlyMap<string, number> = new Map(),
  unwrapped: Span | null = null,
): void {
  const doc = state.doc;
  const tree = syntaxTree(state);
  const lineFrom = (pos: number) => doc.lineAt(Math.min(pos, doc.length)).from;

  const lineDeco = (pos: number, cls: string, attributes?: Record<string, string>) => {
    decorations.push(Decoration.line(attributes ? { class: cls, attributes } : { class: cls }).range(lineFrom(pos)));
  };
  const mark = (from: number, to: number, cls: string) => {
    if (to > from) decorations.push(Decoration.mark({ class: cls }).range(from, to));
  };
  const hide = (from: number, to: number) => {
    if (to > from) decorations.push(Decoration.replace({}).range(from, to));
  };
  const replaceWith = (from: number, to: number, widget: WidgetType, block = false) => {
    if (to > from) decorations.push(Decoration.replace({ widget, block }).range(from, to));
  };
  /**
   * 源码态**补白**：把这个块渲染成 widget 时的高度，与它现在（源码态）的高度的差额，
   * 补成最后一行的 `padding-bottom`。补多少由 `blockPadPlugin` 量出来，这里只负责落到装饰上。
   *
   * 为什么必须补：块级内容两种形态高度不同（实测表格差 92px、mermaid 差 143px），
   * 而「块下方内容不动」等价于「块的高度不变」—— 不补，下方内容必然整块跳。
   *
   * 为什么补在**最后一行**：`padding-bottom` 算在行盒高度里，CM 逐行量高度时会算进去；
   * 补在最后一行等于把「块的下边界」往下推，块上方与自身的位置都不受影响。
   */
  const applyPad = (from: number, to: number, lastLineFrom: number) => {
    const pad = pads.get(state.sliceDoc(from, to));
    if (pad && pad > 1) {
      decorations.push(
        Decoration.line({ attributes: { style: `padding-bottom:${Math.round(pad)}px` } }).range(lastLineFrom),
      );
    }
  };
  /** A node on a line that touches the cursor keeps its raw markdown. */
  const isActive = (from: number, to: number) => {
    for (const [start, end] of active) {
      if (from <= end && to >= start) return true;
    }
    return false;
  };
  /**
   * 光标**真正落在**哪些行上（选区跨多行时就是那几行）。
   *
   * 与 `isActive` 的区别很重要：`isActive` 判的是「节点是否与光标所在行有交集」，
   * 对**整块**生效；而这个集合判的是「这一行本身是不是光标行」。
   *
   * 为什么需要它：围栏代码块的首尾 ``` 行、Setext 标题的下划线行，原来只要光标在
   * **块内任意位置**就露出来 —— 于是光标在代码里上下移动一次，两行围栏忽隐忽现，
   * 块高变化 47px，下方内容整块跟着跳（实测）。改成「只有光标真的停在那两行上才露」，
   * 日常在代码里编辑时块高恒定；要改语言/删围栏，把光标移到那一行仍然看得见、改得动。
   */
  const activeLines = new Set<number>();
  for (const [start, end] of active) {
    const first = doc.lineAt(Math.min(start, doc.length)).number;
    const last = doc.lineAt(Math.min(end, doc.length)).number;
    for (let n = first; n <= last; n += 1) activeLines.add(n);
  }

  /**
   * 这一段被用户**显式拆开**了吗（见 `unwrapSource`）。
   *
   * 这是「渲染态持久、源码只在拆它时出现」模型里**破坏性操作**那一半：
   * 光标停在 `**粗体**` 的边界按删除 ⇒ 先露 `**`，而不是直接删字。
   */
  const isUnwrapped = (from: number, to: number) => !!unwrapped && from <= unwrapped.to && to >= unwrapped.from;

  /**
   * 一个块**还没成立**吗（`## ` 后面空的、`> ` 后面空的、`- ` 后面空的）。
   *
   * 这是同一个模型里**构造态**那一半：空块显示源码，有内容就渲染。
   * 于是「敲下 `##` 时看得见、敲进文字就消失、把文字删空又回来」这三件事
   * 由同一条规则自然给出，不需要任何额外的按键行为。
   */
  const isEmptyBlock = (from: number, to: number) => state.sliceDoc(from, to).trim().length === 0;

  /**
   * `showMarks: true` 是给「我就想一直看着源码」的人用的逃生舱：所有标记一律露出。
   *
   * 默认 `false` 走的是模型本身：**渲染态持久**，源码只在
   *   ① 块还没成立（`isEmptyBlock`），或
   *   ② 用户正在拆它（`isUnwrapped`）
   * 时出现 —— 而不是「光标到哪露哪」。
   */
  const revealMarks = settings.showMarks;
  /** 这一个节点的标记要不要露出来。 */
  const showsSource = (from: number, to: number) => revealMarks || isUnwrapped(from, to);

  for (const span of spans) {
    tree.iterate({
      from: Math.max(0, span.from),
      to: Math.min(span.to, doc.length),
      enter: (ref) => {
        const name = ref.name;
        const from = ref.from;
        const to = ref.to;
        const node = ref.node;

        /* ------------------------------------------------------------ headings */
        const atx = /^ATXHeading([1-6])$/.exec(name);
        if (atx) {
          lineDeco(from, `md-h${atx[1]}`);
          const markNode = node.getChild("HeaderMark");
          // 空标题（`## ` 后面还没有文字）显示源码 —— 它此刻还不成立。
          // 「敲下 `##` 看得见 → 敲进文字就消失 → 把文字删空又回来」全由这一条给出。
          const empty = markNode ? isEmptyBlock(markNode.to, to) : false;
          if (!markNode) return;
          const markEnd = Math.min(markNode.to + 1, to);
          if (!empty && !showsSource(from, to)) hide(markNode.from, markEnd);
          else mark(markNode.from, markEnd, "md-src");
          return;
        }
        const setext = /^SetextHeading([12])$/.exec(name);
        if (setext) {
          lineDeco(from, `md-h${setext[1]}`);
          const markNode = node.getChild("HeaderMark");
          if (markNode) {
            const line = doc.lineAt(markNode.from);
            // 只有光标**停在下划线那一行**、而且开关允许露标记时才把它露出来
            // （原来只要在标题块内就露，光标从标题文字移开/移入都会让块高变化 29px）。
            if (!(revealMarks && activeLines.has(line.number))) {
              hide(line.from, line.to);
              lineDeco(line.from, "md-hide-line");
            }
          }
          return;
        }

        /* ------------------------------------------------------- inline styles */
        if (name === "Emphasis" || name === "StrongEmphasis" || name === "Strikethrough" || name === "Highlight") {
          const cls =
            name === "Emphasis"
              ? "md-em"
              : name === "StrongEmphasis"
                ? "md-strong"
                : name === "Strikethrough"
                  ? "md-del"
                  : "md-mark";
          const first = node.firstChild;
          const last = node.lastChild;
          if (first && last && first !== last && MARK_RE.test(first.name) && MARK_RE.test(last.name)) {
            mark(first.to, last.from, cls);
          } else {
            mark(from, to, cls);
          }
          if (!showsSource(from, to)) {
            for (let child = first; child; child = child.nextSibling) {
              if (MARK_RE.test(child.name)) hide(child.from, child.to);
            }
          }
          return;
        }

        if (name === "InlineCode") {
          const first = node.firstChild;
          const last = node.lastChild;
          if (first && last && first !== last && first.name === "CodeMark" && last.name === "CodeMark") {
            mark(first.to, last.from, "md-code");
            if (!showsSource(from, to)) {
              hide(first.from, first.to);
              hide(last.from, last.to);
            }
          }
          return false;
        }

        if (name === "Link" || name === "Image") {
          // an image inside a link keeps its source so the two never overlap
          if (name === "Image" && node.parent?.name === "Link") return false;
          const marks: SyntaxNode[] = [];
          for (let child = node.firstChild; child; child = child.nextSibling) {
            if (LINK_MARK_RE.test(child.name)) marks.push(child);
          }
          const urlNode = node.getChild("URL");
          const raw = urlNode ? state.sliceDoc(urlNode.from, urlNode.to) : "";
          const labelFrom = marks.length ? marks[0].to : to;
          const labelTo = marks.length > 1 ? marks[1].from : to;

          if (name === "Image") {
            const alt = labelTo > labelFrom ? state.sliceDoc(labelFrom, labelTo) : "";
            /*
             * 图片是**持久渲染**的：光标停在它旁边**不会**把它换成源码。
             *
             * 这是「渲染态持久、源码只在拆它时出现」模型的一部分：把光标放到图片**后面**
             * 按 Backspace，先露出 `![](...)` 而不是把图删掉（见 `unwrap.ts`）。
             * 两者只有在「光标在图片行上也不换形态」时才不打架 —— 否则光标一落上去
             * 源码就自己出来了，那次 Backspace 也就无从谈起。
             */
            if (!showsSource(from, to) && raw) {
              const line = doc.lineAt(from);
              const alone = line.from === from && doc.lineAt(to).to === to;
              replaceWith(from, to, new ImageWidget(raw, alt, alone, settings.notePath, state.sliceDoc(from, to)));
              if (alone) lineDeco(from, "md-media-line");
              return false;
            }
            mark(from, to, "md-src");
            // 块级图片（独占一行）渲染态有几十上百像素高，源码态只有一行 ——
            // 差额补成留白，否则拆开图片下方内容就跳。
            applyPad(from, to, doc.lineAt(from).from);
            return false;
          }

          if (labelTo > labelFrom) mark(labelFrom, labelTo, "md-link");
          if (!showsSource(from, to)) {
            for (const markNode of marks) hide(markNode.from, markNode.to);
            if (urlNode) hide(urlNode.from, urlNode.to);
            const title = node.getChild("LinkTitle");
            if (title) hide(title.from, title.to);
          } else if (raw && urlNode) {
            mark(urlNode.from, urlNode.to, "md-src");
          }
          return;
        }

        if (name === "InlineMath") {
          if (!isActive(from, to)) {
            replaceWith(from, to, new MathWidget(stripMathDollars(state.sliceDoc(from, to)), false));
            return false;
          }
          mark(from, to, "md-src");
          return false;
        }

        if (name === "MathBlock") {
          const startLine = doc.lineAt(from);
          const endLine = doc.lineAt(to);
          const raw = state.sliceDoc(from, to);
          // A closed block always renders as a widget; so does a short unclosed
          // one. A long unclosed block stays visible as source instead (D13).
          const closed = /\$\$\s*$/.test(raw);
          if (!isActive(from, to) && (closed || endLine.number - startLine.number < MAX_UNCLOSED_MATH_LINES)) {
            replaceWith(startLine.from, Math.max(endLine.to, startLine.to), new MathWidget(stripMathFence(raw), true, state.sliceDoc(from, to)), true);
            return false;
          }
          for (let n = startLine.number; n <= endLine.number; n += 1) lineDeco(doc.line(n).from, "md-math-src");
          applyPad(from, to, endLine.from);
          return false;
        }

        if (name === "WikiLink") {
          const label = state.sliceDoc(from + 2, Math.max(from + 2, to - 2));
          if (!isActive(from, to)) {
            replaceWith(from, to, new WikiLinkWidget(label, bridge.hasNote(label)));
            return false;
          }
          mark(from, to, "md-src");
          return false;
        }

        /* ------------------------------------------------------------- code */
        if (name === "FencedCode") {
          const info = node.getChild("CodeInfo");
          const lang = info ? state.sliceDoc(info.from, info.to).trim().split(/\s+/)[0].toLowerCase() : "";
          const startLine = doc.lineAt(from);
          const endLine = doc.lineAt(to);
          if (lang === "mermaid" && !isActive(from, to)) {
            const codeText = state.sliceDoc(startLine.to, endLine.from).trim();
            replaceWith(
              startLine.from,
              Math.max(endLine.to, startLine.to),
              new MermaidWidget(codeText, settings.theme, settings.appearance, state.sliceDoc(from, to)),
              true,
            );
            return false;
          }
          /*
           * 围栏什么时候露？
           *
           * - `revealMarks`（逃生舱：一直看着源码）
           * - 光标**停在其中一条围栏行上**（原来只要在块内任意位置就露，于是在代码里
           *   上下移动光标会让块高反复变化 47px —— 这一条是修掉的）
           * - **代码内容为空**：空代码块还不成立，露出围栏才改得动语言/删得掉它 ——
           *   和空标题、空引用同一条「块还没成立就显示源码」的规则
           */
          const codeBody = state.sliceDoc(startLine.to, endLine.from);
          const showFences =
            revealMarks ||
            codeBody.trim().length === 0 ||
            activeLines.has(startLine.number) ||
            activeLines.has(endLine.number);
          for (let n = startLine.number; n <= endLine.number; n += 1) {
            const line = doc.line(n);
            const isFirst = n === startLine.number;
            const isLast = n === endLine.number;
            if (isFirst || isLast) {
              lineDeco(line.from, showFences ? "md-code-fence" : "md-hide-line");
              continue;
            }
            const cls = ["md-code-line"];
            if (n === startLine.number + 1) cls.push("md-code-first");
            if (n === endLine.number - 1) cls.push("md-code-last");
            lineDeco(
              line.from,
              cls.join(" "),
              lang && n === startLine.number + 1 ? { "data-lang": lang } : undefined,
            );
          }
          // mermaid 块在光标进入时换成源码（围栏 + 代码），渲染态却有几百像素高 ——
          // 差额补成留白，否则点进图表下方内容整块跳。普通代码块没有「渲染态」，
          // 源码就是它的形态，不需要补。
          if (lang === "mermaid") {
            /*
             * 补白必须落在**最后一条可见的行**上，不能想当然落在闭围栏行：
             * 光标在代码正文里时围栏是 `md-hide-line`（`display:none`），
             * 补在它上面的 `padding-bottom` 完全不参与布局 —— 高度永远补不上去，
             * `blockPad` 插件就会一轮轮加大补白（实测发散到 2298px）。
             */
            const lastVisible = showFences ? endLine.number : Math.max(startLine.number, endLine.number - 1);
            applyPad(from, to, doc.line(lastVisible).from);
          }
          return;
        }

        if (name === "CodeBlock") {
          const startLine = doc.lineAt(from);
          const endLine = doc.lineAt(to);
          for (let n = startLine.number; n <= endLine.number; n += 1) {
            const cls = ["md-code-line"];
            if (n === startLine.number) cls.push("md-code-first");
            if (n === endLine.number) cls.push("md-code-last");
            lineDeco(doc.line(n).from, cls.join(" "));
          }
          return;
        }

        /* ------------------------------------------------------------ quotes */
        if (name === "Blockquote") {
          let depth = 0;
          for (let cur: SyntaxNode | null = node; cur; cur = cur.parent) if (cur.name === "Blockquote") depth += 1;
          const startLine = doc.lineAt(from);
          const endLine = doc.lineAt(to);
          for (let n = startLine.number; n <= endLine.number; n += 1) {
            lineDeco(doc.line(n).from, `md-quote md-quote-${Math.min(depth, 3)}`);
          }
          if (!showsSource(from, to)) {
            for (let child = node.firstChild; child; child = child.nextSibling) {
              if (child.name === "QuoteMark") {
                hide(child.from, Math.min(child.to + 1, doc.lineAt(child.from).to));
              }
            }
          }
          return;
        }

        if (name === "QuoteMark") {
          /*
           * 逐行判：这一行 `>` 后面还有文字才隐藏标记。
           *
           * 空行留着 `>` 可见 —— 空引用还不成立，和空标题、空列表项同一条规则
           * （「块还没成立就显示源码」）。这一条比在 Blockquote 上判更准：
           * QuoteMark 是 Paragraph 的子节点，不是 Blockquote 的直接子节点。
           */
          const line = doc.lineAt(from);
          const markEnd = Math.min(to + 1, line.to);
          const rest = state.sliceDoc(markEnd, line.to);
          if (rest.trim().length > 0 && !showsSource(from, to)) hide(from, markEnd);
          else mark(from, markEnd, "md-src");
          return false;
        }

        /* ------------------------------------------------------------- lists */
        if (name === "ListMark") {
          const listType = node.parent?.parent?.name;
          if (listType === "BulletList" || listType === "OrderedList") {
            if (listType === "BulletList") {
              // 空列表项（`- ` 后面还没有文字）显示源码，和空标题/空引用同一条规则。
              const item = node.parent;
              const empty = item ? isEmptyBlock(to, item.to) : false;
              if (!empty && !showsSource(from, to)) {
                let depth = 0;
                for (let cur: SyntaxNode | null = node; cur; cur = cur.parent) if (cur.name === "BulletList") depth += 1;
                replaceWith(from, to, new BulletWidget(Math.max(1, depth)));
                return false;
              }
              mark(from, to, "md-src");
              return false;
            }
            mark(from, to, "md-num");
            return false;
          }
          return;
        }

        if (name === "TaskMarker") {
          const raw = state.sliceDoc(from, to);
          replaceWith(from, to, new CheckboxWidget(/[xX]/.test(raw)));
          return false;
        }

        /* ------------------------------------------------------------ blocks */
        if (name === "HorizontalRule") {
          if (!isActive(from, to)) {
            const line = doc.lineAt(from);
            replaceWith(line.from, line.to, new HrWidget(state.sliceDoc(from, to)), true);
          } else {
            lineDeco(from, "md-src");
            applyPad(from, to, doc.lineAt(from).from);
          }
          return false;
        }

        if (name === "Table") {
          const startLine = doc.lineAt(from);
          const endLine = doc.lineAt(to);
          if (!isActive(from, to)) {
            const source = state.sliceDoc(startLine.from, endLine.to);
            replaceWith(
              startLine.from,
              Math.max(endLine.to, startLine.to),
              new TableWidget(renderMarkdown(source), endLine.number - startLine.number + 1, state.sliceDoc(from, to)),
              true,
            );
            return false;
          }
          for (let n = startLine.number; n <= endLine.number; n += 1) lineDeco(doc.line(n).from, "md-table-src");
          // 渲染态的表格比源码高得多（实测 4 列表格差 92px）：差额补成留白，
          // 否则点进表格时它下方的内容整块上跳 130px。
          applyPad(from, to, endLine.from);
          // keep descending: the delimiter marks live on the table's children
          return;
        }

        if (name === "TableDelimiter") {
          mark(from, to, "md-table-delim");
          return false;
        }

        return;
      },
    });
  }

  /* ------------------------------------------------------------ focus mode */
  if (settings.focus) {
    const head = Math.min(state.selection.main.head, doc.length);
    let block: SyntaxNode | null = tree.resolveInner(head, 1);
    while (block?.parent && block.parent.name !== "Document") block = block.parent;
    if (block && block.name !== "Document" && spans.some((span) => block!.from >= span.from && block!.to <= span.to)) {
      const startLine = doc.lineAt(block.from);
      const endLine = doc.lineAt(block.to);
      for (let n = startLine.number; n <= endLine.number; n += 1) lineDeco(doc.line(n).from, "md-focus-on");
    }
  }
}

/** Decorate the whole document (the path used for small documents). */
function buildDecorations(
  state: EditorState,
  pads: ReadonlyMap<string, number> = new Map(),
  epoch = 1,
  unwrapped: Span | null = null,
): LivePreviewValue {
  const doc = state.doc;
  const active = selectionSpans(state);
  if (doc.length === 0 || doc.length > MAX_DECORATED_LENGTH) {
    return { set: Decoration.none, active, parsedTo: syntaxTree(state).length, epoch, pads, unwrapped };
  }
  const settings = state.field(editorSettingsField, false) ?? defaultEditorSettings;
  const decorations: Range<Decoration>[] = [];
  decorate(state, settings, [{ from: 0, to: doc.length }], active, decorations, pads, unwrapped);
  return { set: Decoration.set(decorations, true), active, parsedTo: syntaxTree(state).length, epoch, pads, unwrapped };
}

/** Reuse the previous decoration set and only redo the blocks that changed. */
function updateDecorations(
  value: LivePreviewValue,
  tr: Transaction,
  fullRebuild: boolean,
  pads: ReadonlyMap<string, number>,
  unwrapped: Span | null,
): LivePreviewValue {
  const state = tr.state;
  const doc = state.doc;
  const active = selectionSpans(state);
  const epoch = value.epoch + 1;
  if (doc.length === 0 || doc.length > MAX_DECORATED_LENGTH) {
    return { set: Decoration.none, active, parsedTo: syntaxTree(state).length, epoch, pads, unwrapped };
  }
  // 补白变了就得整体重算：它落在具体某几行上，增量路径的 filter/update 不会把它带上。
  if (fullRebuild || doc.length < FULL_REBUILD_LENGTH) return buildDecorations(state, pads, epoch, unwrapped);
  const settings = state.field(editorSettingsField, false) ?? defaultEditorSettings;
  const tree = syntaxTree(state);

  // everything the previous build produced, moved to the new document
  let set = value.set.map(tr.changes);

  // collect the document regions that may need different decorations: the
  // changed text, the lines the cursor left and the lines it moved to
  const dirty: Span[] = [];
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (toB > fromB) dirty.push({ from: fromB, to: toB });
    // the old side is mapped explicitly so decorations of removed text are
    // filtered out even when they collapsed onto a point
    if (toA > fromA) dirty.push({ from: tr.changes.mapPos(fromA, -1), to: tr.changes.mapPos(toA, 1) });
  });
  for (const [from, to] of value.active) dirty.push({ from: tr.changes.mapPos(from, -1), to: tr.changes.mapPos(to, 1) });
  for (const [from, to] of active) dirty.push({ from, to });
  // the background parser may have caught up since the last build
  if (tree.length > value.parsedTo) dirty.push({ from: Math.max(0, value.parsedTo - 1), to: tree.length });

  const spans = mergeSpans(dirty.map((span) => blockSpan(tree, state, span.from, span.to)));
  const decorations: Range<Decoration>[] = [];
  for (const span of spans) {
    set = set.update({
      filterFrom: span.from,
      filterTo: span.to,
      filter: (from, to) => !(from >= span.from && to <= span.to),
    });
    decorations.length = 0;
    decorate(state, settings, [span], active, decorations, pads, unwrapped);
    if (decorations.length) set = set.update({ add: decorations.slice(), sort: true });
  }
  return { set, active, parsedTo: tree.length, epoch, pads, unwrapped };
}

export const livePreviewField = StateField.define<LivePreviewValue>({
  create: (state) => buildDecorations(state, new Map(), 0, null),
  update(value, tr) {
    const settingsChanged = tr.effects.some(
      (effect) => effect.is(setEditorSettings) || effect.is(refreshDecorations),
    );
    /*
     * 补白变化（`setBlockPad`）也要重算 —— 它落在具体某几行上。
     *
     * 这里顺手把「没变」的 effect 丢掉：`blockPadPlugin` 每次装饰换形态都会量一次并
     * 派发，差值小于 1px 就不该白重算一遍，否则量 → 派发 → 重算 → 再量会一直循环。
     */
    let pads = value.pads;
    for (const effect of tr.effects) {
      if (!effect.is(setBlockPad)) continue;
      const { key, pad } = effect.value;
      const current = pads.get(key) ?? 0;
      if (Math.abs(current - pad) < 1) continue;
      const next = new Map(pads);
      if (pad > 1) next.set(key, pad);
      else next.delete(key);
      pads = next;
    }
    const padsChanged = pads !== value.pads;

    /*
     * 「拆开这一段」（`unwrapSource`）：光标停在已渲染元素的边界上按删除时，由 `unwrap.ts`
     * 的键处理器发出 —— 先露源码、吃掉这次按键，而不是直接删内容。
     *
     * 只留**一段**，而且**光标一离开就收起来**：它是「我正在拆这一个」的临时状态，
     * 不是一份持久清单。不这么做的话，用户点一下别处回来会发现标记莫名其妙还在。
     */
    let unwrapped = value.unwrapped;
    let unwrapChanged = false;
    for (const effect of tr.effects) {
      if (!effect.is(unwrapSource)) continue;
      const { from, to } = effect.value;
      if (unwrapped && unwrapped.from === from && unwrapped.to === to) continue;
      unwrapped = { from, to };
      unwrapChanged = true;
    }
    if (unwrapped) {
      // 跟着文档一起移动，否则敲一个字之后范围就错位了
      if (tr.docChanged) {
        const from = tr.changes.mapPos(unwrapped.from, -1);
        const to = tr.changes.mapPos(unwrapped.to, 1);
        if (from !== unwrapped.from || to !== unwrapped.to) {
          unwrapped = { from, to };
          unwrapChanged = true;
        }
      }
      // 光标离开这一段就收起来。±1 是容忍「贴着边界」的那一格 ——
      // 拆开之后光标通常就停在边界上。
      if (tr.selection) {
        const head = tr.state.selection.main.head;
        if (head < unwrapped.from - 1 || head > unwrapped.to + 1) {
          unwrapped = null;
          unwrapChanged = true;
        }
      }
    }
    // D28：后台解析器推进语法树时发的是**只有 effect** 的事务 ——
    // `@codemirror/language` 的 ParseWorker 走的是
    // `dispatch({ effects: Language.setState.of(new LanguageState(field.context)) })`，
    // 既没有 docChanged 也没有 selection。只看这两个会把它们全部漏掉，于是
    // 文档尾部一直停在**原始 markdown**，直到用户下一次点击/打字才一次性补上
    // 全部装饰 —— 那一下就是整篇重排（实测 6309 字文档一次补 880 条）。
    //
    // 所以「语法树推进了」也必须算作要重算的理由。比较的是 `parsedTo`（上次构建时的
    // 树长）而不是文档长度：树没动就照旧直接返回，不白跑一遍。
    if (
      !tr.docChanged &&
      !tr.selection &&
      !settingsChanged &&
      !padsChanged &&
      !unwrapChanged &&
      syntaxTree(tr.state).length === value.parsedTo
    ) {
      return value;
    }
    return updateDecorations(value, tr, settingsChanged || padsChanged || unwrapChanged, pads, unwrapped);
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.set),
});

export const livePreview = [livePreviewField];

/**
 * @internal exported for the regression tests — the full, non-incremental build.
 *
 * 带上**当前状态里的补白**：`blockPad` 插件把补白记在字段的 `pads` 上，全量重建必须
 * 用它，否则「增量结果 == 全量重建」这条等价性断言会把补白当成增量路径的私货。
 */
export function livePreviewDecorations(state: EditorState): DecorationSet {
  const field = state.field(livePreviewField, false);
  return buildDecorations(state, field?.pads ?? new Map<string, number>(), 1, field?.unwrapped ?? null).set;
}

/** 一张图片在文档里的位置：整段 markdown，以及其中**引用串**那一段。 */
export interface ImageSourceRange {
  from: number;
  to: number;
  /** `![说明](这里)` 里「这里」的范围 —— 「编辑图片」把光标落在这儿。 */
  urlFrom: number;
  urlTo: number;
}

/** `![说明](url "标题")` 里 url 那一段的偏移（相对 `source` 起点）。 */
function urlRangeInSource(from: number, source: string): { urlFrom: number; urlTo: number } {
  const open = source.indexOf("](");
  if (open < 0) return { urlFrom: from, urlTo: from + source.length };
  let start = open + 2;
  while (start < source.length && /\s/.test(source[start])) start += 1;
  const body = source.endsWith(")") ? source.slice(start, -1) : source.slice(start);
  const space = body.search(/\s/); // `(url "标题")` —— 取到标题前为止
  const urlLength = space < 0 ? body.length : space;
  return { urlFrom: from + start, urlTo: from + start + urlLength };
}

/**
 * 按**完整的 markdown 源码**（`![说明](引用)`）在文档里定位那张图片。
 *
 * 给宿主用：右键菜单拿到的是编辑器交出来的原文串（`openImageMenu` 的 `source`），
 * 而只有语法树知道它在文档里的确切范围。**不能拿字符串 `indexOf` 去猜** ——
 * 同一张图可能被引用两次，`![a](x.png)` 也可能只是代码块里的字面量。
 *
 * `hintFrom` 是**被右键的那一个**在文档里的起点（编辑器用 `posAtDOM` 取）。
 * 给了它就必须命中那一处 —— 同一张图出现两次时，只有这样才删得对／编辑得对。
 * 命中不了返回 `null` 而不是退回第一处：宁可报「没找到」，也不能删错到别的地方去。
 */
export function findImageSource(
  state: EditorState,
  source: string,
  hintFrom = -1,
): ImageSourceRange | null {
  // 既没有位置也没有源码串 ⇒ 无从下手。只有位置是完全可以定位的。
  if (!source && hintFrom < 0) return null;
  // 用数组而不是 `let found`：在 `iterate` 的回调里赋值会让 TS 的控制流分析把
  // 外面的变量收窄成 `null`，`return found` 就过不了类型检查。
  const hit: ImageSourceRange[] = [];
  syntaxTree(state).iterate({
    /*
     * ⚠️ `iterate` 的回调收到的是 `SyntaxNodeRef`，**不是 `SyntaxNode`** ——
     * 它有 `name` / `from` / `to`，但**没有 `getChild()`**，要经 `.node` 拿真正的节点。
     * 直接 `ref.getChild(...)` 会抛 `TypeError`，而这个异常发生在菜单项的 `run()` 里，
     * 表现是「点了没反应」。
     */
    enter: (ref) => {
      if (ref.name !== "Image") return;
      const node = ref.node;
      /*
       * 有位置就**只认位置**。
       *
       * `hintFrom` 是被右键的那个元素经 `posAtDOM` 得到的，比源码串可靠：串可能来自
       * 半更新的 bridge（`undefined`／空串），也可能因为转义写法与节点文本不完全一致。
       * 只按串匹配，会让「删除图片」莫名其妙报「没找到这张图片」。
       */
      if (hintFrom >= 0 ? node.from !== hintFrom : state.sliceDoc(node.from, node.to) !== source) return;
      const url = node.getChild("URL");
      hit.push({
        from: node.from,
        to: node.to,
        urlFrom: url ? url.from : node.from,
        urlTo: url ? url.to : node.to,
      });
    },
  });
  if (hit[0]) return hit[0];

  /*
   * 语法树里没有 ⇒ **解析还没追上这一段**。
   *
   * `@codemirror/language` 的 `LanguageState.init` 只**同步**解析前 3000 个字符，其余交给
   * 后台 ParseWorker 分片做。于是刚打开一篇长笔记、图片在 3000 字符之后时，
   * `syntaxTree()` 里可能真的还没有那个 Image 节点。
   *
   * 这时不能就这么放弃：位置是右键那一刻从 DOM 取的，拿它做一次纯文本校验就够了，
   * 而且这个兜底只认**精确位置**，不会像 `indexOf` 那样命中别处。
   */
  if (hintFrom >= 0 && source.length > 0) {
    const end = Math.min(hintFrom + source.length, state.doc.length);
    if (state.sliceDoc(hintFrom, end) === source) {
      return { from: hintFrom, to: end, ...urlRangeInSource(hintFrom, source) };
    }
  }
  return null;
}
