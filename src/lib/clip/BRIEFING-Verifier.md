# C1 · L2 接收端（`opennote.import/v1`）最终简报 —— 给 Verifier

> 交付物：共享任务 `task-2`（L2 应用内接收端）。写入范围：`src/lib/clip/**`、`src/data/importLog.ts(+.test.ts)`、
> `src/components/ConflictDialog.tsx`。**未碰**任何热点文件（`library.ts` / `inbox.ts` / `App.tsx` / `electron/**` / `styles/**` / `extension/**` / `docs/**`）。
> 本简报按你的要求写：**实现了什么 / 没实现什么 / 怎么自证 / 已知限制**。

---

## 1. 我实现了什么

| 契约位置 | 实现 | 文件 |
|---|---|---|
| §2 信封校验（spec/importId/body 与 bodyFile 互斥、8 MiB、标签、目录、附件白名单与体积、SVG 安全） | `validateImportEnvelope()` → `ImportRejection(IMP-3002/3003/4001/4002/4003/4004/4005/4007/4008/4010/4012/4013/4014)` | `src/lib/clip/envelope.ts` |
| §3.2 字节模板（front-matter 8 键顺序、空行、`# title`、H1 降级、末尾恰好一个 `\n`、无 BOM/CR） | `renderMarkdown()` / `renderFrontMatter()` / `renderBodyBlock()` | `src/lib/clip/frontmatter.ts` |
| §3.3.3 追加（`\n\n---\n\n` 分隔 + `> 再次剪藏于 …` 时间戳 + 前像） | `renderAppended()`、`appendTo()` | `frontmatter.ts` / `receive.ts` |
| §4.1 判定链 6 步（同 importId → 同 URL 同正文 → 同 URL 不同正文（选区追加 / 整页进收件箱）→ 仅内容哈希相同 → 新建） | `runCommit()` 有序链 | `src/lib/clip/receive.ts` |
| §4.3 幂等索引 + §4.3.3 front-matter 降级重建 | `src/data/importLog.ts`（`.opennote/import-index.json`，2000 条上限） | `src/data/importLog.ts` |
| §3.3.3 / §6.7④ 前像与撤销（逐字节还原；不可回退时降级为移入回收站且文案如实） | `writePreimage()` / `undoImport()`（`mode: "preimage" \| "trash"`） | `importLog.ts` / `receive.ts` |
| §4.5 回执（11 个冻结字段 + `status` 六值 + HTTP 201/202/200） | `ImportReceipt` + `httpStatusOf()` | `receive.ts` |
| §5.8.2 收件箱投递（`pending`，`inboxId` = **磁盘目录名**） | `enqueuePending()` + `resolveInboxDirName()` | `receive.ts` |
| 00 §6.7① overwrite 四道闸门（通道=local-bridge + 开关开 + 显式 conflict + 前像可写 + 目标不在编辑） | `overwriteGate()` / `overwriteTarget()`，任一不满足 → 降级 `new` + `IMP-4011` | `receive.ts` |
| 00 §6.7④ 入库 toast（10 秒窗口，唯一 toast 来源，`deduped/duplicate/skipped/pending` 静默） | `announce()` + `UNDO_WINDOW_MS = 10_000` | `receive.ts` |
| UI-06 冲突对话框（逐字文案、`radiogroup`、↑↓、打开聚焦推荐项） | `askConflict()` / `ConflictDialogHost()` / `installImportConflictDialog()` | `src/components/ConflictDialog.tsx` |
| §6.1 跨模块域错误透传（按**结构**判，不按类判） | `toImportErrorBody()` | `envelope.ts` |
| **00 §6.14㉕㉖（0.3.0）落点偏好接线**：`importConflict === "inbox"` + 外部通道 → 强制 `pending`、跳过第 2–6 步、不写盘 | `setImportLandingPreference()` + `runCommit()` 第 1 步之后的分支 + `isExternalDeliveryChannel()` | `receive.ts` |

## 1.5 · 0.3.0 落点偏好（`task-10`，00 §6.14㉕㉖㉗）

**接口（已导出到 barrel，task-14 接的就是它）**

