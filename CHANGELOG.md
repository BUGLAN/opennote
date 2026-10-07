# 更新日志

本项目按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 记录，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

发布流程见 [RELEASING.md](RELEASING.md)。注意：`pnpm release:check` 会检查**当前版本**
在这个文件里有条目 —— 没有条目就说明「这个版本要发什么」没人写过，发布流水线会拦下来。

## [Unreleased]

（下一批改动写这里。发布时把这一节落成 `## [x.y.z] - 日期`，并跑 `pnpm release:version x.y.z`。）

## [0.7.4] - 2026-10-08

### 修复

- **网页版设置页不再显示「版本未知」和「读取更新状态失败」**：版本号之前只有一个产地——
  桌面 preload 的 `window.opennote.version`，网页版没有桥，关于页只能写「版本未知」；
  更新一栏还会误报「读取更新状态失败」（网页版不是读取失败，是根本没有更新通道）。
  现在构建时把根 `package.json` 的版本号烧进网页包（Vite `define`），关于页照常显示
  `v0.7.x`；更新一栏如实说「网页版 v0.7.x · 自动更新只在桌面版提供」。桌面端行为不变
  （仍以运行时的 `app.getVersion()` 为准，构建常量只是兜底）。`src/lib/appVersion.ts`
  是版本号在渲染层的唯一产地，两处都读不到才显示「版本未知」。

## [0.7.3] - 2026-10-08

### 修复

- **下载完没重启就关软件，重开后「已下载」过一会儿又变回「下载更新」**：启动恢复的
  「已下载待重启」状态会被启动 5 秒后的自动检查（或手动「检查更新」）覆盖成
  `available` / `error`——`check()` 里没有 `ready` 分支，查到新版本就无条件改状态，
  用户被要求重新下载 151 MB，而 staging 包明明还在磁盘上；不下载就关软件的话，
  下次启动又被恢复成「已下载」，如此反复。现在检查只负责刷新元数据：
  staged 版本仍是最新 → 保持「已下载」（并补齐 release 链接与真实包大小）；
  GitHub 出了比 staged 更新的版本 → 清掉过期 staging，正常提示下载新版本；
  检查失败（断网/限流）→ 保持「已下载」，错误只进日志。护栏见
  `src/desktop/updateServer.test.ts` 新增的 4 条回归。

## [0.7.2] - 2026-10-07

### 修复

- **命令面板打字时输入框会上下跑**：面板高度随结果条数实时变（`max-height` 封顶），而它挂在
  `place-items: center` 的浮层里 —— 结果一变，整块面板连同输入框就被重新垂直居中。
  真 Chrome 实测：1440×900 下从 60 项（空查询）打到 5 项（「导入」），输入框下跳 **111.03px**，
  1024×640 / 820×600 下分别是 25.23px / 12.03px。现在面板单独走顶部锚定
  `.overlay-root--palette`（上边距 `max(24px, 17vh)`；17vh = 满高面板居中时的上边距，
  结果最多时观感与原来一致），变短只朝下收缩：同三档视口复测位移 **0 / 0 / 0**，
  对话框与收件箱的居中浮层不受影响。护栏见 `src/data/paletteLayout.test.ts`。

## [0.7.1] - 2026-10-07

### 修复

- **扩展 0.2.0 的「剪藏到 \<网页版\>」永远报没有权限**（扩展 0.2.1）：`chrome.permissions.request`
  要求调用点处在**用户手势**里，而 0.2.0 把它放在了 service worker —— 手势不会跨进程传过去，
  Chrome 直接拒掉。真机现象是：点一下按钮，**一次授权气泡都没弹过**，立刻出现
  `IMP-3001`「没有获得访问 buglan.github.io 的权限，这次剪藏没有发送。」
  现在申请挪进 popup（那里正是那次点击），service worker 只做 `contains` 复核。
  装 0.2.1 的方式照旧：下载新的扩展 zip 解压覆盖后点「重新加载」。

### 变更

- **扩展门禁 V17B 补一条分工判据**：`chrome.permissions.request` 只许出现在 popup 里，
  background 里出现即红（并新增第 10 个变异证明这条判据真的能红）。
  `tools/cdp-inpage-check.mjs` 也补了回归判据：用 CDP 发一次**可信点击**，断言不会当场
  出现那句失败文案（0.2.0 会当场红；0.2.1 的现场是按钮变「正在剪藏…」、`data-busy=true`）。

## [0.7.0] - 2026-10-07

