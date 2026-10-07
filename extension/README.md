# Opennote 剪藏扩展（Chrome / Edge · Manifest V3）

把网页上的**一块元素**或**整页正文**剪藏到本机的 Opennote 笔记本，默认先进**收件箱**。
连不上时如实说清楚是哪一种连不上；无论如何**不静默失败**。

> 本文档描述的是**当前实现**（M1 极简 + M2 清死代码之后）。历史上出现过的「三区分段 / 模板系统 /
> 高亮 / 来源三选一 / 存到 / 标签」已整套删除，文档里不再有它们的说明。

## 0. 30 秒上手

1. 构建：`cd extension ; node build.mjs` → 产物在 `extension/dist`（**26 个文件**；逐个清单见 §2 与 `verify.mjs` 的 V2b）。
2. Chrome → `chrome://extensions` → 打开「开发者模式」→「加载已解压的扩展程序」→ 选 **`E:\repo\opennote\extension\dist`**。
3. 打开桌面版 Opennote 的「设置 · 文件 · 导入与接口」，开启本地接口，**复制 47 字符长期令牌**。
4. 点扩展图标 → 在 popup 里**粘贴令牌**（`opn_` + 43 位）→ 芯片变成「本地接口已开启」。
5. 界面上只有两个按钮：
   - **`选择当前元素`**：popup 关闭，页面上出现跟随鼠标的轮廓 → 在要剪的那块上**点一下**（`Esc` 取消）
     → popup 自动弹回，按钮变成 `重新选择`，预览里就是那一块；
   - **`整页提取`**：把来源切到整页正文并刷新预览。
6. 点 **`剪藏到 Opennote`**。默认**先进收件箱**（应用侧设置是唯一真源），回执逐字显示
   「已进入收件箱等待确认：{标题}。」
7. 快捷键 `Alt+Shift+S` = 进入元素选择模式；右键菜单 = `剪藏整页正文到 Opennote`（只有这一项）。

## 1. 命令与判据（每条都贴真实输出）

| 命令 | 覆盖什么 | 期望 |
| --- | --- | --- |
| `node build.mjs` | 拷贝 `src/` → `dist/`、tokens 逐字注入（3 处 `:root`→`:host`；**25 处根属性选择器 → `:host(...)`**，夜版覆盖层靠它）、生成 PNG 图标、写 `BUILD-INFO.json`、`verifyManifest()` | `[build] dist 就绪：26 个文件` |
| `node verify.mjs` | 静态验收 **V1–V21**：清单/权限/引用完整性/**产物正面清单（V2b：逐个列出该在的与必须不在的）**/零远程主机/零 eval+内联处理器/tokens 逐字同源/0 新令牌/逐字文案/契约硬约束/无 emoji/极简形态（两按钮 + 无死元素 + 来源允许空值）/反引号禁用/元素选择纪律/去配对+令牌格式/四因分离/令牌回显/**产物一致性**/**V17A：A 接通 + ⑤ 选中态 + ③ 图片开关**/**V17B：网页版通道按钮**/**V21：页面内桥协议两处一致** | `✓ 21 组验收全部通过（V1–V21）`（退出码 0） |
| `node tools/run-tests.mjs` | **跑测试的唯一入口**：158 条单测（信封、状态、队列、桥（真 HTTP）、自包含性、判定链、四因分离、极简形态、令牌回显、产物守卫、**A 接通/资产形状/图片降级（真回环）**、**页面内桥（候选判定/字节上限/注入脚本自包含）**）；失败自动落 `.test-failure.log` | `通过：158 条（node --test 退出码 0）` |
| `node tools/dist-race-probe.mjs --seconds 25 --builds 40` | **诊断工具**（不是门禁，永远 exit 0）：量化「构建进行中读产物」的窗口有多大 | 半写窗口命中的采样数（见 §1.1） |
| `node tools/cdp-pick-check.mjs` | 真机：真 Chrome + 真扩展 + 两个按钮 + ㉝ 全链（**诊断工具，不是门禁**） | `元素选择真机验证：全部 PASS` |
| `node tools/mutation-stage-assets.mjs` | **反向验证**（7 个：资产形状退回 `{url,alt}`、`CLIP_WEB_READY` 退回 false、openUrl 自己拼、stage 退回旧 clip.html、图片开关默认改成开、产物清单多一个/少一个）：每个变异先打印**命中处数 + 前后 sha256**，没落地就 `NO_EFFECT` + `exit 2` | 7/7 命中期望文案后 `verify exit=0` / tests 0 fail |
| `pwsh -File tools/mutation-check.ps1` | 8 个变异**必须变红**且命中期望文案（历史那一套，变异点不同） | 8/8 命中后 `verify exit=0`、tests 0 fail |
| `node tools/real-bridge-stage-probe.mjs` | **诊断工具**（不是门禁，永远 exit 0）：起**真桥**（`electron/bridge.cjs`，不需要 Electron）复跑 `/v1/clip/stage` 的三种资产形状 | 三种输入各自的 HTTP 状态 + 错误码 |
| `node tools/cdp-inpage-check.mjs` | **诊断工具**（不是门禁，永远 exit 0）：真 Chrome + 真扩展 + **真网页版产物**（`npx vite build` 的 `dist/`）验网页版通道的两件事 —— ① popup 底栏那颗 `剪藏到 <域名>` 按钮的出现位置与逐字文案；② 把**真注入函数** `deliverInpage` 送进真网页版标签页，收回页面侧的结构化回执（跨世界 `postMessage` 是否真的通） | 见 §15 |
| `node tools/popup-shot.mjs` | **诊断工具**（不是门禁，永远 exit 0）：用**真** `popup.js` / `picker.js` 渲染截图到 `extension/.shots/`（不是 action popup 的截图，见工具头部） | 每个镜头的字节数与 sha256 |
| `node tools/mock-bridge.mjs --mode healthy --port 8795 --token "opn_…" --inbox` | 本地假桥（真 HTTP），用来跑 §4 的六态；`/v1/clip/stage` 也照 02 §2.5 校验 `assets[]` | 见 §4 |

**两种退出码要分清**：`0` = 通过；`1` = 可信且失败；**`2` = 本次结果不可信**（这时既不算红也不算绿）：
- `extension/.mutation-running` 存在 → 有变异正在跑（变异脚本自己的 verify 用 `OPENNOTE_MUTATION_SELF=1` 声明身份才会看到真实红）；
- `extension/.building` 存在 → **有构建正在写 dist**（`build.mjs` 先 `rmSync(dist)` 再逐文件重写，存在半写窗口）。

### 1.1 「门禁不许读一个正在被写的产物」（M2 收尾）

同族问题在团队里出现过三次：`.mutation-running` 让变异脚本自己的 verify 恒为 exit 2（假通过）、
`verify-e2e` 读到别人正在写的脚本、以及扩展这边一次「刚跑完 `build.mjs` 就 `node --test`」的 79/80 假红。
形制统一为**标记 + 指纹**（`tools/dist-guard.mjs`，构建与门禁**共用一份实现**）：