```ts
export type ImportLandingPreference = "new" | "append" | "skip" | "inbox";
setImportLandingPreference(pref: ImportLandingPreference): void  // 界面侧 mount + 设置变更时调用
getImportLandingPreference(): ImportLandingPreference
resetImportLandingPreference(): void                             // 复位成默认 "inbox"（不是 "new"）
```
默认 `"inbox"`（与 `DEFAULT_UI.importConflict` 一致）⇒ 即使界面接线晚了，行为层也已经是 0.3.0 语义。
运行时脏值不采信（保持当前值 + `console.warn`），绝不静默落到某个选项上。

**行为（可逐条复验）**

1. `pref === "inbox"` 且通道 ∈ {`local-bridge`（插件/CLI/MCP/Skill/URL scheme）, `inpage`（页面内桥）}
   → `status="pending"`、`path=null`、`inboxId=<目录名>`、HTTP 202，**跳过判定链第 2–6 步、一个笔记文件都不写**。
2. **第 1 步仍然最优先**：同 `importId` 重投 → `deduped`（`path=null` + 首次入队的 `inboxId`），收件箱里只有 1 条。
   实现要点：笔记索引只记得**落过盘**的笔记，pending 条目一个字都没写 → 所以 `enqueuePending()` 会先用
   C2 的 `readInboxDetail(importId)` 查一次收件箱（判不到就当没有，交给 `enqueueInbox()` 自己的同 id 幂等）。
   **索引优先于收件箱**：条目若已被「确认入库」，第 1 步先在索引命中，回执给的是笔记落点。
3. `channel === "in-app"` 不受影响（直接落盘 + 可撤销）—— 控制组。
4. **`channel === "inbox"` 也排除在外**（㉕.1，Lead 已裁定）：那是 C2 的「确认入库」复投
   （`inbox.ts` 传 `channel: "inbox"`），若也强制 pending 会把条目原样塞回收件箱 = 死循环。
5. **`pref === "inbox"` 优先于客户端下发的 `conflict`（含 `"overwrite"`）**（㉕.2，Lead 已裁定）：
   覆盖是最不可逆的无审阅写入，正是这个设置要拦的对象。四道闸门代码**一行未动**（纵深防御），此偏好下不可达。
6. ㉗ 文案逐字：`IMP-4007` = `Opennote 里还没有打开笔记本文件夹。请在 Opennote 左侧选一个文件夹，或新建一个，再试一次。`
   `IMP-4006` = `Opennote 没有在运行。请先打开 Opennote，再试一次。`
   （`IMP-4013` 的 `附件太多或太大，请减少后用重新剪藏。` **未动**，仍被 C-6c 逐字护栏钉住。）
   本接收端把 `IMP-4006` **也放进了 `IMPORT_ERRORS`**：它自己不产出这个码（桥/扩展产出），
   但 `toImportErrorBody()` 需要按码补 `http`/`retryable`，且㉗ 的三态区分需要一个权威副本。
   ⚠️ `02`/`03` 文档里的 `IMP-4006`/`IMP-4007` 文案**还是旧的**（`02:1696`/`02:1697`、`03:684`/`03:685`），
   `C2` 的 `src/data/inbox.ts:118-119` 也是旧文案 —— 按 `00` §6.14㉗（优先级 1）它们都该改，但都不在我范围内。

**⚠️ E2E 侧要注意的保真缺口（不是缺陷，是可观测性）**：`scripts/verify-e2e.cjs` 的驱动**从不调用
`setImportChannelContext()`**，所以它所有直接调用接收端的场景都跑在默认通道 `in-app` 上 ——
`pref="inbox"` 的新行为在 E2E 里**看不见**（`S1.x`「插件 → 桥 → 落盘」仍然是 `created`）。
要覆盖 0.3.0 默认路径，需要 Verifier 在对应场景里显式 `setImportChannelContext({ channel: "local-bridge" })`
（或让桥的 handler 如实声明通道）再加一条「默认设置下 → `pending` + 无新 `.md`」的断言。

## 1.6 图片随笔记落盘（task-31，Lead 裁定 `foo.assets/`）

**用户原话**：「图片下载，即将图片下载到本地（**从收件箱移动到其他位置时，图片位置也应改变**）」。

**命名（冻结）**：笔记 `<目录>/foo.md` → 图片 `<目录>/foo.assets/`，正文引用是**相对路径** `foo.assets/<文件>`。
不用公共 `<目录>/assets/`：那种布局只有「整个目录一起搬」才成立，单篇笔记挪走（或从收件箱 `{folder}` 入库到别处）就会断图。

