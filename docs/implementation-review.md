# 独立复核：占位名笔记自动改名 + 旧附件迁移（t9）

> 复核任务：`t9`（团队 `opennote-rename-title`，成员 `reviewer`，attempt 1）
> 复核对象：`t7`（自动改名实现，交付物 `src/lib/utils.ts` / `src/data/library.ts` / `src/App.tsx` /
> `src/components/EditorPane.tsx` / 测试）与 `t6`（附件迁移器，交付物 `src/data/migrateAssets.ts` /
> `scripts/migrate-assets.mjs` / `src/data/nodeFsBackend.ts` / `saveImage` 去重）
> 对照基准：`docs/标题命名规则-改动方案.md`（27 条改动清单）· `docs/asset-lifecycle-and-migration.md`（A→D 四阶段）
> 复核方式：**只读**。未修改 `src/` / `scripts/` 下任何文件；`E:\repo\notes` 只读（只跑 dry-run，
> 跑前跑后全树 935 个文件的 sha256 逐条比对完全一致）。
> 证据标注沿用方案约定：**【实测】**= 有命令/运行读数；**【读码】**= 代码行可复核；**【推断】**= 未实测。

---

## verdict: **needs_revision**

三个**阻断级约束**（不写 `titleOverride`、`cursorRef` 存在的必要性、抑制条件含 30s 静默期 + IME）
**全部成立**，收窄范围（只救占位名、认 H1–H6、其余笔记不动）**逐条成立**，数据安全设计（复制→校验→删源、
不碰 `.opennote/history/`、绝不递归删 `.opennote/`）**逐条成立**。核心功能是对的、可用的、有测试咬住的。

判 `needs_revision` 的是 3 条**具体的、可验证的偏离**（不是风格问题）：

| 级别 | 编号 | 一句话 |
|---|---|---|
| 高 | R1 | 方案 §2.6「必须同时改 `renameNote` 的两处」第 1 处（`titleOverride` 写**落盘名**而不是**请求名**）**没有实现**，且方案 §7.1 为它指定的新断言在测试里**不存在**。 |
| 高 | R2 | 方案 #20 的 `autoTitleFromPlaceholder` 开关**完全不存在**（`src/data/types.ts` 里没有这个键），改名默认开启且用户**无法关闭**；方案 #19 的对话框文案也未改（文案仍在说「只改显示名」，与新规则矛盾）。 |
| 高 | R11 | **Windows 上「删空目录」完全不生效**：`removeIfEmpty` 的 `backend.remove(dir)`（不带 `recursive`）经 `nodeFsBackend` 落到 `fs.rm(dir, {recursive:false})`，Node 22 / win32 对**目录**一律抛 `ERR_FS_EISDIR`，异常被 `.catch(() => undefined)` 吞掉 → 23 个旧附件目录一个都收不掉。**见下方来源说明**：本条由 t8 验证者以真实文件系统复现（我未独立复现）。 |
| 中 | R3 | 复核验收里逐字列出的「`cursorRef` **真的存在且被定时器读取**」——**存在但不被任何代码读取**（`grep cursorRef` 只有声明与写入两处）。定时器读的是数据层的 `editorCursorLine`（**这层语义是对的、比 `cursorRef` 更正确**），但验收字面项不成立，且 `cursorRef` 是死代码。 |

> **R11 的来源与我的处理**：我在本次复核中**没有**跑过 `--apply`（任务要求 `E:\repo\notes` 全程只读，
> 我只跑 dry-run），因此 R11 **不是我独立复现的**。它来自同队成员 t8 的验证报告
> `docs/implementation-verification.md` §3「缺陷 D1」，那里有最小复现脚本、Node 22.19.0 / win32 的
> 原始报错文本，以及仓库自有两个测试夹具里早写下的同一事实（`src/data/library.p2.test.ts:214`、
> `src/data/library.regression.test.ts:182` 的注释「Node semantics: rm(dir, {recursive: false}) always fails,
> empty or not」）。**我把它并入本复核的 findings 并判 high**，因为它直接推翻我 §3.3 里
> 「空目录才收」这条判据的**可用性**（护栏本身写对了，落地却静默失效），且用户原始诉求正是
> 「整理旧附件目录」。两份报告在这一点上**没有冲突**：我核的是护栏的形状，t8 核的是护栏在真机上的效果。

以上四条都不影响「图片会不会丢」（源文件在阶段 B 已复制并逐字节校验、引用已改写），
但都会影响**下一个人读代码时的判断**、**用户的知情权**与**交付是否真的达到用户诉求**，
且每条都有明确的、一行到十几行的修法。因此不判 pass；修完（或由队长显式把 R1/R2 移出本次范围并留档）
即可转 pass。

---

## 1. 三个阻断级约束：逐条核验（结论：全部成立）

### 1.1 约束一 ★「自动改名不写 `titleOverride`」——**成立**（代码 + 运行双证）

**代码证据（全仓写入点穷举）**

`grep -n "setTitleOverride|pinTitle|titleOverride:" src/data/library.ts` 的全部命中：

| 行 | 上下文 | 是不是自动改名路径 |
|---|---|---|
| `:307` | `makeNote()` 里 `titleOverride: null`（新笔记初始值） | 否 |
| `:583` | 快照恢复 / 历史回放 | 否 |
| `:894` | 重扫时把 `local.titleOverride` 搬回内存 | 否（只读） |
| `:1673` | `renameNote()`：`titleOverride: clean` | **否（用户显式改名）** |
| `:1675` | `renameNote()`：`setTitleOverride(nextPath, clean)` | **否（用户显式改名）** |
| `:1441` | **`autoRenameFromPlaceholder()`**：`titleOverride: null` | **是 —— 写的是 `null`** |

`titlePinnedAt` 的唯一写入点是 `pinTitle()`（`:1618-1621`），而 `pinTitle()` 只被 `renameNote()`
调用（`:1677`）——**【读码】** 自动改名路径既不写 `titleOverride` 也不写 `titlePinnedAt`。
`:1444-1449` 那段「防御性清掉 `nextPath` 上的 stale pin」是**删**不是写，且注释说明了理由。

`autoRenameFromPlaceholder` 的实现形状（`:1396-1466`）与方案 §2.6 的 13 步逐条对齐：
`flushNote` → `resolveAvailablePath`（或 `caseOnly` → `moveCaseOnly`）→ `target.move` →
`remapIds` → `moveHistory` → `patchNotes(title: deriveTitle(...), titleOverride: null, updatedAt)`。
**与 `renameNote` 的唯一差别就是第 11 步**，与方案逐字一致。

**运行证据**

- `src/data/library.files.test.ts:752-769`【实测，已跑通】：第一次自动改名后
  `getLibrary().notes["会议记录.md"].titleOverride === null`，且第二次改标题**文件名再跟一次**
  （`会议记录.md` → `会议记录 2026.md`，旧文件不存在）。这条正是「复用 `renameNote` 会失败」的反证。
- `src/data/library.files.test.ts:771-781`【实测，已跑通】：自动改名后 `flushMeta()`，
  `state.json` 里 `titlePinnedAt === undefined` **且** `titleOverrides === undefined`。
- 真实笔记本旁证【实测】：`E:\repo\notes\.opennote\state.json` 的 `titleOverrides` **只有 1 条**
  （`项目实战/system_panel/系统设计ABC.md`），`titlePinnedAt` **不存在**——与队长实测一致，
  说明自动改名至今没有往 `state.json` 里堆过任何记录。

> 一句话：这条阻断级约束**真的落实了**。`refresh()` 的 `titleOverride ?? deriveTitle(...)`
> 不会被自动改名锁死，用户第二次改标题文件名还会跟随。

### 1.2 约束二 ★ `cursorRef`——**机制成立，但字面项不成立（见 R3）**

**成立的部分**：定时器读到的**不是**过期闭包值，这一条的核心诉求（方案 §2.4 / 风险 R5）被满足。

