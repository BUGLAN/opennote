import { EditorView, WidgetType } from "@codemirror/view";
import { resolveImageSrc } from "../data/assets";
import type { ThemeId } from "../data/types";
import { parentPath } from "../fs";
import { blockHeightFor, rememberBlockHeight } from "./blockHeight";
import { imageSizeFor, markImageLoaded, parkImageElement, pooledImageElement, rememberImageSize, rememberSourceSize, sourceSizeFor } from "./imagePool";
import { bridge } from "./bridge";
import { mathHtmlSync, renderMath } from "./math";
import { mermaidHtmlSync, renderMermaid } from "./mermaid";
import { rememberTableWidths, splitTableRow, tableMetricKey, type TableColumn } from "./tableMetrics";

/* ------------------------------------------------------- block height report */

/**
 * 量一次这个**块级** widget 的高度，记进 `blockHeight`（`blockHeight.ts`）——
 * 光标进到块里、源码露出来时，靠这个数把差额补成留白，块下方的内容才不会跳。
 *
 * 读放在 `requestMeasure` 的 **read 阶段**：那时 DOM 已经更新完、布局是新的，
 * 读到的才是真高度；直接在 `toDOM()` 里读只会拿到未布局的 0。
 *
 * 异步渲染（图片解码 / KaTeX / mermaid）完成时会再调一次，所以记下的是**最终**高度。
 */
function reportBlockHeight(view: EditorView, el: HTMLElement, key: string): void {
  if (!key) return;
  view.requestMeasure({
    read: () => el.getBoundingClientRect().height,
    write: (height) => rememberBlockHeight(key, height),
  });
}

/**
 * 块级 widget 的**估算高度**给 CodeMirror 用。
 *
 * 为什么必须给：`WidgetType.estimatedHeight` 默认返回 `-1`（「我不知道」），而 CM 的
 * `hasHeight()` 正是拿它判断「这个 widget 有没有已知高度」的。返回 `-1` 等于告诉 CM
 * 「这块高度未知」—— 于是视口外的区域只能按**字符数比例**去猜行高，markdown 的字符
 * 分布极不均匀（长段落与空行交替），一猜就偏。归档实测过一次远距离跳转被 CM 自己
 * 改写 `scrollTop` **−708.63px**，根因就是 `HeightMapGap.blockAt()` 的字符比例插值
 * 猜偏了 24 行。
 *
 * 这里优先用**记得住的实测高度**（`blockHeight.ts` 里 widget 自己量过的那份），
 * 没有才退回一个按内容的粗估。估准一点，滚动与光标定位就稳一点。
 *
 * 关于 `coordsAt`：**刻意不实现**。官方文档要求「默认实现不准时才覆盖」，
 * 而本文件里每个块级 widget 都是**单个元素**、内部没有可寻址的文本位置，
 * 默认实现（取元素自己的矩形）就是正确答案；写一个只会把同一件事重说一遍。
 * 将来若有 widget 内部出现多行可定位内容（例如单元格可点选），再补不迟。
 */
function estimatedBlockHeight(key: string, fallback: number): number {
  return blockHeightFor(key) ?? fallback;
}

/* ------------------------------------------------------------------ images */

export class ImageWidget extends WidgetType {
  constructor(
    readonly raw: string,
    readonly alt: string,
    readonly block: boolean,
    /** 图片所属笔记的**路径**（`归档/foo 2.md`）；相对引用按它所在目录解析。 */
    readonly notePath: string,
    /** 块原文（独占一行的图片才有）—— 源码态补白的钥匙，见 `blockHeight.ts`。 */
    readonly blockKey: string = "",
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return (
      other.raw === this.raw && other.alt === this.alt && other.block === this.block && other.notePath === this.notePath
    );
  }

  /**
   * 见 `estimatedBlockHeight()`。图片会被 `max-width: 100%` 缩到栏宽，
   * 所以自然高度只能当上限用（这里取 480px 封顶），量过之后一律以实测为准。
   */
  get estimatedHeight(): number {
    if (!this.block) return -1;
    const size = sourceSizeFor(this.raw);
    return estimatedBlockHeight(this.blockKey, size ? Math.min(size.height, 480) : 200);
  }

