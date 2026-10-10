# Opennote 架构总览

> 目的：用一份文档说清「这个项目由什么组成、数据怎么流动、为什么这么设计」。
> 面向两类人：① 想改这个仓库的贡献者；② 想拿它当**真实教材**学前端的开发者（对照 [`docs/learning/frontend-knowledge-map.md`](learning/frontend-knowledge-map.md)）。
> 文中每个数字、每个文件名都来自仓库源码实读（核实方式见 §11），不是设计意图的复述。

---

## 0. 一句话定位

**笔记就是你磁盘上的 Markdown 文件。** 打开一个文件夹当笔记本，应用直接读写其中的 `.md`；
没有后端服务、没有账号、没有遥测、没有专有数据库/格式。样式与手感照 Typora 来：语法标记在未编辑的行自动隐藏，光标回到那一行再露出来。

由此推出的三条硬性架构约束（后面每个设计决定都能回溯到这三条）：

1. **文件是唯一真相**，内存状态只是它的镜像 —— 任何写入都必须落回文件系统。
2. **没有服务器**，所以「浏览器能不能直接读写磁盘」必须靠平台能力（FSA / OPFS / Node fs / Capacitor）解决，并被抽象成同一套接口。
3. **同一份代码要跑在四种宿主里**（浏览器、Electron 渲染进程、Android WebView、扩展），所以平台差异必须收敛在 `src/fs` 与 `src/desktop` 两层。

---

## 1. 四种交付形态（同一份 `src/`）

| 形态 | 入口 | 文件系统后端 | 关键差异 |
| --- | --- | --- | --- |
| 网页版 / PWA | `index.html` → `src/main.tsx` | File System Access API（Chrome/Edge）或 OPFS（Firefox/Safari） | Service Worker 预缓存界面；含严格 CSP；支持 GitHub 仓库当笔记本 |
| Electron 桌面版 | `electron/main.cjs` → `file://` 加载渲染进程 | Node `fs`（经 IPC） | 相对路径构建、关掉 PWA、无窗口菜单栏、内置本地导入桥与自更新 |
| Android | `capacitor.config.ts` + `src/fs/capacitorBackend.ts` | `Documents/OpenNote/` 下的目录 | 复用网页构建，经 Capacitor Filesystem 插件读写 |
| 剪藏扩展 | `extension/src/manifest.json`（MV3） | 不直接写笔记：把「导入信封」投递给本机笔记本 | `src/clip-web/` 是扩展注入用的轻量页面，复用同一套契约类型 |

---

## 2. 技术栈（版本取自 `package.json` / `tsconfig.json`）

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 语言 | TypeScript 7.0.2 | `strict: true` + `noUnusedLocals` + `verbatimModuleSyntax` + `isolatedModules`，`noEmit: true`（只做检查，编译交给 Vite/esbuild） |
| UI | React 19.3 + react-dom 19.3 | 只有 19 个 `.tsx`，React 是薄视图层 |
| 构建 | Vite 8.3 + `@vitejs/plugin-react` 6.1 | `pnpm build` = `tsc --noEmit` + `vite build`；`build:desktop` 单独一套相对路径产物 |
| 编辑核心 | CodeMirror 6（`@codemirror/state`、`view`、`language`、`lang-markdown`、`commands`、`search`、`autocomplete`） | 语法树来自 Lezer（`@lezer/markdown`、`@lezer/common`、`@lezer/highlight`），用于按行决定隐藏哪些标记 |
| 渲染 | markdown-it 15（HTML 导出/预览）、KaTeX 0.18（公式）、Mermaid 12（图表）、DOMPurify 3.4（清洗不可信 HTML） | Mermaid / KaTeX 走懒加载分包，不进安装期预缓存 |
| 数据 | `idb` 8（IndexedDB，仅存 FSA 目录句柄 + 一次性旧数据迁移）、JSZip（导入导出 zip）、localStorage（设置与工作区注册表） | **笔记正文永不进 IndexedDB** |
| 测试 | Vitest 5（`environment: "node"`） | 65 个 `*.test.ts`，约 1191 个用例 |
| 桌面 | Electron 44 + electron-builder 26 | 主进程 CommonJS；`contextIsolation`/`sandbox`/`webSecurity` 全开 |
| 移动 | `@capacitor/core`、`@capacitor/android`、`@capacitor/filesystem` 8.x | 复用同一份 web 构建 |
| 样式 | 手写 CSS，无 Tailwind / 无 CSS-in-JS / 无组件库 | `src/styles/` 6 个文件；字体自托管（`@fontsource-variable`），「文楷」按需从 CDN 取、失败回退系统楷体 |