**磁盘表现（扩展侧照这个填 `assets[]`，不改字段名/形状）**
1. 文件名 = `contentHash8(bytes) + "-" + sanitizeName(name)`，**空白折成 `-`**（空格会截断 Markdown 链接目标）。
   内容哈希前缀 ⇒ 重试幂等；同名不同内容天然区分。
2. **不静默覆盖**：目标路径已存在时**先读回来比字节** —— 相同 → 复用（不写）；不同 → 可读化去重 `…-2.png`、`…-3.png`
   （用 `-2` 不用 ` 2`，同样是为了引用里没有空格）。用户手放的同名文件**逐字节不动**。
3. **资产名不是路径逃逸入口**，两道闸：`sanitizeName` 先剥掉分隔符/冒号/控制字符；
   落点再过 `assertSafeRelative()` **且**比对 `parentPath(落点) === 附件目录` —— 后者是硬闸：
   `joinPath` 会把 `..` 归一化掉，只做词法校验看不出「悄悄写到目录外」。
4. **撤销（10 秒窗口）时资产与正文一致**：
   - 撤销「新建」→ 笔记与 `<笔记名>.assets/` **一起**移入 `.opennote/trash/`（不留孤儿目录）；
   - 撤销「追加/覆盖」→ 前像还回来，**这次新增**的图片跟着删（判据：本次回执里的 `assets[]` **且**还原后的正文不再引用它），
     **复用的旧图不删**（它被还原后的正文引用着）；目录空了顺手收掉；
   - 清理失败**如实说明**（消息里带上没能清理的个数与目录），不假装成功。
5. 收件箱待确认期间资产在条目自己的 `entry/assets/`（C2 落盘）；确认入库时由接收端写最终落点
   （C2 的 `commitInboxResult` 把条目资产重新内联成 `dataBase64` 后交回接收端 → 只有一条写路径），
   提交成功后 C2 立刻删掉条目里的暂存副本（`src/data/inbox.ts:1175-1179`）。
6. **不迁移旧数据**（Lead 裁定）：老笔记的图留在公共 `<目录>/assets/` 里，正文也照旧引用 `./assets/x.png` —— **照样能读**，
   接收端不改写、不搬运、不删它们；只有**新图**写 `<笔记名>.assets/`。
   （H1 端到端 + H2 撤销两组用例把这条钉住：老笔记正文与老图**逐字节不变**、公共目录**既不多也不少文件**、
   撤销时也**不碰**它 —— 这两组各有一条能独立红的断言，见下表。）

**三路统一后请按这四条不变量打**（编辑器粘贴 / 本地导入 / 剪藏 → 都写 `<笔记名>.assets/`；见下方缺口 2 的裁定）：
1. **落点不变量**：`join(parentPath(notePath), sanitizeName(stripExtension(baseName(notePath))) + ".assets")` —— 三条路必须用**同一个**派生函数（`assetsDirFor`，barrel 已导出）。
2. **引用可解析不变量**：`join(笔记所在目录, 正文里的引用)` 恰好等于磁盘上的文件（**命名无关**的写法，改命名时这条仍然成立）。
3. **无孤儿不变量**：永久删除 / 图删除后，`<笔记名>.assets/` **和**公共 `assets/`（若该目录下已无别的笔记在用）两个位置都不留该笔记的图。
4. **旧数据不迁移不变量**：只在公共 `assets/` 里有图的老笔记，正文引用**一个字符都不变**、图片仍能解析（跑一遍老数据夹具即可）。

**可复跑的端到端**（真 `enqueueInbox` + 真 `commitInboxResult`，只把工作区换成内存盘）：

```text
$ npx vitest run src/lib/clip/assetsE2E.test.ts        # 6 passed
  ① 信封 → pending（资产在 .opennote/inbox/<dir>/assets/，工作区里还没有笔记）
  ② commitInboxResult(id, { folder: "归档" }) → 归档/带图的剪藏.md + 归档/带图的剪藏.assets/×2
  ③ 断言写成命名无关的不变量：join(笔记所在目录, 正文引用) 恰好等于磁盘上的资产文件
  ④ 根目录无残留（没有「先落盘再搬」的中间态）；重复确认 → null 且路径快照不变
  ⑤ discard → 条目目录（含 assets/）整棵消失；保留期 24h 清理 → 条目目录消失、最终落点的图不受影响
  ⑥ **不迁移旧数据**（H1）：目录里先有「老笔记 + 公共 `归档/assets/`」→ 收件箱入库 / 直接落盘**两条路**都跑一遍，
     老笔记正文与老图**逐字节不变**、公共目录既不多也不少文件、新图只进 `<新笔记>.assets/`
```

