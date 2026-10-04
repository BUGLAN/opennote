# 发布与分发

面向维护者。产物清单、验证方式、分发通道、已知坑都在这里。
相关文件：[`scripts/release-version.mjs`](scripts/release-version.mjs)、[`scripts/pack-extension.mjs`](scripts/pack-extension.mjs)、
[`scripts/make-checksums.mjs`](scripts/make-checksums.mjs)、[`.github/workflows/release.yml`](.github/workflows/release.yml)、
[`electron-builder.yml`](electron-builder.yml)。

## 1. 版本号从哪来

| 产物 | 真源 | 说明 |
| --- | --- | --- |
| 网页版 / 桌面版 | 根 [`package.json`](package.json) 的 `version` | 发布 tag 必须与它逐字一致 |
| 剪藏扩展 | [`extension/package.json`](extension/package.json) + [`extension/src/manifest.json`](extension/src/manifest.json) | 两处必须一致；扩展有自己的生命周期（当前 `0.1.x`），**不**跟根版本同号 |

```shell
pnpm release:check                        # 门禁：版本合法 + 扩展两处一致 + CHANGELOG 有当前版本条目
pnpm release:check --tag v0.4.0           # CI 用的口径：再多查 tag 与 package.json 一致
pnpm release:version 0.4.1                # 写根版本（只改那一行，不重排文件）
pnpm release:version 0.4.1 --extension 0.1.5   # 连扩展两处一起写
```

`CHANGELOG.md` 必须同时有 `## [Unreleased]` 段与**当前版本**的条目；没有条目就说明
「这个版本要发什么」没人写过，门禁会直接拦下来（`FAIL [V-4]`）。

## 2. 本地出一次完整发布

```shell
pnpm release:check
pnpm release:version 0.4.1        # 只在下一个版本需要（当前 package.json 已是 0.4.0）
# 编辑 CHANGELOG.md：把 [Unreleased] 的内容落到 ## [0.4.1]
pnpm release:check
pnpm release:build                # 一条命令出齐下面三样
```

`pnpm release:build` = `build:desktop` → `electron-builder` → 扩展构建 + zip → SHA256SUMS，
产物全在 `release/`：

| 产物 | 给谁 | 怎么用 |
| --- | --- | --- |
| `Opennote-<版本>-win-x64.zip` | Windows 用户 | 解压到任意目录，双击 `Opennote.exe`（免安装、不写注册表） |
| `Opennote-clip-<版本>.zip` | 剪藏扩展用户 | 解压后在 `chrome://extensions` 打开「开发者模式」→「加载已解压的扩展程序」；也是商店上传用的同一份 zip |
| `SHA256SUMS` | 所有人 | `sha256sum -c SHA256SUMS`（Windows 在 Git Bash 里跑） |

体积基线（0.4.0 实测，改体积前先看 [`electron-builder.yml`](electron-builder.yml) 文件头的说明）：

| 指标 | 改动前 | 现在 |
| --- | --- | --- |
| `resources/app.asar` | 203.6 MB | 11.08 MB |
| `release/win-unpacked/` | 573.3 MB | 378.5 MB |
| 交付 zip | 198.5 MB（0.2.0） | 151.1 MB（0.4.0） |

## 3. 打 tag 触发 CI

```shell
git add -A && git commit -m "chore(release): 0.4.0"
git tag v0.4.0
git push origin main --tags
```

[`release.yml`](.github/workflows/release.yml) 在 `windows-latest` 上依次做：
门禁（tag/版本/CHANGELOG）→ 单测（渲染层 705 例 + 扩展 144 例）→ 桌面 zip → 扩展 zip →
SHA256SUMS → 存 Actions artifact → 建/更新 GitHub Release（`--generate-notes`）。

重跑：Actions → Release → Run workflow，填一个已存在的 tag（用 `--clobber` 覆盖同名资产）。

## 4. 分发通道：现在与将来

仓库**目前是私有的**，这决定了今天能用的通道；转公开后同一批资产自动对公众可见，流水线不用改。

| 面 | 私有期间 | 仓库公开后 |
| --- | --- | --- |
| 网页版 | 只能本地 `pnpm dev` / `pnpm preview`；Pages 对私有仓库需要 Pro，且当前 `buglan.github.io/opennote` 是 404 | GitHub Pages（[`deploy.yml`](.github/workflows/deploy.yml) 已就绪）或 Cloudflare Pages / Vercel（都支持私有仓库，转公开后也照用） |
| 桌面版 | Actions 的 artifact（协作者可下）、Release（协作者可见） | GitHub Releases 为权威源；再加 **Scoop**（最适合这种绿色 zip）→ **winget**（需先有 NSIS 安装器）；国内加一层镜像（Gitee Releases / 对象存储），因为 GitHub 下载慢 |
| 剪藏扩展 | Release 里的 zip + 开发者模式加载 | Chrome Web Store（一次性 $5）→ Edge Add-ons（免费）；Firefox AMO 需先把 `background.service_worker` 适配成 Firefox 的 MV3 形态 |

## 5. 平台与签名（现状：一个都没签）

- **Windows**：没签名 → 首次运行会出现「Windows 已保护你的电脑」。README 里已如实写明「更多信息 → 仍要运行」。
  要治本：**SignPath Foundation**（开源项目免费）或 **Certum Open Source Code Signing**；EV 证书对本项目不必考虑。
