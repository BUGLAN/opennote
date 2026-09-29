# Opennote 剪藏扩展（Chrome / Edge · Manifest V3）

> **在页面上点一下要剪的那块**（元素选择）、整页正文、或当前选区；**连不上时如实说清楚是哪一种连不上**；无论如何**不静默失败**。

- 版本：`0.1.4`（`src/manifest.json` 与 `lib/errors.js:15 CLIENT_VERSION` 同步）
- 目标：`POST http://127.0.0.1:8787-8796/v1/import`，契约 `opennote.import/v1`（`docs/import/02-接口契约-导入信封与通道.md`）
- 零依赖、零构建工具链：`package.json` 没有 `dependencies` / `devDependencies`，构建 = 复制 `src/` → `dist/` + 生成图标 + 内联设计令牌
- 物理隔离：本目录与 `src/`（桌面/网页应用）互不 import，唯一被读取的外部文件是 `src/styles/tokens.css`（**逐字复制**，见 §10）
- 0.3.1 两处大改（`00` §6.15㉝㉞/㊱）：**元素选择取代选区浮标**；**配对整体删除，改为粘贴长期令牌**

---

## 0. 30 秒上手（加载路径逐字）

1. 先生成可加载目录（`dist/` 不在仓库里，`.gitignore` 已忽略）：

   ```powershell
   cd E:\repo\opennote\extension
   node build.mjs
   ```

2. 打开 `chrome://extensions`（Edge 用 `edge://extensions`），右上角打开 **「开发者模式」**。
3. 点 **「加载已解压的扩展程序」**，在文件选择器里选中这个目录（**逐字**）：

   ```
   E:\repo\opennote\extension\dist
   ```

   > 选 `extension\dist`，**不要选** `E:\repo\opennote\extension`，也**不要选** `extension\src`。
   > `src/` 是源目录：里面的 `content/picker.js` 还带着 `__OPENNOTE_TOKENS_CSS__` 占位符、`styles/tokens.css` 是构建时才从 `src/styles/tokens.css` 复制进来的、`icons/` 是构建时生成的。直接加载它不会报错，但**元素选择的覆盖层会没有样式**、图标缺失。
   > `manifest.json` 在 `extension/src/manifest.json`，构建时原样复制到 `extension/dist/manifest.json` —— Chrome 只认 `dist/` 这一层。

4. 建议点扩展卡片上的「固定」，把图标放到工具栏。
5. 打开桌面版 Opennote →「设置 · 文件 · 导入与接口」→ **开启本地接口**（默认端口 8787）。
6. 首次使用（0.3.1 起**没有配对码**）：在 Opennote 里打开「设置 · 文件 · 导入与接口」→ 复制**访问令牌**（`opn_` 开头，47 个字符）→ 点插件图标 → 把令牌粘进「访问令牌」输入框 → 「连接」。令牌**长期有效**，除非你在 Opennote 里重新生成。
7. 之后剪藏有三种正文来源（popup 正文区的三选一）：
   - **元素选择**（默认推荐）：点 popup 里的「选择页面元素」→ popup 关闭、页面上出现跟随鼠标的轮廓 → 在要剪的那块上**点一下**（`Esc` 取消）→ popup 自动弹回，显示 `已选择 {标签名}`；
   - **整页正文**：不做任何点选，直接剪整页；
   - **当前选区**：页面上已经有选中的文字时用它（**只剪选区**，高亮不会写进正文）。
   快捷键 `Alt+Shift+S` 现在是**「进入元素选择模式」**（原来的「剪藏选区」已删除）；整页剪藏走右键菜单「剪藏整页正文到 Opennote」。高亮入口在右键菜单「高亮这段文字」（浮标已删除）。

卸载/更新：`chrome://extensions` 上点「重新加载」即可（改完源码先 `node build.mjs`）。

---

## 1. 构建与自检命令

| 命令 | 作用 | 本次结果 |
| --- | --- | --- |
| `node build.mjs` | 清空并重建 `dist/`：复制 `src/`（跳过 `styles/`）、逐字 vendor `tokens.css`、把设计令牌内联进 `content/picker.js` 的 `:host`、生成 16/32/48/128 PNG 图标、写 `dist/BUILD-INFO.json`；**先做 manifest 自检**（`verifyManifest()`：`manifest_version` 必须为 3；`default_locale` 若存在必须是字符串；`background.service_worker` / `action.default_popup` / `options_ui.page` 指向的文件必须真实存在） | `dist 就绪：26 个文件` |
| `node verify.mjs` | 静态验收 V1–V15（清单/权限/引用完整性/零远程主机/零 eval+内联处理器/tokens 逐字同源/0 新令牌/逐字文案/契约硬约束/无 emoji/模板白名单/两档高亮/三区+6 项菜单/反引号禁用/**元素选择纪律**/**去配对+令牌格式**） | `✓ 15 组验收全部通过（V1–V15）` |
| `node --test "tests/**/*.test.mjs"` | 92 条单测 + 真 HTTP 集成（真 `node:http` mock 桥、真 vite 载入的**真接收端**） | `92 pass / 0 fail` |
| `node build.mjs && node --test "tests/**/*.test.mjs" && node verify.mjs`（`npm run check`） | 三件套 | 全绿 |
| `node tools/mock-bridge.mjs --mode healthy --port 8795 --token opn_KK… --inbox` | 无依赖 mock 桥：`/v1/health`、`/v1/workspace`、`/v1/import(s)`（`--inbox` 时导入返 **202 待确认**）、`/demo` | 配合 §4 逐态复现（8787 留给真 Opennote，避免抢端口） |
| `pwsh -File tools/mutation-check.ps1` | **反向验证**：8 个变异逐个跑 verify+tests（应红）→ 恢复 → 复跑（应绿）+ 核对 `git status src/` 为空 | 8/8 命中，恢复后全绿 |

