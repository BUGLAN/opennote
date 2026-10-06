# 更新日志

本项目按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 记录，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

发布流程见 [RELEASING.md](RELEASING.md)。注意：`pnpm release:check` 会检查**当前版本**
在这个文件里有条目 —— 没有条目就说明「这个版本要发什么」没人写过，发布流水线会拦下来。

## [Unreleased]

（下一批改动写这里。发布时把这一节落成 `## [x.y.z] - 日期`，并跑 `pnpm release:version x.y.z`。）

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
