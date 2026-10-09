# t13 集成与真实迁移 · 交付说明（implementation-delivery）

> 执行人：migrator2 ｜ 任务：t13（attempt 1，attempt_id `ed25af55-41f9-4bae-952d-6ea5bc92d0c3`）
> 工作区：`E:\repo\opennote` ｜ 用户笔记本：`E:\repo\notes`（git 仓库，1200 文件 / 434 目录 / 174,855,672 字节）
> **最终状态：✅ 迁移已完成并全量验证（--apply 于 2026-10-09 22:24 执行，exit 0）。零数据损失、零新增裂图；遗留 1 个已知报告口径缺陷（不阻断数据安全，交回实现侧，队长将单开修复任务）。**

---

## 0. 结论速览

| 项 | 结果 |
| --- | --- |
| 前置门 | ✅ t12 复验 verdict=pass；复核门由 t15 review-round-2 verdict=pass 完成（t9 三次均为 API 基础设施错误 `no_healthy_account`，非结论性失败；后继集成任务 t10 的依赖已改为 `[t8, t15]`）；队长已正式放行 |
| 完整备份 | ✅ `.tmp-migrate/backup-20261009-215520/`，robocopy 全量复制 0 FAILED；备份时点全树 sha256 **1200/1200 逐字节一致**（含 `.opennote/state.json`）；apply 前又把应用退出时的最终落盘（state.json + 原子写 tmp，+1 文件）自愈重拷，终态 **1201/1201 逐字节一致** |
| dry-run（只读） | ✅ exit 0；数字与 t12 复验基线**逐字一致**（见 §3）；dry-run 前后全树 sha256 零漂移（一个字节没写） |
| 新发现缺陷（不阻断） | ⚠️ 死引用报告存在误报：55 条中 10 条解析目标真实存在（src/data/migrateAssets.ts:355-363 缺 exists 检查）。**只污染报告计数，不影响写盘行为**（详见 §4）；按契约不修 src/，交回实现侧 |
| --apply | ✅ 用户确认「已关闭 Opennote，立即执行迁移」+ 三重静默复核通过后，于 22:24 执行，exit 0：复制 208 / 复用 23（208+23=231 全部源文件都有着落）/ 改写 42 篇 196 条 / 删源 231 / **删空目录 40** / 保留非空 1（工作区根 assets/，按设计保留）/ 失败 0 / 并发跳过 0 |

---

## 1. 前置门核查（不得带着失败门开工）

| 门 | 证据 |
| --- | --- |
| t12 复验 verdict=pass | `.agent-teams/opennote-rename-title/team.json` t12 记录 + t12 交付报告（D1 关闭、真实笔记本 dry-run 数字逐字一致） |
| 复核门 pass | t9（独立复核）三次尝试均因 API `no_healthy_account` 失败（team.json t9.output 为 API 错误原文，非复核结论）；同一复核职责由 **t15 review-round-2** 完成，team.json t15.`verdict`=`"pass"`（7/7 验收项全过，无阻断级 findings）；任务板上后继集成任务 t10 的依赖已改接为 `["t8","t15"]`；队长开工指令明示「t15 复核已 pass、t12 复验此前已 pass，正式放行」 |
| 三个阻断级约束 | t15 已复核成立（不写 titleOverride / 等价光标下推 / 30s 静默期+IME 抑制），本任务不重演，只消费其结论 |

---

## 2. 完整备份（迁移前，已逐字节校验）

