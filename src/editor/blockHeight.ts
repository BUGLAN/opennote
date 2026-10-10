/**
 * 块级 widget 的**已渲染高度**，以及源码态要补的**留白**。
 *
 * ## 为什么需要它
 *
 * 块级内容（表格 / mermaid / 公式块 / 块级图片 / 分隔线）在光标进出时会在
 * 「渲染态 ↔ 源码态」之间换形态。两种形态的高度毫无关系：
 *
 * | 块 | 源码态 | 渲染态 | 差 |
 * |---|---|---:|---:|
 * | 4 列表格 | ≈156px | 248px | −92px |
 * | mermaid | ≈130px | 273px | −143px |
 *
 * 于是**块下方的内容整块跳**（真实浏览器实测：表格 −130.66px、mermaid −164.17px）。
 * 而「块下方内容不动」在数学上**等价于「块的高度不变」** —— 块变矮了多少，
 * 就得在源码态补回多少留白，否则下方内容必然移动。
 *
 * ## 怎么用
 *
 * 1. 块渲染成 widget 时，它自己量一次高度并 `rememberBlockHeight(key, h)`
 *    （`widgets.ts` 的 `reportBlockHeight`）；
 * 2. 光标进到块里、源码露出来时，`blockPadPlugin` 量出源码态的高度，
 *    算出还差多少，`setBlockPad` 通知装饰层在**块的最后一行**补上 `padding-bottom`；
 * 3. 补完再量一次，差值收敛到 1px 内就停 —— 所以不会来回震荡。
 *
 * 钥匙是**块在文档里的原文**（`state.sliceDoc(node.from, node.to)`），
 * 两边（widget 侧 / 插件侧）用同一套算法，因此同一个块永远对得上。
 */
import { StateEffect } from "@codemirror/state";

/** 块原文 → 它渲染成 widget 时的高度（px）。 */
const heights = new Map<string, number>();
/** 条目很小，但不无限长：超过就按记录顺序淘汰最老的。 */
const HEIGHTS_CAP = 512;

export function rememberBlockHeight(key: string, height: number): void {
  if (!key || !Number.isFinite(height) || height <= 0) return;
  heights.set(key, height);
  if (heights.size > HEIGHTS_CAP) {
    const oldest = heights.keys().next();
    if (!oldest.done) heights.delete(oldest.value);
  }
}

export function blockHeightFor(key: string): number | null {
  return heights.get(key) ?? null;
}

/**
 * 告诉装饰层：某个块的源码态要补多少留白。
 *
 * `pad` 是**补白总量**（不是增量），装饰层直接把它写成最后一行 `padding-bottom`。
 * 小于 1px 视为「不用补」，会把该块的记录删掉。
 */
export const setBlockPad = StateEffect.define<{ key: string; pad: number }>();

/** @internal 单测用：看记忆表现状。 */
export function blockHeightStats(): { sizes: number } {
  return { sizes: heights.size };
}

/** @internal 单测用：清空记忆表。模块级单例，用例之间需要干净的起点。 */
export function clearBlockHeights(): void {
  heights.clear();
}
