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

**为什么扩展现在做不了自动更新**（这是「没上架」的技术后果，不是没来得及写）：

- `chrome://extensions` 里「加载已解压的扩展程序」装出来的扩展**没有更新通道** —— 没有
  `update_url`，浏览器也不会去问任何地方。升级只能是「下载新 zip → 解压覆盖 → 点重新加载」。
- 自托管 CRX + `update_url` 只在**企业策略/注册表安装**下被 Chrome 接受；个人用户那条路是关着的。
- 商店级自动更新要先把扩展上架（Edge Add-ons 免费，Chrome Web Store 一次性 $5），
  上架后浏览器自己管版本 —— 那时候「扩展更新」这件事根本不用我们写代码。
- 所以这一轮桌面端做了自更新，扩展**明确不做**；等分发通道定了再谈（见第 6 节坑 #6：
  扩展与桌面版分开分发，release notes 里要写「扩展 x.y 需要桌面版 ≥ a.b」）。

## 5. 平台与签名（现状：一个都没签）

- **Windows**：没签名 → 首次运行会出现「Windows 已保护你的电脑」。README 里已如实写明「更多信息 → 仍要运行」。
  要治本：**SignPath Foundation**（开源项目免费）或 **Certum Open Source Code Signing**；EV 证书对本项目不必考虑。
- **macOS**：`electron-builder.yml` 里声明了 `dmg`，但没有 Apple 开发者账号（$99/年）与公证，
  发出去等于让用户对着 Gatekeeper 报错发呆。**没预算就先别发 mac**。
- **Linux**：`AppImage` 同样是声明状态，未验证。
- **更新机制**：桌面版自 0.6.0 起有**用户点击式**自更新（拉 GitHub Release → 校验 → 重启覆盖），
  见下面第 7 节。它不依赖签名，但也**不是静默更新**：每次更新用户都要点一次「重启并更新」，
  且新 exe 未签名 → 更新后第一次运行仍会过一次 SmartScreen。要静默更新，顺序仍然是
  「先有签名 → 再上 `electron-updater` + NSIS」。

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

10. **主进程写 `resources/app.asar` 会被 Electron 的 fs 补丁拦下（0.6.0 自更新第一次端到端抓到的）**：
    补丁把「路径里含 `.asar`」的写操作当成「在 asar 包里写文件」，于是解压免安装包（里面就有
    `resources/app.asar`）时它会去 open 那个还不存在/正写到一半的归档，抛
    `Invalid package`（栈：`WriteStream._construct → Object.open → createError`）。
    现象是「下载与校验都成功，解压必失败」，界面只说「更新失败，请稍后重试」。
    修法：解压与删除 staging 期间置 `process.noAsar = true`（见 [`electron/zip.cjs`](electron/zip.cjs)
    的 `withAsarDisabled`），覆盖脚本里也置了一次作第二道保险。
    **别再把这个开关当成多余的一行删掉** —— `src/desktop/zip.test.ts` 有一条断言咬它。

## 7. 桌面版自更新（0.6.0 起）

用户可见的行为、失败矩阵与设计取舍见 [`docs/update/00-更新机制.md`](docs/update/00-更新机制.md)；
这里只写**维护者必须知道的部分**。

**一条链路**（全部在主进程，渲染层只说状态）：

```
启动 5s 后 GET api.github.com/repos/<owner>/<repo>/releases/latest
  → tag 比 app.getVersion() 新 且 有 Opennote-<版本>-win-x64.zip
  → 左上角出现强调色下载图标（无更新时不占位）
  → 点击：SHA256SUMS 逐字节校验 → 解压到 userData/updates/staging-<版本>/
  → 图标变重启图标 → 点击 + 确认
  → D11 落盘握手 → 关窗 → staging 里的**新 exe** 以 ELECTRON_RUN_AS_NODE 跑覆盖脚本
  → 复制到安装目录（exe 最后）→ 启动新版本 → 新版本启动时清掉 staging 与 zip
```

**维护者需要守住的四件事**：

1. **资产名不许改**：`Opennote-<版本>-win-x64.zip` + `SHA256SUMS`（`.github/workflows/release.yml`
   的 `artifactName` 与 `scripts/make-checksums.mjs` 已经是这个名字，改了三处要一起改）。
2. **`package.json` 的 `repository.url` 是仓库身份的唯一产地**（更新器不读 `homepage` —— 它曾经指向
   一个不存在的组织）。改仓库地址 = 改这里。
3. **主进程不许 require 第三方包**（见第 6 节坑 #4）：更新器的解压是自己写的
   （[`electron/zip.cjs`](electron/zip.cjs)），只认 store/deflate，逐条 CRC，拒 ZIP64/加密/`..` 越界。
4. **CSP 不动**：网络只在主进程发生，渲染层的 `connect-src` 仍然是 `'self' file:`。
   `scripts/ipc-safety-check.cjs` 会断言渲染层没有「传 URL / 传路径」的入口。

**发布日演练（每个版本都做，5 分钟）**：用**上一个版本**的旧包，对着新发的 Release 走一遍
「图标出现 → 下载 → 重启覆盖 → 关于页版本号变了」。这是唯一能证明「asar 里的版本号真的换掉了」
的证据（本地 e2e 用的是假包，见下）。

```shell
node scripts/update-e2e.cjs        # 或 pnpm update:e2e
```

端到端：临时安装目录 + 本地假 Release + 真覆盖脚本 + CDP 驱动（约 1–3 分钟，当前 **PASS 10 / FAIL 0 / SKIP 1**，
SKIP 那条是「新进程的调试端口重新绑定」这个 harness 限制）。

它**不覆盖**：真实 GitHub 网络、真实发布包的版本号变化、只读安装目录（Program Files）、
覆盖途中断电。这四条的现状：真实网络与只读目录靠代码里的明确错误分支（`NETWORK` /
`READ_ONLY_INSTALL`，界面有可执行文案）；断电容错靠覆盖顺序（exe 最后）+ `.applying` 标记
+ 下次启动如实报 `APPLY_FAILED`，**没有**做原子替换。

**回滚**：Release 全部留着，所以「回滚」对用户就是下载旧 zip 解压覆盖（不需要本地留备份）。
本地 `userData/updates/` 里的 staging 与 zip 会在更新成功后自动清掉。

## 8. 回滚

- 只是资产有问题：`gh release upload <tag> <file> --clobber` 覆盖，或 `gh release delete <tag>`。
- 版本发错了：删 Release 与 tag（`git push origin :refs/tags/vX.Y.Z`）后重打。注意重推同名 tag 会再触发一次流水线。
- 桌面版的自更新只在**用户点击**时发生，所以发错版本不会自动扩散：修好资产后，用户下次点「检查更新」
  就会拿到修好的包；已经装上的用户重新下载旧 zip 解压覆盖即可。