**关于测试里用到的 `vite`**：`tests/judgment-chain.test.mjs` 通过 `createRequire(ROOT/package.json).resolve("vite")` 借用**仓库根目录**已安装的 vite，用 `ssrLoadModule("/src/lib/clip/index.ts")` 载入**真接收端代码**（只桩掉 Electron 的 `window.opennote.fs.*` IPC 边界，换成 Node `fs`）。它不进入扩展运行时，`extension/package.json` 里也没有加任何依赖。（`pnpm-workspace.yaml` 没有 `packages:` 键，所以 `extension/` 不在根 workspace 里。）

---

## 2. 目录结构

```
extension/
├─ src/                         # 源目录（不是用来加载的那一层）
│  ├─ manifest.json             # MV3 清单（构建时原样复制）
│  ├─ background.js             # service worker（"type":"module"，用相对路径静态 import）
│  ├─ lib/
│  │  ├─ errors.js              # IMP 码表（33 条 A.3 减 IMP-2004 作废码）+ 唯一文案源 userMessage()
│  │  ├─ envelope.js            # 信封构造/校验/标签过滤/时间戳归一
│  │  ├─ bridge.js              # 纯 fetch 桥：端口探测、导入、状态查询（可注入 fetchImpl；0.3.1 删除 postPair）
│  │  ├─ state.js               # 六态判定 decideState() + 视图模型 planFor()
│  │  ├─ queue.js               # 离线暂存队列（上限/预算/去重/补投批次）
│  │  └─ store.js               # chrome.storage.local 单键状态
│  ├─ content/
│  │  ├─ picker.js              # **元素选择覆盖层**（closed Shadow DOM，构建时内联 tokens；点击三件套 + Esc）
│  │  ├─ extract-page.js        # 自包含的正文抽取器（被 executeScript 注入；支持 rootSelector 只抽点中的子树）
│  │  └─ clipboard.js           # 自包含的页内复制（execCommand 降级用）
│  ├─ options/                  # 选项页：模板管理（增删改 / 导入导出 / 变量与字段说明）
│  └─ popup/                    # popup.html / popup.css / popup.js
├─ tests/                       # 92 条：信封、状态、队列、桥（真 HTTP）、自包含性、高亮、模板、判定链（真接收端）
├─ tools/mock-bridge.mjs        # 零依赖 mock 桥（9 种模式，见 §4）
├─ build.mjs  verify.mjs
├─ tools/mutation-check.ps1      # 反向验证（变异 → 红 → 恢复 → 绿）
└─ docs-verify/                 # 真机验证截图（§11）
```

`dist/`（构建产物，**26 个文件**）：`manifest.json`、`BUILD-INFO.json`、`background.js`、`lib/*.js`、`content/*.js`（`picker.js`/`extract-page.js`/`clipboard.js`，**没有 `float.js`**）、`popup/*`、`options/*`、`icons/icon{16,32,48,128}.png`、`styles/tokens.css`。

---

## 3. 权限清单与联网边界

`permissions` **恰好四项**（`verify.mjs` V2 会断言没有多余项）：

| 权限 | 为什么必须 | 没有它会怎样 |
| --- | --- | --- |
| `storage` | 存令牌/端口/落点/标签 + 离线暂存队列 + 元素选择结果（单键 `opennote.clip.state.v1`） | 每次都要重新粘贴令牌，「先暂存」无法实现 |
| `contextMenus` | 右键「高亮这段文字 / 剪藏整页正文到 Opennote」（0.3.1 恰好两项） | 右键入口消失 |
| `activeTab` | 用户点图标/快捷键/右键时，临时获得**当前这一张**页面的读取权，用于注入抽取器与元素选择覆盖层 | 无法整页抽取（除非申请 `<all_urls>`，被明确否决） |
| `scripting` | `chrome.scripting.executeScript` 注入 `extract-page.js` / `clipboard.js` / `picker.js`（**只在用户点「选择页面元素」或按 `Alt+Shift+S` 时注入**） | 同上 |

`host_permissions` **恰好 10 条**，只有回环地址，没有域名通配、没有 `<all_urls>`：

```
http://127.0.0.1:8787/*  …  http://127.0.0.1:8796/*   （8787..8796 逐条写全）
```

- **剪藏内容只发本机**：全部网络出口就是这 10 条 + `manifest` 里没有任何 `content_scripts` / `web_accessible_resources` / `externally_connectable`。
- **没有申请**：`tabs`、`clipboardWrite`、`notifications`、`nativeMessaging`、`webRequest`、任何 `*://*/*`。
- 零遥测：`verify.mjs` V4 断言全仓库（`src/`+`dist/`）除 `127.0.0.1` / `localhost` / `www.w3.org`（SVG 命名空间）外**没有任何远程主机**；V5 断言没有 `eval` / `new Function` / 内联事件处理器 / 远程脚本。
- `minimum_chrome_version: "116"`（`chrome.scripting` 的 `func` 注入 + `commands` 稳定行为）。

---

## 4. 连接状态：逐态复现

判定全部集中在 `src/lib/state.js:101 decideState()`（纯函数，输入 = 探测结果 + `navigator.onLine` + 是否有令牌 + 待补投条数），探测在 `src/lib/bridge.js:110 discover()`（顺序 8787→8796，单次 **300 ms**，命中即停），决策在 `src/background.js:179 probeAndPlan()`。

### 4.1 应用侧生命周期 → 插件看到什么（Lead 要求的 6 态）