### 新增

- **GitHub 仓库当笔记本（网页版）**：笔记本菜单里多了「从 GitHub 仓库导入…」。填 `owner/repo`
  （或整条 GitHub 地址、`git@github.com:…`、带 `/tree/<分支>` 的地址）就能把仓库拉成一本**可编辑**的
  本地笔记本：笔记是 `.md`、图片也一起下来，搜索、标签、大纲、历史快照全都照常。公开仓库不用令牌；
  要**把改动同步回仓库**、或要导入私有仓库，就在对话框里填一个访问令牌（只存在这个浏览器里，
  不写进笔记本文件夹，也不进日志）。
- **双向同步**：状态栏出现 `GitHub · owner/repo`，点它比较本地与远端。推送走**一个提交**
  （blob → tree → commit → ref），提交信息可改；远端在我们读取之后前进过就**中止**而不是强推。
  拉取只覆盖「本地没动过」的文件；两边都改过的会逐条列出来、**一个字节都不动**，要覆盖得自己点
  「用远端覆盖这些文件」。`.opennote/`（状态文件、历史快照、回收站）永远不推送。
- **剪藏到已打开的网页版**（剪藏扩展，扩展版本 **0.2.0**）：浏览器里开着 Opennote 网页版时，扩展弹窗
  会在 `剪藏到 Opennote` **上方**多出一颗 `剪藏到 <域名>` 的按钮（例如 `剪藏到 buglan.github.io`），
  点一下就把这一页交给那个标签页入库 —— 不需要桌面版、也不需要本地接口。这正是契约里
  写了很久、一直没实现的**页面内桥**（`postMessage`，`docs/import/02` §5.7）。
  升级方式照旧：下载新的扩展 zip 解压覆盖后点「重新加载」（扩展没有自动更新通道）。

### 变更

- **剪藏扩展新增 `tabs` 权限**：只有读标签页的 URL / 标题才能发现「哪个标签页是 Opennote 网页版」
  （`activeTab` 只覆盖当前页，而用户此刻剪的是**别的**页面）。同时新增两条**可选**主机权限声明
  （安装时**没有**任何提示），真正申请的时机只有一个：用户点那颗按钮时，按那个站点的 origin
  申请一次。安装时会多一句「读取你的浏览记录」的提示 —— 我们只用 `url`/`title` 判断，不读历史、
  不读页面正文。
- **网页版 CSP 放行两个 GitHub 来源**（`api.github.com` / `raw.githubusercontent.com`），桌面版不放。
- **契约订正**（`docs/import/02` §5.7）：页面内桥的页面侧校验不能要求
  `event.origin === chrome-extension://<id>` —— 内容脚本与页面共享同一窗口，同窗口消息的 origin
  必然是页面自己的。改为 `source === window` + 同源 + 形状 + `reqId` + 信封校验。
- **反向验证脚本的备份不再落在产物树里**（见下方修复）。

### 修复

- **剪藏扩展的反向验证脚本一直在给假结果**：变异用的备份文件写在 `src/` 与 `dist/` 里，
  而 `build.mjs` 会把 `src/**` 逐字拷进 `dist` —— 于是产物清单先红、门禁提前退出，
  9 个变异里 7 个报的是「未命中」。备份现在落在系统临时目录，9/9 全部命中期望文案。

## [0.6.1] - 2026-10-07

### 修复

- **侧栏底栏与右侧状态栏不在同一条线上**：左边「N 篇笔记」那条横线比右边状态栏那条高
  6.39px —— 脚注的高度原来是被里面的设置按钮撑出来的（36.39px），而状态栏写死 30px，
  于是两条底边线错开半个行高。现在脚注与状态栏共用同一个高度，两条线连成一条，侧栏
  列表的下沿正好落在右侧内容区的下沿上（这是顶行「侧栏头部 / 标签栏」同高的上下镜像）。
- **侧栏的工作区按钮不再贴着头部**：它原来上边距 0、下方留 8px，看起来像一条贴着头部的
  分割线。现在上下各 8px；这段间距从页签栏挪进工作区容器，两处不再各留一半。容器总高
  仍是 46px，所以标签栏及其以下的位置一点没动。

### 变更

- **文件树里的「全部笔记」行删掉了**：它不是筛选项 —— 整棵树本来就摊开在这里，点它只是
  把「当前文件夹」设回空，而同一个信息在页脚还有一份（N 篇笔记）。删掉后树的第一个节点
  就是「文件夹」分组，拖到根目录仍然走整棵树的投放区。
  一个副作用要知道：点文件夹行会把新建笔记的落点设成那个文件夹，此后没有可见入口把它
  重置回根目录（`Ctrl/⌘ + N` 建在「当前文件夹」里）。

