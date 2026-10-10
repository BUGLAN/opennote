# R1｜Typora 在「编辑时内容位置/布局跳动」上的具体工程决策

> 主题：Typora（typora.io）如何规避 hybrid view 下的 layout shift / cursor jump / scroll jump。
> 目的：为 Opennote（Typora 风格 Markdown 笔记本，纯前端 + CodeMirror 6）判定「光标所在行的 markdown 标记显隐」「块级内容渲染态↔源码态切换」这两类高度突变，哪些是 Typora 真正做过的工程决策、哪些是它至今没解决的遗留缺陷。
>
> **本文档只做事实认定，不做代码修改。** 所有结论标注来源 URL 与可信度标签。

---

## 0. 可信度标签与调研边界

| 标签 | 含义 |
| --- | --- |
| 【官方文档确证】 | `support.typora.io` / `typora.io` 官方文档、官方更新日志（What's New）原文可查 |
| 【官方开发者回复】 | Typora 作者 abnerlee 在官方 GitHub issue（`github.com/typora/typora-issues`）或官方文档中的本人表述 |
| 【用户观察】 | 用户提交的 issue / 复现视频 / 第三方文章，未经官方确认或官方仅表示「已收到」 |
| 【未找到】 | 明确未找到一手来源，不做推测 |

### 0.1 关于官方论坛 `forum.typora.io` —— 无法作为来源

任务要求优先抓取 `forum.typora.io`（尤其 abnerlee 的回复）。**本次调研确认该域名已不可用**：

- 权威 DNS（`dave.ns.cloudflare.com` / `dns.cloudflare.com`）对 `forum.typora.io` 的 A / AAAA / CNAME 查询均**只返回 SOA、无任何记录**（NXDOMAIN 语义），即该子域当前**不存在解析**。
- 本机 DNS 对 `forum.typora.io` 的解析结果指向 `31.13.88.26` / `2a03:2880:f11a:83:face:b00c:0:25de`（Facebook/Meta 网段），属**DNS 污染**，TLS 握手失败，不可用。
- `web.archive.org` 的 CDX 接口对该域名返回空结果，`/web/2023/https://forum.typora.io/` 返回 404，**未找到任何存档快照**。

**结论：【未找到】任何来自 `forum.typora.io` 的一手来源。** 因此本文中「官方开发者回复」一律改用**同等权威的替代渠道**：Typora 官方 issue 仓库 `github.com/typora/typora-issues` 中作者 **abnerlee** 本人的回复，以及官方支持站点 `support.typora.io` 正文。Typora 官方在 Quick Start 页面也把 GitHub issue 页列为官方反馈渠道：「We opened a Github issue page in case you want to start a discussion or as an alternative way to report bugs/suggestions」——<https://support.typora.io/Quick-Start/>。

---

## 1. 架构：是「渲染成 DOM 直接编辑」还是「源码 ↔ 预览双缓冲」？

### 结论

**是第一种，且官方明确拒绝第二种。** Typora 只有一份可编辑 DOM（hybrid view），不存在「源码视图 ↔ 渲染视图」双缓冲；`Ctrl+/` 的 Source Code Mode 是一个**独立的第二视图**，而不是渲染管线的一环。

### 证据

**（1）官方把编辑模型命名为 Live Preview，并明确「编辑的就是渲染结果」**【官方文档确证】

> **Typora** uses the feature: _Live Preview_, meaning that you can see inline styles as soon as you finish typing them and see block styles as you type or after you press the Enter key to focus on the next paragraph.
>
> **Note**: Markdown tags for inline styles, such as `**` will be hidden or displayed smartly. Markdown tags for block level styles, such as `###` or `- [x]` will be hidden once the block is rendered.

— <https://support.typora.io/Quick-Start/>

**（2）作者亲口定义「hybrid view」的存在理由**【官方开发者回复】

> We are less likely to implement the _pure_ WYSIWYG mode. **We implement the default hybrid view to save users from the traditional switching between source code and preview mode**, it will not be a good idea to introduce a new mode again.

— abnerlee，2018-03-15，<https://github.com/typora/typora-issues/issues/1317#issuecomment-373295532>

**（3）作者拒绝「左右分栏（源码+预览）」这一双缓冲思路**【官方开发者回复】

> We do not have plans to support a Side-by-side view like mou or macdown, **to make the hybrid view easy and good enough for users is our goal**

— abnerlee，引自 <https://github.com/typora/typora-issues/issues/4215>（该 issue 原文引用了 #70 中 abnerlee 的回复）

**（4）官方在仓库中用 `hybrid editing` 标签分类问题**【官方开发者回复】
`hybrid editing` 是官方 issue 仓库的一等标签，被贴在 #1317、#1313、#285、#1026、#233、#1316、#4100、#4215 等大量「渲染态 / 源码态切换」相关 issue 上。例如 <https://github.com/typora/typora-issues/issues/5375>（"Links cause layout shifting"）的标签就是 `hybrid editing`。

**（5）渲染后的 DOM 结构可从官方 CSS 文档反推**【官方文档确证】
官方在「Change Styles in Focus Mode」中给出了 Typora 编辑器内部的 DOM 类名约定，证明正文是一棵被赋予了语义类名的真实 DOM 树，而不是「一个 textarea + 一个 preview」：

> Please note that when focus mode is enabled, the `<body>` dom will have class `on-focus-mode`, and focused block level elements will have class `md-focus`.
>
> Blocks that can contain `md-focus` class are blocks that cannot contain children blocks and will contain a `md-end-block` class. For instance, `<blockquote>` can contain children blocks like `<p>`, so it does not have `md-end-block` class, while `h1` would have that class. `md-focus-container` class will apply to `li` which contains a `.md-focus` block.

— <https://support.typora.io/Change-Styles-in-Focus-Mode/>

**（6）表格 / 公式等块级内容内部仍嵌了 CodeMirror 实例**【官方文档确证 + 用户观察】
- 官方 CSS 文档直接暴露了内部选择器 `.md-fences.md-focus .CodeMirror-code>*:not(.CodeMirror-activeline) *`、`.CodeMirror.cm-s-inner:not(.CodeMirror-focused) *`、`#typora-source .CodeMirror-code`——说明**代码块、公式输入态、源码模式都是 CodeMirror 实例**（历史版本为 CodeMirror 5）。
  — <https://support.typora.io/Change-Styles-in-Focus-Mode/>
- 用户 issue 报告正文中出现的类名同样印证：`.md-focus`、`.md-end-block`、`.md-focus-container`、`.md-image`、`.md-diagram-panel-preview`。
  — <https://github.com/typora/typora-issues/issues/5308>、<https://support.typora.io/Draw-Diagrams-With-Markdown/>

### 切换触发条件

**没有「切换」这回事**——正文始终是可编辑渲染 DOM。真正的状态变化是**同一个块在「渲染态」与「源码态」之间就地切换**，触发条件是**光标/焦点进入该块**：