| 机制 | 谁做 | 作用 |
| --- | --- | --- |
| `.building` 标记 | `build.mjs` 开工写、收工摘（`finally` + `process.on("exit")`） | 读 dist 的门禁（`verify.mjs`）看到就以**退出码 2** 中止；测试看到就抛 `DistUnstableError` |
| `dist` 全量指纹 | `build.mjs` 写进 `BUILD-INFO.json`；`verify.mjs` **V19** 现场重算比对 | 任何来源的半写/事后改动都会红：被 kill 的构建、别的 agent 的构建、手改产物 |
| `readStableDist()` | `tests/self-contained.test.mjs` 读 dist 的唯一入口 | 读产物前先过守卫，绕过它会被 `tests/build-guard.test.mjs` 的接线断言抓住 |
| `tools/dist-race-probe.mjs` | 诊断工具（**不是门禁**，永远退出 0） | 一边跑构建风暴一边高频采样，量化半写窗口有多大 |
| `tools/cdp-pick-check.mjs` · `tools/real-bridge-stage-probe.mjs` · `tools/popup-shot.mjs` | 诊断工具（**都不是门禁**，永远退出 0，**不得当验收证据引用**） | 真机链路探针 / 真桥 stage 形状探针 / 设计稿渲染出图 |

**窗口是真实存在的（实测）**：`node tools/dist-race-probe.mjs --seconds 25 --builds 40` →
4292 次采样里 **645 次**撞到 `.building`、**6 次**撞到指纹对不上；同一批采样按**修复前**的读法
（直接 `readFileSync`）会有 **1241 次读到缺文件**、**260 次读到不完整的文件树**。
即：修复前约 **15%** 的「构建中采样」会被门禁当成真产物。

**真实门禁下也复现了**：一边跑 40 轮构建风暴一边跑 `node --test`，套件立刻给出
`DistUnstableError: 读 dist 算指纹时产物变了（ENOENT … dist/BUILD-INFO.json）—— 构建正在写这个目录。结果不可信。`
—— 修复前，这种时刻只会表现为某个用例莫名其妙的单条失败（就是那条 79/80 的形状）。

**诚实记一笔**：我按原样重跑了 30 次 `build + node --test`、5 次构建风暴下跑测试、6 次 4 路 CPU 负载下跑测试，
**都没能复现**那一次 79/80。所以这个修复针对的是**这一类**（已量化的窗口 + 已证实的判定路径），
而不是某一个被证实的实例。另外守卫的第一版自己就有洞：竞争发生时 `fingerprintDist` 会抛裸 ENOENT 崩掉 ——
是本探针第一次跑就撞出来的，现已把「读的过程中文件消失」也归到 `DistUnstableError`。

## 2. 目录结构（当前）

```
extension/
├─ src/
│  ├─ manifest.json            # MV3 清单：无 options_ui、host_permissions 恰好 10 条回环；可选主机权限恰好 2 条
│  ├─ background.js            # SW（module）：探测/状态/信封/投递/暂存/元素选择落盘/暂存给网页版剪藏页/网页版通道
│  ├─ lib/{assets,bridge,envelope,errors,inpage,pick,queue,stage,state,store}.js
│  ├─ content/{extract-page,inpage-bridge,picker,clipboard}.js
│  ├─ popup/{popup.html,popup.css,popup.js}
│  └─ styles/tokens.css        # 设计令牌唯一来源（构建期逐字注入影子根）
├─ tests/                      # 158 条单测（`node tools/run-tests.mjs`）
├─ tools/{cdp-pick-check,mock-bridge,mutation-check,mutation-stage-assets,dist-guard,dist-race-probe,popup-shot,real-bridge-stage-probe,run-tests,no-undef-check}
├─ verify.mjs                  # V1–V21（V2b 产物正面清单、V17A A 接通/⑤/③、V17B 网页版通道、V21 协议一致）
├─ .gitignore                  # 两个门禁标记（.building / .mutation-running）+ .shots/ 不进版本库
└─ README.md
```

**产物清单（26 个，V2b 逐个正面断言；数字上界已删除）**：
```
BUILD-INFO.json  background.js  manifest.json
content/{clipboard,extract-page,inpage-bridge,picker}.js
lib/{assets,bridge,envelope,errors,inpage,pick,queue,stage,state,store,timeout}.js
popup/{popup.css,popup.html,popup.js}   styles/tokens.css   icons/icon{16,32,48,128}.png
```
`manifest.json` 引用的 10 个文件都在清单内（V2b 会比对），清单之外的文件一律红。

M2（task-28）删除：`lib/templates.js`、`lib/highlights.js`、`content/highlight.js`、`options/**`、
manifest 的 `options_ui`、`chrome.storage.local` 的 `opennote.templates.v1` / `opennote.highlights.v1`。
task-3（本轮）删除：`src/clip/clip.html` + `src/clip/clip.js`（被网页版剪藏页取代，**连它的 `?tabId=` 路由与 `tabById()` 一起删**）；
新增：`lib/stage.js`（暂存请求体形状的唯一定义）+ `lib/assets.js`（图片字节层与降级）⇒ 27 → **24**。
0.4.0（网页版通道）新增：`content/inpage-bridge.js`（自包含注入函数）+ `lib/inpage.js`（协议常量与候选判定的唯一事实源）⇒ 24 → **26**。

## 3. 权限清单与联网边界

| 权限 | 为什么需要 | 去掉会怎样 |
| --- | --- | --- |
| `storage` | 令牌/端口/落点/模式 + 离线暂存队列 + 元素选择结果（单键 `opennote.clip.state.v1`） | 每次都要重新粘贴令牌，「先暂存」无法实现 |
| `contextMenus` | 右键 `剪藏整页正文到 Opennote`（**恰好一项**） | 右键入口消失 |
| `activeTab` | 用户点图标/快捷键/右键那一刻才拿到当前标签页 | 连当前页都读不到 |
| `scripting` | 注入 `extract-page.js` / `clipboard.js` / `picker.js` / `inpage-bridge.js`（**只在用户点了按钮或按了快捷键之后**） | 元素选择、复制降级与网页版投递全部失效 |
| `tabs`（0.4.0 新增） | **发现「浏览器里开着哪个 Opennote 网页版」**：没有它时 `tab.url`/`tab.title` 一律读不到（`activeTab` 只覆盖当前标签页，而用户此刻正在剪的是**别的**页面） | 网页版通道的按钮永远不会出现。代价如实记：安装时多一句「读取你的浏览记录」的提示；我们只用 `url`/`title` 判断，不读历史、不读页面正文 |

`host_permissions` **恰好 10 条**：`http://127.0.0.1:8787/* … 8796/*`。**没有** `<all_urls>`、没有通配域、
没有 `clipboardWrite`（复制走 §7 的三级降级）。V1/V3 逐条守着这些数字。

`optional_host_permissions` **恰好 2 条**（`http://*` / `https://*` 的任意主机）：**安装时不产生任何提示**，
它是「允许申请」的范围，不是「已经拿到」的权限。真正申请的时机只有一个 —— 用户在 popup 上点
`剪藏到 <域名>` 那一刻，按**那个标签页的 origin** 申请一次（`chrome.permissions.request`，
一次一个站点；已经给过就直接过）。V1 把这两条钉死，V3 只对这两行精确取值放行。

## 4. 连接状态：逐态复现