## [0.6.0] - 2026-10-07

### 新增

- **桌面版可以自己更新了**：每次启动会只读一次 GitHub Releases（不上传任何数据，GitHub 会看到
  你的 IP），发现新版本时左上角（「Opennote」与「新建」之间）出现一个**强调色**下载图标 ——
  与旁边灰色的普通图标一眼可分。点它就从 Release 下载免安装包（`SHA256SUMS` 逐字节校验，
  校验不过直接丢弃），下完图标变成重启图标，点「重启并更新」并确认后：应用先保存未落盘的笔记，
  然后关闭、把新版本覆盖到当前目录、再自动打开。笔记文件在你自己的文件夹里，不受影响。
  设置 →「帮助」里另有一行「更新」，可以手动检查、下载或重启。
  只对**打包版 Windows x64** 生效（dev、浏览器、mac/Linux 不显示这个入口）；仍未签名，
  所以更新后第一次运行还会过一次 SmartScreen。详见 [docs/update/00-更新机制.md](docs/update/00-更新机制.md)。

### 修复

- **`package.json` 里的仓库地址是错的**：`homepage` 与 `repository.url` 都写着
  `github.com/opennote/opennote`，而真实仓库是 `github.com/BUGLAN/opennote`。
  自更新以 `repository.url` 判断「去哪问新版本」，写错的结果是每次检查都 404 ——
  界面上就是一个永远失败的图标。两处都改成真实仓库，并加了一条单测咬住
  「`homepage` 与 `repository.url` 必须指向同一个仓库」。
  （这条是自更新的端到端脚本第一次真跑时抓到的。）

## [0.5.0] - 2026-10-06

### 新增

- **侧栏可以拖宽了**：右边框上多了一条 6px 的把手，拖到 200–520px 之间的任意宽度，
  双击回到 268px，聚焦后 ←/→ 每次 8px（按住 Shift 24px）、Home / End 到两端；
  宽度存进本地设置，重开还在。拖动过程中只改 CSS 变量，松手才落盘，不跟着重渲染整棵树。
- **右键「复制地址」**：标签、文件树里的笔记行与文件夹行都有，复制的是它在**本机磁盘上的
  绝对路径**（和「在文件夹中显示」用的是同一份推导，不会出现两个地址）。
  浏览器 / OPFS 笔记本没有本机路径，这一项是**禁用**的，不是点了没反应的死项。
- **左上角那枚印章改成真图标**：新增 `public/seal/<强调色>-<明暗>.png` 一套 8 个
  （`pnpm icons` 生成，颜色直接解析 `tokens.css`，跟着强调色与亮暗走）。以前是
  `<span>記</span>` + CSS 背景色 —— 形状取决于机器上有没有宋体，也不和窗口/任务栏图标
  共用同一个绘制源。空态与启动页的印章不变。

### 修复

- **命令面板的搜索框被压扁**：面板顶到 `max-height` 时，60 条结果会把输入框从源码里的
  48px 挤到约 20px，文字几乎贴着上下边框。根因是列向 flex 里它没有 `flex: none`
  （`flex: 1` 的列表把空间抢走了）。现在 `flex: none` + 高度 56px，60 项时实测仍是 56px。

### 变更

- 侧栏头部：删掉「开源笔记」小字，高度 `48px → 40px`，与右侧标签栏同高、底边线连成一条。
- **收起 = 只收起左栏本身**：外壳改成两行栅格 —— 顶行是「侧栏头部 + 标签栏」，第 2 行是
  「侧栏身体 + 编辑器 + 状态栏」。收起时头部与标签栏那一行完全不动，只有身体消失，
  编辑器与状态栏绕到头部下面占满整宽（实测编辑器左边界从 268px 变成 0）。于是收起之后
  左上角那个按钮一直点得到，同时不再留下一条通到底的空带；标签栏也不会跳。
  `≤820px` 是抽屉：从顶行下面滑出，头部留在上面始终可用。
- **命令面板与所有对话框的圆角 `14px → 8px`**，与桌面端窗口边框的圆角一致（`--radius`）。
  `--radius-lg` 只剩拖放遮罩一处用处。

## [0.4.2] - 2026-10-06

### 新增