> Span elements will be parsed and rendered right after typing. **Moving the cursor to the middle of a span element will expand that element into the Markdown source.**

— <https://support.typora.io/Markdown-Reference/>（"Span Elements" 章首）【官方文档确证】

**这正好就是 Opennote 用户抱怨的根因，而 Typora 是「有意识地」这么做的**——见第 2 节。

---

## 2. 行内标记的显隐：光标进入块时，`#`、`>`、`**`、反引号显示还是隐藏？正文会不会水平位移？Typora 有没有补偿？

### 2.1 显示/隐藏规则（官方原文）

| 标记类型 | 光标/焦点**在**该块内 | 光标**不在**该块内 |
| --- | --- | --- |
| 行内样式标记（`**`、`*`、`` ` ``、`~~`、`$…$`、链接的 `[text](url)`） | **展开为 Markdown 源码**（"hidden or displayed smartly"） | 隐藏，只显示渲染样式 |
| 块级标记（`###`、`- [x]`、`>`） | 视偏好设置而定（见 2.3） | **隐藏**（"hidden once the block is rendered"） |
| 图片 `![](...)` | **点击图片即切换为 Markdown 源码** | 显示渲染后的图片 |

来源：
- 行内/块级规则：<https://support.typora.io/Quick-Start/>（Live Preview 段）【官方文档确证】
- span 展开规则：<https://support.typora.io/Markdown-Reference/>（"Moving the cursor to the middle of a span element will expand that element into the Markdown source"）【官方文档确证】
- 图片：<https://support.typora.io/Markdown-Reference/>（"You can modify the Markdown source code by clicking on the image."）【官方文档确证】

### 2.2 正文会不会水平位移？——**会，而且这是 Typora 公认未解决的缺陷**

**【用户观察 + 官方开发者已知悉，issue 至今 open】**

**核心证据 #1：链接自动展开导致整段重排、光标被冲走（issue 至今 open，标签 `hybrid editing`）**

> When caret is on a link, they expand automatically, to show the link text & url. **This greatly reduces usability. Obviously, urls can be very long and moves all text after** which make it much more difficult to quickly edit / review a document.
>
> Not only that, but **often it causes bugs in caret position getting shuffled.** For example, when url is long and caret is on a link, hitting down arrow (for next line) lands on text which then gets "compressed" back when link isn't focused anymore, **which resets caret position wrongly.** For example, instead of keeping horizontal position as expected:
> - line 1 column 10
> - line 2 column 10
> - line 3 column 10
>
> you'll have something like:
> - line 1 column 10 (assume line 1 has a link under column 10 with long url causing a line to be added automatically when link url is "expanded")
> - line 1 column 22
> - line 2 column 22
>
> **hence caret got moved from column 10 to 22 instead of remaining at column 10 like expected.**

— <https://github.com/typora/typora-issues/issues/1313>【用户观察】，abnerlee 在该 issue 中只表示「he may only wants to change the link editing style」（<https://github.com/typora/typora-issues/issues/1317#issuecomment-373295532>），**未承诺修复**；issue 状态至今 **open**。

**核心证据 #2：官方 issue 标题就叫「Links cause layout shifting」，标签 `hybrid editing`，至今 open**

> When clicking on links, layout shifts. … **I hope it does not shift.**

— <https://github.com/typora/typora-issues/issues/5375>【用户观察】，官方回复仅为「Possible to provide a sample md file?」（abnerlee，2022-08-23），**未修复，状态 open**。

**核心证据 #3：标记显隐造成的「文字到处跳」被用户明确归因**

> It's too annoying and distracting that **texts keep jumping around with all markups shown/hidden when I move the cursor.**

— 用户 cangyuyao，<https://github.com/typora/typora-issues/issues/1317>【用户观察】

> I think it's stressful that in preview mode while correcting a paragraph or simply moving the cursor hover it the rendering process shows the code for simple syntax as **bold**, _emphasis_ or mark. That is **increasingly detrimental as the paragraph goes longer: the focus change abruptly and the eyes must search the new visual position congruent with the cursor position.**

— 用户（ghost），<https://github.com/typora/typora-issues/issues/1317>【用户观察】

### 2.3 Typora 为此做了哪些补偿？——**只有「可关闭」和「样式保持」，没有几何补偿**

**（a）没有找到任何「预留宽度 / 绝对定位 / 不隐藏」的官方说明**【未找到】
通读 Quick Start、Markdown Reference、Focus Mode、Table Editing、Images、Code Fences、Math、Draw Diagrams 各官方页，**未找到任何一句提到为标记显隐做宽度预留、绝对定位或几何补偿**。相反，2.2 的 issue 证据表明**确实存在水平位移，且官方没有修复**。

**（b）Typora 的补偿是「提供偏好开关让用户关掉块级标记的源码显示」**【官方开发者回复 + 官方文档】

存在一个偏好设置（历史名称 `Display source for simple block on focus`，即「光标进入简单块（含标题）时显示其 Markdown 源码」）：

> When the `Display source for simple blocks on focus` preference is enabled, placing the cursor within headings correctly reveals markup as it for **bold**, *italic* and other marked-up text, but **unlike those, it does not maintain the rendered style (font size, underline, etc).**
> - **This results in disconcerting jumpy text and simply looks bad.**

— issue #285 正文（标题：`` `Display source for simple block on focus` should maintain style on focus ``），标签 `hybrid editing`，状态 **open**
— <https://github.com/typora/typora-issues/issues/285>【用户观察】

**这是本文最关键的一条间接证据**：它说明 Typora 在标题上「显示 `###` 源码」时**不会保持渲染样式**，因此 `#` 字符会真实占据行内空间并改变排版 → 用户感知为「跳」。该 issue 从 2018 年至今未修复。

**（c）作者明确拒绝「完全不显示标记（pure WYSIWYG）」这一根治方案**【官方开发者回复】

> I don't think user will do the switch between above two options when writing, instead, they will tweak the editor to behaviors they want, and then keep using it.
>
> **The pure WYSIWYG looks no enough merits to me**, a typical rich editor which user must modify styles by menubar or shortcut key is not good enough for typical markdown users.

— abnerlee，2018-03-17，<https://github.com/typora/typora-issues/issues/1317#issuecomment-373940788>

**（d）作者对「用户想要纯 WYSIWYG」的直接否认（决定了这个缺陷不会被修）**【官方开发者回复】

> Well, actually I'm not fully agree with this. Of course a Typora user prefer WYSIWYG, but **they also prefer Markdown**… This leading to **a mix of them, but not *pure* WYSIWYG**

— abnerlee，2018-03-30，<https://github.com/typora/typora-issues/issues/1317#issuecomment-377465999>

### 2.4 一个小型但相关的补偿：隐藏的 `<br>` 曾占位，已被官方修掉

> Although `<br/>` can be hidden but **it is occupying the space even when it is hidden.**

— 用户 szjiajin，<https://github.com/typora/typora-issues/issues/1026>【用户观察】

> It is already fixed for what @szjiajin describes, could you try newer versions?

