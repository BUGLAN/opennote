# 标题派生优先级与「按 H1 自动改名」的实证报告（t3）

- 任务：`t3` —— 实证 H1 命名为何没落到文件名上 + 量出迁移爆炸半径
- 执行者：`empirical-check`（attempt 1）
- 装置：`.tmp-title/title-precedence.test.ts`（数据层最小用例，14 例）+ `.tmp-title/scan-notes.mjs`（真实笔记本只读盘点）
- 原始输出：`.tmp-title/test-output.txt`（测试）、`.tmp-title/scan-output.txt`（盘点）
- 前置依赖：`docs/title-source-of-truth.md`（t1 的静态测绘）。本报告只负责**把它钉在可复现的运行结果上**，不重复读代码得出的结论。

**一句话结论**：`# 系统设计` 写进正文后，`note.title` 立刻变成「系统设计」，但**磁盘文件名一步都不动**，全流程**没有任何 `move()` 调用** —— 这不是 bug，是「H1 → 文件名」这条能力从未存在；而一旦要补上它，本机 481 篇笔记里有 **364 篇（75.7%）** 的文件名与正文标题不一致，其中 **5 组同目录撞名**、**17 篇的标题会被 `sanitizeName` 洗掉**、**49 篇的「标题」其实只是正文首行（含图片 alt 文本）**；更要命的是用户现有的 4 篇「无标题 + 正文有真标题」**一篇都不是 H1**（3 篇 h2 + 1 篇普通行），所以「只认 H1 就自动改名」在这台机器上实际改 **0 篇**。

---

## 0. 结论速览（每条都有对应的运行读数）

| # | 结论 | 证据 |
|---|---|---|
| E1 | 正文写 `# 系统设计` → `note.title = 系统设计`，磁盘文件名**仍是** `无标题.md`，且**零 `move()`** | A1a/A1b/A1c |
| E2 | 文件名 vs 正文标题冲突时**正文赢**；文件名只在正文「一个可用行都没有」时当标题 | A2a/A2b |
| E3 | `renameNote` 是「搬文件 + 写 `titleOverride` + 立刻落 `state.json`」，**不改写正文一个字节** | A3a |
| E4 | `titleOverride` 的压制力是**单向且永久**的：写进正文的新标题顶不回显示名；反过来，没 override 的笔记显示名完全由正文决定 | A4a/A4b |
| E5 | 撞名时 `renameNote` 把**请求名**（不是落盘名）写进 `titleOverride` → 磁盘 `系统设计 2.md` 而显示名是 `系统设计`，两者静默分叉 | A5a |
| E6 | 文件夹改名时 `titleOverride` 的键跟着前缀走，显示名不丢 | A6a/A6b |
| E7 | 天真实现「停笔后拿 `deriveTitle` 的结果去 `renameNote`」会**顶掉用户手改的名字**（A7b） | A7b |
| E8 | 迁移半径：文件名 ≠ 正文标题的笔记 **364 / 481 = 75.7%**；其中标题来自 h1 的 106、h2~h6 的 209、普通行的 49 | 口径 3、口径 4 |
| E9 | 「只认 H1」规则在本机实际改 **0 篇**用户的 `无标题` 笔记（它们全是 h2 或普通行） | 口径 2 |
| E10 | 5 组同目录笔记会算出同一个目标名（`面试圣经/` 里 6 篇都叫「一二面」）→ 只能落 `一二面 2.md … 6.md` | 口径 4d |
| E11 | 17 篇的标题含 `:` `/` `?` 等字符，`sanitizeName` 会洗掉 → 磁盘名与显示名分叉 | 口径 4c |

---

## 1. 实验装置与「没有改 src/」的证据

### 1.1 为什么必须带 `--config`

`vitest.config.ts:6` 的 include 只有 `src/**/*.test.ts` 与 `src/clip-web/**/*.test.ts`，`.tmp-title/` 不在其中。任务书要求的裸命令**真的跑了**，原始输出如下（`.tmp-title/test-output-bare.txt`）：