| 状态 | 触发条件 | 芯片 | 正文块 | 怎么恢复 |
| --- | --- | --- | --- | --- |
| **未开启** | 8787–8796 全部拒绝连接 | `本地接口未开启` | `IMP-1001` + 动作「重试 / 打开 Opennote 设置」 | 去应用里开启本地接口 |
| **Opennote 未运行** | 端口在听但回 409 `IMP-4006` | `Opennote 未运行` | 「连接被拒说明本机没有在监听，不是令牌问题。」 | 起应用，或「先暂存这页」 |
| **运行中 · 已配置令牌** | 命中 + `GET /v1/imports/auth-probe-0000` 通过（期望 404 `IMP-4017`）+ `GET /v1/workspace` | `本地接口已开启` | 预览：标题 / 摘要 / 来源信息 | 直接「剪藏到 Opennote」 |
| **令牌不匹配** | 桥在跑，auth 探测 401 `IMP-2002` | `未连接` | 令牌输入块 + 「换一个令牌…」 | 回应用重新生成令牌再粘贴 |
| **端口被占用** | 有监听但不是我们的桥 | `端口被占用` | `IMP-1003` | 关掉占端口的程序 |
| **来源不是扩展** | `/v1/health` 回 403 `IMP-3001` | `未配置令牌` | **绝不显示「已连接」** | 检查桥的 `allowedOrigins` |

测法：`node tools/mock-bridge.mjs --mode healthy --port 8795 --token "opn_<43 位>" --inbox`（各态用不同 `--mode`）。

### 4.1 网页版通道（0.4.0）：剪藏到已打开的网页版

**为什么需要**：网页版没有本地接口可连（它的 CSP 是 `default-src 'self'` + `connect-src 'self'`，
页面**不能** fetch `127.0.0.1`），桌面版才有桥。所以「网页版正开在浏览器里」时，唯一能把信封送进
笔记本的办法是让内容脚本与那个页面直接对话 —— 契约 02 §5.7 / FR-39 的**页面内桥**（`postMessage`）。

**用户看到什么**：检测到网页版标签页时，底栏在 `剪藏到 Opennote` **上方**多出一颗整行按钮
`剪藏到 <域名>`（域名取自被检测到的那个标签页，如 `buglan.github.io`；本地开发就是 `127.0.0.1:5173`）。
没检测到就**不出现**（界面上不留死元素）。它自己一条点击路径（`opennote:inpage-clip` → 后台交付），
**不**并进 `#primary` 的 intent 分支。

**一次剪藏的四步**（全部在 service worker 里编排）：

| 步骤 | 做什么 | 失败时 |
| --- | --- | --- |
| ① 找候选 | `chrome.tabs.query({})` → 标题或 URL 里带 `opennote` 的 http(s) 标签页；排除**正在被剪的那一页**与本会话握手失败过的标签页 | 没有候选 → 按钮不出现（不是错误态） |
| ② 上限 | 信封 > **1 MiB** 就不发（`postMessage` 会整份复制对象） | `IMP-4005` + 一句人话（关掉「图片一起保存」，或改用桌面版） |
| ③ 权限 | `chrome.permissions.request({origins:[<该页 origin>/*]})` —— **必须在这次点击的手势里**，一次一个站点 | `IMP-3001` + `没有获得访问 <域名> 的权限，这次剪藏没有发送。` |
| ④ 握手 + 入库 | 注入 `content/inpage-bridge.js`：`hello` → 等 `ready`（300 ms）→ `import` → 等 `result`（5 s） | 没握手：`IMP-1006`（可能不是网页版）；超时：`IMP-1004`（`Opennote 的页面没有响应…`）|

**候选判定是启发式的，握手才是唯一真相**：标题里带 Opennote 的普通网页也会被当成候选 ——
点下去握手不通过，就如实说一句，并把那个标签页记进本会话的失败集合（不再重复打扰）。

**协议纪律**（逐条对齐 02 §5.7）：

- 消息只有 `opennote:inpage:hello / ready / import / result / event`，`v` 恒为 1，`reqId` ≤ 64 字符；
- `window.postMessage(data, targetOrigin)` **必须显式给 origin**，绝不 `"*"`（V21 卡这一条）；
- 页面侧只校验 `event.source === window` + 同源 + 形状 + `reqId` + 信封校验；
  **订正**：契约原文第 2 条要求页面看到 `event.origin === chrome-extension://<id>` —— 这条在
  `postMessage` 上**不可实现**（内容脚本与页面共享同一个窗口，同窗口消息的 origin 必然是页面自己的
  origin，Chrome 官方文档明说两个方向都只能走共享 DOM）。订正已写进 `docs/import/02` §5.7 与
  `src/lib/clip/inpageBridge.ts` 的模块注释；
- 注入脚本**自包含**（只有一个顶层声明，不 import 任何东西 —— `executeScript({func})` 传的是源码副本），
  因此协议字面量在两处各写一份，`verify.mjs` 的 **V21** 逐字比对。

**边界（不许写成已验）**：`chrome.permissions.request` 会弹一次浏览器气泡；如果 popup 因此被关掉，
**入库仍然照常完成**（后续步骤全在 service worker 里），只是看不到那条回执 —— 笔记会在 Opennote 里
自己冒出来（应用侧另有 toast）。这条路径的真机验证见 §4.2。

## 4.2 真机验证：网页版通道（`node tools/cdp-inpage-check.mjs`）

**跑法**（先出两个产物：扩展 dist 与**真网页版** dist）：

```powershell
cd extension ; node build.mjs
cd ..        ; npx vite build          # 网页版产物，工具会在 127.0.0.1:4173 上起静态服务
cd extension ; node tools\cdp-inpage-check.mjs
```

工具自己起 Chrome（`--headless=new` + `--enable-unsafe-extension-debugging`）、装载 `dist`、
开两个标签页（真网页版 + 一张普通文章页），然后验两组事：

| 组 | 判据 | 为什么这条判据值钱 |
| --- | --- | --- |
| A 检测与呈现 | popup 底栏出现 `#webPrimary`、**文案逐字** `剪藏到 127.0.0.1:4173`、且它的 `top` **小于**主按钮的 `top` | 「检测到网页版 → 在剪切上面加一个按钮」是用户原话；位置错了就是另一种东西。这条同时证明 `tabs` 权限真的读到了那个标签页的 URL |
| B 协议 | 把**真** `deliverInpage`（`content/inpage-bridge.js`，经 `chrome.scripting.executeScript({func})` 注入）送进真网页版标签页后，service worker 收到 `opennote:inpage-report`，且 `local === false`、`error.code === "IMP-4007"` | 整条通道里唯一有平台不确定性的地方是**内容脚本隔离世界的 `window.postMessage` 能否被页面监听器收到**（官方文档说可以，但那只是文档）。`local:false` 说明回执来自**页面**（hello→ready→import→result 四步全通），`IMP-4007` 说明那句话出自**应用侧接收端**（`receiveEnvelopeOutcome()`），不是注入脚本自己编的 |

**2026-10-07 实测（Chrome 154.0.8037.58 / Windows）**：13 项全 PASS —— `#webPrimary` 文案
`剪藏到 127.0.0.1:4173`、位置 `web top=519 < primary top=557`，回执
`{"ok":false,"error":{"code":"IMP-4007","userMessage":"Opennote 里还没有打开笔记本文件夹。…"}}`。