---

## 3. 分层图

```
┌──────────────────────────────────────────────────────────────────────┐
│ 宿主：浏览器 / Electron 渲染进程 / Android WebView                   │
│                                                                      │
│  main.tsx ──► App.tsx ──► components/*.tsx       ← React 视图层      │
│                    │        （Sidebar / EditorPane / InboxPanel …）  │
│                    ▼                                                 │
│  lib/appCommands.ts  ── 命令注册表：菜单、快捷键、命令面板同一份来源  │
│                    │                                                 │
│  ┌─────────────────┴──────────────────────────────────────────────┐  │
│  │ data/ 笔记本数据层（纯 TS，无 React）                          │  │
│  │   library.ts   内存镜像(vault) + 所有变更 + 防抖落盘 + 快照/回收站│ │
│  │   workspaces.ts 工作区注册表 + 后端解析                         │ │
│  │   inbox.ts / importLog.ts / migrateAssets.ts / assets.ts        │ │
│  │   ui.ts  设置（主题/字号/栏宽…，localStorage）                  │ │
│  └─────────────────┬──────────────────────────────────────────────┘  │
│         state ▲    │ FileSystemBackend（同一套接口）  ▼              │
│  ┌──────────────┴───────────────────────────────────────────────┐    │
│  │ src/fs/   路径规则(paths) · 类型(types) · 后端实现            │    │
│  │   nodeBackend(IPC) · handleBackend(FSA) · opfs · capacitor    │    │
│  └───────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  editor/  CodeMirror 6：setup · markdown 扩展语法 · livePreview 装饰  │
│           · widgets(公式/图表/图片) · commands · completion · theme   │
│  lib/     通用工具：markdown · outline · fuzzy · export · import      │
│           · clip/(信封与落地) · github/(导入与同步) · update           │
│  styles/  tokens.css → base → prose → editor → app（手写 CSS 分层）   │
└──────────────────────────────────────────────────────────────────────┘
        │ Electron IPC（8 个 ipcMain.handle）
        ▼
┌──────────────────────────────────────────────────────────────────────┐
│ electron/  主进程（CommonJS）                                        │
│   main.cjs        窗口、IPC 文件操作、路径越界防护、符号链接跳过      │
│   preload.cjs     只暴露 window.opennote 一层薄接口                  │
│   bridge.cjs      本地导入桥：仅绑 127.0.0.1 的极小 HTTP 服务         │
│   update.cjs      只读一次 GitHub Releases 的自更新（校验 + 重启）    │
│   zip.cjs / fetch-images.cjs / clip-stage.cjs / deeplink.cjs          │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 4. 目录地图（真实文件与规模）

```
src/
├── main.tsx                75 行  挂载 React、导入自托管字体与 5 个 CSS 层
├── App.tsx               1614 行  组装界面 + 全部跨层动作（16 个 useState / 27 个 useEffect）
├── components/           15 个 .tsx
│   ├── Sidebar.tsx       1398 行  文件树、多标签、搜索（仓库最大的组件）
│   ├── InboxPanel.tsx    1279 行  导入收件箱
│   ├── AppDialogs.tsx     743 行  设置/历史/快捷键等对话框
│   ├── EditorPane.tsx              CodeMirror 宿主 + 只读锁
│   ├── StatusBar.tsx      146 行  纯展示，无内部状态 → 最好的 React 入门样张
│   └── Outline.tsx         47 行  仓库最小的 .tsx
├── data/
│   ├── library.ts        3193 行  vault 内存镜像：扫描、变更、落盘、快照、回收站
│   ├── workspaces.ts              注册表（localStorage）+ resolveBackend()
│   ├── inbox.ts          1366 行  收件箱状态机（pending→committing→committed/failed/discarded）
│   └── ui.ts              167 行  设置读写（localStorage 全包 try/catch）
├── editor/
│   ├── livePreview.ts     522 行  按语法树生成 decoration，隐藏未编辑行的标记
│   ├── setup.ts                   CodeMirror 扩展组装（Compartment 做动态开关）
│   └── perfD24.test.ts            D24 性能基准（需 D24_BENCH=1 才跑）
├── fs/                            一接口四后端 + 路径规则 + in-memory 测试后端
├── lib/
│   ├── store.ts            39 行  自研状态容器（createStore + useSyncExternalStore）
│   ├── appCommands.ts     486 行  命令注册表（界面按钮、快捷键、命令面板共用）
│   ├── clip/                      信封（envelope 850 行）、接收、落地、附件
│   ├── github/                    api / importRepo / sync / parse
│   └── export.ts · import.ts · markdown.ts · outline.ts …
├── styles/               4600+ 行  tokens.css(257) base(509) prose editor app.css(2693)
└── clip-web/                      扩展注入页（复用自己的 contract.ts 契约类型）

