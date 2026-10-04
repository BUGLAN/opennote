# 更新日志

本项目按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 记录，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

发布流程见 [RELEASING.md](RELEASING.md)。注意：`pnpm release:check` 会检查**当前版本**
在这个文件里有条目 —— 没有条目就说明「这个版本要发什么」没人写过，发布流水线会拦下来。

## [Unreleased]

（下一批改动写这里。发布时把这一节落成 `## [x.y.z] - 日期`，并跑 `pnpm release:version x.y.z`。）

### 修复

- 首次 CI 发布（tag `v0.4.0`）在「单测（扩展）」必红而本地全绿：仓库缺 `.gitattributes`，
  windows-latest runner 的 `core.autocrlf=true` 把检出源码改写成 CRLF，
  `clip-web-stage.test.mjs` 的源码文本断言（`indexOf("\n}\n")`）在 CRLF 下永远匹配不到。
  已加 `.gitattributes` 统一 LF（png/ico 显式 binary），并把该坑记入 [RELEASING.md](RELEASING.md) §6。

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

### 变更

- 桌面版体积：`resources/app.asar` 203.6 MB → 11.08 MB（打包时排除只在构建期使用的 `node_modules`，
  其中光 mermaid 源码就 118.8 MB），`win-unpacked` 573.3 MB → 378.5 MB，
  交付 zip 198.5 MB（0.2.0）→ 151.1 MB（0.4.0 实测）。主进程只 require `electron` 与 node 内置模块，
  功能不受影响（已实测：打包目录与交付 zip 解压后都能正常启动出窗口）。
- 版本号从 0.3.2 跳到 0.4.0：0.3.x 是「本机开发期」，0.4.0 起有可分发产物。

## [0.3.2]

首个纳入本文件的版本；此前的历史未回填（见 `git log`）。
