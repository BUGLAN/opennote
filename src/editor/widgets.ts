import { EditorView, WidgetType } from "@codemirror/view";
import { resolveImageSrc } from "../data/assets";
import type { ThemeId } from "../data/types";
import { bridge } from "./bridge";
import { mathHtmlSync, renderMath } from "./math";
import { mermaidHtmlSync, renderMermaid } from "./mermaid";

/* ------------------------------------------------------------------ images */

export class ImageWidget extends WidgetType {
  constructor(
    readonly raw: string,
    readonly alt: string,
    readonly block: boolean,
    readonly baseDir: string,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return (
      other.raw === this.raw && other.alt === this.alt && other.block === this.block && other.baseDir === this.baseDir
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

    void resolveImageSrc(this.raw, this.baseDir).then((url) => {
      if (!url) {
        wrap.classList.add("is-missing");
        wrap.textContent = this.alt ? `图片未找到：${this.alt}` : `图片未找到：${this.raw}`;
        view.requestMeasure();
        return;
      }
      img.addEventListener("load", () => view.requestMeasure(), { once: true });
      img.src = url;
    });
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
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
  constructor(
    readonly checked: boolean,
    readonly from: number,
    readonly to: number,
  ) {
    super();
  }

  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.from === this.from && other.to === this.to;
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
      view.dispatch({
        changes: { from: this.from, to: this.to, insert: box.checked ? "[x]" : "[ ]" },
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
    readonly from: number,
    readonly rows: number,
  ) {
    super();
  }

  eq(other: TableWidget): boolean {
    return other.html === this.html && other.from === this.from && other.rows === this.rows;
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
      view.dispatch({ selection: { anchor: this.from }, scrollIntoView: true });
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