— abnerlee，2021-03-16，<https://github.com/typora/typora-issues/issues/1026>【官方开发者回复】

**含义**：Typora 对「被隐藏的标记仍占几何空间」这类问题是**认账并会修**的。也就是说，Typora 的立场是「标记必须要么完全消失且不占空间，要么显示且占空间」，**不做「隐藏但仍占位」的宽度补偿**——这与 2.3(a) 的「未找到几何补偿」一致。

---

## 3. 表格：点击时保持渲染态原地编辑，还是切成 Markdown 源码？

### 结论

**保持渲染态、原地编辑单元格。** 官方文档从未提到点击表格会切到源码；相反，官方描述的是「渲染态 + 图形化工具栏 + 右键菜单 + 拖拽」的原地编辑模型。

### 证据【官方文档确证】

> Typora supports this with a graphical interface or by writing the source code directly. … **After a table is created, placing the focus on that table will open up a toolbar for the table where you can resize, align, or delete the table.** You can also use the context menu to copy and add/delete individual columns/rows.
>
> **The full syntax for tables is described below but it is not necessary to know the full syntax in detail as the Markdown source code for tables is generated automatically by Typora.**

— <https://support.typora.io/Markdown-Reference/>

> **Put the cursor inside a table and a table tooltip will show above the table header.** Click the far left icon and you will be able to resize the table.

— <https://support.typora.io/Table-Editing/>

> In Typora, you can simply change text alignment for a column by selecting the related alignment icon from the table tooltip… With alignment set, Typora will add an attribute like `style="text-align: left"` to the current column (`<td>`), but the final alignment can still be changed by CSS rules in the current theme or custom CSS.

— <https://support.typora.io/Table-Editing/>

**关键推论**：官方说「对齐属性被写到 `<td>` 的 `style` 上」，意味着**光标在表格里时，DOM 仍然是 `<table>/<td>` 的渲染态**（否则无处挂 `style`）；同时也说明**表格内部不像链接那样展开为源码**。这是与第 2 节行内标记行为的**显著差异**：Typora 对**块级结构（表格）选择保持渲染态**，对**行内 span（链接/加粗）选择展开源码**。

**一条反向的边界证据**：官方提供 `--` 表格内 `<br>` 的处理，且历史上 `<br>` 在表格单元格里被隐藏时仍占宽度、把列撑宽（见 2.4，2021 年已修）。这说明表格确实存在「隐藏标记占位 → 列宽/行高变化」的同类风险，官方选择的是「让隐藏标记不占位」而非「预留宽度」。

**未找到**：官方文档中没有任何一句明确写「点击表格单元格不会改变表格高度」。此点属于**由上述原文推断**，非官方明文。【未找到】直接的一手声明。

---

## 4. 图片：同步还是异步加载？有没有预留占位高度？官方怎么描述尺寸与缩放？

### 4.1 加载方式：**异步**（由两条用户 issue 反证），**未找到「预留占位高度」的任何官方机制**

**证据 A：远程图片异步加载会把页面顶到顶部/随机位置（issue 已 closed，但未给出根因说明）**

> **Typora keeps jumping to the top of the page, or other seemingly random places if you have multiple images from remote URL locations.**

— issue #3880「Mac OS X Version Scroll Jumping」，<https://github.com/typora/typora-issues/issues/3880>【用户观察】

**证据 B：图片尺寸不稳定 + 预览闪烁（官方确认并修复于 1.4.4）**

> **The size of inserted images are unstable frequently.** At that time, the preview shows with a flicker like an attached video.
> … It looks like this flicker occurs **at the time when images exist on the top of the preview area.**

— issue #5273「unstable images and preview flicker」，标签含 `images / resouces`、`fixed in dev`，<https://github.com/typora/typora-issues/issues/5273>【用户观察】
> fixed in 1.4.4

— abnerlee，2022-09-06，<https://github.com/typora/typora-issues/issues/5273>【官方开发者回复】

**证据 C：点击图片会让编辑器抖动/闪烁（issue 从 1.8.9 报起，2025-10-23 才 closed）**

> Mouse clicks on images cause the editor to jitter or flicker

— issue #5925，<https://github.com/typora/typora-issues/issues/5925>【用户观察】，closed 于 2025-10-23（**无官方修复说明**）

### 4.2 官方文档对「图片尺寸 / 缩放」的写法

**官方推荐的尺寸控制方式，全部依赖 HTML 属性或 CSS，而不是 Markdown 原生语法**【官方文档确证】：

> Typora allows you to use `<img>` tag for displaying images, which can also be used to adjust the size of images.
> For example, you could specify the `width` or `height` attribute of an `<img>` tag, or set the width/height in its `style` attribute:
>
> ```
> <img src="…" width="200px" />
> <!--or-->
> <img src="…" style="height:200px" />
> ```
> Another common use case is that when you insert a retina image, you need to scale it to a "correct" size. To do this, specify a `zoom` factor in its `style` attribute:
>
> ```
> <img src="…" style="zoom:50%" />
> ```
> **You can set other css properties in the `style` attribute: they will be ignored when you edit or preview by Typora**, but can affect the exported HTML or PDF.

— <https://support.typora.io/Resize-Image/>

**关键细节**：官方明说**除 `width`/`height`/`zoom` 之外的 CSS 属性在 Typora 编辑器内会被忽略**——意味着 Typora 只认这三个尺寸相关属性，**没有提供 `aspect-ratio` 这类现代占位方案**。【官方文档确证】

**图片插入后如何调整尺寸**【官方文档确证】：

> **Align images**: Currently Typora does not support image alignment. … Also, by default, if a paragraph only contains one image, it will be center aligned. It uses the following CSS:
> ```
> /* for editing */
> p .md-image:only-child { display: inline-block; width: 100%; }
> p > .md-image:only-child:not(.md-img-error) img { display: block; margin: auto; }
> ```

— <https://support.typora.io/Images/>

注意 `.md-image:only-child { display: inline-block; width: 100% }`：**图片容器被强制撑满行宽**，因此图片的最终高度完全取决于图片文件本身的宽高比 → **图片加载完成前后高度必然变化**，这正是「下方内容被推下去」的机制。

### 4.3 有没有 `width`/`height` 属性或 aspect-ratio 占位？

**【未找到】**官方文档中**没有任何**「图片加载前预留占位高度」的说明，也未找到任何官方 issue 承认并修复过此类问题。仅有：
- 官方明说 `style` 里除 `width`/`height`/`zoom` 外的属性在编辑器内**被忽略**（即 `aspect-ratio` 不会被用于编辑态布局）— <https://support.typora.io/Resize-Image/>
- 用户报告远程图片导致滚动跳到顶部 — <https://github.com/typora/typora-issues/issues/3880>【用户观察】

**结论：Typora 没有（至少没有公开证据表明有）图片占位高度机制。** 这是它与 Opennote 面临同一问题的证据，而不是可借鉴的解法。

---

## 5. 公式 / 图表：渲染同步还是异步？有占位吗？点击会塌成源码吗？