- 方案推荐「两层一起做」，实现**只做了第 2 层，并且做得更彻底**：
  数据层 `editorCursorLine: Map<Id, number>`（`src/data/library.ts:217`）+
  `setEditorCursorLine(id, line)`（`:1286-1291`）+ `autoRenameContext()` 里现取
  `cursorLine: editorCursorLine.get(id) ?? null`（`:1256-1274`），`shouldAutoRename()` 里比对
  `firstHeadingLine(content)`（`:1217-1219`）。定时器回调 `autoRenameContext(id, now)` 每次
  **现取最新状态**（`:1256`），不闭包捕获 `Note` 对象——方案 §2.4「重新读取最新状态」成立。
- `firstHeadingLine()`（`src/lib/utils.ts:138-140`）与 `derivePlaceholderTitle()` 共用**同一次扫描**
  （`scanPlaceholderTitle:142-171`），并修掉了方案没提的一处错位：`splitFrontMatter` 新增
  `bodyLineOffset`（`:56-67`），带 front matter 的笔记光标行号不会整体错位。
  用例 `src/lib/utils.test.ts`「firstHeadingLine（光标是否还停在标题那一行）」把
  「body 相对行号 → 绝对行号」这条咬住了（`---`/`tags`/`---`/空行/`前言`/空行/`# 真标题` → 7）。
- 运行证据：`src/data/library.files.test.ts:908-923`【实测，已跑通】——光标在第 1 行时停笔 5 秒
  **零 move**；`setEditorCursorLine(id, 3)` + 再改一次内容后正常改名。

**不成立的部分**：`const cursorRef = useRef(cursor)`（`src/App.tsx:130`）在 `onCursor` 里被写入
（`:1316`），但**全仓没有任何地方读它**（`grep -n cursorRef src` → 只有 `:130` 与 `:1316`）。
`src/App.tsx` 里也**没有** `onCursor` 的其它读取路径。

**判定**：这不是「方案没实现」，而是「实现换了一条更正确的路，留下一个没用上的 ref」。
定时器读的是数据层现取的值，**不存在过期闭包问题**。但复核验收里逐字写着
「`cursorRef` 真的存在且**被定时器读取**」，字面项不成立 → 记 R3（low），不因此单独判 fail。

### 1.3 约束三 ★ 抑制条件含 30s 显式重命名静默期 + IME 保护——**成立**

`shouldAutoRename(ctx)`（`src/data/library.ts:1200-1320`）把方案 §2.2 的 15 条**逐条**实现成纯函数，
返回值是「被哪一条拦下的原因字符串」（写进 `AutoRenameOutcome`，排查时不用猜）：

| 方案条件 | 实现位置 | 说明 |
|---|---|---|
| 0 占位名（收窄核心） | `:1209` | 判 `placeholderOrigin`（**不是**当前文件名——见 §2.1 的必要性说明） |
| 1 不在回收站 | `:1211` | |
| 2 `titleOverride == null` | `:1213` | 永久停用 |
| 3/4 有真标题行、非首行兜底 | `:1215-1216` | `derivePlaceholderTitle` |
| 5 洗名不等于 fallback | `:1218-1219` | |
| 6 与当前文件名逐字不同 | `:1220` | 只差大小写留给 `moveCaseOnly` |
| 7 不新（10s） | `:1222` | `NEW_NOTE_QUIET_MS = 10_000`（`:204`） |
| **8 显式重命名 30s 静默期** | `:1224-1226` | `EXPLICIT_RENAME_QUIET_MS = 30_000`（`:202`），两张表取更晚者 |
| 9 导入/剪藏/副本静默期 | `:1222` 复用条件 7 的 `createdAt` | **见 R6（口径偏离，效果等价）** |
| 10 `createGuards` | `:1227` | |
| 11 只读锁 | `:1229` | |
| 12 旧布局附件引用 | `:1232` | `hasLegacyAssetRef`（`:1246-1254`） |
| 13 同篇 30s 最小间隔 | `:1234` | `AUTO_RENAME_MIN_INTERVAL = 30_000`（`:200`） |
| 14 改名在途 | `:1236` | `autoRenameInFlight` |
| **§2.4 光标在标题行** | `:1237-1239` | 见 §1.2 |
| **§2.4 IME 合成中** | `:1240-1241` | `composing` → 见下 |

**30s 静默期的运行证据**：`src/data/library.files.test.ts:818-850`【实测，已跑通】逐条咬边界——
`now-1_000` / `now-29_999` 拦、`now-30_000` 放行；`pinnedAt`（持久化那张表）同样拦；
两张表取更晚者。`:852-863` 证明**待执行的定时器被显式重命名取消**（`renameCount === 1`）。

**IME 保护的实现路径与方案不同，但更可靠**（详见 §7 的偏离说明）：

- 方案 #16 写的是 `src/editor/setup.ts:168-179` 的 `updateListener` 读
  `update.transactions.some(t => t.isUserEvent("input.type.compose"))`（方案自己标注为**【推断】**）。
- 实现改成 `src/components/EditorPane.tsx:110-137`：在编辑器**宿主元素**上监听 DOM
  `compositionstart` / `compositionend`（`:126-127`），只在状态变化时上报（`:119-123`），
  卸载时如实复位（`:133`）。`src/App.tsx:1321` 把它下推成 `setEditorComposing(activeId, composing)`。
- **【读码】** 这个改法成立：`EditorView` 挂载在 `host`（`EditorPane.tsx:69-70` `parent: host`），
  其 `contentDOM`（contenteditable）是 `host` 的后代，DOM `composition` 事件按规范冒泡到 `host`。
- 运行证据：`src/data/library.files.test.ts:925-938`【实测，已跑通】——`composing === true` 时停笔
  4×DELAY 不改名；置回 `false` + 再改一次内容后正常改名。
- **未覆盖**：`src/editor/setup.test.ts` 没有为「合成事务」新增用例（方案 #16 的配套测试未落地）；
  DOM 层是否真能在真机上冒泡到 `host`，本次**静态复核无法确认**（见 §7）。

---

## 2. 收窄范围是否被严格遵守：**是**（含一处口径修正）

### 2.1 入口条件：正则本身 + 「占位名出身」这层状态

- 正则唯一产地：`src/lib/utils.ts:110` `const PLACEHOLDER_NAME = /^(无标题|未命名|untitled)(\s\d+)?$/i;`，
  导出为 `isPlaceholderName()`（`:113-115`），`library.ts` 只 import、不重写（`library.ts:28`）。
- **实现比方案多做了一层**：`placeholderOrigin: Set<Id>`（`library.ts:231`，注释 `:223-230`）。
  原因**成立且必要**【读码 + 实测】：第一次自动改名后文件名就不再是占位名，若按「当前文件名」判定，
  用户第二次改标题时文件名不会跟随——**那正是本次要修的原始缺陷**。方案 §2.2 条件 0 只写了
  `isPlaceholderNote(note)`（按当前文件名），**这一层是实现补上的、且方案没有明说**。
  它是**必要修正**而非偏离：`library.files.test.ts:752-769`（第二次改名）只有在有这一层时才可能通过。
- 入集的三条路径：【读码】扫描 `makeNote`（`:302`，`!options.trashed` 且名字匹配）、
  新建（走 `makeNote`）、改名后 `moveAutoRenameState` 跟着键走（`:1341-1345`）；
  重扫时用 `originBefore` 快照保住（`:867`、`:920`）。用户显式改名时出集（`:1653`）。

### 2.2 认 H1–H6、其余笔记一律不动：**成立**

- `derivePlaceholderTitle`（`src/lib/utils.ts:127-129` + `scanPlaceholderTitle:139-171`）：
  扫 front matter 之后的 body，维护围栏状态，命中 `/^(#{1,6})\s+(.*)$/` 且 `cleanInline` 后非空才返回；
  **普通非空行 `continue`（不返回）**——`:168` 的注释把这条标成「★ 与 `deriveTitle()` 的差别」。