  /**
   * 为什么先建空 `<img>`、等 URL 再赋 `src`：本地图片要从磁盘读字节（blob URL 由
   * `imageUrlStore` 缓存）。代价是每个**新建的**元素都要重新解码 —— 换笔记时整篇文档
   * 替换、所有 widget 重建，大图一收一放就是「切换文件整屏闪」。所以这里优先从
   * `imagePool` 把上一轮**已解码**的那个元素搬回来（零加载零解码零塌陷）；全新元素则用
   * 记过的自然尺寸先占住布局，解码期间文档不再跳。
   */
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement(this.block ? "figure" : "span");
    wrap.className = `md-media prose${this.block ? " md-media--block" : ""}`;

    // `<img>` 与它的**尺寸占位**都是同步建的：粘贴那一刻已经从 `File` 量到尺寸并记进
    // `imagePool`（`rememberSourceSize`），所以第一帧就已经是最终高度的盒子 —— 不必等
    // `resolveImageSrc` 的异步，更不必等解码。没有这一步，**首次**插入的图片会先塌成 0、
    // 解码完再把下方内容推下去（用户 2026-10-10 报的那次跳动）。
    const img = document.createElement("img");
    img.alt = this.alt;
    img.loading = "lazy";
    img.decoding = "async";
    img.draggable = false;
    applyKnownSize(img, sourceSizeFor(this.raw));
    wrap.appendChild(img);
    // 块级图片独占一行：记下它渲染出来的高度，光标进到这一行时源码态要补同样的留白。
    if (this.block) reportBlockHeight(view, wrap, this.blockKey);

    // `resolveImageSrc()` 的基准仍是**目录**（`./foo.assets/x.png` 与 `./assets/x.png` 都要能读），
    // 而编辑器里唯一的事实是笔记路径 —— 目录由它换算，不另存一份。
    void resolveImageSrc(this.raw, parentPath(this.notePath)).then((url) => {
      if (!url) {
        wrap.classList.add("is-missing");
        wrap.textContent = this.alt ? `图片未找到：${this.alt}` : `图片未找到：${this.raw}`;
        if (this.block) reportBlockHeight(view, wrap, this.blockKey);
        view.requestMeasure();
        return;
      }

      const pooled = pooledImageElement(url);
      if (pooled) {
        // 同一张图、不同的 alt（同一 URL 也可能被另一篇笔记引用）：说明文字要跟上这一次的用法。
        pooled.alt = this.alt;
        applyKnownSize(pooled, imageSizeFor(url));
        wrap.replaceChild(pooled, img);
        attachImageMenu(wrap, this, view);
        if (this.block) reportBlockHeight(view, wrap, this.blockKey);
        view.requestMeasure();
        return;
      }

      // 引用串那一份没有（老图片、外部导入的笔记）就退到「上次加载后量到的 URL 尺寸」。
      applyKnownSize(img, imageSizeFor(url));
      img.addEventListener(
        "load",
        () => {
          markImageLoaded(img);
          rememberImageSize(url, img.naturalWidth, img.naturalHeight);
          // 同时记一份**按引用串**的：这样下一次重建这个 widget（光标进出图片行、
          // 换笔记回来）也能在同步阶段就占好位，不必再等 `resolveImageSrc`。
          rememberSourceSize(this.raw, img.naturalWidth, img.naturalHeight);
          if (this.block) reportBlockHeight(view, wrap, this.blockKey);
          view.requestMeasure();
        },
        { once: true },
      );
      img.src = url;
      attachImageMenu(wrap, this, view);
    });
    return wrap;
  }

  /** 元素还池（见 `imagePool`）：换笔记 / 光标进出图片行 / 整轮装饰重建都走这里。 */
  destroy(dom: HTMLElement): void {
    const img = dom.querySelector("img");
    if (!(img instanceof HTMLImageElement)) return;
    const url = img.getAttribute("src");
    if (url) parkImageElement(url, img);
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * 只在元素**还没有**尺寸属性时写入。CSS 是 `max-width: 100%; height: auto`：这一对属性
 * 在解码期间就是宽高比占位盒，图片加载完成前后文档高度不变 —— 没有它，图片会先塌成 0
 * 再把下方内容推下去。已经写过的（池子里搬回来的元素、上一次量到的真实尺寸）不覆盖。
 */
function applyKnownSize(img: HTMLImageElement, size: { width: number; height: number } | null): void {
  if (!size || img.hasAttribute("width")) return;
  img.width = size.width;
  img.height = size.height;
}

/**
 * 右键一张图片 → 交给宿主开菜单（`src/App.tsx` 的 `openImageMenu`）。
 *
 * 两个事件都要接，顺序是必须的：
 *   - `mousedown`（右键）先 `preventDefault + stopPropagation`。不拦的话 CodeMirror 会把光标
 *     移进这一行，行一变「活跃」，本 widget 当场被换成源码 —— 元素没了，`contextmenu` 也就
 *     不会落在它身上，菜单永远开不出来（而且不报错）。
 *   - `contextmenu` 才是开菜单的时机（真正的右键语义，含触摸板/键盘菜单键）。
 *
 * 图片没找到时不挂这两个监听：一个只会失败的死菜单比没有菜单更糟。
 *
 * 交给宿主的 `source` 是**完整的 `![说明](引用)`**（`blockKey` 就是这段原文），
 * 不是只有引用串 —— 宿主靠它经 `findImageSource()` 定位文档范围。
 *
 * 同时交出 `from`：**被右键的这一个**在文档里的起点。少了它，同一张图被引用两次时
 * 宿主只能按串去找，会命中第一处 —— 删错地方。位置在**事件发生时**用 `posAtDOM` 取，
 * 不能在建 widget 时缓存：文档一改位置就变了，而 widget 实例可能被复用。
 */
function attachImageMenu(wrap: HTMLElement, widget: ImageWidget, view: EditorView): void {
  wrap.addEventListener("mousedown", (event) => {
    if (event.button !== 2) return;
    event.preventDefault();
    event.stopPropagation();
  });
  wrap.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    bridge.openImageMenu(event.clientX, event.clientY, {
      src: widget.raw,
      notePath: widget.notePath,
      source: widget.blockKey,
      from: positionOfWidget(wrap, widget.blockKey, view),
    });
  });
}