| 应用侧（设置面板） | 插件可观察到的证据 | L1 芯片（逐字） | 正文块 | 下一步 | 证据 |
| --- | --- | --- | --- | --- | --- |
| **未开启** | 8787–8796 十个端口全部拒绝连接 | `本地接口未开启` | `IMP-1001`：`本地接口未开启。打开桌面版 Opennote 的「设置 · 文件 · 导入与接口」，开启本地接口后重试。` + `已保留你填的标题与标签。` + 动作「重试 / 打开 Opennote 设置」 | 去设置开启本地接口，或点「先暂存这页」 | 真机 `state-01-interface-off.png` |
| **已停止** | 与「未开启」**完全一致**（插件无法区分「没开过」与「开过又停了」，也不该猜） | `本地接口未开启` | 同上 | 同上 | 同上（同一复现路径） |
| **正在启动** | 端口已绑定但 `/v1/health` 在 300 ms 内没答完 → 探测判超时 → 不算命中（**绝不会误报「已连接」**） | `本地接口未开启` | 同上（点「重试」即可） | 等一两秒点「重试」 | mock `--mode starting`；真机同款读数；Node 断言 `tests/bridge.test.mjs`「starting…」 |
| **运行中 · 未配置令牌** | `/v1/health` 200 且 `spec`/`bridge` 命中，但本地没有令牌（0.3.1 起**没有配对**，芯片文案从 `需要配对` 改成 `未配置令牌`） | `未配置令牌` | `IMP-2001`：`这个客户端还没有配置访问令牌。请在 Opennote 的「导入与接口」里复制令牌，粘贴到客户端。` + 令牌输入块（粘贴 47 字符）+ 代价披露句 + 「打开 Opennote 设置」 | 复制令牌 → 粘贴 → 「连接」 | 真机 `state-00-needs-pairing.png`（0.2.0 时代截图） |
| **运行中 · 已配置令牌** | 命中 + `GET /v1/imports/auth-probe-0000` 校验令牌通过（期望 404 `IMP-4017`）+ `GET /v1/workspace` | `本地接口已开启` | 预览：标题 / `约 N 字 · 预计 1 篇笔记` / 正文摘要 / 落点+标签行 | 直接「剪藏到 Opennote」 | 真机 `state-03-connected.png` |
| **端口被占用** | 有端口在监听，但 `/v1/health` 不是 Opennote 的桥（返回别的东西），或桥自报 `IMP-1003` | `端口被占用` | `IMP-1003`：`8787 到 8796 端口都被占用了。请关闭占用端口的程序，或在设置里指定其它端口。` + 「重试 / 打开 Opennote 设置」 | 关掉占用端口的程序，或在 Opennote 设置里换端口 | 真机 `state-05-port-busy.png` |
| **启动失败** | 端口**有**监听但不是我们的桥 → 与「端口被占用」同款；端口**没有**监听 → 与「未开启」同款。插件侧无法区分「别人的程序占着」与「自己没起来」 | `端口被占用` / `本地接口未开启` | `IMP-1003` / `IMP-1001` | 去 Opennote 设置面板看它自己报的失败原因 | `state-05` / `state-01` |

> `正在启动` 的取舍：探测预算是 **300 ms**（`bridge.js:HEALTH_TIMEOUT_MS`），超时按「没命中」处理，因为一个不答话的端口不是「Opennote 在跑」的证据。宁可多说一句「未开启 + 重试」，也不猜「已连接」。

### 4.2 六态逐态复现（一条命令一种状态）

所有复现都只用本仓库的 mock 桥，不需要真的开桌面版：

```powershell
cd E:\repo\opennote\extension
# ① 未开启 / 已停止：什么都不起（或把 mock 全停掉）
#   → 芯片「本地接口未开启」+ IMP-1001 + 重试 / 打开 Opennote 设置
node tools/mock-bridge.mjs --mode no-window --port 8787
# ② Opennote 未运行：端口在监听，但明确回 409 IMP-4006（窗口不在场）
#   → 芯片「Opennote 未运行」+「连接被拒说明本机没有在监听，不是令牌问题。」+ 重试 / 先暂存这页
node tools/mock-bridge.mjs --mode healthy --port 8795 --token "opn_KKK…" --inbox
# ③ 已连接（运行中）：popup 里粘贴与桥一致的令牌（--token 的值），桥健康检查回 inbox:true → 进收件箱
#   → 芯片「本地接口已开启」+ 预览
node tools/mock-bridge.mjs --mode healthy --port 8787 --token "opn_ZZZ…"     # 令牌与本地不一致
# ④ 令牌不匹配：桥在跑，auth 探测 401 → 芯片「未连接」+ IMP-2002 + 令牌输入块 / 打开 Opennote 设置
node tools/mock-bridge.mjs --mode foreign --port 8787
# ⑤ 端口被占用：有监听但不是我们的桥 → 芯片「端口被占用」+ IMP-1003
node tools/mock-bridge.mjs --mode origin-denied --port 8787
# ⑥ 来源不是扩展/本机程序：/v1/health 直接 403 IMP-3001 → 芯片「未配置令牌」，**绝不显示「已连接」**
node tools/mock-bridge.mjs --mode starting --port 8787
# ⑦ 正在启动：端口已绑定但答得比 300ms 慢 → 芯片「本地接口未开启」+ 重试
node tools/mock-bridge.mjs --mode no-workspace --port 8787
# ⑧ 文件夹/笔记本未授权：桥通、窗口在，但没打开笔记本 → 芯片仍是「本地接口已开启」，正文块 IMP-4007
node tools/mock-bridge.mjs --mode folder-denied --port 8787
# ⑨ 落点未授权：剪藏时 422 IMP-4009 → 芯片仍是「本地接口已开启」，正文块说明落点问题（P0 必现）
```

**离线态**（不依赖 mock）：把系统网卡断掉（或 `chrome://settings` 里开离线模拟），插件在 `navigator.onLine === false` 时：

- 队列为空 → 芯片 `未连接`，正文块为「连不上本地桥」的 `IMP-1001` 文案 + 「先暂存这页」——**绝不显示「已连接」**（`decideState` 第 1 条硬规则）。
- 队列非空 → 芯片 `离线，已暂存 {n} 条`（`03` §UI-01 S11 逐字），正文：`Opennote 未打开笔记本，内容已暂存在插件里，打开笔记本后会自动补投。`