**这个工具**验不到**的（诚实清单，别把它读成「全链路已验」）**：

1. **`chrome.permissions.request` 的那次浏览器气泡点不了**：CDP 动不了浏览器级 UI（与 `T-11` 同类边界）。
   工具绕开它，用「让网页版标签页成为活动标签页 → 触发 action 拿 `activeTab` → 注入」这条等价路径
   验协议；**「首次点击 → 弹气泡 → 允许 → 入库」那一步归人工**。
2. **popup 上那颗按钮的点击路径**（`submitToWeb()` → 抽正文 → 建信封 → 投递）没有在真机上点过 ——
   真机只验到按钮**在**、位置对、文案对。逻辑那一半由 `verify.mjs` V17B + `tests/inpage.test.mjs` 卡。
3. 入库**成功**（`ok:true` + `created`）没有真机证据：探针用的是一次性 profile，里面没有打开笔记本，
   所以页面如实回 `IMP-4007`。要出成功态，得先在那个 profile 里建一本浏览器笔记本再跑 —— 归人工。

## 5. `conflict` 纪律（回归受 V8 保护）
- 信封**默认不下发** `conflict` 键 —— 落点交给应用侧设置（默认收件箱）与判定链；
- 只有「追加到指定笔记」才有 `conflict: "append"`，而 M1 起 UI 上已经没有这个输入；
- 客户端**永不**下发 `"new"` / `"overwrite"`，`overwrite` 在扩展侧不可达。

## 6. 判定链要点（接收端第 1–4 步）

- `importId` 每次剪藏生成一次（`crypto.randomUUID()` 优先），**重投/重试复用同一个**（幂等）；
- `source.selection` 如实反映剪藏范围：元素选择时**恒为 `false`**（它是对「整页」的声明）；
- 去重四分支：同 `importId` → 幂等返回首次落点；同 URL 且正文哈希相同 → `duplicate`，不追加；
  同 URL 但正文不同 → 按 `selection` 分流；其余 → 新建。
- front-matter 固定 8 键顺序；**值为 `null` 则整行省略** —— 扩展侧对提取不到的来源字段
  （作者 / 发布时间 / 网页标题）下发 `null`，**绝不用空串或占位值凑键**（V17 + 单测双向卡住）。

## 7. 三级降级：没有 `clipboardWrite` 也能复制

① `navigator.clipboard.writeText`（popup 有焦点时）→ ② 注入 `content/clipboard.js` 在页面里用
`document.execCommand("copy")` → ③ 全失败则把 Markdown 显示在 `<textarea>` 里让用户手选。
菜单里的 `复制 Markdown` 走同一条链。

## 8. 离线暂存与幂等重投（FR-53）

连不上时正文进 `chrome.storage.local` 队列（`reason` 记下真实契约 code），回执如实说「已暂存」；
下次打开 popup 或桥恢复时 `flushQueue()` 补投，**成功才出队**，失败即停（不空转重试）。
队列放不下时**不静默丢弃**，降级到 §7 的复制。

## 9. 视觉与文案合规

- 设计令牌**唯一来源** `src/styles/tokens.css`，构建期逐字注入影子根（哈希在 V5 里比对）；
- **0 个新增设计令牌**；**无 emoji**；用户可见文案里**不出现反引号**（Markdown 内联标记不算文案）；
- 逐字文案由 V7 保护（清单里的句子少一句就红）；
- ⋯ 菜单**恰好 5 项**：`复制 Markdown` / `暂存在插件里` / `打开 Opennote` / `插件设置` / `清除本地令牌`
  —— M1 删掉了 `用当前选区新建标签…`（`标签` 输入退场后它是死元素），`03` C63 需 d-ui 从 6 项改 5 项。

## 10. 真机验证（Chrome 154.0.8037.58 / Windows）

```powershell
node build.mjs
node tools\cdp-pick-check.mjs                                   # 本地 demo → 全部 PASS（exit 0）
$env:OPENNOTE_PICK_URL="https://zhuanlan.zhihu.com/p/555517159"
node tools\cdp-pick-check.mjs                                   # 真知乎文章 → 全部 PASS（exit 0）
```

工具做的是**真链路**：`--enable-unsafe-extension-debugging` 起专用 Chrome → CDP `Extensions.loadUnpacked`
装载 `dist` → `Extensions.triggerAction` 触真图标（拿 tab targetId）→ `Input.dispatchMouseEvent` 真点一下 →
从 service worker 的 `chrome.storage.local` 回读 `picked`。

已验证（两个按钮都在真 Chrome 上跑通）：
- `选择当前元素`：覆盖层 `#opennote-pick-host` = `position:fixed / z-index:2147483647 / pointer-events:none /`
  **closed** 影子根 → 真点一下 → `picked` 落盘（demo：`p chars=42`；知乎：`pre chars=123`）→ 抽到的就是被点中那块
  → 点完覆盖层移除；
- `整页提取`：把来源切到整页正文（popup `data-mode=page`）；
- 本机真桥可达：扩展探测真的命中 `127.0.0.1:8787`（真 Opennote），令牌不对时 popup 如实显示
  `IMP-2002`「访问令牌不正确或已失效」，桥自己的 `bridge.log` 同时记 `auth.fail IMP-2002`。

**M2 抓到并修掉的真回归**：`normalizeUrl` 原在已删除的高亮模块里，删掉后元素选择结果会**静默落不了盘**（覆盖层照常出现、也能点，但 `picked` 为 null）。静态检查（`node --check`）抓不到，是**真机检查抓到的**；
修好后 V17 增加成对断言「调用了 `normalizeUrl` 就必须本地定义」，变异④证明它会红。

## 11. 已知限制与未验证项（诚实清单）

1. **`整页提取` 的正文预览未在真机上看到（UNVERIFIED）**：本机 8787 是用户**正在使用的真 Opennote**，
   扩展探测顺序永远先命中它，而**它的令牌拿不到** —— 运行中的是 `app: 0.2.0`，`bridge.json` 里只有
   `tokenHash` / `tokenLast4`（**没有**明文；仓库里的 `electron/bridge.cjs` 已有 `tokenPlaintext`，但那是
   未运行的版本）；扩展自己的 `chrome.storage.local` 是空的；应用没有开远程调试端口（只有 8787）。
   已扫过 `%APPDATA%\opennote`（507 个文件，排除缓存）与 Chrome 配置里的扩展存储，**没有任何**能
   sha256 对上 `tokenHash` 的明文。→ 解锁方式：把令牌贴进 popup，或运行仓库版应用后再跑一次。
   真机目前只证到「点一下确实把来源切到整页正文（`data-mode=page`）」。
2. **键盘快捷键与右键菜单没有在真机上触发过**：`Alt+Shift+S` 与右键项都需要浏览器进程层面的输入，
   CDP 到不了扩展命令注册表；它们与 popup 共用 `background.js` 的同一函数，单测覆盖消息分支。
3. **popup 打不开时的页面内提示条**（`已选好这一块。点扩展图标看预览。`）只被 V14 静态断言 +
   自包含性单测覆盖，没有真机触发过（`chrome.action.openPopup()` 在真机上一直成功）。