### 5.1 渲染引擎与触发方式【官方文档确证】

| 类型 | 引擎 | 触发语法 |
| --- | --- | --- |
| 数学（行内 / 块级） | **MathJax**（v0.11 起升级到 v3；1.13 起升级到 **v4**） | `$…$` / `$$…$$`（1.11 起可选 `\(…\)` / `\[…\]`） |
| 时序图 | **js-sequence** | ` ```sequence ` |
| 流程图 | **flowchart.js** | ` ```flow ` |
| Mermaid（流程图/时序/甘特/类图/状态图/饼图/…） | **mermaid**（1.13 升级到 11.13.0） | ` ```mermaid ` |

来源：<https://support.typora.io/Math/>、<https://support.typora.io/Draw-Diagrams-With-Markdown/>、<https://support.typora.io/What's-New-1.13/>、<https://support.typora.io/What's-New-1.11/>

### 5.2 异步还是同步？——**异步，且异步过程会冲掉光标/滚动**

**（a）数学渲染是异步的，且历史上直接把光标位置冲掉（官方承认并修复）**【官方开发者回复】

> Typing the first dollar sign enters you into math mode, you type your math, you insert a second dollar sign and keep typing at your usual pace. **Unexpectedly, the rendering of the mathjax makes the cursor jump back inside the dollar sign environment**, thereby inserting the new text in a place where it doesn't belong.

— issue #1813「Cursor jumping while rendering mathjax」，<https://github.com/typora/typora-issues/issues/1813>【用户观察】
> duplicate with #1803

— abnerlee，2018-09-27（**官方确认为重复问题，即已知悉**）【官方开发者回复】

**（b）官方在更新日志中多次把它当作「已修复的渲染竞态」记录**【官方文档确证】

- Typora **1.4** Bug Fix：**"Fix a caret jump issue when typing after inline math."** — <https://support.typora.io/What's-New-1.4/>
- Typora **1.3** Bug Fix：**"Fix jump when user click a video and fix caret movement when using ctrl+right key around math."** — <https://support.typora.io/What's-New-1.3/>
- Typora **1.7** Cursor and Selection：**"Fix cursor jump after delete after :emoji: ."** — <https://support.typora.io/What's-New-1.7/>
- Typora **1.8** Bug Fix：**"Fix cursor misplaced when editing emoji."** — <https://support.typora.io/What's-New-1.8/>

**（c）更严重的一例：含公式的段落每次击键后光标都跳到错误位置（官方确认修复于 1.4.4）**【官方开发者回复】

> Cursor moves location after each keystroke when editing paragraphs containing inline mathblock, e.g. `$ a + b $`. … Eventually the cursor will move to the start of the mathblock (before the opening `$`) without any prompting. … Bug does not appear to occur in source mode.
>
> — should be fixed in 1.4.4

— issue #5308，<https://github.com/typora/typora-issues/issues/5308>；abnerlee 回复 2022-09-06【官方开发者回复】

**（d）图表是异步渲染的**（由 1.9.4 起代码块行号「延迟出现并推动页面」的行为反证，见第 6 节）【用户观察】

### 5.3 渲染期间有占位吗？

**【未找到】**官方文档中没有任何「公式/图表渲染期间占位高度」的说明。
官方只提供了**手动强制重刷**作为兜底：

> **Force Refresh**: When math rendering goes wrong, like the output math is too wild/narrow, or equation numbering becomes incorrect, you can trigger a forced refresh for all math from the `Edit` → `Math Tools` menu.

— <https://support.typora.io/Math/>

### 5.4 点击公式/图表会不会塌成源码？——**不会塌成裸源码，而是「渲染结果 + 源码输入区」并置**

**【官方文档确证】**：

- 公式块：进入**输入模式（input mode）**，而非把 `$$` 展开到正文里：
  > In Typora, you can just type `$$` and press the Return key to input a math block. **In input mode, use the Up/Down arrow keys or Command/Ctrl + Return key to finish editing, or just click the ✓ button, or somewhere else.**
  — <https://support.typora.io/Math/>

  且有「输入态」与「渲染态」的区分（`Edit` → `Math Tools` → Force Refresh 的存在本身说明渲染结果与源码是两套表示）。

- 行内公式：需要显式触发预览，而不是光标进入就展开：
  > To trigger an inline preview for inline math: input `$`, then press the ESC key followed by inputting a TeX command.
  — <https://support.typora.io/Markdown-Reference/>（"Inline Math"）

- 图表：点击后**渲染结果仍在**，右键可另存/复制，**没有任何「点击塌成源码」的官方描述**：
  > You can right click on a diagram to save it as a SVG, PNG or JPG file on your local disk. Also, you can right click on a diagram to copy it to your clipboard.
  — <https://support.typora.io/Draw-Diagrams-With-Markdown/>（"Save-as / Copy on Diagrams"）

**重要旁证（说明图表的源码是「另一个面板」而不是「替换渲染结果」）**【官方文档确证】：
官方 CSS 文档中出现了 `.md-diagram-panel-preview` 选择器，用于「让图表左对齐」：

> You can add the custom CSS below to left align your diagram.
> ```
> .md-diagram-panel-preview {text-align:left;}
> ```

— <https://support.typora.io/Draw-Diagrams-With-Markdown/>（"Diagram Alignment"）

`panel` + `preview` 的命名表明：图表是**在一个面板里渲染预览**，与源码编辑区并存。这与 5.4 的结论一致。

**未找到**：官方文档没有明确写「编辑图表时图表预览保持可见、不塌陷」。此点由 `md-diagram-panel-preview` 选择器与「右键另存渲染结果」两条推断。【未找到】直接的官方明文。

---

## 6. 代码块：``` 围栏行什么时候显示？光标在块内 vs 块外时高度会变吗？

### 6.1 围栏行的显隐

**【官方文档确证，但只有间接表述】**
官方在 Live Preview 的说明里把块级标记（举的例子是 `###` 与 `- [x]`）归为「block level styles」，规则是 "will be hidden once the block is rendered"——代码块的 ``` 属于块级标记，因此**块渲染完成后围栏隐藏，光标进入块内时显示**。

— <https://support.typora.io/Quick-Start/>

**【未找到】任何官方文档逐字说明「``` 围栏行在光标位于代码块内时显示、块外时隐藏」。** 上述结论是**由官方对块级标记的总规则推断**得出，请按推断对待。

官方对代码块给出的**显式 UI 事实**是：代码块右下角有一个**语言选择输入控件**（widget），这是渲染态的一部分：
> You can modify the code language for existing code fences in the **right bottom input widget** of the code block.

— <https://support.typora.io/Code-Fences/>

### 6.2 光标在块内 vs 块外，高度会不会变？——**有明确的「渲染迟到 → 页面位移」缺陷记录，且官方多年未修**

**这是 Typora 与 Opennote 症状最接近的一条一手证据。**

