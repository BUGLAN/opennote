/**
 * jump-probe — mounts Opennote's REAL CodeMirror 6 extensions in a plain page so
 * the "content jumps while editing" complaint can be measured with real pixels.
 *
 * Nothing under `src/**` is touched: the probe imports the same modules the app
 * does (`livePreviewField`, `markdownSupport`, `editorTheme`, `editorSettingsField`)
 * and wires them into a minimal EditorView.
 *
 * Everything is exposed on `window.PROBE` and driven from outside with
 * `node scripts/cdp-eval.mjs <port> <expr>` (see run.sh).
 */
import { cursorLineDown, cursorLineUp, history } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, drawSelection } from "@codemirror/view";
/*
 * The same stylesheets/fonts `src/main.tsx` pulls in. Without them the probe
 * would measure fallback-font metrics, and the numbers would not be comparable
 * with the real app. Only `app.css` is left out — the probe has no app shell,
 * and the handful of shell rules it needs are inlined in `index.html`.
 */
import "@fontsource-variable/fraunces/full.css";
import "@fontsource-variable/newsreader/opsz.css";
import "@fontsource-variable/newsreader/opsz-italic.css";
import "@fontsource-variable/figtree/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import "katex/dist/katex.min.css";
import { livePreviewField } from "../../src/editor/livePreview";
import { markdownSupport } from "../../src/editor/markdown";
import { editorSettingsField, setEditorSettings } from "../../src/editor/settings";
import { editorTheme } from "../../src/editor/theme";

/* --------------------------------------------------------------- test document */

const DOC_LINES: string[] = [
  "MARK0",
  "",
  "# 一级标题",
  "一级标题下的普通段落，用来占位。",
  "",
  "MARK1A",
  "",
  "Setext 标题",
  "==========",
  "",
  "MARK2A",
  "",
  "```js",
  "function alpha() {",
  "  return 1;",
  "}",
  "function beta() {",
  "  return 2;",
  "}",
  "function gamma() {",
  "  return 3;",
  "}",
  "```",
  "",
  "MARK3A",
  "",
  "| 列一 | 列二 | 列三 | 列四 |",
  "| --- | --- | --- | --- |",
  "| a1 | b1 | c1 | d1 |",
  "| a2 | b2 | c2 | d2 |",
  "| a3 | b3 | c3 | d3 |",
  "",
  "MARK4A",
  "",
  "```mermaid",
  "graph TD",
  "  A[开始] --> B[处理]",
  "  B --> C[结束]",
  "```",
  "",
  "MARK5A",
  "",
  "$$",
  "E = mc^2 + \\int_0^1 x^2\\,dx",
  "$$",
  "",
  "MARK6A",
  "",
  "![占位图](./x.png)",
  "",
  "MARK7A",
  "",
  "这里有一段含 **加粗文字ABC**、*斜体文字DEF*、`行内代码GHI`、[链接JKL](https://example.com) 的段落。",
  "",
  "MARK8A",
  "",
  "> 引用文字MNO",
  "",
  "MARK9A",
];

const DOC = DOC_LINES.join("\n");

/** A tall document used only by the "is the height map viewport dependent" test. */
function tallDoc(extra: number): string {
  const lines: string[] = ["TOP0", ""];
  lines.push("```js", "let a = 1;", "let b = 2;", "let c = 3;", "```", "", "AFTER-FENCE", "");
  for (let i = 0; i < extra; i += 1) lines.push(`填充段落 ${i}：用来把文档撑得比视口高很多。`, "");
  lines.push("BOTTOM-END");
  return lines.join("\n");
}

/** Tall document with one fenced code block buried in the middle. */
function tallFenceDoc(): string {
  return [
    "TOP0",
    "",
    ...Array.from({ length: 120 }, (_, i) => `填充段落 ${i}：把围栏推到首屏之外。`).flatMap((t) => [t, ""]),
    "```js",
    "let a = 1;",
    "let b = 2;",
    "let c = 3;",
    "```",
    "",
    "FENCE-END",
    "",
    ...Array.from({ length: 40 }, (_, i) => `围栏之后 ${i}。`).flatMap((t) => [t, ""]),
    "BOTTOM-END",
  ].join("\n");
}

/* --------------------------------------------------------------------- view */

const extensions = (listener?: (u: any) => void) => [
  editorTheme(),
  livePreviewField,
  markdownSupport,
  history(),
  drawSelection(),
  EditorState.allowMultipleSelections.of(true),
  EditorView.lineWrapping,
  editorSettingsField,
  EditorView.updateListener.of((u) => listener?.(u)),
];

const host = document.getElementById("host") as HTMLElement;
/**
 * The probe document is ~2.5k px tall; a default 1100 px window would leave the
 * lower markers unrendered (CodeMirror only renders its viewport). The host is
 * therefore made tall enough that *every* line exists in the DOM, so a
 * `getBoundingClientRect()` on any marker is a real measurement and not a guess.
 * Scenario D gets its own, short host on purpose — it needs something to scroll.
 */
const MAIN_HOST_HEIGHT = 2600;
host.style.height = `${MAIN_HOST_HEIGHT}px`;
let updateCount = 0;
const view: EditorView = new EditorView({
  parent: host,
  state: EditorState.create({
    doc: DOC,
    extensions: extensions(() => {
      updateCount += 1;
    }),
  }),
});

function newView(parent: HTMLElement, doc: string): EditorView {
  return new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: extensions() }),
  });
}

/* ------------------------------------------------------------------ helpers */