4. **`Esc` 取消元素选择**同样只被 V14 静态断言覆盖。
5. 令牌只读回显的**尾 4 位**已在 M2 修正（此前刚粘贴完会显示 `opn_••••••••••••????`）：
   尾 4 位从唯一真源推导 + 掩码纯函数 `maskTokenTail()`，V18 + 单测三层卡住。
6. **`IMP-2004`（配对码错误）**保留码号但**不再产出**（配对整体删除）。
7. **网页版通道的三处真机边界**（0.4.0，逐条见 §4.2 末尾）：`chrome.permissions.request` 的浏览器气泡
   点不了（所以「首次点击 → 允许 → 入库」那一步归人工）；popup 上那颗按钮的**点击路径**没有真机点过；
   入库**成功态**没有真机证据（探针用的一次性 profile 里没有打开笔记本，页面如实回 `IMP-4007`）。
8. **候选标签页判定是启发式的**（标题或 URL 里带 `opennote`）：标题里出现 Opennote 的普通网页也会成为
   候选，点下去握手不通过就如实报一句，并把那个标签页记进本会话的失败集合。多标签页时只挑**一个**
   （URL 里带 opennote 的优先 → 活动标签页 → 标签页顺序），不做选择器。

## 12. 变更记录

### 12.-1 0.4.0（网页版通道：剪藏到已打开的网页版）

**用户原话**：「如果检测到当前浏览器打开了 opennote 网页版，在剪切上面加一个按钮，比如剪切到 xx 网址，
比如 buglan.github.io」。落地为契约 02 §5.7 / FR-39 那条**一直只有文档、没有实现**的页面内桥。

- **权限**：新增 `tabs`（发现网页版标签页的唯一办法）+ `optional_host_permissions` 两条（安装期无提示，
  按 origin 逐个申请）。`host_permissions` 一条没动（仍是 10 条回环）。V1 新增可选主机权限断言，
  **V8 反向**（原来断言「不需要 tabs」，现在断言「必须有 tabs」并写明理由）。
- **新增两个产物**：`content/inpage-bridge.js`（自包含注入函数，`hello → ready → import → result`）、
  `lib/inpage.js`（协议常量与候选判定的唯一事实源）。24 → **26** 个文件，V2b 清单同步。
- **popup**：底栏多一颗 `#webPrimary`，**位置在主按钮之前**（DOM 顺序，V17B 盯），CSS 靠
  `.clip__foot{flex-wrap:wrap}` + `flex:0 0 100%` 独占第一行；默认 `hidden`（没检测到就没有这颗按钮）。
  可见性判定只有一个产地 `webTargetFor(plan)`。
- **background**：`clipActiveTab()` 里的抽取与建信封抽成 `buildEnvelopeForTab()`，本地桥与网页版
  两条投递路径**共用**（否则两条路迟早给出不一样的正文）；新增 `detectWebTarget()` /
  `deliverToWebPage()` / `askInpage()`（注入 + 回执挂起表 + 5 s 上限）与 `settleInpage()`。
- **门禁**：V7 逐字文案 +9 条、V12b 消息清单 14 → 16 条、新增 **V17B**（按钮位置/可见性/CSS/文案/
  独立点击路径）与 **V21**（注入脚本自包含 + 6 个协议常量两处逐字一致 + 无 `"*"`）；
  测试 144 → 158 条；`tools/mutation-check.ps1` 新增一个变异（把按钮挪到主按钮之后必须红）。
- **文档**：`docs/import/02` §5.7 记下页面侧 origin 判据的**订正**（内容脚本的 postMessage 必然带
  页面自己的 origin），`docs/import/03` 新增该按钮的 UI 条目与逐字文案。

### 12.0 0.3.2（task-3：接通网页版剪藏页 + 删旧页 + ⑤②③①）

**A 接通（用户要的「网页版剪藏页」）**：扩展侧只做两件事 —— ① `POST /v1/clip/stage`（Bearer 长期令牌，
请求体形状冻结在 `lib/stage.js`，**可执行断言**）；② 成功后 `chrome.tabs.create({ url: openUrl })`。
`openUrl` **只来自接口返回值**（`openUrlOf()` 取不到就是 `null`），扩展侧不拼端口、不拼 `stageId`；
失败**不打开页面**，把原因如实写在 popup 里。卡片上的图标入口恢复渲染（`CLIP_WEB_READY = true`，
无网址时不渲染）。旧页 `src/clip/clip.html` + `clip.js` 删除，**连同它的 `?tabId=` 路由与 `tabById()`**。

**⑤ 两个按钮的选中态**（用户报过「看不出选的是元素还是整页」）：`aria-pressed` 同时驱动读屏与视觉
（`.clip__pick .btn[aria-pressed="true"]`），着色只用既有令牌 `--accent-soft` / `--accent` / `--accent-line`
（新增令牌 0）。

**② 预览卡片「像 Opennote」**：正文从「一行纯文本摘要」改为**块级渲染**（标题 / 表格 / 代码块 / 引用 /
列表 / 分隔线 / 段落 + 三种行内标记），取值逐条对照 `src/styles/editor.css` 与 `tokens.css` 的真实值：
正文 `--font-mono` + `--doc-fs` + `--doc-lh`；H1 1.85em/600/-.014em + 2px `--rule`；`#` 用 `--ink-3`；
H2 1.45em/600 + 1px `--rule`；表格通栏 1px `--rule`、表头 `--paper-3`、单元格等宽；代码 `--code-bg`。
**预览不加载任何远程图片**（图片渲染成文字占位）。新增令牌 0。

**③ 图片下载开关（默认关）**：开关在卡片上（工具条仍是两个按钮）。打开时**真的把字节下下来**，
只有拿到字节才产出 02 §2.5 形状 `{name, mime, dataBase64}`；拿不到字节（无权限 / 跨站 / 超时 /
HTTP 非 2xx / 太大 / 非图片）→ **这一条不进 `assets[]`**、正文里的原始 URL **原样保留**、
原因逐条如实进 `warnings[]`，popup 先把说明摆出来再给「打开编辑页」（不静默打开）。
**绝不发一个桥必拒的形状**（`{url,alt}` 会让真桥 422 `IMP-4003 detail.field="assets[0].name"`）。
不新增权限、零依赖、新增令牌 0。

**① 夜版帧证据（根因修复）**：`page-01-mask-paper` 与 `page-02-mask-night` 字节数完全相同（31744）的根因
**不是** `Emulation.setEmulatedMedia`，而是**影子根里没有主题**：注入的令牌原样保留 `[data-theme="night"]`
这类**根属性选择器**，而影子根匹配不到影子树外面的祖先。修法两步、都不手抄色值：
① `build.mjs` 把根属性选择器机械改写成 `:host(...)`（25 处）；② `content/picker.js` 把页面根上的
`data-theme` / `data-accent` / `data-font` / `data-width` **镜像到我们自己创建的宿主元素**上
（只写我们创建的节点，㉝ 的「不得改页面 DOM」不变）。证据见 §14。