### 4.3 「未配置令牌」与「Opennote 未运行」为什么是两态

| 现象 | 芯片 | 依据 |
| --- | --- | --- |
| 十个端口都没人监听 | `本地接口未开启` | `IMP-1001`（`state.js:137`） |
| 有人监听且**明确回 409 `IMP-4006`**（桥在跑、渲染窗口不在场） | `Opennote 未运行` | `probe.noWindow`（`state.js:117`）→ 契约 `IMP-4006` |
| 有人监听但来源不是扩展/本机程序（**403 `IMP-3001`**）或没有令牌 | `未配置令牌` | `state.js:128` / `:123`，**永不进「已连接」分支** |
| 有人监听但不是 Opennote（或桥自报端口全占） | `端口被占用` | `state.js:131`/`:134` |
| 命中桥但令牌被拒（401 `IMP-2002`） | `未连接` | `state.js:122` |

真机上 `本地接口未开启` / `Opennote 未运行` / `端口被占用` / `未配置令牌` / `未连接` 五个芯片互不相同，截图见 §11。
`IMP-3001` 按 `02` §6.2 的展示口径 **不进 toast、不进插件气泡**：插件只显示用户可行动的「未配置令牌」（`IMP-2001` 文案 + 令牌输入块），来源拒绝的细节留在应用侧设置面板的「被拒绝的来源」日志里。

---

## 5. `conflict` 纪律（BLOCK-1 的结论，回归受 `verify.mjs` V8 保护）

**插件默认不下发 `conflict` 键。** 语义映射（代码注释在 `src/lib/envelope.js:221 buildEnvelope()` 与 `src/popup/popup.html` 的 ⋯ 菜单处）：

| 产品语义 | 信封里的 `conflict` |
| --- | --- |
| 直接入库（默认） | **不下发该键**（缺省 = 交给接收端判定链） |
| 追加到同源笔记 | `"append"` |
| 发现同源同内容就跳过 | `"skip"` |
| 覆盖 | **永不出现**（`ALLOWED_CONFLICTS` 里没有，`overwrite` 会被服务端按 `IMP-4001` 拒） |

**为什么必须缺省**：`conflict` 在 `02` §2 里是**可选键**；只要显式下发 `"new"`，接收端就把它当成「用户已表态：新建」，于是判定链第 3/4 步永不生效 ——

- 第 3 步（同 URL、正文变了、`selection: true`）本该 `200 + appended` 追加进既有笔记，被 `new` 短路成新建第二篇；
- 第 4 步（同 URL、正文变了、`selection: false`）本该 `202 + pending` 进收件箱等人工确认，被 `new` 短路成直接落盘。

也就是说：**硬编码 `new` 会让「收件箱」在插件通道上变成死代码**，用户还会莫名其妙得到一堆重复笔记。本次修复把它改成「只在调用方显式要求时才下发」，并加了闸门：

- `verify.mjs` V8：剥掉注释后匹配 `conflict: "new"` / `envelope.conflict = "new"` → 直接 FAIL，报错文案就是上面这条因果。
- `tests/envelope.test.mjs`：断言 `!("conflict" in envelope)`，且显式只接受 `new|append|skip`。
- `tests/judgment-chain.test.mjs`：拿**真接收端**跑完整判定链（见 §6）。
- `tools/mock-bridge.mjs` 也按同一口径实现了判定链（`state.judgment` 记录轨迹）。

---

## 6. 判定链（接收端第 1–4 步）与契约要点

`tests/judgment-chain.test.mjs` 用 `ssrLoadModule` 载入**真接收端**、真临时工作区、真磁盘，信封由**插件自己的 `buildEnvelope()`** 生成：

```
① 首次剪藏（selection:true，信封键 = spec/importId/title/body/source/target/tags/assets/client）
   → HTTP 201 status=created
② 选区二次剪藏（同 URL、正文变了、selection:true）→ HTTP 200 status=appended    ← 第 3 步
③ 整页二次剪藏（同 URL、正文变了、selection:false）→ HTTP 202 status=pending + inboxId  ← 第 4 步
④ 对照组（同信封但显式 conflict:"new"）→ HTTP 201 status=created（复现 BLOCK-1 的病灶）
```

**信封**（`02` §2）：`spec` / `importId` / `title` / `body` / `source` / `target` / `tags` / `assets` / `client`（+ 可选 `conflict`）。

- `spec: "opennote.import/v1"`、`client: { name: "chrome-extension", version: "0.1.4" }`。
- `importId` 每次剪藏生成一次（`crypto.randomUUID()` 优先），**重投/重试复用同一个**（幂等）；`source.selection` 如实反映剪藏范围（选区 / 整页），它是接收端第 3/4 步的分流依据。
- `body` 上限 **8 MiB**（UTF-8 字节，`envelope.js:82 bodyByteLength()`）；超过 → 本地就报 `IMP-4005`，不发请求。
- 标签：客户端**先过滤**（`filterTagsDetailed()`：按 `,` 拆、剔 `[ ] " '`、去空白、纯数字丢弃、单标签 ≤32 字、最多 32 个、非法字符剥掉），只把干净标签发出去；服务端仍会二次校验。
- 时间戳一律带时区（`toLocalIso()` 输出 `+08:00` 形式），`capturedAt` 用剪藏时刻。
- 认证：`Authorization: Bearer <token>` + `X-Opennote-Token: <token>`（双头，便于不同实现），令牌 47 字符 `opn_` 前缀。
- 令牌有效性探测走 **`GET /v1/imports/auth-probe-0000`**（只读，无副作用；期望 404 `IMP-4017` 表示「令牌没问题，只是这个 id 不存在」）。
- 端口探测：8787→8796 顺序，单次 300 ms，命中即停；全部失败才说 `IMP-1001`。
- 请求一律 `credentials: "omit"`、`redirect: "error"`、`cache: "no-store"`，并带 `AbortController` 超时（导入 5 s）。
- **`overwrite` 永不发送**（`verify.mjs` V8 断言）。

