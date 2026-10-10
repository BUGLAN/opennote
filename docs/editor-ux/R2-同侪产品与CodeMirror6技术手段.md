# R2｜同侪产品与 CodeMirror 6 技术手段调研

> 主题：Markdown / 块编辑器在「编辑时内容位置跳动（layout shift / scroll jump / 光标跳动）」上的机制与公认规避手段。
> 目的：为 Opennote（Typora 风格 Markdown 笔记本，直接构建在 CodeMirror 6 上）判断现有可疑实现是否被官方支持。
>
> **本文档不做代码修改，只做事实认定。** 所有结论均标注来源与可信度。

---

## 0. 可信度标签与证据基线

| 标签 | 含义 |
| --- | --- |
| 【官方文档确证】 | CodeMirror / 产品官方文档原文可查 |
| 【官方源码或 issue】 | 官方源码（含类型声明内嵌文档注释）、官方 changelog、官方仓库 issue、维护者本人的回复 |
| 【社区共识】 | 官方论坛中非维护者主导、但被反复验证的做法 |
| 【未找到】 | 明确未找到一手来源，不做推测 |

### 0.1 证据基线（本机实际运行的版本）

本次调研的 CM6 结论**优先基于本机 `node_modules` 中随代码一起发布的一手源码**，因为这是 Opennote 实际执行的代码，比网页快照更可靠：

| 包 | 本机版本 | 一手来源路径 |
| --- | --- | --- |
| `@codemirror/view` | **6.43.13** | `node_modules/@codemirror/view/dist/index.js`、`index.d.ts`、`CHANGELOG.md` |
| `@codemirror/state` | 6.7.6 | `node_modules/@codemirror/state/dist/` |
| `@codemirror/lang-markdown` | 6.5.2 | `node_modules/@codemirror/lang-markdown/` |
| `@codemirror/language` | 6.12.4 | `node_modules/@codemirror/language/dist/` |

> ⚠️ 版本差异提醒：本机 `@codemirror/view` 为 **6.43.13**，其 CHANGELOG 最新条目为 `6.43.13 (2026-09-22)`；而调研时可访问的 GitHub `main` 分支 CHANGELOG 顶部仅到 `6.41.0 (2026-04-01)`。**两者不一致时以本机 6.43.13 为准**（例如 `overflow-anchor` 的引入、`cursorScrollMargin` 的存在都在本机源码中得到确认）。
>
> `index.d.ts` 中的文档注释即 `https://codemirror.net/docs/ref/` 页面正文的原始出处，因此本文引用 `index.d.ts` 的段落与引用在线 ref 文档等价；下文同时给出在线锚点 URL。

---

# A. CodeMirror 6

## A1. 在 `.cm-line` 上用 CSS `display: none` 隐藏一整行，官方是否支持？

### 结论

**没有找到任何一条官方明文写「禁止对 `.cm-line` 使用 `display: none`」**【未找到】。
但从**官方源码与官方 changelog** 可以确证：**CM6 的整套位置/滚动体系建立在「每个已渲染行都有真实几何高度」这一前提上**，对整行 `display: none` 属于**事实上的不支持**，会破坏测量、坐标映射、垂直移动与滚动高度。

### 官方源码证据：行高是从 DOM 实测出来的

`DocView.measureVisibleLineHeights()` 对每个行元素直接取 `getBoundingClientRect().height` 作为该行高度：

```js
// node_modules/@codemirror/view/dist/index.js:3318-3362（节选）
measureVisibleLineHeights(viewport) {
    ...
    let scan = (tile, pos, measureBounds) => {
        for (let i = 0; i < tile.children.length; i++) {
            ...
            let childRect = child.dom.getBoundingClientRect(), { height } = childRect;
            ...
            result.push(height + spaceAbove);
```

`display: none` 的元素 `getBoundingClientRect()` 全为 0，因此该行会以**高度 0** 写入高度图（`HeightMap`）。

而 `HeightMap` 是 CM6 唯一的「文档位置 ↔ 屏幕高度」映射源，下列 API 全部经由它：

```js
// node_modules/@codemirror/view/dist/index.js:6668-6691（节选）
lineBlockAt(pos) { ... this.heightMap.lineAt(pos, QueryType.ByPos, ...) }
lineBlockAtHeight(height) { ... this.heightMap.lineAt(height, QueryType.ByHeight, ...) }
elementAtHeight(height) { return scaleBlock(this.heightMap.blockAt(...)) }
```

→ 来源：`node_modules/@codemirror/view/dist/index.js`【官方源码或 issue】

### 官方 changelog 证据：`display: none` 行确实触发过崩溃

| 版本 | 官方条目 | 说明 |
| --- | --- | --- |
| `6.43.1 (2026-06-09)` | “Fix a crash when calling ␠ on a line with only `display: none` content.” | CM6 **因为「内容为 `display: none` 的行」而崩溃过**，并在本机运行的 6.43.13 之前被修复。原句中函数名在 changelog 生成时被剥离（本地 `CHANGELOG.md:113` 与在线版本均缺该标识符），故不臆测具体是 `posAtCoords` 还是 `coordsAtPos`。 |
| `6.14.0 (2023-06-23)` | “Fix an issue where having a bunch of padding on lines could cause vertical cursor motion and `posAtCoords` to jump over lines.” | 行的视觉盒模型变化会让**垂直光标移动与 `posAtCoords` 跳过整行**——与隐藏行同类的失效模式。 |
| `0.19.4 (2021-09-01)` | “Fix an issue where lines containing just a widget decoration wrapped in a mark decoration could be displayed with 0 height.” | 「行高度为 0」被官方视为 bug 并修复。 |
| `6.39.2 (2025-12-09)` | “Fix an issue where `moveVertially` was sometimes unable to escape lines with thick borders or padding.” | 行盒模型异常会卡住垂直移动。 |

→ 来源：`node_modules/@codemirror/view/CHANGELOG.md`【官方源码或 issue】

### 官方 issue 证据：布局缺失时 CM6 会自己把文档滚走

- **codemirror/dev#952**（`Exception when editor is initialized out of view`）：编辑器以 `display: none` 初始化时抛异常，栈直指 `HeightMapGap.blockAt → lineBlockAtHeight → measure`。
  https://github.com/codemirror/dev/issues/952 【官方源码或 issue】
- **codemirror/dev#957**（`Editors created out-of-view and subsequently displayed scrolls down`）：报告者（Obsidian 开发者 lishid）直接定位到**测量阶段的 scroll-anchor 差值计算**：“refHeight = 0 but lineBlockAtHeight gives us some random block later on … Subsequent position diff finds a big difference and scrolls down”。即**当几何信息不可信时，CM6 的滚动补偿会主动把视口滚到错误位置**。
  https://github.com/codemirror/dev/issues/957 【官方源码或 issue】

### 会造成什么后果（逐项对应你列出的关注点）

| 关注点 | 具体后果 |
| --- | --- |
| 测量 | `measureVisibleLineHeights` 记录该行高度为 0；高度图与真实 DOM 不一致。 |
| `posAtCoords` | 点击无法落进「无几何」的行；官方在 `6.43.1` 专门修过此类崩溃。 |
| 方向键上下移动 | `moveVertically` 依赖 `lineBlockAt` / `coordsAtPos` 的几何；行高为 0 会导致**跳过整行或落点错位**（同 `6.14.0`、`6.39.2` 的失效模式）。 |
| 滚动高度 | 文档总高 `docHeight = scaler.toDOM(heightMap.height)` 由高度图推出；隐藏行会让总高在「估计值 / 实测值」之间来回跳动。 |
| `heightMap` | 装饰变化会经 `heightRelevantDecoChanges()` 判定是否影响高度；**纯 CSS 变化 CM6 完全不知情**，无法触发相应的重算与补偿。 |
| 综合症状 | 触发测量循环反复重启，控制台出现 `Measure loop restarted more than 5 times` / `Viewport failed to stabilize`。 |

`Measure loop restarted more than 5 times` 的告警字符串确实存在于本机源码中：

```js
// node_modules/@codemirror/view/dist/index.js:8208-8213
if (i > 5) {
    console.warn(this.measureRequests.length
        ? "Measure loop restarted more than 5 times"
        : "Viewport failed to stabilize");
    break;
}
```

→ 来源：`node_modules/@codemirror/view/dist/index.js`【官方源码或 issue】

### 官方正确的替代做法

**结论：用「替换装饰」而不是 CSS 来隐藏行；并且必须由 `StateField` 直接提供。** 【官方文档确证 + 官方源码】

1. **官方文档原文（`EditorView.decorations`）**：
   > “Only decoration sets provided directly are allowed to influence the editor's vertical layout structure. The ones provided as functions are called _after_ the new viewport has been computed, and thus **must not** introduce block widgets or replacing decorations that cover line breaks.”
   https://codemirror.net/docs/ref/#view.EditorView^decorations
   对应本机 `index.d.ts:1306-1321`。

2. **官方文档原文（Decorations 示例页）**：
   > “Decorations that signficantly change the vertical layout of the editor, for example by replacing line breaks or inserting block widgets, must be provided directly, since indirect decorations are only retrieved after the viewport has been computed.”
   https://codemirror.net/examples/decoration/

