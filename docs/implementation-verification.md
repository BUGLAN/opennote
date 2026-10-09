# 独立验证报告：附件迁移工具（t6）与占位名自动改名（t7）

- 验证者：verifier（t8，独立于两个实现者）
- 验证日期：2026-10-09
- 被验证任务：t6（migration-eng）、t7（app-eng）
- 验证方式：**全部读数由验证者自己跑命令产生**，不复用实现者的结论、截图或测试夹具
- 验证脚本与夹具：`.tmp-verify/`（新增 13 个文件；`src/`、`scripts/` 一个字节未改）
- 真实笔记本 `E:\repo\notes`：全程只读，dry-run 跑前跑后全树 sha256 快照逐字节一致

> **本文件是两轮验证的留痕记录，第一轮内容原样保留、不覆盖。**
> - **第一轮（t8）**：§0–§9，verdict = needs_revision，报出缺陷 **D1**。
> - **第二轮（t12，D1 回修 t11 之后的复验）**：见下方 **§R2**，verdict = pass（D1 关闭）。

---

## R2. 第二轮复验（t12）：D1 回修后的复验

- 复验者：verifier（t12，与 t11 的实现者不同人）
- 复验日期：2026-10-09
- 被复验：**t11**（回修第一轮报出的 D1）
- 复验对象代码：`src/data/nodeFsBackend.ts`（mtime 21:04:24）、`src/data/migrateAssets.ts`（21:01:17）、`src/data/migrateAssets.test.ts`（21:07:00）
- 复用第一轮的夹具与复现脚本（`.tmp-verify/`），未重新发明；新增 1 个后端级复验脚本 `.tmp-verify/verify-d1-fixed.mjs`

### R2.0 第二轮 verdict

**verdict = pass** —— D1 已关闭，t6/t7 既有判据**零回归**，真实笔记本数字与第一轮逐字一致。

