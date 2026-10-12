# geometry-probe · 编辑器「位置跳动」几何回归

**一句话**：它是 Opennote 编辑器的**几何回归判据** —— 在真实 Chrome 里挂载**真实的** CodeMirror 6 扩展与样式，量「光标进出块」「异步渲染完成」「外部改动（磁盘赢）落下来」这三种时刻里，页面元素与视口移动了多少像素，位移不为 0 就红。

```bash
node scripts/verify-editor-geometry.cjs        # 或 pnpm verify:geometry
```

退出码：**0 = 全绿，1 = 有 FAIL 或有 UNMEASURED，2 = 判据脚本自身失败**（2 不代表被测代码通过）。

---

## 怎么跑

```bash
pnpm verify:geometry

# 排查用
node scripts/verify-editor-geometry.cjs --verbose         # 打印全部原始数据
node scripts/verify-editor-geometry.cjs --json out.json   # 原始测量 JSON 落盘
node scripts/verify-editor-geometry.cjs --dump            # 不跑断言，只打逐行 DOM 快照 + CM 内部量
node scripts/verify-editor-geometry.cjs --keep            # 跑完不杀自己起的 Chrome / vite
node scripts/verify-editor-geometry.cjs --help
```

脚本**自己**完成全套：起 vite（后台）→ 起 headless Chrome → 连 CDP → 跑测量 → 判定 → 打印 → **杀掉自己起的进程** → 给退出码。它不假设任何东西已经在跑，也不会去杀别的进程。

**前提**：仓库根已 `pnpm install`；机器上装了 Chrome；端口空闲（可用环境变量换）。

### 依赖真实 Chrome —— 这是硬依赖

| 项 | 值 |
|---|---|
| Chrome 可执行文件 | 默认 `C:\Program Files\Google\Chrome\Application\chrome.exe`（找不到会自动试 `Program Files (x86)`、`%LOCALAPPDATA%\Google\Chrome`、macOS/Linux 常见路径） |
| 覆盖方式 | `CHROME_PATH="D:\...\chrome.exe"` |
| 启动参数 | `--headless=new --disable-gpu --remote-debugging-port=<CDP> --user-data-dir=<临时目录> --window-size=1280,2900` |
| **vite 端口** | **5211**（`GEOMETRY_VITE_PORT` 可换）。用独立端口是为了不和 `pnpm dev`(5173) 打架 |
| **CDP 端口** | **9333**（`GEOMETRY_CDP_PORT` 可换） |
| Chrome profile | 每次 `mkdtemp` 新建一个临时目录，结束时删掉 —— **绝不复用、绝不碰你正在用的浏览器 profile** |

> **不要用 jsdom / 假 DOM 替换探针页面。** 这个工具的全部价值就在于量的是真实浏览器的真实布局；换成假 DOM 之后它一条都测不出来。
>
> 也**不要**用 `taskkill /IM chrome.exe` 收工 —— 那会杀掉用户正在用的浏览器。脚本只按 PID 精确杀自己 spawn 出来的进程树。

### 为什么窗口要 2900px 高

CodeMirror 的 `visiblePixelRange()`（`@codemirror/view` dist）会把像素视口**同时**裁剪到 `window.innerHeight` **和**滚动父元素上。窗口不够高的话，文档尾部的标尺段落根本不会被渲染进 DOM，`getBoundingClientRect()` 量到的是空气。所以 `--window-size=1280,2900`（实测 `innerHeight = 2800`）是判据的一部分，不是随便填的。

---

## 输出怎么读

```
不变量 1 · 切换不位移（纵向）
  判定阈值：|Δ| <= 1px（严格容差；实际数值一律原样打印）
  PASS       ATX 标题 `# 一级标题`                         Δ =  0.00 px
  FAIL       4 列表格                                      Δ = -147.69 px
  ...