**文档不一致（如实记录）**：`docs/import/02` §6.2 与 `docs/import/mockups/01-extension-popup.html` 对 `IMP-2002` 的文案不完全一致 —— `02` §6.2 写作「访问令牌不正确或已失效。重新生成令牌后，请在客户端里更新。」，mockup 里的展示更短。本实现采用 **`02` §6.2 的 `userMessage` 作为唯一文案源**（Lead 裁定），所以 popup 逐字显示的是 `02` 那句；如果评审要求以 mockup 为准，只需改 `src/lib/errors.js` 的 `IMP_TABLE["IMP-2002"]` 一处，`tests/state.test.mjs` 与 `verify.mjs` 的逐字清单会同步报错，不会漏改。

---

## 7. 三级降级：没有 `clipboardWrite` 也能复制

剪藏失败时，用户的第一需求是「至少把内容带走」。因为**没有申请 `clipboardWrite`**（那样会在安装时多要一条与剪藏无关的权限），`popup.js:405 copyMarkdown()` 走三级：

1. `navigator.clipboard.writeText()` —— popup 是扩展页面、有用户手势，通常直接成功；
2. 失败则请求 service worker 用 `chrome.scripting.executeScript` 把 `content/clipboard.js` 注入当前页，页内用隐藏 `<textarea>` + `document.execCommand("copy")`（这是 `activeTab` 授权下的合法路径）；
3. 再失败就把 Markdown 放进 popup 里的**可见 `textarea`** 并选中（`showManualCopy()`），提示用户 `Ctrl+C` —— 任何一步都不会「什么都没发生」。

---

## 8. 离线暂存与幂等重投（`FR-53`）

- 存储：`chrome.storage.local` 单键 `opennote.clip.state.v1`（`lib/store.js:8`），队列与令牌/端口/落点同处一份状态。
- 暂存项（`lib/queue.js:42 makeQueueItem()`）= **完整信封** + 端口/令牌快照 + `folderLabel` / `noteTitle` / `mode` / 失败 `reason` + `importId`。
- 上限：**50 条**、总字节 **6 MiB**（超限先淘汰最旧的；单条超过 `body` 上限直接 `item-too-large` 拒收，不会把 storage 撑爆）。
- 触发暂存的入口：状态块里的「先暂存这页」、popup ⋯ 菜单「暂存在插件里」、主按钮在降级态下变成的「暂存在插件里」。
- 恢复后补投：`background.js:281 flushQueue()` 在 SW 启动、popup 打开、点「重试」时按批次投递；**同一个 `importId`**，服务端幂等去重（真机上补投后落盘文件的 `opennote_import_id` 与暂存项**完全一致**）。
- 芯片计数：`离线，已暂存 {n} 条`，不需要用户做任何操作（`03` §UI-01 S11：「打开笔记本后自动补投」）。

---

## 9. 视觉与文案合规

- `src/styles/tokens.css` **逐字复制**进 `dist/styles/tokens.css`（`build.mjs` 打印 SHA-256；`verify.mjs` V6 做内容哈希比对）；**元素选择覆盖层**用 closed Shadow DOM，把同一份 CSS 做机械替换 `:root` → `:host`（3 处）内联进 `content/picker.js`，因此**工具栏之外的页面样式不会被污染**，覆盖层也不会被页面 CSS 影响（`contain: layout style` + `pointer-events:none`）。
- **0 个新设计令牌**：`verify.mjs` V7 断言 `popup.css` 里没有任何自定义属性**声明**，且所有 `var(--…)` 引用都能在 tokens.css 里找到出处（真实令牌名是 `--font-mono`）。
- 文案：逐字清单（芯片、按钮、错误块、空态、成功态、元素选择、令牌块）来自 `03` 与 `mockups/01`，`verify.mjs` V7 逐条断言命中（0.3.1 删掉了配对块与浮标那几条，改挂元素选择/令牌的冻结句）；V13 另有一次**按类扫描**：359 条含中文的用户可见字符串里 0 个反引号；V15 扫描「配对码 / 6 位 / 120 秒 / 一次性 / 轮换」在 dist 里 0 命中（注释剥离后再扫）；错误文案统一走 `errors.js:231 userMessage(code)` —— `02` §6.2 是唯一来源，另有 2 处按 `03` 指定的平台文案覆盖（`IMP-1001` 用 `03` S9、`IMP-1006` 用 `03` S5）；**没有任何「未知错误」兜底**：即便服务端只给了 HTTP 状态码，`bridge.js:148 codeFromHttp()` 也会兜到某个真实码（兜底是 `IMP-4014`）。
- 图标一律内联 SVG（⋯ 菜单、flask/spinner 等），**零 emoji**（`verify.mjs` V9 用 pictograph 区间 + 图标符号黑名单扫描，跳过注释行）。
- 无障碍：芯片是 `role="status" aria-live="polite"`、分段控件是 `radiogroup`、来源三选一是 `radiogroup` + `aria-checked`、⋯ 是 `role="menu"`、元素选择覆盖层不吃事件（`pointer-events:none`）、`prefers-reduced-motion` 下关闭过渡。
- **两档高亮底色**（Lead 0.3.1 裁定 ②）：`color` 只允许 `yellow` / `accent`（`accent` 是强调档），旧的 `red/green/blue/purple` 只作为**读取兼容**存在，一律按 `yellow` 档渲染（`highlightTier()`），不新增任何设计令牌。

---

## 10. 真机验证（Chrome 154.0.8037.58 / Windows）

> **0.3.1 的状态**：下面这张表是 **0.2.0 时代跑过的真机链路**（当时的配对 + 浮标），保留为历史证据。
> 0.3.1 的两处新交互（**元素选择**、**粘贴令牌**）**没有跑真机 CDP**（见 §11 未验证项 1/2 的复现步骤），`dist` 里也**没有任何真机运行证据**。