> **With `Preferences → Markdown → Code Fences → Display line numbers for code fences` enabled, code blocks do not render line numbers immediately when scrolling.**
>
> When a code block enters the visible area, it often appears without line numbers first. **After a short delay, the line number gutter suddenly appears on the left side, causing the page to shift, flicker, or repaint.** This happens repeatedly when scrolling through documents with multiple code fences.
>
> Expected behavior: code blocks should render with line numbers immediately, **without shifting the page** after they become visible.
>
> This bug has existed since 2024 and is **still not fixed** in Typora 1.13.4.

— issue #6548「[BUG] Code fence line numbers cause delayed rendering and layout shift」，状态 **open**，<https://github.com/typora/typora-issues/issues/6548>【用户观察】

同一问题在更早版本被另一个人独立报告：

> Since version 1.9.4, the line numbers for code fences seem hidden and then show up when you scroll to a code fence. … **Initially, the code fence has no line numbers, but soon the document renders to show the line numbers.** The next code fence still hides the line numbers and begins to show them after I reach the area. **The constant page rendering will happen.**

— issue #6094，状态 **open**，<https://github.com/typora/typora-issues/issues/6094>【用户观察】

**另一条更早的、与代码块相关的滚动跳动缺陷（官方承认并修复）**【官方开发者回复】：

> When I click on part of a fenced code block, in the currently-unfocused Typora window, with the document scrollbar in any position but the very top, **the scroll position jumps (scrollbar moving up)**, and the editor interprets this move as a drag-to-select.
>
> — duplicate with #857 … In my testing, it won't happen on v0.9.36.

— issue #848，<https://github.com/typora/typora-issues/issues/848>；abnerlee 2017-08-26【官方开发者回复】

**（但请注意：该 issue 在 2021 年仍有用户追评「This same issue is still happening for me」，见同 URL 评论。）**【用户观察】

### 6.3 官方对代码块的其他相关决策（会影响高度）

| 决策 | 官方原文 | 来源 |
| --- | --- | --- |
| 行号可开关（**默认行为影响高度**） | "You can control whether Typora should show line numbers for code blocks by changing the option `Display line numbers for code fences`" | <https://support.typora.io/Code-Fences/> |
| 长行自动换行 vs 横向滚动（**直接决定块高**） | "You can control whether Typora should auto wrap lines, or provide horizontal scroll, when a code block contains text lines that are longer than the width of its code block container." | <https://support.typora.io/Code-Fences/> |
| 缩进宽度（影响宽度/换行） | "This option controls how many Tab's are used to render the whitespace in a code block." | <https://support.typora.io/Code-Fences/> |

**含义**：Typora 把「代码块高度会变」的根因（行号、换行）交给**用户偏好设置**，而不是用工程手段消除。**Opennote 若照搬，必须注意：这恰恰是把 layout shift 的责任推给用户。**

---

## 7. 滚动与光标：如何保证「正在编辑的那一行」不跳？Focus Mode / Typewriter Mode 的官方定义？

### 7.1 Focus Mode —— 官方定义是「**淡化**（fade out）其他内容」，不是「隐藏」

**【官方文档确证，逐字】**

> When "Focus Mode" is enabled, **Typora will fade out other contents except current line/block.** You could turn "Focus Mode" on/off from `view` menu.

— <https://support.typora.io/Focus-and-Typewriter-Mode/>

**关键判定**：
- 官方用词是 **fade out（淡化）**，且是 "current **line/block**"（当前行**或**块）。
- **不是**「只显示当前段落」。官方从未说其他内容被移除或 `display:none`；相反，官方 CSS 文档给出的实现方式是**改颜色 / 降不透明度**：
  > You can simply change the text color in unfocused paragraph by adding following css: `:root { --blur-text-color: #FFF; }`
  > … `.on-focus-mode .md-end-block:not(.md-focus):not(.md-focus-container) * { color: #C8C8C8 !important; }`
  > … `img { opacity: 50%; }`
  — <https://support.typora.io/Change-Styles-in-Focus-Mode/>
- 因此 **Focus Mode 不改变布局**：元素仍在文档流中、仍占原有高度。它**不参与**「防止位置跳动」这件事。
- ⚠️ **注意一个陷阱**：官方示例把 `--blur-text-color` 设成 `#FFF`（纯白，与背景同色）时，视觉上等同于「只显示当前段落」。这只是**主题/CSS 造成的视觉巧合**，不是 Focus Mode 的定义。Opennote 若引用这条，务必区分「淡化」与「隐藏」。

### 7.2 Typewriter Mode —— 官方定义是「滚动文章以保持光标固定」，光标默认在**窗口正中**

**【官方文档确证，逐字】**

> Typewriter mode mimics the behavior of mechanic typewriters — **it scrolls the article to keep current caret fixed when typing.**
>
> You could turn on/off typewriter mode from `view` menu.
>
> **By default, it will _always_ keep caret in middle of the window even when you change selection by mouse click.** If you only want to use fixed scrolling when typing, you could disable this behavior from `preferences panel` → `Always keep caret in middle of screen\nwhen typewriter mode is enabled`.

— <https://support.typora.io/Focus-and-Typewriter-Mode/>

**关键判定**：
- 光标位置是 **middle of the window（窗口垂直正中）**，官方明确写死这一档，**没有「上 1/3」「下 1/3」等可选档位**。
- 有两个模式：
  1. **默认**：打字**和**鼠标点击改变选区时都保持光标居中；
  2. **可选（关掉上述偏好）**：只在**打字**时做固定滚动，鼠标点击时不强制居中。
- **这就是 Typora 对「正在编辑的那一行不跳」的正面答案**：不是靠避免重排，而是靠**每次打字后主动重新定位滚动锚点（把光标行钉在窗口中线上）**。这是一个**补偿式**方案，不是**预防式**方案。

### 7.3 其他与滚动/光标稳定性直接相关的官方修复【官方文档确证】

| 版本 | 官方更新日志原文 | 来源 |
| --- | --- | --- |
| **1.13** | **"View switch between source code mode and hybrid editing mode will preserve scroll position."** | <https://support.typora.io/What's-New-1.13/> |
| 1.13 | "Fixed the editor window not scrolling in some cases when clicking an outline anchor." | 同上 |
| 1.7 | "Fix open file with anchor pos will not jump to correct position when the file is already opened." | <https://support.typora.io/What's-New-1.7/> |
| 1.7 | "Add jump to line start / end command in menu bar." | 同上 |
| 1.5 | "Fix wrong scroll on code blocks when clicking global search result." | <https://support.typora.io/What's-New-1.5/> |
| 1.3 | "Fix a bug that open file link with # anchor sometimes cannot jump to the correct position." | <https://support.typora.io/What's-New-1.3/> |
| 1.8 | "Performance and Stability: Improve performance and stability." | <https://support.typora.io/What's-New-1.8/> |

**注意 1.13 那条的重要性**：它说明「切换到源码模式再切回来」**在 1.13 之前是会丢失滚动位置的**，1.13 才补上。也就是说，**双视图切换的滚动位置保持是 Typora 直到 2026-04 才显式处理的工程问题**，而它对应到 Opennote 就是「模式切换时的位置保持」。