- 【实测】独立跑实现自己的函数（脚本 `.tmp-title/review-verify.mjs`，只读）：

  ```
  工作区: E:\repo\notes
  笔记 .md（不含 .opennote/）: 476
  占位名（isPlaceholderName）: 7
  非占位名: 469
  非占位名里 derivePlaceholderTitle 能算出标题的: 420
  isPlaceholderName 对它们的返回值全部为 false: true
  ```

  **420 篇非占位名笔记的正文里有真标题行**——这就是「入口条件一旦失效」的爆炸半径。
  它们**一篇都不会**进入自动改名：数据层在 `shouldAutoRename` 的第一条（`:1209`）就按
  `placeholderOrigin` 返回 `"非占位名笔记"`，而 `placeholderOrigin` 只在扫描/新建时按
  `isPlaceholderName` 入集；`grep` 确认没有任何别的地方往这个 Set 里加非占位名。
  用例 `library.files.test.ts:649-659` 断言非占位名笔记「文件名一格不动、零 move」。

### 2.3 口径修正：方案说「5 篇」，当前磁盘是 **7 篇**（且 2 篇是方案之后新出现的）

【实测】`Get-ChildItem` + 实现自己的 `isPlaceholderName` 逐篇核对，当前磁盘 7 篇占位名笔记：

| # | 现文件 | 字节 | `derivePlaceholderTitle` | 判定 | 与方案 §3 对照 |
|---|---|---|---|---|---|
| 1 | `AI智能时代/无标题.md` | 0 | `null` | 保持不动 | ✅ 与方案第 1 篇一致 |
| 2 | `无标题.md` | 93 | `null` | 保持不动 | ✅ 与方案第 2 篇一致（全文一行图片） |
| 3 | `项目实战/system_panel/无标题.md` | 1628 | `修改提示词` | 条件 12 跳过 | ✅ 与方案第 3 篇一致（正文 5 处 `./无标题.assets/…`） |
| 4 | `项目实战/恋爱模拟器/无标题 2.md` | 18133 | `恋爱模拟器综合设计` | 改名 | ✅ 与方案第 4 篇一致 |
| 5 | `项目实战/恋爱模拟器/无标题 3.md` | 18130 | `恋爱模拟器设计提示词` | 改名 | ✅ 与方案第 5 篇一致 |
| 6 | `项目实战/system_panel/无标题 2.md` | 200 | `当前存在问题` | **会改名** | ⚠️ **方案 §3 里没有这一篇**（mtime 2026-10-09 20:15） |
| 7 | `项目实战/恋爱模拟器/无标题.md` | 1586 | `null` | 保持不动 | ⚠️ **方案 §3 里没有这一篇**（首行是普通段落、无 `#` 行） |

- 第 6/7 篇都是 **2026-10-09 当天**产生的（第 7 篇 `.opennote/history/项目实战/恋爱模拟器/无标题.md/2026-10-09-20-33-11.170-auto.md` 有快照），
  晚于 t5 报告的盘点时点，属**方案之后的新增**，不是实现的错。
- **第 7 篇是「不把首行当标题」这条规则的活样本**【实测】：它的首行是
  「 嗯，这个我明白，这个就跟dsh预设差不多…」，`derivePlaceholderTitle` 返回 `null` → 保持不动。
  若当初采纳了「首个非空行兜底」，这篇会被改成那句 90 字长句做文件名。
- **建议（不阻断）**：`docs/标题命名规则-改动方案.md` §3 与 `src/data/library.ts:194-195`
  的「481 篇 / 占位名 5 篇 / 其余 476 篇」在**当前磁盘**上是「476 篇 / 占位名 7 篇 / 非占位 469 篇」，
  读代码的人会被误导（见 R4）。

### 2.4 「首行不当标题」与垃圾名排除：**成立**

- 【实测】`.tmp-title/review-verify.mjs` 的反例段：
  ```
  "![3f1c9589….png](.assets/ac44629b-….png)"  =>  null
  " 嗯，这个我明白，这个就跟dsh预设差不多"      =>  null
  "intro\n# 真标题"                            =>  "真标题"
  "```\n# 围栏里的假标题\n```\n## 真标题"       =>  "真标题"
  "---\ntitle: front matter 的标题\n---\n## 正文标题"  =>  "正文标题"
  "# **粗体**"                                  =>  "粗体"
  "# "                                          =>  null
  ""                                            =>  null
  ```
- 单测：`src/lib/utils.test.ts`「★ 只有一行图片的笔记返回 null —— 否则会产出
  `3f1c9589….png.md` 这种垃圾名」；`library.files.test.ts:712-722` 断言端到端空操作。
- 结论：**不产出 `3f1c9589…png.md`**，这一条阻断级风险（R3）被关掉。

---

## 3. 数据安全：迁移工具逐条核验（结论：成立）

复核 `src/data/migrateAssets.ts` / `scripts/migrate-assets.mjs` / `src/data/nodeFsBackend.ts`。

### 3.1 复制 → 校验 → 删源顺序：**成立**

`applyAssetMigration()`（`:593-702`）的阶段划分与报告 §3.1 逐条对齐：

- **阶段 B**（`:613-646`）：逐个源 `readBytes` → **重算 sha256 与扫描时比对**（`:624`，源被外部改过就跳过）
  → 目标已存在且 `sameBytes` → 复用（不写、不改 mtime，`:629-634`）→ 目标存在但内容不同 → 记
  `failedCopies`（**不覆盖**，`:635-639`）→ 否则 `writeBytes`。**源一个字节都不删**。
- **B 的校验**（`:647-659`）：重新读每一个最终路径，**长度 + 逐字节**与源比对，任一失败 → `return`，
  **不进入阶段 C**。
- **阶段 C**（`:662-687`）：改写前**重读正文**，与扫描时的 `notePlan.before` 不一致 → `conflictedNotes`
  跳过（`:670-674`，对应报告 R7 并发编辑）；改写后**逐条反解校验**
  `workspacePathOfRef(rewrite.after, note) !== rewrite.target` → 整篇进 `failedNotes` 并 `return`（`:677-687`）。
- **阶段 D**（`:689-701`）：只有 A~C 全部通过才执行；删源时再次 `exists` 确认，且只删
  `verified` 里的（`:691-696`）；目录交给 `removeIfEmpty`。

**运行证据（dry-run 的默认只读性）**

```
$ node scripts/migrate-assets.mjs --workspace E:\repo\notes --dry-run
附件迁移报告 · DRY-RUN（只读，未写任何文件）
  待迁移文件数 231   按字节去重省下的文件数 23（208 个内容组，16 组有重复）
  需要复制 208   已存在且字节相同 → 复用 0
  待改写引用条数 196（42 篇笔记）
执行（阶段 B→D）
  复制 0   复用（未重写） 0   删除源文件 0   删除空目录 0