```
 RUN  v5.0.2 E:/repo/opennote

No test files found, exiting with code 1

filter: .tmp-title/title-precedence.test.ts
include: src/**/*.test.ts, src/clip-web/**/*.test.ts
exclude:  **/node_modules/**, **/.git/**
```

这不是失败断言，是「测试没被收集」。因此补一个只放宽 include 的临时配置 `.tmp-title/vitest.title.config.ts`（**不改根 `vitest.config.ts`**），实际执行命令：

```bash
npx vitest run --config .tmp-title/vitest.title.config.ts .tmp-title/title-precedence.test.ts
```

### 1.2 脚手架照抄，未另造

`MemoryBackend` / `record` / `openWorkspace` / `rescanWorkspace` / `flushMeta` / `flushAll` / `renameNote` / `updateNoteContent` 全部逐字照抄 `src/data/library.files.test.ts:33-125`，mock 也是同一句 `vi.mock(...workspaces...)`（路径改为 `../src/data/workspaces`）。

### 1.3 硬性要求核对

- 新增文件只落在 `.tmp-title/`：`title-precedence.test.ts`、`scan-notes.mjs`、`vitest.title.config.ts`、两份原始输出 txt。
- `git status --porcelain` 里没有任何 `src/` 条目；`git diff --stat -- src` 输出为空。
- `scan-notes.mjs` 只用 `readdir` / `stat` / `readFile`；遍历时**任一路径段以 `.` 开头就整棵跳过**（照抄 `src/fs/paths.ts:71-75` 的 `isHiddenPath`），所以 `.opennote/`、`.git/`、`.assets/` 既没读也没写。

---

## 2. 任务 A —— 数据层最小用例（14 例全绿）

```
 ✓ .tmp-title/title-precedence.test.ts (14 tests) 19ms

 Test Files  1 passed (1)
      Tests  14 passed (14)
   Start at  19:28:15
   Duration  305ms (transform 68%, import 22%, tests 8%, worker 1%)
```

### A1 用户不满的现场：H1 有了，文件名没动

**A1a（已有 `无标题.md` + 正文 `# 系统设计`）**

```
[A1a] note.title = 系统设计 | note.titleOverride = null
[A1a] 磁盘 .md = ["无标题.md"]
[A1a] 移动调用 = []
```

断言与读数一致：`title === "系统设计"`、磁盘只有 `无标题.md`、不存在 `系统设计.md`、**磁盘正文逐字节未变**、`testBackend.moves()` 为空数组。这就是「H1 自动命名保留了，但文件名停在 无标题.md」的硬证据 —— 标题算出来了，只是没有任何一条代码把它送到文件名上。

**A1b（真实现场：`createNote()` 建 `无标题.md` → 编辑器里打 `# 系统设计`）**

```
[A1b] createNote 落到 = 无标题.md
[A1b] 打字后 note.title = 系统设计 | 磁盘 .md = ["无标题.md"]
[A1b] 移动调用 = []
```

走的是真链路 `updateNoteContent()`（`src/data/library.ts:1037`）→ `refresh()`（`:1044`）→ `deriveTitle()`（`:223`）。打字之后显示名变成「系统设计」，磁盘名一个字节没动，**依然零 `move()`**。

**A1c（停笔 / 重扫 / 重开笔记本）**

```
[A1c] 重开后 磁盘 .md = ["无标题.md"]
```

`flushMeta()` + `closeWorkspace()` + `openWorkspace()` 之后文件名照旧。合起来：**「停笔 5 秒」缺的不是等待时间，是那条把 H1 变成 `move()` 的调度**（与 t1 §5 的静态结论一致，这里给出了运行时反证）。

### A2 文件名 vs 正文标题：正文赢

```
[A2a] 文件名=系统设计.md | note.title = 修改提示词
[A2b] 全是围栏代码时 note.title = 系统设计
```

A2a 用的是**用户笔记里真实存在的那一篇**（`项目实战/system_panel/无标题.md`，首行 `## 修改提示词`）：文件名 `系统设计.md` 输给了正文的 h2。A2b 证明 `deriveTitle` 的 fallback（`src/lib/utils.ts:85`）只有在正文「一个可用行都没有」时才生效 —— 即文件名在这套逻辑里是**兜底值**，不是竞争者。