---

## 8. 源码模式：`Ctrl+/` 的官方说明 —— 它是不是官方的「逃生舱」？

### 8.1 官方事实【官方文档确证】

| 事实 | 原文 | 来源 |
| --- | --- | --- |
| 快捷键 | View → **Source Code Mode**：Windows/Linux `Ctrl + /`，macOS `Command + /` | <https://support.typora.io/Shortcut-Keys/> |
| 是一个独立的**视图模式** | 官方 1.13 更新日志称之为 "View switch between **source code mode and hybrid editing mode**" | <https://support.typora.io/What's-New-1.13/> |
| 内部是 CodeMirror | 官方 CSS 文档暴露 `#typora-source .CodeMirror-code`、`#typora-source .CodeMirror-lines` 选择器 | <https://support.typora.io/Change-Styles-in-Focus-Mode/>、<https://support.typora.io/Width-of-Writing-Area/> |
| 宽度独立配置 | "To change the width of source code mode: `#typora-source .CodeMirror-lines { max-width: auto; }`" | <https://support.typora.io/Width-of-Writing-Area/> |
| 官方承认某些问题「在源码模式下不会出现」 | issue #5308 报告者："Bug does not appear to occur in source mode."（官方随后确认修复于 1.4.4） | <https://github.com/typora/typora-issues/issues/5308>【用户观察】 |
| 官方明确「源码模式应保留纯源码、不被 hybrid 样式影响」是**用户诉求**（非官方承诺） | 用户 bwl21："The source-Mode shall be styles independent from hybrid (WYSIWIG) mode / shall be monospace font with syntax highlighting but nothing else" | <https://github.com/typora/typora-issues/issues/1317>【用户观察】 |

### 8.2 它是不是官方定义的「逃生舱」？

**【未找到】官方文档中没有任何一句把 Source Code Mode 定义为「渲染出问题时的逃生舱 / escape hatch」。** 官方只在 `Ctrl+/` 的快捷键表与 1.13 更新日志里把它当作一个**并列的视图模式**描述。

但可以确证的**事实性等价表述**是：
- **用户社群**把它当作逃生舱使用，且这是社区共识：「Most of my work can be done in WYSIWYG and **if something is strange, just switch to source code mode to fix it.**」（用户 cangyuyao，<https://github.com/typora/typora-issues/issues/1317>）【用户观察】
- 官方**不反对**这一用法，且 1.13 主动补齐了「源码 ↔ hybrid 切换保持滚动位置」，**在工程上降低了切换成本**（<https://support.typora.io/What's-New-1.13/>）【官方文档确证】

**给 Opennote 的准确表述**：`Ctrl+/` 不是官方命名的逃生舱，但它是官方持续投入（1.13 补滚动位置保持）的、事实上的兜底通道。**它的问题在于：它把「渲染态不稳定」的成本转移给了用户的手动切换。**

---

## 9. 已知缺陷与官方修复：`jump` / `scroll` / `layout shift` / `flicker` / `scroll position` 的完整清单

### 9.1 官方**承认并修复**过的（有明确修复版本）

| # | 症状 | 官方处置 | 来源 |
| --- | --- | --- | --- |
| 1 | 打字后行内公式导致光标跳 | 1.4 修复："Fix a caret jump issue when typing after inline math." | <https://support.typora.io/What's-New-1.4/> |
| 2 | 点击 video 后跳 / 公式周围 ctrl+right 光标移动错乱 | 1.3 修复 | <https://support.typora.io/What's-New-1.3/> |
| 3 | 删 emoji 后光标跳 | 1.7 修复："Fix cursor jump after delete after :emoji: ." | <https://support.typora.io/What's-New-1.7/> |
| 4 | 编辑 emoji 时光标错位 | 1.8 修复："Fix cursor misplaced when editing emoji." | <https://support.typora.io/What's-New-1.8/> |
| 5 | 含行内公式的段落每次击键后光标跑到错误位置（含公式段落的渲染竞态） | 1.4.4 修复（abnerlee 确认） | <https://github.com/typora/typora-issues/issues/5308> |
| 6 | MathJax 渲染把光标冲回 `$` 内部 | 官方判为 #1803 的重复（即已跟踪） | <https://github.com/typora/typora-issues/issues/1813> |
| 7 | 图片尺寸不稳定 + 预览闪烁（把下方内容推来推去） | 1.4.4 修复（abnerlee 确认） | <https://github.com/typora/typora-issues/issues/5273> |
| 8 | 点击未聚焦窗口中的代码块 → 滚动位置跳 + 误判为拖拽选择 | 0.9.36 起修复（abnerlee 确认；2021 年仍有用户追评存在） | <https://github.com/typora/typora-issues/issues/848> |
| 9 | 隐藏的 `<br>` 仍占宽度（撑宽表格列） | 2021 年修复（abnerlee 确认） | <https://github.com/typora/typora-issues/issues/1026> |
| 10 | 编辑时随机破坏代码块围栏（丢/复制 ` ``` `） | "fixed in new release"（abnerlee，2021-04-27） | <https://github.com/typora/typora-issues/issues/4100> |
| 11 | 切换源码模式 / hybrid 模式后滚动位置丢失 | **1.13 修复**："View switch between source code mode and hybrid editing mode will preserve scroll position." | <https://support.typora.io/What's-New-1.13/> |
| 12 | 点击大纲条目时编辑器不滚动 / 锚点定位错误 | 1.13 修复 | 同上 |
| 13 | 全局搜索结果点击后代码块滚动错误 | 1.5 修复 | <https://support.typora.io/What's-New-1.5/> |
| 14 | 点击图片导致编辑器抖动/闪烁 | 2025-10-23 closed（**无官方修复说明**，仅关闭） | <https://github.com/typora/typora-issues/issues/5925> |

### 9.2 官方**未修复 / 至今 open** 的（Opennote 必须自己解决的）

| # | 症状 | 状态 | 来源 |
| --- | --- | --- | --- |
| A | **链接自动展开导致 layout shift，长 URL 把后面文字全部推走** | **open**，标签 `hybrid editing` | <https://github.com/typora/typora-issues/issues/5375> |
| B | **链接展开导致光标列位置被重置（col 10 → col 22）** | **open**，标签 `hybrid editing` | <https://github.com/typora/typora-issues/issues/1313> |
| C | **标题上显示 `###` 源码时不保持渲染样式 → "disconcerting jumpy text"** | **open**，标签 `hybrid editing`（2018 年至今） | <https://github.com/typora/typora-issues/issues/285> |
| D | **代码块行号延迟渲染 → 页面位移/闪烁**（1.9.4 起，1.13.4 仍存在） | **open** | <https://github.com/typora/typora-issues/issues/6548>、<https://github.com/typora/typora-issues/issues/6094> |
| E | 远程图片异步加载 → 页面跳到顶部或随机位置 | closed，**无根因说明** | <https://github.com/typora/typora-issues/issues/3880> |
| F | 空列表项光标不垂直居中，输入首字母后 JUMP（视觉闪烁） | **open** | <https://github.com/typora/typora-issues/issues/6159> |
| G | 文档无原因向上滚动一整页（含打字过程中） | **open** | <https://github.com/typora/typora-issues/issues/6089> |
| H | Command-Tab 切回后滚动位置丢失 | **open** | <https://github.com/typora/typora-issues/issues/6633> |
| I | 点击大纲跳转到文档顶部（偶发） | **open**（`Need more info`） | <https://github.com/typora/typora-issues/issues/5948> |
| J | 大文档打字卡顿（主题相关） | **open** | <https://github.com/typora/typora-issues/issues/6595> |
| K | 「鼠标选中内容的过程中」光标/选区异常 | closed，无修复说明 | <https://github.com/typora/typora-issues/issues/5339> |

