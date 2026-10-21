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

### macOS 单独出（0.14.0 起）

```shell
pnpm package:mac      # 只能在 macOS 上跑
```

一条命令做完 7 步（见 [`scripts/build-mac.mjs`](scripts/build-mac.mjs) 文件头）：构建渲染层 →
`electron-builder --mac --dir` → ad-hoc 签名 + 复验 → **真启动一次产物做冒烟测试** →
`hdiutil` 出 DMG → `ditto` 出 ZIP → 写 `SHA256SUMS`。全程**不需要联网**（这点是刻意的，
见第 6 节坑 #11）也不需要 Apple 开发者账号。

| 产物 | 给谁 | 怎么用 |
| --- | --- | --- |
| `Opennote-<版本>-mac-arm64.dmg` | macOS 用户（首选） | 打开 → 把 `Opennote.app` 拖进旁边的「应用程序」软链接 |
| `Opennote-<版本>-mac-arm64.zip` | macOS 用户（备选） | 解压即用；`ditto` 保留符号链接与可执行位，解出来必须是能跑的 `.app` |
| `release/mac-arm64/Opennote.app` | 本机自测 | 未压缩的 unpacked 产物，冒烟测试跑的就是它 |

签名与体积基线（0.14.0 在 arm64 上实测）：

| 指标 | 值 |
| --- | --- |
| `codesign -dv` | `Signature=adhoc`、`TeamIdentifier=not set` |
| `CodeDirectory flags` | `0x2(adhoc)` —— **不能带 `runtime`**（带了起不来，坑 #12） |
| `codesign --verify --deep --strict` | 通过 |
| `resources/app.asar` | **11 MB**（漏掉 `!node_modules/**/*` 时是 **219 MB**，见坑 #4） |
| App bundle / DMG / ZIP | 311 MB / **138.6 MB** / **126.5 MB** |
| `spctl -a -t exec` | `rejected`（预期：ad-hoc 过不了 Gatekeeper） |

## 3. 打 tag 触发 CI

```shell
git add -A && git commit -m "chore(release): 0.4.0"
git tag v0.4.0
git push origin main --tags
```

[`release.yml`](.github/workflows/release.yml) 两个 job：

1. `release`（`windows-latest`）依次做：门禁（tag/版本/CHANGELOG）→ 单测（渲染层 + 扩展）→
   Windows 桌面 zip → 扩展 zip → SHA256SUMS → 存 Actions artifact → 建/更新 GitHub Release
   （`--generate-notes`）。
2. `release-mac`（`macos-15`，arm64，`needs: release`）→ 单测 → `pnpm package:mac`（含签名复验与
   启动冒烟）→ 存 Actions artifact → 把 mac 的 dmg/zip 追加进同一个 Release，并把
   Windows 资产一起重新算一遍 **SHA256SUMS 覆盖上传**（`SHA256SUMS` 必须一份覆盖全部资产）。