### A3 `renameNote` 的真实语义

```
[A3a] note.title = 系统设计 | titleOverride = 系统设计
[A3a] 磁盘 .md = ["系统设计.md"]
[A3a] state.json titleOverrides = {"系统设计.md":"系统设计"}

[A3b] 重扫后 title = 我的设计稿
[A3b] 重开后 title = 我的设计稿
```

A3a：`renameNote("无标题.md","系统设计")` 一次调用做三件事 —— 搬文件、写内存 `titleOverride`、把 `.opennote/state.json` 的 `titleOverrides` 落成 `{"系统设计.md":"系统设计"}`；**正文逐字节未变**（`expect(testBackend.text("系统设计.md")).toBe("# 系统设计\n正文一段\n")`），印证对话框那句「重命名只改显示名；正文里的一级标题不会被改写」。
A3b：`我的设计稿` 这个名字在重扫、重开笔记本之后都活着 —— **dce308b 修的那条确实修好了**（对照 t1 §9「已确认」）。

### A4 `titleOverride` 的压制力

```
[A4a] 改正文标题后 note.title = 我的设计稿
[A4b] 无 override 时改 H1 → title = 改了标题
```

A4a：改名之后用户把正文标题行改成 `# 完全换了的标题`，显示名**不跟随**，重扫后仍是「我的设计稿」；同时磁盘正文确实写进去了 —— override 只挡显示名，不挡正文。
A4b：反向对照，没有 override 的笔记显示名完全跟着正文跑（`系统设计` → `改了标题`），**但文件名依然是 `无标题.md`**。两个方向合起来说明：显示名与文件名是两个独立通道，**没有任何一条规则让文件名跟随正文**。

### A5 撞名：显示名与磁盘名静默分叉（新发现，t1 未列）

```
[A5a] 磁盘 .md = ["系统设计 2.md","系统设计.md"]
[A5a] note.title = 系统设计 | titleOverride = 系统设计
[A5a] state.json titleOverrides = {"系统设计 2.md":"系统设计"}
```

`resolveAvailablePath()`（`src/data/library.ts:822-838`）把文件挪到了 `系统设计 2.md`，但 `renameNote` 写进 `titleOverride` 的是 `clean`（= **请求名**，`:1171`/`:1173`），不是最终落盘名。后果：侧栏显示「系统设计」，磁盘上是 `系统设计 2.md`。这对自动改名是**硬约束** —— 如果直接复用 `renameNote`，撞名时用户会看到「名字没变但文件多了一个 2」，而且 `state.json` 里那条 override 会让后续任何一次重扫都保持这个分叉。

### A6 文件夹改名：override 的键跟着前缀走

```
[A6a] 改名前 titleOverrides = {"资料/设计稿.md":"设计稿"}
[A6a] 改名后 磁盘 .md = ["归档/设计稿.md"]
[A6a] 改名后 titleOverrides = {"归档/设计稿.md":"设计稿"}
[A6a] 改名后 title = 设计稿
```

`renameFolder()`（`:1608`）→ `remapIds(..., {prefix:true})`（`:1621`）→ `:1898-1900` 的 `titleOverrides` 键替换，一条链走通，**显示名不丢**。A6b 是对照组：同一目录下没写过 override 的笔记，改名后显示名照旧由正文派生（`正文里的标题`）。

### A7 自动改名的副作用读数

```
[A7a] .md 数量 before/after = 1 / 1
[A7a] state.json 顶层键 = ["expanded","lastOpened","starred","titleOverrides","version"]
[A7a] 全部 move = ["move:无标题.md->系统设计.md"]

[A7b] 自动改名之前 title/titleOverride = 我手改的名字 / 我手改的名字
[A7b] 自动改名之后 磁盘 .md = ["系统设计.md"]
[A7b] 自动改名之后 title/titleOverride = 系统设计 / 系统设计
```

A7a：一次 `renameNote` 恰好产生 1 次 `move`、0 次新增/删除笔记，并新占一个 `state.json` 顶层键 `titleOverrides`。这既说明「用 `renameNote` 当自动改名的动作原语」在磁盘侧是干净的，也说明每改一次名都会往 `state.json` 里加一条永久记录（迁移/清理要一并考虑）。