汇总: 2 passed / 14 failed   （共 16 条断言，阈值 |Δ| <= 1px）
```

* 每条断言一行 `PASS` / `FAIL` / `UNMEASURED`，**Δ 是实测像素值**，PASS 也打，不是只打失败。
* 下面「明细」段落给出每条失败的前后值（标尺 `rect.top` 前后、块高前后、`contentHeight` 变化、`scrollTop` 变化、横向的元素 `rect.left` 与行文本前后），所以「坏在哪、坏多少」一眼可见。
* 阈值是 `|Δ| <= 1px`：亚像素布局在 `getBoundingClientRect()` 上天然有 ±1px 抖动，用 0 会把抖动报成位移。**这是唯一一处容差，且每条的实际数值都会原样打出来** —— 实测至今没有任何一条落在 `0 < |Δ| <= 1` 区间：PASS 全是精确的 `0.00`，FAIL 最小也有 `6.39px`。所以这个容差在实际运行中**从未起过作用**，它只是防抖的安全网。
* `UNMEASURED` = 测不出来。**它不计为通过**，退出码同样为 1：测不出来就等于判据失效，绝不能算绿。触发条件：标尺段落不在 DOM、`coordsAtPos()` 返回 null、异步渲染 30s 没完成，以及**异步那两条没有真的观察到占位态**（若 t0 采到时渲染已经完成，Δ 必然是 0 —— 那是**假绿**，必须报 `UNMEASURED`）。
* 表头会打**源码指纹**：`src/**` 全部 `.ts/.tsx/.css` 内容的 sha256 前 16 位 + `git HEAD` + 「src 是否脏」。这样任何一组数字都能归属到确定的源码状态 —— 在有并发改动的工作区里尤其重要。**读数字前先读指纹**：指纹变了，两组数字就不可比。
* 日志目录只在**有 FAIL / UNMEASURED 时保留**（表头会打出路径），全绿时自动删掉。

### 为什么探针的 vite 关掉了 hmr / watch

判据要的是**一次测量期间的绝对稳定**。不关的话，只要有人在同一个工作区里改 `src/**`（并发修复、别的编辑器正在保存），vite 的文件监听就会给页面推一次 HMR 更新；探针页面没有 `import.meta.hot.accept`，vite 于是**整页 reload** —— 正在被测量的 `EditorView` 连同它的状态一起消失，CDP 报 `Inspected target navigated or closed`。依赖预打包完成后的自动 reload 也走同一条通道。

所以 `scripts/geometry-probe/vite.config.mts` 里写了 `server.hmr = false` + `server.watch = null`。页面每次都是重新从磁盘加载的，关掉监听不会让探针读到旧代码。


### 四条不变量

| # | 不变量 | 怎么量 | 判据 |
|---|---|---|---|
| 1 | **切换不位移（纵向）** | 光标放在块**外面**，记录块**下方第一个标记段落**的 `rect.top`；光标移进块里，等 3 帧后重记 | `\|Δ\| <= 1px` |
| 2 | **异步渲染不位移** | 挂载文档后，逐帧等到 widget（`.md-math` / `.md-mermaid`）**进 DOM 且仍是占位态**（`.is-loading`）的那一刻记 `rect.top`；再轮询到渲染完成（上限 30s）后重记 | `\|Δ\| <= 1px`，且**必须真的观察到占位态**，否则记 `UNMEASURED` |
| 3 | **切换不位移（横向）** | 光标在段落**外/内**时，`**加粗**`、`*斜体*`、`` `行内代码` ``、`[链接](url)`、标题 `# `、引用 `> ` 这些元素**文字起点**的 `coordsAtPos().left` | `\|Δ\| <= 1px` |
| 4 | **外部改动（磁盘赢）不甩走视口** | 一篇 24 000px 高的笔记滚到 `scrollTop = 4000`（300px 小步进落位）→ 按**产品里那份** `minimalReplace` 落一次外部改动 → 视口里第一条非空行的 `rect.top` 与**它在文档里的位置**（`posAtDOM`） | `\|Δ\| <= 1px`，且锚点必须还是同一行（下方改动：位置一个字符都不许动；上方改动：位置必须正好后移插入的那一段） |

不变量 1 逐个块测：ATX 标题、Setext 标题、围栏代码块、4 列表格、mermaid 块、`$$` 公式块、块级图片、引用块。
不变量 2 每次都用**全新**的公式/图表内容（内容里塞自增序号），避开 `src/editor/math.ts` / `src/editor/mermaid.ts` 的模块级 `Map` 缓存 —— 缓存命中时根本不会出现「占位 → 渲染完成」，那一位移就测不到。
不变量 4 三个时刻：改动在视口**下方**（Agent 在文末追加）、改动在视口**上方**（Agent 在开头插一段）、以及**用户正拖着滚动条往上跳 1200px 的那一刻**改动落下来。

> **不变量 4 为什么比的是「哪一行」而不是像素**：视口被整篇甩回文档开头时，新的顶行同样贴在滚动容器上沿，`rect.top` 照样在 0 附近（修复前实测 Δ = −29.33px，而 `scrollTop` 掉了 3926px）—— 只看像素就是**假绿**。所以锚点同时比行文本与文档位置。

---

## 文件

| 文件 | 作用 |
|---|---|
| `scripts/verify-editor-geometry.cjs` | **判据**。零依赖 Node 脚本：起进程、连 CDP、判定、打印、清理、给退出码 |
| `scripts/geometry-probe/probe.ts` | **探针页面**。挂载真实的 `livePreviewField` / `markdownSupport` / `editorTheme` / `editorSettingsField`，对外只暴露 `window.GEOM` 的**测量原语**（不判定） |
| `scripts/geometry-probe/index.html` | vite 入口（真实样式表 + 内联的 6 条 `.editor-host` 外壳规则） |
| `scripts/geometry-probe/vite.config.mts` | 独立 vite 配置（端口 5211 + 预打包 mermaid/katex，避免跑到一半触发依赖优化重载） |

**判据和被测代码是分开的**：`probe.ts` 只负责把原始像素交给 Node 脚本，PASS/FAIL 全部在 `verify-editor-geometry.cjs` 里做。这样「尺子」不会跟着「被测物」一起变。

**不变量 4 用的是产品里那一份改动计算**（`import { minimalReplace } from "../../src/editor/externalReplace"`）—— 不是探针里另抄一份。所以它量的是「产品代码在真实浏览器里的行为」，不是「探针自己的实现」。

---

## 已知边界（没测出来的部分，如实标注）

1. **键入触发的跳动没测**：在表格/代码块里打字、回车、粘贴造成的重排，不在本次四条不变量里。
2. **远距离滚动跳转被 CM 改写 `scrollTop` 只测了「外部改动之后」那一次**：归档报告里那 −708.63px（一次 0→6000 的跳转）属于另一类问题（`HeightMapGap.blockAt()` 按字符比例猜行号），本次只在「外部改动落下来之后拖一次滚动条上跳 1200px」这个组合里量了它（不变量 4 的第三行，实测 drift 0）。裸的大跳转要看归档探针的 D/E 场景（`docs/editor-ux/probe/`）。
3. **整篇重写时视口会落到文档开头**：改动**覆盖了视口锚点所在的字符**（Agent 把整篇重写、或正好重写了你正在读的那一段）时，「同一位置」在内容被重写之后本来就没有定义，锚点映射到改动区间的起点。这是 `minimalReplace` 的显式边界（见 `src/editor/externalReplace.ts` 的「边界」一节），不变量 4 测的是「部分改动」（追加 / 上方插入），不覆盖整篇重写。
4. **绝对像素值随环境变**：探针是「真实编辑器模块 + 真实样式 + 真实字体」的独立页面，但**没有** React 外壳、标签栏、大纲栏，也没有桌面端的 `devicePixelRatio` 差异。**位移的方向与机制可直接外推，绝对像素值会随字号/行宽/DPI 变化**（本次用默认 `--doc-fs: 16.5px`、`--doc-lh: 1.78`、`--measure: 46rem`，视口 1254×2800 @1x）。
5. **一次跑一次采样**：脚本对每条断言只量一次（`settle()` = 3 帧 + 150ms + 2 帧）。极偶发的时序抖动可能漏掉；关闭 hmr/watch 后连续多次重跑结果完全一致（`diff` 为空，含每条 Δ 的小数位）。
6. **`UNMEASURED` 的触发条件**：标尺段落不在 DOM（窗口太矮 / CodeMirror 没渲染到那一行）、`coordsAtPos()` 返回 null、异步渲染 30s 未完成、不变量 4 的视口里找不到非空行。跑出 `UNMEASURED` 时先看窗口高度与 `--window-size`。
7. **并发修改会让数字不可比**：`src/**` 正在被别的进程改写时，同一份"当前代码"两次跑出来的数字可能不同（实测撞到过：vite 的 HMR 让页面在测量中途整页 reload）。跑之前先确认工作区安静，并核对报告表头的源码指纹。
8. **端口 5211 上残留的旧 vite 会被复用**：脚本发现端口上已经有 geometry-probe 页面时**复用它、且结束时不会杀它**（避免误杀来源不明的实例）。上一次运行被强杀留下的孤儿进程会让新代码量不出来 —— 拿到「与改动不符」的数字时先 `netstat -ano | findstr :5211` 确认端口是空的。

---

## 和归档探针（`docs/editor-ux/probe/`）的关系

归档探针是**一次性诊断**，跑出 [`证据-浏览器实测报告-位置跳动.md`](../../docs/editor-ux/证据-浏览器实测报告-位置跳动.md) 里那些数字；这里是它的**正式版**：只保留回归判据需要的部分，去掉场景 D/E 那套排查脚手架，补上判定、清理、退出码与源码指纹。

改动清单见本目录的 git 历史；要点是：**探针页面挂载真实扩展这件事一字未改**，`src/**` 没有被这个工具碰过一个字节（脚本每次运行都会把 `git status --porcelain -- src` 的结果打进报告表头）。