mac job 是**纯追加**的：它不碰 Windows 那条链路，所以 macOS 打包出问题最多是「这个版本没有 mac 产物」，
不会连带把 Windows 发布弄挂。同理它也会因 runner 不是 arm64 而**明确失败**，而不是悄悄产出名字与
架构不符的包。

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
- **macOS**：**ad-hoc 签名**（`codesign -s -`），出 `.app` + DMG + ZIP，命令是 `pnpm package:mac`。
  - 为什么必须签、又不能真签：Apple Silicon 上内核要求每个可执行文件都有有效签名 ——
    Electron 发行版自带 ad-hoc 签名，但打包过程改了 Info.plist、重命名了可执行文件与 Helper、
    又加进了 `app.asar`，**原签名全部失效**，不重签就是「已损坏，无法打开」。
    ad-hoc 就是不依赖任何证书的本地签名：能过内核这一关，**过不了 Gatekeeper**。
  - 用户侧的表现与放行：从网上下载的包带 quarantine 标记，首次打开被拦。
    右键图标 →「打开」→「打开」，或 `xattr -dr com.apple.quarantine /Applications/Opennote.app`。
  - 要彻底消除这一步：Apple 开发者账号（$99/年）→ `Developer ID Application` 证书
    → `mac.identity` 换成该证书、`hardenedRuntime: true`、补公证（notarytool）。
    顺序不能反：**没有证书就别开 hardenedRuntime**（见第 6 节坑 #12）。
  - 架构：只出构建机架构（arm64 机器出 arm64）。跨架构要另配一份 Electron 发行版，
    而 `electron-builder.yml` 的 `electronDist` 指向 `node_modules` 里那一份单架构 dist。
  - **有自更新**（0.14.0 起）：`Opennote-<版本>-mac-<arch>.zip` 整包替换 `.app`，
    换包前验签、失败自动回滚 —— 见第 7 节与 [`docs/update/00-更新机制.md`](docs/update/00-更新机制.md) §4.2。
    从 dmg 里运行、或被 App Translocation 挂到只读临时路径时会在入口处 `supported:false`。
- **Linux**：`AppImage` 仍是声明状态，未验证。
- **更新机制**：桌面版自 0.6.0 起有**用户点击式**自更新（拉 GitHub Release → 校验 → 重启覆盖），
  见下面第 7 节。它不依赖签名，但也**不是静默更新**：每次更新用户都要点一次「重启并更新」，
  且新 exe 未签名 → 更新后第一次运行仍会过一次 SmartScreen。要静默更新，顺序仍然是
  「先有签名 → 再上 `electron-updater` + NSIS」。
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
4. **别再让 `node_modules` 进 asar**：主进程只 require `electron`、node 内置模块与**可选**的
   `@parcel/watcher`（[`electron/main.cjs`](electron/main.cjs):23-32、:54-59 的 try/catch，
   拿不到就退化回 `node:fs` 递归 watch）。将来主进程真要 require 第三方包，必须同时改
   `electron-builder.yml` 的 `files`，否则启动即 `Cannot find module`。
   **这条踩第二次了，而且只靠「正列」拦不住**：`files` 里只写 `dist/`、`electron/` 这些**正**模式
   是不够的 —— electron-builder 会把 `package.json` 的**生产依赖整包**收进 asar（日志里那句
   `searching for node modules pm=pnpm` 就是它）。0.13.0 实测：没有 `'!node_modules/**/*'`
   这一行时 `app.asar` = **219 MB / 10001 个 node_modules 条目**（mermaid、codemirror、
   katex、react、@fontsource……全是只在 Vite 构建期用的包），补上这一行后回到 **11 MB**，
   DMG 从 199.9 MB 掉到 **138.6 MB**、ZIP 从 177.5 MB 掉到 **126.5 MB**。
   验证手法（别只看体积，要看内容）：
   `node node_modules/.pnpm/@electron+asar@3.4.1/node_modules/@electron/asar/bin/asar.js list <app>/Contents/Resources/app.asar | awk -F/ '{print $2}' | sort -u`
   —— 顶层只该有 `dist`、`dist-clip`、`electron`、`package.json`。
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

11. **electron-builder 的图标 / dmg / zip 目标都要联网下载工具链（macOS 打包在离线机器上全挂在这里）**：
    - `mac.icon` 指向 `.png` 时，它会去 GitHub Releases 下 `icons@1.1.0` 工具链来转换；
    - `target: dmg` 要下 `dmg-builder@1.2.5`（dmgbuild）；
    - `target: zip` 要下 7zip 工具链。
    离线环境下三个都是 `TypeError: fetch failed`。修法（已落地）：`.icns` 由 `pnpm icons` 用系统
    `iconutil` 预生成、`mac.icon` 直接指向它 —— `iconConverter.js` 对「源文件扩展名已经等于目标格式」
    有短路分支，原样返回、不碰下载器；分发用 `hdiutil` + `ditto` 自己出。
    **别把 `mac.target` 改回 `dmg`/`zip`，也别把 `mac.icon` 改回 `.png`**，否则离线打包立刻复发。