/**
 * 这个 widget 在文档里的起点。取不到就返回 `-1`，让宿主知道「位置不可用」。
 *
 * 取完**必须校验**：`posAtDOM` 在某些边界（widget 已从 DOM 摘掉、位置落在别处）会给出
 * 一个看似合理但不对的数。用 `source` 回读一遍，对不上就当作没取到 ——
 * 宿主会退回「按串找第一处」，至少不会删到别的地方去。
 */
function positionOfWidget(wrap: HTMLElement, source: string, view: EditorView): number {
  let from: number;
  try {
    from = view.posAtDOM(wrap);
  } catch {
    return -1;
  }
  if (from < 0 || from + source.length > view.state.doc.length) return -1;
  return view.state.sliceDoc(from, from + source.length) === source ? from : -1;
}

/* -------------------------------------------------------------------- math */

export class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
    /** 块原文（行内公式为空串）—— 源码态补白的钥匙，见 `blockHeight.ts`。 */
    readonly blockKey: string = "",
  ) {
    super();
  }

  eq(other: MathWidget): boolean {
    return other.tex === this.tex && other.display === this.display;
  }

  /** 见 `estimatedBlockHeight()`。行内公式不是块级装饰，不参与估算（返回 -1）。 */
  get estimatedHeight(): number {
    return this.display ? estimatedBlockHeight(this.blockKey, 60) : -1;
  }

  toDOM(view: EditorView): HTMLElement {
    const host = document.createElement(this.display ? "div" : "span");
    host.className = `md-math prose${this.display ? " math-block" : ""}`;
    if (this.display) reportBlockHeight(view, host, this.blockKey);
    const cached = mathHtmlSync(this.tex, this.display);
    if (cached) {
      host.innerHTML = cached;
      return host;
    }
    host.classList.add("is-loading");
    host.textContent = this.display ? "公式渲染中…" : this.tex;
    void renderMath(this.tex, this.display).then((html) => {
      host.innerHTML = html;
      host.classList.remove("is-loading");
      if (this.display) reportBlockHeight(view, host, this.blockKey);
      view.requestMeasure();
    });
    return host;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/* ----------------------------------------------------------------- mermaid */

export class MermaidWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly theme: ThemeId,
    readonly appearance: "light" | "dark",
    /** 块原文（含围栏）—— 源码态补白的钥匙，见 `blockHeight.ts`。 */
    readonly blockKey: string = "",
  ) {
    super();
  }

  eq(other: MermaidWidget): boolean {
    return other.code === this.code && other.theme === this.theme && other.appearance === this.appearance;
  }

  /** 见 `estimatedBlockHeight()`。图表渲染完能到两三百像素，没量过先按 200 估。 */
  get estimatedHeight(): number {
    return estimatedBlockHeight(this.blockKey, 200);
  }

  toDOM(view: EditorView): HTMLElement {
    const host = document.createElement("div");
    host.className = "mermaid-block md-mermaid prose";
    reportBlockHeight(view, host, this.blockKey);
    const cached = mermaidHtmlSync(this.code, this.theme);
    if (cached) {
      host.innerHTML = cached;
      return host;
    }
    host.classList.add("is-loading");
    host.textContent = "图表绘制中…";
    void renderMermaid(this.code, this.theme, this.appearance).then(({ html }) => {
      host.innerHTML = html;
      host.classList.remove("is-loading");
      reportBlockHeight(view, host, this.blockKey);
      view.requestMeasure();
    });
    return host;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/* --------------------------------------------------------------- structure */

export class HrWidget extends WidgetType {
  /** 块原文（`---` / `***`）—— 源码态补白的钥匙。 */
  constructor(readonly blockKey: string = "") {
    super();
  }

  eq(other: HrWidget): boolean {
    return other instanceof HrWidget;
  }

  /** 见 `estimatedBlockHeight()`。分隔线就是三个圆点加固定内边距，很矮。 */
  get estimatedHeight(): number {
    return estimatedBlockHeight(this.blockKey, 50);
  }

  toDOM(view: EditorView): HTMLElement {
    const host = document.createElement("div");
    host.className = "dinkus md-hr";
    host.setAttribute("aria-hidden", "true");
    host.innerHTML = "<span></span><span></span><span></span>";
    reportBlockHeight(view, host, this.blockKey);
    return host;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

export class BulletWidget extends WidgetType {
  constructor(readonly depth: number) {
    super();
  }

  eq(other: BulletWidget): boolean {
    return other.depth === this.depth;
  }

  toDOM(): HTMLElement {
    const glyphs = ["•", "◦", "▪"];
    const host = document.createElement("span");
    host.className = "md-bullet";
    host.textContent = glyphs[(this.depth - 1) % glyphs.length];
    return host;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }

  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked;
  }

  toDOM(view: EditorView): HTMLElement {
    const host = document.createElement("span");
    host.className = "md-task";
    host.contentEditable = "false";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "task-checkbox";
    box.checked = this.checked;
    box.setAttribute("aria-label", this.checked ? "标记为未完成" : "标记为已完成");
    box.addEventListener("change", () => {
      // The decoration may have been moved by an edit since the widget was
      // built, so resolve the marker from the DOM instead of caching it.
      const from = view.posAtDOM(host);
      if (!/^\[[ xX]\]$/.test(view.state.sliceDoc(from, from + 3))) return;
      view.dispatch({
        changes: { from, to: from + 3, insert: box.checked ? "[x]" : "[ ]" },
        userEvent: "input.task",
      });
      view.focus();
    });
    host.appendChild(box);
    return host;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export class WikiLinkWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly exists: boolean,
  ) {
    super();
  }

  eq(other: WikiLinkWidget): boolean {
    return other.label === this.label && other.exists === this.exists;
  }

  toDOM(): HTMLElement {
    const host = document.createElement("span");
    host.className = `md-wikilink${this.exists ? "" : " is-missing"}`;
    host.contentEditable = "false";
    host.textContent = this.exists ? this.label : `${this.label} ＋`;
    host.title = this.exists ? `打开《${this.label}》` : `创建笔记《${this.label}》`;
    host.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      bridge.openWikiLink(this.label);
    });
    return host;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * 点到渲染态表格的哪一格 ⇒ 源码里的哪个位置。
 *
 * 表格渲染出来之后，点它应该**落进那一格**（和 Typora 一样），而不是永远把光标
 * 丢到表格开头再让用户点第二次。行号从源码行推：表头 = 第 0 行，分隔行 = 第 1 行，
 * 正文第 n 行 = 第 n + 2 行；列号就是 `cellIndex`。
 */
function tableCellAnchor(
  view: EditorView,
  host: HTMLElement,
  target: EventTarget | null,
  source: string,
): number | null {
  const cell = (target as HTMLElement | null)?.closest?.("td,th") as HTMLTableCellElement | null;
  if (!cell || !host.contains(cell)) return null;
  const row = cell.closest("tr");
  const table = cell.closest("table");
  if (!row || !table) return null;
  const lines = source.split("\n");
  let lineIndex: number;
  if (row.parentElement?.tagName === "THEAD") {
    lineIndex = 0;
  } else {
    const bodyRows = Array.from(table.querySelectorAll("tbody tr"));
    lineIndex = 2 + Math.max(0, bodyRows.indexOf(row));
  }
  const line = lines[lineIndex];
  if (line == null) return null;
  const { cells } = splitTableRow(line);
  const segment = cells[cell.cellIndex] ?? cells[cells.length - 1];
  if (!segment) return null;
  const raw = line.slice(segment.from, segment.to);
  const lead = raw.length - raw.trimStart().length;
  let offset = segment.from + lead;
  for (let i = 0; i < lineIndex; i += 1) offset += lines[i].length + 1;
  return view.posAtDOM(host) + offset;
}


/**
 * 读渲染态表格每一列的**两个**数：轨道宽度（边界间距）与内容盒宽度。
 *
 * 两个都必须精确到小数，因为它们决定了**断行**：
 *   - `track` 用**每格左边线**之差算 —— `border-collapse` 下各格 width 之和比表宽少
 *     1px（共享边框各算一半），按边界相减才是真正的列位置；
 *   - `content` 塞一个 block 探针撑满内容盒再量 —— `clientWidth` 是整数、
 *     `getComputedStyle().width` 在表格里不可靠，差 0.5px 就会让某一格多折一行。
 */
function readTableMetrics(host: HTMLElement): TableColumn[] | null {
  const table = host.querySelector("table");
  const row = host.querySelector("thead tr") ?? host.querySelector("tbody tr");
  if (!table || !row) return null;
  const cells = Array.from(row.children).filter((cell): cell is HTMLElement => cell instanceof HTMLElement);
  if (cells.length === 0) return null;
  const tableRect = table.getBoundingClientRect();
  const rects = cells.map((cell) => cell.getBoundingClientRect());
  if (!rects.every((rect) => rect.width > 0)) return null;
  const tracks = rects.map((rect, i) => {
    const right = i + 1 < rects.length ? rects[i + 1].left : tableRect.right;
    return right - rect.left;
  });
  // 第一列把表格左边框那一小截也吃掉，整张表的宽度才与渲染态完全一致。
  tracks[0] += rects[0].left - tableRect.left;
  const probes = cells.map((cell) => {
    const probe = document.createElement("div");
    probe.style.cssText = "display:block;height:0;margin:0;padding:0;border:0;width:auto";
    cell.appendChild(probe);
    return probe;
  });
  const contents = probes.map((probe) => probe.getBoundingClientRect().width);
  for (const probe of probes) probe.remove();
  const columns = tracks.map((track, i) => ({ track, content: contents[i] }));
  return columns.every((col) => col.track > 0 && col.content > 0 && col.content <= col.track) ? columns : null;
}

export class TableWidget extends WidgetType {
  constructor(
    readonly html: string,
    readonly rows: number,
    /** 表格原文 —— 源码态补白的钥匙，见 `blockHeight.ts`。 */
    readonly blockKey: string = "",
  ) {
    super();
  }

  eq(other: TableWidget): boolean {
    return other.html === this.html && other.rows === this.rows;
  }

  /**
   * 见 `estimatedBlockHeight()`。
   * `rows` 是**源码行数**（表头 + 分隔行 + 数据行）；没量过就按每行 30px 加内边距估。
   */
  get estimatedHeight(): number {
    return estimatedBlockHeight(this.blockKey, this.rows * 30 + 40);
  }

  /**
   * 量一次每列的宽度，记进 `tableMetrics.ts`。
   *
   * 编辑态要把源码行排成同一张表，列宽只能从这里来（`getBoundingClientRect`
   * 拿到的是**渲染后**的真宽度，含内边距与边框）。和高度一样放在
   * `requestMeasure` 的 read 阶段量：`toDOM` 刚返回时元素还没进文档、布局是空的。
   *
   * ⚠️ 表格的列宽会**变**：字体晚一点加载完、窗口/侧栏改宽度、`--measure` 设置被改，
   * 都会让渲染态的列宽在 widget 挂载之后重新排一次。所以要一直跟着量：
   * ① 挂载时量一次；② 用 `ResizeObserver` 盯着 `<table>`，它一变就重量；
   * ③ 用户点进来时**再同步量一次**（这一下是最权威的，晚一帧都不行）。
   * 少了任何一条，点进表格都会看到列宽跳一下。
   */
  private measureWidths(view: EditorView, host: HTMLElement): void {
    if (!this.blockKey) return;
    const key = tableMetricKey(this.blockKey);
    view.requestMeasure({
      read: () => readTableMetrics(host),
      write: (columns) => {
        if (columns) rememberTableWidths(key, columns);
      },
    });
  }

  /** 跟着渲染态的表格重量列宽（字体加载、容器改宽都会触发）。 */
  private watchWidths(host: HTMLElement): void {
    if (typeof ResizeObserver === "undefined" || !this.blockKey) return;
    const key = tableMetricKey(this.blockKey);
    const table = host.querySelector("table");
    if (!table) return;
    let last = "";
    const observer = new ResizeObserver(() => {
      const columns = readTableMetrics(host);
      if (!columns) return;
      const signature = columns.map((col) => `${Math.round(col.track * 10)}/${Math.round(col.content * 10)}`).join(",");
      if (signature === last) return;
      last = signature;
      rememberTableWidths(key, columns);
    });
    observer.observe(table);
    this.widthObserver = observer;
  }

  toDOM(view: EditorView): HTMLElement {
    const host = document.createElement("div");
    host.className = "md-table table-widget prose";
    host.contentEditable = "false";
    host.title = "点击单元格编辑";
    /*
     * 必须 trim：markdown-it 给表格吐的 HTML 末尾带一个换行，而编辑器里的
     * `.cm-content` 是 `white-space: pre-wrap` —— 那个换行会在 widget 里
     * 变成一整行空白（实测 26px）。它既不是设计也不是留白，还会让渲染态比
     * 「就地编辑态」高出一行，点进表格时整块往下跳一下。
     */
    host.innerHTML = this.html.trim();
    reportBlockHeight(view, host, this.blockKey);
    this.measureWidths(view, host);
    this.watchWidths(host);
    host.addEventListener("mousedown", (event) => {
      const anchor = (event.target as HTMLElement | null)?.closest("a");
      if (anchor instanceof HTMLAnchorElement) {
        event.preventDefault();
        event.stopPropagation();
        bridge.openExternal(anchor.href);
        return;
      }
      event.preventDefault();
      // 点进来的这一下同步量一遍：编辑态第一帧就要用**当前**列宽，
      // 不能用挂载时那份可能已经过期的。
      if (this.blockKey) {
        const columns = readTableMetrics(host);
        if (columns) rememberTableWidths(tableMetricKey(this.blockKey), columns);
      }
      // resolved from the DOM: the table may have moved since it was rendered
      const start = view.posAtDOM(host);
      const cell = tableCellAnchor(view, host, event.target, this.blockKey);
      // 不加 `scrollIntoView`：用户点的就是眼前这张表，光标落点必然可见；
      // 一带滚动，整页会跟着挪一下（实测 15px），看起来就像「点一下跳一下」。
      view.dispatch({ selection: { anchor: cell ?? start } });
      view.focus();
    });
    return host;
  }

  destroy(): void {
    this.widthObserver?.disconnect();
    this.widthObserver = null;
  }

  ignoreEvent(): boolean {
    return true;
  }

  private widthObserver: ResizeObserver | null = null;
}

/**
 * 零宽单元格（`||`）的占位元素。
 *
 * 编辑态里每一格都是一个 `grid` 项；空到连空格都没有的格子如果没有元素，
 * 这一列就会被后面的格子顶掉、整行错位。给一个空 `<span>` 占住位置。
 */
export class TableCellWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "md-tcell";
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/* -------------------------------------------------- asset preloading helper */

export async function warmAsset(path: string): Promise<void> {
  await resolveImageSrc(path);
}