3. **官方标准实现就是折叠（folding）**：`@codemirror/language` 的 `foldState` 是一个 **`StateField`**，通过 `provide: f => EditorView.decorations.from(f)` 直接提供 `Decoration.replace` 范围：
   ```js
   // node_modules/@codemirror/language/dist/index.js:1316-1345（节选）
   const foldWidget = Decoration.replace({ widget: new class extends WidgetType { ... } });
   ...
   return folded.update({ add: decorations });
   ...
   provide: f => EditorView.decorations.from(f),
   ```
   → 隐藏整行（含 Setext 下划线行、代码围栏行）的官方姿势 = **`StateField` 里的 `Decoration.replace({widget})`，范围覆盖该行（含行尾换行符）**。
   https://codemirror.net/docs/ref/#view.Decoration^replace 【官方源码或 issue】

4. **官方论坛同一问题的定论**：用户用 `ViewPlugin` + `Decoration.replace` 替换整行时出现内容缺失与 `Measure loop restarted more than 5 times`；维护者 Marijn 明确要求改用 `StateField`，并给出可运行方案。
   https://discuss.codemirror.net/t/hiding-replacing-lines-that-begin-with-a-certain-signifier/4473 【官方源码或 issue（维护者回复）】

---

## A2. `Decoration.replace({ block: true })` 的官方约束

### 结论：文档约束 + 源码强制报错，双重确认

**【官方文档确证】文档原文：**

| 约束 | 原文 | 链接 |
| --- | --- | --- |
| 块级装饰**不能由 ViewPlugin / 函数式 decorations 提供** | “Only decoration sets provided directly are allowed to influence the editor's vertical layout structure. The ones provided as functions … thus **must not** introduce block widgets or replacing decorations that cover line breaks.” | https://codemirror.net/docs/ref/#view.EditorView^decorations |
| 块级装饰**不应有垂直 margin** | “Note that block-level decorations should not have vertical margins, and if you dynamically change their height, you should make sure to call `requestMeasure`, so that the editor can update its information about its vertical layout.” | https://codemirror.net/docs/ref/#view.Decoration^widget^spec.block |
| `block` 的默认值 | `ReplaceDecorationSpec.block`：“Whether this is a block-level decoration. Defaults to false.” | https://codemirror.net/docs/ref/#view.Decoration^replace |
| `inclusive` 默认值随 `block` 变化 | “Defaults to false for inline replacements, and **true for block replacements**.” | 同上 |
| 块级 widget 与内联 widget 的排序 | “By default, to avoid unintended mixing of block and inline widgets, block widgets with a positive `side` are always drawn after all inline widgets at that position … Setting `inlineOrder` to `true` … will turn this off.” | https://codemirror.net/docs/ref/#view.Decoration^widget^spec.inlineOrder |
| 与 `atomicRanges` 的配合 | “If you want decorated ranges to behave like atomic units for cursor motion and deletion purposes, also provide the range set containing the decorations to `EditorView.atomicRanges`.” | https://codemirror.net/docs/ref/#view.EditorView^decorations |

**关于「零长度」「覆盖换行」的官方约束（源码硬校验）：**

```js
// node_modules/@codemirror/view/dist/index.js:318-365（节选）
throw new RangeError("Mark decorations may not be empty");
throw new RangeError("Line decoration ranges must be zero-length");
throw new RangeError("Invalid range for replacement decoration");
throw new RangeError("Widget decorations can only have zero-length ranges");
```

**由 ViewPlugin 提供块装饰 / 跨行替换装饰，会直接抛 `RangeError`（不是静默忽略）：**

```js
// node_modules/@codemirror/view/dist/index.js:2770-2777
point: (from, to, deco, active, openStart, index) => {
    if (deco instanceof PointDecoration) {
        if (this.disallowBlockEffectsFor[index]) {
            if (deco.block)
                throw new RangeError("Block decorations may not be specified via plugins");
            if (to > this.view.state.lineAt(from).to)
                throw new RangeError("Decorations that replace line breaks may not be specified via plugins");
        }
```

→ 来源：`node_modules/@codemirror/view/dist/index.js`【官方源码或 issue】

**官方 changelog 对应的加固记录：**

- `0.19.36 (2021-12-22)`：“**Adding block decorations from a plugin now raises an error.** Replacing decorations that cross lines are ignored, when provided by a plugin.”
- `0.19.42 (2022-02-04)`：“Report an error when a replace decoration from a plugin crosses a line break, rather than silently ignoring it.”
- `0.19.16 (2021-11-11)`：**Breaking** — “Block replacement decorations now default to inclusive, because non-inclusive block decorations are rarely what you need.”

→ 来源：`node_modules/@codemirror/view/CHANGELOG.md`【官方源码或 issue】

### 对 Opennote 的直接判定

- ✅ `Decoration.replace({ widget, block: true })` 本身**是被官方支持的机制**。
- ❌ **但前提是它必须来自 `StateField`（直接提供的 decorations），不能来自 `ViewPlugin`。** 若你的表格/公式/mermaid 块 widget 是在 `ViewPlugin` 里生成 decorations 的，CM6 会直接抛 `RangeError`。这一点值得立刻核对（本次调研未读取 Opennote 源码）。
- ⚠️ 块级 widget **不要设垂直 margin**；高度动态变化时**必须 `requestMeasure()`**。

---

## A3. 块级 widget 高度首次渲染后变化（异步图片 / KaTeX / mermaid 完成）时 CM6 怎么处理？

这是本次调研**最关键的发现**：CM6 **内置了一套 scroll anchoring 补偿循环**，并且有明确的触发条件与豁免条件。

### A3.1 官方文档层面的要求

- `WidgetDecorationSpec.block` 原文：“…if you dynamically change their height, you should make sure to call `requestMeasure`, so that the editor can update its information about its vertical layout.”
  https://codemirror.net/docs/ref/#view.Decoration^widget^spec.block 【官方文档确证】
- `WidgetType.estimatedHeight` 原文：“The estimated height this widget will have, to be used when estimating the height of content that hasn't been drawn. May return -1 to indicate you don't know. The default implementation returns -1.”
  https://codemirror.net/docs/ref/#view.WidgetType 【官方文档确证】
- `WidgetType.coordsAt` 原文：“Override the way screen coordinates for positions at/in the widget are found.”
  同上。

### A3.2 维护者亲口说：大块 widget 必须实现 `estimatedHeight` 与 `coordsAt`

discuss.codemirror.net 上一位做「长 Markdown 表格块 widget」的开发者报告「光标在 widget 内移动时编辑器频繁跳到 widget 开头/结尾」。**Marijn（CM 作者）本人的回答**：

> “Drawn content is measured precisely as soon as it appears in the DOM. I don't think your conclusion here is correct.”

而提问者最终确认的解法是：

> “It turns out that the `estimatedHeight` and `coordsAt` methods of the widget are vital for large block widgets. By giving the editor a rough estimated height and returning proper coords for any positions within the widgets I was able to almost completely get the jumping under control.”
> “the further off the estimate is from the actual rendered widget's height, the worse the jumping gets”

https://discuss.codemirror.net/t/unwanted-programmatic-scrolling-with-large-widgets/9372 【官方源码或 issue（维护者回复）+ 社区共识】

→ **可操作结论**：块级 widget **必须**实现 `estimatedHeight`（尽量接近真实高度）与 `coordsAt`，否则「跳动」几乎不可避免。这直接对应 Opennote 的表格 / 公式 / mermaid 块。

### A3.3 官方 changelog 确认：CM6 会「注意到」widget 高度变化

- `6.7.0 (2022-12-07)`：“**Make the editor notice widget height changes to automatically adjust its height information.**”
- `6.13.0 (2023-06-05)`：“Fix a bug where **differences between widgets' estimated and actual heights could cause the editor to inappropriately move the scroll position**.”
- `6.13.2 (2023-06-13)`：“Fix an issue in scroll position stabilization for **changes above the visible**, where **Chrome already does this natively and we ended up compensating twice**.”
- `6.15.0 (2023-07-17)`：“Fix an issue that could cause the scroll position to **jump wildly**”
- `6.14.1 (2023-07-06)`：“Fix an issue where scrolling up through line-wrapped text would sometimes cause the scroll position to **pop down**.”
- `6.36.4 (2025-03-03)`：“Fix an issue where scrolling down to a range higher than the viewport could in some situations fail to scroll to the proper position.”
- `6.43.9 (2026-08-16)`：“Fix an issue where the scroll position would incorrectly be moved up when a document scrolled to the bottom would lose height.”
- `6.43.10 (2026-08-31)`：“Avoid scroll position jumping during editor scaling by properly taking scale into account when stabilizing the vertical position.”

→ 来源：`node_modules/@codemirror/view/CHANGELOG.md`【官方源码或 issue】

### A3.4 「height change above the viewport」在 CM6 里的确切处理（源码级）

CM6 在每次 `measure()` 循环中执行如下算法（本机 `index.js:8185-8285`）：

1. 进入循环前，记录当前滚动锚点：**锚点 = 当前 scrollOffset 处的行块**。
   ```js
   scrollAnchorAt(scrollOffset) {
       let block = this.lineBlockAtHeight(scrollOffset + 8);
       return block.from >= this.viewport.from || this.viewportLines[0].top - scrollOffset > 200
           ? block : this.viewportLines[0];
   }
   ```
   （`index.js:6682-6685`）若已滚到底部，则锚点取文档总高（`scrollAnchorPos = -1`）。