12. **ad-hoc 签名 + hardened runtime = 应用起不来（0.14.0 实测抓到的）**：
    现象是双击毫无反应，命令行启动报
    `dyld: Library not loaded: @rpath/Electron Framework.framework/... Reason: ... have different Team IDs`。
    ad-hoc 签名没有 Team ID，而 hardened runtime 会打开 library validation，于是主程序拒绝加载框架。
    两个坑叠在一起：
    - `mac.identity: "-"` **不能用来要 ad-hoc**：`macCodeSign.js` 的 `_findIdentity()` 用
      `line.includes(qualifier)` 匹配证书名，`"-"` 会命中**任何名字里带连字符的证书**，
      而且 Developer ID 类型还会退而求其次挑「非 Apple 证书」——本机就被签成了无关的自签证书
      `Snow Shot Local Installer C8C84F83-…`，换台机器产物完全不同。修法：`mac.identity: null`
      让 electron-builder **确定性跳过**，改由 `scripts/build-mac.mjs` ad-hoc 签。
    - `@electron/osx-sign` 的**顶层 `hardenedRuntime` 选项是无效的**：它只从
      `optionsForFile()` 的返回值里读（`dist/cjs/sign.js` 的 `mergeOptionsForFile`）。
      传顶层 `false` 被忽略 → 产物带上 `runtime` 标志。修法：
      `optionsForFile: () => ({ hardenedRuntime: false })`。
    `scripts/build-mac.mjs` 现在把这两条都咬死了：签名必须 `Signature=adhoc` 且 flags 不含 `runtime`，
    然后**真启动一次**产物确认渲染进程起来了 —— 只验签名是验不出这个问题的。

13. **打包产物的启动冒烟必须摘掉 `ELECTRON_RUN_AS_NODE`**：这个环境变量会让 Electron 二进制
    退化成纯 Node，连 `--user-data-dir` 都不认（报 `bad option: --user-data-dir=...`），
    看起来像打包坏了。`scripts/build-mac.mjs` 的 `smokeTest()` 显式 `delete env.ELECTRON_RUN_AS_NODE`；
    手工复现时用 `env -u ELECTRON_RUN_AS_NODE release/mac-arm64/Opennote.app/Contents/MacOS/Opennote`。
    （配合坑 #3：还要给独立 `--user-data-dir`，否则会被单实例锁静默顶掉。）

14. **macOS 的 zip 必须用 `ditto`，不能换 `zip`/7z**：`.app` 内部靠符号链接搭结构
    （`Versions/Current -> A`、`Electron Framework -> Versions/Current/Electron Framework`……）。
    zip/7z 会把符号链接**解引用成真实副本**，解出来的框架结构就废了、签名也对不上。
    `ditto -c -k --sequesterRsrc --keepParent` 是唯一能原样保住权限位与符号链接的做法。
    验证手法：解压后 `ls -la "Opennote.app/Contents/Frameworks/Electron Framework.framework/Versions/"`
    必须看到 `Current -> A` 是**链接**而不是目录。
    **自更新这条链路上同理**：解压必须走 `/usr/bin/ditto -x -k --norsrc`，绝不能用
    [`electron/zip.cjs`](electron/zip.cjs)（它对每个条目一律 `createWriteStream`，没有符号链接处理）。