**七组断言的红/绿都验过**（细节见 §3）：

| # | 回退方式 | 结果 |
|---|---|---|
| ① 搬笔记没搬资产 | `writeAssets` 开头直接 `return { paths: [], renames: [] }` | 21 红（`expected [] to have a length of 1`；E2E `引用应该指向 带图的剪藏.assets/：./assets/diagram.png`） |
| ② 搬了资产但正文没重写 | `rewriteAssetRefs` 开头 `return body` | 14 红（`expected './assets/diagram.png' to match /^测试标题\.assets\//`） |
| ③ discarded 后资产残留 | 运行时把后端的 `remove` 桩成「留下 `assets/`」（`discardInbox` 是 c2 的文件，我不改） | 1 红（`expected true to be false`） |
| ④ 资产名含 `../` 逃逸 | `assetFinalName` 去掉 `sanitizeName` | 6 红（`../../../escape.png` 被硬闸拒成 `IMP-4012`：`❯ allocateAssetPath src/lib/clip/landing.ts:141`） |
| **H1 不迁移旧数据** | `writeAssets` 末尾加一句删除公共 `<笔记目录>/assets/`（模拟「统一时顺手迁移旧数据」） | **2 红，且只有这 2 条红**（其余 4 条 E2E 保持绿）：`AssertionError: 老图的字节被改动了: expected null to deeply equal Uint8Array[…]` |
| **H2 撤销不误删旧图** | `rollbackImportAssets` 里加同一句（模拟旧实现的破坏性清理） | **1 红，且只有这 1 条红**（其余 36 条保持绿）：`expected null to deeply equal Uint8Array[…]` |
| **H3 派生边界** | `assetsDirFor` 退回 `joinPath(parentPath(notePath), "assets")` | **13 红**：`expected 'assets' to be 'foo.assets'` / `expected '归档/assets' to be '归档/foo.assets'` … |

**H3 红证明里有一条「没红」，值得单独说清**：`接收端落盘的目录与 assetsDirFor(最终笔记路径) 逐字一致` 在回退后**仍然绿** ——
它是**自洽性**断言（「写的人和算的人是不是同一个」），不是**命名**断言；回退时两边一起动，所以它照样绿。
命名本身由那 11 条**字面量**用例钉住（`foo.md` → `foo.assets` …）。**两类断言各证明一件不同的事，不能互相替代。**

⚠️ **写测试夹具的坑（Verifier 一定会踩）**：想在「已导入的笔记」上造追加场景时，**不要直接改磁盘上的正文**
再投第二封 —— 接收端会识别成「外部改动」并给出 `IMP-W004 目标笔记有外部改动，已另存为新文件以免覆盖。`，
结果是另存 ` 2.md`（`appended` 变 `created`）。正确做法：**让第一次导入就写出那份正文**
（想造「老笔记 + 公共 `assets/`」的夹具，就先 `seedBytes` 那张图，再让第一封导入的信封正文引用 `./assets/x.png` ——
未声明的引用会带 `IMP-W002` 原样保留，正好就是「不迁移」的语义）。

⚠️ **③ 的红证明是「模拟回归」**：`discardInbox` 在 `src/data/inbox.ts`（c2 的写入范围），我**没有**改它；
我用运行时桩模拟了它「删不干净」的回归，证明**断言本身对残留敏感**；生产路径的真清理由 E2E 绿证明。

⚠️ **两个跨模块缺口 —— Lead 已裁定（2026 本轮）**：
1. **删除/搬迁必须连带 `<笔记名>.assets/` —— 要修，但 `src/data/library.ts` 是 Lead-only 热点，我不动。**
   现状：`library.ts` 只认公共 `ASSETS_DIR`（`:1145-1146`、`:1197-1208`、`:2017-2029`）→ 永久删除一篇落盘笔记
   会留下 `<笔记名>.assets/` **孤儿目录**（用户看得见、会累积）。`trashNote` 那侧我在撤销路径里补了
   （`runUndo` → `trashAssetsDir`），**删除笔记**走 library，由 Lead 接线。
   **修的时候必须在两个可能的位置都查**（见裁定 ②）。