2. 测量完成后，重新计算锚点块的 `top`，与记录值比较：
   ```js
   let newAnchorHeight = scrollAnchorPos < 0 ? this.viewState.heightMap.height :
       this.viewState.lineBlockAt(scrollAnchorPos).top;
   let diff = (newAnchorHeight / this.viewState.scaleY) - (scrollAnchorHeight / scrollScale);
   if ((diff > 1 || diff < -1) && !(browser.ios && ...momentum...) &&
       (scroll == this.scrollDOM || this.hasFocus ||
        Math.max(this.inputState.lastWheelEvent, this.inputState.lastTouchTime) > Date.now() - 100)) {
       scrollOffset = scrollOffset + diff;
       if (!scroll) this.win.scrollBy(0, diff);
       else if (scrollAnchorPos < 0) scroll.scrollTop = scroll.scrollHeight;
       else scroll.scrollTop += diff;
       scrollAnchorHeight = -1;
       continue;
   }
   ```
   （`index.js:8264-8280`）

**即：CM6 确实会自动补偿 `scrollTop`，以免视口上方高度变化导致内容跳。但补偿有 4 个严格前提：**

| 前提 | 源码依据 |
| --- | --- |
| 锚点块顶部位移 **> 1px** | `diff > 1 \|\| diff < -1` |
| **不是** iOS 惯性滚动中 | `!(browser.ios && lastIOSMomentumScroll > Date.now() - 100)` |
| 且满足三者之一：**滚动容器就是 `.cm-scroller`**、**编辑器有焦点**、**100ms 内发生过 wheel/touch** | `scroll == this.scrollDOM \|\| this.hasFocus \|\| lastWheel/lastTouch > now-100` |
| 用户在两次 measure 之间**没有自己滚动过** | `if (Math.abs(scrollOffset - this.viewState.scrollOffset) > 1) scrollAnchorHeight = -1;`（`index.js:8187-8188`，一旦用户滚动过就放弃补偿） |

→ 来源：`node_modules/@codemirror/view/dist/index.js`【官方源码或 issue】

**⚠️ 对 Opennote 最要紧的一条：补偿目标 `scroll` 是 `viewState.scrollParent`（最近的滚动祖先）。**
若 Opennote 把编辑器放在一个**父级滚动容器**里（`.cm-scroller` 自己不滚），则：
- 补偿逻辑走 `scroll = scrollParent` 分支（`scrollTop += diff`），**理论上仍然生效**；
- 但这条路径**历史上 bug 密集**：
  - `6.39.16 (2026-03-02)`：“**Perform scroll stabilization on the document or wrapping scrollable elements**, when the user scrolls the editor.”
  - **codemirror/dev#1673**：`Scroll snaps upward on first click after scrolling - regression in 6.39.x`。报告者环境正是「父 div 是真正滚动容器、`.cm-scroller` 从不滚动」，症状是**首次点击后视口向上跳**，光标落点正确但滚动位置错。Marijn 复现后修补，`6.39.13` 之后修复。
    https://github.com/codemirror/dev/issues/1673 【官方源码或 issue】
  - **discuss 9603**：用户问「不用 `cm-scroller` 作为滚动元素是否必然导致 jumpy scrolling」，Marijn 未直接回答；提问者最终自述**是自身 CSS/flex 布局问题**。另一位用户抱怨“I'd click on line 5 and the editor would some unnecessary jumping or shifting.”
    https://discuss.codemirror.net/t/on-scrolling-with-parent-and-content-loading-on-scroll/9603 【社区共识】
  → **Opennote 的「位置经常变动」很可能与「父级滚动容器 + 动态高度块」这个组合直接相关，而不是单纯的装饰写法问题。**

### A3.5 `view.requestMeasure()` vs `EditorView.requestMeasure`

**这两者不是两个不同 API。** 官方只有一个实例方法：

```ts
// index.d.ts:866-874
/**
Schedule a layout measurement, optionally providing callbacks to
do custom DOM measuring followed by a DOM write phase. Using
this is preferable reading DOM layout directly from, for
example, an event handler, because it'll make sure measuring and
drawing done by other components is synchronized, avoiding
unnecessary DOM layout computations.
*/
requestMeasure<T>(request?: MeasureRequest<T>): void;
```

- 调用形式就是 **`view.requestMeasure()`**，即「实例方法挂在 `view` 上」；`EditorView.requestMeasure` 只是 ref 文档里的锚点写法 `#view.EditorView.requestMeasure`，**没有静态版本**。
  https://codemirror.net/docs/ref/#view.EditorView.requestMeasure 【官方文档确证】
- `MeasureRequest` 允许传 `{ read, write }` 两个回调，实现「先统一读布局、再统一写 DOM」的两阶段，避免强制同步布局（layout thrashing）。
- **正确用法（异步渲染完成后）**：在 `img.onload` / KaTeX `render` 回调 / mermaid `render` 的 promise `then` 里，先同步写入 DOM，然后调用 `view.requestMeasure()`。**不要在 `ViewPlugin.update` 或 `docViewUpdate` 里直接读 DOM**：
  ```ts
  // index.d.ts:433-450
  /**
  Notifies the plugin of an update that happened in the view. This
  is called _before_ the view updates its own DOM. ... To avoid unnecessary
  layout recomputations, it should _not_ read the DOM layout—use
  `requestMeasure` to schedule your code in a DOM reading phase if you need to.
  */
  update?(update: ViewUpdate): void;
  /**
  Called when the document view is updated (due to content,
  decoration, or viewport changes). Should not try to immediately
  start another view update. Often useful for calling `requestMeasure`.
  */
  docViewUpdate?(view: EditorView): void;
  ```
  https://codemirror.net/docs/ref/#view.ViewPlugin 【官方文档确证】

**结论**：异步 widget 高度变化后调 `view.requestMeasure()` 是**官方要求且被支持的**；但这**只更新高度信息**，是否补偿滚动仍受 A3.4 的 4 个前提约束。要完全消除跳动，还需要准确的 `estimatedHeight` + 正确的 `coordsAt`（A3.2）。

---

## A4. 与「保持位置稳定」相关的官方 API 语义

以下均为 `index.d.ts` 内嵌文档注释原文（等价于在线 ref 文档）。

