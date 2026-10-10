import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { blockHeightFor, setBlockPad } from "./blockHeight";
import { livePreviewField } from "./livePreview";

/**
 * 光标进出块级内容时，把「渲染态高度」与「源码态高度」的**差额补成留白**。
 *
 * ## 它解决的是一条绕不开的算术
 *
 * 块级内容（表格 / mermaid / 公式块 / 块级图片 / 分隔线）在光标进出时换形态，
 * 而两种形态高度不同 —— 真实浏览器实测：
 *
 * | 块 | 源码态 | 渲染态 | 补白 |
 * |---|---|---:|---:|
 * | 4 列表格 | ≈118px | 248px | 130.66px |
 * | mermaid | ≈101px | 273px | 172.34px |
 * | `$$` 公式块 | ≈77px | 91px | 13.66px |
 * | 块级图片 | ≈29px | 36px | 6.39px |
 *
 * 于是**块下方的内容整块跳**（实测表格 −130.66px、mermaid −164.17px）。
 * 而「块下方内容不动」在数学上**等价于「块的高度不变」**：块变矮了多少，
 * 就得在源码态补回多少留白。
 *
 * 滚动补偿解决不了这件事 —— 那只会把「下方内容跳」换成「你点的那一块跳走」，更糟。
 *
 * ## 怎么收敛
 *
 * 每次**装饰换过一轮**（`epoch` 变了，意味着某个块可能换了形态）就看一眼光标所在的块：
 *
 * 1. 这个块渲染成 widget 时的高度 `rendered` 由 widget 自己量好记下（`blockHeight.ts`）；
 * 2. 现在的高度 `height` 从 CM 的行高表读（见下面 `read` 里为什么不能用 `coordsAtPos`）；
 * 3. 已经补过的留白是 `applied`，所以**源码本身**的高度是 `height − applied`；
 * 4. 该补 `rendered − (height − applied)`，差值小于 1px 就不派发。
 *
 * 第 3 步是关键：不减掉已补的部分，就会「补 → 量到更高 → 再补 → 再量」无限循环。
 *
 * 顺带一个自洽性：块渲染成 widget 时 `height ≈ rendered`，算出来 `pad ≈ applied`，
 * 于是**不会**派发 —— 这个插件对「块正在渲染态」这件事天然无副作用。
 */
export const blockPad = ViewPlugin.fromClass(
  class {
    update(u: ViewUpdate) {
      const before = u.startState.field(livePreviewField, false);
      const after = u.state.field(livePreviewField, false);
      if (!after) return;
      // 装饰没换过一轮 ⇒ 没有块换形态 ⇒ 不必量
      if (before && before.epoch === after.epoch) return;

      const state = u.state;
      const tree = syntaxTree(state);
      const head = Math.min(state.selection.main.head, state.doc.length);
      let block: SyntaxNode | null = tree.resolveInner(head, 1);
      while (block?.parent && block.parent.name !== "Document") block = block.parent;
      if (!block || block.name === "Document") return;

      const key = state.sliceDoc(block.from, block.to);
      // 不是「记得住渲染高度的块级内容」（普通段落、标题…）⇒ 直接跳过。
      // 放在调度之前是为了不白排一次测量：绝大多数事务都走这条出口。
      if (blockHeightFor(key) == null) return;

      const applied = after.pads.get(key) ?? 0;
      const from = block.from;
      const to = block.to;

      u.view.requestMeasure({
        read: (view) => {
          /*
           * 用 CM 自己的**行高表**（`lineBlockAt`）而不是 `coordsAtPos` 量这个块。
           *
           * 区别是致命的：`coordsAtPos(pos).bottom` 给的是**文字盒**下沿，
           * 不含行的 `padding-bottom` —— 而补白正是靠 padding 实现的。用它去量，
           * 「已补的部分」永远量不回来，于是 `pad` 每一轮都变大：
           * 实测表格从 136px 一路涨到 1498px（发散）。
           *
           * `lineBlockAt` 读的是高度表，而高度表是用 `getBoundingClientRect().height`
           * 逐行实测来的（含 padding）；`viewState.measure()` 又跑在 measureRequests
           * 的 read 回调**之前**，所以这里读到的一定是本轮最新的高度。
           */
          const top = view.lineBlockAt(from);
          const bottom = view.lineBlockAt(to);
          return bottom.bottom - top.top;
        },
        write: (height, view) => {
          if (height == null || height <= 0) return;
          // 期间可能又被别的重建改过，重新取一次
          const rendered = blockHeightFor(key);
          if (rendered == null) return;
          /*
           * 补白上限 = 这个块渲染时的高度。
           *
           * 这是一道**安全网**，防的是一类已经踩过的坑：如果补白落在了不参与布局的行上
           * （例如被 `display:none` 隐藏的围栏行），`height` 就永远长不上去，
           * `pad` 会一轮轮变大 —— 实测发散到 2298px。正常情况下
           * `rendered − (height − applied) ≤ rendered` 恒成立，这道上限不生效；
           * 一旦生效就说明「补了但没量到」，此时宁可少补也不能让它失控。
           */
          const pad = Math.min(rendered, Math.max(0, rendered - (height - applied)));
          if (Math.abs(pad - applied) < 1) return;
          /*
           * 必须**延到微任务**里派发，不能在 `write` 里直接 `view.dispatch()`。
           *
           * 原因：`requestMeasure` 的 `write` 阶段 `EditorView.updateState` 仍是
           * `Updating`，此时 `dispatch()` 会抛
           * 「Calls to EditorView.update are not allowed while an update is in progress」——
           * 而它被 CM 的 `logException` **静默吞掉**。症状极具迷惑性：
           * 高度量出来了、代码也走到了，但装饰集里什么都没有。
           *
           * 微任务在同一个任务（测量所在的 rAF 回调）结束之后、浏览器绘制之前执行，
           * 所以既不会多闪一帧，也不会和测量循环打架。
           */
          queueMicrotask(() => {
            // 微任务里视图可能已经被销毁（换笔记、关标签）——`EditorView.destroyed`
            // 在类型上是私有的，用 DOM 连接性判断同样可靠且是公开 API。
            if (!view.dom.isConnected) return;
            view.dispatch({ effects: setBlockPad.of({ key, pad }) });
          });
        },
      });
    }
  },
);
