/**
 * 外部改动（磁盘赢）落到编辑器时的**最小改动**。
 *
 * ## 为什么不能整篇替换
 *
 * `EditorHost` 收到外部内容变化时，原来是 dispatch 一个
 * `{ from: 0, to: doc.length, insert: next }`（整篇替换）。这对文档内容是等价的，
 * 但对**滚动位置**不是：
 *
 *   - `ViewState.update()` 把滚动锚点映射进新文档时用的是
 *     `scrollAnchorPos = update.changes.mapPos(anchor.from, -1)`。整篇替换的映射区间是
 *     `[0, len]`，`assoc = -1` ⇒ **锚点一律塌到 0**（文档开头）；
 *   - 而 `scrollAnchorHeight` 仍是旧文档里那一行的 top（实测 3961.73px）；
 *   - 于是 `measure()` 里的滚动补偿算出 `diff = lineBlockAt(0).top - 3961.73 ≈ -3961.73`，
 *     执行 `scroll.scrollTop += diff` —— **整篇文档被拽回顶部**。
 *
 * 实测（`scripts/geometry-probe/probe.ts` 的「不变量 4」，真实 Chrome + 真实扩展）：
 * 一篇 24 000px 高的笔记滚到 `scrollTop = 4000`，外部改动落下来之后变成 **74**
 * （Δ = −3926px）。用户看到的就是「Agent 一改文件，我读的地方就没了」。
 *
 * 除了滚动位置，整篇替换还会把**整张高度表**作废：改动之外那些已经量过的行高
 * 全部退回 `HeightMapGap` 的字符比例估算，长笔记里这会连带放大归档报告 §0.1 F
 * 那条「大跨度滚动被 CM 自己改写 `scrollTop`」的暴露面。
 *
 * ## 最小改动为什么是对的
 *
 * 只替换「公共前后缀之外」的那一段（前后缀的字符一字不动），最终文档与整篇替换
 * **逐字相同**，但 CodeMirror 的两条机制都恢复成它设计时的样子：
 *
 *   - **改动在视口下方** ⇒ 锚点行没被碰到 ⇒ `newAnchorHeight === scrollAnchorHeight`
 *     ⇒ `diff = 0` ⇒ 视口一动不动（实测 Δ = 0.00px）；
 *   - **改动在视口上方** ⇒ 锚点映射到同一段内容的新位置 ⇒ `diff` 正好等于上方新增的
 *     高度 ⇒ CM 把它补进 `scrollTop`，视口钉在同一段内容上（实测：上方插入 370px，
 *     `scrollTop 4000 → 4370`，视口顶行位移 0.32px）；
 *   - **高度表**只作废被改动覆盖的行，其余实测行高原样保留。
 *
 * ## 边界
 *
 * 改动**覆盖了视口锚点所在的字符**（例如 Agent 把整篇重写、或正好重写了你正在读的
 * 那一段）时，锚点映射到改动区间的起点 —— 视口会落到那段新内容的最上面。
 * 这是「同一位置」在内容被重写之后本来就没有定义，不是这一层能补的；对小改动它正是
 * 想要的行为（你看到的就是被重写的那一段）。
 */

export interface ReplaceChange {
  from: number;
  to: number;
  insert: string;
}

export interface MinimalReplace {
  changes: ReplaceChange;
  /** 按索引夹进新文档的选区 —— 与旧的「整篇替换 + 夹光标」行为一致。 */
  selection: { anchor: number; head: number };
}

/** 代理对的高位（`0xD800-0xDBFF`）—— 用来避免把改动边界切在字符中间。 */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * 把「旧文本 → 新文本」表示成**一段**最小改动。
 *
 * 返回的 `changes` 落在公共前缀之后、公共后缀之前，保证
 * `oldText.slice(0, from) + insert + oldText.slice(to) === nextText`。
 * 两段文本相同时返回一段空改动（`from === to`、`insert === ""`）。
 */
export function minimalReplace(
  oldText: string,
  nextText: string,
  selection: { anchor: number; head: number },
): MinimalReplace {
  const max = Math.min(oldText.length, nextText.length);
  let head = 0;
  while (head < max && oldText.charCodeAt(head) === nextText.charCodeAt(head)) head += 1;
  // 别把边界切在代理对中间：两个不同的 emoji 可能共用高位代理（U+1F600 / U+1F601）。
  if (head > 0 && head < max && isLowSurrogate(nextText.charCodeAt(head))) head -= 1;

  let tail = 0;
  while (
    tail < max - head &&
    oldText.charCodeAt(oldText.length - 1 - tail) === nextText.charCodeAt(nextText.length - 1 - tail)
  ) {
    tail += 1;
  }

  const to = oldText.length - tail;
  const insertEnd = nextText.length - tail;
  return {
    changes: { from: head, to, insert: nextText.slice(head, insertEnd) },
    selection: {
      anchor: Math.min(selection.anchor, nextText.length),
      head: Math.min(selection.head, nextText.length),
    },
  };
}