A7b 是**最需要下游注意的一条**：先手动改名成「我手改的名字」，再模拟「停笔后按正文标题自动改名」——用户手改的名字被**顶掉**了，磁盘也从 `我手改的名字.md` 变回 `系统设计.md`。所以自动改名**必须**先跳过「这篇有 `titleOverride`」的笔记；否则每次停笔都会覆盖用户上一次的显式决定。

---

## 3. 原始测试输出（完整，未删改）

来源：`.tmp-title/test-output.txt`（`npx vitest run --config .tmp-title/vitest.title.config.ts .tmp-title/title-precedence.test.ts`，exit 0）。

```
 RUN  v5.0.2 E:/repo/opennote

stdout | .tmp-title/title-precedence.test.ts > A1 正文 H1 与磁盘文件名的关系（现场复现） > A1a 已有 无标题.md，正文 `# 系统设计`：note.title=系统设计，磁盘文件名**不变**
[A1a] note.title = 系统设计 | note.titleOverride = null
[A1a] 磁盘 .md = ["无标题.md"]
[A1a] 移动调用 = []

stdout | .tmp-title/title-precedence.test.ts > A1 正文 H1 与磁盘文件名的关系（现场复现） > A1b 用户真实现场：新建 无标题.md → 在编辑器里打 `# 系统设计` → 文件名仍是 无标题.md
[A1b] createNote 落到 = 无标题.md

stdout | .tmp-title/title-precedence.test.ts > A1 正文 H1 与磁盘文件名的关系（现场复现） > A1b 用户真实现场：新建 无标题.md → 在编辑器里打 `# 系统设计` → 文件名仍是 无标题.md
[A1b] 打字后 note.title = 系统设计 | 磁盘 .md = ["无标题.md"]
[A1b] 移动调用 = []

stdout | .tmp-title/title-precedence.test.ts > A1 正文 H1 与磁盘文件名的关系（现场复现） > A1c 停笔之后（重扫 / 重开笔记本）文件名依旧不跟随正文 H1
[A1c] 重开后 磁盘 .md = ["无标题.md"]

stdout | .tmp-title/title-precedence.test.ts > A2 文件名 vs 正文标题：正文赢 > A2a 文件 系统设计.md、正文首行 `## 修改提示词` → note.title=修改提示词
[A2a] 文件名=系统设计.md | note.title = 修改提示词

stdout | .tmp-title/title-precedence.test.ts > A2 文件名 vs 正文标题：正文赢 > A2b 正文里连一个可用行都没有时，文件名才当标题（fallback 生效）
[A2b] 全是围栏代码时 note.title = 系统设计

stdout | .tmp-title/title-precedence.test.ts > A3 renameNote 的真实语义 > A3a renameNote('无标题.md','系统设计')：写 override + 搬文件 + **正文一个字节不改**
[A3a] note.title = 系统设计 | titleOverride = 系统设计
[A3a] 磁盘 .md = ["系统设计.md"]
[A3a] state.json titleOverrides = {"系统设计.md":"系统设计"}

stdout | .tmp-title/title-precedence.test.ts > A3 renameNote 的真实语义 > A3b 重命名后重扫 / 重开：显示名不再被正文 H1 顶回去（dce308b 修的这条）
[A3b] 重扫后 title = 我的设计稿

stdout | .tmp-title/title-precedence.test.ts > A3 renameNote 的真实语义 > A3b 重命名后重扫 / 重开：显示名不再被正文 H1 顶回去（dce308b 修的这条）
[A3b] 重开后 title = 我的设计稿

stdout | .tmp-title/title-precedence.test.ts > A4 titleOverride 对正文的压制力 > A4a 改名后用户又把正文标题行改成别的：显示名**不跟随**，永远是 override
[A4a] 改正文标题后 note.title = 我的设计稿

stdout | .tmp-title/title-precedence.test.ts > A4 titleOverride 对正文的压制力 > A4b 反过来：没写过 override 的笔记，显示名**完全**由正文决定（H1 一改就跟着变）
[A4b] 无 override 时改 H1 → title = 改了标题