- 编辑器里**右键图片 →「复制图片」**：截图、照片、矢量图都能复制进系统剪贴板，贴到别的应用
  里就是一张 PNG（本地 PNG 原样写入、不重编码；其它格式过一遍画布转 PNG；图没找到或环境
  不允许时**如实报错**，不假装成功）。设置 · 格式 · 编辑操作里补了一句说明。

## [0.4.1] - 2026-10-04

### 修复

- 入库提示（toast）在长 CJK 标题下被撑成两行、撤销按钮竖排成一个字宽：
  消息恒单行省略、动作恒宽不换行，药丸宽度补 `min(420px, 100vw - 32px)` 响应式护栏；
  撤销降级说明独立成小字行，主文案保持完整（对齐 UI-05 文案冻结表）。

## [0.4.0] - 2026-10-01

第一个「有发布链路、能分发」的版本 —— 此前只能在本机打包，打出来的包没人拿得到、版本号也对不上。

### 新增

- 发布链路：[`scripts/release-version.mjs`](scripts/release-version.mjs)（版本一致性门禁 / 版本号写入）、
  [`scripts/pack-extension.mjs`](scripts/pack-extension.mjs)（扩展 zip，同一份 dist 可复现）、
  [`scripts/make-checksums.mjs`](scripts/make-checksums.mjs)（SHA256SUMS）、
  [`.github/workflows/release.yml`](.github/workflows/release.yml)（打 tag 即出产物 + Release 资产）、
  [RELEASING.md](RELEASING.md)（产物清单、分发通道、签名路线、实测坑）。
- 新命令：`pnpm release:check`、`pnpm release:version`、`pnpm release:build`、`pnpm pack:extension`、`pnpm checksums`。
- [README.md](README.md) 新增「下载与分发」一节（三种形态、校验和、签名与自动更新的现状）。

### 修复

- `pnpm package:desktop` 在本机与 CI 上必失败的上游 bug：`app-builder-lib@26.15.3` 声明
  `@electron/get@^3.0.0`，却调用只有 5.x 才导出的 `ElectronDownloadCacheMode`，导致
  `building target=zip` 抛 `Cannot read properties of undefined (reading 'ReadWrite')`。
  已在 [`pnpm-workspace.yaml`](pnpm-workspace.yaml) 用 override 钉到 5.1.0（上游修好后可删）。
- [`deploy.yml`](.github/workflows/deploy.yml) 钉的 pnpm 9 与本仓库 `pnpm-workspace.yaml`
  （用 pnpm ≥10 的 `allowBuilds`）不兼容：pnpm 9 读该文件会直接报 `packages field missing or empty`。
  两个 workflow 已统一到 pnpm 11。
- 首次 CI 发布在「单测（扩展）」必红而本地全绿：仓库缺 `.gitattributes`，
  windows-latest runner 的 `core.autocrlf=true` 把检出源码改写成 CRLF，
  `clip-web-stage.test.mjs` 的源码文本断言（`indexOf("\n}\n")`）在 CRLF 下永远匹配不到。
  已加 `.gitattributes` 统一 LF（png/ico 显式 binary），并把该坑记入 [RELEASING.md](RELEASING.md) §6。
- CI 打包秒败 `The specified electronDist does not exist`：pnpm 11 全新安装不执行 electron 的
  postinstall（`allowBuilds: true` 也不跑，pnpm 11.21.0 实测），`node_modules/electron/dist` 缺失。
  [release.yml](.github/workflows/release.yml) 在 install 后显式跑
  `node node_modules/electron/install.js`，坑记入 [RELEASING.md](RELEASING.md) §6。
  （以上两条随 tag `v0.4.0` 一起出的修复，整理 CHANGELOG 时从 Unreleased 归位。）

### 变更

- 桌面版体积：`resources/app.asar` 203.6 MB → 11.08 MB（打包时排除只在构建期使用的 `node_modules`，
  其中光 mermaid 源码就 118.8 MB），`win-unpacked` 573.3 MB → 378.5 MB，
  交付 zip 198.5 MB（0.2.0）→ 151.1 MB（0.4.0 实测）。主进程只 require `electron` 与 node 内置模块，
  功能不受影响（已实测：打包目录与交付 zip 解压后都能正常启动出窗口）。
- 版本号从 0.3.2 跳到 0.4.0：0.3.x 是「本机开发期」，0.4.0 起有可分发产物。

## [0.3.2]

首个纳入本文件的版本；此前的历史未回填（见 `git log`）。
