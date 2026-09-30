import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode, Tree } from "@lezer/common";
import { type EditorState, type Range, StateField, type Transaction } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, type WidgetType } from "@codemirror/view";
import { renderMarkdown } from "../lib/markdown";
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
}

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
  /** A node on a line that touches the cursor keeps its raw markdown. */
  const isActive = (from: number, to: number) => {
    for (const [start, end] of active) {
      if (from <= end && to >= start) return true;
    }
    return false;
  };

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
          if (!isActive(from, to)) {
            const markNode = node.getChild("HeaderMark");
            if (markNode) hide(markNode.from, Math.min(markNode.to + 1, to));
          }
          return;
        }
        const setext = /^SetextHeading([12])$/.exec(name);
        if (setext) {
          lineDeco(from, `md-h${setext[1]}`);
          if (!isActive(from, to)) {
            const markNode = node.getChild("HeaderMark");
            if (markNode) {
              const line = doc.lineAt(markNode.from);
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
          if (!isActive(from, to)) {
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
            if (!isActive(from, to)) {
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
            if (!isActive(from, to) && raw) {
              const line = doc.lineAt(from);
              const alone = line.from === from && doc.lineAt(to).to === to;
              replaceWith(from, to, new ImageWidget(raw, alt, alone, settings.notePath));
              if (alone) lineDeco(from, "md-media-line");
              return false;
            }
            mark(from, to, "md-src");
            return false;
          }

          if (labelTo > labelFrom) mark(labelFrom, labelTo, "md-link");
          if (!isActive(from, to)) {
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
            replaceWith(startLine.from, Math.max(endLine.to, startLine.to), new MathWidget(stripMathFence(raw), true), true);
            return false;
          }
          for (let n = startLine.number; n <= endLine.number; n += 1) lineDeco(doc.line(n).from, "md-math-src");
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
              new MermaidWidget(codeText, settings.theme, settings.appearance),
              true,
            );
            return false;
          }
          const showFences = isActive(from, to);
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
          if (!isActive(from, to)) {
            for (let child = node.firstChild; child; child = child.nextSibling) {
              if (child.name === "QuoteMark") {
                hide(child.from, Math.min(child.to + 1, doc.lineAt(child.from).to));
              }
            }
          }
          return;
        }

        if (name === "QuoteMark") {
          if (!isActive(from, to)) hide(from, Math.min(to + 1, doc.lineAt(from).to));
          return false;
        }

        /* ------------------------------------------------------------- lists */
        if (name === "ListMark") {
          const listType = node.parent?.parent?.name;
          if (listType === "BulletList" || listType === "OrderedList") {
            if (listType === "BulletList") {
              if (!isActive(from, to)) {
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
            replaceWith(line.from, line.to, new HrWidget(), true);
          } else {
            lineDeco(from, "md-src");
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
              new TableWidget(renderMarkdown(source), endLine.number - startLine.number + 1),
              true,
            );
            return false;
          }
          for (let n = startLine.number; n <= endLine.number; n += 1) lineDeco(doc.line(n).from, "md-table-src");
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
function buildDecorations(state: EditorState): LivePreviewValue {
  const doc = state.doc;
  const active = selectionSpans(state);
  if (doc.length === 0 || doc.length > MAX_DECORATED_LENGTH) {
    return { set: Decoration.none, active, parsedTo: syntaxTree(state).length };
  }
  const settings = state.field(editorSettingsField, false) ?? defaultEditorSettings;
  const decorations: Range<Decoration>[] = [];
  decorate(state, settings, [{ from: 0, to: doc.length }], active, decorations);
  return { set: Decoration.set(decorations, true), active, parsedTo: syntaxTree(state).length };
}

/** Reuse the previous decoration set and only redo the blocks that changed. */
function updateDecorations(value: LivePreviewValue, tr: Transaction, settingsChanged: boolean): LivePreviewValue {
  const state = tr.state;
  const doc = state.doc;
  const active = selectionSpans(state);
  if (doc.length === 0 || doc.length > MAX_DECORATED_LENGTH) {
    return { set: Decoration.none, active, parsedTo: syntaxTree(state).length };
  }
  if (settingsChanged || doc.length < FULL_REBUILD_LENGTH) return buildDecorations(state);
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
    decorate(state, settings, [span], active, decorations);
    if (decorations.length) set = set.update({ add: decorations.slice(), sort: true });
  }
  return { set, active, parsedTo: tree.length };
}

export const livePreviewField = StateField.define<LivePreviewValue>({
  create: (state) => buildDecorations(state),
  update(value, tr) {
    const settingsChanged = tr.effects.some(
      (effect) => effect.is(setEditorSettings) || effect.is(refreshDecorations),
    );
    if (!tr.docChanged && !tr.selection && !settingsChanged) return value;
    return updateDecorations(value, tr, settingsChanged);
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.set),
});

export const livePreview = [livePreviewField];

/** @internal exported for the regression tests — the full, non-incremental build. */
export function livePreviewDecorations(state: EditorState): DecorationSet {
  return buildDecorations(state).set;
}