stdout | .tmp-title/title-precedence.test.ts > A5 同名冲突：resolveAvailablePath 之后显示名与磁盘名分叉 > A5a 目标名已被占用 → 文件落成 系统设计 2.md，但 title/titleOverride = 系统设计
[A5a] 磁盘 .md = ["系统设计 2.md","系统设计.md"]
[A5a] note.title = 系统设计 | titleOverride = 系统设计
[A5a] state.json titleOverrides = {"系统设计 2.md":"系统设计"}

stdout | .tmp-title/title-precedence.test.ts > A6 文件夹改名后子笔记的 titleOverride > A6a 资料/ → 归档/：override 键跟前缀走，显示名还在
[A6a] 改名前 titleOverrides = {"资料/设计稿.md":"设计稿"}

stdout | .tmp-title/title-precedence.test.ts > A6 文件夹改名后子笔记的 titleOverride > A6a 资料/ → 归档/：override 键跟前缀走，显示名还在
[A6a] 改名后 磁盘 .md = ["归档/设计稿.md"]
[A6a] 改名后 titleOverrides = {"归档/设计稿.md":"设计稿"}
[A6a] 改名后 title = 设计稿

stdout | .tmp-title/title-precedence.test.ts > A6 文件夹改名后子笔记的 titleOverride > A6b 反例：文件夹里那篇**没写过 override** 的笔记，改名后显示名照旧由正文派生
[A6b] 磁盘 .md = ["归档/随便.md"]
[A6b] title = 正文里的标题

stdout | .tmp-title/title-precedence.test.ts > A7 自动改名的副作用读数（迁移影响面） > A7a 一次 renameNote 会搬文件 + 写 override + 动 state.json；且**不会**再写一份新笔记
[A7a] .md 数量 before/after = 1 / 1
[A7a] state.json 顶层键 = ["expanded","lastOpened","starred","titleOverrides","version"]
[A7a] 全部 move = ["move:无标题.md->系统设计.md"]

stdout | .tmp-title/title-precedence.test.ts > A7 自动改名的副作用读数（迁移影响面） > A7b 自动改名必须先判「这篇有没有 override」：否则用户手改的名字会被下一次改名顶掉
[A7b] 自动改名之前 title/titleOverride = 我手改的名字 / 我手改的名字

stdout | .tmp-title/title-precedence.test.ts > A7 自动改名的副作用读数（迁移影响面） > A7b 自动改名必须先判「这篇有没有 override」：否则用户手改的名字会被下一次改名顶掉
[A7b] 自动改名之后 磁盘 .md = ["系统设计.md"]
[A7b] 自动改名之后 title/titleOverride = 系统设计 / 系统设计

 ✓ .tmp-title/title-precedence.test.ts (14 tests) 19ms

 Test Files  1 passed (1)
      Tests  14 passed (14)
   Start at  19:28:15
   Duration  305ms (transform 68%, import 22%, tests 8%, worker 1%)
```

### 3.1 仪表误差（如实记录，不改断言换绿）

**第一次运行是 `2 failed | 12 passed`**，两个红分别是 A1b 与 A4b，失败断言都是同一句：

```
AssertionError: expected [ …(2) ] to deeply diff [ '无标题.md' ]

- Expected
+ Received

  [
+   ".opennote/history/无标题.md/2026-10-09-19-25-35.807-auto.md",
    "无标题.md",
  ]
```

根因在**量具**不在被测对象：我的 `mdFiles()` 一开始把所有 `.md` 都算成「用户笔记」，而历史快照目录 `.opennote/history/<笔记名>/<时间戳>-auto.md`（由 `updateNoteContent` → `maybeSnapshot` 产生）也是 `.md`。

处理方式：修量具（`mdFiles()` 排除 `.opennote/` 前缀），**断言一个字没改**（「用户笔记的文件名没变」）。改后 14 例全绿。保留此节是因为这两条红不是产品缺陷，不应被下游当成证据引用。

---

## 4. 任务 B —— 用户真实笔记本只读盘点

装置：`.tmp-title/scan-notes.mjs`，根目录 `E:\repo\notes`，只做 `readdir`/`stat`/`readFile`。判定规则逐条照抄 `src/lib/utils.ts:61-86`（front matter、围栏、`#`~`######`、跳过 `>`/`|`/`---`/`***`/`___`、否则取首个非空行、都没命中则 fallback = 文件名 stem），笔记范围照抄 `isMarkdownPath()`（md/markdown/mdown/mkd/txt）+ `isHiddenPath()`。完整原始输出见 `.tmp-title/scan-output.txt`（351 行）。

