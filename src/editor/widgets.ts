import { EditorView, WidgetType } from "@codemirror/view";
import { resolveImageSrc } from "../data/assets";
import type { ThemeId } from "../data/types";
import { parentPath } from "../fs";
import { imageSizeFor, markImageLoaded, parkImageElement, pooledImageElement, rememberImageSize } from "./imagePool";
import { bridge } from "./bridge";
import { mathHtmlSync, renderMath } from "./math";
import { mermaidHtmlSync, renderMermaid } from "./mermaid";

/* ------------------------------------------------------------------ images */

export class ImageWidget extends WidgetType {
  constructor(
    readonly raw: string,
    readonly alt: string,
    readonly block: boolean,
    /** 图片所属笔记的**路径**（`归档/foo 2.md`）；相对引用按它所在目录解析。 */
    readonly notePath: string,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return (
      other.raw === this.raw && other.alt === this.alt && other.block === this.block && other.notePath === this.notePath
    );
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

    // `resolveImageSrc()` 的基准仍是**目录**（`./foo.assets/x.png` 与 `./assets/x.png` 都要能读），
    // 而编辑器里唯一的事实是笔记路径 —— 目录由它换算，不另存一份。
    void resolveImageSrc(this.raw, parentPath(this.notePath)).then((url) => {
      if (!url) {
        wrap.classList.add("is-missing");
        wrap.textContent = this.alt ? `图片未找到：${this.alt}` : `图片未找到：${this.raw}`;
        view.requestMeasure();
        return;
      }

      const pooled = pooledImageElement(url);
      if (pooled) {
        // 同一张图、不同的 alt（同一 URL 也可能被另一篇笔记引用）：说明文字要跟上这一次的用法。
        pooled.alt = this.alt;
        wrap.appendChild(pooled);
        attachImageMenu(wrap, this);
        view.requestMeasure();
        return;
      }

      const img = document.createElement("img");
      img.alt = this.alt;
      img.loading = "lazy";
      img.decoding = "async";
      img.draggable = false;
      const size = imageSizeFor(url);
      if (size) {
        // CSS 是 `max-width: 100%; height: auto`：这对属性在解码期间就是占位盒（宽高比盒），
        // 图片加载完成前后文档高度不变 —— 没有它，首次加载也会塌一下再弹回去。
        img.width = size.width;
        img.height = size.height;
      }
      img.addEventListener(
        "load",
        () => {
          markImageLoaded(img);
          rememberImageSize(url, img.naturalWidth, img.naturalHeight);
          view.requestMeasure();
        },
        { once: true },
      );
      img.src = url;
      wrap.appendChild(img);
      attachImageMenu(wrap, this);
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
 * 右键一张图片 → 交给宿主开菜单（`src/App.tsx` 的 `openImageMenu` 实现里是「复制图片」）。
 *
 * 两个事件都要接，顺序是必须的：
 *   - `mousedown`（右键）先 `preventDefault + stopPropagation`。不拦的话 CodeMirror 会把光标
 *     移进这一行，行一变「活跃」，本 widget 当场被换成源码 —— 元素没了，`contextmenu` 也就
 *     不会落在它身上，菜单永远开不出来（而且不报错）。
 *   - `contextmenu` 才是开菜单的时机（真正的右键语义，含触摸板/键盘菜单键）。
 *
 * 图片没找到时不挂这两个监听：一个只会失败的死菜单比没有菜单更糟。
 */
function attachImageMenu(wrap: HTMLElement, widget: ImageWidget): void {
  wrap.addEventListener("mousedown", (event) => {
    if (event.button !== 2) return;
    event.preventDefault();
    event.stopPropagation();
  });
  wrap.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    bridge.openImageMenu(event.clientX, event.clientY, { src: widget.raw, notePath: widget.notePath });
  });
}

/* -------------------------------------------------------------------- math */

export class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
  ) {
    super();
  }

  eq(other: MathWidget): boolean {
    return other.tex === this.tex && other.display === this.display;
  }

  toDOM(view: EditorView): HTMLElement {
    const host = document.createElement(this.display ? "div" : "span");
    host.className = `md-math prose${this.display ? " math-block" : ""}`;
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
  ) {
    super();
  }

  eq(other: MermaidWidget): boolean {
    return other.code === this.code && other.theme === this.theme && other.appearance === this.appearance;
  }

  toDOM(view: EditorView): HTMLElement {
    const host = document.createElement("div");
    host.className = "mermaid-block md-mermaid prose";
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
  eq(other: HrWidget): boolean {
    return other instanceof HrWidget;
  }

  toDOM(): HTMLElement {
    const host = document.createElement("div");
    host.className = "dinkus md-hr";
    host.setAttribute("aria-hidden", "true");
    host.innerHTML = "<span></span><span></span><span></span>";
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

export class TableWidget extends WidgetType {
  constructor(
    readonly html: string,
    readonly rows: number,
  ) {
    super();
  }

  eq(other: TableWidget): boolean {
    return other.html === this.html && other.rows === this.rows;
  }

  toDOM(view: EditorView): HTMLElement {
    const host = document.createElement("div");
    host.className = "md-table table-widget prose";
    host.contentEditable = "false";
    host.title = "点击编辑表格源码";
    host.innerHTML = this.html;
    host.addEventListener("mousedown", (event) => {
      const anchor = (event.target as HTMLElement | null)?.closest("a");
      if (anchor instanceof HTMLAnchorElement) {
        event.preventDefault();
        event.stopPropagation();
        bridge.openExternal(anchor.href);
        return;
      }
      event.preventDefault();
      // resolved from the DOM: the table may have moved since it was rendered
      view.dispatch({ selection: { anchor: view.posAtDOM(host) }, scrollIntoView: true });
      view.focus();
    });
    return host;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/* -------------------------------------------------- asset preloading helper */

export async function warmAsset(path: string): Promise<void> {
  await resolveImageSrc(path);
}