2. **Lead 裁定：统一到 `<笔记名>.assets/`，公共 `assets/` 那一套判为「本身是错的」**（同一缺陷的另一半：
   单独移动一篇笔记，用编辑器贴的图一样会断）。
   - **新图一律写 `<笔记名>.assets/`**：编辑器粘贴/拖拽、本地文件夹导入、剪藏三条路统一
     （涉及 `src/data/assets.ts`、`src/editor/media.ts`、`src/lib/import.ts` —— **都是 Lead 派单的热点文件，我不动**）；
   - **不迁移旧数据**：老笔记的图留在 `assets/` 里，路径已经写在 Markdown 里，照样能读（迁移风险 > 收益）；
   - **删除/搬迁要同时处理两种情况**（旧公共目录 + 新按笔记目录），与裁定 ① 合并；
   - 文案同步（`welcome.ts:17/26/83-86`、`Sidebar.tsx:751/772`、`AppDialogs.tsx:342/413` 仍写 `assets/`）也由 Lead 派。
   - **三路统一时请复用本模块的派生函数，不要各写一份**：`assetsDirFor(notePath)` 已从 barrel 导出
     （`src/lib/clip/index.ts:119`），语义 = `joinPath(parentPath(notePath), sanitizeName(stripExtension(baseName(notePath)), "未命名") + ".assets")`，
     **入参必须是最终笔记路径**（撞名去重后的 `foo 2.md` → `foo 2.assets/`），不是标题。

⚠️ **引用里的空格**：笔记名本身带空格（如撞名后的 `测试标题 2.md`）时，引用会是 `测试标题 2.assets/x.png` ——
**资产文件名**已经不含空格，但**笔记名**带来的空格仍在引用里。严格 CommonMark 需要 `%20` 或 `<>`；
当前应用没有自己的图片解析器，实际渲染器（Obsidian/预览）接受字面空格，所以保留字面路径。**这是有意的，不是漏改。**

## 2. 我**没有**实现什么（如实，别当已做）
1. **S10 批量模式未做**：没有 batch 接口、没有 `assets` 追加接口、没有并发多封入队的编排。任务只要求单封信封的 L2 接收端。
2. **`overwrite` 实际上永远走不到**：桥侧 `electron/bridge.cjs` 的 `getAdvancedOverwrite()` 恒 `false`（0.2.0 没做高级覆盖开关），
   所以 `conflict:"overwrite"` 到渲染层之前就被降级成 `new` + `IMP-4011`。**我的四道闸门代码是真的、也有测试**，
   但在当前版本里只能通过直接调用 `receiveEnvelope()`（绕开桥）才能触发。**0.3.0 又多一层**：
   默认 `pref="inbox"` 时，外部通道的 `conflict:"overwrite"` 直接进收件箱（㉕.2，Lead 已裁定），
   所以要在测试里验四道闸门，必须先 `setImportLandingPreference("new")`（`receive.test.ts` 的
   overwrite 那一组就是这么做的）。
3. **`committedAt` 不产出**：`00` §6.9⑩ 说它是可选字段、不作验收必查项，我没写。
4. **`dedupedBy: "sourceUrl"` 不产出**：枚举保留，但判定链一律不出这个值（同 §6.9⑩）。
   我一度给 `appended/pending/skipped` 填过 `"sourceUrl"`，现已收敛为 `null`，保持
   `deduped === false ⇒ dedupedBy === null`。`deduped` → `"importId"`，`duplicate` → `"contentHash"`。
5. **收件箱状态机、面板、IPC 接线、桥本体、扩展**都不是我的：分别在 C2 / C3 手里（`src/data/inbox.ts`、`App.tsx`、`electron/**`、`extension/**`）。
6. **真实窗口渲染 / 像素级「3 秒内可见」**：环境里没有 Electron 窗口，任何人在本机都证不了，只能 UNVERIFIED。

## 3. 我怎么自证的（命令 + 真实输出）