**为什么要绕这一下**：Chrome 137+ 起，命令行的 `--load-extension` 对未打包扩展**不再生效**（启动参数里能看到、扩展却没被加载；`chrome://extensions` 里 `getExtensionsInfo()` 返回空）。真机自动化改走 CDP：

```powershell
# 1) 起一个专用 Chrome（必须带 --enable-unsafe-extension-debugging，CDP 才允许装载未打包扩展）
chrome.exe --remote-debugging-port=9335 --user-data-dir=%TEMP%\opennote-hl2-profile `
  --enable-unsafe-extension-debugging --headless=new http://127.0.0.1:8787/demo
# 2) 用 CDP 装载 dist（等价于「加载已解压的扩展程序」）
#    Extensions.loadUnpacked { path: "E:\\repo\\opennote\\extension\\dist" }  → {"id":"kffijoknceppgjodbdolhpflholonabl"}
# 3) 用 CDP 触发扩展图标（真实用户手势 → 授予 activeTab，弹出真 popup）
#    Extensions.triggerAction { id, targetId: <tab targetId> }
# 4) 之后在 popup / service worker 上下文里 Runtime.evaluate 读 DOM、截 Page.captureScreenshot
```

真机跑通的链路（点过什么 / 看到什么）：

| 步骤 | 我做了什么 | 看到了什么 | 截图 |
| --- | --- | --- | --- |
| 装载 | CDP `Extensions.loadUnpacked` 指向 `dist` | 返回扩展 id，service worker `…/background.js` 起在浏览器里 | — |
| 打开 popup | CDP `Extensions.triggerAction` 点图标 | popup 真身弹出（真 popup 气泡，非本地 HTML 预览） | — |
| 配对（**0.3.1 已删除的路径**） | 在 popup 的 6 位输入框里填入 mock 的 `482913` | 芯片 `需要配对` → `本地接口已开启`；mock 侧收到 `POST /v1/pair` | `state-00` / `state-03` |
| 连接态 | 打开 popup | 芯片 `本地接口已开启`；mock 侧依次收到 `GET /v1/health`、`GET /v1/imports/auth-probe-0000`、`GET /v1/workspace` | `state-03-connected.png` |
| 真剪藏 | 切「整页正文」→ 点「剪藏到 Opennote」 | 预览 `中文排版指北 / 约 218 字`；`POST /v1/import 970B`；popup 显示 `已剪藏到「根目录」。中文排版指北.md`；**磁盘上真的出现 .md** | — |
| 浮标（**0.3.1 已删除的 UI-02**） | 在页面里选中一段正文 | 浮标 pill 出现在选区上方（`記 剪藏 │ 整页`，暗底 + 品牌红印章），Shadow DOM 内令牌生效（`--accent: #b23a2e`、`--font-mono`、圆角 99px） | `state-09-float-on-page.png`（历史截图，0.3.1 起不再有浮标） |
| 降级 · 暂存 | 桥不在场（`IMP-4006`）→ 点「先暂存这页」 | 芯片 `离线，已暂存 1 条`；`chrome.storage.local` 里真出现暂存项（9 键信封 + 端口/令牌快照 + 同 `importId`） | `state-06-staged-offline.png` |
| 降级 · 补投 | 重开接口，再开 popup | 队列自动清空（`pendingCount: 0`），芯片回到 `本地接口已开启`，**磁盘上出现同一个 `importId` 的 .md** | — |

逐态截图（`extension/docs-verify/`，均为真机、真 popup）：

| 文件 | 态 | 芯片 |
| --- | --- | --- |
| `state-00-needs-pairing.png` | 运行中 · 未配置令牌（0.2.0 时代截图，当时这条叫「需要配对」） | `未配置令牌`（0.3.1 起的芯片文案） |
| `state-01-interface-off.png` | 未开启 / 已停止 / 正在启动 | `本地接口未开启` |
| `state-02-not-running.png` | 桥在跑、窗口不在场（409 `IMP-4006`） | `Opennote 未运行` |
| `state-03-connected.png` | 运行中 · 已配对 | `本地接口已开启` |
| `state-04-token-mismatch.png` | 令牌不匹配（401 `IMP-2002`） | `未连接` |
| `state-05-port-busy.png` | 端口被占用 | `端口被占用` |
| `state-06-staged-offline.png` | 已暂存待补投 | `离线，已暂存 1 条` |
| `state-07-device-offline.png` | 设备离线（`navigator.onLine === false`） | `未连接` |
| `state-08-origin-denied.png` | 来源不是扩展/本机程序（403 `IMP-3001`，本地已有令牌） | `未配置令牌`（**不是**「已连接」） |
| `state-09-float-on-page.png` | UI-02 浮标（真页面选区；**0.3.1 已删除**） | — |

> 说明：`state-07` 的 `navigator.onLine` 是在真 service worker 里打桩成 `false` 的（真断网会让同一台机器上的 mock 桥也失联，无法同时观察「离线 + 接口在跑」）；`state-08` 的 403 由 mock 桥返回。其余各态都是真实网络栈 + 真实 MV3 service worker + 真实 popup。

---

## 11. 已知限制与未验证项（诚实清单）

**未验证 / 验证不到位的**：