const raf = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function settle(frames = 3, ms = 120): Promise<void> {
  for (let i = 0; i < frames; i += 1) await raf();
  if (ms) await sleep(ms);
  for (let i = 0; i < 3; i += 1) await raf();
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Scroll the *window* so `el` is fully inside it.
 *
 * CodeMirror's `visiblePixelRange()` (dist/index.js:6362-6385) clips the pixel
 * viewport to `window.innerWidth/innerHeight` **and** to the scroll parent. A
 * probe editor that hangs below the window bottom would therefore be measured as
 * if only the sliver inside the window were visible, which changes how CM picks
 * its viewport. Every extra probe host is brought into view before it is used.
 */
async function showHost(el: HTMLElement): Promise<void> {
  const top = el.getBoundingClientRect().top + window.scrollY;
  window.scrollTo(0, Math.max(0, top - 4));
  await raf();
  await raf();
}

function rectOf(el: Element | null | undefined) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r2(r.top), left: r2(r.left), right: r2(r.right), bottom: r2(r.bottom), width: r2(r.width), height: r2(r.height) };
}

function linesOf(v: EditorView): HTMLElement[] {
  return Array.from(v.contentDOM.querySelectorAll<HTMLElement>(".cm-line"));
}

function lineByText(v: EditorView, text: string): HTMLElement | null {
  return linesOf(v).find((el) => (el.textContent ?? "").includes(text)) ?? null;
}

/** `view.posAtDOM()` can return undefined for a node the tile tree does not know. */
function safePosAtDOM(v: EditorView, el: Element): number | null {
  try {
    const pos = v.posAtDOM(el);
    return typeof pos === "number" && Number.isFinite(pos) ? pos : null;
  } catch {
    return null;
  }
}

function posOf(needle: string, offset = 0): number {
  const at = DOC.indexOf(needle);
  if (at < 0) throw new Error(`needle not in doc: ${needle}`);
  return at + offset;
}

function coordsAt(v: EditorView, pos: number) {
  const c = v.coordsAtPos(pos);
  if (!c) return null;
  return { left: r2(c.left), right: r2(c.right), top: r2(c.top), bottom: r2(c.bottom), height: r2(c.bottom - c.top) };
}

function cursorLineOf(v: EditorView): number {
  return v.state.doc.lineAt(v.state.selection.main.head).number;
}

function snapshot(v: EditorView) {
  return {
    scrollTop: r2(v.scrollDOM.scrollTop),
    scrollHeight: v.scrollDOM.scrollHeight,
    clientHeight: v.scrollDOM.clientHeight,
    contentScrollHeight: v.contentDOM.scrollHeight,
    contentHeight: r2(v.contentHeight),
    cursorHead: v.state.selection.main.head,
    cursorLine: cursorLineOf(v),
  };
}

function setCursor(v: EditorView, pos: number, scrollIntoView = false) {
  v.dispatch(scrollIntoView ? { selection: { anchor: pos }, scrollIntoView: true } : { selection: { anchor: pos } });
}

/** First `.cm-line` whose bottom is below the scroller's top edge — CM's own scroll anchor. */
function anchorLineOf(v: EditorView) {
  const top = v.scrollDOM.getBoundingClientRect().top;
  for (const el of linesOf(v)) {
    const r = el.getBoundingClientRect();
    if (r.height > 0 && r.bottom > top + 8) return (el.textContent ?? "").slice(0, 24);
  }
  return null;
}

function scrollMarkerTo(v: EditorView, needle: string, mode: "center" | "top" | "justBelow" = "center") {
  const el = lineByText(v, needle);
  if (!el) return { ok: false, reason: `marker ${needle} not rendered` };
  const scrollerTop = v.scrollDOM.getBoundingClientRect().top;
  const scrollerH = v.scrollDOM.clientHeight;
  const rel = el.getBoundingClientRect().top - scrollerTop;
  const cur = v.scrollDOM.scrollTop;
  const target = mode === "center" ? cur + rel - scrollerH / 2 : mode === "top" ? cur + rel - 4 : cur + rel;
  v.scrollDOM.scrollTop = Math.max(0, target);
  return { ok: true, scrollTop: r2(v.scrollDOM.scrollTop) };
}

/* ------------------------------------------------------------------ block map */

interface BlockSpec {
  id: string;
  label: string;
  before: string;
  after: string;
  inside: string;
  insideOffset: number;
  blockSel: string;
  /** Position of a cursor that keeps this block inactive (defaults to `before`). */
  outsideFrom?: string;
}

const BLOCKS: BlockSpec[] = [
  { id: "h1", label: "ATX 一级标题", before: "MARK0", after: "MARK1A", inside: "一级标题", insideOffset: 1, blockSel: ".cm-line.md-h1" },
  { id: "setext", label: "Setext 标题", before: "MARK1A", after: "MARK2A", inside: "Setext 标题", insideOffset: 1, blockSel: ".cm-line.md-h2" },
  { id: "fence", label: "围栏代码块 ```js", before: "MARK2A", after: "MARK3A", inside: "function beta", insideOffset: 1, blockSel: ".cm-line.md-code-first" },
  { id: "table", label: "4 列表格", before: "MARK3A", after: "MARK4A", inside: "| a1 |", insideOffset: 1, blockSel: ".md-table" },
  { id: "mermaid", label: "mermaid 代码块", before: "MARK4A", after: "MARK5A", inside: "A[开始]", insideOffset: 1, blockSel: ".md-mermaid" },
  { id: "math", label: "$$ 公式块", before: "MARK5A", after: "MARK6A", inside: "E = mc^2", insideOffset: 1, blockSel: ".md-math.math-block" },
  { id: "image", label: "块级图片 ![alt](./x.png)", before: "MARK6A", after: "MARK7A", inside: "![占位图]", insideOffset: 2, blockSel: ".md-media" },
  { id: "quote", label: "引用块 >", before: "MARK7A", after: "MARK8A", inside: "引用文字MNO", insideOffset: 1, blockSel: ".cm-line.md-quote" },
];

/* ------------------------------------------------------------- scenario A */