**门禁变化**：V2 新增 **V2b 产物正面清单**（逐个列出「该在的」与「必须不在的」；清单不对就**停在那里**，
不在半截产物上跑完再报一堆假红）；V17A 新增「A 接通 + ⑤ 选中态 + ③ 图片开关」一组；
V7 逐字文案 76 → 92 条；`verify.mjs` 顶部 V1–V20 不变。新增反向验证工具
`tools/mutation-stage-assets.mjs`（7 个变异，每个先证明落地：命中处数 + 前后 sha256，没落地 `NO_EFFECT` + exit 2）。

### 12.0.1 0.3.3（真机验收轮：两栏换位 + 图片开关 + 删说明句）

用户真机验收提的两批界面意见，落成两件（同一轮的上下半场）：

**上半场（`00` §6.16（53），上一个提交）**：网页版剪藏页**两栏换位**（左预览、右编辑；换的是 DOM
顺序而不是 CSS `order`，视觉顺序与 Tab 键顺序一致）；popup 的「图片一起保存」从卡片挪到**工具条那一行**。

**下半场（`00` §6.16（54），本条）**：用户对着真机截图**画了两个红框**，逐条落成：

- **红框里的说明文字删除**，两处：`选择模式进行中` 的那两句（`03` `UI-01/C68`+`C69`）与图片开关
  下面那三条状态说明（`C89`/`C90`/`C95`）。`verify.mjs` 的 V7 逐字清单同步**移除 6 条条目**
  （92 → 86）——判据对象不存在了就移除条目，不是放宽判据。
- **`#pickNote` 不许跟着一起删**：它还是**点选失败的出口**（四因分离文案 + `#pickDetail` 的真实原文）。
  删掉它就是把「点了一下没进选择模式」变成静默失败。V17A 新增一条反向断言卡住这一点。
- **图片开关「始终」与两个按钮同一行**：上一轮只把它挂进 `#pickRow` 还不够 —— `#pickNote` 是
  `flex-basis:100%` 的**整行子项**，**排在它后面的兄弟一定被挤到下一行**：只要那一行有话说
  （点选失败 / 等待点选），开关就掉到第三行（用户第二张截图里的现场）。做法：`mountImageSwitch()`
  改用 `insertBefore(imageSwitch(), pickNote)`，位置与「那一行有没有说明句」解耦；CSS 加 `flex:none`
  （不许被压缩成「同一行」的样子）。判据盯**兄弟顺序**：`verify.mjs` V17A 两条 + 单测一条。
- **依旧不破 ㊶**：㊶ 冻结的是工具条上的**动作**只有两个；删的是句子、挪的是复选框，动作数量没变。

**做法与验证**：`node build.mjs` → `node verify.mjs`（V1–V20 全绿，V7 = 86 条）→
`node tools/run-tests.mjs`（144 条全绿）；视觉证据是用**新镜头** `card-pickfail` 出的图（见 §14）——
它专门把「工具条那一行多出一句失败说明」这个最容易被挤下去的状态拍下来。

### 12.0.2 0.3.5（首启令牌块：补材质 + 主句唯一产地）

**用户原话**：「第一次启动的时候，需要向用户要密钥，然后此时的样式有问题，文本贴在边框附近，
没有正确的 border 和 margin」。

**根因不是「哪条 margin 写小了」**：`.clip__token`（令牌块）从 0.3.1 起**一条 CSS 规则都没有** ——
`git log -S 'clip__token' -- src/popup/popup.css` 是空的：**从来没写过，不是被删了**。0.3.1 把配对码
整体删除那一轮，只落了 HTML（`#tokenRow`）与渲染逻辑，于是首启屏上它是这么个东西：`<p>` 吃 UA 默认
外边距、输入框与「连接」各占一行、整块左右都贴到窗口边缘（现场见 §14 的 `card-token-before`）。
同一段代码还带出三件连带缺陷：

- **同一句话说两遍**：`#tokenMain` 的 HTML 默认文案与错误块（`.clip__alert`）里的 `IMP-2001` 是同一串字；
- **`IMP-2002` 时说的是错话**：输入框在「令牌不正确」时也露出来，而写死的那句是「还没有配置访问令牌」；
- **插件设置挂着一张假错误卡片**：`settingsPlan` 没有 `code`、没有动作，错误块靠兜底句 `IMP-4014` 撑满 ——
  用户在「插件设置」里读到的是「导入时出现了内部错误，已记录日志。请重试一次。」（现场见 §14 的
  `card-token-saved-before`）。

**做法（三处，互相独立）**：

1. `popup.css` 按 `03` §6.1 的 `.clip__token` 行补齐材质：`--paper-2` 内嵌块 + `--rule` 边框 +
   `--radius-sm` + `--s3` 内外边距；`label` + `.field`（`--font-mono`）+ 主按钮**同一行**；S30 的只读回显
   用 `--code-bg` 等宽块 + 「重新粘贴令牌」同排。两条 `display:flex` 的行各自补 `[hidden]{display:none}`
   兜底 —— 同 `#primary` 那个坑：**作者 `display` 会盖掉 UA 的 `[hidden]`**。
2. `popup.js`：令牌块的**主句只有一个产地** —— `blockNode()` 把这一态的真实句子（`IMP-2001`/`IMP-2002`）
   写进 `#tokenMain`，错误块不再重复渲染 `<p>`；没有主句、没有 `code`、没有动作时（插件设置），
   错误块**整个不渲染**（不再留一张只有边框的空卡片）。
3. 令牌块本体**位置不变**（仍在 `.clip__body` 里，**不搬进**错误块 —— 搬进去就是卡片套卡片、双层边框）；
   `tokenInputBlock()` 交回空片段，删掉 0.3.1 留下的空 `<div>` 占位：它唯一的作用是让「这张卡片是不是空的」
   恒为假（第 2 条那个判断因此永远进不去）。

**判定**：`node build.mjs` → `node verify.mjs`（V1–V20 全绿）→ `node tools/run-tests.mjs`（151 条全绿，
其中新增 4 条）。4 条新判据做了**变异自检**：把 `src/` 换回改动前那一版（`git archive HEAD extension/src`
到临时目录后重跑同一个测试文件），**正是这 4 条红、其余 17 条绿** —— 守卫能红，不是恒绿的装饰。

**一个字都没碰的**：用户可见文案（V7 的逐字清单不变）、`tokens.css`（55 个令牌，V5/V19 兜底）、
扩展版本号（发版时按 `RELEASING.md` §1 用 `pnpm release:version --extension` 两处一起写）。

### 12.1 0.3.2（M1 极简 + M2 清死代码）

**M1（task-24，用户可见）**：界面只剩 `选择当前元素` + `整页提取` 两个按钮；三区分段、模板选择器、
来源三选一、`存到`、`标签`、`追加到笔记` 的 DOM 全部退场（不留死元素）；右键菜单只剩一项；
正文不再生成 `## 高亮` 小节；**来源信息自动填写、允许空值**（提取不到就下发 `null`，由应用侧整行省略）；
默认进收件箱不变。`popup.js` 1430 → 843 行。