- **备份位置**：`E:\repo\opennote\.tmp-migrate\backup-20261009-215520\`（工作区外，避免递归进笔记本扫描口径）
- **方式**：`robocopy E:\repo\notes <dst> /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NP /MT:16`
- **复制结果**：Dirs 434/434、Files **1200/1200**、Bytes 166.75 MB（= 174,855,672 字节，与源全树 Measure-Object 逐字一致）、FAILED 0、robocopy exit 1（=有文件复制，属成功码）
- **逐字节校验**：源树与备份树全量 sha256（`Get-FileHash -Algorithm SHA256`，隐藏文件含 `.git`、`.opennote` 全部在内）
  - `manifest-source-pre.txt` vs `manifest-backup.txt`：**1200 = 1200，diffCount = 0**
  - 重点单项 `.opennote\state.json`：src `87c2a99e6046934a…` = backup `87c2a99e6046934a…` ✅
  - 备份期间应用未写入（无漂移，未触发自愈分支）
- **备份时点的笔记本实况（供回滚语境）**：git status --porcelain 4 条（`M 项目实战/system_panel/无标题 2.md`；未跟踪 `.assets/da36874a-….png`、`项目实战/system_panel/系统设计ABC.md`、`项目实战/恋爱模拟器/无标题.md`）——均为用户 20:14–20:33 的正常使用痕迹，迁移会原样保留其中所有新布局内容

## 2.1 dry-run 只读性证明

- dry-run 前全树清单 `manifest-source-pre.txt`（1200 条）与 dry-run 后 `manifest-source-post-dryrun.txt`（1200 条）**Compare-Object diffCount = 0**
- 即：两次 CLI 扫描（文本报告 + JSON 报告）合计对笔记本 **一个字节都没有写**

---

## 3. dry-run 读数（2026-10-09 21:56，当前磁盘实况）

命令：`node scripts/migrate-assets.mjs --workspace E:\repo\notes --dry-run`（文本版 `.tmp-migrate/dryrun-1.txt`，JSON 版 `.tmp-migrate/dryrun-1.json`，均 exit 0）

| 指标 | 本次读数 | t12 复验基线 | 一致? |
| --- | --- | --- | --- |
| 旧附件目录 | 23 | 23 | ✅ |
| 待迁移文件数 | 231 | 231 | ✅ |
| 内容组 / 重复组 / 去重省下 | 208 / 16 / **23** | 208 / 16 / 23 | ✅ |
| 同名不同内容让位（`-2`） | 0 | 0 | ✅ |
| 需要复制 / 复用已存在 | 208 / 0 | 208 / 0 | ✅ |
| 待改写引用 / 涉及笔记 | **196 条 / 42 篇** | 196 / 42 | ✅ |
| 写法分布（旧 `<笔记名>.assets/` + `./`公共 + 裸 assets/） | 9 + 7 + 180 | 9 + 7 + 180 | ✅ |
| 死引用（原样保留） | 55（指向附件 21） | 55（指向附件 21） | ✅（但含 10 条误报，见 §4） |
| 算不出工作区路径 | 0 | 0 | ✅ |
| 无引用文件（旧布局 / 共享 .assets/） | 35 / 0 | 35 / 0 | ✅ |

用户 20:14–20:33 的新动作（贴图进 system_panel/无标题 2.md、新建/编辑 恋爱模拟器/无标题.md）**全部落在新布局**，因此旧布局侧数字与 t12 基线零漂移——本身就是「新链路正常、旧数据待迁移」的一次现场验证。

**笔记 3（`项目实战/system_panel/无标题.md`）的 5 条改写计划**（dry-run JSON 实录，前缀层数正确）：

| 改写前 | 改写后 |
| --- | --- |
| `./无标题.assets/image.png` | `../../.assets/c84a80fa-fe73-575b-b9fd-ea4d30138a32.png` |
| `./无标题.assets/image 2.png` | `<../../.assets/6cf4abfd-1ce5-5646-a1aa-d0c60c96a2b9.png>` |
| `./无标题.assets/image 3.png` | `<../../.assets/297d119e-4f19-55fc-aa4f-7d44e271462b.png>` |
| `./无标题.assets/image 4.png` | `<../../.assets/295e09fd-722a-5db9-a210-2c58d958eb07.png>` |
| `./无标题.assets/image 5.png` | `<../../.assets/51577953-946d-587c-9d8e-cc20254ccc65.png>` |

---

## 4. ⚠️ 新发现缺陷：死引用报告误报 10/55（不阻断迁移，交回实现侧）

**现象**：55 条「死引用（原样保留）」中，有 10 条的解析目标**真实存在**，被错误记为死引用。

**根因**（读码定位，非猜测）：`src/data/migrateAssets.ts:355-363` —— 注释写明「可能是新布局（共享 `.assets/`，不该动），也可能是真的什么都没有，**只有后者才是死引用**」，但代码在 `!targetOfSource.has(resolved)` 分支**没有做 `backend.exists(resolved)` 检查**就一律记 `kind:"dead"`。

**逐条核验**（对每条死引用的解析目标做 `Test-Path` 实测）：

| # | 所在笔记 | 引用 | 解析目标（真实存在） | 类别 |
| --- | --- | --- | --- | --- |
| 1 | `.opennote/trash/菜鸟教程…2.md` | `../../.assets/2aff152e-….webp` | `.assets/2aff152e-0148-5798-95f8-c323cb783cf6.webp`（158,840B） | 共享 .assets 新布局 |
| 2 | `.opennote/trash/菜鸟教程…2.md` | `../../.assets/16f80b5e-….png` | `.assets/16f80b5e-294e-5899-83d0-aa2c976adcdc.png`（35,308B） | 共享 .assets 新布局 |
| 3 | `无标题.md`（根目录） | `.assets/ac44629b-….png` | `.assets/ac44629b-c595-5f19-968e-28ac9f160a4a.png`（167,862B） | 共享 .assets 新布局 |
| 4 | `项目实战/system_panel/无标题 2.md` | `../../.assets/da36874a-….png` | `.assets/da36874a-2a85-56cb-a80b-222aa5673b04.png`（200,183B，用户 20:14 所贴） | 共享 .assets 新布局 |
| 5 | `自言自语/project/无知者的荣耀.md` | `./img/python操作符优先级.png` | `自言自语/project/img/python操作符优先级.png` | 指向存在的图片（t5 §1.6a 曾记 img/ 不存在，现已存在） |
| 6–10 | golang/源码分析 4 篇笔记间链接 | `./gomock.md` 等 5 条 | 同目录 .md 均存在 | 笔记间链接 |

**影响评估（为什么不阻断）**：
1. **写盘路径不受影响**：该分支对引用**原样保留**（`after += text.slice(reference.start, reference.end)`，:352），不产生改写、不触发整篇回滚；含误报引用的笔记在待改写清单里为 0 条 ⇒ 迁移根本不会写这些文件。
2. **不参与收敛判据与退出码**：收敛 = 需要复制 0 且 待改写 0（方案 §3.1 阶段 D）；CLI 退出码只看 `failedCopies/failedNotes`（scripts/migrate-assets.mjs:207）。
3. **只污染两个报告计数**：`deadReferences` 55（实为 45 真死引用 + 10 误报）、`deadAssetReferences` 21（实为 17 + 4）。

**处置**：按 t13 契约「src/ 的进一步功能改动——发现缺陷交回对应实现任务」，本轮**不修**。建议 migration-eng 补一行 `else if (!(await backend.exists(resolved)))`（或等价）+ 2 条用例（指向现存共享文件的引用不报死 / 指向不存在的才报）。本缺陷已同步队长。

---

## 5. --apply 执行记录（2026-10-09 22:24，已全部完成）

**apply 前三重静默复核（22:23，全部通过后才动手）**：
1. 进程：`Get-CimInstance Win32_Process` 全量扫描 **无任何 electron/opennote 进程**（对比 21:51 有 4 个）；
2. 停写：state.json 最后写入 22:21:05（应用退出时的最终落盘，附带原子写 tmp），此后 2 分钟无任何新写入；
3. 备份重验：把 state.json + tmp 两份退出落盘**自愈重拷进备份**后全树重验 **1201/1201 diff=0**（自愈记录 `.tmp-migrate/drift-log.txt`）。

**命令**：`node scripts/migrate-assets.mjs --workspace E:\repo\notes --apply`（输出全文 `.tmp-migrate/apply-1.txt`，exit 0）

| 执行项 | 数值 |
| --- | --- |
| 复制（阶段 B） | 208 |
| 复用（组内去重，208+23=231） | 23 |
| 改写笔记 / 引用（阶段 C） | **42 / 196** |
| 删除源文件（阶段 D） | 231 |
| **删除空目录** | **40**（含 `项目实战/system_panel/无标题.assets` 与 3 个回收站孤儿 `.assets/`） |
| 保留（非空）目录 | 1 = 工作区根 `assets/`（方案 §3.7 按设计保留） |
| 复制校验失败 / 改写回滚 / 并发跳过 / 源丢失 | **0 / 0 / 0 / 0** |

**复扫收敛**：第 2 轮 dry-run（22:25）→ 待迁移 0 / 需复制 0 / 待改写 0 / 执行段全 0，**1 轮即收敛**（上限 3 轮未用满）；旧附件目录只剩工作区根空 `assets/`。

**state.json**：迁移前后 sha256 一致 —— 迁移器不触碰 state.json（自动改名相关的两张表原样保留）。

## 6. apply 后验证（全部通过，脚本与原始输出都在 .tmp-migrate/）

**6.1 改写引用反解校验 —— 不止抽 10 条，196 条全量**（`node .tmp-migrate/verify-refs.mjs`，只读）：
- **196/196 pass，0 失败，旧引用文本 0 残留**。每条校验四件事：① 新引用确实出现在正文；② `resolveWorkspacePath(新引用, parentPath(笔记))` 反解 **===** 迁移目标；③ 目标文件真实存在；④ **目标 sha256 === 备份里原始源文件 sha256**（字节级同一）。
- 10 条抽样（覆盖回收站三层前缀 / 一层 / 两层深度 / 角括号形态 / 中文名源）全部反解命中、exists=true、目标与源 sha 前 16 位逐字相等，例：`.opennote/trash/Agent 产出/无标题.md` 的 `./无标题.assets/image.png → ../../../.assets/6fcbec77-….png`（6fcbec7766834719 / 6fcbec7766834719）。
- **迁移引入的裂图数 = 0**。

**6.2 死引用最终口径（逐条人工核验，`node .tmp-migrate/verify-deadrefs.mjs` 直接调 `buildAssetMigrationPlan({limit:1e9})` 绕开 CLI 的 200 条 JSON 截断）**：

| 口径 | apply 前 | apply 后 |
| --- | --- | --- |
| 工具报「死引用」 | 55（指向附件 21） | 251（指向附件 217） |
| **真死引用（逐条 Test-Path 实测不存在）** | **45** | **45** |
| 误报（解析目标真实存在） | 10（指向附件 5） | 206（指向附件 201 = 196 条已成功改写、指向现存 `.assets/<uuid>` 的引用 + 5 条原有附件形/笔记链接） |
| 真死引用多重集差（note/ref/目标，含重复次数） | — | **仅 apply 前 = 0，仅 apply 后 = 0** |

**结论：迁移零新增死引用、零误删**。apply 后误报暴涨到 206 正是 §4 缺陷的自然延伸：apply 后迁移映射表为空，所有指向现存文件的引用（含 196 条刚改写成功的）都被误标——反解校验 196/196 pass 证明它们全是活的。

**C1 计数器已修复（t16）**：`rewriteAssetRefsIn` 计死前先问磁盘（`backend.exists`）；后端拒答的路径（`E:\…` 绝对路径，`assertSafeRelative` 当场抛错）视作「永不可能落在工作区里」照旧计死，扫描不被炸掉。引用文本的去留零变化——该判定只影响报告。修复后两轮实测读数与人工逐条核验**一致**：
- apply 前备份（`.tmp-migrate/backup-20261009-215520`）恢复到临时工作区 dry-run：待迁移 231 / **真死引用 45（指向附件 16）/ 误报 0**，45 条与 §4 人工核验表**多重集差 = 0**；
- 真实笔记本 `E:\repo\notes` dry-run：待迁移 0 / 死引用 45（指向附件 16）/ 误报 0，45 条与 t13 全量真死引用集合**多重集差 = 0**，全树 sha256 前后零漂移（一个字节没写）。

**口径修正（计数器已修复，工具读数与人工核验一致，45 条集合逐字相同）**：「指向附件」的细分以工具自身 `isAssetLikeRef` 为准是 **16（真死）+ 5（误报）= 21**——本文早期文本写的「17/4」是 t13 时的减法滑误：`isAssetLikeRef` 有图片扩展名兜底，`无知者的荣耀.md ← ./img/python操作符优先级.png` 这条**误报**（指向现存图片）本就是附件形，当时被错记进「笔记/图片链接」类。45 条真死引用集合本身自始至终两轮逐字一致，不受此影响。

**6.3 全树对照（迁移前 1201 文件 → 迁移后 1178；-231+208 自洽）**：
- 内容变化恰好 **42** 篇 `.md`（= 改写清单 42 篇：39 篇工作区 + 3 篇回收站笔记），0 条例外；
- 删除恰好 **231** 个旧布局附件（`assets/`、`*.assets/` 下），**0 条例外、`.opennote/history/` 零牵连**；
- 新增恰好 **208** 个文件且全部在 `.assets/`（共享目录 4 → **212** = 4+208，与去重后的内容唯一组数一致），0 条例外；
- **`.opennote/history/` 47 个条目前后 sha256 零差异**；state.json 前后一致。
- git 形状自洽：M 40（39 迁移改写 + 1 用户 20:15 自己的改动）/ D 227（231 − 4 个本就未被 git 跟踪的回收站孤儿图）/ ?? 211（208 新图 + 3 个迁移前已存在的未跟踪文件）。

**6.4 回收站孤儿目录（4 张图）—— 按预期整理**：
- `Agent 产出/无标题.assets/image.png` → `.assets/6fcbec77-….png` ✅ 字节一致；`image 2.png` → `.assets/3a6b6f2a-….png` ✅；
- `刷 B 站….assets/35a62705-….png` → `.assets/35a62705-61a9-…` ✅ 字节一致；`无标题.assets/345e3163-….png` → `.assets/31748296-….png` ✅；
- 3 个孤儿 `.assets/` 源目录全部从磁盘消失；独立备份 `.tmp-title/trash-orphan-backup-20261009-192809/` 4 文件原样未动。

**6.5 七篇占位笔记 vs 方案 §3（逐一核对）**：

| # | 方案 §3 预期 | 迁移后磁盘实况 | 判定 |
| --- | --- | --- | --- |
| 1 `AI智能时代/无标题.md` | 保持不动（空文件） | 原位原名，0B | ✅ |
| 2 `无标题.md`（根） | 保持不动（一行图片） | 原位原名 93B，其 `.assets/ac44629b-…` 引用原样 | ✅ |
| 3 `项目实战/system_panel/无标题.md` | 等附件迁移后改 `修改提示词.md` | 仍是占位名；**5 张图已全部改写为新布局**、`无标题.assets/` 目录已删、**条件 12 解除**——用户在应用里编辑该笔记停笔 5 秒即安全改名（硬顺序已达成） | ✅（数据前提全部就绪） |
| 4/5 `恋爱模拟器/无标题 2、3.md` | 改名 | 仍占位名（用户侧应用尚未含自动改名功能，磁盘从未触发过；state.json `titlePinnedAt` 为空） | ✅（改名动作由应用在编辑时执行，非 CLI 职责） |
| 6 `system_panel/无标题 2.md` | 改名 | 仍占位名，用户 20:15 所贴新布局图引用原样 | ✅ |
| 7 `恋爱模拟器/无标题.md` | 保持不动（无真标题行） | 原位原名 1586B | ✅ |

非占位笔记被波及 **0** 篇（方案 §3 汇总行成立）；任何占位笔记都未被本迁移改名（改名只能由应用侧 `autoRenameFromPlaceholder` 触发，且现在再无裂图风险）。

**6.6 全量测试**：`npx tsc --noEmit` → **exit 0**；`npx vitest run` → 63 文件，**1056 passed / 2 skipped**，exit 0（与 t15 复核基线逐字一致，零回归）。

## 7. 遗留问题（汇总）

1. **死引用计数器缺陷（✅ 已在 t16 修复并双工作区实测验证）**：根因 `src/data/migrateAssets.ts:355-363` 的 dead 判定缺 `exists` 检查。**最终口径（逐条人工核验 = t16 修复后工具读数）：apply 前真死引用 45（指向附件 16）、误报 10（指向附件 5）；apply 后真死引用 45（指向附件 16）、误报 206（196 条已改写成功的活引用 + 5 条原有附件形/链接误报；总数 21 的附件形拆分不变）**。修复方式（exists 检查 + 后端拒答按「不在工作区」计死）与行为零变化论证见 §6.2 C1 段；该缺陷自始至终只污染报告计数，写盘路径不受影响（§4 三条影响论证 + 196/196 反解实证）。
2. **观察项（低风险，无需动作）**：`刷 B 站….assets/35a62705-01f2e32fe9bc2b722561edf06be13ac2d101950d.png` 迁移后落名为 `.assets/35a62705-61a9-5c7a-93e4-7f951e3baf52`（**无扩展名**）——这是 `assetFinalName` 对超长横线名的既有行为（与剪藏新链路同一唯一产地，方案 §3.1 明确要求复用、不另抄公式），其引用已被同步改写且反解校验通过；仅该回收站笔记引用此图。
3. **IME 尾态边缘 case**（t15 low 观察项，~5 行可补）——队长明示不在 t13 范围，随真机 IME 实测一并评估。
4. **真机 IME / Electron 文件监听 / 三后端真机 move / 快照恢复交互**——静态无法确认项（t15 如实声明），不在本轮可验面内。
5. 45 条真死引用为**迁移前既成事实**（跨机器绝对路径、已不存在的 trash `.assets/`、断链笔记链接等），按设计「死引用本来就死，绝不猜」原样保留。
6. **后续提示**：用户更新应用后，占位笔记 #3/#4/#5/#6 会在编辑停笔 5 秒后自动改名（其中 #3 的裂图风险已被本次迁移拆除）；迁移器写入 `.assets/` 的 212 个文件与改写后的引用即新布局基线，旧目录已清空（仅工作区根 `assets/` 空壳按设计保留）。

## 7.1 真机实测回修（2026-10-09 23:10，队长直接修，非团队轮次）

用户按预期流程实测（新建笔记 → 写标题 → 停笔等 5 秒）**一次都没有触发改名**。根因不在判据本身，而在调度层：`scheduleAutoRename()` 排定时器时的预检把**瞬态**拦截（光标在标题行 / 输入法合成中 / 新建静默期）当成终态，定时器整个不排——打字过程里这些条件必然成立，停笔后没有任何新触发点。修了四处：

1. **删除「光标还在标题那一行」判据**及整条 `setEditorCursorLine` 下推通道：自然流程里光标必然停在标题行，「用户还在编辑」由 5 秒防抖保证，光标位置只会帮倒忙。
2. **瞬态失败改为「照排定时器，到点再判，仍不满足按 2 秒短重试（上限 45 次 ≈ 90 秒）」**；只有稳定失败（非占位 / 有 override / 无真标题 / 旧附件引用 / 只读锁 / 总开关关）才直接放弃。
3. **输入法合成结束（compositionend）主动重排一次**：合成结束就是停笔的自然终点，不再要求用户「再改一次内容」才触发改名（顺手关闭了 t15 的 low 观察项）。
4. 行为预期随之明确：**存量占位笔记**停笔 5 秒改名；**刚新建的笔记**因 10 秒创建静默期（保护导入/剪藏场景，见 `NEW_NOTE_QUIET_MS` 注释）会在创建后约 10~12 秒改名。

测试：`library.files.test.ts` 的光标/合成两条用例改写为新语义，`npx vitest run` 1059 通过 / 2 skipped，`npx tsc --noEmit` 干净。真机复测步骤：重启应用 → 打开一篇占位名笔记 → 改标题 → 停笔；新建笔记则等约 10 秒。

## 8. 回滚方法（在 apply 之后仍然有效）

前提：先关闭 Opennote（避免回滚与应用写入打架）。

```powershell
# 用备份镜像整树还原（/MIR 会删除备份之后新建的文件！执行前必须人工确认备份后没有需要保留的新增内容）
robocopy E:\repo\opennote\.tmp-migrate\backup-20261009-215520 E:\repo\notes /MIR /COPY:DAT /DCOPY:DAT /R:1 /W:1
# 校验：还原后全树 sha256 应与 manifest-source-pre.txt 完全一致
```

- 备份包含 `.git`、`.opennote/`（state.json、history、trash）全量，还原即回到 2026-10-09 21:55:20 的完整状态。
- 迁移器自身的 A→B→C→D 顺序保证：阶段 D（删源）之前源文件始终在，最坏中间态是「多一份冗余」而不是「丢图」。
- 更细粒度的对照：`manifest-source-pre.txt`（迁移前基线）逐文件比对。

## 9. 本轮产物清单（.tmp-migrate/）

| 文件 | 说明 |
| --- | --- |
| `backup-20261009-215520/` | 完整备份（1200 文件，sha256 已验） |
| `manifest-source-pre.txt` / `manifest-backup.txt` / `manifest-source-post-dryrun.txt` | 迁移前源树 / 备份树 / dry-run 后源树三份 sha256 清单 |
| `dryrun-1.txt` / `dryrun-1.json` | dry-run 报告（人读版 / 机器版，apply 前） |
| `apply-1.txt` | --apply 执行输出全文（exit 0） |
| `dryrun-2.txt` / `dryrun-2.json` / `dryrun-2-full.json` | 复扫第 2 轮（收敛证明；full 版为 --limit 2000，但 issues 仍受实现内 200 条上限约束，全量核验见下） |
| `verify-refs.mjs` | 196 条改写全量反解 + 字节级校验脚本（196/196 pass，含 10 条抽样输出） |
| `verify-deadrefs.mjs` | 死引用全量口径核验脚本（直调 `buildAssetMigrationPlan({limit:1e9})`；真死引用 45↔45 多重集差 0） |
| `deadref-genuine-pre.txt` / `deadref-genuine-post.txt` | 真死引用集合（apply 前 / 后） |
| `manifest-source-post-apply.txt` | 迁移后全树 sha256 清单（对照用） |
| `drift-log.txt` | apply 前备份自愈记录（state.json + 原子写 tmp） |
| `tsc.log` / `vitest.log` | 全量测试原始输出（exit 0 / 1056 passed 2 skipped） |
| `last-backup-path.txt` | 备份路径指针 |
