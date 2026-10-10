# Opennote · 开源笔记

**笔记就是你磁盘上的 Markdown 文件。** 打开一个文件夹当作笔记本，Opennote 直接读写它 —— 没有数据库、没有账号、没有遥测、没有专有格式。样式和手感照 Typora 来：语法标记在你不编辑的行自动隐藏，光标回到那一行再露出来。

[![License: MIT](https://img.shields.io/badge/license-MIT-3da639.svg)](LICENSE)
![纯前端](https://img.shields.io/badge/%E7%BA%AF%E5%89%8D%E7%AB%AF-%E6%97%A0%E5%90%8E%E7%AB%AF-4c8c6a)
![桌面端](https://img.shields.io/badge/Electron-%E6%A1%8C%E9%9D%A2%E7%AB%AF-47848f)
![made with Vite + React + CodeMirror 6](https://img.shields.io/badge/made_with-Vite_%2B_React_%2B_CodeMirror_6-646cff)

<!-- 截图：由 `pnpm preview` + 真实构建抓取 -->
![Opennote：文件夹树、标签页、行内渲染的正文与文档大纲](docs/screenshot.png)

![暗色主题「夜读」](docs/screenshot-dark.png)

<details>
<summary>更多截图：命令面板 · 公式与图表 · 专注模式</summary>

![命令面板](docs/screenshot-palette.png)

![行内公式、块级公式与 Mermaid 图表](docs/screenshot-mermaid.png)

![专注模式：只留光标所在的段落](docs/screenshot-focus.png)

</details>

## 笔记放在哪里

一个「笔记本」就是一个真实文件夹，三种后端共用同一套文件系统接口：

| 场景 | 后端 | 说明 |
| --- | --- | --- |
| Electron 桌面版 | Node `fs` | 直接读写你选择的磁盘目录，就是本地软件 |
| Chrome / Edge 网页版 | File System Access API | 选一次文件夹并授权，之后直接读写磁盘；刷新后需要再点一次「授权」 |
| 任意现代浏览器（含 Firefox / Safari） | OPFS | 浏览器自己的文件系统。「导入文件夹」会把本地目录按**完整相对路径**拷进去；目标目录里已有同名文件时加序号（`笔记.md` → `笔记 2.md`），不会覆盖，跨目录的同名文件也互不影响 |

笔记文件夹里只有你能读懂的东西：

```
我的笔记/
├── 根笔记.md                  ← 笔记就是普通 Markdown 文件
├── 日记/
│   ├── 九月.md
│   └── assets/                ← 这篇笔记里粘贴的图片
└── .opennote/                 ← 附加信息，删掉也不影响正文
    ├── state.json             ← 星标、展开状态、上次打开的笔记、手动改过的显示名（重命名）
    └── history/根笔记.md/…    ← 版本快照（每 3 分钟自动留一次，最多 60 份）
```

IndexedDB 只在两处出现，都不存笔记内容：一是 Chrome 的文件夹**授权句柄**（句柄无法放进 localStorage，这是平台唯一可行的存法），二是 0.1 版的旧数据迁移（一次性读取，导完就不再使用）。

## 特性

- **所见即所得的编辑**：语法标记（`#`、`**`、`[]()`、代码围栏、`$$`）在你没有编辑的那一行自动隐藏，光标回到该行时重新出现；图片、表格、公式、Mermaid 图表直接在正文里渲染，编辑与预览是同一个界面。
- **文件夹就是笔记本**：多笔记本切换、文件夹树（拖拽移动）、多标签编辑、文档大纲、模糊匹配的命令面板。
- **GitHub 仓库也能当笔记本**（网页版）：笔记本菜单里选「从 GitHub 仓库导入…」，把公开仓库（或带令牌的私有仓库）拉成一本本地笔记本 —— 之后照常编辑、搜索、留历史快照；改动用**一个提交**同步回仓库，拉取时两边都改过的文件会逐条列出来、**不覆盖**。令牌只存在这个浏览器里，不写进笔记本文件夹。
- **找得到东西**：全文搜索带命中片段与高亮；标签支持正文 `#tag` 或 YAML front-matter；还有星标与回收站（回收站是 `.opennote/trash`，笔记不会凭空消失）。回收站里「彻底删除」是**真的删**：正文与它的历史快照（`.opennote/history/…`）一起清掉，同目录的 `assets/` 在没有别的笔记之后也会删；「清空回收站」对其中每一篇都这样做，操作前会告诉你会删掉多少条。
- **不怕写坏**：每次改动都防抖写回磁盘，状态栏显示「已写入磁盘」；每篇笔记保留版本快照，可回看并恢复；`[[wiki links]]` 在笔记之间互相跳转。
- **写作语法**：`==高亮==`、任务列表、图片粘贴与拖入（写进 `<笔记目录>/assets/`，正文里是 `./assets/xxx.png` 这样的相对路径，换任何编辑器都能看）。
- **外观可调**：5 套主题 × 4 种强调色，4 种正文字体预设，字号 / 行高 / 栏宽可调；打字机模式、专注模式，以及打印为 PDF 的样式表。

## 下载与分发

三种形态，同一份数据格式（笔记就是 Markdown 纯文件）：

| 形态 | 拿到它的方式 | 适合谁 |
| --- | --- | --- |
| 网页版 | 打开部署地址（PWA，浏览器里可「安装」到桌面） | 想零安装先用起来；也能把 GitHub 仓库当笔记本 |
| 桌面版 | Releases 里的 `Opennote-<版本>-win-x64.zip`，解压即用、免安装 | 要直接读写本机文件夹 |
| 剪藏扩展 | Releases 里的 `Opennote-clip-<版本>.zip`，在 `chrome://extensions` 用「开发者模式 → 加载已解压的扩展程序」安装 | 要把网页整块内容剪进收件箱；浏览器里开着网页版时会多一个「剪藏到 <域名>」的按钮 |

- 每个 Release 都带 `SHA256SUMS`，`sha256sum -c SHA256SUMS` 可验证下载完整性。
- 桌面版目前只有 **Windows x64 免安装 zip**，且**没有代码签名**：首次运行会出现「Windows 已保护你的电脑」，
  点「更多信息 → 仍要运行」即可。mac / Linux 的配置在 [`electron-builder.yml`](electron-builder.yml) 里声明了但尚未交付（未签名、未公证）。
- 桌面版**可以自己更新**（Windows x64）：启动时只读一次 GitHub Releases，有新版本就在左上角
  （「Opennote」与「新建」之间）出现一个**强调色**下载图标；点它下载并校验，图标变成重启图标后
  点「重启并更新」——应用先保存笔记，再关闭、覆盖当前目录、自动重开。设置 →「帮助」里也能手动检查。
  只读一次、不上传任何数据（GitHub 会看到你的 IP）；**没有**后台常驻检查，也不会静默安装。
  你的笔记在自己的文件夹里，不受影响；机制与边界见 [docs/update/00-更新机制.md](docs/update/00-更新机制.md)。
- 剪藏扩展**没有自动更新**：它没上架任何商店，`chrome://extensions` 的「加载已解压的扩展」也没有
  更新通道。升级就是下载新的 `Opennote-clip-<版本>.zip` 解压覆盖后点「重新加载」。
  将来上 Edge Add-ons（免费）或 Chrome Web Store 才有商店级自动更新，见 [RELEASING.md](RELEASING.md) 第 4 节。
- 仓库目前是私有的：公开之前 Release 与 Actions 产物只对协作者可见，网页版也还没有可访问的部署地址。
  打包与分发流程（版本门禁、产物清单、签名与商店路线、已知坑）见 [RELEASING.md](RELEASING.md)。

## 快速开始

需要 Node 20.19+ 与 pnpm 11+。

```shell
pnpm install
pnpm dev            # 浏览器开发服务器 http://127.0.0.1:5173
pnpm build          # 类型检查 + 生产构建，产物在 dist/
pnpm preview        # 本地预览生产构建
pnpm typecheck
pnpm test           # Vitest 单测
pnpm release:check  # 发布门禁：版本号 / CHANGELOG / tag 三者一致
pnpm release:build  # 一条命令出齐发布产物：桌面 zip + 扩展 zip + SHA256SUMS（在 release/）
```

桌面版：

```shell
pnpm dev:electron     # 一条命令：起 Vite + 开 Electron 窗口（热更新）
pnpm build:desktop    # 构建 Electron 用的资源（相对路径、关掉 Service Worker）
pnpm package:desktop  # 打包成免安装 zip → release/Opennote-<版本>-win-x64.zip
```

桌面版为什么单独构建：打包后的应用通过 `file://` 加载，资源必须用相对路径，`build:desktop` 会自动设置 `OPENNOTE_DESKTOP=1` 让 Vite 输出 `./assets/...` 并关闭 PWA。

## 桌面版（Electron）

- **没有窗口菜单栏**：桌面端不显示「文件 / 编辑 / 视图 / 帮助」那条原生横条，这些操作全部收进应用内的 **设置**（状态栏齿轮按钮，或 `Ctrl/⌘ + ,`），分成外观 / 文件 / 编辑 / 视图 / 帮助五类，按钮直接取自界面同一份命令注册表，和命令面板、快捷键完全一致。
- 应用图标与界面左上角的印章同源：`pnpm icons` 会从同一份绘制代码生成 `public/favicon.svg`、PWA 图标、`build/icon.ico`（多尺寸，打包时由 `electron-builder.yml` 的 `win.icon` 内嵌进 exe），以及界面左上角用的 `public/seal/<强调色>-<明暗>.png` 一套 8 个 —— 那套的颜色直接解析 `tokens.css`，所以**改了强调色要重跑一次 `pnpm icons`**。
- 安全基线保持默认：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，所有 IPC 文件操作都必须落在你选定的笔记本目录内（`../../../package.json` 这类路径会被拒绝并报「路径越界」）。
- preload 只暴露一层薄接口（`window.opennote`），渲染进程拿不到 Node 能力。macOS 上会保留一份只含系统角色的最小菜单（否则 ⌘C/⌘V/⌘Q 不生效），Windows/Linux 直接置空。
- 打包目标只有免安装 zip（便携、无需安装器）。想要 NSIS 安装包，把 `electron-builder.yml` 里 `win.target` 换成 `nsis` 即可。当前 zip 151 MB（Electron 本体占大头，`app.asar` 只有 11 MB）；发布流程见 [RELEASING.md](RELEASING.md)。

## 数据与备份

### 把 GitHub 仓库当笔记本（网页版）

1. 左侧点笔记本名 → **从 GitHub 仓库导入…**，填 `https://github.com/owner/repo`（也认 `owner/repo`、
   `git@github.com:owner/repo.git`、带 `/tree/<分支>` 的地址）。公开仓库**不用填令牌**。
2. 导入会把仓库里的 Markdown 与图片拉进一本浏览器本地笔记本（OPFS）—— 之后就是普通笔记本：
   编辑、搜索、标签、历史快照、导出 zip 全都照常。仓库里的源码 / 配置只记账、**不落地**。
3. 想改回仓库：填一个**有 repo 权限**的访问令牌（对话框里勾「记住令牌」），状态栏点
   `GitHub · owner/repo` → **提交并推送**。一次推送 = **一个提交**；推送前会先看分支头有没有前进，
   前进过就中止并让你先拉取（**不强推**）。
4. **从远端拉取**只覆盖「本地没动过」的文件；两边都改过的会逐条列出来、一个字节都不动，
   要覆盖得自己点「用远端覆盖这些文件」。`.opennote/`（状态文件、历史快照、回收站）永远不推送。
5. 令牌只存在这个浏览器里（不勾「记住」就只活到关标签页），**不写进笔记本文件夹**、不进日志；
   状态栏的「清除令牌」可以随时把它删掉。

> 一句话说明白边界：这本笔记本是**本地**的，GitHub 只在「导入」「推送」「拉取」这三个动作里出现；
> 离线照常编辑，联网后自己决定什么时候同步。

- **写入时机**：编辑时先更新内存，450ms 防抖后写入磁盘；切换笔记、切到后台、关闭窗口前都会强制落盘。状态栏的圆点表示还有未写入的改动。
- **导出整库**：`Ctrl/⌘ + K` → 「导出整库备份（zip）」，打包的就是笔记本文件夹本身（可用 `includeHistory` 选项排除历史快照）。
- **导入**：拖入 `.md` / `.zip` / 图片，或在设置 · 文件里选「导入文件或 zip」；导入会**写进笔记本目录**，同名文件自动加序号，不会覆盖（新建笔记同理：磁盘上已有同名文件时也加序号，而不是把它覆盖掉）。导入整库备份时会保留嵌套的 `assets/` 相对路径，跳过 `.opennote/` 与 `README.txt`。
- **名字冲突**：新建、导入、重命名前都会用后端复核目标名是否已存在（桌面端的 Windows / macOS 默认大小写不敏感，`README.md` 与 `readme.md` 视为同一个名字），已存在就加序号；只改大小写的重命名会走两步改名**真正改掉大小写**，不会变成 `名字 2.md`。
- **换电脑**：把文件夹拷过去（U 盘、网盘、Git 都行），在新机器上「打开本机文件夹」选择它即可。
- **注意**：浏览器后端的数据在浏览器自己的存储里，清理站点数据会一起清掉 —— 定期导出 zip，或者用桌面版/磁盘文件夹。

## 快捷键

macOS 用 ⌘，其他平台用 Ctrl。

| 动作 | 快捷键 |
| --- | --- |
| 命令面板 / 快速打开 | `Ctrl/⌘ + K`（别名 `Alt + K`） |
| 命令面板：只看命令 | `Ctrl/⌘ + Shift + P` |
| 全局搜索 | `Ctrl/⌘ + Shift + F` |
| 新建笔记 | `Ctrl/⌘ + N` |
| 新建文件夹 | `Ctrl/⌘ + Shift + N` |
| 立即保存并同步 | `Ctrl/⌘ + S` |
| 关闭当前标签 | `Alt + W`（安装为应用后 `Ctrl/⌘ + W` 也可用） |
| 下一个 / 上一个标签 | `Alt + →` / `←`（别名 `Ctrl/⌘ + Alt + →/←`） |
| 加粗 / 斜体 | `Ctrl/⌘ + B` / `Ctrl/⌘ + I` |
| 行内代码 | `Ctrl/⌘ + E` |
| 插入链接 | `Ctrl/⌘ + Shift + K` |
| 删除线 / 高亮 | `Ctrl/⌘ + Shift + X` / `Ctrl/⌘ + Shift + H` |
| 标题 1–6 级 | `Ctrl/⌘ + 1` … `Ctrl/⌘ + 6` |
| 无序 / 有序 / 任务列表 | `Ctrl/⌘ + Shift + 8` / `7` / `9` |
| 引用 / 代码块 | `Ctrl/⌘ + Shift + Q` / `C` |
| 表格 / 公式块 / 图表 | `Ctrl/⌘ + Shift + T` / `M` / `G` |
| 折叠侧栏 / 大纲 | `Ctrl/⌘ + \` / `Ctrl/⌘ + Shift + O`（别名 `Alt + O`） |
| 切换亮/暗 | `Ctrl/⌘ + Alt + T`（别名 `Alt + T`） |
| 打字机模式 / 专注模式 | `Ctrl/⌘ + Shift + Y` / `D`（别名 `Alt + Y` / `Alt + D`） |
| 设置 / 快捷键说明 | `Ctrl/⌘ + ,` / `Ctrl/⌘ + /` |
| 打印或导出 PDF | `Ctrl/⌘ + P`（别名 `Ctrl/⌘ + Alt + P`；打印时侧栏、大纲、标签栏、状态栏会自动隐藏） |
| 编辑器内查找 / 替换 | `Ctrl/⌘ + F` 打开查找面板，面板里带替换输入框；`Ctrl/⌘ + Shift + L` 选中全部匹配 |

浏览器会占用一部分快捷键（`Ctrl + W`、`Ctrl + P`、`Ctrl + K` 等）。上表里的 `Alt` 别名在任何浏览器里都能用；桌面版里没有这些限制，全部绑定生效。

## 主题

5 套主题：**素笺**（默认）、**青瓷**、**琥珀**、**夜读**、**砚池**；4 种强调色：**朱砂**、**靛青**、**松绿**、**藤黄**。`Ctrl/⌘ + Alt + T` 在亮色与暗色之间切换。

正文字体提供 4 种预设，另有「文楷」可选（按需从 `cdn.jsdelivr.net` 加载霞鹜文楷；离线或 CDN 被拦截时自动回退到系统楷体）。字号、行高、正文栏宽都可以在设置里调整。

## 导入导出格式

- **`.md`**：单篇导出为普通 Markdown；图片默认保留相对路径，也可以选择内联成 `data:` URL 得到单文件版本。
- **`.html`**：单篇导出为独立 HTML，样式内联、图片转成 `data:` URL，双击即可打开或分享。
- **`.zip`**：整库备份，内容就是笔记本目录（`.opennote/history` 默认不打包，`README.txt` 里写了怎么恢复）。导入时按文件性质处理：Markdown 变成笔记、图片进 `assets/`、其它文件跳过。

## 部署

### GitHub Pages

仓库自带 [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)：推送到 `main` 或手动触发 `workflow_dispatch` 时，用 Node 22 + pnpm 构建并发布 `dist/`。

启用方式：仓库 **Settings → Pages → Source** 选择 **GitHub Actions**，然后推一次 `main`。工作流用 `VITE_BASE=/${{ github.event.repository.name }}/` 指定子路径（默认 `/`）。

网页版构建的 CSP 里有一条 `connect-src 'self' https://api.github.com https://raw.githubusercontent.com` —— 那是「从 GitHub 仓库导入 / 同步」要用的；桌面版**不放开**这两个来源（它的策略在 `electron/main.cjs`，对应功能也不开放）。

### Vercel / Netlify / Cloudflare Pages

无需额外配置：构建命令 `pnpm build`，输出目录 `dist`。

## 技术栈与架构

- **构建**：Vite + React 19 + TypeScript
- **编辑器**：CodeMirror 6 作为编辑核心，`@lezer/markdown` 提供语法树，用于按行决定哪些语法标记要隐藏
- **文件系统**：`src/fs` 一层抽象，三种后端 —— Electron 的 Node `fs`、File System Access API、OPFS
- **渲染**：KaTeX 负责公式，Mermaid 负责图表，全部内联在编辑界面中
- **桌面端**：Electron 主进程（CommonJS）+ preload 桥，`contextIsolation` + `sandbox` 全开
- **样式**：手写 CSS，设计令牌 + 主题；字体自托管（`@fontsource-variable`：Fraunces、Newsreader、Figtree、JetBrains Mono），「文楷」按需从 `cdn.jsdelivr.net` 加载（网页版构建产物带 CSP：`script-src` 只有本站与页面内联脚本的 sha256，`cdn.jsdelivr.net` 只出现在 `style-src` / `font-src`）

```
src/
├── fs/          文件系统抽象：路径规则、句柄后端(FSA/OPFS)、Node 后端、上传导入
├── data/        笔记本：工作区注册表、文件↔笔记映射、元数据与历史快照、旧数据迁移
├── desktop/     Electron preload 桥的类型定义
├── editor/      CodeMirror 6 编辑器：Markdown 扩展语法、实时预览装饰、公式与图表 widget、命令与补全
├── components/  React 界面：侧栏文件树、标签页、大纲、命令面板、设置/历史/快捷键面板、浮层
├── lib/         通用工具：导入导出、模糊匹配、大纲提取、快捷键注册表、状态存储
└── styles/      手写样式：设计令牌与主题、基础层、正文排版、编辑器与外壳
electron/
├── main.cjs     主进程：窗口、IPC 文件操作（含路径越界防护与符号链接跳过）
└── preload.cjs  contextBridge：只暴露一层薄接口给渲染进程
```

## 质量与验证

- `pnpm typecheck`：TypeScript 严格模式全量检查（`strict` + `noUnusedLocals`）。
- `pnpm test`：700+ 个 Vitest 单测，覆盖路径规则与安全校验、三种文件系统后端（含大小写不敏感与移动/删除语义）、数据层回归（并发扫描、外部改动写冲突、快照与回收站清空、导入不覆盖同名）、Markdown 扩展语法树（行内/块级公式、`==高亮==`、`[[wiki links]]`、GFM 表格与任务列表及其缩进上下文）、编辑器设置状态、模糊匹配、字数统计。
- `pnpm build`：类型检查 + 生产构建。产物里网页版会注入一份严格 CSP（`script-src` 只有本站与页面内联脚本的 sha256），语言分包与 Mermaid/KaTeX 放在 `assets/lazy/` 里**不进安装期预缓存**，由 Service Worker 首次使用时按需缓存（离线仍可打开整个界面）。
- 端到端（真实浏览器 + 真实 Electron 进程）实测过：OPFS 笔记本的创建/写入/刷新后仍在、编辑器输入落盘、`.opennote/state.json` 与历史快照生成、Electron 通过 IPC 读写真实文件、`../../../package.json` 被拒绝。

## 路线图

- 元数据索引与正文懒加载：笔记本到万篇级时，打开只重读「变化过的文件」、正文按需加载
  （最近打开的常驻，其余放回磁盘）、全文搜索改用持久化纯文本快照。设计与全部消费点
  清单已定稿，见
  [docs/设计-同步层与索引重构-2026-10-10.md](docs/设计-同步层与索引重构-2026-10-10.md)
  的 §P2b（已裁定择期实施）。
- File System Access 的授权体验优化（记住授权、一次性授权多个目录）。
- 移动端布局优化。
- 笔记加密（本地口令加密，密钥不出设备）。
- 插件化的自定义主题。

## 参与贡献

1. Fork 本仓库并 clone 到本地。
2. `pnpm install`，`pnpm dev` 起开发服务器（桌面端用 `pnpm dev:electron`）。
3. 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)，例如 `feat(fs): 支持 OPFS 后端`、`fix(editor): 修正列表续写`。
4. 提交 PR 前跑一遍 `pnpm typecheck && pnpm test`。

## 许可证

[MIT](LICENSE) © 2025 Opennote contributors

## English

Opennote is a Typora-flavoured Markdown notebook **whose notes are plain files in a folder you choose**. There is no backend, no account, no telemetry and no proprietary format: open a folder and Opennote reads and writes the `.md` files inside it.

- **Where notes live** — three interchangeable backends behind one file-system interface: Node `fs` in the Electron desktop app, the File System Access API in Chrome/Edge, and OPFS in any modern browser (upload a folder and it is copied into the browser's own file system). Images go to `<note dir>/assets/`, starred notes and version snapshots to `<workspace>/.opennote/`. IndexedDB only ever stores Chrome's directory *handle* and one-time legacy data.
- **Seamless live preview** — syntax marks (`#`, `**`, `[]()`, code fences, `$$`) hide on the lines you are not editing and reappear under the cursor; images, tables, KaTeX formulas and Mermaid diagrams render inline.
- **Organise** — multiple notebooks, folder tree with drag & drop, tabs, outline, fuzzy command palette, full-text search with snippets, tags, starred notes, a trash folder and per-note version snapshots.
- **Desktop** — `pnpm dev:electron` for development, `pnpm package:desktop` for a portable zip. Native Chinese menu, `contextIsolation` + `sandbox` on, every path resolved inside the chosen workspace.
- **Release** — `pnpm release:build` produces the portable desktop zip, the clipper extension zip and `SHA256SUMS`; pushing a `vX.Y.Z` tag runs [`.github/workflows/release.yml`](.github/workflows/release.yml) and publishes them to a GitHub Release. Details in [RELEASING.md](RELEASING.md).

```shell
pnpm install
pnpm dev             # web dev server
pnpm build           # type-check + production build (dist/)
pnpm test            # Vitest
pnpm dev:electron    # desktop development
pnpm package:desktop # portable desktop zip
pnpm release:check   # release gate: version / CHANGELOG / tag consistency
pnpm release:build   # all release artifacts: desktop zip + extension zip + SHA256SUMS
```

Licensed under [MIT](LICENSE).