### 4.1 总量与四组口径

```
【总量】
  笔记文件总数（md/markdown/mdown/mkd/txt，已排除隐藏路径）：481
  其中 .md：474
  读不出来的文件：0

【口径 1】文件名像「无标题」/「无标题 N」的笔记
  数量：5（占全部 1.0%）
【口径 2】其中「正文有真标题、且与文件名不同」的（= 自动改名真正要动的那批）
  数量：4
  这批的标题来源：h1 0 篇 / h2~h6 3 篇 / 非标题行 1 篇
  → 「只认 H1」的自动改名在这台机器上实际会改：0 篇
【口径 3】正文首个标题与文件名 stem 不一致的笔记总数（迁移影响面）
  数量：364（占全部 75.7%）

【正文首个标题的来源分布】
  标题行（#~######）：391
  首个非空行（无标题行时的兜底）：49
  正文里没有可用行 → 拿文件名当标题（deriveTitle fallback）：41
```

**E9 是本次盘点最反直觉、也最影响方案的一条**：用户现在受影响的 `无标题` 笔记一共 5 篇，其中正文有真标题的 4 篇里，**没有一篇的首个标题是 H1** —— 3 篇是 `##`（h2），1 篇是普通行（图片 alt 文本）。所以：

- 若规则写成「首个标题是 H1 才自动改名」→ 在这台机器上**实际改 0 篇**，用户的问题一个都没解决；
- 若规则放宽到「任意级别的首个标题」→ 4 篇里有 3 篇能改，剩下 1 篇会把文件名改成 `3f1c9589f284944860bef0e22aecc5b0_720.png.md`（见 4.3）。

### 4.2 五个「无标题」笔记的全部明细（口径 1）

```
   1. AI智能时代/无标题.md
      文件名：无标题.md
      首个标题："无标题"（fallback）
   2. 无标题.md
      文件名：无标题.md
      首个标题："3f1c9589f284944860bef0e22aecc5b0_720.png"（line）
   3. 项目实战/system_panel/无标题.md
      文件名：无标题.md
      首个标题："修改提示词"（heading h2）
   4. 项目实战/恋爱模拟器/无标题 2.md
      文件名：无标题 2.md
      首个标题："恋爱模拟器综合设计"（heading h2）
   5. 项目实战/恋爱模拟器/无标题 3.md
      文件名：无标题 3.md
      首个标题："恋爱模拟器设计提示词"（heading h2）
```

`AI智能时代/无标题.md` 是空文件（deriveTitle 落到 fallback），**自动改名必须放过它**（没有标题就没有新名字）。

### 4.3 口径 4a：标题来自「非标题行」的 49 篇 —— 改名会拿到垃圾名

```
   1. AI智能时代/claudecn.com/docs/.../01_什么是 Claude Code_What-IS-Claude-Code/index.md
      首个标题："什么是 Claude Code"（line）
   ...
  10. AI智能时代/claudecn.com/docs/.../02_JetBrains 集成_JetBrains/index.md
      首个标题："JetBrains 集成"（line）
```

49 篇的「标题」其实是正文首个非空行。极端案例就是上面那篇用户笔记 `E:\repo\notes\无标题.md`，全文只有一行：

```
![3f1c9589f284944860bef0e22aecc5b0_720.png](.assets/ac44629b-c595-5f19-968e-28ac9f160a4a.png)
```

`cleanInline` 把图片语法洗成 alt 文本（`src/lib/utils.ts:91`），于是 `deriveTitle` 返回 `3f1c9589f284944860bef0e22aecc5b0_720.png`。**如果自动改名直接用 `deriveTitle` 的输出，这篇会被改名成 `3f1c9589f284944860bef0e22aecc5b0_720.png.md`。** 因此规则必须要求「首个标题来自真正的标题行」，而不是 `deriveTitle` 的任意输出。