electron/  6929 行；extension/  MV3 扩展；docs/  契约与验证文档；scripts/  构建与发布脚本
```

---

## 5. 关键数据流

### 5.1 启动
`index.html`（含启动兜底脚本与 CSP）→ `src/main.tsx` 先应用系统主题与 `ui.ts` 设置 → `createRoot().render(<App/>)`；
`index.html` 的兜底脚本在 React 挂载后停止等待（`window.__opennoteMounted`）。localStorage 被浏览器禁止时**不致命**：只提示「设置本次不保存」，笔记照常读写。

### 5.2 打开笔记本 → 选后端
`App.tsx` → `workspaces.ts` 读注册表（localStorage）→ `resolveBackend(record)`
→ 按 `BackendKind` 选 `nodeBackend`（Electron IPC）/ `handleBackend`（FSA，句柄存在 IndexedDB）/ `opfs` / `capacitorBackend`
→ `library.ts#initLibrary()` 扫描目录，把文件映射成 `Note`/`Folder`，写入 `libraryStore`。
FSA 的授权是**平台限制**：句柄可存 IndexedDB（localStorage 存不了），但刷新后需用户再点一次授权。

### 5.3 编辑 → 落盘（核心链路）
CodeMirror `onChange` → `updateNoteContent()` 先改内存 → `persistNoteSoon()` **450ms 防抖**写回后端
→ 状态栏圆点表示「还有未写入」→ 切换笔记 / 切后台 / 关窗 / 关闭标签前 `flushAll()` 强制落盘。
写入的**唯一出口**是文件系统后端，所以桌面端主进程绝不自己写正文（写了也会被渲染层的 `flushAll()` 覆盖 —— `bridge.cjs` 头部注释明确写了这条）。

### 5.4 剪藏 → 收件箱 → 落地
扩展 / 命令行 / 其他应用把「导入信封」投递给本机：桌面版走 `electron/bridge.cjs`（**只绑 `127.0.0.1`** 的极小 HTTP 服务，零新依赖，令牌 + 按来源类型的白名单校验，普通网页来源 403；渲染层只经 IPC 读桥状态，不直接 fetch）
→ 信封先落盘到 `.opennote/inbox/<entry>/` → `data/inbox.ts` 状态机管理待确认
→ 用户确认后 `commitInboxResult()` 才真正写进笔记目录（支持 undo）。
网页版没有本机桥时，走页面内/粘贴/文件导入等通道，契约类型是同一份 `src/clip-web/contract.ts`。