async function runA() {
  await showHost(host);
  const rows: any[] = [];
  for (const b of BLOCKS) {
    const outsidePos = posOf(b.before, 2);
    const insidePos = posOf(b.inside, b.insideOffset);
    setCursor(view, outsidePos);
    await settle(3, 140);
    const before = {
      ...snapshot(view),
      markerFound: !!lineByText(view, b.after),
      marker: rectOf(lineByText(view, b.after)),
      block: rectOf(view.contentDOM.querySelector(b.blockSel)),
      activeCursorLine: view.state.doc.lineAt(outsidePos).number,
    };
    setCursor(view, insidePos);
    await settle(3, 160);
    const after = {
      ...snapshot(view),
      markerFound: !!lineByText(view, b.after),
      marker: rectOf(lineByText(view, b.after)),
      block: rectOf(view.contentDOM.querySelector(b.blockSel)),
      activeCursorLine: view.state.doc.lineAt(insidePos).number,
    };
    rows.push({
      id: b.id,
      label: b.label,
      outsidePos,
      insidePos,
      before,
      after,
      deltaMarkerTop: before.marker && after.marker ? r2(after.marker.top - before.marker.top) : null,
      deltaBlockTop: before.block && after.block ? r2(after.block.top - before.block.top) : null,
      deltaContentScrollHeight: after.contentScrollHeight - before.contentScrollHeight,
      deltaContentHeight: r2(after.contentHeight - before.contentHeight),
      deltaScrollTop: r2(after.scrollTop - before.scrollTop),
    });
  }
  setCursor(view, 0);
  await settle(2, 60);
  return rows;
}

/* ------------------------------------------------------------- scenario B */

interface InlineSpec {
  id: string;
  label: string;
  text: string;
  /** DOM selector of the rendered element, when the mark produces one. */
  sel?: string;
  /** Where the cursor sits to keep this mark hidden. */
  outside: string;
}

const INLINES: InlineSpec[] = [
  { id: "strong", label: "**加粗文字ABC**", text: "加粗文字ABC", sel: ".md-strong", outside: "MARK7A" },
  { id: "em", label: "*斜体文字DEF*", text: "斜体文字DEF", sel: ".md-em", outside: "MARK7A" },
  { id: "code", label: "`行内代码GHI`", text: "行内代码GHI", sel: ".md-code", outside: "MARK7A" },
  { id: "link", label: "[链接JKL](https://example.com)", text: "链接JKL", sel: ".md-link", outside: "MARK7A" },
  { id: "atx", label: "# 一级标题（标题标记）", text: "一级标题", sel: ".cm-line.md-h1", outside: "MARK7A" },
  { id: "quote", label: "> 引用文字MNO（引用标记）", text: "引用文字MNO", sel: ".cm-line.md-quote", outside: "MARK7A" },
];

async function runB() {
  await showHost(host);
  const rows: any[] = [];
  for (const spec of INLINES) {
    const outsidePos = posOf(spec.outside, 2);
    const textPos = posOf(spec.text);
    setCursor(view, outsidePos);
    await settle(3, 140);
    const beforeEl = spec.sel ? view.contentDOM.querySelector(spec.sel) : null;
    const before = {
      cursorLine: view.state.doc.lineAt(outsidePos).number,
      elementRect: rectOf(beforeEl),
      elementText: beforeEl ? (beforeEl.textContent ?? "").slice(0, 40) : null,
      coordsAtText: coordsAt(view, textPos),
      lineText: (lineByText(view, spec.text)?.textContent ?? "").slice(0, 80),
    };
    setCursor(view, textPos + 1);
    await settle(3, 160);
    const afterEl = spec.sel ? view.contentDOM.querySelector(spec.sel) : null;
    const after = {
      cursorLine: view.state.doc.lineAt(textPos + 1).number,
      elementRect: rectOf(afterEl),
      elementText: afterEl ? (afterEl.textContent ?? "").slice(0, 40) : null,
      coordsAtText: coordsAt(view, textPos),
      lineText: (lineByText(view, spec.text)?.textContent ?? "").slice(0, 80),
    };
    rows.push({
      id: spec.id,
      label: spec.label,
      before,
      after,
      deltaElementLeft:
        before.elementRect && after.elementRect ? r2(after.elementRect.left - before.elementRect.left) : null,
      deltaCoordsLeft:
        before.coordsAtText && after.coordsAtText ? r2(after.coordsAtText.left - before.coordsAtText.left) : null,
      deltaElementTop:
        before.elementRect && after.elementRect ? r2(after.elementRect.top - before.elementRect.top) : null,
      deltaCoordsTop:
        before.coordsAtText && after.coordsAtText ? r2(after.coordsAtText.top - before.coordsAtText.top) : null,
    });
  }
  setCursor(view, 0);
  await settle(2, 60);
  return rows;
}

/* ------------------------------------------------------------- scenario C */

let uniqueC = 0;

function asyncDoc(kind: "math" | "mermaid"): string {
  uniqueC += 1;
  const body =
    kind === "math"
      ? ["$$", `E = mc^2 + ${uniqueC} \\cdot \\int_0^1 x^2\\,dx`, "$$"]
      : ["```mermaid", "graph TD", `  A${uniqueC}[开始] --> B${uniqueC}[处理]`, `  B${uniqueC} --> C${uniqueC}[结束]`, "```"];
  return ["CBEFORE", "", ...body, "", "CAFTER", "", ...Array.from({ length: 12 }, (_, i) => `尾部段落 ${i}。`)].join("\n");
}