### 9.3 作者对这类问题的整体立场（决定了上面 B/C 不会被修）

> Of course a Typora user prefer WYSIWYG, but they also prefer Markdown… This leading to **a mix of them, but not *pure* WYSIWYG**

— abnerlee，2018-03-30，<https://github.com/typora/typora-issues/issues/1317#issuecomment-377465999>【官方开发者回复】

> We implement the default hybrid view to save users from the traditional switching between source code and preview mode, **it will not be a good idea to introduce a new mode again.**

— abnerlee，2018-03-15，<https://github.com/typora/typora-issues/issues/1317#issuecomment-373295532>【官方开发者回复】

---

## 10. 对 Opennote 的直接启示

> 前提约束：Opennote 是**纯前端 + CodeMirror 6**，Typora 是 **Electron + 自有 DOM + CodeMirror 5 内嵌**。两者的**可借用程度**差别很大：Typora 的「渲染态就地编辑」方案依赖它自己可控的 DOM 与编辑器内核，**不能直接移植到 CM6**（CM6 的行高来自对 `.cm-line` 的实测，见 R2 文档）。因此下面区分「可借鉴的决策」与「不可照搬、必须反向做的决策」。

### 10.1 可以直接采纳的 4 条 Typora 决策

1. **块级结构保持渲染态、原地编辑，绝不塌成源码。**
   依据：表格（<https://support.typora.io/Table-Editing/>）、公式块输入模式（<https://support.typora.io/Math/>）、图表面板（`.md-diagram-panel-preview`，<https://support.typora.io/Draw-Diagrams-With-Markdown/>）三处一致。
   → 对 Opennote：**表格 / 公式 / Mermaid / 代码块在编辑态必须保持渲染结果可见**，源码编辑区以「面板/widget」形式并置或覆盖，**不得用源码替换渲染结果**。

2. **Typewriter Mode 的正面做法：用「主动重新锚定滚动」补偿重排。**
   依据：官方明确定义为 "scrolls the article to keep current caret fixed when typing"，且默认光标钉在**窗口正中**（<https://support.typora.io/Focus-and-Typewriter-Mode/>）。
   → 对 Opennote：与其追求「零高度变化」，不如**在每次文档变更后，用 CM6 的 `EditorView.scrollIntoView(pos, {y: 'center'})` 重新锚定**。这是一个**确定性可落地**的兜底，成本远低于消除所有重排。
   ⚠️ 但注意：这会与「用户手动滚动时不要抢滚动」冲突——Typora 用「只在打字时居中」这个偏好开关来化解，Opennote 需要等价的状态机（区分「打字触发的变更」与「用户滚动/鼠标选择」）。

3. **Focus Mode 是「淡化」而非「隐藏」，不改变布局。**
   依据：官方用词 fade out（<https://support.typora.io/Focus-and-Typewriter-Mode/>），实现是改 `color` / `opacity`（<https://support.typora.io/Change-Styles-in-Focus-Mode/>）。
   → 对 Opennote：若要实现 Focus Mode，**只改颜色/透明度，绝不 `display:none` 或改高度**。这是**零 layout 风险**的写法。

4. **把「源码视图 ↔ 编辑视图」的滚动位置保持当作显式工程需求。**
   依据：Typora 直到 **1.13**（2026-04）才做到 "View switch between source code mode and hybrid editing mode will preserve scroll position"（<https://support.typora.io/What's-New-1.13/>）。
   → 对 Opennote：如果存在任何模式切换（源码模式、预览模式、专注模式），**必须在切换前记录锚点、切换后恢复**，不要等用户报 bug。

### 10.2 必须**反向做**的 5 条（Typora 的缺陷，正是 Opennote 的差异点）

5. **行内标记显隐必须做几何补偿，或干脆不隐藏。**
   Typora 明确不做（第 2.3 节，【未找到】任何补偿机制），后果是长 URL 把整段推走、光标列位置被重置（issue #1313 / #5375，均 open）。
   → 对 Opennote：**这是最大差异化机会**。可选路线（需实测）：(a) 标记行内渲染但用等宽/固定宽度占位；(b) 标记绝对定位 + 正文预留 padding；(c) 用 CM6 的 **atomic range / replace decoration** 让标记「零宽」而非「显示/隐藏切换」；(d) 只在不改变行盒高度时显示标记。
   ⚠️ 具体实现约束见同目录 R2 文档（CM6 行高实测、`HeightMap`、`overflow-anchor` 等）。

6. **标题上的 `###` 显示时必须保持渲染样式。**
   Typora 的 #285（open，2018 至今）证明：一旦 `###` 以普通正文字号插入，行高与折行都会变 → 用户感知为「跳」。
   → 对 Opennote：标题标记若显示，必须**保留标题的字号/行高/字重**，只把标记本身做成弱化样式；否则宁可隐藏。

7. **图片必须预留占位高度。**
   Typora **没有**这个机制（第 4.3 节【未找到】），官方甚至明说除 `width`/`height`/`zoom` 外的 `style` 属性在编辑器内被忽略（<https://support.typora.io/Resize-Image/>）；用户已报告远程图片导致跳到顶部（issue #3880）。
   → 对 Opennote：**在图片元数据可用时写入 `width`/`height` 或 `aspect-ratio` 占位**，这是 Typora 没做而 Opennote 可以做到更好的地方。

8. **代码块的行号 / 自动换行不要「渲染迟到」。**
   Typora 的 #6548 / #6094（均 open，跨 1.9.4 → 1.13.4 多年未修）证明：行号 gutter 延迟出现会推动页面。
   → 对 Opennote：行号 gutter 必须**与代码块同帧渲染**，且**宽度固定**（不随行数变化改变代码区宽度）。

9. **公式/图表渲染必须是「不改变高度」的幂等替换。**
   Typora 的公式渲染竞态曾把光标冲走（issue #1813 / #5308），官方只能逐个版本打补丁；官方至今没有渲染期占位（第 5.3 节【未找到】）。
   → 对 Opennote：渲染前先**测量并锁定容器高度**（或用上一步的高度做占位），渲染完成后只替换内容不改盒模型；渲染过程**不得触碰选区/滚动锚点**（CM6 侧即「不要在有渲染任务在飞时 dispatch selection 变更」）。