1. ~~元素选择没跑真机~~ → **已真机验证（2026-XX，Chrome 154.0.8037.58 / Windows）**：`node tools/cdp-pick-check.mjs` 全 12 项 PASS（退出码 0）。它做的事：起本地 demo 页 + 专用 Chrome（CDP 9346）→ `Extensions.loadUnpacked` → `Extensions.triggerAction` 弹真 popup → 在 popup 真 DOM 里点 `#pick` → 观察页面上的 `#opennote-pick-host`（`position:fixed` / `z-index:2147483647` / `pointer-events:none` / `closed` 影子根）→ `Input.dispatchMouseEvent` 在正文段落上真点一下 → 从 service worker 的 `chrome.storage.local` 读回 `picked`（`tagName=p`、`selector=main > article > p:nth-of-type(1)`、Markdown 含被点段落且**不含**侧栏/页脚）→ 覆盖层已移除。
   ```powershell
   cd E:\repo\opennote\extension ; node build.mjs ; node tools\cdp-pick-check.mjs
   # 退出码：0 = 全 PASS；1 = 有 FAIL；2 = 环境缺失（没装 Chrome / 没 build / 9346 被上一轮遗留的 Chrome 占用）
   ```
   **仍未验证**：`Esc` 取消与「popup 打不开时的页面内提示条」这两条**没有真机点到过**（前者要发键盘事件给页面、后者要 `chrome.action.openPopup()` 失败，headless 下不稳），只有静态断言（V14）+ 单测覆盖（`tests/self-contained.test.mjs`）。
2. **粘贴令牌的整条真机链路没跑（**UNVERIFIED**）**：`opennote:set-token` 的本地校验与落盘有单测，但「在真 popup 里粘贴 47 字符 → 芯片变 `本地接口已开启`」需要在真机上对着真/假桥点一次。可行验证：`node tools/mock-bridge.mjs --mode healthy --port 8795 --token opn_<43 位> --inbox` → popup 里粘贴同一个令牌 → 芯片应变 `本地接口已开启`。
2. **键盘快捷键与右键菜单没有在真机上触发过**：`Alt+Shift+S`（元素选择）、右键「高亮这段文字」/「剪藏整页正文到 Opennote」都需要 Chrome 浏览器进程层面的输入/UI 交互，CDP 的 `Input.dispatchKeyEvent` 到不了扩展命令注册表，右键菜单项也无法脚本选择。它们与 popup 共用同一个函数（`background.js` 的 `clipFromChromeEntry` / `captureHighlight`），单测覆盖了消息分支，但**「按快捷键真的会进入选择模式」这一步没人眼确认过**，请人工验一次。
2. **剪贴板三级降级没在真机走完**：`navigator.clipboard.writeText` 需要真用户手势，CDP 里读剪贴板还要额外授权，所以只测到「第 1 级会调用、失败会往第 2/3 级落」的逻辑层（单测 + 代码路径），没有在真机粘贴出来看一眼。
3. **没有对真的桌面版 Opennote 端到端验证**：本机的真桥是 `tools/mock-bridge.mjs`（按 `02` 契约实现）。判定链那一环用了**真接收端 TS 代码**（`tests/judgment-chain.test.mjs`），但「桌面版应用 + 真 8787 端口」这一整条没跑过。**0.3.1 的令牌链**同样没对着真应用验过（真应用的令牌是从「导入与接口」复制出来的 47 字符串）。
4. **只验了 Chrome 154（Windows）**：Edge 未验（同为 Chromium，理论上一致）。
5. **移动端 / Safari 完全没有考虑**（`03` 里属于 P1，`IMP-1006`）。
6. **队列管理界面没做**（`03` 的 `O-8` 明确「只做芯片计数，不做队列管理界面」）。
7. **插件不代发「进收件箱」指令（这是设计，不是缺陷）**：0.3.0（00 §6.14 ㉕㉘）起「进不进收件箱」由**应用侧设置**决定，插件只如实显示；`03` 冻结的 6 项 ⋯ 菜单里已经**没有**这个项（0.2.0 那个置灰死按钮已删除）。判定链第 4 步（同 URL、正文变了、`selection: false`）→ `202 + pending` 收件箱仍由**接收端**在元素选择/整页二次剪藏时触发。
8. **`02` §6.2 的 `IMP-1003` 文案在「只有一个端口被别人占用」时略过度**：原文是「8787 到 8796 端口都被占用了」。芯片 `端口被占用` 是准确的，正文那句在单端口占用时字面上说过头了。文案逐字取自契约，未擅自改写。
9. **设备离线且队列为空时没有专属错误码**：`02` 的号段里没有「设备离线」这一号（`IMP-1005` 是 Host 校验、`IMP-1006` 是平台能力），`03` 只为「离线已暂存」定义了 S11。所以该态复用了 `02` 认可的「连不上本地桥 → `IMP-1001`」语义；芯片如实显示 `未连接`。
10. **元素选择的 Markdown 保真度只到 `extract-page.js` 的能力边界**：点中的元素及子树走同一个抽取器（`stripNoise` + `htmlToMarkdown`），所以 `iframe` / `<canvas>` / closed 影子根里的内容读不到（popup 会如实说明「这块是嵌入的内容，只能剪到它的外框，里面的内容读不到。」）；图片保留 `src` 绝对地址。
11. **高亮不写回页面**：0.3.0 用的是 CSS Custom Highlight API（不改宿主页面 DOM），所以关掉 popup 再打开、高亮还在不在取决于页面是否还在原标签页；**没有**做「按 `selector` 重放高亮」——那需要 `content_scripts` + `<all_urls>`，被明确否决。高亮的**持久**形态是剪藏正文里的 `## 高亮` 小节。
12. **`IMP-2004` 已从码表删除**：码号在 `02` 附录 A.3 里保留，但扩展**不再收录它的文案**（产不出来的文案就是死数据，且会永远与冻结文案对不上）。若将来有人重新引入配对，必须同时把该条目加回表里。

**受限页面**：`chrome://*`、扩展页、`file://`、Chrome 应用商店等无法注入，`background.js:88 isRestrictedUrl()` 会直接给 `RESTRICTED_PAGE` 提示（不会假装能剪）。

**iframe 与动态页面**：元素选择的覆盖层只装在顶层文档；`executeScript` 默认只注入主 frame，所以点中 `iframe` 只能拿到外框（popup 会如实说明）。

