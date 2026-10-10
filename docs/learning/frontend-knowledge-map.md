# opennote 前端知识地图

> 一份给「会写代码、但没做过前端、也不熟 React/TypeScript」的中文开发者的可执行学习路线 + 资源清单。
> 所有资源都以**一手来源**为准（官方文档 / 作者站点 / 出版社页 / W3C·TC39 规范），并在 §14 标注核实状态。

---

## 目录

- [0. 阅读约定](#0-阅读约定)
- [1. 你的起点：opennote 客观技术画像](#1-你的起点opennote-客观技术画像)
- [2. 路线总览](#2-路线总览)
- [3. 阶段 0：环境与心智模型](#3-阶段-0环境与心智模型)
- [4. 阶段 1：HTML + CSS](#4-阶段-1html--css)
- [5. 阶段 2：JavaScript 深入](#5-阶段-2javascript-深入)
- [6. 阶段 3：TypeScript](#6-阶段-3typescript)
- [7. 阶段 4：React 19](#7-阶段-4react-19)
- [8. 阶段 5：前端设计与 UI/UX（你的弱项，重点章节）](#8-阶段-5前端设计与-uiux你的弱项重点章节)
- [9. 阶段 6：工程化与质量](#9-阶段-6工程化与质量)
- [10. 阶段 7：进阶专题（opennote 实际用到的）](#10-阶段-7进阶专题opennote-实际用到的)
- [11. 资源总清单](#11-资源总清单)
- [12. 针对 opennote 的 6 周落地计划](#12-针对-opennote-的-6-周落地计划)
- [13. 英语一般怎么读 & 8 个常见误区](#13-英语一般怎么读--8-个常见误区)
- [14. 核实状态附录](#14-核实状态附录)

---

## 0. 阅读约定

**核实标记**（每条资源都带一个）：

| 标记 | 含义 |
| --- | --- |
| ✅ 已抓取 | 我用 web_fetch 实际抓取了该页面，返回 HTTP 200 且标题/内容与描述匹配 |
| 🔍 搜索核实 | 该官方页面出现在搜索结果中且标题匹配（网站在线、被索引），但我没有逐字抓取正文 |
| ⚠️ [未核实] | 抓取失败（403 / 超时 / 页面不存在）或只见到间接引用。**按未核实对待** |

**语言 / 费用标记**：`中文`、`英文`、`中英双语`、`免费`、`部分免费`、`付费`。

**"英语一般也能读"提示**：凡是标 `英文` 的资源，如果正文是**代码 + 短句**型（文档、API 参考、规范），用浏览器翻译 + 术语表就能读；只有**长散文型**（书、博客随笔）才真正吃英语。下面每条我会写明属于哪一类。

**时间估算假设**：每天 1.5–2 小时、每周 5 天 ≈ **每周 8–10 小时**。所有"大概多久"按这个速率给。

---

## 1. 你的起点：opennote 客观技术画像

这一节不是评价，是**事实基线**——后面每条建议都要能对上这些事实。以下数字来自仓库实际读取（`package.json`、`tsconfig.json`、`vitest.config.ts`、`node_modules/*/package.json`）。

| 维度 | 实际值 | 对你的含义 |
| --- | --- | --- |
| React | `react` / `react-dom` **19.3.0** | 学 react.dev 上的 v19 文档，不要看 v16/v17 的老教程（`componentWillMount`、类组件那套已经过时） |
| TypeScript | `typescript` **7.0.2**（`tsconfig.json` `strict: true`） | 你面对的是**全量 strict + noUnusedLocals**，不是"随便写写的 TS" |
| 构建 | `vite` **8.3.1** + `@vitejs/plugin-react` **6.1.1** | Vite 8 是原生 ESM dev server，理解 ESM 是理解热更新的前提 |
| 测试 | `vitest` **5.0.2**，`environment: "node"` | **没有 jsdom、没有 @testing-library、没有 Playwright**（见下） |
| 源码规模 | 141 个 `.ts` + 19 个 `.tsx` + 6 个 `.css` ≈ 4.5 万行 | `.tsx` 只有 19 个 → **React 只是薄薄一层视图**，逻辑几乎全在纯 TS 模块里 |
| 测试文件 | `src/**/*.test.ts` 共 **65** 个 | 测试覆盖集中在纯逻辑（`src/data`、`src/lib`、`src/editor`、`src/fs`） |
| 样式 | 手写 CSS，无 Tailwind / 无 CSS-in-JS / 无组件库；`src/styles/` 共 6 个文件，`app.css` 2693 行 | 你**必须**懂 CSS，没有框架替你兜底 |
| 设计令牌 | `src/styles/tokens.css`（257 行）已有 `--s1`…`--s7` 间距、`--dur*` 动效、4 套 `[data-theme]` 配色 | 这是全仓库最值得先读的文件，也是"设计系统"的真实教材 |
| 状态管理 | `src/lib/store.ts`（39 行）用 `useSyncExternalStore` 自研极简 store | 别人用 Redux/Zustand 的地方，opennote 用 39 行原生 API 解决了 |
| 编辑器 | CodeMirror 6（`@codemirror/*`）+ Lezer（`@lezer/*`） | 阶段 7 的核心，也是最难的部分 |
| 多端 | Electron 44 + electron-builder、`@capacitor/android` + `@capacitor/filesystem`、自研剪藏扩展 | "Web 技术做多端"的完整样本 |

**五条关键观察**（决定了学习顺序）：

1. **逻辑在 TS，视图在 React。** 19 个 `.tsx` vs 141 个 `.ts`。所以 **TypeScript 的优先级高于 React**——你写的多数代码是纯 TS 模块。
2. **没有 UI 框架。** 样式全靠手写 CSS + 设计令牌。所以 **CSS 的优先级也高于 React**。
3. **测试环境是 `node`，不是浏览器。** `vitest.config.ts` 里 `environment: "node"`，且 `package.json` 里**没有** `jsdom` / `happy-dom` / `@testing-library/*` / `playwright` / `eslint` / `prettier`。这意味着：现有测试只能测**纯逻辑**，测不了 DOM 交互。想测 React 组件，你需要先自己引入这些依赖（属于"进阶可选项"，不是必修）。
4. **`strict: true` + `noUnusedLocals` + `verbatimModuleSyntax`。** 你写的每一行都要通过严格检查，`any` 会很难混过去。
5. **性能是真实需求。** `src/editor/livePreview.ts` 里有 `MAX_DECORATED_LENGTH = 800_000` 这样的阈值和实测注释（`D24_BENCH=1 npx vitest run src/editor/perfD24.test.ts`）。大文档性能不是纸上谈兵。

---

## 2. 路线总览

| 阶段 | 主题 | 建议时长 | 够用的标准（一句话） |
| --- | --- | --- | --- |
| 0 | 环境与心智模型 | 8–12 h | 能独立解释「我改了一行 `.ts`，浏览器里发生了什么」 |
| 1 | HTML + CSS | 40–50 h | 能不看教程手写一个响应式三栏布局，并说清为什么某条样式赢了 |
| 2 | JavaScript 深入 | 40–50 h | 能预测一段含 `async`/闭包/事件回调的代码的执行顺序 |
| 3 | TypeScript | 30–40 h | 能把 `unknown` 收窄成具体类型，而不是到处 `as any` |
| 4 | React 19 | 35–45 h | 能判断「这个状态该不该放进 React」，并解释一次 re-render 的成因 |
| 5 | **前端设计 / UI-UX** | **30–40 h** | 能对任一界面说出 5 条具体可改的问题 + 怎么改 |
| 6 | 工程化与质量 | 25–35 h | 能读懂 `vite.config.ts`，能写一个能跑的测试，能看懂 Performance 面板 |
| 7 | 进阶专题 | 40–60 h（按需） | 能读懂 `livePreview.ts` 的 decoration 策略并改一个小功能 |

**总计约 250–330 小时**。按每周 8–10 小时 ≈ **7–9 个月**到"能独立改 opennote 的任何一层"。好消息是你不用等学完再动手——第 12 节的 6 周计划就是边学边在该仓库里练。

**给"没时间"的最短路径**（只选一条就必须选这条）：阶段 1（CSS）+ 阶段 5（设计）。React 和 TS 你读文档能补，**审美和 CSS 感觉补不了**，而且 opennote 恰好是一个"样式全手写"的项目。

---

## 3. 阶段 0：环境与心智模型

### 先学什么（按顺序）

1. **运行时分层**：浏览器 JS 引擎 vs Node.js 运行时 vs 打包器。三者不是一回事。
2. **ESM 模块系统**：`import` / `export`、静态提升、`type="module"`、为什么 Vite 能秒开（原生 ESM dev server）。
3. **包管理**：`package.json` 的 `dependencies` vs `devDependencies`、语义化版本 `^`、lockfile 的作用、`node_modules` 为什么会那么大。
4. **pnpm 与 workspace**：为什么仓库用 pnpm 而不是 npm（硬链接 + 严格依赖隔离）。
5. **浏览器 DevTools 四件套**：Elements（DOM + 样式来源）、Console、Network、Sources（断点）。
6. **TypeScript 只是编译期**：`noEmit: true` + Vite 用 esbuild 抹掉类型 —— 这也解释了为什么 `pnpm build` 要先跑 `tsc --noEmit`。

### 推荐资源

| 资源 | 链接 | 语言 | 费用 | 核实 | 备注 |
| --- | --- | --- | --- | --- | --- |
| pnpm 官方文档 | https://pnpm.io/ | 英文（多语言站点） | 免费 | 🔍 | 只需读「Motivation」+「Workspace」两页；文档型，英语一般也能读 |
| Node.js 中文网 | https://nodejs.cn/ | 中文 | 免费 | 🔍 | 中文镜像站；官方英文为 https://nodejs.org/docs/latest/api/ |
| MDN — JavaScript 模块 | https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules | 英文（有中文版见 §11） | 免费 | 🔍 | 文档型；ESM 的权威解释 |
| MDN 学习区（起点总览） | https://developer.mozilla.org/en-US/docs/Learn_web_development | 英文（中文版 https://developer.mozilla.org/zh-CN/docs/Learn_web_development） | 免费 | ✅ | 先看它的目录结构，知道"整个前端有哪些块" |
| Chrome DevTools 官方文档 | https://developer.chrome.com/docs/devtools/ | 英文 | 免费 | 🔍 | 只看 Elements / Sources / Network 三章 |
| Chrome DevTools Performance 参考 | https://developer.chrome.com/docs/devtools/performance/reference | 英文 | 免费 | 🔍 | 阶段 6 再回头细读 |

### 大概多久
**8–12 小时**（约一周的业余时间）。不要在这一阶段读完整套文档——目标是"知道东西在哪"。

### 到什么程度算够用
- 能画出「浏览器请求 `index.html` → 加载 `src/main.tsx` → Vite 转换 TS/JSX → 模块图 → React 挂载到 `#root`」这条链路。
- 能在 DevTools 的 Elements 面板里点中一个元素，看到它的**最终生效样式和来源文件行号**（这是阶段 1 的前置技能）。
- 能解释 `pnpm dev` 和 `pnpm build` 的区别，以及为什么 `pnpm build` 先跑 `tsc --noEmit`。
- 能打开 Network 面板，看出哪些请求是源码模块、哪些是 `node_modules` 依赖。

### 在 opennote 里对着看
`package.json`（scripts + engines）、`vite.config.ts`、`vitest.config.ts`、`index.html`、`src/main.tsx`。

---

## 4. 阶段 1：HTML + CSS

> **这一阶段的权重被严重低估了。** opennote 有 6 个 CSS 文件、4600+ 行手写样式，没有任何框架替你写。你的 CSS 水平直接等于你的 UI 产出水平。

### 先学什么（严格按这个顺序）

1. **盒模型**：`content-box` vs `border-box`、`box-sizing` 为什么全球都设成 `border-box`。
2. **选择器与优先级**：类型/类/属性/伪类/ID 的权重、`!important` 的代价、`:where()`/`:is()` 对权重的零影响。
3. **层叠（Cascade）**：来源顺序 → 优先级 → 出现顺序；`@layer` 的意义。
4. **继承与初始值**：`inherit` / `initial` / `unset` / `revert` 的区别。
5. **Flexbox**：主轴/交叉轴、`flex-grow/shrink/basis`、`min-width: auto` 陷阱（这是 90% 的"flex 撑爆"问题根源）。
6. **Grid**：`fr` 单位、`minmax()`、`auto-fit` vs `auto-fill`、命名区域。
7. **响应式**：移动优先、`min-width` 媒体查询、容器查询（`@container`）、`clamp()` 流体尺寸。
8. **CSS 变量与设计令牌**：`:root` 作用域、变量回退、主题切换（`[data-theme]`）。
9. **现代布局无需媒体查询**：`flex-wrap` + `min-width` 实现"自动换行"。
10. **无障碍基础**：`<button>` vs `<div onclick>`、`:focus-visible`、对比度、语义化标签、键盘可达。
11. **动效克制**：`transition` 只加给需要反馈的属性、`prefers-reduced-motion`。

### 推荐资源

| 资源 | 链接 | 语言 | 费用 | 核实 | 备注 |
| --- | --- | --- | --- | --- | --- |
| **Learn CSS**（Andy Bell / Rachel Andrew / Una Kravets / Adam Argyle 合著） | https://web.dev/learn/css | 英文（中文站点 https://web.developers.google.cn/learn/css） | 免费 | ✅ | **本阶段首选**。30 个模块，从盒模型一路到 container queries / view transitions。文档型短句 + 交互 demo，英语一般也能读 |
| Learn Responsive Design | https://web.dev/learn/design | 英文（有中文） | 免费 | 🔍 | 响应式的系统课，比零散博客强 |
| MDN — Flexbox 基础概念 | https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_flexible_box_layout/Basic_concepts_of_flexbox | 英文（有中文） | 免费 | 🔍 | 卡住时查这里，不要查博客 |
| MDN — CSS Grid 布局 | https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_grid_layout | 英文（有中文） | 免费 | 🔍 | 同上 |
| MDN — 使用 CSS 自定义属性 | https://developer.mozilla.org/en-US/docs/Web/CSS/Using_CSS_custom_properties | 英文（有中文） | 免费 | 🔍 | 设计令牌的技术底座 |
| **Every Layout**（Heydon Pickering & Andy Bell，第 3 版） | https://every-layout.dev/ | 英文 | **部分免费**（rudiments + Stack / Sidebar / Switcher 免费；全本 $69） | ✅ | 教"算法式布局"：用 `flex-basis` / `min()` 让浏览器自己决定换行，而不是堆 `@media`。免费部分已足够改变你的布局思维 |
| 免费章节入口 | https://every-layout.dev/rudiments/boxes/ | 英文 | 免费 | ✅ | 从这个 rudiments 开始读 |
| CSS-Tricks — A Complete Guide to Flexbox | https://css-tricks.com/snippets/css/a-guide-to-flexbox/ | 英文 | 免费 | 🔍 | 当**速查表**用，不要当教材（图多、结构好，适合贴在显示器边上） |
| Grid by Example（Rachel Andrew） | https://gridbyexample.com/ | 英文 | 免费 | 🔍 | Grid 的"例子库"，每个模式一个可复制 demo |
| A11Y Project Checklist | https://www.a11yproject.com/checklist/ | 英文 | 免费 | ✅ | 46 条可勾选的无障碍清单，每条带 WCAG 条款号。**这是"改完怎么验收"的标准答案** |
| WCAG 2.2 规范 | https://www.w3.org/TR/WCAG22/ | 英文 | 免费 | ✅ | 规范本体，**不要通读**。只在 checklist 里点到某条时来查 |
| How to Meet WCAG 2.2（Quickref） | https://www.w3.org/WAI/WCAG22/quickref/ | 英文 | 免费 | 🔍 | 可筛选的速查版，比规范好用 |
| WAI-ARIA Authoring Practices Guide | https://www.w3.org/WAI/ARIA/apg/ | 英文 | 免费 | 🔍 | 想做 tab / menu / dialog 时看官方推荐键盘行为 |
| WebAIM Contrast Checker | https://webaim.org/resources/contrastchecker/ | 英文 | 免费 | 🔍（站点已确认在线） | 输入前景/背景色出对比度。opennote 有 4 套配色，这个工具是刚需 |
| caniuse | https://caniuse.com/ | 英文 | 免费 | 🔍 | 用某个 CSS 属性前先查兼容性 |

### 大概多久
**40–50 小时**。分配建议：盒模型 + 优先级 + 层叠 6h；Flexbox 10h；Grid 10h；响应式 8h；CSS 变量/令牌 6h；无障碍 6h；剩下时间做练习。

### 到什么程度算够用
- 看到一个布局能立刻判断"这该用 Grid 还是 Flex"。
- 样式不生效时，能在 DevTools 的 Computed 面板里 30 秒内定位是哪条规则赢了、为什么。
- 不写 `!important`，不靠 `margin-left: 37px` 这种魔数。
- 能手写一个 `grid-template-columns: repeat(auto-fit, minmax(240px, 1fr))` 且知道它为什么自适应。
- 知道 `outline: none` 是 bug 不是优化（除非同时给了替代的 `:focus-visible` 样式）。

### 在 opennote 里对着看
`src/styles/tokens.css`（**先读这个**，257 行，全站视觉的唯一产地）、`src/styles/base.css`（reset + 全局）、`src/styles/app.css`（2693 行，主力布局）、`src/styles/prose.css`（正文排版）、`src/styles/editor.css`（编辑器）。

---

## 5. 阶段 2：JavaScript 深入

### 先学什么

1. **执行上下文与作用域链** → 闭包（为什么 `useState` 的 setter 能记住状态）。
2. **`this` 的四种绑定** + 箭头函数为什么不绑定 `this`（React 里到处是箭头函数）。
3. **原型与 `class`**：`__proto__` vs `prototype`、`class` 只是语法糖。
4. **事件循环**：调用栈 / 宏任务 / 微任务；`Promise.then` 与 `setTimeout` 的顺序；`await` 到底暂停了什么。
5. **异步**：回调 → Promise → `async/await`；`Promise.all` / `allSettled` / `race`；错误传播。
6. **迭代协议**：`Symbol.iterator`、`for...of`、生成器（CodeMirror 里大量用到 iterable）。
7. **模块**：ESM 的静态结构与循环依赖问题。
8. **DOM 与事件**：事件冒泡/捕获、**事件委托**、`preventDefault` vs `stopPropagation`、`addEventListener` 的第三个参数。
9. **不可变更新**：展开运算符、`Object.is` 比较——**这是理解 React 重渲染的地基**。
10. **`useSyncExternalStore` 的前提**：`subscribe` 返回退订函数、快照必须稳定。

### 推荐资源

| 资源 | 链接 | 语言 | 费用 | 核实 | 备注 |
| --- | --- | --- | --- | --- | --- |
| **现代 JavaScript 教程（中文版）** | https://zh.javascript.info/ | **中文** | 免费 | ✅ | **中文世界最好的 JS 系统教程，没有之一。** 内容与英文版同源、持续更新（页脚显示最后修改于 2026-10-09）。第三部分含 IndexedDB、动画、事件循环等 opennote 直接用得上的章节 |
| 现代 JavaScript 教程（英文原版） | https://javascript.info/ | 英文 | 免费 | 🔍 | 中英对照读，术语用英文记 |
| **Eloquent JavaScript，第 4 版（2024）** | https://eloquentjavascript.net/ | 英文 | 免费在线阅读 | 🔍 | 长散文型，**英语一般读起来会累**；但它有大量可运行的交互示例，配合中译本《JavaScript 编程精解》读 |
| You Don't Know JS Yet（Kyle Simpson） | https://github.com/getify/You-Dont-Know-JS | 英文 | 免费（GitHub 全文） | 🔍 | 只读 `scope-closures` 和 `types-grammar` 两本，别全读 |
| MDN — 事件循环 | https://developer.mozilla.org/en-US/docs/Web/JavaScript/Event_loop | 英文（有中文） | 免费 | 🔍 | 想彻底搞懂微任务时读 |
| MDN — 原型链与继承 | https://developer.mozilla.org/en-US/docs/Web/JavaScript/Inheritance_and_the_prototype_chain | 英文（有中文） | 免费 | 🔍 | 权威且短 |
| MDN — Promise | https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise | 英文（有中文） | 免费 | 🔍 | 参考手册，配 javascript.info 的 Promise 章节读 |
| ECMAScript 语言规范（TC39） | https://tc39.es/ecma262/ | 英文 | 免费 | 🔍 | **只用来查"某个行为到底怎么定义的"**，不要通读。规范级一手来源 |
| 阮一峰《ECMAScript 6 入门》 | https://es6.ruanyifeng.com/ | 中文 | 免费在线阅读 | 🔍 | 中文经典，按特性组织。**注意**：它面向 ES6 增量，不能替代系统教程；适合当"某个新语法怎么用"的字典 |

### 大概多久
**40–50 小时**。如果已有编程基础，重点在事件循环（6h）、闭包（4h）、异步（10h）、DOM 事件（8h）、不可变更新（4h）、其余快速过。

### 到什么程度算够用
- 给一段代码，能说出打印顺序（含 `Promise` / `setTimeout` / `await` 混合）。
- 能徒手写一个事件委托，并解释为什么不给每个子元素绑定。
- 能解释 `arr.push()` 与 `[...arr, x]` 在 React 场景下的差别。
- 能解释 `src/lib/store.ts` 的 `set` 里为什么有 `if (Object.is(value, state)) return;`。
- 能读懂 `subscribe` 必须返回 `unsubscribe` 函数的原因。

### 在 opennote 里对着看
`src/lib/store.ts`（39 行，事件循环 + 不可变 + 订阅模型的浓缩教材）、`src/lib/utils.ts`、`src/fs/paths.ts`、`src/editor/settings.ts`。

---

## 6. 阶段 3：TypeScript

> opennote 是 `strict: true` + `noUnusedLocals` + `noUnusedParameters` + `verbatimModuleSyntax` + `isolatedModules`。你写的类型要对得起这套配置。

### 先学什么

1. **类型注解 vs 类型推断**：什么时候该写、什么时候写是噪音。
2. **`strict` 到底开了哪些开关**：`strictNullChecks`（最重要的一个）、`noImplicitAny`、`strictFunctionTypes` 等。
3. **联合类型与收窄**：`typeof` / `in` / `instanceof` / 判别式联合（discriminated union）/ 自定义类型守卫。
4. **`unknown` vs `any`**：为什么 `unknown` 是正确默认、`any` 是逃生舱。
5. **泛型**：约束 `extends`、默认类型参数、泛型在函数与类型别名里的位置。
6. **工具类型**：`Partial` / `Required` / `Pick` / `Omit` / `Record` / `ReturnType` / `Awaited`；`keyof`、索引访问类型、映射类型。
7. **`satisfies` 运算符**：既校验又保留字面量类型。
8. **`verbatimModuleSyntax` 的含义**：必须写 `import type { X }`，不能靠"编译器猜"。
9. **模块解析 `moduleResolution: "bundler"`**：为什么可以省 `.ts` 后缀。
10. **类型体操的边界**：什么时候该停手——**为一个只用一次的对象写 30 行条件类型是负债，不是资产。**

### 推荐资源

| 资源 | 链接 | 语言 | 费用 | 核实 | 备注 |
| --- | --- | --- | --- | --- | --- |
| **TypeScript 官方手册** | https://www.typescriptlang.org/docs/handbook/intro.html | 英文 | 免费 | 🔍 | **唯一权威**。至少读 Handbook 的 "Everyday Types / Narrowing / Generics / Object Types" 四章。文档型，英语一般也能读 |
| TSConfig 参考（每个选项的解释） | https://www.typescriptlang.org/tsconfig/ | 英文 | 免费 | 🔍 | 对着 opennote 的 `tsconfig.json` 一条条查，**这是最快的 strict 模式入门法** |
| tsconfig.json 是什么 | https://www.typescriptlang.org/docs/handbook/tsconfig-json.html | 英文 | 免费 | 🔍 | 短，先读 |
| TypeScript Deep Dive（Basarat Ali Syed） | https://basarat.gitbook.io/typescript/ | 英文 | 免费在线 | 🔍 | 免费、实战向，讲得比官方手册更"人话"。注意部分章节可能滞后于 TS 7 |
| **type-challenges** | https://github.com/type-challenges/type-challenges | 英文（题目简短） | 免费 | 🔍 | 类型体操的"练习题集"，从 Easy 开始做。**用它来理解边界，不要用它来炫技** |
| Total TypeScript（Matt Pocock） | https://www.totaltypescript.com/ | 英文 | 部分免费（有免费教程，进阶课程付费） | 🔍 | 免费部分质量很高；付费课程是取舍问题——**先做完 type-challenges Easy/Medium 再考虑** |
| Effective TypeScript，第 2 版（Dan Vanderkam，O'Reilly） | 书；官方书页见 §14 | 英文 | 付费 | ⚠️ 书页未核实 | 83 条具体建议，中高级必读。**但你现阶段不需要**——等你能读懂 opennote 全部类型后再买 |
| 第三方中文《TypeScript 使用手册》翻译 | https://github.com/zhongsp/TypeScript | 中文 | 免费 | 🔍 | **非官方、可能滞后**。仅作术语对照用，遇到分歧以官方英文为准 |

### 大概多久
**30–40 小时**。分配：基础类型与收窄 12h；泛型 8h；工具类型 6h；`satisfies`/模块语法 4h；type-challenges Easy 20 题 6h。

### 到什么程度算够用
- 拿到一个 `unknown`，能用类型守卫和判别式联合收窄成具体类型，而不是 `as any`。
- 能解释 `src/data/types.ts` 里每个类型为什么这么设计。
- 能写出一个接受泛型并返回正确类型的工具函数。
- **能判断"这里不值得写类型"**：一个只在单文件内使用三次的中间对象，让它推断就好。
- 打开任何 `.ts` 文件，`tsc --noEmit` 不会因为你的改动报新错。

### 在 opennote 里对着看
`tsconfig.json`、`src/data/types.ts`、`src/fs/types.ts`、`src/fs/index.ts`（backends 的抽象接口）、`src/data/library.ts`（3194 行，类型最密集的地方，**别想一次读完，按功能读**）。

---

## 7. 阶段 4：React 19

> 先纠正一个常见误解：opennote 里 React **不是主角**。19 个 `.tsx`，最大的 `Sidebar.tsx` 1398 行，而逻辑全在 `src/data/*.ts` 和 `src/lib/*.ts`。所以学 React 的目标不是"精通 React"，而是**"看懂这 19 个文件，并且知道状态该放哪儿"**。

### 先学什么

1. **组件即函数**：props 入、JSX 出；JSX 编译成什么。
2. **props 与单向数据流**：为什么 props 不可变、回调怎么往下传。
3. **`useState`**：状态是快照不是变量、批量更新、函数式更新 `setX(x => x+1)`。
4. **渲染与提交（render & commit）**：React 何时重渲染、何时操作 DOM；`key` 的真正作用。
5. **列表与 `key`**：为什么用数组下标当 key 会导致输入框错位。
6. **受控组件**：`value` + `onChange` 模式；CodeMirror 这类"非受控"库怎么和 React 相处（opennote 用 `EditorPane.tsx` + `src/editor/bridge.ts` 处理）。
7. **`useEffect` 的正确用途**：同步外部系统，**不是**"数据变了就处理数据"。
8. **⚠️ 「You Might Not Need an Effect」**：这是 React 官方文档里最有价值的一篇，直接决定你会不会写出一堆互相触发的 effect。
9. **`useMemo` / `useCallback` / `memo`**：什么时候有用、什么时候是纯开销（Dan Abramov 的「Before You memo()」）。
10. **`useRef`**：跨渲染保存值、拿 DOM 引用。
11. **`useSyncExternalStore`**：订阅外部 store 的官方 API——**opennote 全站状态层就建立在这上面**。
12. **Context**：解决"层层传 props"，以及它的重渲染代价。
13. **Suspense / 并发特性**：`useTransition`、`useDeferredValue`（搜索、大列表过滤时有用）。
14. **React 19 新东西**：Actions、`useActionState`、`useOptimistic`、`ref` 作为 prop、`use()`。
15. **React Compiler**（可选）：自动 memo 化，理解它为什么可能让你不再需要手写 `useMemo`。
16. **反模式清单**：在渲染中改状态、用 `useEffect` 派生状态、用 `useState` 存可以从 props 算出来的值、`key` 用下标、把大对象放进 Context。

### 推荐资源

| 资源 | 链接 | 语言 | 费用 | 核实 | 备注 |
| --- | --- | --- | --- | --- | --- |
| **React 官方文档（新版）** | https://react.dev/learn | 英文 | 免费 | 🔍 | 2023 年重写的官方文档，**质量碾压所有第三方教程**。文档型，英语一般也能读 |
| **React 官方中文文档** | https://zh-hans.react.dev/learn | **中文** | 免费 | 🔍 | 官方维护的简体中文翻译（社区翻译但由 React 团队托管）。**优先读这个** |
| React 19 发布公告 | https://react.dev/blog/2024/12/05/react-19 | 英文 | 免费 | 🔍 | 一页看清新特性；中文版 https://zh-hans.react.dev/blog/2024/12/05/react-19 |
| **You Might Not Need an Effect** ⭐ | https://react.dev/learn/you-might-not-need-an-effect | 英文（中文版 https://zh-hans.react.dev/learn/you-might-not-need-an-effect） | 免费 | 🔍 | **本篇是本阶段最高优先级的单篇文档。** 读完你会删掉自己一半的 useEffect |
| Render and Commit | https://react.dev/learn/render-and-commit | 英文（有中文） | 免费 | 🔍 | 理解"一次重渲染"到底发生了什么 |
| Thinking in React | https://react.dev/learn/thinking-in-react | 英文（有中文） | 免费 | 🔍 | 从设计稿到组件树的官方方法论 |
| `useSyncExternalStore` 参考 | https://react.dev/reference/react/useSyncExternalStore | 英文（有中文） | 免费 | 🔍 | **对着 `src/lib/store.ts` 读这篇，一次就懂** |
| Synchronizing with Effects | https://react.dev/learn/synchronizing-with-effects | 英文（有中文） | 免费 | 🔍 | effect 的正确心智模型 |
| Suspense 参考 | https://react.dev/reference/react/Suspense | 英文（有中文） | 免费 | 🔍 | 阶段 4 后期读 |
| React Compiler 简介 | https://react.dev/learn/react-compiler | 英文（有中文） | 免费 | 🔍 | 了解趋势即可，别急着上 |
| **overreacted.io**（Dan Abramov，React 团队成员） | https://overreacted.io/ | 英文 | 免费 | ✅ | **活跃**（2025–2026 仍在更新）。必读三篇：`/react-as-a-ui-runtime/`、`/a-complete-guide-to-useeffect/`、`/before-you-memo/`。长散文型，英语一般**建议配翻译**读 |
| React as a UI Runtime | https://overreacted.io/react-as-a-ui-runtime/ | 英文 | 免费 | ✅ | 理解 React 编程模型最深的一篇 |
| A Complete Guide to useEffect | https://overreacted.io/a-complete-guide-to-useeffect/ | 英文 | 免费 | ✅ | effect 的经典长文，仍适用于 v19 的心智 |
| Before You memo() | https://overreacted.io/before-you-memo/ | 英文 | 免费 | ✅ | 教你"先改结构，再谈性能" |
| patterns.dev | https://www.patterns.dev/ | 英文 | 免费 | 🔍 | 设计/渲染/性能模式的免费在线书，React 章节质量高 |
| Josh Comeau 的博客 | https://www.joshwcomeau.com/ | 英文 | 免费 | 🔍 | **CSS + React 交互解释的天花板**，配大量可视化。英语一般也能读（代码驱动） |
| The Joy of React（Josh Comeau） | https://www.joyofreact.com/ | 英文 | 付费 | 🔍 | 公认最好的付费 React 课之一。**取舍**：官方文档免费且够用，只有在"文档读不进去、需要人带着做项目"时才买 |
| Epic React（Kent C. Dodds） | https://www.epicreact.dev/ | 英文 | 付费 | 🔍 | 另一门顶级付费课。同样建议先用完免费资源 |

### 大概多久
**35–45 小时**。别跳「You Might Not Need an Effect」和 `useSyncExternalStore` 这两篇。

### 到什么程度算够用
- 能回答："`useState` 里存的这个值，能不能从 props 算出来？"——如果能，就不该有状态。
- 能解释一次点击触发了哪些组件的重渲染，以及为什么。
- 能手写一个订阅外部 store 的 hook（用 `useSyncExternalStore`）。
- 能看出 `useEffect` 里不该写的三种逻辑，并改成渲染期计算 / 事件处理器 / 派生变量。
- 能读懂 `src/components/StatusBar.tsx` 的每个 prop 从哪来。
- 遇到"要不要用 Context / 要不要装状态库"时，能先问"opennote 用 39 行 store 就够了吗"。

### 在 opennote 里对着看
`src/lib/store.ts`（**先读，39 行**）、`src/components/StatusBar.tsx`（146 行纯展示组件，最好的入门样张）、`src/components/TabBar.tsx`（95 行）、`src/components/Outline.tsx`（47 行，最小）、`src/components/Sidebar.tsx`（1398 行，**反例/挑战**）、`src/App.tsx`（组件树总览）、`src/components/EditorPane.tsx` + `src/editor/bridge.ts`（React 与 CodeMirror 的边界）。

---

## 8. 阶段 5：前端设计与 UI/UX（你的弱项，重点章节）

> 这是你明确说的短板，也是**最不能靠"多写多练"解决**的部分。设计是**可拆解、可命名、可检查**的技能，不是天赋。这一节给的是"审查一个界面好不好"的具体方法。

### 先建立 3 个心智模型

**模型一：视觉层级 = 让眼睛知道先看哪。**
层级不是靠"加大加粗"，而是靠**对比**：大小、字重、颜色深浅、留白、位置。Refactoring UI 的核心论点：`Not all elements are equal` —— 如果一个界面里所有东西都在喊，那就没有东西被听见。

**模型二：间距系统 > 单个像素。**
不要每次手写 `padding: 13px`。定一套刻度（opennote 已有：`--s1: 4px` … `--s7: 48px`），所有间距从这个刻度里取。**规则：相邻元素用更小的刻度，不相关的组之间用更大的刻度——这就是"避免含糊间距"（Avoid ambiguous spacing）。**

**模型三：设计令牌 = 设计决策的单一产地。**
颜色、间距、字号、圆角、阴影、动效曲线，全部变成变量。这样"换配色"只是换一组变量值。opennote 的 `src/styles/tokens.css` 就是这个模型的教科书实现（4 套 `[data-theme]` 只改值不改结构）。

### 先学什么（按顺序）

1. **视觉层级**：如何用 3 个手段（大小 / 字重 / 颜色）建立 3 级层级。
2. **间距系统**：8pt 网格或 4pt 基准、亲密性原则、组内 vs 组间。
3. **字体排印**：字号阶梯（type scale）、行高与字号成正比、行长（45–75 字符）、字体的性格（衬线 vs 无衬线）、CJK 与拉丁混排。
4. **色彩**：HSL 思维、不要用纯灰（给灰加一点色相）、每个色要 8–10 档明度、对比度必须达标（正文 4.5:1）。
5. **栅格与布局**：Grid 的 `minmax`、内容驱动宽度、不要"填满整屏"。
6. **深度**：阴影模拟光源（统一光源方向）、用阴影表达层级而不是装饰、边框能少就少。
7. **交互反馈**：hover / active / focus / disabled / loading / empty / error 七态**每一态都要设计**（`Don't overlook empty states`）。
8. **动效克制**：动效只用来解释"发生了什么"，时长 120–250ms、`ease-out`、尊重 `prefers-reduced-motion`。
9. **设计系统与令牌**：从「原子设计」到 DTCG 令牌标准。
10. **可访问性作为设计约束**：不是事后补丁，是布局阶段的输入。
11. **审查方法**：见本节末尾的「界面审查 8 问」。

### 推荐资源

| 资源 | 链接 | 语言 | 费用 | 核实 | 备注 |
| --- | --- | --- | --- | --- | --- |
| **Refactoring UI**（Adam Wathan & Steve Schoger，Tailwind CSS 作者） ⭐ | https://refactoringui.com/ | 英文 | **付费**（可领 2 个免费章节） | ✅ | **本阶段第一推荐，也是唯一值得你花钱的。** 50 章全是**可执行战术**：`Establish a spacing and sizing system`、`Establish a type scale`、`Use fewer borders`、`Don't use grey text on colored backgrounds`、`Not all elements are equal`。它明确是"写给开发者的设计书"——正是你的处境。长散文但句子短、图占一半，**英语一般也能读** |
| **Butterick's Practical Typography，第 2 版** | https://practicaltypography.com/ | 英文 | **免费在线**（reader-supported，可自愿付费） | ✅ | **排印圣经，且免费。** 先读这两页就够用一年：[Typography in ten minutes](https://practicaltypography.com/typography-in-ten-minutes.html)、[Summary of key rules](https://practicaltypography.com/summary-of-key-rules.html)。opennote 的 `src/styles/prose.css` 就是排印规则的实践场 |
| Every Layout（同 §4） | https://every-layout.dev/ | 英文 | 部分免费 | ✅ | 布局与留白的"算法化"思路，同时属于阶段 5 |
| Inclusive Components（Heydon Pickering） | https://inclusive-components.design/ | 英文 | 免费博客（书为付费） | ✅ | "一个博客装作是模式库"——11 个组件的无障碍实现（card / data table / notification / tabs / menu button / theme switcher / toggle button）。**和你的 `InboxPanel`、`Overlays` 直接相关** |
| Atomic Design（Brad Frost，在线免费版） | https://atomicdesign.bradfrost.com/ | 英文 | 免费在线 | 🔍 | 组件化设计的经典分层：atoms → molecules → organisms → templates → pages。用来给组件命名和分级 |
| Design Tokens Format Module（W3C Design Tokens CG，2025.10） | https://www.w3.org/community/reports/design-tokens/CG-FINAL-format-20251028/ | 英文 | 免费 | 🔍 | 设计令牌的**规范**。想看"业界把令牌标准化成什么样"就读这个；实践看 tokens.css 更快 |
| Material Design 3 | https://m3.material.io/ | 英文（多语言） | 免费 | 🔍 | Google 的设计系统。**当作参考手册**：想知道"标准对话框/菜单/状态该长什么样"就查它 |
| Apple Human Interface Guidelines | https://developer.apple.com/design/human-interface-guidelines | 英文（多语言） | 免费 | 🔍 | 另一套权威系统观。**Typography 与 Layout 两章对排版最有启发** |
| Laws of UX（Jon Yablonski） | https://lawsofux.com/ | 英文 | 免费 | 🔍 | 30+ 条交互心理学定律（Fitts、Hick、Jakob、Miller）。每条一页，**适合当灵感卡牌**随机抽读 |
| Nielsen Norman Group 文章库 | https://www.nngroup.com/articles/ | 英文 | 免费（部分报告付费） | 🔍 | 可用性研究的**一手来源**（Jakob Nielsen、Don Norman 创立）。查"表单怎么设计""空状态怎么写"最权威 |
| Smashing Magazine | https://www.smashingmagazine.com/ | 英文 | 免费 | 🔍 | 长文质量高，设计 + 前端各半 |
| A List Apart | https://alistapart.com/ | 英文 | 免费 | 🔍 | 老牌、偏"设计哲学与标准"，适合建立品味 |
| Google Fonts Knowledge | https://fonts.google.com/knowledge | 英文 | 免费 | 🔍 | Google 的字体知识库，讲字形/配对/可读性，比零散博客系统 |
| The Non-Designer's Design Book，第 4 版（Robin Williams） | https://www.peachpit.com/store/non-designers-design-book-9780133966367 | 英文（中文版《写给大家看的设计书》见下） | 付费 | 🔍 | 极经典的入门书，四个原则（对比/重复/对齐/亲密性）。**中文版见下行** |
| 《写给大家看的设计书》（中文版，Robin Williams） | https://book.douban.com/works/1021797 | **中文** | 付费 | 🔍 | 上面那本的中译本（多个版本，第 3/4 版）。**如果你只想买一本中文设计书，就买它** |
| 《点石成金：访客至上的 Web 和移动可用性设计秘笈》（Don't Make Me Think 中文版） | https://book.douban.com/subject/26313852/ | **中文** | 付费 | 🔍 | 可用性入门，薄、好读、直接可操作 |
| 《设计心理学》（The Design of Everyday Things 中文版，Don Norman） | https://read.douban.com/bundle/126023088/ | **中文** | 付费 | 🔍 | 设计思维的地基（可供性、意符、映射、反馈）。**不是讲界面，但讲清了"为什么用户会困惑"** |
| Figma Resource Library | https://www.figma.com/resource-library/ | 英文（多语言） | 免费 | 🔍 | 灵感 + 方法文章库，看别人怎么组织界面 |
| Grid by Example | https://gridbyexample.com/ | 英文 | 免费 | 🔍 | 栅格的实例库 |

### 大概多久
**30–40 小时**，且**必须配练习**。分配：Refactoring UI 通读 + 做笔记 10h；Practical Typography 精读 6h；tokens.css + base.css 审计实操 8h；对比度与无障碍审查 6h；抄改优秀界面 10h（见下）。

### 一个被低估的练习法：**"抄 — 改 — 破"**

1. **抄**：找一个你喜欢的笔记/编辑器界面截图（Typora、Obsidian、Bear、iA Writer），用浏览器 DevTools 覆盖在 opennote 上，逐项量它的间距、字号、行高。
2. **改**：在 `src/styles/tokens.css` 里只改**变量值**（不动任何结构代码），看能否逼近那个观感。
3. **破**：故意把 `--s*` 刻度打乱、把配色换成纯灰，观察界面"塌掉"的过程——这比读十篇文章更能建立对系统的直觉。

### "到什么程度算够用"：**界面审查 8 问**

拿到任何一个界面（包括 opennote 的 `docs/screenshot.png`），按这 8 条逐条问，**每条都要能给出"改哪里、改成什么"**：

1. **层级**：眯眼看，第一眼落在哪？是否是我希望用户第一眼看的地方？次级信息是否真的退后了？
2. **间距**：相邻元素的间距是否**更小**于不相关组的间距？有没有"说不清为什么是 13px"的值？
3. **排印**：正文行长是否在 45–75 字符？标题到正文是否有明显层级（不是只差 1px）？中英文混排是否协调？
4. **色彩**：正文对比度是否 ≥ 4.5:1？灰色是否带一点色相？除了颜色，状态是否还有第二种区分方式（图标/文字/形状）？
5. **状态**：hover / active / focus-visible / disabled / loading / empty / error —— 七态齐全吗？空状态有没有告诉用户"该做什么"？
6. **深度**：阴影方向是否统一？边框是否过多（"能用阴影或背景色区分就别用边框"）？
7. **动效**：有没有 > 300ms 的动效？有没有 `prefers-reduced-motion` 兜底？动效是否在解释因果？
8. **无障碍**：键盘能走通全流程吗？焦点可见吗？`alt` 齐全吗？`<button>` 和 `<a>` 用对了吗？（用 §4 的 A11Y checklist 逐条勾）

> **合格线**：你能对任意界面产出「5 条具体问题 + 每条的具体改法」，而不是"感觉不太好看"。

### 在 opennote 里对着看
`src/styles/tokens.css`（**全站设计决策的单一产地**，4 套配色 `paper` / `celadon` / `sepia` / `night`）、`src/styles/prose.css`（CJK + 拉丁混排的排印实践）、`src/styles/base.css`、`src/styles/app.css`、`docs/screenshot.png` 与 `docs/screenshot-dark.png`（拿来做审查练习的样张）。

---

## 9. 阶段 6：工程化与质量

> 现实提醒：opennote **没有** ESLint / Prettier / Playwright / Testing Library / jsdom。所以这一阶段的"推荐资源"里有一部分是**你未来可以引入的**，不是仓库现状。我会明确标注。

### 先学什么

1. **Vite**：dev server 的原生 ESM 机制、HMR 原理、`build` 的产物结构、`define` / `resolve.alias` / `build.rollupOptions`、插件机制。
2. **Vitest**：`describe/it/expect`、mock（`vi.fn` / `vi.spyOn` / `vi.mock`）、`environment` 的差别（node vs jsdom）、覆盖率的含义与误导性。
3. **测试策略**：先测**纯逻辑**（这也是 opennote 现状）；组件测试与 E2E 是后加的。
4. **Testing Library 思想**：测"用户看到什么"而不是"组件内部有什么"。
5. **Playwright**：E2E 与跨浏览器验证；`trace` 调试。
6. **Lint / Format**：ESLint 的 flat config、`typescript-eslint`、Prettier 的分工（lint 管正确性，format 管风格）。
7. **性能剖析**：Performance 面板读火焰图、Long Task、Layout Shift、Memory 面板查泄漏。
8. **Web 性能指标**：LCP / INP / CLS 的定义与常见杀手。
9. **PWA / Service Worker**：离线策略（cache-first vs network-first）、`vite-plugin-pwa` 做什么。
10. **多端打包**：Electron 的主进程 vs 渲染进程、`contextIsolation`、Capacitor 的 WebView + 原生插件桥。

### 推荐资源

| 资源 | 链接 | 语言 | 费用 | 核实 | 备注 |
| --- | --- | --- | --- | --- | --- |
| Vite 官方指南（中文） | https://cn.vite.dev/guide/ | **中文** | 免费 | 🔍 | 官方中文站。对着 `vite.config.ts` 读「配置 Vite」「构建生产版本」 |
| Vite 官方指南（英文） | https://vite.dev/guide/ | 英文 | 免费 | 🔍 | 版本更新时以英文站为准 |
| Vitest 官方指南 | https://vitest.dev/guide/ | 英文 | 免费 | 🔍 | 中文文档在 https://cn.vitest.dev/ （社区翻译，🔍） |
| Testing Library — React | https://testing-library.com/docs/react-testing-library/intro/ | 英文 | 免费 | ✅ | **注意：opennote 当前没有它。** 想测 React 组件时才需要引入 |
| Playwright 官方文档 | https://playwright.dev/docs/intro | 英文 | 免费 | 🔍 | **同样未在仓库中。** 想做 E2E 时读；`playwright.dev` 站点已确认在线 |
| web.dev — Learn Testing | https://web.dev/learn/testing | 英文 | 免费 | 🔍 | 测试策略的系统课（其导航在 Learn CSS 页面已确认存在） |
| ESLint 官方文档 | https://eslint.org/docs/latest/ | 英文 | 免费 | 🔍 | 只在决定引入 lint 时读 |
| Prettier 官方文档 | https://prettier.io/docs/ | 英文 | 免费 | 🔍 | 同上 |
| Chrome DevTools — Performance 参考 | https://developer.chrome.com/docs/devtools/performance/reference | 英文 | 免费 | 🔍 | 面板每个字段的含义 |
| web.dev — Learn Performance | https://web.dev/learn/performance | 英文（有中文） | 免费 | 🔍 | 性能指标与优化手段的系统课 |
| web.dev — 渲染性能 | https://web.dev/articles/rendering-performance | 英文 | 免费 | 🔍 | 像素管线（layout / paint / composite）的基础 |
| web.dev — Learn PWA | https://web.dev/learn/pwa | 英文（有中文） | 免费 | 🔍 | 离线与安装，对着 `vite-plugin-pwa` 读 |
| PWA — 离线数据 | https://web.dev/learn/pwa/offline-data | 英文 | 免费 | 🔍 | 直接对应 opennote 的离线优先设计 |
| Electron 官方文档（中文） | https://www.electronjs.org/zh/docs/latest | **中文** | 免费 | 🔍 | 官方中文文档存在。重点读 Process Model 与 Context Isolation |
| Capacitor 官方文档 | https://capacitorjs.com/docs | 英文 | 免费 | 🔍 | 对着 `capacitor.config.ts` 与 `src/fs/capacitorBackend.ts` 读 |

### 大概多久
**25–35 小时**。Vite + Vitest 是刚需（12h），其余按需。

### 到什么程度算够用
- 能读懂 `vite.config.ts` 里每个插件是干什么的，并新增一个 `resolve.alias`。
- 能为一个纯逻辑模块写出测试，并在 `pnpm test` 里通过（且理解 `environment: "node"` 意味着什么）。
- 能在 Performance 面板录一次交互，指出最长的那个任务是什么。
- 能解释 `vite-plugin-pwa` 生成的 Service Worker 的缓存策略。
- 知道 Electron 主进程/渲染进程的边界，以及 `src/desktop/` 存在的意义。

### 在 opennote 里对着看
`vite.config.ts`（312 行）、`vitest.config.ts`（7 行）、`vite.clip.config.ts`、`capacitor.config.ts`、`.github/workflows/`、`electron/`、`scripts/`、`extension/`。

---

## 10. 阶段 7：进阶专题（opennote 实际用到的）

这一阶段不按"通用前端"组织，而是**按 opennote 的真实依赖**组织。每个专题都指向仓库里的真实文件。

### 7.1 CodeMirror 6 与 Lezer 语法树

**为什么**：`src/editor/` 下 20 个文件几乎都建立在 CodeMirror 6 的 `StateField` / `Decoration` / `Transaction` 模型上，而 CodeMirror 6 的架构（不可变 `EditorState` + 事务）本身就是"不可变数据 + 纯函数"的极致案例。

**学什么**：`EditorState` 不可变模型；`Transaction` 与 `dispatch`；`StateField` vs `ViewPlugin`；`Decoration`（mark / widget / replace）三种类型；`syntaxTree` 增量解析；`RangeSet` 的映射（`map`）；`WidgetType` 自定义渲染；大文档的性能取舍（`MAX_DECORATED_LENGTH = 800_000` 这种阈值从哪来）。

| 资源 | 链接 | 语言 | 费用 | 核实 |
| --- | --- | --- | --- | --- |
| **CodeMirror 6 官方文档总入口** ⭐ | https://codemirror.net/docs/ | 英文 | 免费 | ✅ |
| System Guide（架构与常见任务） | https://codemirror.net/docs/guide/ | 英文 | 免费 | 🔍 |
| Reference Manual（完整 API） | https://codemirror.net/docs/ref/ | 英文 | 免费 | 🔍 |
| Examples（Decorations 等实例） | https://codemirror.net/examples/ | 英文 | 免费 | 🔍 |
| 核心扩展清单 | https://codemirror.net/docs/extensions/ | 英文 | 免费 | 🔍 |
| 5 → 6 迁移指南（理解 6 的设计动机） | https://codemirror.net/docs/migration/ | 英文 | 免费 | 🔍 |
| **Lezer System Guide**（语法树） | https://lezer.codemirror.net/docs/guide/ | 英文 | 免费 | 🔍 |
| Lezer Reference Manual | https://lezer.codemirror.net/docs/ref/ | 英文 | 免费 | 🔍 |
| 官方论坛 | https://discuss.codemirror.net/ | 英文 | 免费 | ✅（文档页已确认链接） |

> 文档型，英语一般也能读——但**建议先读 `src/editor/livePreview.ts` 的注释**，作者已经把性能和设计取舍写在里面了（含实测数据）。

### 7.2 IndexedDB

**为什么**：`idb` 8 是直接依赖；离线优先笔记本的元数据、快照、导入日志都落在 IndexedDB。

**学什么**：object store / index / 事务 / 游标；为什么必须用 `idb` 而不是裸 API（回调地狱）；版本升级与 `onupgradeneeded`；与 `localStorage`（`src/data/ui.ts` 用的）的分工；OPFS / File System Access API 与 IndexedDB 的差别（`src/fs/opfs.ts`、`src/fs/fsa.ts`）。

| 资源 | 链接 | 语言 | 费用 | 核实 |
| --- | --- | --- | --- | --- |
| MDN — IndexedDB API | https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API | 英文（中文版可切） | 免费 | 🔍 |
| MDN — 使用 IndexedDB | https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB | 英文（中文版可切） | 免费 | 🔍 |
| idb 官方仓库（README 即文档） | https://github.com/jakearchibald/idb | 英文 | 免费 | ✅ |
| javascript.info — IndexedDB | https://zh.javascript.info/indexeddb | **中文** | 免费 | ✅（目录已确认有此章节） |
| MDN — 客户端存储 | https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Client-side_web_APIs/Client-side_storage | 英文（有中文） | 免费 | 🔍 |

### 7.3 大文档性能与虚拟列表

**为什么**：`src/editor/perfD24.test.ts` 里已有 benchmark；`InboxPanel.tsx`（1279 行）和 `Sidebar.tsx`（1398 行）渲染长列表。opennote **目前没有**引入虚拟列表库——这正是"什么时候该引入"的判断题。

**学什么**：为什么长列表卡（DOM 节点数 / 布局抖动 / 重排）；虚拟化的原理（只渲染视口内）；React 下的 memo 化与 `key` 稳定；`requestIdleCallback` / 时间切片；用 `performance.now()` 做微基准（看 `perfD24.test.ts` 怎么写的）。

| 资源 | 链接 | 语言 | 费用 | 核实 |
| --- | --- | --- | --- | --- |
| TanStack Virtual 文档 | https://tanstack.com/virtual/latest/docs/introduction | 英文 | 免费 | 🔍 |
| React Virtual（React 适配） | https://tanstack.com/virtual/latest/docs/framework/react/react-virtual | 英文 | 免费 | 🔍 |
| web.dev — 渲染性能 | https://web.dev/articles/rendering-performance | 英文 | 免费 | 🔍 |
| React 官方 — `useDeferredValue` | https://react.dev/reference/react/useDeferredValue | 英文（有中文） | 免费 | 🔍 |
| overreacted — Before You memo() | https://overreacted.io/before-you-memo/ | 英文 | 免费 | ✅ |

### 7.4 离线优先与同步冲突

**为什么**：`src/components/ConflictDialog.tsx`（265 行）就是冲突解决 UI；`src/lib/update.ts`、`src/lib/github/`、`src/data/library.watch.test.ts` 都在处理"文件被外部改动"。

**学什么**：离线优先的数据模型；last-write-wins 的代价；基于内容哈希的变更检测；三方合并 vs 冲突让用户选；时钟/版本向量；用户自选文件夹（File System Access API）带来的"外部修改"问题。

| 资源 | 链接 | 语言 | 费用 | 核实 |
| --- | --- | --- | --- | --- |
| web.dev — PWA 离线数据 | https://web.dev/learn/pwa/offline-data | 英文（有中文） | 免费 | 🔍 |
| MDN — File System API | https://developer.mozilla.org/en-US/docs/Web/API/File_System_API | 英文 | 免费 | 🔍 |
| MDN — 让 PWA 可安装 | https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable | 英文 | 免费 | 🔍 |
| web.dev — Learn PWA | https://web.dev/learn/pwa | 英文（有中文） | 免费 | 🔍 |

### 7.5 Markdown 渲染与 XSS 防护

**为什么**：`markdown-it` 15 + `dompurify` 3 + `katex` + `mermaid` 12 全在依赖里。**用户笔记是用户自选文件夹里的任意文件**——包括别人发给他的、从网页剪藏的。这是真实攻击面。

**学什么**：CommonMark 与 GFM 的差别；markdown-it 的插件与 `html: false` 选项；**为什么"自己写个正则过滤 script"是错的**；DOMPurify 的 `ALLOWED_TAGS` 白名单思路；KaTeX 的 `trust` 选项；mermaid 的安全配置；剪藏场景下"不可信 HTML → 安全 HTML"的完整链路。

| 资源 | 链接 | 语言 | 费用 | 核实 |
| --- | --- | --- | --- | --- |
| **OWASP — XSS 防护速查表** ⭐ | https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html | 英文 | 免费 | 🔍 |
| DOMPurify 官方仓库 | https://github.com/cure53/DOMPurify | 英文 | 免费 | 🔍 |
| markdown-it 官方演示/文档 | https://markdown-it.github.io/ | 英文 | 免费 | 🔍 |
| markdown-it 中文文档 | https://markdown-it.docschina.org/ | **中文** | 免费 | 🔍 |
| CommonMark 规范 | https://spec.commonmark.org/ | 英文 | 免费 | 🔍 |
| GitHub Flavored Markdown 规范 | https://github.github.com/gfm/ | 英文 | 免费 | 🔍 |
| Mermaid 官方文档 | https://mermaid.js.org/intro/ | 英文 | 免费 | 🔍 |
| KaTeX — 支持的函数 | https://katex.org/docs/supported.html | 英文 | 免费 | 🔍 |
| KaTeX — 支持表 | https://katex.org/docs/support_table.html | 英文 | 免费 | 🔍 |
| MDN — DOM 变动观察器 | https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver | 英文 | 免费 | 🔍 |

### 阶段 7 大概多久
**40–60 小时**，且必然按需——不要试图按顺序全学。**建议顺序**：7.5（安全，2–4h，最紧迫）→ 7.2（IndexedDB，6h）→ 7.1（CodeMirror/Lezer，20h+，最难）→ 7.3（性能，10h）→ 7.4（离线同步，10h）。

### 到什么程度算够用
- 能读懂 `src/editor/livePreview.ts` 的 decoration 策略，并解释 `MAX_DECORATED_LENGTH` 为什么设在那里。
- 能说出"剪藏来的 HTML 从进入到渲染"经过哪几道清洗。
- 能给一个 IndexedDB 的读取路径加一个索引。
- 能对"要不要引入虚拟列表"给出有数据支撑的判断（而不是"大厂都这么做"）。

---

## 11. 资源总清单

### 11.1 书（12）

| # | 书名 | 链接 | 语言 | 费用 | 核实 |
| --- | --- | --- | --- | --- | --- |
| 1 | Refactoring UI | https://refactoringui.com/ | 英文 | 付费（2 章免费） | ✅ |
| 2 | Butterick's Practical Typography (2nd ed) | https://practicaltypography.com/ | 英文 | 免费在线阅读 | ✅ |
| 3 | Every Layout (3rd ed) | https://every-layout.dev/ | 英文 | 部分免费 | ✅ |
| 4 | Inclusive Components | https://inclusive-components.design/ | 英文 | 博客免费 / 书付费 | ✅ |
| 5 | Eloquent JavaScript (4th ed, 2024) | https://eloquentjavascript.net/ | 英文 | 免费在线阅读 | 🔍 |
| 6 | You Don't Know JS Yet | https://github.com/getify/You-Dont-Know-JS | 英文 | 免费 | 🔍 |
| 7 | TypeScript Deep Dive | https://basarat.gitbook.io/typescript/ | 英文 | 免费在线阅读 | 🔍 |
| 8 | Effective TypeScript (2nd ed) | 见 §14 | 英文 | 付费 | ⚠️ |
| 9 | Atomic Design | https://atomicdesign.bradfrost.com/ | 英文 | 免费在线阅读 | 🔍 |
| 10 | 《写给大家看的设计书》 | https://book.douban.com/works/1021797 | 中文 | 付费 | 🔍 |
| 11 | 《点石成金》（Don't Make Me Think 中文版） | https://book.douban.com/subject/26313852/ | 中文 | 付费 | 🔍 |
| 12 | 《设计心理学》（Don Norman 中文版） | https://read.douban.com/bundle/126023088/ | 中文 | 付费 | 🔍 |

### 11.2 博客与个人站点（10）

| # | 站点 | 链接 | 语言 | 费用 | 核实 | 活跃度 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | overreacted — Dan Abramov | https://overreacted.io/ | 英文 | 免费 | ✅ | 高（2026 仍在更新） |
| 2 | Josh Comeau | https://www.joshwcomeau.com/ | 英文 | 免费 | 🔍 | 高 |
| 3 | Piccalilli — Andy Bell | https://piccalil.li/ | 英文 | 免费 | 🔍 | 高 |
| 4 | Heydon Works — Heydon Pickering | https://heydonworks.com | 英文 | 免费 | ✅（Every Layout 页面确认） | 中 |
| 5 | 张鑫旭 - 鑫空间-鑫生活 | https://www.zhangxinxu.com/wordpress/ | 中文 | 免费 | 🔍 | 中（更新变慢但存量极高） |
| 6 | 阮一峰的网络日志 | https://www.ruanyifeng.com/blog/ | 中文 | 免费 | 🔍 | 高（科技爱好者周刊） |
| 7 | Nielsen Norman Group | https://www.nngroup.com/articles/ | 英文 | 免费 | 🔍 | 高 |
| 8 | Smashing Magazine | https://www.smashingmagazine.com/ | 英文 | 免费 | 🔍 | 高 |
| 9 | A List Apart | https://alistapart.com/ | 英文 | 免费 | 🔍 | 中 |
| 10 | CSS-Tricks | https://css-tricks.com/ | 英文 | 免费 | 🔍 | 中（速查用） |

### 11.3 系统性教程 / 课程（13）

| # | 教程 | 链接 | 语言 | 费用 | 核实 |
| --- | --- | --- | --- | --- | --- |
| 1 | MDN — Learn web development | https://developer.mozilla.org/en-US/docs/Learn_web_development | 英文/中文 | 免费 | ✅ |
| 2 | web.dev — Learn CSS | https://web.dev/learn/css | 英文/中文 | 免费 | ✅ |
| 3 | web.dev — Learn HTML | https://web.dev/learn/html | 英文/中文 | 免费 | 🔍 |
| 4 | web.dev — Learn Accessibility | https://web.dev/learn/accessibility | 英文 | 免费 | 🔍 |
| 5 | web.dev — Learn Responsive Design | https://web.dev/learn/design | 英文/中文 | 免费 | 🔍 |
| 6 | web.dev — Learn Performance | https://web.dev/learn/performance | 英文/中文 | 免费 | 🔍 |
| 7 | web.dev — Learn PWA | https://web.dev/learn/pwa | 英文/中文 | 免费 | 🔍 |
| 8 | web.dev — Learn Testing | https://web.dev/learn/testing | 英文 | 免费 | 🔍 |
| 9 | 现代 JavaScript 教程（中文） | https://zh.javascript.info/ | 中文 | 免费 | ✅ |
| 10 | 现代 JavaScript 教程（英文原版） | https://javascript.info/ | 英文 | 免费 | 🔍 |
| 11 | type-challenges | https://github.com/type-challenges/type-challenges | 英文 | 免费 | 🔍 |
| 12 | Total TypeScript | https://www.totaltypescript.com/ | 英文 | 部分免费 | 🔍 |
| 13 | The Joy of React / Epic React | https://www.joyofreact.com/ · https://www.epicreact.dev/ | 英文 | 付费 | 🔍 |

### 11.4 网站 / 文档 / 工具（39）

| # | 名称 | 链接 | 语言 | 费用 | 核实 |
| --- | --- | --- | --- | --- | --- |
| 1 | MDN Web Docs | https://developer.mozilla.org/ | 中英双语 | 免费 | ✅ |
| 2 | TypeScript Handbook | https://www.typescriptlang.org/docs/handbook/intro.html | 英文 | 免费 | 🔍 |
| 3 | TSConfig Reference | https://www.typescriptlang.org/tsconfig/ | 英文 | 免费 | 🔍 |
| 4 | React 官方文档 | https://react.dev/learn | 英文/中文 | 免费 | 🔍 |
| 5 | React 中文文档 | https://zh-hans.react.dev/ | 中文 | 免费 | 🔍 |
| 6 | Vite 官方（中文） | https://cn.vite.dev/guide/ | 中文 | 免费 | 🔍 |
| 7 | Vite 官方（英文） | https://vite.dev/guide/ | 英文 | 免费 | 🔍 |
| 8 | Vitest 官方指南 | https://vitest.dev/guide/ | 英文 | 免费 | 🔍 |
| 9 | Testing Library (React) | https://testing-library.com/docs/react-testing-library/intro/ | 英文 | 免费 | ✅ |
| 10 | Playwright | https://playwright.dev/docs/intro | 英文 | 免费 | 🔍 |
| 11 | ESLint | https://eslint.org/docs/latest/ | 英文 | 免费 | 🔍 |
| 12 | Prettier | https://prettier.io/docs/ | 英文 | 免费 | 🔍 |
| 13 | Electron 官方（中文） | https://www.electronjs.org/zh/docs/latest | 中文 | 免费 | 🔍 |
| 14 | Capacitor | https://capacitorjs.com/docs | 英文 | 免费 | 🔍 |
| 15 | Chrome DevTools 文档 | https://developer.chrome.com/docs/devtools/ | 英文 | 免费 | 🔍 |
| 16 | Performance 面板参考 | https://developer.chrome.com/docs/devtools/performance/reference | 英文 | 免费 | 🔍 |
| 17 | caniuse | https://caniuse.com/ | 英文 | 免费 | 🔍 |
| 18 | WCAG 2.2 | https://www.w3.org/TR/WCAG22/ | 英文 | 免费 | ✅ |
| 19 | WCAG 2.2 Quickref | https://www.w3.org/WAI/WCAG22/quickref/ | 英文 | 免费 | 🔍 |
| 20 | WAI-ARIA Authoring Practices | https://www.w3.org/WAI/ARIA/apg/ | 英文 | 免费 | 🔍 |
| 21 | A11Y Project Checklist | https://www.a11yproject.com/checklist/ | 英文 | 免费 | ✅ |
| 22 | WebAIM Contrast Checker | https://webaim.org/resources/contrastchecker/ | 英文 | 免费 | 🔍 |
| 23 | Design Tokens Format Module (W3C) | https://www.w3.org/community/reports/design-tokens/CG-FINAL-format-20251028/ | 英文 | 免费 | 🔍 |
| 24 | Material Design 3 | https://m3.material.io/ | 英文（多语言） | 免费 | 🔍 |
| 25 | Apple Human Interface Guidelines | https://developer.apple.com/design/human-interface-guidelines | 英文（多语言） | 免费 | 🔍 |
| 26 | Laws of UX | https://lawsofux.com/ | 英文 | 免费 | 🔍 |
| 27 | Google Fonts Knowledge | https://fonts.google.com/knowledge | 英文 | 免费 | 🔍 |
| 28 | Grid by Example | https://gridbyexample.com/ | 英文 | 免费 | 🔍 |
| 29 | CodeMirror 6 文档 | https://codemirror.net/docs/ | 英文 | 免费 | ✅ |
| 30 | Lezer System Guide | https://lezer.codemirror.net/docs/guide/ | 英文 | 免费 | 🔍 |
| 31 | idb（IndexedDB 封装） | https://github.com/jakearchibald/idb | 英文 | 免费 | ✅ |
| 32 | TanStack Virtual | https://tanstack.com/virtual/latest/docs/introduction | 英文 | 免费 | 🔍 |
| 33 | OWASP XSS 防护速查表 | https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html | 英文 | 免费 | 🔍 |
| 34 | DOMPurify | https://github.com/cure53/DOMPurify | 英文 | 免费 | 🔍 |
| 35 | markdown-it | https://markdown-it.github.io/ | 英文 | 免费 | 🔍 |
| 36 | Mermaid | https://mermaid.js.org/intro/ | 英文 | 免费 | 🔍 |
| 37 | KaTeX（支持函数） | https://katex.org/docs/supported.html | 英文 | 免费 | 🔍 |
| 38 | CommonMark 规范 | https://spec.commonmark.org/ | 英文 | 免费 | 🔍 |
| 39 | GFM 规范 | https://github.github.com/gfm/ | 英文 | 免费 | 🔍 |

（本类实际 39 条，含上表 1–39。）

### 11.5 中文社区 / 中文资源（10）

| # | 名称 | 链接 | 类型 | 费用 | 核实 | 为什么只推荐它 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **现代 JavaScript 教程（中文）** | https://zh.javascript.info/ | 教程 | 免费 | ✅ | **中文世界最好的 JS 教程**；与英文版同源、持续更新；含 IndexedDB / 事件循环 / 动画 |
| 2 | MDN 中文文档 | https://developer.mozilla.org/zh-CN/docs/Web | 文档 | 免费 | 🔍 | 官方维护的中文翻译，引用率最高、最可靠 |
| 3 | 阮一峰《ECMAScript 6 入门》 | https://es6.ruanyifeng.com/ | 教程 | 免费 | 🔍 | 中文 ES6 经典，按特性组织，当字典用 |
| 4 | 阮一峰的网络日志 | https://www.ruanyifeng.com/blog/ | 博客 | 免费 | 🔍 | 长期高质量；《科技爱好者周刊》可当信息源 |
| 5 | 印记中文 docschina | https://www.docschina.org/ | 文档聚合 | 免费 | 🔍 | 把 webpack / Vite 等主流文档的中文翻译聚在一处 |
| 6 | Vite 官方中文文档 | https://cn.vite.dev/ | 文档 | 免费 | 🔍 | 官方中文站，版本跟进及时 |
| 7 | web.dev 中文站 | https://web.developers.google.cn/learn/css | 教程 | 免费 | 🔍 | Google 官方中文入口（Learn CSS / Design / Performance / PWA 都有中文） |
| 8 | Electron 官方中文文档 | https://www.electronjs.org/zh/docs/latest | 文档 | 免费 | 🔍 | 官方中文，桌面端必需 |
| 9 | 掘金 | https://juejin.cn/ | 社区 | 免费 | 🔍 | 中文前端最大的社区。**用法**：只用来"找关键词"，学到的东西仍要回官方文档验证 |
| 10 | Node.js 中文网 | https://nodejs.cn/ | 文档 | 免费 | 🔍 | 中文镜像；与官方英文对照看 |

**明确不推荐 / 已排除**：

- **奇舞团（75team）** —— 搜索只找到"团队负责人离职"的旧闻，没有活跃站点证据。⚠️ **[未核实]**，不建议作为持续资源。
- **第三方《TypeScript 使用手册》中文翻译**（https://github.com/zhongsp/TypeScript）—— 存在但为非官方翻译，可能滞后于 TS 7。仅作术语对照，**遇到分歧以官方英文为准**。
- **从搜索引擎随机点开的前端教程** —— 绝大多数是 v16 时代的 React 内容，与 opennote 的 React 19 不兼容（类组件、`componentWillMount`、`ReactDOM.render`）。

---

## 12. 针对 opennote 的 6 周落地计划

> 每周 8–10 小时。**所有路径都是仓库里真实存在的文件**（我先用 `ops_glob` / `read` / `grep` 核对过）。
> 纪律：**每周只动一个小地方**，改完跑 `pnpm typecheck` 和 `pnpm test`，确认没有新增失败。

### 第 1 周 —— 环境与心智模型：把"改一行代码之后发生了什么"搞清楚

**目标**：建立完整的运行时心智模型，能读懂构建配置。

**资源**：
- MDN Learn Web Development 的 Getting started 模块 https://developer.mozilla.org/en-US/docs/Learn_web_development
- MDN — JavaScript 模块 https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules
- Chrome DevTools 官方文档（只看 Elements / Sources / Network）https://developer.chrome.com/docs/devtools/

**仓库练习**（只读，不改代码）：
1. 读 `package.json` 的 `scripts`，把 `dev` / `build` / `typecheck` / `test` / `build:desktop` / `build:apk` 各做什么写成一句话。
2. 跑 `pnpm dev`，在 DevTools 的 **Network** 面板里筛选 `JS`，观察 `src/main.tsx`、`src/App.tsx` 是以什么形式被加载的（提示：不是打包后的 bundle）。
3. 读 `vite.config.ts`，找出 `define`、`resolve.alias`、`build.rollupOptions`、PWA 插件各自在哪一行、干什么。
4. 对比读 `vitest.config.ts`（只有 7 行）与 `vite.config.ts`（312 行），回答：**为什么测试配置不需要 React 插件？**（答案在 `environment: "node"`）

**完成标志**：能向别人解释「`pnpm dev` 时浏览器里的模块图和 `pnpm build` 之后的产物有什么不同」。

---

### 第 2 周 —— HTML + CSS：用层叠和令牌解释一个真实界面

**目标**：能读懂 `tokens.css`，能用 DevTools 定位样式来源，能解释优先级。

**资源**：
- **Learn CSS** https://web.dev/learn/css （模块 1–11：box model / selectors / cascade / specificity / inheritance / color / sizing / layout / flexbox / grid / custom properties）
- MDN — 使用 CSS 自定义属性 https://developer.mozilla.org/en-US/docs/Web/CSS/Using_CSS_custom_properties
- Every Layout 免费 rudiments https://every-layout.dev/rudiments/boxes/

**仓库练习**（改动极小，但要看懂）：
1. 通读 `src/styles/tokens.css`（257 行），画一张表：间距令牌 `--s1`…`--s7` 分别对应多少像素、用在哪。
2. 在 DevTools 里选中侧边栏，找出它的宽度来自哪个变量（提示：`--sidebar-w`），然后把 `--sidebar-w` 临时改成 `320px`，观察会发生什么、是否有别处被"带崩"。
3. **把 `src/styles/app.css` 里剩余的 3 处硬编码间距收敛到令牌**（已定位：第 366 行 `gap: 2px 12px`、第 368 行 `padding: 12px 14px`、第 900 行 `padding: 0 8px 0 12px`）——把它们换成 `var(--s*)`，改完在浏览器里对比确认视觉**无变化**。
4. 用 DevTools 的 Computed 面板，找出 `.sidebar` 的 `width` 最终是被哪条规则决定的。

**完成标志**：能解释"为什么我写的这条 CSS 没生效"，并能在 30 秒内指出是哪条规则赢了。
**验证命令**：`pnpm typecheck`（应无新增错误）。

---

### 第 3 周 —— JavaScript + TypeScript：给一个纯逻辑模块补测试

**目标**：能读懂 `src/lib/store.ts` 的每一行；能写第一个通过的测试。

**资源**：
- zh.javascript.info 的「闭包」「Promise / async-await」「事件循环：微任务和宏任务」「模块」四章 https://zh.javascript.info/
- TypeScript Handbook — Narrowing / Generics https://www.typescriptlang.org/docs/handbook/intro.html
- TSConfig Reference（对着 `tsconfig.json` 逐条查）https://www.typescriptlang.org/tsconfig/

**仓库练习**：
1. 读 `src/lib/store.ts`（**39 行**）三遍，直到能解释：
   - `set` 里 `Object.is(value, state)` 提前 return 的意义；
   - `subscribe` 为什么必须返回一个函数；
   - `useStore` 和 `useStoreSelector` 的区别。
2. 读 `tsconfig.json`，查出 `verbatimModuleSyntax`、`isolatedModules`、`noUncheckedSideEffectImports` 各是什么，写进笔记。
3. **新建 `src/lib/store.test.ts`**，为 `createStore` 写 4 个测试：初始值、`set` 生效、`set` 为同一引用时不通知订阅者、`subscribe` 返回的函数能退订。（参考 `src/lib/utils.test.ts` 的写法；因为 `environment: "node"`，**不要**测试 React hook。）
4. 跑 `pnpm test`，确认新测试通过。
5. 进阶（可选）：读 `src/data/ui.ts`（167 行），注意 `readItem` / `writeItem` 用 try/catch 包住 `localStorage` —— 思考如果你要测"存储被禁用"这条路径，该怎么写。

**完成标志**：`src/lib/store.test.ts` 4 个测试全绿，且你能解释每一行的类型标注为什么这么写。
**验证命令**：`pnpm test`、`pnpm typecheck`。

---

### 第 4 周 —— React 19：读一个组件，再把它拆开

**目标**：能看懂 props 流向；能判断"这个值该不该是 state"。

**资源**：
- react.dev — **You Might Not Need an Effect**（必读）https://react.dev/learn/you-might-not-need-an-effect
- react.dev — Render and Commit https://react.dev/learn/render-and-commit
- react.dev — `useSyncExternalStore` https://react.dev/reference/react/useSyncExternalStore
- overreacted — Before You memo() https://overreacted.io/before-you-memo/

**仓库练习**：
1. 读 `src/components/StatusBar.tsx`（**146 行**，纯展示组件，无内部状态）——这是最好的入门样张。列出它接收的**所有** prop，并追踪每一个从 `src/App.tsx` 的哪里传进来。
2. 读 `src/lib/store.ts`，再读 react.dev 的 `useSyncExternalStore` 页面。回答：**为什么 opennote 不需要 Redux / Zustand？**
3. **拆组件**：`StatusBar.tsx` 里有多个结构相同的 `<span className="statusbar__item">` 区块。抽出一个局部子组件（例如 `function StatusItem({ children, title, compact }: {...})`），把重复的 className 拼接收敛进去，**保持渲染结果完全一致**。
4. 对比阅读 `src/components/Outline.tsx`（**47 行**，仓库最小的 `.tsx`）和 `src/components/Sidebar.tsx`（**1398 行**）——列出 Sidebar 太大带来的 3 个具体问题（滚动成本、props 数量、无法复用）。
5. 思考题：`src/components/Sidebar.tsx` 里的搜索输入框，它的值应该是 `useState` 还是从 `src/data/library.ts` 的 store 派生？为什么？

**完成标志**：`StatusBar.tsx` 行数下降、渲染无变化，且你能说清每个变量的来源。
**验证命令**：`pnpm typecheck`、`pnpm build`（确保 JSX 改动没破坏构建）。

---

### 第 5 周 —— 前端设计与 UI/UX：做一次真正的界面审查

**目标**：产出「5 条具体问题 + 每条的具体改法」，而不是"感觉不好看"。

**资源**：
- **Refactoring UI** https://refactoringui.com/ （先领 2 个免费章节；重点章节：Hierarchy is Everything / Layout and Spacing / Designing Text / Working with Color）
- **Practical Typography** 的两页速成 https://practicaltypography.com/typography-in-ten-minutes.html 与 https://practicaltypography.com/summary-of-key-rules.html
- A11Y Project Checklist https://www.a11yproject.com/checklist/
- WebAIM Contrast Checker https://webaim.org/resources/contrastchecker/

**仓库练习**：
1. 用 `docs/screenshot.png` 和 `docs/screenshot-dark.png` 做**界面审查 8 问**（见 §8 末尾），逐条写结论，至少凑出 5 条**具体**问题（例："侧边栏条目名的 `--ink` 与 `--ink-3` 在 night 主题下对比度可能低于 4.5:1，需要用 WebAIM 验证并调亮 `--ink-3`"）。
2. 用 WebAIM Contrast Checker 验证 `src/styles/tokens.css` 中 **4 套主题**的 `--ink-2` 与 `--ink-3` 对 `--paper` 的对比度，把不达标的值记录下来。（`paper` / `celadon` / `sepia` / `night` 四套都在同一个文件里）
3. **只改变量，不改结构**：在 `tokens.css` 里为 `night` 主题调高 `--ink-3` 的亮度，使正文注释文字达到 4.5:1；跑一遍界面确认观感没有被破坏。
4. 给 `tokens.css` 补一层**语义令牌**（如 `--text-primary` / `--text-muted` / `--surface-raised`），先在 `src/styles/base.css`（509 行，改动面小）里试用，理解"原始令牌 → 语义令牌"的两层结构为什么重要。

**完成标志**：一份 5 条以上的审查笔记（每条含"问题 → 原因 → 具体改法"）+ 至少 1 处对比度修复。
**验证命令**：`pnpm typecheck`（改 CSS 不影响类型，但要确保没顺手改坏结构）。

---

### 第 6 周 —— 工程化与进阶专题：摸到 opennote 最硬的两块

**目标**：读懂性能取舍；理解不可信输入的安全链路。

**资源**：
- Vite 官方中文指南 https://cn.vite.dev/guide/
- Vitest 官方指南 https://vitest.dev/guide/
- **OWASP XSS 防护速查表** https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
- CodeMirror 6 System Guide https://codemirror.net/docs/guide/
- Lezer System Guide https://lezer.codemirror.net/docs/guide/

**仓库练习**：
1. **安全链路追踪**：从 `src/lib/clip/receive.ts`（或 `src/lib/import.ts`）开始，追踪一段剪藏来的 HTML 到最终渲染，列出经过的每一次清洗（`markdown-it` 配置 → `dompurify` → 组件渲染）。回答：**如果去掉 DOMPurify，最坏会发生什么？**
2. **性能阅读**：读 `src/editor/livePreview.ts` 的头部注释（含 `MAX_DECORATED_LENGTH = 800_000` 与 D24 阈值说明），再读 `src/editor/perfD24.test.ts`。跑一次 `D24_BENCH=1 npx vitest run src/editor/perfD24.test.ts`，把你机器上的实测数字记下来，和注释里的数字对比。
3. **补一个缺失的测试**：`src/data/assetPaths.ts`（104 行）目前**没有**同名测试文件。读它（附件目录路径派生逻辑），仿照 `src/data/assets.test.ts` 的写法新建 `src/data/assetPaths.test.ts`，覆盖 3 个边界：空文件名、含空格的文件名、含中文的文件名。
4. 进阶（可选）：读 `src/editor/setup.ts` 与 `src/editor/commands.ts`，找出一个你想改的小功能并写下改动方案（**先别动手**）。

**完成标志**：能画出剪藏 HTML 的清洗链路；`pnpm test` 里多了一个通过的测试文件。
**验证命令**：`pnpm test`、`pnpm typecheck`、`npx vitest run src/editor/perfD24.test.ts`。

---

### 6 周之后往哪走

- **补齐 React**：把 `src/components/Sidebar.tsx`（1398 行）拆成 3–4 个文件，这是最好的 React 实战。
- **补齐测试体系**（需要你先引入依赖）：加 `jsdom` + `@testing-library/react`，为 `StatusBar.tsx` 写第一个组件测试；再加 `playwright` 写一条"打开笔记 → 编辑 → 保存"的 E2E。
- **补齐 CSS 架构**：把 `src/styles/app.css`（2693 行）按"组件 / 布局 / 工具类"拆分，理解为什么文件太大会成为认知负担。
- **补齐设计**：完成 Refactoring UI 全书 + 用 §8 的"抄—改—破"法做 5 个界面的改造。

---

## 13. 英语一般怎么读 & 8 个常见误区

### 英语一般也能读的三类（放心读）

1. **API 文档 / 规范**（MDN、CodeMirror、OWASP、WCAG）—— 句子短、代码占一半、术语重复出现。**开浏览器翻译 + 建一个术语表**就够了。
2. **代码驱动的教程**（web.dev Learn CSS、Josh Comeau、react.dev）—— 能跑起来的代码是最好的翻译。
3. **带大量图的实战书**（Refactoring UI）—— 图占一半，句子是"操作指令"而非论述。

### 真正吃英语的两类（建议配翻译或有中文替代）

1. **长散文型书**：Eloquent JavaScript、Refactoring UI 的论述段。→ 替代：《写给大家看的设计书》《点石成金》，或中译本配合读。
2. **哲学型博客**：overreacted 的多数文章。→ 建议：先读中文翻译版，再回英文原文对关键段落。

### 8 个常见误区

1. **"先学完再动手"** —— 前端没有"学完"这回事。第 12 周计划就是边学边改真实代码。
2. **"React 最重要，先学 React"** —— 对 opennote 是错的：141 个 `.ts` vs 19 个 `.tsx`，**TS + CSS 的优先级高于 React**。
3. **"CSS 不重要，反正有框架"** —— opennote **没有** CSS 框架，4600+ 行手写样式。你的 CSS 水平 = 你的 UI 水平。
4. **"`useEffect` 是'数据变了就处理'"** —— 这是最贵的误解，见官方 [You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect)。
5. **"类型越复杂越专业"** —— 为一个只用一次的对象写 30 行条件类型是负债。TypeScript 的价值在**消除 bug**，不在炫技。
6. **"性能就是加 memo"** —— 先改结构，再谈 memo（[Before You memo()](https://overreacted.io/before-you-memo/)）。
7. **"设计靠天赋"** —— 设计是**可拆解战术**的集合（Refactoring UI 的整个前提就是"Design with tactics, not talent"）。你能学会它。
8. **"搜索引擎里排名高的教程就是对的"** —— 大量前端教程停留在 React 16 时代。**只信官方文档和作者本人站点**；就 opennote 而言，任何教你 `ReactDOM.render` 或类组件的教程都该关掉。

---

## 14. 核实状态附录

### 标记为 ⚠️ [未核实] 的条目（共 5 条）

| 条目 | 我尝试的链接 | 失败原因 | 建议做法 |
| --- | --- | --- | --- |
| pnpm 中文文档 | https://pnpm.io/zh/ | 返回 **HTTP 403**（Vercel 安全校验拦截机器人）。英文站 https://pnpm.io/ 已由搜索确认为官方站 | 你自己用浏览器打开 https://pnpm.io/zh/ 确认；不行就读英文站 |
| Effective TypeScript (2nd ed) 官方书页 | O'Reilly 书页 | 未成功抓取；只见到 Google Books 的间接记录，**没有**拿到出版社一手页面 | 搜索 "Effective TypeScript 2nd edition O'Reilly" 后从 oreilly.com 官网进入；ISBN 978-1-098-15506-3 为二手来源，未核实 |
| 奇舞团（75team.com） | https://75team.com/ | 未找到活跃证据；只搜到"团队负责人离职"的旧闻 | **不建议**作为持续资源，已从推荐列表中排除 |
| type-scale.com | https://type-scale.com/ | 搜索结果全部指向一个无关的手机 App，**未能确认该工具站** | 改用 [Practical Typography](https://practicaltypography.com/) 的字号规则 + Refactoring UI 的 "Establish a type scale" 章节 |
| cn.vitest.dev（Vitest 中文文档） | https://cn.vitest.dev/ | 只搜到 `v3.cn.vitest.dev/guide/` 与社区翻译仓库，**未能确认为官方维护** | 以英文 https://vitest.dev/guide/ 为准；中文可参考社区项目 https://github.com/skyclouds2001/docs-cn |

> 上表 5 行，其中 pnpm 中文与 type-scale.com 为「抓取失败」，Effective TypeScript 书页为「未找到一手页」，奇舞团为「疑似停更」，cn.vitest.dev 为「归属不明」。

### 已直接抓取（HTTP 200 且内容匹配）的 12 个页面

| 页面 | 链接 |
| --- | --- |
| MDN — Learn web development | https://developer.mozilla.org/en-US/docs/Learn_web_development |
| web.dev — Learn CSS | https://web.dev/learn/css |
| Every Layout（含免费章节入口） | https://every-layout.dev/ |
| Inclusive Components | https://inclusive-components.design/ |
| WCAG 2.2（W3C Recommendation, 2024-12-12） | https://www.w3.org/TR/WCAG22/ |
| The A11Y Project — Checklist | https://www.a11yproject.com/checklist/ |
| Refactoring UI（含完整目录，确认 50 章） | https://refactoringui.com/ |
| Butterick's Practical Typography（第 2 版，免费在线） | https://practicaltypography.com/ |
| CodeMirror Docs（System Guide / Reference / Examples 入口） | https://codemirror.net/docs/ |
| idb — "IndexedDB, but with promises" | https://github.com/jakearchibald/idb |
| 现代 JavaScript 教程（中文，页脚显示 2026-10-09 更新） | https://zh.javascript.info/ |
| overreacted（确认活跃至 2026） | https://overreacted.io/ |

### 其余条目的核实方式

标注 **🔍 搜索核实** 的条目，是通过搜索该资源的官方页面并从返回结果的**标题与 URL** 确认其存在与主题匹配（网站在线、被搜索引擎索引），但**没有逐个抓取正文**。这些资源均为领域内长期存在的权威站点（w3.org、developer.mozilla.org、react.dev、vite.dev、codemirror.net 等），但我仍然建议你在第一次使用前自己打开确认一次。

---

*本文件由技术调研生成，路径 `docs/learning/frontend-knowledge-map.md`。仓库事实（版本号、文件路径、行数、测试数量、依赖缺口）均来自对 `E:\repo\opennote` 的实际读取；资源链接的核实状态见 §14。*