### 10.3 一句话总结

> **Typora 在「编辑稳定性」上的工程决策，本质上不是「消除重排」，而是三件事：(1) 把块级结构（表格/公式/图表）固定在渲染态，避免整块高度突变；(2) 用 Typewriter Mode 主动重新锚定滚动来掩盖行内重排；(3) 对行内标记显隐造成的位移，选择「承认并长期不修」。**
>
> 因此对 Opennote 的启示是**反向的**：**Typora 唯一正面可抄的是「块级保持渲染态」和「Typewriter 重新锚定」；它在行内标记、图片占位、代码块行号、公式渲染占位这四处的空白，恰恰是 Opennote 可以做到更好的地方。**

---

## 附录 A：本文引用的全部一手来源

**官方文档（support.typora.io）**
- Quick Start（Live Preview / 标记显隐总规则）：<https://support.typora.io/Quick-Start/>
- Markdown Reference（span 展开规则、图片点击改源码、表格图形化编辑）：<https://support.typora.io/Markdown-Reference/>
- Focus Mode and Typewriter Mode：<https://support.typora.io/Focus-and-Typewriter-Mode/>
- Change Styles in Focus Mode（DOM 类名、淡化实现）：<https://support.typora.io/Change-Styles-in-Focus-Mode/>
- Table Editing：<https://support.typora.io/Table-Editing/>
- Images in Typora：<https://support.typora.io/Images/>
- Resize Images：<https://support.typora.io/Resize-Image/>
- Code Fences：<https://support.typora.io/Code-Fences/>
- Math and Academic Functions：<https://support.typora.io/Math/>
- Draw Diagrams With Markdown：<https://support.typora.io/Draw-Diagrams-With-Markdown/>
- Shortcut Keys（`Ctrl+/` = Source Code Mode）：<https://support.typora.io/Shortcut-Keys/>
- Change Width of Writing Area（`#typora-source` 为 CodeMirror）：<https://support.typora.io/Width-of-Writing-Area/>
- Trouble Shooting：<https://support.typora.io/Trouble-Shooting/>
- Convert & Reformat Markdown：<https://support.typora.io/Markdown-Export/>

**官方更新日志（What's New）**
- 1.14 <https://support.typora.io/What's-New-1.14/>｜1.13 <https://support.typora.io/What's-New-1.13/>｜1.12 <https://support.typora.io/What's-New-1.12/>｜1.11 <https://support.typora.io/What's-New-1.11/>｜1.10 <https://support.typora.io/What's-New-1.10/>｜1.9 <https://support.typora.io/What's-New-1.9/>｜1.8 <https://support.typora.io/What's-New-1.8/>｜1.7 <https://support.typora.io/What's-New-1.7/>｜1.6 <https://support.typora.io/What's-New-1.6/>｜1.5 <https://support.typora.io/What's-New-1.5/>｜1.4 <https://support.typora.io/What's-New-1.4/>｜1.3 <https://support.typora.io/What's-New-1.3/>

**官方 issue 仓库（作者 abnerlee 亲自回复处）**
- #1317 hybrid view 的定义与拒绝 pure WYSIWYG：<https://github.com/typora/typora-issues/issues/1317>
- #1313 链接自动展开导致 layout shift + 光标列位置重置（open）：<https://github.com/typora/typora-issues/issues/1313>
- #5375 "Links cause layout shifting"（open）：<https://github.com/typora/typora-issues/issues/5375>
- #285 标题显示 `###` 不保持渲染样式（open）：<https://github.com/typora/typora-issues/issues/285>
- #6548 代码块行号延迟渲染导致 layout shift（open）：<https://github.com/typora/typora-issues/issues/6548>
- #6094 1.9.4 起代码块行号隐藏后出现（open）：<https://github.com/typora/typora-issues/issues/6094>
- #5273 图片尺寸不稳定 + 预览闪烁（1.4.4 修复）：<https://github.com/typora/typora-issues/issues/5273>
- #5308 含公式段落击键后光标跳（1.4.4 修复）：<https://github.com/typora/typora-issues/issues/5308>
- #1813 MathJax 渲染导致光标跳：<https://github.com/typora/typora-issues/issues/1813>
- #1026 隐藏的 `<br>` 仍占宽度（已修）：<https://github.com/typora/typora-issues/issues/1026>
- #848 点击代码块导致滚动跳 + 误选（0.9.36 修复）：<https://github.com/typora/typora-issues/issues/848>
- #4100 编辑时随机破坏代码块围栏（已修）：<https://github.com/typora/typora-issues/issues/4100>
- #5925 点击图片导致编辑器抖动/闪烁（2025-10-23 closed）：<https://github.com/typora/typora-issues/issues/5925>
- #3880 远程图片导致滚动跳到顶部：<https://github.com/typora/typora-issues/issues/3880>
- #6089 文档无原因向上滚动（open）：<https://github.com/typora/typora-issues/issues/6089>
- #6159 空列表项输入首字母后光标 JUMP（open）：<https://github.com/typora/typora-issues/issues/6159>
- #6633 Command-Tab 后滚动位置丢失（open）：<https://github.com/typora/typora-issues/issues/6633>
- #5948 点击大纲跳到文档顶部（open）：<https://github.com/typora/typora-issues/issues/5948>
- #4215 作者拒绝左右分栏（引用 #70 原话）：<https://github.com/typora/typora-issues/issues/4215>
- #6595 大文档打字卡顿（open）：<https://github.com/typora/typora-issues/issues/6595>

**不可用来源（已记录）**
- `forum.typora.io`：DNS 无 A/AAAA/CNAME 记录（仅返回 SOA），本机解析被污染至 Meta 网段，Wayback Machine 无快照。**未能取得任何一手来源。**

## 附录 B：本文中所有「未找到」的清单（避免被误读为「Typora 没有该行为」）

| 项 | 状态 |
| --- | --- |
| `forum.typora.io` 上 abnerlee 的任何回复 | 【未找到】（域名已失效，见 0.1） |
| 为行内标记显隐做宽度预留 / 绝对定位的官方说明 | 【未找到】 |
| 「点击表格单元格不改变表格高度」的官方明文 | 【未找到】（由 Table-Editing 原文推断） |
| 「图片加载前预留占位高度」的官方机制 | 【未找到】 |
| 「公式/图表渲染期间有占位」的官方说明 | 【未找到】 |
| 「``` 围栏行在光标位于块内时显示、块外时隐藏」的官方逐字说明 | 【未找到】（由 Quick Start 的块级标记总规则推断） |
| 官方把 Source Code Mode 定义为「逃生舱」的表述 | 【未找到】（1.13 补齐滚动位置保持，是事实上的降级成本优化） |
| 「编辑图表时预览保持可见」的官方明文 | 【未找到】（由 `.md-diagram-panel-preview` 与「右键另存渲染结果」推断） |