```text
$ npx tsc --noEmit
（无输出）exit 0

$ npx vitest run src/lib/clip/
Test Files  7 passed (7)
     Tests  177 passed (177)          ← task-31 图片：assets 37 + assetsE2E 6（含 H1/H2/H3）

$ pnpm typecheck
（无输出）exit 0

$ pnpm test
Test Files  32 passed | 1 skipped (33)
     Tests  592 passed | 2 skipped (594) / 0 failed

$ node scripts/ipc-safety-check.cjs
PASS 62 / FAIL 0 / SKIP 2                  exit 0

$ node scripts/verify-contract.cjs
PASS 107 / FAIL 1 / SKIP 2 / INFO 18        exit 1
  唯一的 FAIL 是 [C-12c]（main `webContents.send` ⇄ preload 订阅，IPC 配对③）—— **不在接收端**，
  IPC 配对那组护栏是 Verifier 新加的，Lead 在派修（`C-12a`/`C-12b`/`C-10t` 已消）。我这边全绿：
  [C-6c] PASS、**`[C-6f]` PASS（6 个产地：bridge/main/envelope/inbox/ext-errors/ext-dist）**、
  [C-6f·覆盖] `envelope: 键位 17 个码／取到文案 17 个`。

$ node scripts/verify-e2e.cjs
PASS 106 / FAIL 0 / UNVERIFIED 3 / INFO 5    exit 0
  （S7.1 的单实例锁打桩问题已被 C3/Verifier 消化；UNVERIFIED 3 条是「真实窗口肉眼可见」类，
    需要真机跑，不是断言失败。）
```

单测分布：`receive.test.ts` 72（含落点偏好 11）· `envelope.test.ts` 38 · **`assets.test.ts` 37** · `frontmatter.test.ts` 14 · `hash.test.ts` 7 · `errorTable.test.ts` 3 · **`assetsE2E.test.ts` 6** · `importLog.test.ts` 22。
关键断言都用「能独立红」的方式验过（把实现临时回退 → 对应用例红 → 恢复 → 全绿）：
- 域错误透传 3 红 / `inboxId` 目录名 1 红 / `IMP-4013` 文案 1 红（0.2.0 那一轮）；
- **0.3.0 落点偏好 5 红**（`expected 'created' to be 'pending'` 等），同一轮里 4 条控制组
  （`in-app` 不受影响、`channel="inbox"` 不被强制、`pref="new"` 与 0.2.0 一致、脏值不采信）**保持绿** ——
  证明回退没有把「该对的」也一起弄坏；
- 收件箱幂等预判 1 红（`expected 'pending' to be 'deduped'`，第二次投递会假报又入队）；
- ㉗ 文案 1 红（旧文案 `Opennote 里还没有打开笔记本，请先打开一个文件夹（或新建浏览器笔记本）。`）；
- **`IMP-4008` 的反引号 2 红**（`errorTable.test.ts`：与桥逐字比对红 + 全表扫描报出
  `IMP-4008.userMessage: 目标目录不合法：不能使用 \`..\`、…`），同轮第 3 条（警告文案）保持绿；
- **task-31 图片 7 组红**（①21 红 ②14 红 ③1 红 ④6 红 + **H1 2 红 / H2 1 红 / H3 13 红**，逐条见 §1.6 的表；
  H1/H2 的红**只有目标那几条**、控制组保持绿，H3 的回退还额外暴露了「自洽性断言 ≠ 命名断言」，见下表后面的说明）。

**错误码表的三边对齐**（`errorTable.test.ts`，`scripts/verify-contract.cjs` 的 `C-6f` 单元版）：
同一个码的 `userMessage` 有多个产地（接收端 / 桥 / 收件箱 / 扩展），`02` 附录 A.3 表格里的反引号是
**Markdown 内联代码标记**，抄进字符串就会显示给用户。护栏按**类**扫全表（`IMPORT_ERRORS` 的
`userMessage` + `message`、`IMPORT_WARNINGS`），不按条目扫 —— 这类错「看着一样」，逐条看会漏。

**手写信封的独立验证**：见 `src/lib/clip/RECIPE-手工信封验证.md`（一段可复制的 `node -e` 命令 + 变体表 + 断言依据）。
该脚本是**从文档里原样抽出来**跑的：正常桩 3 行 PASS，故意错键序 / 多一个换行都如实 FAIL。

**收件箱按目录名操作**（§6.13㉔ 落地后的第一手复核，我亲自跑的）：
`npx vitest run src/data/inbox.test.ts` → 50 passed；`node scripts/verify-e2e.cjs` →
`PASS [S5.8b] 丢弃（目录名写法）生效：未抛错且目录已删`，全量 PASS 81 / FAIL 0。

## 4. 已知限制与风险（请你重点打）

