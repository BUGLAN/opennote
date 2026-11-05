import { StateEffect } from "@codemirror/state";

/**
 * 「把这一段源码露出来」。
 *
 * 由 `unwrap.ts` 的删除键处理器发出：光标停在某个**已渲染行内元素**（`**粗体**`、
 * `` `代码` ``、链接、图片…）的边界上按删除时，先露源码、吃掉这次按键 —— 这就是
 * 「删掉这个粗体这一块」的手感；再按一次才真的删内容。链接浮层的「编辑」、单击行内公式
 * 也用它。
 *
 * 单独放一个模块：widget（`widgets.ts`）也要发它，而 `livePreview.ts` 依赖 widget ——
 * 定义放在任一边都会成环。
 */
export const unwrapSource = StateEffect.define<{ from: number; to: number }>();