**M2（task-28，零用户可见效果）**：删除模板与高亮两个模块 + `options/**` + manifest `options_ui` +
两个 `chrome.storage` 键；`background.js` 里的死引用与 10 个死消息分支清除；`verify.mjs` 删掉 V10/V11
（逐条写明「为什么不再适用」）、V2 的 options 断言反向、V17 升级为「死模块不许进产物 + 产物确实变小」、
新增 **V18**（令牌回显）；删除 `tests/templates.test.mjs` / `tests/highlights.test.mjs`，新增
`tests/minimal-m1.test.mjs` / `tests/token-tail.test.mjs`；README 去 doc-debt（本文）。

**顺带修掉两个真缺陷**：① 粘贴令牌后只读回显尾 4 位显示 `????`；② 元素模式剪藏没把已选元素交给
`buildClipEnvelope`（会提交空正文）—— 现在与预览走同一条取法 `currentPicked()`。

**M2 收尾（门禁可信度）**：修掉「门禁读一个正在被写的产物」这一族问题 —— `build.mjs` 立 `.building`
开工标记 + 写 dist 全量指纹；`verify.mjs` 见标记即退出码 2，并新增 **V19 产物一致性**；
`tests/build-guard.test.mjs` 6 条把守卫的两种判定（标记 / 指纹）与**接线**都钉住；
新增诊断工具 `tools/dist-race-probe.mjs` 量化窗口（实测构建期 15% 采样会读到半写产物）。
详见 §1.1。

### 12.2 0.3.1（元素选择 + 去配对）

- ㉝ 元素选择取代选区浮标：`content/picker.js` 覆盖层（closed 影子根、`pointer-events:none`、点击三重阻断、
  `Esc`、退出即移除、不动宿主页面 DOM）；`Alt+Shift+S` 语义改为「进入元素选择模式」；浮标与 `selectionchange` 删除；
- ㉞ 配对整体删除，改为粘贴 47 字符长期令牌（`TOKEN_RE = /^opn_[A-Za-z0-9_-]{43}$/`）；
- task-21 四因分离：`no_url` / `restricted_scheme` / `injection_failed` / `extraction_failed` 各一句真话
  （`src/lib/pick.js` 单一来源），注入失败把 `chrome.scripting` 的真实原文显示在 popup 的 `#pickDetail`；
- 页面内药丸反馈随浮标删除，改为 `chrome.action` 徽标。

### 12.3 0.2.0 / BLOCK-1（历史）

信封与契约（`opennote.import/v1`）、落点与去重、离线队列、三级复制降级、收件箱回执文案。

## 13. 真机跑通记录（卡死修复后一轮）

令牌**从盘上自己取**，不在对话里转抄（少一个产地）：

```powershell
cd extension
$env:OPENNOTE_PICK_TOKEN = (Get-Content "$env:APPDATA\opennote\bridge.json" -Raw | ConvertFrom-Json).tokenPlaintext
node tools\cdp-pick-check.mjs
```

| 次 | 结果 | exit |
| --- | --- | --- |
| ① 修 `workerSession` 之前 | 内容断言全 PASS，但工具自己在 `finally` 里抛 `workerSession is not defined` → 中断 | 1 |
| ②③ 修好之后 | `popup 在 8 秒内离开加载态` PASS、`popup / service worker 没有 Uncaught 或 console.error` PASS、`整页提取` 正文预览 PASS | 1（1 项 FAIL，见下） |

- **新增两条断言**（本轮派单的验收点）：① popup 必须在 **8 秒内离开加载态** —— 用户那个卡死本可被它抓住，此前缺的就是它；② popup **与 service worker** 的 `Runtime.exceptionThrown` / `consoleAPICalled(error)` / `Log.entryAdded(error)` 任一出现即 FAIL。
- **`整页提取` 的正文预览已解锁**（此前 UNVERIFIED）：对真 8787 跑，预览区出现的是页面正文（`## 中文排版指北 …`），且「预览里出现的就是页面上的正文」PASS。
- ~~**仍未过的一条：`粘贴令牌 → 连接 → 只读回显` FAIL（原因未定，未修）**~~ → **2026-09-30 定案（见下）**。现场：令牌 47 字符、通过本地预检（`#tokenError` 未出现、无 `aria-invalid`），但 `opennote:set-token` 回来后 `reply.ok` 为假、popup 没进只读回显；同时 `%APPDATA%\opennote\bridge.log` 在这三次运行期间**没有任何新条目**（既无 `auth.fail` 也无 `import.ok`）。同一个桥（06:58:52 启动）在 07:10:59 / 07:24:20 记过扩展的两次 `import.ok`，说明这条链曾经通。

### 13.1 定案：`粘贴令牌 → 连接` 是 **CDP 环境 artifact**，用户侧人工验证可用

**结论（第三种状态）**：
> 真机 CDP 环境下的 action popup 处于**隐藏/失焦态被节流**，导致工具无法驱动该路径；
> **用户侧已由用户本人验证可用**。

- 证据：① CDP 真鼠标点击后 `chrome.storage.local` 里 `hasToken:false`、SW console **没有** `set-token：收到`（消息根本没发出）；② 探针打印 popup 的 `document.visibilityState === "hidden"`；③ **用户在真 popup（非 CDP）里粘贴 47 字符令牌 → 点「连接」→ 连上了**。
- **这条验收的边界**：「粘贴令牌 → 连接」这一步，**扩展侧的自动化验收到此为止** —— 有效证据来自**用户本人的人工验证，不是机器**。它既不是「未验证」，也不是「机器已验证」。
- 为此留下的东西（不许撤）：`storeManualToken` 的 **`set-token：收到`** 探针与 `visibilityState` 打印 —— 没有它们只能在「产品坏了 / 工具坏了」之间猜；`tools/cdp-pick-check.mjs` 头部的**边界声明**（下一个人不会再追一遍）。
- 这一轮顺带查实的**真产品缺口**（独立于上面的 artifact）：`storeManualToken` 的 `discover()` **原先完全没有超时** —— 对 8787–8796 逐个请求，任一端口「接受连接但不回话」就能拖死整条链，用户看到的就是「点了连接什么都没发生」。已加 `settleWithin(..., DISCOVER_TIMEOUT_MS=3000)` 并**先保存令牌再探测**（动作的成败不该由旁支决定）。

## 14. 视觉证据（task-3：⑤②①）· 图在 `extension/.shots/`（已 gitignore）

**先说清这些图是什么**：它们由 `node tools/popup-shot.mjs` 生成 —— **真** `popup.js` / **真** CSS /
**真** `dist/content/picker.js`，只是换了个宿主（本地 http + 一个 `chrome` 替身）。
**它们不是 action popup 的截图**（`T-11`：真机 CDP 里 popup 被节流，那条路机器不可验）。
本工具是**诊断工具、不是门禁、不得当验收证据引用**；逻辑那一半由 `tests/**` 与 `verify.mjs` 卡。

