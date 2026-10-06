import { EditorView, WidgetType } from "@codemirror/view";
import { resolveImageSrc } from "../data/assets";
import type { ThemeId } from "../data/types";
import { parentPath } from "../fs";
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

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement(this.block ? "figure" : "span");
    wrap.className = `md-media prose${this.block ? " md-media--block" : ""}`;
    const img = document.createElement("img");
    img.alt = this.alt;
    img.loading = "lazy";
    img.decoding = "async";
    img.draggable = false;
    wrap.appendChild(img);

    // `resolveImageSrc()` 的基准仍是**目录**（`./foo.assets/x.png` 与 `./assets/x.png` 都要能读），
    // 而编辑器里唯一的事实是笔记路径 —— 目录由它换算，不另存一份。
    void resolveImageSrc(this.raw, parentPath(this.notePath)).then((url) => {
      if (!url) {
        wrap.classList.add("is-missing");
        wrap.textContent = this.alt ? `图片未找到：${this.alt}` : `图片未找到：${this.raw}`;
        view.requestMeasure();
        return;
      }
      img.addEventListener("load", () => view.requestMeasure(), { once: true });
      img.src = url;
      attachImageMenu(wrap, this);
    });
    return wrap;
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