async function runC() {
  const out: any[] = [];
  for (const kind of ["math", "mermaid"] as const) {
    const host2 = document.createElement("div");
    host2.className = "probe-host";
    host2.style.height = "700px";
    document.body.appendChild(host2);
    const v = newView(host2, asyncDoc(kind));
    const marker = () => Array.from(v.contentDOM.querySelectorAll<HTMLElement>(".cm-line")).find((el) => (el.textContent ?? "").includes("CAFTER")) ?? null;
    const sel = kind === "math" ? ".md-math" : ".md-mermaid";
    const t0 = { at: 0, markerTop: rectOf(marker())?.top ?? null, loading: v.contentDOM.querySelectorAll(".is-loading").length, widget: rectOf(v.contentDOM.querySelector(sel)) };
    const timeline: any[] = [{ ...t0 }];
    const started = performance.now();
    let done = false;
    while (performance.now() - started < 20000) {
      await sleep(40);
      const loading = v.contentDOM.querySelectorAll(".is-loading").length;
      const rendered = v.contentDOM.querySelector(`${sel}:not(.is-loading)`);
      timeline.push({
        at: Math.round(performance.now() - started),
        markerTop: rectOf(marker())?.top ?? null,
        loading,
        rendered: !!rendered,
      });
      if (rendered && loading === 0) {
        done = true;
        break;
      }
    }
    await settle(4, 250);
    const t1 = { at: Math.round(performance.now() - started), markerTop: rectOf(marker())?.top ?? null, loading: v.contentDOM.querySelectorAll(".is-loading").length, widget: rectOf(v.contentDOM.querySelector(sel)) };
    out.push({
      kind,
      settled: done,
      t0,
      t1,
      deltaMarkerTop: t0.markerTop !== null && t1.markerTop !== null ? r2(t1.markerTop - t0.markerTop) : null,
      timeline,
      finalWidgetHtmlHead: (v.contentDOM.querySelector(sel)?.innerHTML ?? "").slice(0, 60),
    });
    v.destroy();
    host2.remove();
  }
  return out;
}

/* ------------------------------------------------------------- scenario D */

/**
 * D runs in its own 700 px-tall editor so there is something to scroll: the
 * question is whether CodeMirror's scroll anchoring (`view.measure()`,
 * @codemirror/view dist/index.js:8185-8279) pins the content when a block above
 * the viewport changes height.
 */
async function runD() {
  const results: any[] = [];
  const host2 = document.createElement("div");
  host2.className = "probe-host";
  host2.style.height = "700px";
  document.body.appendChild(host2);
  const v = newView(host2, DOC);
  await showHost(host2);
  await settle(6, 400);

  async function scenario(
    name: string,
    opts: { setup: (v: EditorView) => any; activate: (v: EditorView) => void; observe: string },
  ) {
    setCursor(v, posOf("MARK0", 2));
    v.scrollDOM.scrollTop = 0;
    await settle(4, 200);
    const setupInfo = await opts.setup(v);
    await settle(6, 350);
    const grab = () => {
      const scrollerTop = v.scrollDOM.getBoundingClientRect().top;
      const markerEl = lineByText(v, opts.observe);
      const marker = rectOf(markerEl);
      return {
        ...snapshot(v),
        scrollerTop: r2(scrollerTop),
        anchorLine: anchorLineOf(v),
        markerFound: !!markerEl,
        marker,
        /** Where the marker sits inside the scroller's viewport (the number a user sees move). */
        markerViewportTop: marker ? r2(marker.top - scrollerTop) : null,
        table: rectOf(v.contentDOM.querySelector(".md-table")),
        mathBlock: rectOf(v.contentDOM.querySelector(".md-math.math-block")),
        internals: (() => {
          const vs: any = (v as any).viewState;
          if (!vs) return null;
          const b = vs.scrollAnchorAt(vs.getScrollOffset());
          return { anchorFrom: b.from, anchorTop: r2(b.top), anchorText: v.state.doc.lineAt(b.from).text.slice(0, 20) };
        })(),
      };
    };
    const before = grab();
    opts.activate(v);
    await settle(6, 300);
    const after = grab();
    results.push({
      name,
      setupInfo,
      observe: opts.observe,
      before,
      after,
      deltaScrollTop: r2(after.scrollTop - before.scrollTop),
      deltaMarkerTop: before.marker && after.marker ? r2(after.marker.top - before.marker.top) : null,
      deltaMarkerViewportTop:
        before.markerViewportTop !== null && after.markerViewportTop !== null
          ? r2(after.markerViewportTop - before.markerViewportTop)
          : null,
      deltaContentScrollHeight: after.contentScrollHeight - before.contentScrollHeight,
      deltaAnchorTop: before.internals && after.internals ? r2(after.internals.anchorTop - before.internals.anchorTop) : null,
      pinned: before.markerViewportTop !== null && after.markerViewportTop !== null ? Math.abs(r2(after.markerViewportTop - before.markerViewportTop)) < 2 : null,
    });
  }

  /**
   * Scroll via the *height map* first, then refine with the real DOM rect.
   *
   * A single big scroll leaves the target widget unrendered (CM keeps its
   * viewport biased in the direction of travel), so a DOM-only setup would fail
   * with "no table widget". `lineBlockAt()` always answers.
   */
  const scrollToLineTop = async (v: EditorView, needle: string, offset: number) => {
    const pos = posOf(needle);
    const pass1 = Math.max(0, v.lineBlockAt(pos).top - offset);
    v.scrollDOM.scrollTop = pass1;
    await settle(5, 300);
    const el = lineByText(v, needle);
    const info: any = { pass1: r2(pass1), pass1Actual: r2(v.scrollDOM.scrollTop), rendered: !!el };
    if (el) {
      const rel = el.getBoundingClientRect().top - v.scrollDOM.getBoundingClientRect().top;
      v.scrollDOM.scrollTop = Math.max(0, v.scrollDOM.scrollTop + rel - offset);
      info.pass2 = r2(v.scrollDOM.scrollTop);
    }
    return info;
  };
  const scrollToLineBottomAboveTop = async (v: EditorView, needle: string, margin: number) => {
    const line = v.state.doc.lineAt(posOf(needle));
    const pass1 = v.lineBlockAt(line.to).bottom + margin;
    v.scrollDOM.scrollTop = pass1;
    await settle(5, 300);
    const el = lineByText(v, needle);
    const info: any = { pass1: r2(pass1), pass1Actual: r2(v.scrollDOM.scrollTop), rendered: !!el };
    if (el) {
      const rel = el.getBoundingClientRect().bottom - v.scrollDOM.getBoundingClientRect().top;
      v.scrollDOM.scrollTop = v.scrollDOM.scrollTop + rel + margin;
      info.pass2 = r2(v.scrollDOM.scrollTop);
    }
    return info;
  };

  // D1: the block that changes sits ABOVE the viewport's top line (CM's scroll anchor).
  await scenario("D1 变化块在锚点上方（表格整体滚到视口上方，观察 MARK6A）", {
    setup: (v) => scrollToLineBottomAboveTop(v, "| a3 |", 20),
    activate: (v) => setCursor(v, posOf("| a1 |", 1)),
    observe: "MARK6A",
  });

  // D2: the block that changes sits BELOW the anchor (table just under the top edge).
  await scenario("D2 变化块在锚点下方（表格贴视口顶部，观察 MARK4A——视口内可见）", {
    setup: (v) => scrollToLineTop(v, "| 列一 |", 60),
    activate: (v) => setCursor(v, posOf("| a1 |", 1)),
    observe: "MARK4A",
  });

  // D3: same as D2 but the transaction asks CM to keep the caret in view (what typing does).
  await scenario("D3 同 D2，但 dispatch 带 scrollIntoView（真实输入/方向键路径）", {
    setup: (v) => scrollToLineTop(v, "| 列一 |", 60),
    activate: (v) => setCursor(v, posOf("| a1 |", 1), true),
    observe: "MARK4A",
  });

  // D4: the math block (below the anchor) changes; MARK6A sits right under it.
  await scenario("D4 变化块是公式块（MARK5A 贴视口顶部，观察 MARK6A）", {
    setup: (v) => scrollToLineTop(v, "MARK5A", 20),
    activate: (v) => setCursor(v, posOf("E = mc^2", 1)),
    observe: "MARK6A",
  });

  // D5: the everyday case — the caret *leaves* a fenced code block, so the two
  // hidden fence lines come back as display:none and the block shrinks.
  await scenario("D5 光标离开围栏代码块（围栏行重新 display:none，观察 MARK3A）", {
    setup: async (v) => {
      setCursor(v, posOf("function beta", 1));
      await settle(5, 300);
      const pos = posOf("```js");
      v.scrollDOM.scrollTop = Math.max(0, v.lineBlockAt(pos).top - 20);
      return { ok: true, cursorInsideFence: true, scrollTop: r2(v.scrollDOM.scrollTop) };
    },
    activate: (v) => setCursor(v, posOf("MARK2A", 2)),
    observe: "MARK3A",
  });

  // D6: the table straddles the viewport's top edge (the ordinary "click into a
  // table that is half visible" case).
  await scenario("D6 表格跨视口上沿时点进表格（观察 MARK4A）", {
    setup: (v) => scrollToLineTop(v, "| 列一 |", -300),
    activate: (v) => setCursor(v, posOf("| a1 |", 1)),
    observe: "MARK4A",
  });

  v.destroy();
  host2.remove();
  return results;
}