| API | 官方语义（要点） | 链接 |
| --- | --- | --- |
| `EditorView.scrollIntoView(pos, options)` | 返回一个 **StateEffect**，加进 transaction 即可把位置/范围滚入视野。`y` 策略：默认 `"nearest"`（最小滚动量）、`"start"`、`"end"`、`"center"`；`yMargin` 默认 5，**必须小于编辑器高度**。 | [ref](https://codemirror.net/docs/ref/#view.EditorView^scrollIntoView) |
| `EditorView.scrollSnapshot()` | 返回一个 effect，**把编辑器重置回「调用该方法时」的滚动位置**。“The effect should be used with a document identical to the one it was created for. Failing to do so is not an error, but may not scroll to the expected position.” ⚠️ 只影响编辑器自己的滚动元素，**不影响父级**。 | [ref](https://codemirror.net/docs/ref/#view.EditorView.scrollSnapshot) |
| `EditorView.scrollMargins` | 提供「应被视为不可见」的额外滚动边距（例如固定的 gutter 覆盖区域）。“Not to be confused with `cursorScrollMargin`.” | [ref](https://codemirror.net/docs/ref/#view.EditorView^scrollMargins) |
| `EditorView.cursorScrollMargin` | 光标滚入视野时与编辑器边缘保持的距离，单个像素数或 `{x, y}`，**默认两轴各 5px**。（本机 6.43.13 确认存在；`6.41.0` changelog 记为新特性。） | [ref](https://codemirror.net/docs/ref/#view.EditorView^cursorScrollMargin) |
| `EditorView.scrollHandler` | 可**覆盖「滚入视野」的默认行为**：返回 `true` 则不再有后续处理，返回 `false` 走默认。“Scroll handlers should **never** initiate editor updates.” 这是拦截「编辑器自作主张滚动」的官方钩子。 | [ref](https://codemirror.net/docs/ref/#view.EditorView^scrollHandler) |
| `scrollPastEnd()` | 在内容底部加一个约等于编辑器高度（减一行）的边距，使**任意行都能滚到顶部**。“This is only meaningful when the editor is scrollable, and should not be enabled in editors that take the size of their content.” | [ref](https://codemirror.net/docs/ref/#view.scrollPastEnd) |
| `EditorView.contentAttributes` | 为**可编辑 DOM 元素**提供额外属性（`AttrSource`，可为函数）。常用于 `spellcheck` / `autocorrect` / `autocapitalize`。 | [ref](https://codemirror.net/docs/ref/#view.EditorView.contentAttributes) |
| `EditorView.lineWrapping` | “An extension that enables line wrapping in the editor (by setting CSS `white-space` to `pre-wrap` in the content).” | [ref](https://codemirror.net/docs/ref/#view.EditorView.lineWrapping) |
| `Decoration.line(spec)` | “Create a line decoration, which can add DOM attributes to the line starting at the given position.” 仅当定位在**行首**时生效；`LineDecorationSpec` 支持 `attributes` 与 `class`。→ **这是给整行加样式（如隐藏标记行的视觉、行高）的正规途径，而不是改 `display`。** | [ref](https://codemirror.net/docs/ref/#view.Decoration^line) |
| `EditorView.updateListener` | “A facet that can be used to register a function to be called every time the view updates.” | [ref](https://codemirror.net/docs/ref/#view.EditorView^updateListener) |
| `Decoration.replace({block:true})` | 见 A2。 | [ref](https://codemirror.net/docs/ref/#view.Decoration^replace) |

### 补充：CM6 自带「水平宽度稳定化」

隐藏 `**`、`#`、`>` 等内联标记会让整行变窄，可能引起水平滚动条抖动。CM6 对此**内置了稳定化逻辑**（记录 `minWidth` / `minWidthFrom` / `minWidthTo`）：

```js
// node_modules/@codemirror/view/dist/index.js:3318-3354（节选）
let contentWidth = this.view.contentDOM.clientWidth;
let isWider = contentWidth > Math.max(this.view.scrollDOM.clientWidth, this.minWidth) + 1;
...
if (width > widest) { widest = width; this.minWidth = contentWidth;
                      this.minWidthFrom = pos; this.minWidthTo = end; }
```

官方 changelog 亦记：`6.0.2 (2022-06-23)` “Fix a CSS issue that broke horizontal scroll width stabilization.”
→ 【官方源码或 issue】

---

## A5. CM6 对浏览器原生 scroll anchoring（`overflow-anchor`）的态度

### 结论：CM6 **主动禁用了它**，因为它与 CM6 自己的补偿机制冲突。

**官方源码（baseTheme）：**

```js
// node_modules/@codemirror/view/dist/index.js:6855-6865
".cm-scroller": {
    display: "flex !important",
    alignItems: "flex-start !important",
    fontFamily: "monospace",
    lineHeight: 1.4,
    height: "100%",
    overflowX: "auto",
    position: "relative",
    zIndex: 0,
    overflowAnchor: "none",   // ← 关键
},
```

**官方提交（commit message 与说明）：**

> **Style cm-scroller with overflow-anchor: none to prevent some buggy Chrome scrolling**
> `FIX: Avoid an issue where Chrome would incorrectly scroll the window when deleting lines in the editor.`
> See https://discuss.codemirror.net/t/why-delete-line-makes-parent-element-scroll/8524
> — Marijn Haverbeke, 2024-08-07, 修改 `src/theme.ts`（+`overflowAnchor: "none"`）

- 提交：https://github.com/codemirror/view/commit/71ef7556ad072a7e3150384cff066309a3c961af
- 对应 changelog：`6.31.0 (2024-08-11)` “Avoid an issue where Chrome would incorrectly scroll the window when deleting lines in the editor.”

**为什么禁用**：该议题中用户先自行找到 StackOverflow 的结论「给 `cm-scroller` 加 `overflow-anchor: none` 可解决父元素被浏览器自动滚动的问题」，Marijn 回复：

> “Oh, nice. I've added that kludge to the base styling in this patch.”

→ 来源：https://discuss.codemirror.net/t/why-delete-line-makes-parent-element-scroll/8524 【官方源码或 issue（维护者回复）】

### 解读与推论（谨慎标注）

- **官方事实**：CM6 在 `.cm-scroller` 上设 `overflow-anchor: none`，动机是「Chrome 会在删除行时错误地滚动窗口」，属于浏览器原生 scroll anchoring 与编辑器自身补偿逻辑**互相打架**。
- **【社区共识】**：Obsidian 论坛用户在处理同类跳动时，第一条自救手段就是给 `.cm-scroller` 加 `overflow-anchor: none !important`。
  https://forum.obsidian.md/t/.../112103 （见 B1）
- **⚠️ 注意范围**：`overflow-anchor: none` 只加在 **`.cm-scroller`** 上。若 Opennote 的滚动容器是 `.cm-scroller` 的**父级**，那么父级上浏览器原生 scroll anchoring 仍然生效，**会与 CM6 的补偿叠加**（这正是 changelog `6.13.2` 所述「Chrome 已经原生做了，我们又补偿了一次」的风险类别）。这是本次调研识别出的一个高优先级排查点。

---

## A6. CM6 社区关于「避免布局跳动」的公认做法清单

以下每条均附一手 URL 与可信度。

| # | 做法 | 来源 | 标签 |
| --- | --- | --- | --- |
| 1 | **凡是会改变垂直布局的装饰（块 widget、跨行 replace）必须由 `StateField` 直接提供**，不能用 `ViewPlugin`（否则抛 `RangeError`） | [ref](https://codemirror.net/docs/ref/#view.EditorView^decorations)、[示例](https://codemirror.net/examples/decoration/)、[discuss 4473](https://discuss.codemirror.net/t/hiding-replacing-lines-that-begin-with-a-certain-signifier/4473) | 官方文档确证 / 官方源码 |
| 2 | **大块 widget 必须实现 `estimatedHeight` 与 `coordsAt`**，且估计值越准跳动越小 | [discuss 9372](https://discuss.codemirror.net/t/unwanted-programmatic-scrolling-with-large-widgets/9372) | 官方（维护者）+ 社区共识 |
| 3 | **不要在 `ViewPlugin.update` 里读 DOM 布局**；统一走 `view.requestMeasure({read, write})` | [ref](https://codemirror.net/docs/ref/#view.EditorView.requestMeasure) | 官方文档确证 |
| 4 | **块级 widget 高度变化后主动 `requestMeasure()`**，不要依赖自动感知 | [ref](https://codemirror.net/docs/ref/#view.Decoration^widget^spec.block) | 官方文档确证 |
| 5 | **块级装饰不要设垂直 margin** | [ref](https://codemirror.net/docs/ref/#view.Decoration^widget^spec.block) | 官方文档确证 |
| 6 | **不要用 `display: none` 隐藏行**；用 replace 装饰（折叠式），行高交给编辑器管理 | 本机源码 `measureVisibleLineHeights` + changelog 6.43.1/6.14.0 + [issue 957](https://github.com/codemirror/dev/issues/957) | 官方源码或 issue（官方无明文禁令 → 该禁令为【未找到】，但事实不支持） |
| 7 | **给滚动容器设 `overflow-anchor: none`**（CM6 已对 `.cm-scroller` 内置；父级滚动容器需自行处理） | [commit 71ef755](https://github.com/codemirror/view/commit/71ef7556ad072a7e3150384cff066309a3c961af)、[discuss 8524](https://discuss.codemirror.net/t/why-delete-line-makes-parent-element-scroll/8524) | 官方源码或 issue |
| 8 | **不要改动 CM6 的 flex/CSS 布局**（父级 flex、`.cm-scroller` 的 overflow）——这是社区反复踩到的跳动根因 | [discuss 9603](https://discuss.codemirror.net/t/on-scrolling-with-parent-and-content-loading-on-scroll/9603) | 社区共识 |
| 9 | 需要「保存/恢复滚动位置」时用 **`EditorView.scrollSnapshot()`**，并保证文档一致 | [ref](https://codemirror.net/docs/ref/#view.EditorView.scrollSnapshot) | 官方文档确证 |
| 10 | 需要拦截编辑器自作主张的滚动时用 **`EditorView.scrollHandler`**（返回 `true` 即接管） | [ref](https://codemirror.net/docs/ref/#view.EditorView^scrollHandler) | 官方文档确证 |
| 11 | 若要让光标行「始终居中」，官方语义上的组合是 `scrollIntoView(sel, {y: "center"})` + 在 `updateListener` 中触发；`scrollPastEnd()` 保证末行也能居中/置顶 | [ref scrollIntoView](https://codemirror.net/docs/ref/#view.EditorView^scrollIntoView)、[ref scrollPastEnd](https://codemirror.net/docs/ref/#view.scrollPastEnd) | 官方文档确证（组合方式为推论） |
| 12 | 出现 `Measure loop restarted more than 5 times` / `Viewport failed to stabilize` 时，几乎总意味着**装饰高度不稳定**（异步渲染、估计高度严重失准、或 CSS 与高度图脱节） | 本机源码 `index.js:8208-8213` + [issue 761](https://github.com/codemirror/dev/issues/761) | 官方源码或 issue |

**关于「隐藏 Markdown 语法」的官方态度补充**：CM6 维护者明确表示这是**使用者自己构建的模式**，编辑器不内置：

> “Some systems like this show the marks as text again when the cursor is on/near them.”

https://discuss.codemirror.net/t/hide-markdown-syntax/7602 【官方源码或 issue（维护者回复）】
→ 即：**「光标行显示源码、其他行显示渲染」不是 CM6 的内置能力，是使用方自建的模式，其稳定性由使用方负责。**

---

# B. 同侪产品

每个产品回答：单一渲染态原地编辑，还是源码态↔渲染态切换？切换触发条件？如何避免位置跳动？

## B1. Obsidian Live Preview（同样基于 CodeMirror 6 —— 最直接的同类）

### 编辑模型：**双视图 + 双模式**，Live Preview 内部是「光标触发的局部源码↔渲染切换」

**官方文档确证**（Obsidian 官方帮助文档）：

> “Obsidian lets you customize how to edit and preview notes with Markdown syntax using _editor views_ and _editor modes_.”
> **Editor views**：Editing view ↔ Reading view，切换方式为右上角图标或 `Ctrl/Cmd+E`。
> **Editor modes**（在 Editing view 内）：
> - **Live Preview**：“Live Preview is a smart editor mode that previews Markdown-formatted text while you're editing. **You can reveal the syntax for any Markdown-formatted text by moving the text cursor to it.**”
> - **Source mode**：“Source mode displays the Markdown syntax for the entire note.”
> 默认模式在 **Settings → Editor → Default editing mode**。

- 官方页面：https://obsidian.md/help/edit-and-read （页面为 SPA，正文需 JS；同一文档的纯文本源：https://huggingface.co/spaces/anpigon/obsidian-qa-bot/raw/main/docs/obsidian-help/Editing%20and%20formatting/Edit%20and%20preview%20Markdown.md ）
- 本地对应文件：`docs/obsidian-help/Editing and formatting/Edit and preview Markdown.md`（该镜像为社区维护的官方帮助文档抓取）

**标签**：【官方文档确证】

### 回答「它怎么处理光标行显示源码、其他行显示渲染」

**官方原话就是答案**：语法**按光标位置局部显隐**（“reveal the syntax … by moving the text cursor to it”）。这与 Opennote 的「光标所在行显示、其他行隐藏」是**同一类设计**。
**标签**：【官方文档确证】

⚠️ 重要区分：**Obsidian 并未把这一行为描述为「稳定」或「无跳动」，官方文档完全没提位置稳定性**。也就是说，**Live Preview 的局部显隐是产品选择，不是 CM6 提供的稳定机制**。**标签**：【官方文档确证（关于「未提及」）】

### 表格在 Live Preview 里是原地编辑还是切源码？

**【未找到】**：Obsidian 官方帮助文档中**没有**关于「Live Preview 下表格如何编辑」的明确说明。官方 Advanced formatting syntax 只描述表格**语法**（`|` 与 `-`、列对齐冒号、表格内的 wikilink/嵌入需要转义 `\|`），未描述编辑态渲染行为。
- https://huggingface.co/spaces/anpigon/obsidian-qa-bot/raw/main/docs/obsidian-help/Editing%20and%20formatting/Advanced%20formatting%20syntax.md
- 相关官方文档（Table Editor 概念）见 Zettlr，非 Obsidian。
→ 不臆测。

### 嵌入图片 `![[...]]` 异步加载怎么避免跳动？有没有 placeholder / 尺寸预留机制？

**【未找到】官方说明。** Obsidian 官方帮助文档未描述嵌入图片的尺寸预留或占位机制。**不臆测。**

但**有强力的官方论坛证据表明这正是 Obsidian 的痛点所在**（见下）。

### 已知 layout shift / scroll jump 问题与官方修复

**Obsidian 官方论坛 Bug 报告（含 Obsidian 员工参与、确认、修复）**：
标题：`Scrolling unusable when document has transclusions - large jumps, up/down and infinite jump loops with (Viewport failed to stabilize, Measure loop restarted more than 5 times)`

关键事实（逐条，均为论坛一手内容）：
- 版本 `1.12.5` 出现：滚动跳几百到几千行；点击标题跳；点击搜索结果跳。
- 控制台出现 **CM6 自己的告警字符串**：
  - `app.js:1 Measure loop restarted more than 5 times`
  - `Viewport failed to stabilize`
  - `Uncaught TypeError: Cannot read properties of null (reading 'length') at e.scanTile … at e.posAtCoords … at e.posAtMouse`
- 报告者定位：**由 embeds / transclusions 引起**（“it seems to be caused by embeds ![]. They are mostly images but also transclusions”）。
- 报告者的自救 CSS 尝试（**含 `overflow-anchor: none`**）：
  ```css
  .internal-embed, .markdown-source-view.mod-cm6 .cm-embed-block, .markdown-source-view.mod-cm6 img { display: none !important; }
  .cm-scroller { overflow-anchor: none !important; }
  ```
- 报告者推测：“Based on how it jumps both up and down, it looks like those are the effect of calculations resulting from **asynchronous rendering**. So scrolling gets pushed up/down based on how these async renderings finish.”
- **Obsidian 员工 `WhiteNoise`**：“I can reproduce your problem. I am investigating where the regression happened.”
- 回归范围：报告者实测 **`1.12.4` 不复现，`1.12.5` 复现**（downgrade 验证）。
- **官方修复承诺**：`WhiteNoise`：“will be fixed 1.12.7”。
- 官方 changelog 对应条目：`2026-03-18 desktop v1.12.6` — “Fixed some regressions with the editor introduced in 1.12.4”（https://obsidian.md/changelog/2026-03-18-desktop-v1.12.6/ ）。
- 后续：报告者 `2026-05-28` 称 **`1.13.0` 又回来了，而且更糟**（“This is back in 1.13.0 and it's worse.”）。
- 另有用户（`https.em`）报告：**只有 1500 词、纯 Markdown 的文档，Live Preview 滚动时滚动条持续抖动、尺寸不断变化**。

→ 来源：https://forum.obsidian.md/t/scrolling-unusable-when-document-has-transclusions-large-jumps-up-down-and-infinite-jump-loops-with-viewport-failed-to-stabilize-measure-loop-restarted-more-than-5-times/112103
**标签**：员工复现与修复承诺为【官方源码或 issue】；用户定位与推测为【社区共识】。

### 对 Opennote 的启示（B1）

**这是本次调研最有价值的一条同侪证据**：一个由 CM6 作者本人参与、基于 CM6 的成熟商业产品，在「异步渲染的嵌入块 + 局部源码显隐」这个组合上**反复出现与 Opennote 完全同类的跳动**，且表现为**版本回归**（1.12.4 好 / 1.12.5 坏 / 1.12.7 修好 / 1.13.0 又坏）。
→ 说明：**这不是「写法不够聪明」，而是该架构本身的固有风险区**；缓解手段是工程纪律（A6 清单）+ 回归测试，而非一次性修复。

---

## B2. MarkText（Electron + 自研 Muya 块编辑器）

### 编辑模型：**默认单一渲染态原地编辑（实时预览），另有一个全局「源码编辑器」切换**

**官方文档（MarkText 仓库 `docs/BASICS.md`）确证**：

> “Mark Text is a **realtime preview editor** for markdown with various markdown extensions. You can simply write and edit text and **Mark Text hides all unnecessary syntax elements**.”
> **Switch between editor modes**：“You can use `CmdOrCtrl+Alt+S` to switch between the **preview** and **source-code editor**. The **realtime preview editor is the default** editor with many features.”

→ 即：**日常编辑是单一渲染态原地编辑**；源码态是**用户显式触发的整篇切换**（`Cmd/Ctrl+Alt+S`），**不是**「光标移到某行才变源码」。
→ 来源（本次实际读取的镜像）：https://raw.githubusercontent.com/krbarker/marktext/develop/docs/BASICS.md ；上游对应路径 `marktext/marktext` → `docs/BASICS.md`。
**标签**：【官方文档确证】

### 块如何切换源码/渲染？

**官方源码（Muya README）确证**——Muya 是 **JSON 状态 + 虚拟 DOM** 架构，不是「按块切换源码/渲染」：

> - “**JSON state model** built on `ot-json1` / `ot-text-unicode` — wire it up to your own transport for collaborative editing.”
> - 架构：
>   ```
>   Muya
>   ├── EventCenter      custom pub/sub for editor-internal + user events
>   ├── Editor           owns runtime modules and routes DOM events
>   │   ├── JSONState    ot-json1 document, source of truth
>   │   ├── InlineRenderer custom lexer + snabbdom virtual DOM
>   │   ├── Selection    live selection bridged to the JSON path
>   │   ├── Search       regex search + highlight overlay
>   │   ├── Clipboard    paste/copy bridging via turndown / marked
>   │   ├── History      OT-aware undo/redo stack
>   │   └── ScrollPage   root block of the tree
>   ```
> - “The block tree under `ScrollPage` is built from `TreeNode → Parent → (Content | Format)`. Each concrete block lives in `packages/core/src/block/{commonMark,gfm,extra,content}/`.”

→ 解读：**块是持久存在的渲染单元**（contenteditable + snabbdom 虚拟 DOM 差分更新），**不存在「把整块换成 widget、光标进入再换回源码」的往返**。这是它比「装饰替换」路线更稳定的结构性原因。
→ 来源：https://github.com/marktext/muya/blob/master/README.md 【官方源码或 issue】
（注：Muya 仓库已迁移至 `marktext/marktext` monorepo，README 顶部有迁移公告。）

### 如何避免位置跳动？有无 block virtualization / scroll anchoring / 占位尺寸？

- **有 `ScrollPage` 作为块树根节点**（官方 README），说明其滚动是按块树组织的。
- **未找到**官方关于「块虚拟化」「scroll anchoring」「占位尺寸」的说明或源码注释 → **【未找到】**，不臆测。
- **未找到** MarkText/Muya 官方关于 scroll jump / layout shift 的专门 issue 结论 → **【未找到】**。

### 对 Opennote 的启示（B2）

Muya 路线（**持久块 + 虚拟 DOM 差分 + 无源码↔渲染往返**）从根上回避了 Opennote 当前的跳动来源。但它是**自研编辑器内核**，与 CM6 不可直接互换；**不建议照搬**，可作为「为什么块编辑器天生不跳」的机理参照（见 B4）。

---

## B3. Milkdown / Crepe（ProseMirror 系 WYSIWYG markdown）

### 编辑模型：**单一渲染态**（ProseMirror 文档模型），markdown 只是序列化格式

**官方文档确证**：

> “Milkdown is a powerful **WYSIWYG markdown editor** …”
> “**Reliable** — Built on top of [prosemirror](https://prosemirror.net/) and [remark](https://github.com/remarkjs/remark)”
> “Milkdown consists of two main parts: **Core Package** (`@milkdown/core`) … **Additional Plugins** …”
> “Milkdown is a browser library…”
> 技术栈：“Prosemirror — A toolkit for building rich-text editors on the web / Remark — Markdown parser done right”

- https://milkdown.dev/docs/guide/getting-started
- 纯文本源：https://raw.githubusercontent.com/Milkdown/website/main/docs/guide/getting-started.md

**标签**：【官方文档确证】

### 为什么它不会有源码↔渲染切换的跳动？

**官方文档没有直接解释这一点** → 该「为什么」的表述属于**推论**，不标为官方。

但可由官方架构事实推出机理（标注为**推论，基于官方文档所述架构**）：
1. **唯一真相是 ProseMirror 文档树**，Markdown 只用于 `defaultValue` 输入与（经 remark）序列化输出；编辑过程中**不存在「源码字符串」这个并行状态**。
2. 因此没有「显示源码 / 显示渲染」的切换，也就**没有切换瞬间的高度突变**。
3. 表格、代码块等以 ProseMirror node 的形式存在于同一文档树中（官方 features 列表列出 “📊 Table — Table support with fluent ui, via table plugin”、“🧮 Math — LaTeX math equations support via math plugin”），**原地编辑而非替换**。

→ 标签：架构事实为【官方文档确证】；「因此不跳动」为【推论】。

### 是否使用 node view / decoration？有无关于位置稳定性的官方说明？

- 官方文档页面列出了插件体系与 features，但**未找到**关于「node view vs decoration」或「位置稳定性」的官方说明 → **【未找到】**。
- 未找到官方关于 scroll jump / layout shift 的专门说明 → **【未找到】**。

### 对 Opennote 的启示（B3）

**「单一渲染态」是消除跳动的根本解**，但它要求放弃「Markdown 源码是唯一真相」。Milkdown 的代价是：文档模型不再是纯文本，需要 round-trip 序列化（可能损失格式）。Opennote 若坚持 Typora 风格（源码即真相），就**无法**通过换库获得这个解，只能走 CM6 的约束路线。

---

## B4. Bear / Craft / Notion —— 块编辑器为什么「天生不跳」？

### Notion

**官方工程博客确证**（Notion 官方 Tech 博客，2021-05-18，作者 Jake Teton-Landis, Engineering）：

> “Everything you see in Notion is a block. Text, images, lists, a row in a database, even pages themselves—these are all blocks, dynamic units of information that can be transformed into other block types or moved freely within Notion.”
> 每个 block 的属性：**ID**（UUID v4）、**Properties**（如 `title`）、**Type**、**Content**（子 block ID 有序数组）、**Parent**。
> “The block type is what specifies how the block is rendered in Notion's UI—and depending on that type, we interpret the block's properties and content differently.”
> “Each block defines the position and order in which its content blocks are rendered. We call this hierarchical relationship … the '**render tree**'.”
> “Changing the type of a block doesn't change the block's properties or content—it only changes the type attribute. The information is just rendered differently…”

- https://www.notion.com/blog/data-model-behind-notion

**标签**：【官方文档确证】

**为什么天生不跳（基于官方模型的机理说明，标注为推论）**：
- 块的 **Type 是持久状态**，不是「光标进入才切换的临时状态」。因此**不存在「渲染态 ↔ 源码态」的往返**，也就没有往返带来的高度突变。
- 「Turn into」是**用户显式操作**，不是光标移动的副作用。
- 块高度在正常编辑下是单调、可预测的（文字增删），异步资源（图片）以**块**为单位，而非嵌在文本流中的装饰。

⚠️ **官方博客未讨论滚动位置保持或 layout shift** → 关于「如何避免跳动」的官方说明为 **【未找到】**。

### Craft

**官方帮助文档确证**：

> “Craft uses a unique **block-based structure** … In Craft, everything you create is a block. Every paragraph, image, table, or heading is its own independent unit.”
> “Each block can: Contain its own content (text, media, tables, etc.) / Be styled independently / Be moved, copied, or deleted on its own / Transform into a page with deeper content”
> “A **block** is a single unit of content / A **page** is a block that contains other blocks inside it / A **document** is the top-level container”

- https://support.craft.do/en/write-and-edit/blocks-and-pages

**标签**：【官方文档确证】
**未找到** Craft 官方关于滚动位置保持 / layout shift 的说明 → **【未找到】**。

### Bear

**官方 FAQ 确证**——关键发现：**Bear 的 markdown 标记显隐是「全局开关」，不是「按光标位置」**：

> “You can choose to **hide or show Markdown style characters** by toggling the **Hide Markdown** option in Bear's `Settings > General` preferences panel.”
> “Apps like Bear that support Markdown can **display this formatting while still working with your notes as plain text**. This duality, of sorts, has a number of advantages…”
> “To be specific, Bear uses **CommonMark**…”

- https://bear.app/faq/how-to-use-markdown-in-bear/

**标签**：【官方文档确证】

**这是对 Opennote 极其重要的对照**：Bear 同样「源码即真相 + 渲染显示」，但它**不把标记显隐绑定到光标位置**——而是让用户在设置里**全局选择**「Hide Markdown」开或关。
→ 全局开关**只会在切换时改变一次布局**，而「光标行显隐」会在**每次光标移动时**触发局部重排。这是两种完全不同的跳动风险等级。

**未找到** Bear 官方关于滚动位置保持 / layout shift 的说明 → **【未找到】**。

### B4 小结（为什么块编辑器天生不跳）

综合上述**官方模型**，机理可归纳为（机理表述为推论，架构事实均有官方来源）：

| 机理 | 官方依据 |
| --- | --- |
| 块的「类型/渲染态」是**持久状态**，不随光标位置改变 | Notion 官方博客（Type 属性）；Craft 官方（block 独立单元） |
| 因此**不存在源码态↔渲染态的往返**，没有往返带来的高度突变 | 同上（推论） |
| 标记显隐若是需要，采用**全局开关**而非按光标位置 | Bear 官方 FAQ（Hide Markdown） |
| 异步资源（图片）以**块**为单位，而非文本流中的装饰 | Notion 官方（block 为最小单位）（推论） |

---

## B5. Zettlr / iA Writer / Ulysses —— typewriter mode 的官方定义与光标位置档位

### Zettlr

**编辑模型（官方文档确证）**：**单一渲染态原地编辑**，渲染/源码是**全局开关**：

> “Zettlr is, first and foremost, a Markdown editor… It offers a **fully WYSIWYG view**, while at the same time allowing you to define block elements by simply typing in the corresponding syntax elements.”
> “Many apps will provide a separate pane… Some apps, however, will **render the Markdown in-place. Zettlr does the latter**.”
> 设置项 **Markdown rendering**：在 **WYSIWYG**（“preview”）与 **WYSIWYM**（“raw”）之间二选一；选 preview 后可再**逐类**勾选哪些元素预渲染（例如「只渲染图片和链接，不渲染引用」）。
> 也可通过状态栏的 “Rendering” 项即时切换。
> 表格：**Table Editor** 设置 —— “Turn on to render Markdown tables using actual table elements. This setting is also controled by the rendering mode (tables will not be rendered if you switch to 'raw').”

- https://docs.zettlr.com/en/editor/appearance.html
- https://docs.zettlr.com/en/reference/settings.html

**标签**：【官方文档确证】

**⚠️ 官方对「原地渲染为何不能做到位」的坦诚说明（高度相关）**：

> “Even the preview rendering mode is **only an approximation** of how your document will look like when you export it… The second reason is that **you still need to be able to edit the file. If we were to produce a truthful representation of the Markdown document in an exported state, we would also need to sometimes collapse linebreaks, move elements around, and so on. We can't do this without introducing the risk of potential data loss or other glitches.**”

→ 这是官方**明确承认**：「为了可编辑性，渲染必须是不完全的，否则会引入数据损失或 glitch」。可作为 Opennote 设计取舍的官方背书。
**标签**：【官方文档确证】

**typewriter mode 的官方定义与档位**：**未找到**。
Zettlr 官方文档的编辑器小节（`/en/editor/`：Introduction / Appearance / Search / Autocomplete / Citations / Cross-References / Comments / Status Bar / Table Editor / Text Transforms / Snippets）与设置参考（`/en/reference/settings.html`）中**均未出现 "typewriter mode"**。设置中与光标/专注相关的是 **Distraction-free mode**（“You can **mute non-focused lines**, and hide the toolbar in the distraction-free mode.”）。
→ **【未找到】** 官方 typewriter mode 定义与档位；不臆测其档位。

### iA Writer —— **有官方定义，且有官方承认的「跳动」副作用**

**官方 Support 文档确证**（Focus Mode）：

> “Focus mode for Mac emphasizes the active sentence or paragraph while eliminating distractions…”
> 三种设置：**Sentence** / **Paragraph** / **Typewriter**
> **Typewriter**：“Unlike the two previous options, the text will not be highlighted or dimmed in this mode. **The cursor remains vertically centered in the Editor when typing or moving up or down in your document.** The experience is similar to what you would have with a mechanical typewriter.”

**光标位置档位**：官方仅定义 **Typewriter = 垂直居中**（1 档）；Sentence / Paragraph 是**高亮范围**档位，不是光标位置档位。

**⚠️ 官方明确承认 typewriter mode 会导致跳动**（小节标题即 “Jumping Screen When Editing?”）：

> “Focus Mode is meant to be used during the writing/ creation phase and for the best experience we recommend **toggling it off during any editing phases**. **A conflict between the area you will select to edit and Focus Mode's attempt to vertically center the cursor might result in the screen jumping vertically.**”

- https://ia.net/writer/support/editor/focus-mode

**标签**：【官方文档确证】

→ **对 Opennote 的直接启示**：**「让光标居中」这一机制本身就会造成垂直跳动**，iA Writer 的官方对策不是「消除跳动」，而是**建议在编辑阶段关闭该模式**。这说明「位置绝对稳定」与「光标居中」在交互上是**互相冲突的目标**，必须显式取舍。

### Ulysses

**typewriter mode 官方定义与档位：本次调研未能取得一手内容。**
- 官方存在该主题页面：https://media.ulysses.app/typewriter-mode/ ，标题为 **“For Better Focus: Typewriter Mode, Revamped”**（Ulysses 官方 `media.ulysses.app` 域）。但**多次抓取该 URL 均失败（网络层 `fetch failed`）**，故**不引用其正文**。
- Ulysses 帮助中心为 https://help.ulysses.app/ ，其文章路径不含 `typewriter-mode`（`/dive-into-editing/typewriter-mode` 与 `/en_US/dive-into-editing/typewriter-mode` 均返回 404）。
→ **【未找到】** 可验证的一手正文。**不臆测其档位或防跳动机制。**

### B5 小结

| 产品 | typewriter / 专注模式官方定义 | 光标档位 | 是否讨论防跳动 |
| --- | --- | --- | --- |
| **Zettlr** | 【未找到】（官方仅记载 Distraction-free mode，可 mute 非焦点行） | 【未找到】 | 【未找到】 |
| **iA Writer** | 【官方文档确证】Typewriter = 光标垂直居中 | 1 档（居中）；另有 Sentence / Paragraph 高亮档 | ✅ **官方承认会造成垂直跳动，建议编辑时关闭** |
| **Ulysses** | 【未找到】（官方页面存在但正文抓取失败） | 【未找到】 | 【未找到】 |

---

# C. CM6 里被官方支持的稳定做法清单

> 以下每条的「官方支持」依据均为 CM6 官方文档 / 源码 / 官方 changelog / 维护者回复，已在上文标注。

## C1. 硬性规则（违反会抛错或被忽略）

1. **块级 widget 与跨行 replace 装饰，只能由 `StateField` 直接提供**（`EditorView.decorations.from(field)`），**不能**由 `ViewPlugin` 或函数式 decorations 提供。违反时 CM6 抛 `RangeError("Block decorations may not be specified via plugins")` / `RangeError("Decorations that replace line breaks may not be specified via plugins")`。
2. **不要用 CSS `display: none` 隐藏 `.cm-line`。** 官方无明文禁令，但 CM6 用 `getBoundingClientRect().height` 实测行高并据此构建 `heightMap`；`display: none` 会让该行高度记为 0，破坏 `posAtCoords` / `moveVertically` / 文档总高，且官方在 `6.43.1` 修过「`display: none` 内容行导致崩溃」。
3. **装饰类型各自的长度约束**（源码硬校验）：mark 装饰不可为空；line 装饰范围必须零长度；widget 装饰范围必须零长度；replace 装饰范围必须合法。
4. **块级装饰不要设垂直 margin。**
5. **不要在 `ViewPlugin.update` / `docViewUpdate` 中读取 DOM 布局**；一律通过 `view.requestMeasure({read, write})` 排入读/写两阶段。

## C2. 高度与滚动稳定性

6. **隐藏一行（含换行）的正规做法 = `StateField` 中的 `Decoration.replace({widget})`**，范围覆盖该行（含行尾换行符）——即官方折叠（folding）的实现方式（`@codemirror/language` 的 `foldState`）。
7. **大块 widget 必须实现 `WidgetType.estimatedHeight` 与 `WidgetType.coordsAt`**；估计值越接近真实高度，跳动越小。这是 CM 作者在官方论坛给出的关键答复。
8. **块级 widget 高度在首次渲染后变化（图片 `onload`、KaTeX、mermaid 完成）时，写入 DOM 后调用 `view.requestMeasure()`。** 官方文档明确要求。
9. **理解 CM6 自带的滚动补偿及其 4 个前提**：位移 > 1px；非 iOS 惯性滚动；滚动容器为 `.cm-scroller` 或有焦点或 100ms 内有 wheel/touch；且用户未在两次 measure 之间自己滚动过。**任何一条不满足，CM6 就不会补偿**，跳动会直接暴露给用户。
10. **`.cm-scroller` 上 CM6 已内置 `overflow-anchor: none`**（官方为规避 Chrome 错误滚动而加）。若你的滚动容器是父级，需评估父级原生 scroll anchoring 与 CM6 补偿**叠加**的风险（官方 changelog `6.13.2` 记录过「Chrome 原生做了、我们又补偿一次」的 bug 类别）。
11. **`Measure loop restarted more than 5 times` / `Viewport failed to stabilize` 是高度不稳定的诊断信号**，而不是可忽略的噪音。
12. **父级滚动容器是被官方修过多次 bug 的路径**（`6.39.16`、`6.43.10`、issue #1673）。若可能，优先让 `.cm-scroller` 自己承担滚动。

## C3. 需要精确定位/滚动时使用的官方 API

13. `EditorView.scrollIntoView(pos|range, {y, x, yMargin, xMargin})` —— 唯一的官方「滚入视野」入口，支持 `"nearest" / "start" / "end" / "center"`。
14. `EditorView.scrollSnapshot()` —— 保存并恢复滚动位置（**只作用于编辑器自身滚动元素**，不含父级）。
15. `EditorView.cursorScrollMargin` —— 光标与边缘的距离（默认 5px）。
16. `EditorView.scrollMargins` —— 声明「被覆盖因而不可见」的边距。
17. `EditorView.scrollHandler` —— 拦截/覆盖默认「滚入视野」行为（**不得在其中发起编辑器更新**）。
18. `scrollPastEnd()` —— 保证任意行可滚到顶部/居中。
19. `Decoration.line({class, attributes})` —— 给整行加样式（含行高）的官方途径，替代改 `display`。
20. `EditorView.updateListener` —— 在每次视图更新后统一处理位置/滚动决策。

## C4. 明确「官方不提供、由使用方负责」的部分

21. **「光标行显示源码、其他行显示渲染」不是 CM6 内置能力**，是使用方自建模式；维护者对此的原话是 “Some systems like this show the marks as text again when the cursor is on/near them.” —— 编辑器不为此提供稳定性保证。
22. **CM6 不提供「内容位置永不跳动」的保证**。它提供的是：高度图 + 滚动锚点补偿 + 一套必须遵守的装饰约束。**超出约束的部分，跳动是使用方的责任。**

---

# D. 对 Opennote 的直接启示

> 逐条对应任务背景中列出的 4 项可疑实现。**判定「是否被官方支持/推荐」，不改代码。**

## D1. `.cm-line { display: none }` 隐藏整行（Setext 下划线行、代码围栏行）

**判定：不被支持（事实层面），应替换。**

- 官方无明文禁令 → 不宣称「官方禁止」；但 **CM6 的几何体系建立在该行被真实渲染之上**，`display: none` 使其高度记为 0，破坏 `heightMap` / `posAtCoords` / `moveVertically` / 文档总高（证据见 A1）。
- **官方替代方案（推荐）**：在 `StateField` 中用 `Decoration.replace({widget})`，范围覆盖该行**含行尾换行符**，即官方 folding 的做法（`@codemirror/language` 的 `foldState` 就是如此）。若要「视觉上完全消失」，widget 可以是零高度占位（`WidgetType` 返回空元素，`estimatedHeight` 返回 0）。
- ⚠️ 特别注意：**Setext 标题的下划线行、代码围栏行**用 replace 隐藏后，**光标进入该行时的处理**必须显式设计——因为折叠（fold）在官方实现里会在**光标触达时自动展开**（`clearTouchedFolds`，`@codemirror/language/dist/index.js:1340-1342`）。Opennote 若想「隐藏但可编辑」，需要自己复刻这套「触达即展开」逻辑，且展开/收起本身**就是高度突变**，必须配合 A3 的补偿。

## D2. `Decoration.replace({})`（inline）隐藏 `**`、`#`、`>`，光标所在行显示

**判定：机制被支持；但「随光标位置反复显隐」是跳动的主要来源之一，且官方不为此提供稳定性保证。**

- 内联 replace 装饰本身完全合法且是官方推荐用法（官方 Decorations 示例即用 `Decoration.replace({widget})` 隐藏 `[[name]]`）。
- 但：
  - **它改变行宽**。CM6 有内置的水平宽度稳定化（`minWidth`/`minWidthFrom`/`minWidthTo`，见 A4 补充），能缓解水平滚动条抖动，但**不能阻止行内文字本身左右位移**——因为 `**` 确实占了宽度。
  - **「光标所在行显示」意味着每次光标上下移动都会触发一次该行的重排**。这与 iA Writer 官方承认的「光标居中与编辑区域选择冲突会导致屏幕垂直跳动」属于同一类交互冲突（见 B5）。
- **可参考的官方/同侪做法**：
  - **Bear**：把标记显隐做成**全局开关**（“Hide Markdown”），而非按光标位置 → 只在切换时改变一次布局（B4）。
  - **Zettlr**：全局 WYSIWYG/WYSIWYM 开关 + 逐类元素勾选（B5）。
  - **Obsidian Live Preview**：确实采用「光标触达即显源码」（官方文档原文），但**其滚动跳动问题在官方论坛反复出现并被员工确认为回归 bug**（B1）。
- **不改变结论的补充**：若必须保留光标行显隐（Typora 风格的核心体验），则应（a）让显隐只影响**行内**、绝不改变行高（用 `Decoration.line` 固定行高，或用 `line-height` 统一）；（b）对隐藏标记造成的宽度变化，接受水平位移为设计代价，并确保**垂直位置零变化**（这是可以做到的，也是关键）。

## D3. `Decoration.replace({ widget, block: true })` 整块替换（表格 / 公式 / mermaid），光标进入换回源码

**判定：机制被支持，但有两个硬性前提 + 一个固有风险。**

- **硬性前提 1**：必须由 `StateField` 提供。**若当前是在 `ViewPlugin` 里生成这些块装饰，CM6 会直接抛 `RangeError`**（A2）。→ **这是最值得立刻核对的一点。**
- **硬性前提 2**：块级 widget **不要设垂直 margin**；高度动态变化时**必须 `requestMeasure()`**（A2/A3）。
- **固有风险**：**「widget ↔ 源码」往返 = 高度突变**。CM6 的补偿只保证「视口上方高度变化时锚点块不动」，且只在 A3.4 的 4 个前提下生效。当**光标所在行自己**就是那个块时，编辑器还要额外把它滚入视野，两套动作叠加——这正是 issue #1673 / discuss 9372 / Obsidian 论坛所描述的现象。
- **必须做的加固**：
  1. 块级 widget **实现 `estimatedHeight`**，让估计高度尽量接近真实渲染高度（Marijn：估计偏差越大跳动越剧烈）。
  2. 块级 widget **实现 `coordsAt`**，让块内任意位置都有正确坐标（否则光标在块内移动时编辑器会跳向块的起止端）。
  3. **对称设计**：如果 widget 的高度与源码文本高度差异巨大，考虑让 widget 使用**固定高度 + 内部滚动**（height 稳定），而不是让高度随内容自由变化。

## D4. widget 内部异步渲染完成后调 `view.requestMeasure()`

**判定：完全正确，且是官方要求。但它是必要不充分条件。**

- 官方文档要求：块级装饰高度动态变化时**必须** `requestMeasure`（A3.1）。
- 官方 changelog：`6.7.0` 起 CM6 会「注意到 widget 高度变化并自动调整高度信息」（A3.3）——但**不要依赖它**，主动调用是官方文档的明确要求。
- **不充分的原因**：`requestMeasure` 只更新**高度信息**；是否补偿滚动由 A3.4 的 4 个前提决定。因此：
  - 若 Opennote 使用**父级滚动容器**，补偿路径历史上 bug 密集（issue #1673），且**父级的浏览器原生 `overflow-anchor` 仍在生效**，会与 CM6 补偿叠加。
  - 若异步渲染发生在**视口内**（不是视口上方），CM6 的锚点补偿**不会**介入（锚点只看 scrollOffset 处的块），此时高度变化**必然**推动下方内容——这是无法用 `requestMeasure` 解决的物理事实。
- **建议**：把异步内容的高度在**渲染前**就确定下来（图片预留宽高比占位、KaTeX/mermaid 给出 `estimatedHeight`），让「异步完成」不改变高度，从根上消除这一类跳动。

## D5. 综合判定表

| Opennote 现有做法 | 官方是否支持/推荐 | 风险等级 | 官方替代/加固 |
| --- | --- | --- | --- |
| `.cm-line { display: none }` | ❌ 事实不支持（无明文禁令，但破坏几何体系） | **高** | `StateField` + `Decoration.replace`（含换行），即 folding 模式 |
| inline `Decoration.replace({})` 隐藏标记 | ✅ 机制支持 | **中**（跳动主要来源之一） | 保证不改变行高；或改为全局开关（参考 Bear / Zettlr） |
| `Decoration.replace({widget, block:true})` 整块替换 | ⚠️ 支持，**但必须由 StateField 提供、不得设垂直 margin** | **中–高**（取决于是否满足前提） | 核对是否 StateField；补 `estimatedHeight` + `coordsAt`；固定高度 |
| 光标进入时换回源码 | ⚠️ 无官方机制保证 | **高**（高度往返突变） | 让往返两侧高度一致；或用 A3.4 前提确保补偿生效 |
| 异步渲染后 `view.requestMeasure()` | ✅ 官方要求 | — | 必要不充分；应改为**渲染前预留高度** |
| （隐含）父级滚动容器 | ⚠️ 官方修过多次 bug 的路径 | **高（本次调研新发现）** | 评估改为 `.cm-scroller` 自身滚动；或在父级也设 `overflow-anchor: none` 并做回归测试 |

## D6. 本次调研识别的三个「最高优先级排查点」

1. **这些块级 `Decoration.replace({block:true})` 是否来自 `ViewPlugin`？** 若是，CM6 会抛 `RangeError`（源码硬校验）。必须改为 `StateField`。
2. **滚动容器是 `.cm-scroller` 还是父级？** 父级路径是官方 bug 高发区（issue #1673、discuss 9603），且父级的原生 `overflow-anchor` 未被子级 CSS 关闭，会与 CM6 补偿叠加。
3. **块级 widget 是否实现了 `estimatedHeight` 与 `coordsAt`？** 未实现时，大块 widget（表格 / mermaid）的跳动几乎不可避免——这是 CM 作者在官方论坛亲自指出的关键。

---

## 附：主要来源索引

**CodeMirror 6（官方）**
- Ref 文档：https://codemirror.net/docs/ref/
- Decorations 示例：https://codemirror.net/examples/decoration/
- `overflow-anchor: none` 提交：https://github.com/codemirror/view/commit/71ef7556ad072a7e3150384cff066309a3c961af
- 本机源码：`node_modules/@codemirror/view/dist/index.js`（6.43.13）、`index.d.ts`、`CHANGELOG.md`；`node_modules/@codemirror/language/dist/index.js`（6.12.4）

**CodeMirror 论坛 / issue**
- https://discuss.codemirror.net/t/why-delete-line-makes-parent-element-scroll/8524
- https://discuss.codemirror.net/t/unwanted-programmatic-scrolling-with-large-widgets/9372
- https://discuss.codemirror.net/t/hiding-replacing-lines-that-begin-with-a-certain-signifier/4473
- https://discuss.codemirror.net/t/hide-markdown-syntax/7602
- https://discuss.codemirror.net/t/on-scrolling-with-parent-and-content-loading-on-scroll/9603
- https://github.com/codemirror/dev/issues/1673 （父级滚动容器下首次点击视口上跳，6.39.x 回归）
- https://github.com/codemirror/dev/issues/761 （块 widget 高度计算）
- https://github.com/codemirror/dev/issues/952 、 https://github.com/codemirror/dev/issues/957 （`display: none` 初始化异常与滚动跳）
- https://github.com/codemirror/dev/issues/953 （换行下滚动文字抖动）
- https://github.com/codemirror/dev/issues/1639 （行 padding 导致点选错位）
- https://github.com/codemirror/dev/issues/1089 （大文档滚动跳动）

**同侪产品**
- Obsidian 帮助（编辑视图与模式）：https://obsidian.md/help/edit-and-read
- Obsidian 论坛（滚动跳动 bug 报告 + 员工确认 + 修复版本）：https://forum.obsidian.md/t/scrolling-unusable-when-document-has-transclusions-large-jumps-up-down-and-infinite-jump-loops-with-viewport-failed-to-stabilize-measure-loop-restarted-more-than-5-times/112103
- Obsidian changelog：https://obsidian.md/changelog/2026-03-18-desktop-v1.12.6/
- MarkText 文档：https://raw.githubusercontent.com/krbarker/marktext/develop/docs/BASICS.md （上游 `marktext/marktext` → `docs/BASICS.md`）
- Muya 架构：https://github.com/marktext/muya/blob/master/README.md
- Milkdown：https://milkdown.dev/docs/guide/getting-started ／ https://raw.githubusercontent.com/Milkdown/website/main/docs/guide/getting-started.md
- Notion 官方工程博客：https://www.notion.com/blog/data-model-behind-notion
- Craft 帮助：https://support.craft.do/en/write-and-edit/blocks-and-pages
- Bear FAQ：https://bear.app/faq/how-to-use-markdown-in-bear/
- Zettlr 文档：https://docs.zettlr.com/en/editor/appearance.html ／ https://docs.zettlr.com/en/reference/settings.html
- iA Writer 支持：https://ia.net/writer/support/editor/focus-mode
- Ulysses 帮助中心：https://help.ulysses.app/ （typewriter mode 正文抓取失败，标记为未找到）