| 文件 | 是什么 | 字节 | sha256（前 16） |
| --- | --- | --- | --- |
| `.shots/card-before-page.png` | ② 改之前：正文是一行纯文本摘要（`#`/`**` 原样、4 行截断、无表格） | 37080 | `54329bb19c5f2b84` |
| `.shots/card-page.png` | ② 改之后：`#` 暗灰 + 衬线粗体大字 + 通栏细线；正文等宽；表格 1px 通栏、表头略深 | 39800 | `1b362b412d8383d7` |
| `.shots/card-before-element.png` | ⑤ 改之前：两个按钮**一模一样**（用户原话「看不出选的是元素还是整页」） | 32021 | `40b25da8aa1185db` |
| `.shots/card-element.png` | ⑤ 改之后：`重新选择` 处于选中态（`--accent-soft` 底 + `--accent` 字），来源行写 `已选择 article` | 34740 | `d4f3a13823ad2833` |
| `.shots/card-page-night.png` / `.shots/card-element-night.png` | 同一套卡片走**夜读**主题（深色纸） | 38354 / 33256 | `7f3dc9f8fe7bbfea` / `4011899806a39418` |
| `.shots/card-warn.png` | ③ 的降级说明：图片没下载下来 → 说明摆出来 + 主按钮变 `打开编辑页`（不静默打开） | 24655 | `8e5416971d8a03ea` |
| `.shots/picker-before-paper.png` | ① 修复**前**、亮色：覆盖层用纸色压暗（正常） | 20850 | `5fc17dd3a2f49686` |
| `.shots/picker-before-night.png` | ① 修复**前**、夜读：覆盖层仍用**亮色纸**（深色页面上蒙一层灰白）＝ 缺陷现场 | 20994 | `dc7f1a725906a9b6` |
| `.shots/picker-paper.png` | ① 修复**后**、亮色：与修复前**逐字节相同**（`5fc17dd3a2f49686`）⇒ 修复没碰亮色那条路 | 20850 | `5fc17dd3a2f49686` |
| `.shots/picker-night.png` | ① 修复**后**、夜读：覆盖层改用夜版纸色（「洞」比四周亮、跟随之标签转为浅色墨） | 21267 | `68d79a4a4134b7d6` |

**0.3.3 重出的一轮（`00` §6.16（54）：删说明句 + 图片开关「始终」与两个按钮同一行）**：
上面表里 `card-page` / `card-element` 两行是 **v5 那一轮**的现场（字节/sha 属于那一轮的版本，留着用于那一轮的对比）；
本轮重出后的三帧如下 ——

| 文件 | 是什么 | 字节 | sha256（前 16） |
| --- | --- | --- | --- |
| `.shots/card-page.png` | 0.3.3：工具条那一行 = `选择当前元素` + `整页提取` + `图片一起保存`（靠右）；开关下面**没有**说明行 | 36181 | `bcd5ffbe6d1d4886` |
| `.shots/card-element.png` | 同上，来源 = 已选元素（`重新选择` 处于选中态，来源行 `已选择 article`） | 24194 | `908e68bdb9ba11f2` |
| `.shots/card-pickfail.png` | **新镜头**：点选失败 ⇒ 工具条那一行多出一句失败说明（`#pickNote`），开关**仍**在第一行 —— 用户 0.3.3 第二张截图里它正是被这一行挤到了第三行 | 40661 | `d60edb655190181c` |

三帧出自同一批命令：`node tools/popup-shot.mjs --shots=card-page,card-element,card-pickfail`。
它们证明的是**静态排版**（开关与两个按钮同排、说明行只剩「点选失败」这一条路径），
不是真机点击路径（`T-11` 仍归人工）。

**怎么读这张表（可证伪的签名，不是「看着不一样」）**：
- 同一个主题下「修复前 vs 修复后」：**亮色两帧字节完全相同**（20850 B / `5fc17dd3…`），
  **夜读两帧不同**（`dc7f1a72…` → `68d79a4a…`）⇒ 改变的**只有夜版那条路**，正是本次修的范围；
- 同一个版本下 `paper` vs `night`：修复前**也**不同 —— 但那个差异来自**页面自身**的背景（页面也是
  亮/暗两套），**不是覆盖层换了装**；所以判据必须盯上面那一条同主题对比，不能只看「两帧不一样」。
- 旧的 `page-01-mask-paper.png` / `page-02-mask-night.png`（各 31744 B、来自 `cdp-pick-check` 的
  `Emulation.setEmulatedMedia`）**保持原样留着**，作为「上一次为什么没验出来」的现场：那次两帧字节相同，
  原因是影子根里根本没有主题可言（见 §12.0 ①）。

**0.3.5 重出的一轮（首启令牌块：材质 + 主句唯一产地，见 §12.0.2）**：新镜头 `card-token` /
`card-token-night` / `card-token-saved`，外加两帧同状态对照（`card-token-before` /
`card-token-saved-before`，走 `variant=before`，读的是 `.shots/before/` 里**改动前**的那一版源码）：

| 文件 | 是什么 | 字节 | sha256（前 16） |
| --- | --- | --- | --- |
| `.shots/card-token-before.png` | 改动前：主句贴着窗口左边缘（无边框、无内外边距），「连接」被挤到单独一行；下面那块把同一句又说了一遍 | 37723 | `a663800580d97b0a` |
| `.shots/card-token.png` | 改动后：`--paper-2` 卡片 + `--rule` 边框 + `--s3` 内外边距；`访问令牌` + 输入框 + `连接` 同一行；同一句只说一遍 | 33647 | `d10c1908fbf2a3db` |
| `.shots/card-token-night.png` | 同上，夜读主题 | 33474 | `5385ef37a1ffe5e4` |
| `.shots/card-token-saved-before.png` | 改动前 · 插件设置：裸文本 + 一张写着 `IMP-4014`（与「插件设置」毫无关系的假错误）的卡片 | 24347 | `c0e7a6191b9a11ce` |
| `.shots/card-token-saved.png` | 改动后 · 插件设置（`S30`）：只剩一张卡片 —— `--code-bg` 只读回显 + `重新粘贴令牌` + `C73` 次行 + 代价披露 | 23761 | `68d8da317b17b27d` |

同批命令：`node tools/popup-shot.mjs --shots=card-token,card-token-night,card-token-saved,card-token-before,card-token-saved-before`。

**没被这次改动碰到的那条路可以自证**：`card-page` 重出后仍是 **36181 B / `bcd5ffbe6d1d4886`** —— 与上面
0.3.3 那一轮的记录**逐字节相同** ⇒ 连接正常态一个像素都没动（这一帧没有令牌块，所以它接不住本轮的改动，
正好当对照组）。

**读这一轮的表要多知道一件事（诚实边界）**：这些帧在**页头那一条**（像素 `y≈12–55`）会有 0–11 B 的
run-to-run 抖动 —— 与本次改动**无关**：0.3.3 就有的 `card-element` 同样会在 23959 B / `8e135de2131151fb`
与 23970 B / `e1ab675589ff5eb2` 之间跳（各跑 4 次的实测）。所以上表的字节/sha 是**某一次运行**的取值，
不能拿「字节完全相同」当本轮的判据；本轮的可证伪判据是 `tests/popup-card.test.mjs` 里那 4 条 +
同状态两帧的**可见差异**（主句首行最左的深色像素：改前 `x=2`，改后 `x=30` —— 差值正是
`--s3` 外边距 + `--s3` 内边距 + 1px 边框 = 25px，再用 Pillow 在两帧上量的）。

**已知边界（不许写成已验）**：以上都是**静态渲染**；真机 action popup 里的点击路径仍归 `T-11`（人工）。

