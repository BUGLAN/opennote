import { syntaxTree } from "@codemirror/language";
import { StateField, type EditorState } from "@codemirror/state";
import { showTooltip, type EditorView, type Tooltip } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { bridge } from "./bridge";
import { linkTarget, livePreviewField } from "./livePreview";
import { editorSettingsField } from "./settings";
import { unwrapSource } from "./unwrapEffect";

/**
 * 光标停在链接里时，在链接上方显示它的地址，并给两个动作：打开 / 编辑。
 *
 * 为什么必须有：渲染态常驻之后，`](https://…)` 一直藏着，而且是原子范围（光标走不进去）。
 * 不给入口的话，**链接地址既看不见也改不了**（排查报告问题 14）。Typora 的做法是光标进来就
 * 露源码；这里保持渲染态不动（不让整行横跳），把地址放进浮层里。
 *
 * 「编辑」= 拆开这个链接（露出源码，见 `unwrapSource`）并选中地址：直接打字就是换地址，
 * 输入法、撤销都是编辑器原生的。
 */

interface LinkAt {
  from: number;
  to: number;
  url: string;
  urlFrom: number;
  urlTo: number;
  /** 引用式链接：地址不在链接里，在定义行上。 */
  reference?: boolean;
}

/** 定义行里这个地址的位置（第一处）。 */
function definitionUrl(state: EditorState, url: string): { from: number; to: number } | null {
  for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) {
    if (node.name !== "LinkReference") continue;
    const child = node.getChild("URL");
    if (child && state.sliceDoc(child.from, child.to) === url) return { from: child.from, to: child.to };
  }
  return null;
}

function linkAt(state: EditorState, pos: number): LinkAt | null {
  const tree = syntaxTree(state);
  for (const side of [-1, 1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (node.name !== "Link") continue;
      if (pos < node.from || pos > node.to) break;
      const url = node.getChild("URL");
      if (url) return { from: node.from, to: node.to, url: state.sliceDoc(url.from, url.to), urlFrom: url.from, urlTo: url.to };
      // 引用式链接：地址在定义行上（那一行是可见的源码），「编辑」直接去那里选中它
      const target = linkTarget(state, node);
      if (!target) return null;
      const def = definitionUrl(state, target);
      return def ? { from: node.from, to: node.to, url: target, urlFrom: def.from, urlTo: def.to, reference: true } : null;
    }
  }
  return null;
}

function tooltipFor(state: EditorState): LinkTooltip | null {
  const range = state.selection.main;
  if (!range.empty || state.selection.ranges.length > 1) return null;
  if (state.field(editorSettingsField, false)?.showMarks) return null;
  const link = linkAt(state, range.head);
  if (!link) return null;
  // 已经拆开（源码可见）时地址就在眼前，浮层只会挡字
  const unwrapped = state.field(livePreviewField, false)?.unwrapped;
  if (unwrapped && unwrapped.from <= link.from && unwrapped.to >= link.to) return null;
  const tooltip: LinkTooltip = {
    pos: link.from,
    above: true,
    strictSide: false,
    arrow: false,
    create: (view) => ({ dom: renderTip(view, link) }),
    url: link.url,
  };
  return tooltip;
}

type LinkTooltip = Tooltip & { url: string };

const OPENABLE = /^(?:https?:\/\/|mailto:|www\.)/i;

function renderTip(view: EditorView, link: LinkAt): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "md-link-tip";
  const address = document.createElement("span");
  address.className = "md-link-tip__url";
  address.textContent = link.url;
  address.title = link.url;
  dom.appendChild(address);

  const button = (label: string, run: () => void) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "md-link-tip__btn";
    el.textContent = label;
    // mousedown 不许把焦点从编辑器抢走：否则选区一丢，浮层自己就消失了
    el.addEventListener("mousedown", (event) => event.preventDefault());
    el.addEventListener("click", (event) => {
      event.preventDefault();
      run();
    });
    dom.appendChild(el);
  };

  if (OPENABLE.test(link.url)) {
    button("打开", () => bridge.openExternal(/^www\./i.test(link.url) ? `https://${link.url}` : link.url));
  }
  button("编辑", () => {
    view.dispatch({
      effects: link.reference ? [] : unwrapSource.of({ from: link.from, to: link.to }),
      selection: { anchor: link.urlFrom, head: link.urlTo },
      scrollIntoView: link.reference,
    });
    view.focus();
  });
  return dom;
}

export const linkTip = StateField.define<LinkTooltip | null>({
  create: tooltipFor,
  update(value, tr) {
    if (!tr.docChanged && !tr.selection && !tr.effects.length) return value;
    const next = tooltipFor(tr.state);
    // 同一个链接、同一个位置 ⇒ 沿用原来的浮层（不重建 DOM，不闪）
    if (value && next && value.pos === next.pos && value.url === next.url) return value;
    return next;
  },
  provide: (field) => showTooltip.from(field),
});