/* ------------------------------------------------------------- scenario E */

async function runE() {
  const out: any = {};
  await showHost(host);

  // E1 — are the display:none lines really in the DOM?
  setCursor(view, posOf("MARK0", 2));
  view.scrollDOM.scrollTop = 0;
  await settle(4, 200);
  const hiddenEls = Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cm-line.md-hide-line"));
  out.hiddenLines = hiddenEls.map((el) => {
    const pos = safePosAtDOM(view, el);
    const line = pos === null ? null : view.state.doc.lineAt(pos);
    const block = pos === null ? null : view.lineBlockAt(pos);
    return {
      text: (el.textContent ?? "").slice(0, 24),
      docLine: line ? line.number : null,
      lineText: line ? line.text.slice(0, 24) : null,
      className: el.className,
      display: getComputedStyle(el).display,
      offsetHeight: el.offsetHeight,
      offsetTop: el.offsetTop,
      rect: rectOf(el),
      posAtDOM: pos,
      lineBlockAt: block ? { from: block.from, to: block.to, top: r2(block.top), height: r2(block.height) } : null,
      coordsAtPos: pos === null ? null : coordsAt(view, pos),
      posAtCoords_atOwnTop: (() => {
        if (pos === null) return null;
        const c = view.coordsAtPos(pos);
        if (c) return view.posAtCoords({ x: c.left + 2, y: c.top + 1 });
        const nextEl = el.nextElementSibling;
        const r = nextEl?.getBoundingClientRect();
        return r ? view.posAtCoords({ x: r.left + 4, y: r.top + 1 }) : null;
      })(),
    };
  });

  // E2 — height accounting: does the height map agree with the DOM?
  const sumLineHeights = linesOf(view).reduce((acc, el) => acc + el.getBoundingClientRect().height, 0);
  const cs = getComputedStyle(view.contentDOM);
  out.heightAccounting = {
    lineCount: linesOf(view).length,
    hiddenLineCount: hiddenEls.length,
    sumOfRenderedLineHeights: r2(sumLineHeights),
    contentScrollHeight: view.contentDOM.scrollHeight,
    scrollerScrollHeight: view.scrollDOM.scrollHeight,
    viewContentHeight: r2(view.contentHeight),
    contentPaddingTop: cs.paddingTop,
    contentPaddingBottom: cs.paddingBottom,
    scrollerClientHeight: view.scrollDOM.clientHeight,
    docLines: view.state.doc.lines,
  };

  // E3 — arrow-key navigation across a hidden fence line.
  setCursor(view, posOf("MARK2A", 2));
  view.scrollDOM.scrollTop = 0;
  await settle(4, 200);
  const steps: any[] = [];
  const recordStep = (label: string) => {
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    const markerEl = lineByText(view, "MARK3A");
    steps.push({
      label,
      head,
      docLine: line.number,
      lineText: line.text.slice(0, 24),
      lineHidden: (() => {
        const el = linesOf(view).find((e) => safePosAtDOM(view, e) === line.from);
        return el ? getComputedStyle(el).display === "none" : null;
      })(),
      caretCoords: coordsAt(view, head),
      marker3Top: rectOf(markerEl)?.top ?? null,
      contentScrollHeight: view.contentDOM.scrollHeight,
      scrollTop: r2(view.scrollDOM.scrollTop),
      anchorLine: anchorLineOf(view),
    });
  };
  recordStep("start (MARK2A)");
  for (let i = 1; i <= 4; i += 1) {
    cursorLineDown(view);
    await settle(4, 200);
    recordStep(`ArrowDown #${i}`);
  }
  out.arrowDown = steps;

  // E4 — same, going up from below the code block.
  setCursor(view, posOf("MARK3A", 2));
  await settle(4, 200);
  const up: any[] = [];
  const recordUp = (label: string) => {
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    up.push({
      label,
      docLine: line.number,
      lineText: line.text.slice(0, 24),
      caretCoords: coordsAt(view, head),
      marker3Top: rectOf(lineByText(view, "MARK3A"))?.top ?? null,
      scrollTop: r2(view.scrollDOM.scrollTop),
    });
  };
  recordUp("start (MARK3A)");
  for (let i = 1; i <= 4; i += 1) {
    cursorLineUp(view);
    await settle(4, 200);
    recordUp(`ArrowUp #${i}`);
  }
  out.arrowUp = up;

  // E5 — a vertical "click map": which document line does each y resolve to?
  setCursor(view, posOf("MARK0", 2));
  view.scrollDOM.scrollTop = 0;
  await settle(4, 200);
  const scan: any[] = [];
  const fenceFirst = view.contentDOM.querySelector<HTMLElement>(".cm-line.md-code-first");
  const hiddenFence = hiddenEls.find((el) => (el.textContent ?? "").includes("js")) ?? null;
  if (fenceFirst) {
    const startY = fenceFirst.getBoundingClientRect().top - 40;
    for (let dy = 0; dy <= 220; dy += 4) {
      const y = startY + dy;
      const pos = view.posAtCoords({ x: fenceFirst.getBoundingClientRect().left + 6, y });
      const domLine = document.elementFromPoint(fenceFirst.getBoundingClientRect().left + 6, y)?.closest(".cm-line");
      scan.push({
        y: r2(y),
        relY: dy,
        pos: typeof pos === "number" ? pos : null,
        docLine: typeof pos === "number" ? view.state.doc.lineAt(pos).number : null,
        lineText: typeof pos === "number" ? view.state.doc.lineAt(pos).text.slice(0, 20) : null,
        domLineText: domLine ? (domLine.textContent ?? "").slice(0, 20) : null,
      });
    }
  }
  out.clickMap = {
    hiddenFenceText: hiddenFence ? (hiddenFence.textContent ?? "").slice(0, 12) : null,
    hiddenFenceRect: rectOf(hiddenFence),
    firstCodeLineRect: rectOf(fenceFirst),
    scan,
  };

  // E6 — height map: what does CM believe a display:none line is worth before it
  // has ever measured one? The code fence is placed below the first viewport so
  // its two hidden fence lines start out estimated, then get measured on scroll.
  const host2 = document.createElement("div");
  host2.className = "probe-host";
  host2.style.height = "700px";
  document.body.appendChild(host2);
  const tallLines = tallFenceDoc().split("\n");
  const v2 = newView(host2, tallLines.join("\n"));
  await showHost(host2);
  await settle(6, 400);
  const tallText = v2.state.doc.toString();
  const fenceOpenPos = tallText.indexOf("```js");
  const fenceClosePos = tallText.indexOf("```", fenceOpenPos + 5);
  const controlPos = tallText.indexOf("填充段落 119");
  const afterFencePos = tallText.indexOf("围栏之后 0");
  const lastPos = tallText.indexOf("BOTTOM-END");
  const read = () => {
    const block = (p: number) => {
      const b = v2.lineBlockAt(p);
      return { docLine: v2.state.doc.lineAt(p).number, top: r2(b.top), height: r2(b.height) };
    };
    return {
      scrollTop: r2(v2.scrollDOM.scrollTop),
      scrollerScrollHeight: v2.scrollDOM.scrollHeight,
      contentScrollHeight: v2.contentDOM.scrollHeight,
      viewContentHeight: r2(v2.contentHeight),
      hiddenRendered: v2.contentDOM.querySelectorAll(".cm-line.md-hide-line").length,
      renderedLines: v2.contentDOM.querySelectorAll(".cm-line").length,
      openFence: block(fenceOpenPos),
      closeFence: block(fenceClosePos),
      control: block(controlPos),
      afterFence: block(afterFencePos),
      last: block(lastPos),
    };
  };
  const beforeScroll = read();
  // Scroll the fence into view — this is the moment CM measures the hidden lines.
  const requested = Math.max(0, beforeScroll.openFence.top - 200);
  v2.scrollDOM.scrollTop = requested;
  const scrollTrace: any[] = [
    { at: "just set", scrollTop: r2(v2.scrollDOM.scrollTop), scrollHeight: v2.scrollDOM.scrollHeight },
  ];
  for (let i = 0; i < 8; i += 1) {
    await raf();
    scrollTrace.push({
      at: `raf ${i + 1}`,
      scrollTop: r2(v2.scrollDOM.scrollTop),
      scrollHeight: v2.scrollDOM.scrollHeight,
      renderedLines: v2.contentDOM.querySelectorAll(".cm-line").length,
    });
  }
  await settle(6, 400);
  scrollTrace.push({
    at: "settled",
    scrollTop: r2(v2.scrollDOM.scrollTop),
    scrollHeight: v2.scrollDOM.scrollHeight,
  });
  const fenceInView = read();
  v2.scrollDOM.scrollTop = 0;
  await settle(6, 400);
  const backToTop = read();
  out.heightMapEstimateVsMeasure = {
    note: "围栏代码块放在首屏之外：scrollTop=0 时两行围栏从未被量过（走估算），滚进视口后才被实测",
    requestedScrollTop: requested,
    scrollTrace,
    beforeScroll,
    fenceInView,
    backToTop,
    deltaContentHeight_fenceInView_minus_before: r2(fenceInView.viewContentHeight - beforeScroll.viewContentHeight),
    deltaScrollerScrollHeight_fenceInView_minus_before:
      fenceInView.scrollerScrollHeight - beforeScroll.scrollerScrollHeight,
    openFenceHeight_estimate_then_measured: [beforeScroll.openFence.height, fenceInView.openFence.height],
    closeFenceHeight_estimate_then_measured: [beforeScroll.closeFence.height, fenceInView.closeFence.height],
    controlHeight_estimate_then_measured: [beforeScroll.control.height, fenceInView.control.height],
    afterFenceTop_contentCoords: [beforeScroll.afterFence.top, fenceInView.afterFence.top],
    afterFenceTop_shift: r2(fenceInView.afterFence.top - beforeScroll.afterFence.top),
    lastTop_shift: r2(fenceInView.last.top - beforeScroll.last.top),
  };

  // E7 — does the height map place every *rendered* line where the DOM does?
  const contentTop = v2.contentDOM.getBoundingClientRect().top;
  const padTop = parseFloat(getComputedStyle(v2.contentDOM).paddingTop);
  const drift = linesOf(v2)
    .map((el) => {
      const pos = safePosAtDOM(v2, el);
      if (pos === null) return null;
      const mapTop = v2.lineBlockAt(pos).top;
      const domTop = el.getBoundingClientRect().top - contentTop - padTop + v2.scrollDOM.scrollTop;
      return {
        docLine: v2.state.doc.lineAt(pos).number,
        text: (el.textContent ?? "").slice(0, 20),
        display: getComputedStyle(el).display,
        mapTop: r2(mapTop),
        domTop: r2(domTop),
        diff: r2(domTop - mapTop),
      };
    })
    .filter(Boolean) as any[];
  out.heightMapDrift = {
    note: "mapTop 来自 view.lineBlockAt()，domTop 来自真实 getBoundingClientRect()；两者应相等",
    checkedLines: drift.length,
    maxAbsDiff: drift.length ? r2(Math.max(...drift.map((d) => Math.abs(d.diff)))) : null,
    worst: drift.slice().sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 6),
  };
  v2.destroy();
  host2.remove();

  // E8 — does a programmatic scroll survive CodeMirror's measure loop?
  const host3 = document.createElement("div");
  host3.className = "probe-host";
  host3.style.height = "700px";
  document.body.appendChild(host3);
  const v3 = newView(host3, tallLines.join("\n"));
  await showHost(host3);
  await settle(6, 400);
  const scrollSteps: any[] = [];
  for (const target of [0, 500, 1000, 2000, 3000, 4000, 5000, 6000, 6905, 7000, 8000, 9000, 10000, 10300]) {
    v3.scrollDOM.scrollTop = target;
    const immediate = r2(v3.scrollDOM.scrollTop);
    await settle(3, 150);
    scrollSteps.push({
      target,
      immediatelyAfterSet: immediate,
      afterSettle: r2(v3.scrollDOM.scrollTop),
      delta: r2(v3.scrollDOM.scrollTop - target),
      scrollHeight: v3.scrollDOM.scrollHeight,
      hiddenRendered: v3.contentDOM.querySelectorAll(".cm-line.md-hide-line").length,
      renderedLines: v3.contentDOM.querySelectorAll(".cm-line").length,
    });
  }
  out.programmaticScroll = {
    note: "每一步都把 scrollTop 设成 target，等 3 帧后看还剩多少；delta≠0 表示滚动位置被 CM 改掉",
    maxScrollTop: v3.scrollDOM.scrollHeight - v3.scrollDOM.clientHeight,
    steps: scrollSteps,
  };
  v3.destroy();
  host3.remove();

  // E9 — which part of the height map actually changes while scrolling?
  const host4 = document.createElement("div");
  host4.className = "probe-host";
  host4.style.height = "700px";
  document.body.appendChild(host4);
  const v4 = newView(host4, tallLines.join("\n"));
  await showHost(host4);
  await settle(6, 400);
  const probeLines = [1, 60, 120, 180, 240, 243, 247, 251, 280, 300, 331];
  const sampleTops = () =>
    probeLines.map((n) => {
      const from = v4.state.doc.line(n).from;
      const b = v4.lineBlockAt(from);
      return { line: n, text: v4.state.doc.line(n).text.slice(0, 14), top: r2(b.top), height: r2(b.height) };
    });
  const snapshots: any[] = [
    { at: "scrollTop=0", scrollTop: r2(v4.scrollDOM.scrollTop), contentHeight: r2(v4.contentHeight), rows: sampleTops() },
  ];
  for (const target of [2000, 4000, 6000, 7000]) {
    v4.scrollDOM.scrollTop = target;
    await settle(4, 250);
    snapshots.push({
      at: `after scroll to ${target}`,
      scrollTop: r2(v4.scrollDOM.scrollTop),
      contentHeight: r2(v4.contentHeight),
      rows: sampleTops(),
    });
  }
  out.heightMapEvolution = {
    note: "同一批行在滚动过程中的 lineBlockAt().top —— 看是谁把高度表改动了",
    snapshots,
    topDeltasVsFirstSnapshot: snapshots.slice(1).map((s) => ({
      at: s.at,
      deltas: s.rows.map((r: any, i: number) => ({ line: r.line, dTop: r2(r.top - snapshots[0].rows[i].top), height: r.height })),
    })),
  };
  v4.destroy();
  host4.remove();

  // E10 — same scroll steps, but with the browser's native scroll anchoring off.
  // Chrome's `overflow-anchor` reacts to CodeMirror rebuilding its tile DOM by
  // moving scrollTop itself; this tells the two apart.
  const host5 = document.createElement("div");
  host5.className = "probe-host";
  host5.style.height = "700px";
  host5.style.overflowAnchor = "none";
  document.body.appendChild(host5);
  const v5 = newView(host5, tallLines.join("\n"));
  await showHost(host5);
  await settle(6, 400);
  v5.scrollDOM.style.overflowAnchor = "none";
  v5.contentDOM.style.overflowAnchor = "none";
  const stepsNoAnchor: any[] = [];
  for (const target of [0, 500, 1000, 2000, 3000, 4000, 5000, 6000, 6905, 7000, 8000, 9000, 10000]) {
    v5.scrollDOM.scrollTop = target;
    await settle(3, 150);
    stepsNoAnchor.push({ target, afterSettle: r2(v5.scrollDOM.scrollTop), delta: r2(v5.scrollDOM.scrollTop - target) });
  }
  out.programmaticScrollNoOverflowAnchor = {
    note: "与 E8 相同的步骤，但 scrollDOM/contentDOM 上 overflow-anchor:none",
    steps: stepsNoAnchor,
  };
  v5.destroy();
  host5.remove();
  setCursor(view, 0);
  view.scrollDOM.scrollTop = 0;
  await settle(2, 60);
  return out;
}

