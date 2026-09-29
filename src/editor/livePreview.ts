import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { type EditorState, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, type WidgetType } from "@codemirror/view";
import { renderMarkdown } from "../lib/markdown";
import { bridge } from "./bridge";
import { stripMathDollars, stripMathFence } from "./math";
import { defaultEditorSettings, editorSettingsField, refreshDecorations, setEditorSettings } from "./settings";
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

const MARK_RE = /^(?:EmphasisMark|StrikethroughMark|HighlightMark|LinkMark|ImageMark|CodeMark|WikiLinkMark)$/;
const LINK_MARK_RE = /^(?:LinkMark|ImageMark)$/;

/**
 * The heart of the Typora feel: markdown syntax is still the document, but the
 * parts you are not editing are decorated into their rendered form. Everything
 * that needs a block widget (tables, formulas, diagrams, rules) lives here,
 * because CodeMirror only allows block decorations from a state field.
 */
function buildDecorations(state: EditorState): DecorationSet {
  const doc = state.doc;
  if (doc.length === 0 || doc.length > MAX_DECORATED_LENGTH) return Decoration.none;
  const settings = state.field(editorSettingsField, false) ?? defaultEditorSettings;

  const decorations: Range<Decoration>[] = [];
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

  const selectionSpans: [number, number][] = state.selection.ranges.map((range) => [
    doc.lineAt(range.from).from,
    doc.lineAt(range.to).to,
  ]);
  /** A node on a line that touches the cursor keeps its raw markdown. */
  const isActive = (from: number, to: number) => {
    for (const [start, end] of selectionSpans) {
      if (from <= end && to >= start) return true;
    }
    return false;
  };

  const tree = syntaxTree(state);

  tree.iterate({
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
            replaceWith(from, to, new ImageWidget(raw, alt, alone, settings.baseDir));
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
        if (!isActive(from, to)) {
          replaceWith(
            startLine.from,
            Math.max(endLine.to, startLine.to),
            new MathWidget(stripMathFence(state.sliceDoc(from, to)), true),
            true,
          );
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
        replaceWith(from, to, new CheckboxWidget(/[xX]/.test(raw), from, to));
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
            new TableWidget(renderMarkdown(source), startLine.from, endLine.number - startLine.number + 1),
            true,
          );
          return false;
        }
        for (let n = startLine.number; n <= endLine.number; n += 1) lineDeco(doc.line(n).from, "md-table-src");
        return;
      }

      if (name === "TableDelimiter") {
        mark(from, to, "md-table-delim");
        return false;
      }

      return;
    },
  });

  /* ------------------------------------------------------------ focus mode */
  if (settings.focus) {
    const head = state.selection.main.head;
    let block: SyntaxNode | null = tree.resolveInner(Math.min(head, doc.length), 1);
    while (block?.parent && block.parent.name !== "Document") block = block.parent;
    if (block && block.name !== "Document") {
      const startLine = doc.lineAt(block.from);
      const endLine = doc.lineAt(block.to);
      for (let n = startLine.number; n <= endLine.number; n += 1) lineDeco(doc.line(n).from, "md-focus-on");
    }
  }

  return Decoration.set(decorations, true);
}

export const livePreviewField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update(value, tr) {
    const settingsChanged = tr.effects.some(
      (effect) => effect.is(setEditorSettings) || effect.is(refreshDecorations),
    );
    if (!tr.docChanged && !tr.selection && !settingsChanged) return value;
    return buildDecorations(tr.state);
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const livePreview = [livePreviewField];