```

【实测】`copy=0 / deletedSources=0 / removedDirs=0`；`scripts/migrate-assets.mjs:197`
用 `createNodeFsBackend(root, { canWrite: options.apply })` 造后端，`apply=false` 时 `canWrite:false`
（`src/data/nodeFsBackend.ts` 里写操作当场抛错）。
**跑前跑后 `E:\repo\notes` 全树 935 个文件的 sha256 逐条 `Compare-Object` 完全一致**，
`git status --porcelain` 也一字未变 → dry-run **确实一个字节没写**。

### 3.2 `.opennote/history/` 不碰：**成立**

- `isHistoryPath()`（`:177-179`）：`path === ".opennote/history" || path.startsWith(".opennote/history/")`，
  `HISTORY_DIR = ".opennote/history"`（`src/fs/paths.ts:102`）。
- 三个入口都过它：`isOutOfScope()`（`:187-191`，被 `findLegacyAssetDirs:215`、
  `listNotePaths:235`、`filesIn:255` 调用）、`emptyDirsUnder` 的 `walk`（`:717`）。
- 【实测】dry-run 报「旧附件目录 23 个」，逐个列出：**没有一个是 `.opennote/history/` 下的**；
  真实笔记本 `.opennote/history/` 下有 47 个快照 `.md`，一个都没进 `notePlans`。

### 3.3 绝不递归删 `.opennote/`：**成立**

`removeIfEmpty()`（`:742-750`）四道护栏【读码】：

```ts
if (!dir || dir === SHARED_ASSETS_DIR) return false;   // 共享 .assets/ 永不删
if (dir === ".opennote") return false;                 // 元数据目录本身永不删
if (dir === "assets") return false;                    // 工作区根空 assets/ 留下
const entries = await listEntries(backend, dir);
if (entries.length) return false;                      // 只有 list() 真空才删
await backend.remove(dir).catch(() => undefined);      // ← 没有 recursive
```

- 全文件 `remove(` 只有两处：`:694` 删**单个文件**、`:748` 删**已确认为空**的目录，
  **没有任何 `recursive: true`**（`grep -n "remove(" src/data/migrateAssets.ts` 可核）。
  `.opennote/trash/` 下的孤儿 `.assets/` 目录**允许**被收（用户明确要求一并整理），
  但前提是 `list()` 返回空——不会碰到任何文件。
- 删源只删 `verified` 集合里的（`:691-696`），而 `verified` 只在「字节相同复用」或
  「写下去 + 阶段 B 校验通过」时加入 → **绝不按目录误删**（报告 R1 那次历史事故的护栏）。
- ⚠️ **但「空目录才收」这条在真机 Windows 上是静默失效的**（护栏形状对、落地不生效）：
  见 **R11**（来自 t8 验证报告 §3 D1 的真实文件系统复现，我本次只跑 dry-run、未独立复现）。
  两个方向的偏差都要注意：**不会多删**（安全方向没问题），但**一个都收不掉**（用户诉求未达成）。

### 3.4 去重按字节、绝不互相覆盖：**成立**

- 分组用 `sha256`（`byHash`，`:406-411`），**不是文件名**；真实反例被显式列出：
  `image.png` / `image 2.png` 各一对（回收站 `Agent 产出/无标题.assets/` vs 工作区
  `项目实战/system_panel/无标题.assets/`）【实测，dry-run 报告里逐条打印】。
- 目标已存在且字节相同 → 复用；字节不同 → `resolveTarget` 让位 `-2`（`:439`），
  顺序按源路径字典序（`:434`）→ **幂等**。
- `saveImage`（编辑器粘贴）也改成了同一套语义（`src/data/library.ts:3024-3085`：
  `reuseOrDedupe:3066` + `dedupePath:3078`），与剪藏落点 `allocateAssetPath` 一致。
  **既有断言被改动 1 条**：`src/editor/media.test.ts` 把去重形态从 ` 2`（带空格 → 必须角括号）
  改成 `-2`（无空格），这是**方案 #23 / 报告 §1.4 明确要求**的，改得对（§6 有逐条说明）。

---

## 4. 五篇真实笔记的预期结果 vs 实现：**一致**（当前磁盘多出 2 篇，见 §2.3）

| 方案预期 | 实现表现 | 结论 |
|---|---|---|
| 第 1 篇 空文件 → 保持不动 | `derivePlaceholderTitle("") === null`；`library.files.test.ts:1013-1021` | ✅ |
| 第 2 篇 只有一行图片 → 保持不动 | `null`；`library.files.test.ts:712-722`、`:1022-1031` | ✅ |
| 第 3 篇 含旧布局引用 → 条件 12 跳过、等迁移 | `hasLegacyAssetRef` 命中 → `"正文里有按旧文件名写死的附件引用"`；`library.files.test.ts:940-951` 用真实正文形态当夹具 | ✅ |
| 第 4/5 篇 h2 → 改名 | `恋爱模拟器综合设计.md` / `恋爱模拟器设计提示词.md`；`library.files.test.ts:1042-1055` | ✅ |
| 非占位笔记被波及 0 | 见 §2.2（420 篇有真标题、一篇不触发） | ✅ |
| 撞名 0 / 洗名 0 | `sanitizeName` + `resolveAvailablePath` 走既有路径；撞名用例 `library.files.test.ts:953-963` | ✅ |

---

## 5. 逐条对照方案的 27 条改动清单

| # | 文件 | 状态 | 证据 / 说明 |
|---|---|---|---|
| 1 | `src/lib/utils.ts` 新增 `derivePlaceholderTitle` | **已实现** | `src/lib/utils.ts:128-130` + `scanPlaceholderTitle:142-171`；配套 11 条单测在 `src/lib/utils.test.ts` |
| 2 | `src/lib/utils.ts` 新增 `isPlaceholderName` | **已实现** | `src/lib/utils.ts:110-115`；单测「isPlaceholderName（自动改名的唯一入口条件）」3 条 |
| 3 | `src/data/types.ts` 新增 `autoTitleFromPlaceholder` | **未实现** | `grep autoTitleFromPlaceholder src` 无命中；`UiSettings`（`src/data/types.ts:182` 旁）只有 `lockedNotes` 等。→ **R2** |
| 4 | `src/data/library.ts` `WorkspaceMeta` 新增 `titlePinnedAt` | **已实现** | `src/data/library.ts:114-129`（含语义边界注释） |
| 5 | `readTitlePinnedAt` + 接进 `readMeta` | **已实现** | `src/data/library.ts:143-151`、`:408`、`:416` |
| 6 | 模块级 5 张表 + 4 个常量 | **已实现（1 处口径偏离）** | `src/data/library.ts:198-242`：`autoRenameTimers` / `autoRenameInFlight` / `explicitRenamedAt` / `lastAutoRenameAt` / `editorCursorLine` / `editorComposing` / `placeholderOrigin`；常量 `:198-204`。**没有** `importQuietUntil`，导入静默期改由条件 7 的 `createdAt` 承担 → R6 |
| 7 | `renameNote`：①写落盘名 ②`titlePinnedAt` ③`explicitRenamedAt` ④`clearTimeout` | **②③④ 已实现；① 未实现** | `src/data/library.ts:1649-1655`（②③④）、`:1671-1679`（`pinTitle`）。①仍是 `titleOverride: clean`（请求名）→ **R1** |
| 8 | 新增 `autoRenameFromPlaceholder` | **已实现** | `src/data/library.ts:1396-1466`（形状与 §2.6 的 13 步逐条对齐） |
| 9 | 新增纯函数 `shouldAutoRename` | **已实现** | `src/data/library.ts:1205-1243`；返回「被哪条拦下」的原因串 |
| 10 | `updateNoteContent` 里插 `scheduleAutoRename` | **已实现** | `src/data/library.ts:1526`，正好在 `:1521` `persistNoteSoon` 与 `:1527` `maybeSnapshot` 之间（方案指定区间） |
| 11 | `flushMeta` / `moveTitleOverride` / `dropTitleOverrides` / `remapIds` 处理 `titlePinnedAt` | **已实现** | `dropTitleOverrides:1624-1640` 同时清两张表；`remapIds:2415-2418` 同处换键。`flushMeta` 随整个 `meta` 落盘（无需单独改） |
| 12 | 各入口清/取消计时器 + 打静默期戳 | **大部分实现** | `resetWorkspaceTransients:706-722`（清空全部表）；`cancelAutoRename` 调用点 `:1420`（自动改名自己）/`:1652`（`renameNote`）/`:1735`（`moveNote`）/`:1815`（`trashNote`）/`:1857`（`restoreNote`）；`dropAutoRenameState` 调用点 `:2014`（`purgeNote`）/`:2034`（`emptyTrash`）；`deleteFolder`/`moveFolder` 经 `remapIds`。**`duplicateNote` 未单独打 60s 戳**（靠条件 0 双保险 + 条件 7） |
| 13 | `setEditorCursorLine` / `setEditorComposing` | **已实现** | `src/data/library.ts:1286-1297` |
| 14 | `src/App.tsx` 新增 `cursorRef` | **已实现但不被读取** | `src/App.tsx:130`（写：`:1316`）；`grep cursorRef` 无第三处 → **R3** |
| 15 | `onCursor` 同时写 ref/state + 下推行号 | **已实现** | `src/App.tsx:1314-1320`（`setEditorCursorLine(activeId, value.line)`） |
| 16 | `src/editor/setup.ts` 传 `composing` | **未按原样实现（等价替代）** | 改在 `src/components/EditorPane.tsx:110-137`（DOM `compositionstart/end` 冒泡）；`src/editor/setup.ts` **一字未动**。配套测试未加 → 见 §7 与 R7 |
| 17 | `EditorPane` 透传 `composing` | **已实现** | `src/components/EditorPane.tsx:36-46`（prop）、`:126-127`（监听） |
| 18 | `App.tsx` 透传 `setEditorComposing` | **已实现** | `src/App.tsx:1321` |
| 19 | `Sidebar.tsx:893` 改文案 | **未实现** | `src/components/Sidebar.tsx` 不在改动集内。文案仍说「重命名只改显示名」，与新规则矛盾 → **R2** |
| 20 | `AppDialogs.tsx` 加开关行 | **未实现** | 同上 → **R2** |
| 21 | `openWikiLink` 的 H1 用 `sanitizeName` | **未实现（方案标注「与本次功能独立」）** | 既有缺陷仍在，不属本次范围，记录待办 |
| 22 | 新增 `src/data/migrateAssets.ts` | **已实现** | `src/data/migrateAssets.ts`（758 行）；25 条单测 `src/data/migrateAssets.test.ts` 全绿 |
| 23 | `saveImage` 走 `allocateAssetPath` 语义 | **已实现** | `src/data/library.ts:3024-3085`（`reuseOrDedupe:3066` + `dedupePath:3078`）；`src/editor/media.test.ts` 新增 2 条 + 改 1 条旧断言 |
| 24 | 改名时搬 `<旧名>.assets/` | **未实现「搬」，改由条件 12 + 迁移器兜住** | 方案原文给了「或」的分支：「或先由迁移器消灭旧布局，再靠条件 12 兜底」——实现选了后者。**成立，但见 R8（顺序只是文档约定）** |
| 25 | `receive.ts` 顺手改 `import-index.json` 的 `path` | **未实现** | `src/lib/clip/receive.ts` 不在改动集内（方案自己也标「不再是本次改名的直接后果」） |
| 26 | 清 11 处旧注释 | **部分实现** | `saveImage` 头注释（`src/data/library.ts:3010-3023`）已重写；`src/editor/media.ts` / `src/editor/settings.ts` / `src/lib/export.ts` / `src/data/inbox.ts` / `src/data/types.ts` 等**仍在描述旧行为**（t5 §2 清单） |
| 27 | `docs/import/00-…md:596` 补改判记录 | **未实现** | 该文件不在改动集内 |

**汇总（按 27 条编号逐条判，其中 #7 的 ① 与 ②③④ 分开记）**：
**13 条已实现**、**5 条等价替代/部分实现**（6、12、16、24、26）、**9 条未实现**
（3、7①、14 的读取、19、20、21、25、27）。其中 **7① 与 3/19/20 是本次复核判 needs_revision 的直接依据**；
21/25/27 与 26 的剩余部分**不在 t7/t6 的 in-scope 文件里**，属方案里明确标注为「独立/顺手」的条目，
本次**不作为失败项**，但应在方案里标注为「未做」。
（另：迁移器的「收空目录」这一条按方案 §3.7 属于 #22 的落地内容，形状写对了但真机失效 → **R11**。）

---

## 6. t2 盘出的既有断言：**无一条被反转**（1 条被改动，理由成立）

【实测】`git diff --numstat` + 逐文件 diff：

| 文件 | 增 | 删 | 说明 |
|---|---|---|---|
| `src/data/library.files.test.ts` | 528 | 0 | **纯新增**（30 → 61 条用例），既有 30 条一字未动 |
| `src/lib/utils.test.ts` | 104 | 0 | **纯新增**（`deriveTitle` 的既有语义断言保持不动） |
| `src/editor/media.test.ts` | 29 | 4 | 唯一被改动的既有断言 |
| `src/data/library.ts` | 564 | 13 | 实现 |
| `src/lib/utils.ts` | 89 | 4 | 实现 |
| `src/App.tsx` / `EditorPane.tsx` / `src/fs/paths.ts` | 19/34/21 | 1/0/0 | 实现 |
| `src/lib/clip/landing.ts` / `src/data/assets.ts` | 33/6 | 91/21 | t6 的「抽纯运算到 `assetPaths.ts`/`workspaceRef.ts`」重构 |

**唯一被改动的断言**：`src/editor/media.test.ts` 里那条「同一内容重复粘贴 → `X 2.png`（带空格 → 角括号）」，
改成「不同内容同名 → `X-2.png`（无空格）」。
**为什么合理**：它断言的是**方案 #23 / 报告 §1.4 明确要求改掉的行为**——
`saveImage` 从「按文件名清单去重」改成「按字节去重、去重形态统一 `-2`」。
原断言里的 `X 2.png` 正是报告 §1.4 认定为「与用户『uuid 命名 = 复用』的决定直接冲突」的那一态。
同一次改动还**新增**了 2 条用例覆盖新语义（同内容复用同一路径 / 不同内容让位 `-2`），
不是「把断言改成能过」。方案 §7.1 表格里列的 26 条（含 `deriveTitle` 语义、`safeFileName`、
`sanitizeName`、`paths.gate`、`clip/receive`）逐条**保持绿**。

【实测】`npx vitest run` → **63 文件通过 / 1 skipped，1039 passed / 2 skipped**；
`npx tsc --noEmit` → **exit 0**。

---

## 7. 上线顺序约束（附件迁移先于自动改名）：**只在文档/注释里表达，代码里没有机制**

- **文档里表达了**：【读码】
  - `docs/标题命名规则-改动方案.md:303`「阶段四（附件迁移）必须先于阶段二的 `autoRenameFromPlaceholder` 上线」、
    `:341`「阶段四：附件独立交付，**必须先于 #8 上线**」、`:399-410`（§6.5 硬约束，含「为什么 ① 必须在 ② 之前」）。
  - `docs/asset-lifecycle-and-migration.md` §3.5 明确「迁移必须抢在用户清空回收站之前」。
  - 代码注释里也点了名：`src/data/library.ts:1232-1234`（条件 12 的注释引用本机第 3 篇）、
    `src/data/library.files.test.ts:1032`（用例名「本次跳过（等附件迁移后才会改）」）。
- **代码里没有机制**：`shouldAutoRename` 的条件 12 是**逐篇运行时**护栏（正文含旧名 `.assets/` 就跳过），
  它**不检查迁移是否已经跑过**。若自动改名先上线，第 3 篇会被跳过（不裂图）——**这一层是安全的**；
  但「迁移必须先跑」这件事**没有任何强制或提示**：迁移器目前**只有命令行入口**
  （`scripts/migrate-assets.mjs`），应用内没有引导/体检入口，用户不会知道要跑它。
  方案 §6.2/§6.5 ③ 明确要求「在应用内、逐条、可撤销」「只读体检 + 逐条确认」——**未实现**（→ R8）。

---

## 8. 我独立复核了什么 / 什么无法从静态审查确认

### 8.1 独立复核过（可复现）

| 项 | 怎么做的 | 结果 |
|---|---|---|
| 全量测试与类型 | `npx vitest run`、`npx tsc --noEmit` | 1039 passed / 2 skipped；tsc exit 0 |
| 三个阻断约束的代码证据 | 穷举 `setTitleOverride`/`pinTitle`/`titleOverride:`/`titlePinnedAt` 的全部命中行 | 自动改名路径只写 `null`，不写两张表 |
| 入口正则的误伤面 | 写 `.tmp-title/review-verify.mjs`，**import 实现自己的** `isPlaceholderName`/`derivePlaceholderTitle` 跑真实笔记本 476 篇 | 469 篇非占位（420 篇有真标题）全部 `false`；7 篇占位逐篇判定与方案一致 |
| 垃圾名排除 | 同上脚本 + `utils.test.ts` 用例 | 一行图片 → `null`，不产 `3f1c9589….png.md` |
| 迁移 dry-run 的真实只读性 | 跑前/跑后 `E:\repo\notes` 全树 935 个文件 sha256 `Compare-Object` + `git status` | 完全一致；报告里 `复制 0 / 删源 0 / 删目录 0` |
| `.opennote/history/` 排除 | 读 `isHistoryPath`/`isOutOfScope` + dry-run 的 23 个目录清单 | 47 个快照一篇没进 `notePlans` |
| 绝不递归删 `.opennote/` | `grep remove(` 全部命中 + `removeIfEmpty` 四道护栏 | 无任何 `recursive: true` |
| 既有断言是否被反转 | `git diff --numstat` + 逐文件 diff（`library.files.test.ts` 528/0、`utils.test.ts` 104/0） | 纯新增；唯一改动是方案要求的 `-2` 形态 |
| 真实笔记本现状 | `Get-ChildItem` + `Get-Content` + `.opennote/state.json` 解析 | `titleOverrides` 仅 1 条、无 `titlePinnedAt`；占位名 7 篇（非方案里的 5 篇） |

### 8.2 **无法**从静态审查确认（如实列出，不假装确认过）

1. **真机 Electron 文件监听与 5 秒计时器是否成环**：桌面端 `workspace-changed` 是 500ms 去抖 +
   重扫，而自动改名会 `target.move` 触发新一轮监听。实现有**两道**防抖（条件 13 同篇 30s 最小间隔、
   `autoRenameInFlight`），但「重扫 → `rescanWorkspace` → `originBefore` 保住 `placeholderOrigin` →
   会不会再次排定时器」这条闭环**只在单测（`MemoryBackend`）里跑过**，**真机未验证**。
   需要的验证：桌面端打日志数 `workspace-changed` 触发次数、看是否出现连续两轮改名。
2. **IME composition 事件在真机上是否真能冒泡到 `host`**：`EditorPane.tsx:126-127` 把监听挂在
   `EditorView` 的**父元素**上，靠 DOM 冒泡。规范上成立（`contentDOM` 是 `host` 后代），
   但**没有真机中文输入法验证**，也**没有 DOM 层单测**（`src/editor/setup.test.ts` 未新增用例）。
   方案 #16 原本要求的 `input.type.compose` 事务判定也**没做**——两条路都没有运行证据。
3. **三后端（FSA / OPFS / Capacitor）上的 `move` 语义**：迁移器与自动改名都只依赖
   `FileSystemBackend` 接口，单测用的是 `MemoryBackend`；真机行为未验证（报告 R12 / t1 §9.2 V6）。
4. **快照恢复（`updateNoteContent(..., {immediate:true})`）与自动改名的交互**：方案 §2.4 标为
   【待验证】/ R10。实现把它交给了 `updateNoteContent` 这一个汇聚点（`:1526`），逻辑上会被覆盖，
   但**没有专门用例**，也未在真机上验证「恢复快照 → 5 秒后改名」是否符合预期。
5. **30 秒节流在真实使用中的体感**：单测用 `resetAutoRenameHistoryForTests()` 显式跳过 30 秒；
   真实语义下「同一篇笔记两次自动改名至少隔 30 秒」意味着用户在 30 秒内连改两次标题时，
   文件名**只会跟第一次**。这是设计选择（方案条件 13），但**没有任何用例或文档向用户解释这一点**。
6. **`cursorRef` 的最终归宿**：它现在既不被读取也不被删除。我确认了「不被读取」，
   但**无法确认**这是「实现换路后的残留」还是「后续接线的占位」——需要实现者说明。

---

## 9. Findings

| id | severity | file:line | problem | requiredFix |
|---|---|---|---|---|
| **R1** | high | `src/data/library.ts:1646,1664,1671-1675` | 方案 §2.6「必须同时改 `renameNote` 的两处」第 1 处**未实现**：`titleOverride` 仍写**请求名** `clean`，不是**落盘名** `stripExtension(baseName(nextPath))`。撞名时磁盘是 `系统设计 2.md`、侧栏显示名是 `系统设计`，永久静默分叉（方案 §7.1 表格点名要修、并指定新增断言「撞名后 `title === "系统设计 2"`」）。`grep "落盘名\|系统设计 2" src/data/*.test.ts` **无任何命中**，该断言不存在。 | 在 `renameNote()` 成功分支里把写进 `Note.titleOverride` 与 `setTitleOverride()` 的值从 `clean` 改成 `stripExtension(baseName(nextPath))`；并新增方案 §7.1 指定的断言（同目录已有 `系统设计.md` 时，重命名后 `title === "系统设计 2"` 且 `titleOverride === "系统设计 2"`）。 |
| **R2** | high | `src/data/types.ts`（`UiSettings`，`:118-183` 区间）、`src/components/AppDialogs.tsx`、`src/components/Sidebar.tsx:893` | 方案 #20 的 `autoTitleFromPlaceholder` 开关**完全不存在**（`grep autoTitleFromPlaceholder src` 无命中）：自动改名默认开启且**用户无法关闭**。方案 #19 的对话框文案也未改——`Sidebar.tsx:893` 仍是「重命名只改显示名；正文里的一级标题不会被改写。」，而新规则下重命名**会改文件名**（方案 §4.1 已论证这句话一直在撒谎）。用户读完文案会得到错误的心智模型。 | ① `UiSettings` 新增 `autoTitleFromPlaceholder: boolean`（默认 `true`，照 `lockedNotes` 的兜底写法）+ `AppDialogs.tsx` 的「文件」段加开关行 + `shouldAutoRename` 里接上这个开关；② 改 `Sidebar.tsx:893` 的文案（方案 §4.2 推荐第 1 条 + 第 3 条范围说明）。若队长裁定本次不做开关，则必须在方案与代码注释里**显式记为「未做」**，不能让读者以为做了。 |
| **R3** | low | `src/App.tsx:130,1316` | 复核验收里逐字要求的「`cursorRef` 真的存在且**被定时器读取**」**不成立**：`grep -n cursorRef src` 只有声明（`:130`）与写入（`:1316`）两处，**没有任何读取**。定时器实际读的是数据层的 `editorCursorLine`（`src/data/library.ts:1270`），该机制**正确且比 `cursorRef` 更可靠**（`autoRenameContext` 每次现取）。因此这是死代码 + 验收字面项不成立，不是功能缺陷。 | 二选一：① 删掉 `cursorRef`（连同 `:1316` 的写入），并在 `App.tsx:1314-1320` 注释里写明「行号经 `setEditorCursorLine` 下推，数据层现取，因此不需要 ref」；② 若确实打算用 ref，就让它被真实读取。无论选哪个，都在 `docs/implementation-review.md` 之外的实现注释里把这个取舍写清楚。 |
| **R4** | low | `src/data/library.ts:194-195`、`:1206`；`src/data/library.files.test.ts:1012`；`docs/标题命名规则-改动方案.md` §3/§6.1 | 注释里的笔记本盘点数字**与当前磁盘不符**：代码写「481 篇笔记，占位名 5 篇，其余 476 篇」，实测是「476 篇 `.md`（不含 `.opennote/`），占位名 **7** 篇，非占位 469 篇」。方案 §3 的 5 篇表里也缺了 `项目实战/system_panel/无标题 2.md`（mtime 2026-10-09 20:15，正文 `## 当前存在问题`，**会被改名**）与 `项目实战/恋爱模拟器/无标题.md`（首行是普通段落、**不会**改名）。读代码的人会得到错误的收益/风险估计。 | 把 `library.ts` 的两处数字改成「当前磁盘：476 篇、占位名 7 篇、非占位 469 篇（其中 420 篇正文有真标题行）」，或改成不写死数字的表述；在方案 §3 补一行「2026-10-09 之后新增的第 6/7 篇」及其判定。 |
| **R5** | medium | `src/data/library.ts:302`、`:1341-1345`、`:1850-1880` | **回收站往返会丢「占位名出身」**：`makeNote` 只给**非回收站**笔记入集（`:302` 的 `!options.trashed`），而 `trashNote()` 不把 id 从 `placeholderOrigin` 移除、`restoreNote()` 也不把它搬回工作区路径（`restoreNote` 的 `cancelAutoRename(id)` 只清定时器，`:1857`）。用户把一篇占位名笔记丢进回收站再还原后，它名字仍是 `无标题.md`，但**再也不会被自动改名**（`shouldAutoRename` 条件 0 直接返回 `"非占位名笔记"`）——这与本次要修的原始缺陷是同一现象。 | `restoreNote()` 在 `remapIds` 之前/之后把新路径补进 `placeholderOrigin`（判据：还原后的 stem 匹配 `isPlaceholderName`）；或让 `moveAutoRenameState` 在「新 id 的 stem 是占位名」时无条件入集。补一条用例：`createNote` → `trashNote` → `restoreNote` → 写标题 → 停笔后改名。 |
| **R6** | low | `src/data/library.ts:1222`（`NEW_NOTE_QUIET_MS`）、方案 #6 的常量表 | 方案 #6 要求 5 张表（含 `importQuietUntil: Map<Id, number>`）与 4 个常量（含 `IMPORT_QUIET_MS = 60_000`），实现**没有** `importQuietUntil`/`IMPORT_QUIET_MS`：导入/剪藏的静默期由条件 7（`createdAt` 10s）承担。**效果方向正确**（导入的笔记 `createdAt` 就是刚刚，会被 10s 拦住），但窗口是 10s 不是方案说的 60s，且**没有独立用例**覆盖「批量导入的 md 在静默期内不被改名」（方案 N9）。 | 要么按方案补 `importQuietUntil`（导入/剪藏落盘时打 60s 戳），要么在方案与代码注释里把口径改成「导入/剪藏复用条件 7 的 `createdAt` 10s」并补 N9 用例。 |
| **R7** | low | `src/components/EditorPane.tsx:110-137`、`src/editor/setup.ts:168-179` | 方案 #16 指定在 `src/editor/setup.ts` 的 `updateListener` 里用 `update.transactions.some(t => t.isUserEvent("input.type.compose"))` 判定合成；实现改成在编辑器宿主元素上监听 DOM `compositionstart/end`，`src/editor/setup.ts` **一字未动**。DOM 冒泡在规范上成立（`contentDOM` 是 `host` 后代），但**没有 DOM 层单测**（方案 #16 要求 `src/editor/setup.test.ts` 加一条），也**没有真机中文输入法验证**。 | 在 `src/components/EditorPane.tsx`（或新增一个纯函数）为「宿主上的 composition 事件 → `onComposing(true/false)`」补一条 DOM 层用例（可用 `happy-dom`/`jsdom` 直接 `dispatchEvent`）；并在真机上用中文输入法实测一次，把读数记进文档。 |
| **R8** | medium | `scripts/migrate-assets.mjs`（唯一入口）、`src/data/library.ts:1232-1234`、方案 §6.2/§6.5 | 「附件迁移先于自动改名」只在**文档与注释**里表达，代码里**没有任何强制或提示**；迁移器目前**只有命令行入口**，应用内没有体检/引导入口，用户不会知道要跑它。条件 12 能保证「不裂图」（第 3 篇会被跳过），但「必须先跑迁移」这件事对用户不可见。方案 §6.2 要求的「在应用内、只读体检 + 逐条确认、可撤销」未实现。 | 至少在应用内给一条**可点提示**（状态栏/命令面板）：「检测到 N 处旧布局附件引用，请先运行附件迁移」——即方案 §6.2 的只读体检入口；或在 `shouldAutoRename` 的跳过原因上做用户可见提示（`AutoRenameOutcome.reason` 已经有 `"正文里有按旧文件名写死的附件引用"` 这个现成读数，接到界面即可）。 |
| **R9** | low | `docs/标题命名规则-改动方案.md`（未更新的 27 条状态）、`src/data/library.ts:194-195` | 方案是**施工前**写的，实现后没有回填「哪条做了、哪条没做」。§5 的 27 条里有 9 条未实现（#3、#7①、#14 的读取、#19、#20、#21、#25、#27），其中 #21/#25/#27 与 #26 的一部分**不在 t7/t6 的 in-scope 文件里**，容易被后来者误读成「都做完了」。 | 在方案 §5 的表格里逐条加一列「实施状态」（已实现/等价替代/未做+原因），或在本文档 §5 基础上把结论回填进方案。 |
| **R10** | low | `src/data/library.ts:1444-1449`、`:1286-1297` | `autoRenameFromPlaceholder()` 里那段「防御性清掉 `nextPath` 上的 stale `titlePinnedAt`」直接改 `meta` 但不 `flushMeta`/`scheduleMeta`（该分支自己没调），且它**删的是 `meta.titlePinnedAt`** —— 这是自动改名路径上唯一一处会改「用户手定的名字」那张表的地方。方案 §2.6 第 12 步把它列为「防御性」，但**没有用例**覆盖「pin 存在时自动改名会把它清掉」这条分支（正常路径下永不触发，因此也永不被测到）。 | 为这条防御分支补一条直接调 `autoRenameFromPlaceholder()` 的用例（先手工 `pinTitle` 再触发），或把这段改成「只记日志不改 `meta`」，避免一条永不被测的分支留在关键路径上。 |
| **R11** | high | `src/data/migrateAssets.ts:748`（经 `src/data/nodeFsBackend.ts:81`） | **Windows 上「删空目录」完全不生效**（t8 验证报告 §3 D1 的真实文件系统复现，我未独立复现）：`backend.remove(dir)` 不带 `recursive` → `nodeFsBackend` 调 `fs.rm(dir, {recursive:false})`，Node 22.19 / win32 对目录**一律抛 `ERR_FS_EISDIR`**（空目录也抛），异常被 `:748` 的 `.catch(() => undefined)` 静默吞掉，`removeIfEmpty` 随后 `return !(await backend.exists(dir))` → `false` → 目录进 `keptDirs`，**23 个旧附件目录一个都收不掉**。`src/data/migrateAssets.test.ts` 用的内存后端把 `remove()` 实现成「能删空目录」，所以在 CI 里测绿、在真机上失效。仓库自己的两个夹具早已记下这条 Node 语义：`src/data/library.p2.test.ts:214`、`src/data/library.regression.test.ts:182`（注释「rm(dir, {recursive: false}) always fails, empty or not」）。 | 给 `FileSystemBackend.remove()` 加一条「删空目录」的明确语义，或让 `removeIfEmpty` 对目录改走 `remove(dir, { recursive: true })` 的**安全变体**（只在 `list()` 确认为空之后调用；`recursive: true` 只作用于已确认为空的目录，因此仍不可能删到文件）。无论选哪条，都要在 `migrateAssets.test.ts` 里加一条**走真实 `nodeFsBackend`** 的用例（现有内存后端测不出这个缺陷）。 |

**不判失败的方案条目**（明确移出本次 in-scope）：#21 `openWikiLink` 的 H1 净化、
#25 `import-index.json` 路径、#26 剩余注释、#27 文档改判记录——方案自己就标注为「独立/顺手」，
且对应文件不在 t7/t6 的 in-scope 列表里。**但请在方案里记为「未做」**（见 R9）。

---

## 10. 复核结论摘要（给队长）

- **可以放心的**：三个阻断级约束**真的落实**（尤其「自动改名不写 `titleOverride`」，有代码穷举 + 运行双证）；
  收窄范围严格（420 篇有真标题的非占位笔记一篇不触发）；**「不丢图」这条数据安全底线成立**
  （阶段 B 先复制 + 逐字节校验，源到阶段 D 才可能被删；dry-run 全树 sha256 一致）；
  5 篇真实笔记的预期结果与实现一致；既有断言无一条被反转。
- **必须修的**：R1（`renameNote` 写落盘名——方案点名要修且指定了断言）、R2（开关缺失 + 文案自相矛盾）、
  **R11（Windows 上删空目录静默失效，23 个旧附件目录一个都收不掉 —— 来自 t8 的真实文件系统复现）**。
- **建议修的**：R5（回收站往返丢「占位名出身」）、R8（迁移顺序只有文档约定、没有应用内入口）。
- **与 t8 验证报告的关系**：`docs/implementation-verification.md` 判 t6 的「空目录才收」判据失败（D1），
  与我本报告的 R11 是**同一条**；它没有覆盖 R1/R2/R5/R8（那几条在 t7 的实现与方案对照里）。
  两份报告在「核心安全性质全部成立」这一点上**结论一致**，没有冲突。
- **如实告知的**：§8.2 的 6 项无法从静态审查确认，尤其**真机 Electron 文件监听与 5 秒计时器是否成环**
  与**IME composition 是否真能冒泡到宿主元素**——这两条都缺真机读数，请勿在报告里当成已验证。
  **R11 我也没有独立复现**（我只跑了 dry-run），它的证据在 t8 报告里。

> 复核过程中的只读辅助脚本落在 `.tmp-title/review-verify.mjs`（不进 CI，可随时删除）。
> `E:\repo\notes` 全程未被写入（跑前跑后 935 个文件的 sha256 逐条一致，`git status` 未变）。

---

## 11. R1–R11 的回修记录（repair round 2 · t14 · app-eng · 2026-10-09）

> 本节由**被复核方**（t7 的实现者）在回修之后回填，**不是**复核结论。复核结论仍以上面 §9/§10 为准；
> 下一轮复核（t15）请按本节的「证据」列**独立复验**，不要采信自述。
> 回修严格限于 t14 的 in-scope 文件；队长另裁定 **R11 归 t11（migration-eng）**，本轮**未碰**
> `src/data/nodeFsBackend.ts` 与 `src/data/migrateAssets.ts`。

| finding | 本轮处置 | 证据（可复现） |
|---|---|---|
| **R1**（high）写请求名而非落盘名 | ✅ **已修** | `renameNote()` 写 `stripExtension(baseName(nextPath))`；用例「同目录已有「系统设计.md」时，重命名后 title 与 titleOverride 都等于「系统设计 2」」（含 `state.json` 与重扫两道复验） |
| **R2**（high）开关缺失 + 文案自相矛盾 | ✅ **已修** | `UiSettings.autoTitleFromPlaceholder`（`DEFAULT_UI` 为 `true`）+ `shouldAutoRename` 条件 −1 + `AppDialogs.tsx`「文件」段开关行 + `Sidebar.tsx` 文案重写；3 条用例（默认值 / 纯函数 / 关掉后不改名再打开又跟随）。**注**：`src/data/ui.ts` 里 lockedNotes 式的显式守卫未加（该文件不在 in-scope），已记为待补（方案 §5 #3） |
| **R3**（low）`cursorRef` 只写不读 | ✅ **已处置（删掉）** | 队长裁定「判据写错」；删 `cursorRef` + 其写入，在 `App.tsx` 的 `onCursor` 旁写明「行号经 `setEditorCursorLine` 下推，数据层现取，因此不需要 ref」 |
| **R4**（low）注释里的盘点数字与磁盘不符 | ✅ **已修** | `library.ts` 两处数字全部去掉（只留机制表述 + 指向方案 §3 的读数）；方案 §3 补 §3.2 的**第 6/7 篇**逐篇判定 + 当前读数表（483/7/476/420）+ 只读盘点脚本 `.tmp-title/count-readings.mjs` |
| **R5**（medium）回收站往返丢「占位名出身」 | ✅ **已修** | 三处：`trashNote` 把标记搬进回收站路径、`restoreNote` 从回收站路径/原路径搬到最终路径、`moveAutoRenameState` 在「新 stem 是占位名」时无条件入集。用例 2 条（`createNote→trash→restore→写标题→改名`；**已被自动改名过的笔记**往返后仍跟随）。**实测**：临时注掉修复后第 2 条用例变红（`等待超时；磁盘上是 ["修改提示词.md"]`），恢复后绿 —— 证明它是判别性用例 |
| **R6**（low）`importQuietUntil` 缺失 | ⚠️ **选了口径统一（不补表）** | 方案 §2.5 末段写明「导入/剪藏复用条件 7 的 `createdAt` 10s」+ 代价与原因；`library.ts` 的 `NEW_NOTE_QUIET_MS` 注释同口径；N9 已补（纯函数边界 + 窗口过去后跟随的端到端）。补表需动 `src/lib/import.ts` / `src/lib/clip/`（不在 in-scope） |
| **R7**（low）DOM 层用例 + 真机 IME 读数 | ⚠️ **DOM 用例已补；真机实测未做** | 判定形态改为宿主元素上的 `compositionstart/end`（`attachCompositionReporter()`，`EditorPane.tsx`；`src/editor/setup.ts` 一字未动）；DOM 层用例 2 条（Node 自带 `EventTarget`：只在变化时上报 + 退订补报 `false`；端到端 `compositionstart → 不改名`）。**真机中文输入法实测：未做**（无 GUI/输入法环境），已在方案 §2.4 显式记为未做 + 给出人工复现步骤 |
| **R8**（medium）迁移顺序没有代码机制/应用内入口 | ✅ **已裁定：不做代码机制**（队长） | 理由写在方案 §6.2（流程保证顺序 + 条件 12 已兜住「不裂图」这条底线 + 本机只命中 1 篇 + 迁移器 dry-run 已逐条列出）；残留 UX 缺口（用户看不到为何不改名）与最便宜的补法（~15 行 `notify`）一并如实记录 |
| **R9**（low）方案未回填实施状态 | ✅ **已修** | 方案 §5 的 4 张表**逐条**加了「实施状态」列（已实现 / 等价替代 / 未做 + 原因）；未做的 9 条（#3 的一半、#6、#12 的一半、#14、#16 的形态、#21、#25、#26 的一部分、#27）逐条写明是「in-scope 之外」还是「队长裁定不作废/不做」 |
| **R10**（low）防御分支无用例 | ✅ **已修** | 保留该分支（并注释说明「`remapIds` 已 `scheduleMeta(400)`，不必再排一次」），补用例：手工往 `state.json` 塞一个 pin → 触发自动改名 → 断言 `titlePinnedAt` 被清掉、且 `titleOverrides` 仍为 `undefined` |
| **R11**（high）Windows 删空目录静默失效 | ✅ **不归本轮（t11 已修，只读核验）** | `nodeFsBackend.remove()` 对目录走 `rmdir` 分支（等价替代「给 `FileSystemBackend.remove()` 定义明确的删空目录语义」）；`src/data/migrateAssets.test.ts` 的「真实 node 后端：remove 只删空目录（D1 回归）」一组用例在跑：**30/30 通过**（本轮只读跑，未改这两个文件） |

### 11.1 本轮验证读数

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npx vitest run` | **63 文件通过 / 1 跳过（64）**；**1056 通过 / 2 跳过（1058）** |

**基线口径说明（避免下一轮把增量算错）**：t7 交付时的读数是 **1039 通过 / 2 跳过**。
本轮增量 **+17**，由两部分组成：

- **+12**：本轮的库侧用例（`src/data/library.files.test.ts` 61 → 73）；
- **+5**：**t11 的**（`src/data/migrateAssets.test.ts` 25 → 30，D1 回修带来的真实后端用例），
  与本轮无关，但会体现在同一个总数里。

### 11.2 本轮**没有**独立复验的两件事（如实列出，别当成已验证）

1. **真机中文输入法**（见 R7）：只有 DOM 层用例，没有真实 IME 读数。
2. **真机 Electron 文件监听与 5 秒计时器是否成环**（§8.2 的旧账）：本轮同样没跑真机；
   条件 13 的 30 秒节流有用例，但那是单测里的读数。

`E:\repo\notes` 在本轮**未被写入**：所有用例走 `MemoryBackend`；唯一的只读盘点脚本是
`.tmp-title/count-readings.mjs`（只 `readdir` / `readFile` / `stat`，不写）。