/* ---------------------------------------------------------------- plumbing */

const PROBE = {
  version: "1.0.0",
  view,
  doc: DOC,
  docLines: DOC_LINES,
  posOf,
  updateCount: () => updateCount,
  snapshot: () => snapshot(view),
  lineInfo: (needle: string) => ({
    found: !!lineByText(view, needle),
    rect: rectOf(lineByText(view, needle)),
    text: (lineByText(view, needle)?.textContent ?? "").slice(0, 60),
    display: lineByText(view, needle) ? getComputedStyle(lineByText(view, needle) as HTMLElement).display : null,
  }),
  dumpLines: () =>
    linesOf(view).map((el) => ({
      text: (el.textContent ?? "").slice(0, 26),
      cls: el.className,
      display: getComputedStyle(el).display,
      rect: rectOf(el),
      pos: safePosAtDOM(view, el),
    })),
  settle,
  setCursor: (pos: number, scrollIntoView = false) => {
    setCursor(view, pos, scrollIntoView);
    return { head: view.state.selection.main.head, line: cursorLineOf(view) };
  },
  setSettings: (patch: any) => {
    view.dispatch({ effects: setEditorSettings.of(patch) });
    return patch;
  },
  coordsAt: (pos: number) => coordsAt(view, pos),
  lineBlockAt: (pos: number) => {
    const b = view.lineBlockAt(pos);
    return { from: b.from, to: b.to, top: r2(b.top), height: r2(b.height) };
  },
  /** Raw internals used by the report (height map / viewport). */
  internals: () => {
    const vs: any = (view as any).viewState;
    return {
      contentHeight: r2(view.contentHeight),
      docHeight: r2(view.docHeight),
      documentTop: r2(view.documentTop),
      documentPadding: view.documentPadding,
      heightMapHeight: vs?.heightMap ? r2(vs.heightMap.height) : null,
      viewport: view.viewport,
      viewportLines: (view as any).viewportLineBlocks?.slice?.(0, 60).map((b: any) => ({
        from: b.from,
        top: r2(b.top),
        height: r2(b.height),
        text: view.state.doc.lineAt(b.from).text.slice(0, 20),
      })),
      scrollParentIsScrollDOM: vs?.scrollParent === view.scrollDOM,
      scrollOffset: vs ? r2(vs.getScrollOffset()) : null,
      anchor: (() => {
        if (!vs) return null;
        const b = vs.scrollAnchorAt(vs.getScrollOffset());
        return { from: b.from, top: r2(b.top), text: view.state.doc.lineAt(b.from).text.slice(0, 20) };
      })(),
    };
  },
  runA,
  runB,
  runC,
  runD,
  runE,
  tallFenceDoc,
  showHost,
  /** Build an extra probe editor on demand (used by ad-hoc diagnostics). */
  newProbeView: (hostHeight: number, doc: string) => {
    const h = document.createElement("div");
    h.className = "probe-host";
    h.style.height = `${hostHeight}px`;
    document.body.appendChild(h);
    const v = newView(h, doc);
    return { view: v, host: h };
  },
  runAll: async () => {
    const out: any = { startedAt: new Date().toISOString() };
    for (const name of ["runA", "runB", "runC", "runD", "runE"] as const) {
      try {
        out[name] = await (PROBE as any)[name]();
      } catch (error) {
        out[name] = { error: String((error as Error)?.stack ?? error) };
      }
    }
    out.finishedAt = new Date().toISOString();
    return out;
  },
};

(window as any).PROBE = PROBE;
(window as any).PROBE_READY = true;