15. **macOS 自更新是「整包替换」，不是「逐文件覆盖」**：`.app` 是代码签名的，往里换任何一个
    文件都会让签名失配，Apple Silicon 上直接起不来。所以 `handoff.layout` 分成
    `files`（Windows）/ `bundle`（macOS）两种形态，见 [`docs/update/00-更新机制.md`](docs/update/00-更新机制.md) §4.2。
    维护者要守住的四条：
    - **换包前必须验签**（`codesign --verify --deep --strict`，还要核对 Info.plist 版本与
      可执行文件架构）。这是唯一能兜住「换了个坏包 = 用户的应用没了」的闸门。
      `scripts/update-e2e-mac.cjs` 里有一条断言专门喂**被篡改过的**包，必须被拒。
    - **只有确认新版本能起来之后才删旧备份**；启动失败要**自动回滚**。mac 比 Windows 多这一层保证。
    - **`installDir` 在 mac 上是 `.app` 的父目录**（`/Applications`），不是 exe 所在目录；
      `exeName` 是 bundle 内部的相对路径。写错这两处会「下载成功、替换到错误位置」。
    - **helper 的代码来自正在运行的旧版本**（从它的 asar 里复制）。所以 mac 自更新只能从
      **已经带这个能力的版本**往后升 —— 0.13.0 及更早的 mac 包必须手动换一次。

16. **`app.getVersion()` 读的是 asar 里的 `package.json`，不是 Info.plist**：mac 的
    自更新预检核对的是 Info.plist 的 `CFBundleShortVersionString`，而应用自报的版本号来自
    asar 内 `package.json`。真发布时 electron-builder 两处一起写、天然一致；但**手工造
    「新版本」fixture 时只改一处会得到「更新成功但版本号没变」的假象**（实测踩过）。
    `scripts/update-e2e-mac.cjs` 因此两处都改、都断言。

17. **别用 `asar extract-file`，它把文件写到「当前工作目录」而不是 stdout**：在仓库根目录下
    调用它，会**直接覆盖仓库的 `package.json`**（实测踩过：把版本号写成了 fixture 的 9.9.9，
    而且 electron-builder 打包时会剥掉 `keywords`/`scripts` 等字段，等于把项目元数据砸了）。
    要读 asar 里的文件就 `asar extract <archive> <明确的临时目录>` 再读。

## 7. 桌面版自更新（0.6.0 起；macOS 0.14.0 起）

用户可见的行为、失败矩阵与设计取舍见 [`docs/update/00-更新机制.md`](docs/update/00-更新机制.md)；
这里只写**维护者必须知道的部分**。

**一条链路**（全部在主进程，渲染层只说状态）：

```
启动 5s 后 GET api.github.com/repos/<owner>/<repo>/releases/latest
  → tag 比 app.getVersion() 新 且 有本机平台的资产
      Windows：Opennote-<版本>-win-x64.zip
      macOS：  Opennote-<版本>-mac-<arm64|x64>.zip   ← 认 zip 不认 dmg（要能直接换的 bundle）
  → 左上角出现强调色下载图标（无更新时不占位）
  → 点击：SHA256SUMS 逐字节校验 → 解压到 userData/updates/staging-<版本>/
      Windows：electron/zip.cjs        macOS：/usr/bin/ditto -x -k --norsrc（保住符号链接）
  → macOS 额外一步：**换包前验签**（codesign --verify --deep --strict + 版本/架构核对）
  → 图标变重启图标 → 点击 + 确认
  → D11 落盘握手 → 关窗 → staging 里的**新可执行文件**以 ELECTRON_RUN_AS_NODE 跑覆盖脚本
      Windows：逐文件复制（exe 最后）
      macOS：  整包 rename 替换；失败自动回滚；起来之后才删旧备份
  → 启动新版本 → 新版本启动时清掉 staging 与 zip
```

**维护者需要守住的五件事**：

1. **资产名不许改**：`Opennote-<版本>-<win-x64|mac-arm64>.zip` + `SHA256SUMS`
   （`.github/workflows/release.yml` 的 `artifactName` 与 `scripts/make-checksums.mjs` 已经是
   这个名字，改了三处要一起改）。**`SHA256SUMS` 必须覆盖全部平台资产**：更新器是从这个文件里
   找当前资产的校验和，找不到就直接拒绝更新 —— 这正是 `release-mac` job 要重算并覆盖上传的原因。
