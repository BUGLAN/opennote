# 待整合：HTML 页面的标题派生与搜索路径

> 这份文件是**记录**，不是最终文档。等你决定怎么并进 `docs/html-page.md` 之后可以删掉。
> 全部内容来自当前分支 `feat/html` 的实际代码；行号以工作区当前状态为准（base `39eb62c`）。

## 一、标题是怎么取的

> 建议去处：`docs/html-page.md` 第 1 节「它是什么」的表格下面，补一小节「标题从哪来」。

### 1. 两条链，同一个形状

| 类型 | 顺序 | 唯一产地 |
| --- | --- | --- |
| Markdown | 正文第一个 `#` 标题 → 正文第一行非空文本 → 文件名 | `src/lib/utils.ts:71` `deriveTitle()` |
| HTML | `<title>` → 第一个 `<h1>` → 文件名 | `src/lib/htmlPage.ts:114` `htmlTitle()` |

两边都是**三级兜底**，不是并列候选。「文件名」在两条链里都排在最后一级。

调用点只有两个，都在 `src/data/library.ts`：

- `makeNote():384` —— 扫描时新建
- `refresh():408` —— 内容变了重算（外部改动、快照恢复）

### 2. 还有一层：titleOverride 赢过一切

`Note.title` 的实际值统一是 `titleOverride ?? 派生值`。用户手动改过名之后派生值不再生效；
重扫时从 `.opennote/state.json` 挂回去（`src/data/library.ts:673-682`）。所以严格说顺序是：

```
titleOverride（用户手定）  >  <title> / H1 / 文件名（自动派生）
```

### 3. 为什么 HTML 不是「就直接取文件名」

两条链的**唯一差异**是 `<title>`。

Markdown 没有「文档标题」这个位置，`deriveTitle()` 能拿来比较的只有 H1；首行兜底是因为
大量笔记根本不写 H1。

HTML 有 `<title>`，它是作者**显式**给这份文档起的名字 —— 浏览器标签页显示的就是它。
把 `<h1>` 排在它前面的话，`<title>登录 · 原型</title><h1>欢迎回来</h1>` 这种页面
在树里会显示「欢迎回来」，而作者给它起的名字是「登录 · 原型」。

`htmlFallbackTitle()`（`src/lib/htmlPage.ts:129`）名字里带 fallback 只是因为它处理最后一级；
它顺带处理了 `.html` 这种「去掉扩展名什么都不剩」的名字 —— `extName()` 不把开头就是点的段
当扩展名，所以 `stripExtension(".html")` 原样返回 `.html`，不特判的话列表里会出现一条
标题叫「html」的笔记。这一条有单测：`src/lib/htmlPage.test.ts` 的 `htmlFallbackTitle` 一节。

## 二、对不上号的地方（待修）

> 这五处是我上一轮交付时漏掉的：树的那条分支改了，同源的其它分支没改。
> 它们不是「风格不统一」，是会真正显示错东西。

### D1 搜索结果的摘要会吐出 CSS 与脚本

| 项 | 内容 |
| --- | --- |
| 锚点 | `src/data/library.ts:3318-3325` `buildSnippet()` |
| 现状 | `stripMarkdown(splitFrontMatter(note.content).body)` |
| 树里（正确） | `src/components/Sidebar.tsx:1041` 走 `htmlExcerpt()` |

为什么错：`stripMarkdown()`（`src/lib/utils.ts:189-207`）对 HTML 只做
`.replace(/<[^>]+>/g, " ")` —— **去掉标签，留下标签之间的文本**。`<style>` / `<script>` 的
**内容**原样保留。

**已实测**（`tsx` 直接跑这两个函数，同一份页面）：

```
stripMarkdown => "原型 · 登录页 h1{color:#fff} 欢迎回来 这是一个原型页面。 document.title = '被脚本改掉'"
htmlToText    => "原型 · 登录页 欢迎回来 这是一个原型页面。"
```

左边就是搜索结果现在会显示的东西。

建议：按 kind 分流 —— `note.kind === "html" ? htmlToText(note.content) : stripMarkdown(...)`。
`htmlToText()` 已经在剥 script / style / 注释，与 `htmlExcerpt()` 同源。

### D2 搜索索引里混进了样式与脚本

| 项 | 内容 |
| --- | --- |
| 锚点 | `src/data/library.ts:3258-3268` `plainOf()` |
| 现状 | `stripMarkdown(note.content).toLowerCase()` |
| 用处 | `searchNotes():3293` 的 `body.indexOf(term)`，以及摘要的 `position` |

为什么错：同上。这份字符串是**检索**用的，不是显示用的。