---

## 12. 变更记录

### 12.1 0.3.1（本轮：元素选择 + 去配对）

| 文件 | 改动 |
| --- | --- |
| `src/content/picker.js`（新增） | 元素选择覆盖层：`#opennote-pick-host`（`position:fixed;inset:0;z-index:2147483647;pointer-events:none`）+ **closed** Shadow DOM；轮廓 `2px solid var(--accent)` + `box-shadow:0 0 0 1px var(--paper)`、遮罩 `var(--sel)`；跟随标签 `{标签名} · {宽} × {高}`；点击 `preventDefault` + `stopPropagation` + `stopImmediatePropagation`；`Esc` 取消；只加这一层，**不动页面其它 DOM**；popup 打不开时用同一条影子根显示一次性提示条（`已选好这一块。点扩展图标看预览。` / `知道了`） |
| `src/content/float.js`（删除） | 选区浮标（UI-02）与它依赖的 `selectionchange` 逻辑整体删除（㉝） |
| `src/content/extract-page.js` | 新增 `opts.rootSelector`：给了就只抽**点中的元素及子树**，跳过「整页挑正文容器」那一步 |
| `src/background.js` | 新增 `opennote:pick` / `opennote:element-picked` / `opennote:pick-cancelled`；`startPick()`（受限页回 `IMP-1006`，不注入任何东西）；`rememberPicked()` / `currentPicked()`（结果按 URL 存、换页即失效）；`normalizeMode()` = element/page/selection；`resolveBody` / `resolveTitle` / `templateCtxOf` / `composeDelivery` / `buildClipEnvelope` 全部接 `pickedElement`；**`source.selection` 在元素选择时恒为 `false`**；右键菜单只剩「高亮这段文字 / 剪藏整页正文到 Opennote」；`armTab()` 删除；页面内药丸反馈随浮标删除，改用 `chrome.action` 徽标 |
| `src/background.js`（配对） | `pairWithCode()` 与 `opennote:pair` 删除；`IMP-2004` 保留码号但**不再产出**；令牌走 `opennote:set-token`（`TOKEN_RE = /^opn_[A-Za-z0-9_-]{43}$/`，47 字符，长期有效） |
| `src/lib/bridge.js` | `postPair()` 删除（留 `PAIRING_REMOVED` 一条显式记录） |
| `src/lib/errors.js` | `IMP-2001` / `IMP-3001` 按 ㉞ 改文案；**删除** `IMP-2004` 条目（Lead 0.3.1 裁定：码号保留、表里不收录产不出来的文案） |
| `src/lib/state.js` | 芯片 `需要配对` → `未配置令牌`；`plan.pairingInput` → `plan.tokenInput`（`kind: "token"`），动作只剩「打开 Opennote 设置」 |
| `src/popup/popup.html` + `popup.js` | L2「选择页面元素」行（`重新选择` / `正在页面上等待你点选…` / C69 提示）；来源三选一（`元素选择` / `整页正文` / `当前选区`，默认项按「已选过元素 → 有选区 → 整页」判）；C65 `已选择 {标签名}`；C67 空态、C71 受限说明；令牌块（粘贴 47 字符 + C70 四句本地校验 + C72 代价披露 + C74 `令牌已保存。` + C77 清除确认）；**删除**配对输入块与全部 6 位码文案 |
| `src/manifest.json` | `commands`：删 `clip-selection`，新增 `pick-element`（`Alt+Shift+S`）；`_execute_action` 不再占用该键 |
| `verify.mjs` | V1 期望清单跟着 `03` 改（`pick-element` + `clip-page`，并断言 `clip-selection` **已删除**）；V7 逐字文案清单换成 0.3.1 冻结句；新增 **V14**（元素选择纪律：closed 影子根 / 覆盖层 only / 点击三件套 / Esc / 退出即移除 / 标签格式 / 无 `float.js`）与 **V15**（去配对 + 令牌格式 + 不产出 `IMP-2004`） |
| `tools/mutation-check.ps1` | 变异从 4 个扩到 **8 个**（新增 V14 影子根、V15 `opennote:pair`、V15 令牌格式、V1 快捷键语义） |

### 12.2 0.2.0 / BLOCK-1（历史）

| 文件 | 改动 |
| --- | --- |
| `src/lib/envelope.js` | 删掉硬编码 `conflict: "new"`；新增 `OPTIONAL_ENVELOPE_KEYS = ["conflict"]`（`:33`）与 `REQUIRED_ENVELOPE_KEYS`（`:36`）；`buildEnvelope()`（`:221`）只在显式传入 `new/append/skip` 时才写该键；`envelopeProblems()` 对 `conflict` 改成「有则校验」 |
| `src/manifest.json` | 删掉 MV3 非法的 `"default_locale": null` |
| `build.mjs` | 新增 `verifyManifest()` 自检（`manifest_version`、`default_locale` 类型、`service_worker`/`default_popup` 文件存在） |
| `verify.mjs` | V8 新增 BLOCK-1 回归闸门（剥注释后匹配 `conflict: "new"` → FAIL） |
| `tests/envelope.test.mjs` | 断言信封**不含** `conflict`；显式值只接受三种 |
| `tests/judgment-chain.test.mjs` | 新增：真接收端 + 真磁盘跑判定链 201→200(appended)→202(pending+inboxId)→对照组 |
| `tests/bridge.test.mjs` | 新增：走真 HTTP 的判定链断言；`starting`（300 ms 预算内必须判超时且不显示已连接）、`origin-denied`（403 `IMP-3001` → 需要配对） |
| `tools/mock-bridge.mjs` | `conflict` 可选；实现判定链（`created/appended/pending/duplicate/deduped` + `state.judgment`）；`downgradeLeadingH1()` 对齐真接收端；新增 `starting` / `origin-denied` 模式 |
| `docs-verify/*.png` | 真机截图 10 张（§10） |
