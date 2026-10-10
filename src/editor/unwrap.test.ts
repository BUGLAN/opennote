import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { livePreviewField, unwrapSource } from "./livePreview";
import { markdownSupport } from "./markdown";
import { unwrapBackspace, unwrapDelete } from "./unwrap";

/**
 * 「光标停在边界按删除 ⇒ 先拆开这一段，而不是删内容」。
 *
 * 这是 `showMarks: false` 下唯一**主动看见标记**的入口，所以它的边界判定必须准：
 * 判宽了，普通打字会被吃掉（按 Backspace 不删字）；判窄了，就永远拆不开。
 */

const DOC = "前 **粗体** 后\n";

/** `前 **粗体** 后` 的字符位置：`**粗体**` 占 2..8。 */
const BOLD_END = 8;
const BOLD_START = 2;
const BOLD_MIDDLE = 5;

function stateAt(pos: number, doc = DOC): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor: pos },
    extensions: [markdownSupport, livePreviewField],
  });
}

/** 不需要真实 DOM：只关心「有没有派发 effect」和「返回 true 还是 false」。 */
function viewOf(state: EditorState) {
  const specs: TransactionSpec[] = [];
  const view = {
    state,
    dispatch: (spec: TransactionSpec) => specs.push(spec),
  } as unknown as EditorView;
  return { view, specs };
}

describe("unwrap：光标停在边界按删除，先拆开这一段", () => {
  it("Backspace 在 `**粗体**` 的末尾 ⇒ 拆开（派发 unwrapSource）", () => {
    const { view, specs } = viewOf(stateAt(BOLD_END));
    expect(unwrapBackspace(view)).toBe(true);
    expect(specs).toHaveLength(1);
    const effect = (specs[0] as { effects: { value: { from: number; to: number } } }).effects;
    expect(effect.value).toEqual({ from: BOLD_START, to: BOLD_END });
  });

  it("Delete 在 `**粗体**` 的开头 ⇒ 拆开", () => {
    const { view, specs } = viewOf(stateAt(BOLD_START));
    expect(unwrapDelete(view)).toBe(true);
    expect(specs).toHaveLength(1);
  });

  it("光标在粗体字**中间** ⇒ 不拆，交给普通的删除", () => {
    expect(unwrapBackspace(viewOf(stateAt(BOLD_MIDDLE)).view)).toBe(false);
    expect(unwrapDelete(viewOf(stateAt(BOLD_MIDDLE)).view)).toBe(false);
  });

  it("光标在普通文字里 ⇒ 不拆（否则按 Backspace 就不删字了）", () => {
    // 位置 1 在 `前 ` 中间，位置 10 在 ` 后` 里
    expect(unwrapBackspace(viewOf(stateAt(1)).view)).toBe(false);
    expect(unwrapBackspace(viewOf(stateAt(DOC.length - 1)).view)).toBe(false);
  });

  it("**已经拆开过的再按一次就放行** —— 那一下才是真的删内容", () => {
    const state = stateAt(BOLD_END);
    const first = viewOf(state);
    expect(unwrapBackspace(first.view)).toBe(true);
    // 应用 unwrapSource，再按一次
    const after = state.update(first.specs[0]).state;
    expect(unwrapBackspace(viewOf(after).view)).toBe(false);
  });

  it("图片：光标在 `![](...)` 后面 ⇒ 拆开（这就是「删掉这张图的渲染」）", () => {
    const doc = "![图](./a.png)\n";
    const end = "![图](./a.png)".length;
    const { view, specs } = viewOf(stateAt(end, doc));
    expect(unwrapBackspace(view)).toBe(true);
    expect((specs[0] as { effects: { value: { from: number; to: number } } }).effects.value).toEqual({
      from: 0,
      to: end,
    });
  });

  it("行内代码与链接同样可拆", () => {
    for (const [doc, pos] of [
      ["看 `代码` 啊\n", 6], // `` `代码` `` 占 2..6
      ["看 [链接](https://x.com) 啊\n", 21], // `[链接](https://x.com)` 占 2..21
    ] as const) {
      expect(unwrapBackspace(viewOf(stateAt(pos, doc)).view)).toBe(true);
    }
  });
});

describe("unwrapSource：拆开之后源码真的露出来了", () => {
  it("`**粗体**` 的 `**` 平时被 replace 掉，拆开后才看得见", () => {
    const doc = "前 **粗体** 后\n";
    const hidden = stateAt(doc.length - 1, doc);
    // `**` 占 2..4 与 6..8：平时是「无类名的 replace 装饰」= 隐藏
    expect(keysOf(hidden)).toContain("2-4");
    expect(keysOf(hidden)).toContain("6-8");

    const revealed = hidden.update({ effects: unwrapSource.of({ from: 2, to: 8 }) }).state;
    expect(keysOf(revealed)).not.toContain("2-4");
    expect(keysOf(revealed)).not.toContain("6-8");
    // 粗体本身仍然加粗
    expect(keysOf(revealed)).toContain("4-6|md-strong");
  });
});

/** 与 `livePreview.test.ts` 里的同名工具一致：`from-to|class|...`。 */
function keysOf(state: EditorState): string[] {
  const out: string[] = [];
  for (const iter = state.field(livePreviewField).set.iter(); iter.value; iter.next()) {
    const spec = (iter.value as { spec: { class?: string } }).spec;
    out.push(`${iter.from}-${iter.to}${spec.class ? `|${spec.class}` : ""}`);
  }
  return out.sort();
}