现象：搜 `fff`、`color`、`document.title` 会命中 HTML 页面 —— 用户看得见的正文里
根本没有这些词。而且 `position` 也算在这份文本上，摘要会从 CSS 里开始截。

建议：与 D1 用**同一个** helper 生成检索文本。索引与摘要用两份不同的文本时，
摘要的截取位置会落到风马牛不相及的地方。

### D3 回收站列表的图标还是 Markdown

| 项 | 内容 |
| --- | --- |
| 锚点 | `src/components/Sidebar.tsx:1176`（`TrashList` 内部，独立实现的行） |
| 现状 | `<Icon name="note" size={14} />` |
| 已改对的地方 | `NoteRow`，`Sidebar.tsx:1032` 按 kind 分 `file` / `note` |

回收站里的 HTML 页面和 Markdown 页面长得一模一样。

### D4 搜索结果的平铺列表图标还是 Markdown

| 项 | 内容 |
| --- | --- |
| 锚点 | `src/components/Sidebar.tsx:1352`（`SearchBody` 的平铺分支） |
| 现状 | `<Icon name="note" size={14} />` |

比 D3 更误导：搜索结果里 HTML 页面看起来**可以像 Markdown 一样编辑**。

### D5 侧栏过滤（filter）的 haystack 也走 Markdown

| 项 | 内容 |
| --- | --- |
| 锚点 | `src/components/Sidebar.tsx:1263`（`FilteredNotes`） |
| 现状 | `excerpt(note.content, 4000)` |

同 D2，只是**不显示**文本，所以症状轻（能筛出不该筛出的页面）。**低优先**。

### 顺带一条：D1 / D2 / D5 的共同前提

三处都在用「Markdown 的纯文本函数」处理 HTML。正确的做法是收一个产地：
`src/lib/htmlPage.ts` 已经有 `htmlToText()`，`htmlExcerpt()` 就是它的包装。
需要的是在 `library.ts` 里加一个按 kind 分流的 `plainTextOf(note)`，`plainOf()` / `buildSnippet()` 共用它。

## 三、改的时候别踩的坑

1. **不要把两条标题链合并成一条**。`deriveTitle()` 的首行兜底对 HTML 是错的
   （HTML 的「第一行」多半是 `<!doctype html>`）；反过来 `htmlTitle()` 的 `<title>` 对
   Markdown 不存在。它们只是形状像。
2. **不要改 `stripMarkdown()` 让它认 HTML**。它同时被字数统计（`countText()`）、
   标签派生、导出的纯文本用着；让它在 HTML 上「稍微正确一点」会让 Markdown 的行为跟着变。
3. **D1 与 D2 必须一起改**。只改摘要不改索引，摘要会从索引里不存在的偏移截取，
   症状比现在更怪（摘要从半句话开始）。
4. **现有用例没有覆盖这一面**：`src/data/library.regression.test.ts` 里的搜索用例全是 `.md`。
   改完要补，否则下次重构会把它们改回去而没人知道。

## 四、验收

改完之后至少要过：

```
pnpm typecheck:all
pnpm test          # 新增断言见下
pnpm check:boundaries
pnpm probe:page    # 不受影响，但要确认没回到红
```

建议补的断言（都放 `src/data/library.files.test.ts` 的「HTML 页面」一节，或新建一节）：

1. 搜一个含 `<style>` 与 `<script>` 的页面，命中的 `snippet` **不含** `{color` / `document.` /
   `<`（即已剥成纯文本）；
2. 只有 CSS 用到 `fff` 的页面，搜 `fff` **不命中**；
3. 同一页面搜它正文里的一个词，**命中**且 `snippet` 包含那个词（防「什么都搜不到」的假绿）；
4. 图标：给 `NoteRow` / `TrashList` / `SearchBody` 各一条静态渲染断言，diff 里出现 `kind === "html"`。

## 附：本次记录涉及的文件

| 文件 | 与本次记录的关系 |
| --- | --- |
| `src/lib/htmlPage.ts` | `htmlTitle()` / `htmlFallbackTitle()` / `htmlToText()`（已有，D1/D2 复用它） |
| `src/lib/utils.ts` | `deriveTitle()`（`:71`）、`stripMarkdown()`（`:189`，**不要改**） |
| `src/data/library.ts` | `makeNote:384`、`refresh:408`、override 挂回 `:673`、D2 的 `plainOf:3258`、D1 的 `buildSnippet:3318` |
| `src/components/Sidebar.tsx` | 已改对 `:1032` / `:1041`；待改 `:1176`（D3）、`:1352`（D4）、`:1263`（D5） |
