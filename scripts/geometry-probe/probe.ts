/**
 * geometry-probe — 正式版「编辑器几何回归」探针页面。
 *
 * 这个页面的**全部价值**在于：它挂载的是产品代码里**真实的** CodeMirror 6 扩展
 * （`livePreviewField` / `markdownSupport` / `editorTheme` / `editorSettingsField`）
 * 和**真实的**样式表 / 字体 / KaTeX 样式，因此这里量到的 `getBoundingClientRect()`
 * 就是真实浏览器里的真实布局。**不要**把它换成 jsdom / 假 DOM —— 那样量不到任何
 * 有意义的位移。
 *
 * 本文件只负责「测量」，不做任何 PASS/FAIL 判定：
 * 页面把原始像素值交给 `scripts/verify-editor-geometry.cjs`，由那个 Node 脚本当判据。
 * 这样「判据」和「被测量的产品代码」在物理上是分开的。
 *
 * 对外接口：`window.GEOM`（`window.PROBE_READY === true` 表示已就绪）。
 *
 * `src/**` 一个字节都不改。
 */
import { history } from "@codemirror/commands";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView, drawSelection } from "@codemirror/view";
/*
 * 与 `src/main.tsx` 拉进来的样式表/字体一一对应。少了它们，量到的是 fallback 字体的
 * 度量，数字与真实应用不可比。只差 `app.css` —— 探针没有 React 外壳，它需要的那几条
 * 外壳规则内联在 `index.html` 里。
 */
import "@fontsource-variable/fraunces/full.css";
import "@fontsource-variable/newsreader/opsz.css";
import "@fontsource-variable/newsreader/opsz-italic.css";
import "@fontsource-variable/figtree/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import "katex/dist/katex.min.css";
import { blockPad } from "../../src/editor/blockPad";
import { minimalReplace } from "../../src/editor/externalReplace";
import { livePreviewField } from "../../src/editor/livePreview";
import { markdownSupport } from "../../src/editor/markdown";
import { editorSettingsField } from "../../src/editor/settings";
import { editorTheme } from "../../src/editor/theme";
import { unwrapKeymap } from "../../src/editor/unwrap";

/* =========================================================== 测试文档 */

/**
 * 每个「块」的上下各有一个 `MARKn` 段落当标尺：
 * `MARKnA` 就是「块下方第一个标记段落」，它的 `rect.top` 位移就是用户看到的跳动。
 */
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

/* =========================================================== 视图搭建 */

/**
 * 探针的扩展列表。
 *
 * ⚠️ **必须与 `src/editor/setup.ts` 的 `buildEditorExtensions()` 保持一致** ——
 * 探针的全部价值就在于「量的是真实编辑器」，少一个扩展（例如 `blockPad`）就会
 * 量出一个**根本不存在于产品里**的行为，判据随之失真。这里手写而不是直接调用
 * `buildEditorExtensions()`，是因为后者会拉进 `media.ts` → `data/library` 那一串
 * 运行时（idb / 文件后端），在探针页里没必要也不稳定。
 */
const extensions = (listener?: (u: unknown) => void) => [
  editorTheme(),
  livePreviewField,
  // 块级内容换形态时补白（`src/editor/blockPad.ts`）—— 与 setup.ts 同序。
  blockPad,
  // 「光标停在边界按删除 ⇒ 先拆开这一段」（`src/editor/unwrap.ts`）—— 与 setup.ts 同序。
  unwrapKeymap,
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
 * 探针文档的正文约 2034px 高（再加上 `.cm-content` 的 padding-bottom 才到 3294px）。
 * 容器给 2600px 是为了让**每一行**都真的存在于 DOM 里：CodeMirror 的
 * `visiblePixelRange()` 会把像素视口同时裁到 `window.innerHeight` 与滚动父元素上，
 * 容器太矮的话文档尾部的标尺段落根本不会被渲染，量出来就是假的。
 * 所以 Chrome 窗口也必须开得够高（verify 脚本用 `--window-size=1280,2900`）。
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

/* =========================================================== 测量原语 */

const raf = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 等 n 个动画帧。 */
async function frames(n = 1): Promise<void> {
  for (let i = 0; i < n; i += 1) await raf();
}

/**
 * 「切换后」的标准等待：**3 帧**（任务书要求的帧数）+ 150ms + 2 帧。
 *
 * 多出来的 150ms 是给 CodeMirror 的 measure 循环用的：光标移动会让 decoration
 * 重建 → 块高度变化 → CM 的 `measure()` 在下一帧才把高度表折回去。3 帧通常已经够，
 * 但 widget（mermaid/表格）的 `requestMeasure()` 走的是 CM 的 measure 队列，
 * 给一点余量能避免把「还没量完」误判成「没有位移」。这段等待对**所有**断言一视同仁，
 * 不构成对某一条的放水。
 */
async function settle(): Promise<void> {
  await frames(3);
  await sleep(150);
  await frames(2);
}

const r2 = (n: number) => Math.round(n * 100) / 100;

interface Rect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

function rectOf(el: Element | null | undefined): Rect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    top: r2(r.top),
    left: r2(r.left),
    right: r2(r.right),
    bottom: r2(r.bottom),
    width: r2(r.width),
    height: r2(r.height),
  };
}