### 5.5 版本快照与冲突
每篇笔记**每 3 分钟**最多留一份快照，最多保留 **60** 份（`SNAPSHOT_INTERVAL = 3*60_000`、`SNAPSHOT_KEEP = 60`），存在 `.opennote/history/<笔记路径>/`。
回收站是 `.opennote/trash`；「彻底删除」会连历史快照与空掉的 `assets/` 一起清掉。
外部改动（换工具改了文件）在切回窗口/手动同步时重新扫描；同名冲突不让覆盖，走序号或对话框。
写入前用后端复核目标名是否已存在（Windows/macOS 大小写不敏感，只改大小写的重命名走两步改名）。

### 5.6 桌面自更新
启动时**只读一次** GitHub Releases → 有新版则出现强调色下载图标 → 下载并校验 → 「重启并更新」：先保存笔记、关闭、覆盖当前目录、自动重开。没有后台常驻检查、没有静默安装。

---

## 6. 八条架构决策（含代价）

| # | 决策 | 理由 | 代价 / 边界 |
| --- | --- | --- | --- |
| 1 | 文件是唯一真相，内存只是镜像 | 数据可被任何编辑器读写，永不锁定；换电脑就是拷文件夹 | 每次变更都要落盘 + 冲突处理；大库要扫描 |
| 2 | `src/fs` 一接口四后端 | 浏览器/桌面/手机/扩展共用同一套上层逻辑 | 后端语义差异（大小写、移动、删除、权限）必须逐条对齐，测试成本高 |
| 3 | 自研 39 行 store（`useSyncExternalStore`） | 状态即模块级单例 + 订阅，零依赖，逻辑层不需要 React 也能测 | 没有 devtools / 中间件；选择器要靠 `useStoreSelector` 手动控制重渲染 |
| 4 | React 只做视图（141 `.ts` vs 19 `.tsx`） | 复杂逻辑写成纯函数/纯模块，可被 Vitest 在 node 环境直接测 | UI 与逻辑边界要靠纪律维持；`App.tsx` 已经 1614 行的压力来自此 |
| 5 | CodeMirror 6 + Lezer 做所见即所得 | 不自己写 Markdown 渲染管道；用语法树决定「这一行该隐藏哪些标记」 | 学习曲线陡；装饰策略有性能阈值（`MAX_DECORATED_LENGTH = 800_000`） |
| 6 | 手写 CSS + 设计令牌 | 无框架体积与版本税；主题/强调色/字体/栏宽全可调（5 主题 × 4 强调色） | 4600+ 行 CSS 全自己维护，令牌纪律靠 review（`DESIGN.md` 是机器可读的令牌契约） |
| 7 | Electron 安全基线不放松，本地能力走「薄 IPC + 环回 HTTP」 | 渲染进程拿不到 Node；所有文件操作被限制在选定目录内（路径越界直接拒绝） | 桥的令牌是本机唯一凭据，明文可得；能力被限制为「只能导入」，不能读笔记 |
| 8 | 测试以纯逻辑为主（node 环境），无 jsdom/Testing Library/Playwright | 逻辑在 `.ts` 里，最快最稳的测试就是直接测它们；E2E 用脚本在真实浏览器/Electron 里跑 | 组件与 DOM 交互缺自动化测试，需改 CSS/DOM 时更依赖人工与脚本验证 |

---

## 7. 状态管理实际长什么样

整个应用状态层只有下面这 39 行（`src/lib/store.ts`），React 通过 `useSyncExternalStore` 订阅：

```ts
export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      const value = typeof next === "function" ? (next as (prev: T) => T)(state) : next;
      if (Object.is(value, state)) return;   // 同一引用不通知
      state = value;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
export const useStore = <T>(s: Store<T>) => useSyncExternalStore(s.subscribe, s.get, s.get);
```

仓库里有多个这样的 store：`libraryStore`（vault）、`workspaceStore`（注册表）、`ui`（设置）、`inbox`（收件箱）。
**这是理解本项目 React 用法的钥匙**：状态不放在组件树里，而是放在模块级 store，组件只是订阅者。

---

## 8. 样式分层（读代码的顺序）