2. **`package.json` 的 `repository.url` 是仓库身份的唯一产地**（更新器不读 `homepage` —— 它曾经指向
   一个不存在的组织）。改仓库地址 = 改这里。
3. **主进程不许 require 第三方包**（见第 6 节坑 #4）：Windows 的解压器是自己写的
   （[`electron/zip.cjs`](electron/zip.cjs)），只认 store/deflate，逐条 CRC，拒 ZIP64/加密/`..` 越界；
   macOS 用系统 `ditto`/`codesign`/`plutil`/`lipo`（都是 `/usr/bin` 下自带的，不需要 Xcode CLT）。
4. **CSP 不动**：网络只在主进程发生，渲染层的 `connect-src` 仍然是 `'self' file:`。
   `scripts/ipc-safety-check.cjs` 会断言渲染层没有「传 URL / 传路径」的入口。
5. **mac 的 `installDir` 语义与 Windows 不同**（是 `.app` 的父目录），且 `layout` 必须一路传到
   helper —— 见第 6 节坑 #15。

**发布日演练（每个版本都做，5 分钟）**：用**上一个版本**的旧包，对着新发的 Release 走一遍
「图标出现 → 下载 → 重启覆盖 → 关于页版本号变了」。这是唯一能证明「asar 里的版本号真的换掉了」
的证据（本地 e2e 用的是改造出来的假包，见下）。

```shell
node scripts/update-e2e.cjs        # 或 pnpm update:e2e       —— Windows 逐文件覆盖
node scripts/update-e2e-mac.cjs    # 或 pnpm update:e2e:mac   —— macOS 整包替换
```

端到端：临时安装目录 + 本地假 Release + 真覆盖脚本 + CDP 驱动（各约 2–4 分钟）。

- Windows：当前 **PASS 10 / FAIL 0 / SKIP 1**，SKIP 那条是「新进程的调试端口重新绑定」这个 harness 限制。
- macOS：当前 **PASS 13 / FAIL 0**。它会用当前产物改造出一个「新版本」fixture ——
  **asar 内的 `package.json` 与 Info.plist 都改**（只改一处会得到「更新成功但版本号没变」的假象，
  见坑 #16），重新 ad-hoc 签名、`ditto` 压包，再让真应用走完整条链路；断言里包含
  「被篡改过的包必须被拒」与「换上去的 bundle 签名仍然有效」。

**macOS 上它不覆盖**：真实 GitHub 网络、真实发布包（fixture 是改造的）、只读安装目录、
App Translocation、断电中断。前两条靠代码里的明确错误分支（`NETWORK` / `READ_ONLY_INSTALL` /
`UNSUPPORTED`）；Translocation 与 dmg 里运行会在**入口处**就被否决（`supported:false` +
启动日志写明原因），不会走到替换那一步。

**回滚**：Release 全部留着，所以「回滚」对用户就是下载旧包覆盖安装
（Windows 解压 zip；macOS 换 dmg/zip）。本地 `userData/updates/` 里的 staging 与 zip 会在更新成功后自动清掉；
macOS 换包失败时会**自动回滚**到旧版本，不留 `.Opennote.app.old-*`（成功路径也会清掉备份）。

## 8. 回滚

- 只是资产有问题：`gh release upload <tag> <file> --clobber` 覆盖，或 `gh release delete <tag>`。
- 版本发错了：删 Release 与 tag（`git push origin :refs/tags/vX.Y.Z`）后重打。注意重推同名 tag 会再触发一次流水线。
- 桌面版的自更新只在**用户点击**时发生，所以发错版本不会自动扩散：修好资产后，用户下次点「检查更新」
  就会拿到修好的包；已经装上的用户重新下载旧 zip 解压覆盖即可。