1. **`url: null` 的读法**（Lead 已裁定批准）：`null` 不是一种来源 → 只在第 2 步（同正文哈希 → `duplicate`）参与判定；
   两次都不带 URL 且正文不同 → **第 6 步新建**。理由：把两段无关记录静默合并是毁内容，多一篇远比错合并轻。
2. **`inboxId` 是磁盘目录名、`InboxEntry.id` 是条目身份，两者不等价 —— 但两种写法都可用**：
   `inboxId` 是**磁盘目录名**（`YYYYMMDDTHHMMSS-<importId 前 8>`），`InboxEntry.id` 是**条目身份**（完整 `importId`）——
   两者**不等价**（`00` 号 §6.13㉒）。但**两种写法都可用**：`readInboxEntry` / `readInboxDetail` / `setInboxStatus` /
   `commitInbox` / `discardInbox` 五个入口都接受 `importId` 或目录名（`findDir` 单点解析，`importId` 精确匹配优先）；
   查不到一律抛 `IMP-4017`，**不存在静默成功**（§6.13㉔）。
3. **`IMP-4013` 一个码两种场景**：附件超限（`envelope.ts`，用 `02:1703` 唯一文案源逐字版）与收件箱满 500
   （C2 的 `INBOX_FULL_MESSAGE`）。透传以**错误对象自带的 `userMessage`** 为准，所以收件箱满时用户看到的是「请先处理一些条目」
   而不是「附件太多」；`http` 仍按总表 = 413。Lead 已让 Verifier 把这类记 INFO。
4. **前像/日志的保留**：日志 500 条、索引 2000 条，裁剪时同步删前像（被保留条目引用的不删）。
   `IMP-W005`（索引写失败）只影响去重、不影响用户数据。
5. **`revertible: false` 的两种情况**：① 追加时前像写不出来（`IMP-W008`）→ 撤销只能移入回收站；
   ② 覆盖降级为新建。文案分别是「内容已合并进已有笔记，撤销会把整篇移入回收站。」
   与「这次导入没有留下可回退的前像，撤销会把笔记移入回收站。」——**绝不承诺「撤销后恢复原样」**。
6. **编辑中的笔记**：装了冲突 resolver → 先问人；没装 → 先 `flushAll()` 再追加（不丢字），
   磁盘与内存版本不一致或未知笔记 → `IMP-W004` + 另存新文件，**永不覆盖**正在编辑的笔记。
7. **测试替身**：`receive.test.ts` 用内存后端 + `vi.mock` 掉 `data/inbox`、`data/workspaces`。
   真磁盘/真 HTTP 的覆盖在 Verifier 的 `verify-e2e.cjs` 里（我引用了它的结论，但那不是我的自证）。
8. **`toImportErrorBody()` 是结构化域错误判定的唯一入口**（已导出到 barrel `src/lib/clip/index.ts`，C2/C3 可直接复用）。
   判据是 `code` 匹配 `/^IMP-\d{4}$/` + `userMessage` 非空，**不依赖具体类**；`http`/`retryable` 缺失时按码从
   `IMPORT_ERRORS` 补齐，域错误自带的 `userMessage` 优先于总表。
   ⚠️ **后来者不要再用 `isImportRejection()` 当跨模块透传的唯一通路** —— 它是精确的类守卫（只认 `ImportRejection`
   或 `name === "ImportRejection"`），别的模块的域错误类（如 `InboxError`）会被它判成 false，然后被包成
   `IMP-5001 磁盘可能已满`，把用户指去查磁盘（真因可能是收件箱满）。这是本项目第三次同类缝：
   **写者 A 的错误对象被写者 B 的类型守卫吃掉 —— 跨模块传错误对象要按结构判、不按类判。**
   只有「确实要区分是不是自己抛的」时才用 `isImportRejection()`。
9. **验证脚本的当前状态**：`node scripts/verify-contract.cjs` = **PASS 66 / FAIL 0 / SKIP 1 / INFO 11**（exit 0）、
   `node scripts/verify-e2e.cjs` = **PASS 81 / FAIL 0 / UNVERIFIED 3 / INFO 4**（exit 0）。
   这两个脚本是 Verifier 的产物、还会继续改（例如待做的 `U-8` 会把 `*.md` 排除出「用户可见文案」的扫描范围 ——
   本目录 `RECIPE-手工信封验证.md` 里的 `⚠️` 会被它当成界面文案；**文档不算界面文案，那个符号保留即可**）。