### 4.4 口径 4c：17 篇的标题会被 `sanitizeName` 洗掉

```
   1. .../09_上下文角色_Context-Roles/index.md
      标题："上下文角色：开发 / 调研 / 审查"
      落盘名："上下文角色：开发 调研 审查"
   6. 工作中的技巧/code-segment.md
      标题："* # 解析struct, 并输出到标准输入输出(带有友好格式)"
      落盘名："# 解析struct, 并输出到标准输入输出(带有友好格式)"
   7. 数据库/mongo/mongo-索引.md
      标题："见: https://juejin.cn/post/6844903591166083086"
      落盘名："见 https juejin.cn post 6844903591166083086"
  10. 自言自语/platform/the-way-vim/1-copy-content.txt
      标题："...We're waiting for copy before the site can go live..."
      落盘名："We're waiting for copy before the site can go live"
```

`sanitizeName()`（`src/fs/paths.ts:85-92`）会把 `\ / : * ? " < > |` 换成空格、折叠空白、去掉首尾点与空白、截到 80 字。这 17 篇里，标题（显示名）与落盘名会**必然不同**。这解释了 A5 那类分叉为什么不是边角情况，而是这套命名方案的常态。

### 4.5 口径 4d：5 组同目录撞名 —— 最危险的一批

```
   1. 目标：语言和技术学习/golang/golang 错误处理最佳实践.md
      语言和技术学习/golang/golang-error-best-practice.md
      语言和技术学习/golang/golang错误处理最佳实践.md
   2. 目标：语言和技术学习/源码分析/gin-v0.1源码分析.md
      语言和技术学习/源码分析/gin-core-v0.1.md
      语言和技术学习/源码分析/gin-core-v1.5.0.md
   3. 目标：面试大师/每日一问/下面这段代码输出什么.md
      面试大师/每日一问/0001-defer的执行顺序.md
      面试大师/每日一问/0002-for-range陷阱.md
      面试大师/每日一问/0003-切片的默认填充值.md
   4. 目标：面试大师/面试圣经/一二面.md
      面试大师/面试圣经/共济科技.md
      面试大师/面试圣经/博雅互通.md
      面试大师/面试圣经/店匠科技.md
      面试大师/面试圣经/明源云.md
      面试大师/面试圣经/智象科技.md
      面试大师/面试圣经/闪鲜到家.md
   5. 目标：面试大师/面试圣经/一面.md
      面试大师/面试圣经/星际大陆.md
      面试大师/面试圣经/腾讯云外包2.md
```

`面试大师/面试圣经/` 里 6 篇面试记录的首个标题都是「一二面」，`每日一问/` 里 3 篇都是「下面这段代码输出什么」。一旦启用「文件名跟随正文标题」，它们会互相踩成 `一二面.md`、`一二面 2.md` … `一二面 6.md` —— 文件名**信息量归零**，而侧栏显示名全是「一二面」。这不是理论风险：`resolveAvailablePath()` 的行为已由 A5a 实测确认。

（`目标名已被另一篇笔记占着` 一项为 **0**，说明现有文件名与现有标题没有直接冲突；撞名全部来自「多篇算到同一个新名字」。）

---

## 5. 从证据推出的自动改名硬约束（供下游方案与实现直接引用）