| 项 | 结论 |
| --- | --- |
| **D1（第一轮 medium）** | **已关闭**。真实 node 后端上空目录被收掉、非空目录抛 `ENOTEMPTY` 且原样保留。证据见 [R2.1](#r21-d1-关闭证据真实-node-后端逐支量取)。 |
| t6 十条判据 | 全部通过（第一轮的失败项 D1 已消失） |
| t7 十条判据 | 全部通过（t11 只动 nodeFsBackend/migrateAssets，未波及 t7） |
| 是否引入新缺陷 | 未发现。t11 的三支 `remove()` + `lstat` 改动未削弱任何安全边界（详见 [R2.5](#r25-是否引入新缺陷)） |
| ⚠️ 全树 `tsc`/`vitest` 当前为红 | **不是 t11 造成的**，是 **t14（app-eng, repair-round-2）正在改 `library.ts`/`types.ts`/`App.tsx`** 造成的在途状态。因果链见 [R2.4](#r24-关于当前全树-tscvitest-为红的如实说明)。t13（真实迁移）需等 t14 收工后再开。 |

### R2.1 D1 关闭证据：真实 node 后端逐支量取

复验脚本 `.tmp-verify/verify-d1-fixed.mjs`（`createNodeFsBackend` + `os.tmpdir()`，直接量**后端**而不是 `fs` 原语）：

```
① backend.remove(空目录)          = OK
   exists 之后                    = false （期望 false）
② backend.remove(非空目录)        = 抛错 ENOTEMPTY （期望 ENOTEMPTY）
   exists 之后                    = true （期望 true）
   readdir 之后                   = ["x.txt"] （期望 ["x.txt"]）
③ backend.remove(文件)            = OK
   文件 exists 之后               = false （期望 false）
④ removeIfEmpty(空壳2.assets)      = true （期望 true）
   exists 之后                    = false （期望 false）
   removeIfEmpty(有图.assets)      = false （期望 false）
   exists 之后                    = true （期望 true）
   removeIfEmpty(.opennote)       = false （期望 false，护栏）
   removeIfEmpty(assets)          = false （期望 false，护栏）
   removeIfEmpty(.assets)         = false （期望 false，护栏）
⑤ backend.remove(深层, recursive) 之后 exists = false （期望 false）
```

**修前 vs 修后对照**（同一个第一轮复现脚本 `.tmp-verify/diagnose-empty-dirs.mjs`）：

| 读数 | 第一轮（D1 存在） | 第二轮（D1 修复后） |
| --- | --- | --- |
| `result.removedDirs` | `[]` | `["子/无标题.assets","assets/sub"]` |
| `removeIfEmpty(子/无标题.assets)` | `false` | `true` |
| 该目录 `exists()` | `true`（还在） | `false`（真的消失） |
| 磁盘实况 | 空目录残留 | `子/无标题.assets`、`assets/sub` 均已消失 |

**D1 最小复现（第一轮 §3 那条）现在通过**：

```
  需要复制                            1
  复制                              1
  删除源文件                           1
  删除空目录                           1   子/无标题.assets
REPRO_EXIT=0
目录 子/无标题.assets 仍在 = False  ← 修前为 True
```

**安全边界未被削弱**（重点复核，这是 D1 修复最容易踩坏的地方）：

- 非空目录**没有被删**：`remove()` 非 recursive 分支只调 `rmdir`（`nodeFsBackend.ts:103`），非空抛 `ENOTEMPTY`；实测 `readdir` 仍为 `["x.txt"]`。
- `removeIfEmpty` 的 `entries.length` 空判据原样保留为唯一护栏（`migrateAssets.ts:747`），三条护栏 `.opennote` / `assets` / `.assets` 实测均返回 `false`。
- 无任何递归回退：`recursive:true` 仍走 `rm`（行为不变，实测仍能递归删）。
- `.opennote/history/` 全程不扫不改不删（见 [R2.2](#r22-t6-十条判据复跑)）。

> 附注：第一轮那个 `diagnose-rm.mjs` 直接调 `node:fs/promises` 的 `rm`，所以它**仍然**打印 `ERR_FS_EISDIR` —— 那是 Node 的原始语义，是**预期的**，不是回归。要量的是**后端**的 `remove()`，即上面的 `verify-d1-fixed.mjs`。

### R2.2 t6 十条判据复跑

| # | 判据 | 第一轮 | 第二轮 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | 迁移逻辑在 `src/data/`；默认 dry-run，不带 `--apply` 绝不写 | 通过 | **通过** | 真实笔记本 dry-run `result` 全 0；全树 sha256 一致 |
| 2 | dry-run 报告 5 项数字与 t5 一致或说明差异 | 通过 | **通过** | 231 / 16 组省 23 / 196 条 42 篇 / 55 死引用 / 35 无引用 / 23 旧目录 —— 与第一轮逐字相同 |
| 3 | 去重按 sha256 字节；同名不同内容不得互相覆盖 | 通过 | **通过** | 第一轮夹具 A1/A2/A4 仍全绿（42 条夹具全通过） |
| 4 | 引用改写覆盖角括号/裸/带子目录/`<img src>`，改写后逐条反解校验 | 通过 | **通过** | 第一轮夹具 D1–D5 全绿；CLI 端到端改写后 `<../.assets/…>` 正确 |
| 5 | 复制→逐字节校验通过后才删源；只删确认复制成功的源；**空目录才收**；绝不递归删 `.opennote/` | **失败** | **通过 ✅** | `removedDirs` 由 `[]` 变为 `["子/a.assets","assets/子"]`；非空目录照旧保留；零 `recursive` 删除 |
| 6 | `.opennote/history/` 一个字节都不动 | 通过 | **通过** | CLI 端到端后 history 快照内容 `历史：![x](assets/子/b.png)` 逐字未变 |
| 7 | 幂等：连跑两次第二次 0 处改动 | 通过 | **通过** | CLI 第二次 `待迁移 0 / 复制 0 / 删除源文件 0 / 删除空目录 0`，exit 0 |
| 8 | `saveImage` 字节去重有单测覆盖 | 通过 | **通过** | 第一轮夹具 F1–F6（6 条）全绿 |
| 9 | `npx tsc --noEmit` 通过 | 通过 | **见 R2.4** | 当前 tsc 有 **1 条**错误，位于 `library.files.test.ts:819`，**不是** t11 改动面（因果链见 R2.4） |
| 10 | `npx vitest run` 全绿，既有 91+ 条相关测试不回归 | 通过 | **见 R2.4** | 当前 1 failed（`library.files.test.ts`），**不是** t11 改动面；t11 相关的 5 个套件 123 条全绿 |

判据 9/10 的说明：t12 复验范围内**所有与 t11 相关的套件全绿**（见 R2.3）；全树为红的那 1 条来自 t14 在途工作。这与第一轮把「实现者声明值」当基线不同 —— 本轮我如实记录当前树状态，并给出因果归属。

### R2.3 逐套件复跑读数

```
src/data/migrateAssets.test.ts                                    → 1 file / 30 passed（含 5 条真实后端 D1 回归）
src/data/assets.test.ts + src/editor/media.test.ts
  + src/lib/clip/assets.test.ts + src/data/library.regression.test.ts
  + src/data/library.p2.test.ts                                   → 5 files / 123 passed
.tmp-verify/vitest.verify.config.ts（第一轮自建夹具全套）           → 3 files / 42 passed
src/data/library.files.test.ts                                     → 1 failed / 60 passed（t14 在途，见 R2.4）
```

t7 判据复跑：第一轮自建夹具的 **16 条自动改名用例全部通过**（含「有 override 不顶掉」「首行不当标题」「不写 titleOverride」「光标在标题行」「IME 合成中」「30 秒节流边界」「撞名让位」）。这证明 t11 只动 nodeFsBackend/migrateAssets，**没有波及 t7**。

### R2.4 关于当前全树 tsc/vitest 为红的如实说明

**现状**（第二轮复验期间实测）：

```
npx tsc --noEmit  →  TSC_EXIT=1，仅 1 条错误：
  src/data/library.files.test.ts(819,11): error TS2741:
  Property 'autoTitleFromPlaceholder' is missing in type '{ id: string; stem: string; ... }'
  but required in type 'AutoRenameContext'.

npx vitest run    →  1 failed | 62 passed | 1 skipped (64) / 1043 passed | 1 failed | 2 skipped (1046)
  × library.files.test.ts > 刚显式重命名过：30 秒静默期…
    → expected '设置里已关闭自动改名' to be null
```

**因果链（已逐项取证，与 t11 无关）**：

| 证据 | 读数 |
| --- | --- |
| 新增字段的 git 出处 | `git diff src/data/library.ts` 显示 `+ autoTitleFromPlaceholder: boolean;`（新增到 `AutoRenameContext`）与 `+ autoTitleFromPlaceholder: getUi().autoTitleFromPlaceholder !== false,`（`library.ts:1307`） |
| 新字段的文件时间 | `library.ts` 21:14:15、`types.ts` 21:10:00 —— 均**晚于** t11 的改动（`nodeFsBackend.ts` 21:04:24、`migrateAssets.ts` 21:01:17） |
| 失败测试的文件时间 | `library.files.test.ts` 20:47:18 —— **早于**新字段的引入，所以它没跟上接口变化 |
| tsc 错误清单按文件归类 | 只有 `src/data/library.files.test.ts` **1 条**，`nodeFsBackend.ts` / `migrateAssets.ts` / 迁移侧其它文件 **0 条** |
| 断言失败原文 | `expected '设置里已关闭自动改名' to be null` —— 正是新条件 -1 的返回串（`library.ts:1220`） |
| 为何返回该串 | 该测试的 `AutoRenameContext` 字面量没有 `autoTitleFromPlaceholder` ⇒ `undefined` ⇒ `!undefined === true` ⇒ 条件 -1 短路，压根走不到「刚显式重命名过」那条 |
| 同时活跃的任务 | `t14 [in_progress] app-eng — repair-round-2`；复验期间 `Sidebar.tsx` 21:15:48、`EditorPane.tsx` 21:14:56、`App.tsx` 21:13:41 仍在被改 |

**结论**：这是 **t14（app-eng）在途工作**造成的，属于「另一轮任务的中间态」，**不是 t11 引入的回归**。t14 收工时应当同步更新 `library.files.test.ts:819` 的那个字面量。

**对第一轮夹具的影响（我已适配，非放宽判据）**：t8 第一轮写的 `AutoRenameContext` 字面量也没有这个新字段，所以第一轮夹具一度有 2 条失败（E3 / E3b）。我给两处字面量补上 `autoTitleFromPlaceholder: true`（默认值，`src/data/types.ts:257`），**没有改动任何断言阈值**，并额外补了一条新条件的用例：

```
[E3]  条件 2 单独判定 = "有 titleOverride（用户显式命名过）"
[E3b] 总开关关闭（t14 新增条件 -1） → "设置里已关闭自动改名"
Test Files  3 passed (3)
     Tests  42 passed (42)
```

补齐后 42 条全通过，进一步证明那 2 条失败纯属夹具形状滞后，与 D1 修复无关。

### R2.5 是否引入新缺陷

逐项复核 t11 的改动面，未发现新缺陷：

| t11 改动 | 复核结果 |
| --- | --- |
| `remove()` 三支（rm / rmdir / unlink） | 三支实测均正确；`rmdir` 对非空抛 `ENOTEMPTY` 是**安全边界**而非要绕过的东西；`unlink` 支是必需的（`rmdir` 对文件抛 `ENOTDIR`，会把阶段 D 删源打坏 —— t11 自己发现并补了回归用例，判断正确） |
| `removeIfEmpty` 护栏未动 | 三条护栏（`.opennote` / `assets` / `.assets`）+ 非空判据实测全部仍拒删 |
| `list/exists/stat` 由 `stat` 换 `lstat` | 语义上更正确（断链符号链接不再被伪装成「不存在」）；`migrateAssets.ts` 只通过 `backend.exists()` 用它（`:693` 判源文件是否还在、`:756` 判目录是否真的没了），不依赖跟随链接的语义。**未削弱**：`lstat` 对符号链接 `isDirectory()` 为 false，`remove()` 会走 `unlink` 删链接本身而不是递归跟随 —— 比 `stat` 更安全。**未能真机验证**：本机不允许创建符号链接（需管理员权限），该改动的实际收益我无法独立复现，如实记录 |
| 未改动 `scripts/migrate-assets.mjs` | CLI 侧无需修改（它已正确打印 `removedDirs`），实测输出正确 |

### R2.6 真实笔记本只读复跑（数字未漂移）

`node scripts/migrate-assets.mjs --workspace E:\repo\notes --dry-run` → **exit 0**

| 指标 | 第一轮（t8） | 第二轮（t12） | 一致？ |
| --- | --- | --- | --- |
| 旧附件目录 | 23 | 23 | ✅ |
| 待迁移文件数 | 231 | 231 | ✅ |
| 内容组 / 重复组 / 省下 | 208 / 16 / 23 | 208 / 16 / 23 | ✅ |
| 待改写引用 | 196（42 篇） | 196（42 篇） | ✅ |
| 写法拆分 | 9 + 7 + 180 | 9 + 7 + 180 | ✅ |
| 死引用（其中指向附件） | 55（21） | 55（21） | ✅ |
| 无引用文件（旧布局） | 35 | 35 | ✅ |
| 共享 `.assets/` 无引用 | 0 | 0 | ✅ |
| 同名不同内容组 | 2 | 2 | ✅ |
| dry-run result | 全 0 | 全 0 | ✅ |
| 全树文件数 | 1200 | 1200 | ✅ |
| 全树 sha256 前后一致 | True | True | ✅ |
| 与第一轮快照逐行对比 | — | **1200 条逐行完全相同** | ✅ |

> 说明：第一次做整串 `-Raw` 比较时报 `False`，逐行比对后确认是**尾部空行的捕获差异**（`Out-String` 追加空行），不是笔记本被改动。`Get-Content | Where-Object { $_ -ne '' }` 逐行比对 1200 条，`Compare-Object` 输出为空 ⇒ **笔记本一个字节没变**。

### R2.7 第二轮证据清单

| 证据 | 位置 |
| --- | --- |
| 后端级 D1 复验脚本（空/非空/文件/removeIfEmpty 四类逐支量取） | `.tmp-verify/verify-d1-fixed.mjs` |
| 第一轮 D1 复现脚本（复用，修后读数已变） | `.tmp-verify/diagnose-empty-dirs.mjs` |
| 第一轮夹具（已适配 t14 新字段，42 条全绿） | `.tmp-verify/migration.verify.test.ts`、`autorename.verify.test.ts`、`saveImage.verify.test.ts` |
| 第二轮笔记本快照（与第一轮 1200 条逐行相同） | `.tmp-verify/notes-tree-before-r2.txt`、`notes-tree-after-r2.txt` |

复跑命令：

```powershell
cd E:\repo\opennote
node .tmp-verify\verify-d1-fixed.mjs                                   # ①–⑤ 全符合期望
node .tmp-verify\diagnose-empty-dirs.mjs <临时工作区>                    # removedDirs 非空、目录 exists=false
node scripts/migrate-assets.mjs --workspace <临时工作区> --apply        # 删除空目录 > 0
node scripts/migrate-assets.mjs --workspace <临时工作区> --apply        # 第二次全 0
npx vitest run src/data/migrateAssets.test.ts                          # 30 passed
npx vitest run --config .tmp-verify/vitest.verify.config.ts            # 3 files / 42 passed
node scripts/migrate-assets.mjs --workspace E:\repo\notes --dry-run    # 231 / 196(42) / 55 / 35 / 23
```

---

## 0. Verdict

**verdict = needs_revision**（第一轮 · t8，2026-10-09）

> 第二轮（t12）复验结论见 [§R2](#r2-第二轮复验t12d1-回修后的复验)：**D1 已关闭，verdict = pass**。以下第一轮记录原样保留。

| 结论 | 内容 |
| --- | --- |
| 阻断级问题 | **无**。核心安全性质（不丢图、不误删、不碰 history、不写 override）全部独立复现通过。 |
| 功能缺陷 | **1 条（medium）**：迁移器的「删空目录」在 Windows 上**完全不生效**（`ERR_FS_EISDIR` 被静默吞掉），23 个旧附件目录会全部留在磁盘上。见 [§3 缺陷 D1](#3-缺陷d1删除空目录在-windows-上完全不生效medium)。**→ 已由 t11 回修、t12 复验关闭**。 |
| 判据结论 | t6：9 条通过 / 1 条失败（判据 5 的「空目录才收」部分）；t7：10 条全部通过。**→ 第二轮全部通过**。 |
| 数据安全 | t6/t7 对真实笔记本零写入；迁移器对 `.opennote/history/` 的 47 个快照零触碰；绝不递归删 `.opennote/`。 |

判定说明：唯一失败项是「迁移收尾清理」而非数据安全，也不影响图片可用性（引用已全部改写正确、源文件已复制到新家）。但它使 t6 的验收判据 5 在**用户真实平台**上不成立，且会留下 23 个空目录（用户原始诉求正是「整理」旧附件目录），所以必须回修后再交付。

---

## 1. 独立复跑：基线命令

### 1.1 `npx tsc --noEmit`

```powershell
cd E:\repo\opennote; npx tsc --noEmit; "TSC_EXIT=$LASTEXITCODE"
```

原始输出：

```
TSC_EXIT=0
```

**通过**（exit code 0，无输出）。实现者 t6 报 0、t7 报 0，与本次一致。

### 1.2 `npx vitest run`

```powershell
cd E:\repo\opennote; npx vitest run
```

原始输出（尾部）：

```
 Test Files  63 passed | 1 skipped (64)
      Tests  1039 passed | 2 skipped (1041)
   Start at  20:48:38
   Duration  3.17s
```

**通过**（exit code 0）。与 t7 声明的 63 文件 / 1039 通过 / 2 skip 逐字一致；与 t6 声明的 995 通过相比多 44 条，正是 t7 新增的用例数（t6 完成时 t7 尚未开始）。**无回归、无反转。**

### 1.3 验证者自建夹具（`--config` 必带，否则根 `vitest.config.ts:6` 的 include 会报 No test files found）

```powershell
npx vitest run --config .tmp-verify/vitest.verify.config.ts
```

原始输出（尾部）：

```
 Test Files  3 passed (3)
      Tests  42 passed (42)
   Duration  1.64s
```

三个文件：`migration.verify.test.ts`（20 条）、`autorename.verify.test.ts`（16 条）、`saveImage.verify.test.ts`（6 条）。全部夹具由验证者自写 `VerifierBackend`（`FileSystemBackend` 的独立实现，记录每一次写操作、可整体冻结为只读），**未 import** `src/lib/clip/testing/memoryBackend.ts` 或 `library.files.test.ts` 里的 MemoryBackend。

---

## 2. t6 验收判据逐条核验（10 条）

| # | 判据 | 结论 | 实际证据 |
| --- | --- | --- | --- |
| 1 | 迁移逻辑在 `src/data/`，`scripts/` 只薄 CLI；默认 dry-run，不带 `--apply` 绝不写 | **通过** | `migrateAssets.ts:383` 的 `buildAssetMigrationPlan` 只调 `list/readBytes/readText/exists`；真实笔记本 dry-run 期间 `result.copied=0 reused=0 deletedSources=0`，跑前跑后 1201 条全树 sha256 快照一致。 |
| 2 | dry-run 报告列出 5 项数字，与 t5 实测一致或说明差异 | **通过** | 5 项数字全部独立复算一致（见 [§5](#5-真实笔记本-dry-run-数字独立核对)），差异已由 CLI 末尾「口径对照」段逐条说明。 |
| 3 | 去重按 sha256 字节，`image.png` / `image 2.png` 同名不同内容不得互相覆盖 | **通过** | 见 [§4.1](#41-字节级去重t6-判据-3)。 |
| 4 | 引用改写覆盖 `./foo.assets/a.png`、`<./foo 2.assets/b.png>`、`assets/a.png`、`<img src>`，改写后逐条反解校验 | **通过** | 见 [§4.3](#43-引用改写完整性t6-判据-4)。 |
| 5 | 复制→逐字节校验通过后才删源；只删确认复制成功的源；**空目录才收**；绝不递归删 `.opennote/` | **失败** | 复制/校验/删源顺序、只删已校验源、绝不 `recursive` 三项**通过**；**「空目录才收」在 Windows 上完全不生效**（`removedDirs` 恒为空、23 个空目录留在磁盘）。见 [§3](#3-缺陷d1删除空目录在-windows-上完全不生效medium)。 |
| 6 | `.opennote/history/` 一个字节都不动 | **通过** | 见 [§4.2](#42-history-与-opennote-的数据安全t6-判据-6)。 |
| 7 | 幂等：连跑两次第二次 0 处改动 | **通过** | 见 [§4.4](#44-幂等t6-判据-7)。 |
| 8 | `saveImage` 字节去重有单测覆盖：同内容连粘两次只留一个文件；不同内容同名得到 `-2` | **通过** | 见 [§4.5](#45-编辑器粘贴路径字节去重t6-判据-8)。 |
| 9 | `npx tsc --noEmit` 通过 | **通过** | [§1.1](#11-npx-tsc---noemit)。 |
| 10 | `npx vitest run` 全绿，既有 91+ 条相关测试不回归 | **通过** | [§1.2](#12-npx-vitest-run)：1039 通过 / 2 skip，exit 0。 |

---

## 3. 缺陷 D1：删除空目录在 Windows 上完全不生效（medium）

### 现象

对**真实文件系统**跑 `--apply`（临时工作区，非用户笔记本），报告与磁盘同时显示：

```
  删除源文件                           3
  删除空目录                           0
  保留（非空）目录                        2   子/无标题.assets、assets
```

但 `子/无标题.assets/` 在 `list()` 里已经是**空数组**，按 `removeIfEmpty` 的注释应当被收掉。跑完磁盘实况：

```
子\无标题.assets\        ← 空目录，仍在
assets\sub\              ← 空目录，仍在
```

### 根因（已用最小脚本定位）

`src/data/migrateAssets.ts:748`：

```ts
await backend.remove(dir).catch(() => undefined);   // 不带 recursive
```

→ `src/data/nodeFsBackend.ts:81`：

```ts
await rm(absolute(relPath), { recursive: removeOptions?.recursive === true, force: false });
```

Node 22.19.0 / win32 上，`fs.rm(dir, { recursive: false })` **对目录一律抛 `ERR_FS_EISDIR`**（无论空不空）：

```
--- 空壳.assets ---
  readdir(abs)        = []
  backend.list        = []
  rm(recursive:false) = 抛错：ERR_FS_EISDIR Path is a directory: rm returned EISDIR
  stat 之后           = 还在
```

该异常被 `:748` 的 `.catch(() => undefined)` 静默吞掉，`removeIfEmpty` 随后 `return !(await backend.exists(dir))` → `false` → 被计入 `keptDirs`（`migrateAssets.ts:699`），**永远删不掉**。

这不是本机怪癖：仓库自己的两个测试夹具早已记录同一事实——
`src/data/library.p2.test.ts:214` 与 `src/data/library.regression.test.ts:182` 都写着
`// Node semantics: rm(dir, { recursive: false }) always fails, empty or not.`
`src/data/migrateAssets.test.ts` 用的内存后端把 `remove()` 实现成「能删空目录」，因此**在 Windows 上测不出这个缺陷**（测绿 ≠ 能用）。

### 最小复现

```powershell
# 1) 造夹具
$tmp = Join-Path $env:TEMP "t8-repro"; Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path "$tmp\子\无标题.assets" | Out-Null
[System.IO.File]::WriteAllBytes("$tmp\子\无标题.assets\a.png", [byte[]](5,5,5))
Set-Content "$tmp\子\无标题.md" "![a](<./无标题.assets/a.png>)" -Encoding utf8 -NoNewline

# 2) 跑
cd E:\repo\opennote
node scripts/migrate-assets.mjs --workspace $tmp --apply | Select-String "删除空目录|保留"
#   实际：删除空目录 0 / 保留（非空）目录 1   子/无标题.assets
#   预期：删除空目录 1 / 不再出现 子/无标题.assets

# 3) 看磁盘
Get-ChildItem $tmp -Recurse -Force | Select-Object FullName   # 子\无标题.assets\ 仍在
```

### 影响面

| 项 | 量 |
| --- | --- |
| 真实笔记本里待收的旧附件目录 | **23 个**（其中 22 个当前非空、1 个 `assets/` 已空；迁移后全部变空） |
| 数据风险 | 无（复制/校验/删源/改写引用全部正确，图片不裂） |
| 用户可见后果 | 迁移后工作区留下 23 个空 `assets/`、`*.assets/` 目录；用户诉求的「整理」只完成一半；且**每次重跑都报 0 改动**，问题不会自愈 |
| 与判据关系 | t6 验收判据 5「空目录才收」在用户平台不成立 |

### 建议修复（已验证可行）

不要把「绝不递归」误表达成「不带 recursive」。`fs.rmdir` 对空目录可用、对非空目录抛 `ENOTEMPTY`，正是想要的语义：

```powershell
node -e "const {rmdir}=require('node:fs/promises'); ..."
# rmdir(空目录)   => OK，已删除
# rmdir(非空目录) => 抛错 ENOTEMPTY（安全：非空删不掉）
```

最小改法（二选一，都不放宽安全边界）：
1. `nodeFsBackend.ts:81` 拆成两支：`recursive === true` 用 `rm(..., {recursive:true, force:false})`，否则用 `rmdir(absolute(relPath))`；或
2. `migrateAssets.ts:748` 改成 `backend.remove(dir, { recursive: true })` —— 但**必须保留** `:747` 的 `if (entries.length) return false` 空判据作为唯一护栏（该判据已经在，能挡住误删非空目录）。

另外建议给 `migrateAssets.test.ts` 补一条**真 node 后端**的回归用例（用 `createNodeFsBackend` 指向 `os.tmpdir()` 夹具），否则内存后端会继续掩盖这一类平台差异。

---

## 4. 关键判据的独立验证细节

### 4.1 字节级去重（t6 判据 3）

夹具：`assets/image.png` = `aa aa aa aa`，`assets/image 2.png` = `bb bb bb bb`。

```
[A1] 目标 1 = .assets/dbed14ce-b001-5110-9766-b9013d3b5bbf.png  目标 2 = .assets/bfcd1243-2b17-5570-b814-b813158b2416.png
[A1] 哈希 1 = dbed14ceb001d110…  哈希 2 = bfcd12432b176570…
[A1] 让位数 dedupedTargets = 0  省下 dedupedSavings = 0
[A1] apply → copied=2 deletedSources=2
```

- 两个目标**不同**、两个哈希**不同**、`dedupedSavings=0`（同名不同内容不省文件）→ **通过**。
- 目标名由内容派生：验证者用 WebCrypto 独立复算 `sha256(bytes)` 前 16 字节 + RFC4122 版本位/变体位，断言 `.assets/<uuid>.png` 逐字相符（不是拿实现者的 `contentUuid` 反推）→ **通过**。
- 让位路径单测：预先把「`aa` 应落到的路径」塞入 `bb` 字节，工具正确让位成 `...-2.png`，先到的那份字节一个没动 → **通过**。
- 同内容不同名 → 同一个目标、`copiesNeeded=1`、`dedupedSavings=1` → **通过**。
- 目标已存在且字节相同 → `reusedExisting=1`，apply 期间写操作只有 `remove:assets/a.png`（删源），**没有重写共享文件** → **通过**。

### 4.2 history 与 `.opennote/` 的数据安全（t6 判据 6）

内存夹具（含 `.opennote/history/子/无标题.md/2026-01-01 00-00.md`，正文里故意写了一条旧布局引用）：

```
[B3] history 文件数 1 → 1
[B3] history 内容 = "旧布局引用：![x](./无标题.assets/a.png)\n"
[B3] 扫描目录里有 history 吗 = false
[B3] 删除的目录 = [".opennote/trash/无标题.assets","子/无标题 2.assets","assets/操作系统概念","子/无标题.assets","assets/进程相关"]
[B4] 递归删除调用 = []
[B4] 删除调用 = ["remove:.opennote/trash/无标题.assets/orphan.png", ... ,"remove:.opennote/trash/无标题.assets", ...]
```

- 内容逐字节未变、文件数未变、`scannedDirs` 无 history、`removedDirs` 无 history → **通过**。
- **没有任何 `:recursive` 删除**；`.opennote`、`.opennote/trash`、回收站里的笔记本身都还在 → **通过**。
- `removeIfEmpty` 对 `.opennote` / `assets` / `.assets` / 非空目录一律返回 `false` 且不产生任何删除调用 → **通过**。
- 路径护栏：`assertSafeRelative` 拒绝 `../outside`、`a/../../b`、`C:\Windows\x`、`/etc/passwd`、`a.md:secret` → **通过**。
- 复制校验失败即中止：把某个目标的写入内容篡改后，`failedCopies` 非空、`deletedSources=0`、源文件仍在 → **通过**。

**真实笔记本**：dry-run 期间 `report.files` 里 history 命中 0 条、`scannedDirs` 命中 0 条、`notePlans` 命中 0 条；47 个 history 快照全部原样。

### 4.3 引用改写完整性（t6 判据 4）

内存夹具 apply 后的正文（原始输出，未编辑）：

```
[D1] 根.md 改写后：
![裸](.assets/dbed14ce-b001-5110-9766-b9013d3b5bbf.png)
![子目录](.assets/bfcd1243-2b17-5570-b814-b813158b2416.png)
![带空格](<.assets/8843b54d-2df6-5ca2-a5cf-4a05d27dd2b2.png>)
![重复内容](.assets/7679d672-1dc0-55da-94c5-5104aba11765.png)
<img src=".assets/dbed14ce-b001-5110-9766-b9013d3b5bbf.png" alt="html">
![远程](https://example.com/x.png)
![死引用](assets/不存在.png)
```

逐条核验：

| 写法 | 结果 |
| --- | --- |
| `![x](assets/image.png)` 裸 | 改写为 `.assets/<uuid>.png` ✅ |
| `![x](assets/操作系统概念/image.png)` 带笔记子目录 | 改写为 `.assets/<uuid>.png` ✅ |
| `![x](<assets/进程相关/图 1.png>)` 角括号 + 空格 | 改写后**仍是角括号**（`renderAssetRef` 保留 `bracketed`）✅ |
| `<img src="assets/image.png">` | 只换 `src`，`alt` 属性一字不动 ✅ |
| `![x](<./无标题.assets/a.png>)`（角括号 + `./` 旧布局） | → `<../.assets/<uuid>.png>`（前缀按一层现算）✅ |
| `![x](./无标题 2.assets/b.png)`（裸 + 空格） | → `../.assets/<uuid>.png` ✅ |
| `https://…` 远程 | 原样 ✅ |
| `assets/不存在.png` 死引用 | 原样保留 + 计入 issues ✅ |

**反解校验**：改写后遍历每一条本地引用，用 `resolveWorkspacePath` 反解并断言目标文件真实存在；另独立断言 `workspacePathOfRef(ref, note) === resolveWorkspacePath(ref, dirname(note))`（含回收站两层 `../../assets/a.png` → `assets/a.png`）→ **通过**。

**CLI 级端到端**（临时工作区，`--apply`）：

```
--- 根.md ---
![裸](.assets/9f64a747-e1b9-5f13-9fab-b6b447296c9b.png)
![角括号](<.assets/8493100b-11a2-5e62-9bcf-97fc313f83b5.png>)
<img src=".assets/9f64a747-e1b9-5f13-9fab-b6b447296c9b.png" alt="h">
![远程](https://x/y.png)
--- 子/无标题.md ---
![a](<../.assets/348fbb44-9673-57ce-97e0-55fcbee6c170.png>)
--- 回收站/旧笔记.md ---
![old](../../.assets/9f64a747-e1b9-5f13-9fab-b6b447296c9b.png)
--- history 快照（必须逐字未变）---
历史快照：![x](./无标题.assets/a.png)
```

回收站笔记（`.opennote/trash/`，比工作区深两层）正确写成 `../../.assets/…` —— 即 t6 在交付说明里对 t5 §3.5「回收站三层」的更正**成立**（t5 原文 `../../../` 确实多一层）。

CLI 退出码：`--help`=0、缺 `--workspace`=1、未知参数=1、`--dry-run`=0，与契约一致。

### 4.4 幂等（t6 判据 7）

内存夹具（20 个文件的综合夹具）：

```
[C1] 第一次：copied=7 reused=0 改写=3 篇/7 条 删源=7 删空目录=5
[C2] 第二次：待迁移=0 待改写=0 死引用=8 无引用=0 copied=0 改写=0/0 删源=0 删空目录=0
[C4] 第二次 apply 期间的写操作 = []
```

- 第二次 `totalFiles=0`、`referencesToRewrite=0`、`copied=0`、`deletedSources=0`、`removedDirs=[]`，且**写操作轨迹为空** → **通过**。
- 目标映射确定性：连跑三次 plan 的 `source -> target` 映射逐字相同（不依赖日志或状态键）→ **通过**。
- 说明：第二次 `scannedDirs` 仍含 `assets` —— 那是 `removeIfEmpty:745` 刻意保留的工作区根空 `assets/`（`ensureWorkspaceScaffold` 每次开工作区都重建），不是残留缺陷。

CLI 级（临时工作区）同样成立：第一次 `复制 3 / 改写 3 篇 5 条 / 删源 3`，第二次 `待迁移 0 / 复制 0 / 改写 0/0 / 删源 0`。

### 4.5 编辑器粘贴路径字节去重（t6 判据 8）

独立夹具直接调 `saveImage`：

```
[F1] 第一次 = {"path":".assets/6893a08c-….png","markdown":".assets/6893a08c-….png"}
[F1] 第二次 = {"path":".assets/6893a08c-….png","markdown":".assets/6893a08c-….png"}
[F1] .assets/ 下 = [".assets/6893a08c-….png"]
[F1] 第二次的写操作 = []                       ← 复用 ⇒ 不写盘、不动 mtime
[F2] 建议名「截图 2026.png」与「完全不同的名字.png」→ 同一个 uuid 文件，路径里不含原始名
[F3] 不同内容同名 → 两个不同 uuid 文件，各自字节正确
[F4] 目标被不同字节占用 → 让位成 …-2.png，先到的那份字节未被动
[F5] 根.md → .assets/<uuid>.png ；操作系统/产品/深.md → ../../.assets/<uuid>.png（同一份内容、各自前缀正确）
[F6] 第三参传目录 → 抛错「saveImage 的第三参必须是笔记路径…」（不静默算错前缀）
```

**通过**。与剪藏 `allocateAssetPath` 的语义一致（存在且字节相同 → 复用；否则 `-2` 让位）。

---

## 5. 真实笔记本 dry-run 数字独立核对

命令：

```powershell
node scripts/migrate-assets.mjs --workspace E:\repo\notes --dry-run        # exit 0
node scripts/migrate-assets.mjs --workspace E:\repo\notes --dry-run --json # 供脚本比对
```

验证者**另写脚本从磁盘重新盘点**（不读工具输出）：按路径段判定旧布局目录（`assets` 或 `*.assets`，排除 `.assets`），递归取文件、算 sha256 分组、按 `resolveWorkspacePath` 同语义解析引用。

| 指标 | 工具读数 | 验证者独立复算 | t5 报告值 | 结论 |
| --- | --- | --- | --- | --- |
| 待迁移文件数（旧布局） | 231 | **231** | 234（口径=全部附件） | 231 + 4 个共享 `.assets/` = **235** |
| 共享 `.assets/` 文件数 | 4（`unreferencedSharedFiles`=0） | **4** | 3 | t5 成文后新增 1 个（`da36874a-…png`，10-09 20:14） |
| 附件合计 | 235 | **235** | 234 | 差 1 = 上面那个新文件；**附件侧与 t5 基本对得上** |
| 内容组数 | 208 | **208** | — | 一致 |
| 重复组数 / 省下文件数 | 16 组 / 23 | **16 组 / 23** | 16 组 / 23 | **逐字一致** |
| 同名不同内容组数 | 2 | **2** | 2 | **逐字一致**，源路径也完全一致（见下） |
| 待改写引用条数 | 196（42 篇） | **196（42 篇）** | 190 | 差 6，口径差异，见下 |
| 写法拆分 | 旧 `<笔记名>.assets/` 9 + `./` 7 + 裸 `assets/` 180 | **9 / 7 / 180** | 100+83+7=190 | 可比项：83（带子目录）+7（`./`）完全一致 |
| 死引用 | 55（其中指向附件 21） | **55（其中指向附件 21）** | 3（其 §1.6a 表格本身列了 4 行） | 口径差异，见下 |
| 算不出工作区路径 | 0 | **0** | — | 一致 |
| 无引用文件（旧布局） | 35 | **35** | 47（含 3 个共享） | 差 12，见下 |
| 旧附件目录数 | 23 | **23** | 4 个 `*.assets/` + 19 个公共 `assets/` = 23 | **完全一致** |

**同名不同内容（独立复现，源路径逐字一致）**：

```
image.png    → .opennote/trash/Agent 产出/无标题.assets/image.png
               项目实战/system_panel/无标题.assets/image.png
image 2.png  → .opennote/trash/Agent 产出/无标题.assets/image 2.png
               项目实战/system_panel/无标题.assets/image 2.png
```

**差异逐条解释**（验证者自己核对出来的，不是抄工具的「口径对照」段）：

1. **234 → 235**：共享 `.assets/` 现在 4 个文件（`16f80b5e-…png`、`2aff152e-…webp`、`ac44629b-…png`、`da36874a-…png`），t5 成文时是 3 个。多出来的 `da36874a-…png`（mtime 10-09 20:14）是 t5 之后新落盘的剪藏附件。旧布局 231 与 t5 的「234 − 3」完全对得上。
2. **196 vs 190**：t5 §1.5 只统计**公共 `assets/` 的三种写法**且**不含回收站笔记**；本工具统计**所有指向迁移清单里旧附件的本地引用**（含回收站、含旧 `<笔记名>.assets/`）。可比部分：带笔记子目录 83 = 83、`./` 7 = 7（完全一致）；裸写法 t5 报 100、本工具 180，差额含回收站笔记的引用与「旧 `<笔记名>.assets/` 9 条」这一 t5 未单列的类别。196 = 180 + 7 + 9，内部自洽。
3. **死引用 3 vs 55**：t5 只算**指向附件的图片引用**且其 §1.6a 表格自己列了 4 行（正文写 3，报告内部不自洽）。本工具的 55 = **21 条指向附件** + **34 条笔记之间的链接**（如 `AI智能时代/…/index.md` 里 `[x](/docs/claude-code/…/)`、`[x](./不存在的笔记.md)`）。验证者按工具 `isAssetLikeRef` 的判据（非 `.md` 且路径段含 `assets/` 或本身是图片扩展名）独立复算得 **21**，逐字一致。
4. **无引用文件 47 vs 35**：t5 的 47 = 44 个旧布局无引用 + 3 个共享 `.assets/`（其正文称这 3 个被回收站笔记引用）。本次旧布局无引用 35、共享 `.assets/` 无引用 **0**（4 个共享文件全被存活笔记引用）。t5 成文后引用它们的笔记/文件有变动（t6 已用 `git ls-files` 对照 HEAD 报出 227 个附件文件被删）。附件侧 235 与 t5 基本一致，说明**变的是引用方**。

**dry-run 未写一个字节（验证者独立取证）**：

```
全树（含 .opennote/）sha256 快照一致 = True
快照条目数 = 1201
dry-run 期间 result：copied=0 reused=0 deletedSources=0 removedDirs=0 rewrittenNotes=42
```

`notes-tree-before.txt` / `notes-tree-after.txt` 各 168622 字节，逐字节相同（另存 `.tmp-verify/` 供复核）。

---

## 6. t7 验收判据逐条核验（10 条）

| # | 判据 | 结论 | 实际证据 |
| --- | --- | --- | --- |
| 1 | 入口条件唯一：`stripExtension(baseName(id))` 匹配 `/^(无标题\|未命名\|untitled)(\s\d+)?$/i`；其余笔记一律不触发 | **通过** | `utils.ts:110` 正则逐条复现：`无标题/无标题 2/无标题 12/未命名/untitled/UNTITLED 3` → true；`无标题 副本/无标题副本/无标题 2 副本/未命名-2/系统设计/index/README` → false。全流程：`系统设计.md` 写标题后 0 次 move、`hasPendingAutoRename=false`。 |
| 2 | `derivePlaceholderTitle` 认 H1–H6，跳过 front matter / 围栏 / 引用块 / 表格 / 分隔线，**绝不把正文首行当标题**，扫不到返回 null | **通过** | 11 组逐条复现（见下）。 |
| 3 | 独立路径，不写 `titleOverride` / `titlePinnedAt`；用户手改过名的不被顶掉 | **通过** | `state.json` 落盘后**不含** `修改提示词.md`（无 override 键）；`titleOverride` 内存值 `null`；有 override 时 `shouldAutoRename` 返回「有 titleOverride（用户显式命名过）」。 |
| 4 | 5 秒防抖挂在 `updateNoteContent` 内，按 id 独立计时器，不与 `writeTimers/scheduleMeta` 互相取消 | **通过** | 独立验证「窗口内连续输入 3 次 → 只改一次名（最终 `一二三.md`，`move:无标题.md->` 恰好 1 次）」；真实计时器 + `setAutoRenameDelayForTests(40)`。 |
| 5 | 窗口内再输入 = 取消并重排（不是并发两个改名）；改名途中再输入不产生第二个并发 move | **通过** | 同上；`[E8] move:无标题.md-> 次数 = 1`。 |
| 6 | 抑制条件至少含：有 override、显式重命名后 30s、IME 合成中、标题为空/同名、目标名被占用 | **通过** | 19 条纯函数逐条复现（见下），含 29_999ms 拦 / 30_000ms 放的时间边界。 |
| 7 | `cursorRef`：`onCursor` 同时写 ref 与 state，定时器不读过期 state | **通过** | 行为验证：光标在标题行（line 1）时停笔 5 秒 **0 次 move**；`setEditorCursorLine(id,3)` 后重新输入 → 改名成功。 |
| 8 | 改名后计时器按**新路径**重挂 | **通过** | `[E9]`：改名 `无标题.md → 会议记录.md` 后，对新路径再改标题 → 文件名**再跟一次** `会议记录 2026.md`（若计时器/状态没跟着搬，这一步会失败）。 |
| 9 | 单测覆盖：占位名触发、非占位名不触发、H1–H6 各能触发、首行不触发、空文件不触发、有 override 不触发、幂等、撞名 | **通过** | 见 [§6.1](#61-自动改名逐条读数) 全部用例。 |
| 10 | `npx tsc --noEmit` 通过；`npx vitest run` 全绿；t2 的 26 条断言无一条被反转 | **通过** | [§1.1](#11-npx-tsc---noemit)、[§1.2](#12-npx-vitest-run)。`deriveTitle` 语义未被改（`derivePlaceholderTitle` 是新增函数，`scanPlaceholderTitle` 与它共享一次扫描），既有 deriveTitle 断言全绿。 |

### 6.1 自动改名逐条读数

**触发与抑制（全流程）**

```
[E1] 磁盘 = ["修改提示词.md"]  读数 = {from:"无标题.md", to:"修改提示词.md", status:"renamed"}
[E1] 内存 title = "修改提示词"  titleOverride = null
[E1] state.json = { "version": 1, "starred": [], "expanded": [], "lastOpened": null }   ← 无 titleOverrides / titlePinnedAt
[E2] 磁盘 = ["系统设计.md"]  move 次数 = 0   有排队定时器吗 = false
[E3] 读数 = {reason:"非占位名笔记"}  override = "系统设计ABC"   ← 名字没被顶掉
[E3] 条件 2 单独判定 = "有 titleOverride（用户显式命名过）"
[E3c] 磁盘 = ["无标题.md"] override = "无标题"  读数 = {reason:"有 titleOverride（用户显式命名过）"}
[E4] 磁盘 = ["无标题.md"]  move 次数 = 0  derivePlaceholderTitle = null     ← 一行图片不产垃圾名
[E5] 磁盘 = ["无标题.md"]  move 次数 = 0                                    ← 0 字节不触发
[E6] 光标在标题行：磁盘 = ["无标题.md"]   → 光标移走后：磁盘 = ["修改提示词.md"]
[E7] 合成中：磁盘 = ["无标题.md"]        → 合成结束：磁盘 = ["修改提示词.md"]
[E8] 磁盘 = ["一二三.md"]  move:无标题.md-> 次数 = 1
[E9] 磁盘 = ["会议记录 2026.md"]  override = null                          ← 第二次改标题文件名再跟一次
[E10] 读数 = {reason:"距上次自动改名不足 30 秒"}；期间的写操作 = []；快进 30 秒后 → 第二版.md
[E11] 读数 = {to:"修改提示词 2.md"}；被占名那份的内容 = "# 别人的笔记\n"（未被动）
[E11b] 第一次 → 修改提示词.md；第二次 = {reason:"与当前文件名相同（空操作）"}；磁盘 = ["修改提示词.md"]
```

**`shouldAutoRename` 纯函数 19 条（`null` = 允许改名）**

```
[E3b] 无静默期 → null
[E3b] 显式重命名后 1s → "刚显式重命名过（30 秒静默期）"
[E3b] 显式重命名后 29.999s → "刚显式重命名过（30 秒静默期）"
[E3b] 显式重命名后 30s → null
[E3b] state.json pin 5s 前 → "刚显式重命名过（30 秒静默期）"
[E3b] 新建 5s → "新建笔记静默期（10 秒）"
[E3b] 新建 9.999s → "新建笔记静默期（10 秒）"
[E3b] 新建 10s（边界，含） → "新建笔记静默期（10 秒）"
[E3b] 新建 10.001s → null
[E3b] 回收站 → "在回收站里"
[E3b] 只读锁 → "只读锁"
[E3b] 光标在标题行 → "光标还在标题那一行"
[E3b] 光标在正文行 → null
[E3b] IME 合成中 → "输入法合成中"
[E3b] 在途 → "正在改名途中"
[E3b] 距上次自动改名 29.999s → "距上次自动改名不足 30 秒"
[E3b] 距上次自动改名 30s → null
[E3b] 正文含旧布局引用 → "正文里有按旧文件名写死的附件引用"
[E3b] 正文没有真标题行 → "正文里没有真标题行"
[E3b] 标题与当前文件名相同（当前名 = 无标题） → "标题全是非法字符"
[E3b] 标题全是非法字符 → "标题全是非法字符"
```

**`derivePlaceholderTitle` 11 条**

```
"# 一\n"                                  → "一"
"## 二\n"                                 → "二"
"###### 六\n"                             → "六"
"intro\n# 真标题\n"                       → "真标题"        （正文首行不是标题也要往下找）
"intro\n第二行\n"                         → null            ★ 首行不当标题
"![图](.assets/x.png)\n"                  → null            ★ 一行图片不产 3f1c9589….png.md
"---\ntitle: 元数据\n---\n正文\n"          → null            （front matter 不算）
"```\n# 围栏里的假标题\n```\n# 真标题\n"    → "真标题"        （围栏内不算）
"> # 引用里的标题\n"                       → null
"| 表 |\n"                                → null
"# ** **\n\n# 后面这个才算\n"              → "后面这个才算"
```

### 6.2 真实笔记本上「入口条件不误伤」的独立盘点

```
全部 .md（含 .opennote/）        = 547
用户笔记 .md（排除 .opennote/） = 476      ← 与 t7 任务书「其余 476 篇一律不动」逐字一致
```

> 说明：`476` 是排除 `.opennote/`（history 47 个快照 + 回收站 24 篇）之后的口径，与 t7 任务书里的 476 完全吻合。迁移器侧另有独立证据：`notePlans` 里 `.opennote/history/` 命中 **0** 条（见 §4.2），说明它正确排除了 history。t3 当年的误报正是把 `.opennote/history/*.md` 当成用户笔记，本次已刻意规避。

占位名笔记（`无标题` / `未命名` / `untitled` 及带序号变体）在真实笔记本里共 14 篇：

- **存活（不在回收站）7 篇**：`无标题.md`（0 字节）、`AI智能时代/无标题.md`、`项目实战/system_panel/无标题.md`（正文含 5 处 `./无标题.assets/` 旧布局引用）、`项目实战/system_panel/无标题 2.md`、`项目实战/恋爱模拟器/无标题.md`、`项目实战/恋爱模拟器/无标题 2.md`、`项目实战/恋爱模拟器/无标题 3.md`
- **回收站里 7 篇**（`.opennote/trash/` 下），被「在回收站里」条件拦掉

与 t7 的实现一致：其余 **476 − 7 = 469 篇非占位笔记**不在候选集内（条件 0 直接返回「非占位名笔记」），验证者的独立用例已证明这条对 `系统设计.md` 零 move。t7 任务书里「§3 那 5 篇」是方案抽样出的 5 篇，实际存活占位名笔记是 7 篇（另有 `AI智能时代/无标题.md` 与 `项目实战/恋爱模拟器/无标题.md`），数量差异不影响任何判据结论。

---

## 7. 未通过项汇总

| id | severity | file:line | problem | requiredFix |
| --- | --- | --- | --- | --- |
| D1 | medium | `src/data/migrateAssets.ts:748`（经 `src/data/nodeFsBackend.ts:81`） | `backend.remove(dir)` 不带 `recursive`，在 Node 22.19/Windows 上 `fs.rm(dir,{recursive:false})` 对目录一律抛 `ERR_FS_EISDIR`；异常被 `.catch(() => undefined)` 吞掉，于是 `removeIfEmpty` 恒返回 `false`，**空目录一个都收不掉**。真实笔记本迁移后会留下 23 个空 `assets/`、`*.assets/` 目录，且重跑报 0 改动、不会自愈。t6 验收判据 5「空目录才收」在用户平台不成立。内存测试夹具把 `remove()` 实现成可删空目录，因此在 Windows 上测不出。 | `nodeFsBackend.ts:81` 拆两支：`recursive===true` → `rm(...,{recursive:true,force:false})`；否则 → `rmdir(absolute(relPath))`（`rmdir` 对空目录成功、对非空抛 `ENOTEMPTY`，已验证）。**保留** `migrateAssets.ts:747` 的 `if (entries.length) return false` 作为唯一护栏。另补一条用真 `createNodeFsBackend` + `os.tmpdir()` 夹具的回归用例，避免内存后端继续掩盖平台差异。**→ 状态：已关闭（t11 回修 + t12 复验，见 [§R2.1](#r21-d1-关闭证据真实-node-后端逐支量取)）。** |

**最小复现**：见 [§3](#最小复现)。

除 D1 外，未发现其它未通过项、未发现数据丢失/损坏路径、未发现 t7 的行为缺陷。

---

## 8. 证据清单（可复核）

| 证据 | 位置 / 命令 |
| --- | --- |
| 验证者自建内存后端（记录每次写操作、可冻结只读） | `.tmp-verify/memoryBackend.ts` |
| 迁移器验证夹具（20 条：去重 / 数据安全 / 幂等 / 引用改写） | `.tmp-verify/migration.verify.test.ts` |
| 自动改名验证夹具（16 条：触发 / 抑制 / 光标 / IME / 节流 / 撞名 / 幂等） | `.tmp-verify/autorename.verify.test.ts` |
| `saveImage` 字节去重夹具（6 条） | `.tmp-verify/saveImage.verify.test.ts` |
| 验证专用 vitest 配置（根 config 的 include 不认 `.tmp-verify/`） | `.tmp-verify/vitest.verify.config.ts` |
| 空目录缺陷诊断（两条最小脚本） | `.tmp-verify/diagnose-empty-dirs.mjs`、`.tmp-verify/diagnose-rm.mjs` |
| 真实笔记本 dry-run 机器可读报告 | `.tmp-verify/notes-dryrun.json` |
| dry-run 前后全树 sha256 快照（1201 条，逐字节相同） | `.tmp-verify/notes-tree-before.txt`、`.tmp-verify/notes-tree-after.txt` |
| 工具源文件清单 vs 验证者独立盘点清单 | `.tmp-verify/tool-files.txt`、`.tmp-verify/mine-files.txt` |

复跑命令（按顺序）：

```powershell
cd E:\repo\opennote
npx tsc --noEmit                                   # exit 0
npx vitest run                                     # 63 passed | 1 skipped / 1039 passed | 2 skipped
npx vitest run --config .tmp-verify/vitest.verify.config.ts   # 3 files / 42 passed
node scripts/migrate-assets.mjs --workspace E:\repo\notes --dry-run          # exit 0
node .tmp-verify\diagnose-empty-dirs.mjs <临时工作区>                          # 复现 D1
```

---

## 9. 验证者边界声明

- 本次验证**未修改** `src/`、`scripts/` 下任何文件（只新增 `.tmp-verify/` 下的脚本与夹具）。
- 真实笔记本 `E:\repo\notes` 全程只读：只跑 `--dry-run`，且用全树 sha256 快照证明跑前跑后一个字节未变。
- 未对真实笔记本执行 `--apply`（按契约留给 t10，且需用户确认）。
- 验证者没有重跑实现者自己的测试文件作为结论依据；`§1.2` 的 1039 通过只用于**记录基线**，各判据的结论全部来自 `.tmp-verify/` 下自建夹具与自算脚本。
- 无法从静态/单测确认的点（如实列出，未假装确认）：真机 Electron 文件监听与 5 秒计时器是否成环、多进程/多窗口并发编辑下的 `conflictedNotes` 行为、FSA/OPFS 后端上的 `removeIfEmpty`（`handleBackend` 对目录 `stat` 返回 null，可能有另一套平台差异）。这三项需要真机运行验证。