- **macOS**：`electron-builder.yml` 里声明了 `dmg`，但没有 Apple 开发者账号（$99/年）与公证，
  发出去等于让用户对着 Gatekeeper 报错发呆。**没预算就先别发 mac**。
- **Linux**：`AppImage` 同样是声明状态，未验证。
- **更新机制**：现在**没有**自动更新（依赖里没有 electron-updater）。
  免安装 zip 的升级方式就是「下载新 zip 解压覆盖」——用户数据在自己的笔记本目录里，不受影响。
  想上静默更新，顺序必须是「先有签名 → 再上 `electron-updater` + NSIS」，否则每次更新都要用户过一遍 SmartScreen。

## 6. 已知坑（都实测过，别再踩）

1. **`building target=zip` 报 `Cannot read properties of undefined (reading 'ReadWrite')`** ——
   `app-builder-lib@26.15.3` 声明 `@electron/get@^3.0.0` 却调用 5.x 才有的 `ElectronDownloadCacheMode`；
   26.15.3 已是最新，升级无解。修复在 [`pnpm-workspace.yaml`](pnpm-workspace.yaml) 的 `overrides`
   里（钉到 5.1.0）。**删了它 `pnpm package:desktop` 就会重新失败。**
2. **pnpm 版本必须是 11**：`pnpm-workspace.yaml` 用了 pnpm ≥10 的 `allowBuilds`（不给 electron 放行
   安装脚本，就拿不到 `node_modules/electron/dist`，打包必失败），而 pnpm 9 读这个文件会直接报
   `packages field missing or empty`。两个 workflow 都钉 11。
3. **冒烟测试必须用独立 `--user-data-dir`**：打包版受单实例锁保护（[`electron/main.cjs`](electron/main.cjs):1912），
   如果本机已有另一个 Opennote（包括 `pnpm dev:electron` 起的 `electron.exe`）在跑，打包版会在
   0.5 秒内以**退出码 0** 静默退出——看起来像「打包坏了」，其实是对的。
   验证命令：`release\win-unpacked\Opennote.exe --user-data-dir=<临时目录>`。
4. **别再让 `node_modules` 进 asar**：主进程只 require `electron` 与 node 内置模块
   （[`electron/main.cjs`](electron/main.cjs):23-32、[`electron/bridge.cjs`](electron/bridge.cjs):61-68）。
   将来主进程真要 require 第三方包，必须同时改 `electron-builder.yml` 的 `files`，否则启动即
   `Cannot find module`。
5. **`dist/` 与 `dist-clip/` 是两套产物**：主构建会 `emptyOutDir` 掉 `dist/`，剪藏页走
   `vite.clip.config.ts` 输出到 `dist-clip/`。`electron-builder.yml` 的 `files` 里两行都不能少，
   否则桥的 `GET /clip/<stageId>` 会 404。
6. **扩展与桌面版是分开分发的**，必然出现版本混搭：release notes 里建议带一句「扩展 x.y 需要桌面版 ≥ a.b」
   （桥有 token / 端口 / 错误码契约，见 [`docs/import/02-接口契约-导入信封与通道.md`](docs/import/02-接口契约-导入信封与通道.md)）。
7. **`release/` 里的旧产物不会自动清理**：`make-checksums.mjs` 默认只收「当前版本」的产物
   （文件名带根版本或扩展版本），旧 zip 会被跳过并打 `WARN`，不会被写进 `SHA256SUMS`。
8. **仓库必须有 `.gitattributes`（v0.4.0 首次 CI 发布踩过）**：没有它，windows-latest runner 自带
   `core.autocrlf=true`，把检出源码全改写成 CRLF，`clip-web-stage.test.mjs` 的源码文本断言
   （`indexOf("\n}\n")`）就永远匹配不到 → CI 扩展单测必红而本地全绿（本地工作区一直是 LF）。
   排查手法：用 `git worktree add` 造一个全新检出（会吃 autocrlf），本地就能复现 CI 的红。
   **删了 `.gitattributes` 这类「本地绿、CI 红」会复发。**
9. **pnpm 11 全新安装不跑 electron 的 postinstall（v0.4.0 第二次 CI 发布踩过）**：
   `pnpm install --frozen-lockfile` 在干净环境（CI runner、全新 clone）不执行 electron 的
   `install.js` —— `allowBuilds: electron: true` 写了不跑、`sideEffectsCache: false` 不跑、
   去掉 `--frozen-lockfile` 也不跑（pnpm 11.21.0 实测；本机不犯是因为旧安装时代 dist 已生成）。
   后果是 `node_modules/electron/dist` 缺失，electron-builder 以
   `The specified electronDist does not exist` 秒败。修法：[release.yml](.github/workflows/release.yml)
   在 install 后显式 `node node_modules/electron/install.js`（幂等）。
   本地全新 clone 后想手动补：跑同一条命令即可。

## 7. 回滚

- 只是资产有问题：`gh release upload <tag> <file> --clobber` 覆盖，或 `gh release delete <tag>`。
- 版本发错了：删 Release 与 tag（`git push origin :refs/tags/vX.Y.Z`）后重打。注意重推同名 tag 会再触发一次流水线。
- 桌面版没有自动更新，所以「回滚」对用户就是重新下载旧 zip 解压覆盖。