1. **必须跳过有 `titleOverride` 的笔记**（E7/A7b）：否则每次停笔都会顶掉用户上一次的手动改名。
2. **不能只认 H1**（E9）：本机用户实际受影响 4 篇里 H1 为 0，只认 H1 = 0 篇生效。但也不能退化成 `deriveTitle` 任意输出（4.3）：必须限定「首个标题来自真正的标题行（`#`~`######`）」，并在方案里明确 h2 是否算数。
3. **必须只对「文件名像无标题」的笔记动手**（E8）：否则 364 篇（75.7%）笔记会被卷入改名，其中 5 组直接撞名（4.5）。
4. **撞名与 `sanitizeName` 分叉必须在方案里给出显示名规则**（E5/E11）：`renameNote` 写下的 `titleOverride` 用的是请求名，不是落盘名；直接复用会产生「侧栏 系统设计 / 磁盘 系统设计 2.md」这种静默分叉。要明确「改名后显示名是请求名还是落盘名」。
5. **空正文 / 无标题行必须原地不动**（4.2 的 `AI智能时代/无标题.md`）：没有可用标题就没有改名依据。
6. **每改一次名会永久往 `state.json` 加一条 `titleOverrides`**（A7a），并且改名会搬历史快照目录（`moveHistory`）；批量迁移要考虑 `state.json` 体积与「撤销」所需的记录。
7. **不要在 `src/` 之外验证**：根 `vitest.config.ts:6` 的 include 不覆盖 `.tmp-title/`，任何新测试若要进 CI 必须放回 `src/**`（本任务按约束只落 `.tmp-title/`）。

---

## 6. 局限与未覆盖

- 数据层用 `MemoryBackend`（照抄仓库既有脚手架），**未跑真实 Node/Electron 后端**；`move` 的「不覆盖已存在目标」语义在测试后端里是复刻的（`EEXIST`），真实后端由 t5 的附件调研覆盖。
- 5 秒调度层（`debounce`、计时器表、编辑器回调）本报告**没有实现也没有实测**，只证明了「数据层零件齐全、缺的是调度」（A1b/A1c 的零 `move`）。
- 盘点是**某一时刻的快照**（`2026-10-09T11:28:07Z`，481 篇）；数字会随用户新增笔记变化，脚本可重跑。
- 口径 3 的「不一致」用的是字符串全等；`deriveTitle` 会 `slice(0, 90)`，超长标题的截断差异未单独统计。
- 未读 `.opennote/state.json`（硬性要求「不得触碰」），因此**无法**盘点「用户已经手动改过名的笔记」有多少 —— 这个数字会影响约束 1 的实际影响面，需要另一条只读路径（或用户同意后读取）才能量出来。

---

## 7. 复现命令清单

```bash
# 任务 A（14 例，exit 0）
npx vitest run --config .tmp-title/vitest.title.config.ts .tmp-title/title-precedence.test.ts

# 任务书里的裸命令（预期 exit 1：No test files found，include 不含 .tmp-title/）
npx vitest run .tmp-title/title-precedence.test.ts

# 任务 B（只读，exit 0）
node .tmp-title/scan-notes.mjs            # 默认 E:\repo\notes
node .tmp-title/scan-notes.mjs <其它笔记本根目录>
```

## 8. 附：与 t1 结论的对照

| t1 的静态结论 | t3 的运行时证据 | 判定 |
|---|---|---|
| 优先级 `titleOverride` > `deriveTitle(正文, 文件名stem)` > `"无标题"` | A1a/A2a/A2b/A3a/A4a/A4b | 一致 |
| 算标题只有 `makeNote` / `refresh` 两处 | A1b 走 `updateNoteContent → refresh` 时标题变、文件名不变 | 一致 |
| 全仓 14 个 `target.move(` 没有一处输入是 `deriveTitle` 的结果 | A1a/A1b 的 `moves() === []`（打字全程零 `move`） | 一致，且给出运行时反证 |
| dce308b 只动 3 个文件、不涉及任何 `target.move` | `git show --stat dce308b` = README.md + library.files.test.ts + library.ts；`git show dce308b -- src/data/library.ts` 里新增行只含 `titleOverride` 相关，**没有任何 `+....move(` 行** | 一致 |
| 「H1 停笔 5 秒改名」缺的只有调度层 | A1c：停笔/重扫/重开之后文件名依旧不动；A7a：唯一能搬文件的原语是 `renameNote`（1 次 move） | 一致 |
| 待验证：自动改名要先判有没有 override | A7b：不判 → 手改的名字被顶掉（实测） | **已验证** |
| （t1 未列）撞名时显示名与磁盘名分叉 | A5a + 盘点 4.4/4.5 | **新增证据** |
| （t1 未列）用户现有 4 篇 `无标题` 笔记没有一篇是 H1 | 盘点口径 2 | **新增证据，直接推翻「只认 H1」方案** |