function linesOf(v: EditorView): HTMLElement[] {
  return Array.from(v.contentDOM.querySelectorAll<HTMLElement>(".cm-line"));
}

function lineByText(v: EditorView, text: string): HTMLElement | null {
  return linesOf(v).find((el) => (el.textContent ?? "").includes(text)) ?? null;
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

function setCursor(v: EditorView, pos: number, scrollIntoView = false) {
  v.dispatch(scrollIntoView ? { selection: { anchor: pos }, scrollIntoView: true } : { selection: { anchor: pos } });
}

/**
 * 把额外的探针容器滚进窗口。
 *
 * CodeMirror 的 `visiblePixelRange()` 会把像素视口裁到 `window.innerHeight` 上，
 * 挂在 `#host`（2600px）下面的第二个编辑器如果不滚进窗口，CM 只会渲染它落在窗口内的
 * 那一条，标尺段落就不在 DOM 里了。
 */
async function showHost(el: HTMLElement): Promise<void> {
  const top = el.getBoundingClientRect().top + window.scrollY;
  window.scrollTo(0, Math.max(0, top - 4));
  await raf();
  await raf();
}

function snapshot(v: EditorView) {
  return {
    scrollTop: r2(v.scrollDOM.scrollTop),
    contentScrollHeight: v.contentDOM.scrollHeight,
    contentHeight: r2(v.contentHeight),
    cursorHead: v.state.selection.main.head,
    cursorLine: v.state.doc.lineAt(v.state.selection.main.head).number,
    windowScrollY: r2(window.scrollY),
    innerHeight: window.innerHeight,
  };
}

/* =========================================================== 不变量 1：纵向切换 */

interface BlockSpec {
  id: string;
  label: string;
  /** 光标停在块**上方**这个标记段落里 —— 块处于「渲染态 / 非激活」。 */
  outside: string;
  /** 块**下方第一个标记段落** —— 被观察的标尺。 */
  marker: string;
  /** 光标移进块内的位置（`inside` 的字符偏移）。 */
  inside: string;
  insideOffset: number;
  /** 块自身的 DOM 选择器（只用于报告，不参与判定）。 */
  blockSel: string;
  /**
   * 选择器不够精确时的补充文字条件。
   * Setext 一级标题（`====`）与 ATX 一级标题都会拿到 `md-h1` 行类，光靠类名分不开，
   * 所以这里再按行文本认一次。
   */
  blockText?: string;
}

const BLOCKS: BlockSpec[] = [
  { id: "atx-h1", label: "ATX 标题 `# 一级标题`", outside: "MARK0", marker: "MARK1A", inside: "一级标题", insideOffset: 1, blockSel: ".cm-line.md-h1" },
  { id: "setext", label: "Setext 标题 `====`", outside: "MARK1A", marker: "MARK2A", inside: "Setext 标题", insideOffset: 1, blockSel: ".cm-line.md-h1", blockText: "Setext 标题" },
  { id: "fence", label: "围栏代码块 ```js", outside: "MARK2A", marker: "MARK3A", inside: "function beta", insideOffset: 1, blockSel: ".cm-line.md-code-first" },
  { id: "table", label: "4 列表格", outside: "MARK3A", marker: "MARK4A", inside: "| a1 |", insideOffset: 1, blockSel: ".md-table" },
  { id: "mermaid", label: "mermaid 块", outside: "MARK4A", marker: "MARK5A", inside: "A[开始]", insideOffset: 1, blockSel: ".md-mermaid" },
  { id: "math", label: "`$$` 公式块", outside: "MARK5A", marker: "MARK6A", inside: "E = mc^2", insideOffset: 1, blockSel: ".md-math.math-block" },
  { id: "image", label: "块级图片 `![占位图](./x.png)`", outside: "MARK6A", marker: "MARK7A", inside: "![占位图]", insideOffset: 2, blockSel: ".md-media" },
  { id: "quote", label: "引用块 `>`", outside: "MARK7A", marker: "MARK8A", inside: "引用文字MNO", insideOffset: 1, blockSel: ".cm-line.md-quote" },
];

function blockElOf(b: BlockSpec): HTMLElement | null {
  if (b.blockText) {
    return linesOf(view).find((el) => el.matches(b.blockSel) && (el.textContent ?? "").includes(b.blockText!)) ?? null;
  }
  return view.contentDOM.querySelector<HTMLElement>(b.blockSel);
}

async function measureVertical() {
  await showHost(host);
  const rows: unknown[] = [];

  for (const b of BLOCKS) {
    const outsidePos = posOf(b.outside, 2);
    const insidePos = posOf(b.inside, b.insideOffset);

    setCursor(view, outsidePos);
    await settle();
    const markerElOutside = lineByText(view, b.marker);
    const blockOutside = blockElOf(b);
    const outside = {
      ...snapshot(view),
      markerFound: !!markerElOutside,
      markerRect: rectOf(markerElOutside),
      markerText: (markerElOutside?.textContent ?? "").slice(0, 24),
      blockRect: rectOf(blockOutside),
      blockPresent: !!blockOutside,
    };

    setCursor(view, insidePos);
    await settle();
    const markerElInside = lineByText(view, b.marker);
    const blockInside = blockElOf(b);
    const inside = {
      ...snapshot(view),
      markerFound: !!markerElInside,
      markerRect: rectOf(markerElInside),
      markerText: (markerElInside?.textContent ?? "").slice(0, 24),
      blockRect: rectOf(blockInside),
      blockPresent: !!blockInside,
    };

    rows.push({
      id: b.id,
      label: b.label,
      marker: b.marker,
      outsidePos,
      insidePos,
      outside,
      inside,
      /** 块下方标尺段落的纵向位移（px）—— 判定用的就是这个数。 */
      deltaMarkerTop:
        outside.markerRect && inside.markerRect ? r2(inside.markerRect.top - outside.markerRect.top) : null,
      /** 参考量：块自身高度（渲染态 → 源码态）。 */
      blockHeightOutside: outside.blockRect?.height ?? null,
      blockHeightInside: inside.blockRect?.height ?? null,
      deltaContentHeight: r2(inside.contentHeight - outside.contentHeight),
      deltaScrollTop: r2(inside.scrollTop - outside.scrollTop),
    });
  }

  setCursor(view, 0);
  await settle();
  return rows;
}

/* =========================================================== 不变量 3：横向切换 */

interface InlineSpec {
  id: string;
  label: string;
  /** 被标记元素里的文字（用来定位 `coordsAtPos`）。 */
  text: string;
  /** 渲染态下该标记产生的 DOM 元素。 */
  sel: string;
  /** 光标停在这里时该标记处于「隐藏 / 渲染态」。 */
  outside: string;
}

const INLINES: InlineSpec[] = [
  { id: "strong", label: "`**加粗文字ABC**`", text: "加粗文字ABC", sel: ".md-strong", outside: "MARK7A" },
  { id: "em", label: "`*斜体文字DEF*`", text: "斜体文字DEF", sel: ".md-em", outside: "MARK7A" },
  { id: "code", label: "`` `行内代码GHI` ``", text: "行内代码GHI", sel: ".md-code", outside: "MARK7A" },
  { id: "link", label: "`[链接JKL](https://example.com)`", text: "链接JKL", sel: ".md-link", outside: "MARK7A" },
  { id: "atx-mark", label: "标题的 `# ` 标记", text: "一级标题", sel: ".cm-line.md-h1", outside: "MARK7A" },
  { id: "quote-mark", label: "引用的 `> ` 标记", text: "引用文字MNO", sel: ".cm-line.md-quote", outside: "MARK7A" },
];

async function measureHorizontal() {
  await showHost(host);
  const rows: unknown[] = [];

  for (const spec of INLINES) {
    const outsidePos = posOf(spec.outside, 2);
    const textPos = posOf(spec.text);

    setCursor(view, outsidePos);
    await settle();
    const beforeEl = view.contentDOM.querySelector(spec.sel);
    const outside = {
      ...snapshot(view),
      cursorLine: view.state.doc.lineAt(outsidePos).number,
      elementRect: rectOf(beforeEl),
      elementText: (beforeEl?.textContent ?? "").slice(0, 40),
      coordsAtText: coordsAt(view, textPos),
      lineText: (lineByText(view, spec.text)?.textContent ?? "").slice(0, 90),
    };

    setCursor(view, textPos + 1);
    await settle();
    const afterEl = view.contentDOM.querySelector(spec.sel);
    const inside = {
      ...snapshot(view),
      cursorLine: view.state.doc.lineAt(textPos + 1).number,
      elementRect: rectOf(afterEl),
      elementText: (afterEl?.textContent ?? "").slice(0, 40),
      coordsAtText: coordsAt(view, textPos),
      lineText: (lineByText(view, spec.text)?.textContent ?? "").slice(0, 90),
    };

    rows.push({
      id: spec.id,
      label: spec.label,
      textPos,
      outside,
      inside,
      /** 文字起点的横向位移（px）—— 判定用的就是这个数。 */
      deltaCoordsLeft:
        outside.coordsAtText && inside.coordsAtText ? r2(inside.coordsAtText.left - outside.coordsAtText.left) : null,
      /** 被标记元素自身的 `rect.left` 位移（参考量）。 */
      deltaElementLeft:
        outside.elementRect && inside.elementRect ? r2(inside.elementRect.left - outside.elementRect.left) : null,
      /*
       * 纵向位移**不属于**这条不变量，但必须打出来：它一旦非 0，就说明在这一次测量的
       * 前后之间别的东西（图片 `resolveImageSrc` 的异步折回、上游块的 widget 重建）
       * 把整篇内容挪了。配上 contentHeight / scrollTop / windowScrollY 就能分辨
       * 「是布局变了」还是「是滚动了」。
       */
      deltaCoordsTop:
        outside.coordsAtText && inside.coordsAtText ? r2(inside.coordsAtText.top - outside.coordsAtText.top) : null,
      deltaContentHeight: r2(inside.contentHeight - outside.contentHeight),
      deltaScrollTop: r2(inside.scrollTop - outside.scrollTop),
      deltaWindowScrollY: r2(inside.windowScrollY - outside.windowScrollY),
      lineTextOutside: outside.lineText,
      lineTextInside: inside.lineText,
    });
  }

  setCursor(view, 0);
  await settle();
  return rows;
}

/* =========================================================== 不变量 2：异步渲染 */

/** 公式/mermaid 渲染完成的最长等待。给足：mermaid 首次要动态 import 整个库。 */
const ASYNC_TIMEOUT_MS = 30000;

let asyncSeq = 0;

/**
 * 每次都用**全新的**公式/图表内容。
 * `src/editor/math.ts` 与 `src/editor/mermaid.ts` 都有模块级 `Map` 缓存
 * （`cache.set(key, html)`），内容一模一样的话第二次会直接命中缓存、根本不会出现
 * 「占位 → 渲染完成」的过程，异步位移就测不到了。
 */
function asyncDoc(kind: "math" | "mermaid"): string {
  asyncSeq += 1;
  const n = asyncSeq;
  const body =
    kind === "math"
      ? ["$$", `E = mc^2 + ${n} \\cdot \\int_0^1 x^2\\,dx`, "$$"]
      : ["```mermaid", "graph TD", `  A${n}[开始] --> B${n}[处理]`, `  B${n} --> C${n}[结束]`, "```"];
  return ["CBEFORE", "", ...body, "", "CAFTER", "", ...Array.from({ length: 8 }, (_, i) => `尾部段落 ${i}。`)].join("\n");
}

async function measureAsync() {
  const out: unknown[] = [];

  for (const kind of ["math", "mermaid"] as const) {
    const sel = kind === "math" ? ".md-math" : ".md-mermaid";
    const host2 = document.createElement("div");
    host2.className = "probe-host";
    host2.style.height = "1000px";
    document.body.appendChild(host2);
    await showHost(host2);

    const doc = asyncDoc(kind);
    const v = newView(host2, doc);
    const markerEl = () => lineByText(v, "CAFTER");
    const widgetEl = () => v.contentDOM.querySelector<HTMLElement>(sel);

    const started = performance.now();

    /*
     * t0 必须采在「widget 已经进 DOM、而且**仍是占位态**」的那一帧。
     *
     * 不能像原来那样在 `newView()` 之后**同步**采：CodeMirror 不是同步把装饰渲染进
     * DOM 的 —— 装饰要等第一次 measure（后面的帧）才落地。同步采到的是「widget 还
     * 不存在」，`loading: 0`；等轮询循环第一次采到时，KaTeX/mermaid 可能已经渲染完成
     * （实测 10–29ms），于是「前」值本身就是**渲染后**的高度 → Δ≈0 → **假 PASS**。
     * 这正是「跑两次得到 4 passed / 2 passed」的来源。
     *
     * 所以逐帧等到 widget 元素出现，再取 t0；并用 `placeholderSeen` 如实记录
     * 「有没有真的观察到占位态」—— 没观察到就**不许判 PASS**（由判定侧按 UNMEASURED 处理）。
     */
    let placeholderSeen = false;
    let placeholderWaitMs: number | null = null;
    while (performance.now() - started < 5000) {
      const el = widgetEl();
      if (el) {
        placeholderSeen = el.classList.contains("is-loading");
        placeholderWaitMs = Math.round(performance.now() - started);
        break;
      }
      await frames(1);
    }

    const t0 = {
      at: Math.round(performance.now() - started),
      markerFound: !!markerEl(),
      markerRect: rectOf(markerEl()),
      loading: v.contentDOM.querySelectorAll(".is-loading").length,
      widgetRect: rectOf(widgetEl()),
      widgetText: (widgetEl()?.textContent ?? "").slice(0, 30),
    };

    let settled = false;
    let renderCompletedAtMs: number | null = null;
    const timeline: unknown[] = [];
    /*
     * 先采样再睡：第一次采样紧挨着 t0，能看清「挂载 → 渲染完成」之间有没有中间态。
     * 前 500ms 用 10ms 间隔（KaTeX/mermaid 通常几十毫秒就完成），之后放稀到 50ms。
     */
    while (performance.now() - started < ASYNC_TIMEOUT_MS) {
      const at = Math.round(performance.now() - started);
      const rendered = v.contentDOM.querySelector(`${sel}:not(.is-loading)`);
      const loading = v.contentDOM.querySelectorAll(".is-loading").length;
      if (timeline.length < 400) {
        timeline.push({ at, markerTop: rectOf(markerEl())?.top ?? null, loading, rendered: !!rendered });
      }
      if (rendered && loading === 0) {
        settled = true;
        renderCompletedAtMs = at;
        break;
      }
      await sleep(at < 500 ? 10 : 50);
    }
    await settle();

    const t1 = {
      at: Math.round(performance.now() - started),
      markerFound: !!markerEl(),
      markerRect: rectOf(markerEl()),
      loading: v.contentDOM.querySelectorAll(".is-loading").length,
      widgetRect: rectOf(widgetEl()),
      widgetText: (widgetEl()?.textContent ?? "").slice(0, 30),
    };

    /*
     * ── 第二次渲染：内容命中缓存时，块下方**也不许动** ──
     *
     * 「第一次渲染块下方不动」在物理上做不到：一块从 47.94px 长到 273.23px，
     * 下方内容必然下移 225px —— 除非渲染前就知道最终高度，而那时它还没渲染。
     * 所以判据只对**第二次**（`math.ts` / `mermaid.ts` 的模块级缓存命中、
     * widget 重建时同步出 HTML）要求「块下方零位移」。
     *
     * 做法就是真实场景：光标进块（换源码）→ 光标出块（widget 从缓存重建），
     * 比对前后标尺段落的 top。缓存命中的话高度完全一致 ⇒ Δ 必须是 0。
     */
    const markerAfterRender = rectOf(markerEl());
    setCursor(v, v.state.doc.length - 1);
    await settle();
    const inSource = {
      markerRect: rectOf(markerEl()),
      widgetPresent: !!widgetEl(),
      loading: v.contentDOM.querySelectorAll(".is-loading").length,
    };
    setCursor(v, 0);
    await settle();
    const second = {
      markerRect: rectOf(markerEl()),
      widgetRect: rectOf(widgetEl()),
      loading: v.contentDOM.querySelectorAll(".is-loading").length,
    };
    const deltaMarkerTopSecond =
      markerAfterRender && second.markerRect ? r2(second.markerRect.top - markerAfterRender.top) : null;

    out.push({
      kind,
      docHead: doc.split("\n").slice(0, 6).join(" | "),
      settled,
      timeoutMs: ASYNC_TIMEOUT_MS,
      renderCompletedAtMs,
      elapsedMs: t1.at,
      /**
       * t0 那一刻**真的观察到占位态**（`.is-loading`）吗？
       *
       * `false` 有两种可能，都不是「没有位移」，所以判定侧必须按 UNMEASURED 处理：
       *   1. widget 元素一直没进 DOM（挂载失败 / 选择器不对）；
       *   2. 渲染在 widget 进 DOM 的同一帧内就完成了 —— 那这次根本没测到「渲染前」，
       *      拿它当 PASS 就是**假绿**。
       */
      placeholderSeen,
      /** 从挂载到 widget 进 DOM 用了多少帧/毫秒（诊断用）。 */
      placeholderWaitMs,
      t0,
      t1,
      timeline,
      /**
       * 第一次渲染的标尺位移（px）—— **只作参考量，不参与判定**。
       * 它的值必然 ≈（渲染后高度 − 占位高度），因为块在长高，下方内容只能被推走。
       */
      deltaMarkerTop:
        t0.markerRect && t1.markerRect ? r2(t1.markerRect.top - t0.markerRect.top) : null,
      /** 块**自身**顶边的位移（px）—— 判定用。这才是「你的视角有没有被甩走」。 */
      deltaWidgetTop:
        t0.widgetRect && t1.widgetRect ? r2(t1.widgetRect.top - t0.widgetRect.top) : null,
      placeholderHeight: t0.widgetRect?.height ?? null,
      renderedHeight: t1.widgetRect?.height ?? null,
      /** 第二次渲染（缓存命中）的标尺位移（px）—— 判定用。 */
      deltaMarkerTopSecond,
      markerAfterRender: markerAfterRender?.top ?? null,
      inSource,
      second,
    });

    v.destroy();
    host2.remove();
  }

  return out;
}

/* =========================================================== 调试用接口 */

/** 逐行 DOM/rect 快照 —— 修复过程中定位问题用。 */
function dumpLines() {
  return linesOf(view).map((el) => ({
    text: (el.textContent ?? "").slice(0, 26),
    cls: el.className,
    display: getComputedStyle(el).display,
    rect: rectOf(el),
  }));
}

/** CodeMirror 内部量（高度表 / 视口 / 滚动锚点）—— 只读，用于解释位移。 */
function internalsOf(v: EditorView) {
  const vs = (v as unknown as { viewState?: any }).viewState;
  return {
    contentHeight: r2(v.contentHeight),
    documentTop: r2(v.documentTop),
    documentPadding: v.documentPadding,
    heightMapHeight: vs?.heightMap ? r2(vs.heightMap.height) : null,
    viewport: v.viewport,
    scrollTop: r2(v.scrollDOM.scrollTop),
    contentScrollHeight: v.contentDOM.scrollHeight,
    scrollParentIsScrollDOM: vs?.scrollParent === v.scrollDOM,
    scrollOffset: vs ? r2(vs.getScrollOffset()) : null,
    anchor: (() => {
      if (!vs) return null;
      const b = vs.scrollAnchorAt(vs.getScrollOffset());
      return { from: b.from, top: r2(b.top), text: v.state.doc.lineAt(b.from).text.slice(0, 24) };
    })(),
  };
}

function internals() {
  return internalsOf(view);
}

/* =========================== 不变量 4：外部改动（磁盘赢）不许甩走视口 */

/**
 * 长文档夹具。
 *
 * 形状照抄「一篇几百行的中文长笔记」：标题 + 长段落 + 空行 + 零星围栏代码块，
 * 而且**每行字符数刻意不均匀** —— 归档报告 §0.1 F 查明：未渲染区域在高度表里是一个
 * `HeightMapGap`，`blockAt()` 按**字符比例**猜行号；字符分布均匀的文档猜得准，
 * 也就复现不出「CM 自己改写 scrollTop」那 −708.63px。
 */
const LONG_PARA = [
  "这一段是刻意写长的中文正文，用来把文档撑到几百行：住宅 IP、云主机、远程桌面、支付通道、",
  "封号策略、风控与 BIN 检查、ASN 欺诈分、IP 一致性校验，这些词各自长度不同，",
  "所以每一行的字符密度都不一样，高度表在没量过的区域只能按字符比例去猜。",
].join("");

function longDoc(opts: { above?: boolean; below?: boolean } = {}): string {
  const lines: string[] = [];
  if (opts.above) {
    for (let i = 0; i < 12; i += 1) lines.push(`AGENT-ABOVE-${i} 外部在视口上方插入的段落。`);
    lines.push("");
  }
  for (let i = 0; i < 140; i += 1) {
    lines.push(`## 第 ${i} 节`);
    lines.push("");
    lines.push(LONG_PARA);
    lines.push("");
    if (i % 19 === 0) {
      lines.push("```js");
      lines.push(`function f${i}() { return ${i}; }`);
      lines.push("```");
      lines.push("");
    }
  }
  if (opts.below) {
    lines.push("AGENT-BELOW 外部在文档末尾追加的段落。");
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * 外部改动落进编辑器 —— 与 `src/components/EditorPane.tsx` 里 `EditorHost` 的内容同步
 * effect **同一份代码**（`minimalReplace` 就是产品里那一个），只差 `updateListener`。
 */
function applyExternalReplace(v: EditorView, next: string): void {
  const { changes, selection } = minimalReplace(v.state.doc.toString(), next, v.state.selection.main);
  v.dispatch({ changes, selection, annotations: Transaction.addToHistory.of(false) });
}

/**
 * 用**小步进**滚到目标位置。
 *
 * 一次 ≥1000px 的跳转本身就会中招（归档报告 §0.1 F），而这条不变量要量的是
 * 「外部改动落下来的那一刻」，所以落位过程必须干净：300px 一步。
 */
async function scrollBySteps(v: EditorView, target: number, step = 300): Promise<void> {
  let at = v.scrollDOM.scrollTop;
  while (at < target) {
    at = Math.min(target, at + step);
    v.scrollDOM.scrollTop = at;
    await settle();
  }
}

/**
 * 视口里第一条**非空**行 —— 它是这一条不变量的**内容锚点**。
 *
 * 光看 `rect.top` 会得到**假绿**：视口被整篇甩到开头时，新的顶行同样贴在滚动容器
 * 上沿，`rect.top` 照样在 0 附近（修复前实测 Δ = −29.33px，而 `scrollTop` 掉了 3926px）。
 * 所以锚点必须是「哪一行」：行文本 + 它在**文档里的位置**（`posAtDOM`）。
 * 取非空行是因为夹具里段落之间有空行，空行的文本比不出任何东西。
 */
function topVisibleLine(v: EditorView) {
  const top = v.scrollDOM.getBoundingClientRect().top;
  const el =
    linesOf(v).find((l) => l.getBoundingClientRect().bottom > top + 1 && (l.textContent ?? "").trim() !== "") ?? null;
  return {
    text: (el?.textContent ?? "").slice(0, 40),
    pos: el ? v.posAtDOM(el) : null,
    rect: rectOf(el),
  };
}

function viewportSnapshot(v: EditorView) {
  return { ...snapshot(v), topLine: topVisibleLine(v), internals: internalsOf(v) };
}

/** 800px ≈ 真实阅读高度：视口里只放得下十来行，大部分文档都在「没量过」的区域里。 */
const READING_HOST_HEIGHT = 800;
/** 落点：文档中段（夹具文档约 24 000px 高）。 */
const READING_TOP = 4000;

async function withReadingView(run: (v: EditorView) => Promise<void>): Promise<void> {
  const host4 = document.createElement("div");
  host4.className = "probe-host";
  host4.style.height = `${READING_HOST_HEIGHT}px`;
  document.body.appendChild(host4);
  await showHost(host4);
  const v = newView(host4, longDoc());
  await settle();
  await scrollBySteps(v, READING_TOP);
  try {
    await run(v);
  } finally {
    v.destroy();
    host4.remove();
  }
}

/**
 * 三种「外部改动落下来」的时刻，都是产品里真实会发生的：
 *
 *   - `below`  改动在视口**下方**（Agent 在文末追加）—— 视口必须一动不动；
 *   - `above`  改动在视口**上方**（Agent 在开头插了一段）—— 视口顶行必须是同一行，
 *              `scrollTop` 由 CM 按新增高度自己补上；
 *   - `during` 用户正拖着滚动条往上跳 1200px 的那一刻，改动落下来 ——
 *              这是「滚动条往上滑被拽回去」那条反馈的复现路径。
 */
async function measureExternalReplace() {
  const rows: unknown[] = [];

  for (const kind of ["below", "above"] as const) {
    await withReadingView(async (v) => {
      const before = viewportSnapshot(v);
      applyExternalReplace(v, longDoc({ [kind]: true }));
      await settle();
      const after = viewportSnapshot(v);

      rows.push({
        kind,
        before,
        after,
        /** 外部改动前后，内容锚点的位移（px）—— 判定用。 */
        deltaTopLineTop:
          before.topLine.rect && after.topLine.rect ? r2(after.topLine.rect.top - before.topLine.rect.top) : null,
        deltaScrollTop: r2(after.scrollTop - before.scrollTop),
        /** 锚点还是不是**同一行**（文本 + 文档位置）—— 判定用。 */
        sameTopLine: before.topLine.text === after.topLine.text,
        sameTopLinePos: before.topLine.pos === after.topLine.pos,
        topLineBefore: before.topLine.text,
        topLineAfter: after.topLine.text,
        topLinePosBefore: before.topLine.pos,
        topLinePosAfter: after.topLine.pos,
        /** 参照量：`above` 在开头插进去的那 12 行一共多少字符（锚点位置应当正好后移这么多）。 */
        insertedAbove: kind === "above" ? longDoc({ above: true }).length - longDoc().length : 0,
        /** 参照量：`above` 那 12 行一共多高（`scrollTop` 应当正好后移这么多）。 */
        contentHeightDelta: r2(after.contentHeight - before.contentHeight),
      });
    });
  }

  await withReadingView(async (v) => {
    const before = viewportSnapshot(v);
    /* 拖滚动条往上跳 1200px，**不等**它落定，外部改动就在这一刻落下来。 */
    const requested = Math.max(0, before.scrollTop - 1200);
    v.scrollDOM.scrollTop = requested;
    applyExternalReplace(v, longDoc({ below: true }));
    await settle();
    const after = viewportSnapshot(v);

    rows.push({
      kind: "during",
      before,
      after,
      requested: r2(requested),
      /** 那一跳被 CM 改写掉多少（px）—— 判定用。 */
      drift: r2(after.scrollTop - requested),
      deltaTopLineTop:
        before.topLine.rect && after.topLine.rect ? r2(after.topLine.rect.top - before.topLine.rect.top) : null,
      deltaScrollTop: r2(after.scrollTop - before.scrollTop),
      sameTopLine: before.topLine.text === after.topLine.text,
      topLineBefore: before.topLine.text,
      topLineAfter: after.topLine.text,
    });
  });

  return rows;
}

/* =========================================================== 对外 */

const GEOM = {
  version: "1.0.0",
  doc: DOC,
  docLines: DOC_LINES,
  posOf,
  updateCount: () => updateCount,
  measureVertical,
  measureHorizontal,
  measureAsync,
  measureExternalReplace,
  dumpLines,
  internals,
};

(window as unknown as { GEOM: typeof GEOM }).GEOM = GEOM;
(window as unknown as { PROBE_READY: boolean }).PROBE_READY = true;
