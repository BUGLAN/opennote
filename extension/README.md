# Opennote 剪藏扩展（Chrome / Edge · Manifest V3）

把网页上的**一块元素**或**整页正文**剪藏到本机的 Opennote 笔记本，默认先进**收件箱**。
连不上时如实说清楚是哪一种连不上；无论如何**不静默失败**。

> 本文档描述的是**当前实现**（M1 极简 + M2 清死代码之后）。历史上出现过的「三区分段 / 模板系统 /
> 高亮 / 来源三选一 / 存到 / 标签」已整套删除，文档里不再有它们的说明。

## 0. 30 秒上手

1. 构建：`cd extension ; node build.mjs` → 产物在 `extension/dist`（21 个文件）。
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
| `node build.mjs` | 拷贝 `src/` → `dist/`、tokens 逐字注入（3 处 `:root`→`:host`）、生成 PNG 图标、写 `BUILD-INFO.json`、`verifyManifest()` | `[build] dist 就绪：21 个文件` |
| `node verify.mjs` | 静态验收 **V1–V19**：清单/权限/引用完整性/零远程主机/零 eval+内联处理器/tokens 逐字同源/0 新令牌/逐字文案/契约硬约束/无 emoji/极简形态（两按钮 + 无死元素 + 来源允许空值）/反引号禁用/元素选择纪律/去配对+令牌格式/四因分离/令牌回显/**产物一致性** | `✓ 19 组验收全部通过（V1–V19）`（退出码 0） |
| `node --test "tests/**/*.test.mjs"` | 86 条单测：信封、状态、队列、桥（真 HTTP）、自包含性、判定链（真接收端）、元素选择四因、极简形态、令牌回显、产物守卫 | `# tests 86 / # pass 86 / # fail 0` |
| `node tools/dist-race-probe.mjs --seconds 25 --builds 40` | **诊断工具**（不是门禁）：量化「构建进行中读产物」的窗口有多大 | 半写窗口命中的采样数（见 §1.1） |
| `node tools/cdp-pick-check.mjs` | 真机：真 Chrome + 真扩展 + 两个按钮 + ㉝ 全链 | `元素选择真机验证：全部 PASS` |
| `pwsh -File tools/mutation-check.ps1` | 8 个变异**必须变红**且命中期望文案（反向验证门禁本身有效） | 8/8 命中后 `verify exit=0`、tests 0 fail |
| `node tools/mock-bridge.mjs --mode healthy --port 8795 --token "opn_…" --inbox` | 本地假桥（真 HTTP），用来跑 §4 的六态 | 见 §4 |

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
│  ├─ manifest.json            # MV3 清单：无 options_ui、无通配 host
│  ├─ background.js            # SW（module）：探测/状态/信封/投递/暂存/元素选择落盘
│  ├─ lib/{bridge,envelope,errors,pick,queue,state,store}.js
│  ├─ content/{extract-page,picker,clipboard}.js
│  ├─ popup/{popup.html,popup.css,popup.js}
│  └─ styles/tokens.css        # 设计令牌唯一来源（构建期逐字注入影子根）
├─ tests/                      # 86 条单测（含「产物守卫」6 条）
├─ tools/{cdp-pick-check,mock-bridge,mutation-check,dist-guard,dist-race-probe}
├─ verify.mjs                  # V1–V19
├─ .gitignore                  # 两个门禁标记（.building / .mutation-running）不进版本库
└─ README.md
```

M2（task-28）删除：`lib/templates.js`、`lib/highlights.js`、`content/highlight.js`、`options/**`、
manifest 的 `options_ui`、`chrome.storage.local` 的 `opennote.templates.v1` / `opennote.highlights.v1`。
产物文件数 27 → **21**（V17 正向断言「产物确实变小了」+「死模块与死存储键一个都不许出现」）。

## 3. 权限清单与联网边界

| 权限 | 为什么需要 | 去掉会怎样 |
| --- | --- | --- |
| `storage` | 令牌/端口/落点/模式 + 离线暂存队列 + 元素选择结果（单键 `opennote.clip.state.v1`） | 每次都要重新粘贴令牌，「先暂存」无法实现 |
| `contextMenus` | 右键 `剪藏整页正文到 Opennote`（**恰好一项**） | 右键入口消失 |
| `activeTab` | 用户点图标/快捷键/右键那一刻才拿到当前标签页 | 连当前页都读不到 |
| `scripting` | 注入 `extract-page.js` / `clipboard.js` / `picker.js`（**只在用户点了「选择当前元素」或按 `Alt+Shift+S` 时才注入**） | 元素选择与复制降级失效 |

`host_permissions` **恰好 10 条**：`http://127.0.0.1:8787/* … 8796/*`。**没有** `<all_urls>`、没有通配域、
没有 `clipboardWrite`（复制走 §7 的三级降级）。V1/V3 逐条守着这些数字。

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

**M2 抓到并修掉的真回归**：`normalizeUrl` 原在已删除的高亮模块里，删掉后元素选择结果会**静默落不了盘**
（覆盖层照常出现、也能点，但 `picked` 为 null）。静态检查（`node --check`）抓不到，是**真机检查抓到的**；
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

## 12. 变更记录

### 12.1 0.3.2（本轮：M1 极简 + M2 清死代码）

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