```
tokens.css  → 设计令牌唯一产地（--s1…--s7 间距、--dur* 动效、[data-theme] 五套配色、强调色）
base.css    → 全局重置、排版基线、无障碍基线
prose.css   → 正文（阅读态）排版：表格、引用、代码块、标题层级
editor.css  → CodeMirror 外壳与行内渲染出的 widget（公式/图表/图片）
app.css     → 应用外壳与组件（侧栏、标签、状态栏、对话框…）2693 行
```
`DESIGN.md` 是这份令牌契约的**面向人/机器双读版本**（颜色、字体、布局、层级、形状、动效、组件、状态、无障碍、主题契约、Do's & Don'ts、响应式、改动手册、已知缺口、事实来源）。
改样式的纪律：**引用 `{token.name}`，不要抄字面值**；硬编码值属于待收敛的偏差。

---

## 9. 质量门禁

| 命令 | 作用 |
| --- | --- |
| `pnpm typecheck` | 严格模式全量类型检查 |
| `pnpm test` | Vitest 单测：路径与安全校验、四种后端语义、数据层回归（并发扫描、外部改动、快照与回收站、导入不覆盖）、Markdown 语法树、编辑器设置、模糊匹配 |
| `pnpm build` | 类型检查 + 生产构建（注入严格 CSP；语言分包与 Mermaid/KaTeX 放 `assets/lazy/` 按需缓存） |
| `pnpm release:check` | 发布门禁：版本号 / CHANGELOG / git tag 三者一致 |
| `D24_BENCH=1 npx vitest run src/editor/perfD24.test.ts` | 大文档渲染性能基准（平时跳过） |

---

## 10. 第一次上手，按这个顺序读

1. `README.md` §技术栈与架构（先有地图）
2. `src/main.tsx`（75 行）→ `src/lib/store.ts`（39 行）→ `src/components/StatusBar.tsx`（146 行）：最小的完整链路
3. `src/data/workspaces.ts` 的 `resolveBackend`：理解「一份代码四种后端」
4. `src/data/library.ts` 的 `persistNoteSoon` / `flushAll` / 快照：理解「文件是唯一真相」
5. `src/editor/setup.ts` → `src/editor/livePreview.ts`：理解所见即所得怎么实现
6. `src/styles/tokens.css` + `DESIGN.md`：理解设计系统
7. 桌面/剪藏：`electron/preload.cjs`（薄接口）→ `electron/bridge.cjs` 头部注释（安全边界清单）→ `src/data/inbox.ts`（状态机）

---

## 11. 事实来源与核实方式

本文所有数字均由仓库源码实读得出，可逐条复核：

| 结论 | 核实命令 / 文件 |
| --- | --- |
| 版本号、脚本、依赖 | `package.json` |
| 编译器严格度 | `tsconfig.json` |
| 测试环境与包含范围 | `vitest.config.ts`（`environment: "node"`） |
| 文件规模（141 `.ts` / 19 `.tsx` / 6 `.css`，约 4.5 万行） | `find src -type f`、`wc -l` |
| 令牌与主题数 | `src/styles/tokens.css`（`--s1`…`--s7`；`[data-theme]` 五套） |
| 防抖与快照策略 | `src/data/library.ts`（`persistNoteSoon(id, delay = 450)`、`SNAPSHOT_INTERVAL`、`SNAPSHOT_KEEP`） |
| Electron 安全基线 | `electron/main.cjs`（`contextIsolation: true` / `nodeIntegration: false` / `sandbox: true` / `webSecurity: true`） |
| 本地桥边界 | `electron/bridge.cjs` 头部设计边界清单；`src/lib/importBridge.ts` |
| 性能阈值 | `src/editor/livePreview.ts`（`MAX_DECORATED_LENGTH = 800_000`）、`src/editor/perfD24.test.ts` |
| 未安装 jsdom / Testing Library / Playwright / ESLint / Prettier | `ls node_modules`（均不存在） |

配套阅读：设计令牌与视觉契约见 [`DESIGN.md`](../DESIGN.md)；更新机制见 [`docs/update/00-更新机制.md`](update/00-更新机制.md)；导入信封契约见 [`docs/import/`](import/)；学习路线见 [`docs/learning/frontend-knowledge-map.md`](learning/frontend-knowledge-map.md)。
