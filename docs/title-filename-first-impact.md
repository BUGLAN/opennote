# H1 命名落盘的影响面审计（t2）

> 只读调研。**本轮没有修改任何源码**，唯一新增文件是本报告。
> 结论先行：**H1 自动命名不能靠现有的 `deriveTitle()` 落地，也修不了用户手上真实的 5 个占位文件**——因为那 5 个文件的正文里一个一级标题都没有。要做这件事，必须先把「改名依据」从 `deriveTitle()`（任意级标题/首行）收窄成**真正的 H1**，再补一条与 `renameNote()` 分开的、**不写 `titleOverride`** 的自动改名路径。

---

## 0. 审计口径

| 项 | 说明 |
| --- | --- |
| 代码基线 | `HEAD = 9a57021`（含 `dce308b fix(data): 重命名后显示名不再被正文里的 H1 顶回去`） |
| 笔记本样本 | `E:\repo\notes`（真实笔记本：有 `.git`、`.opennote/state.json`、`.assets/`，481 篇可识别 Markdown/文本笔记，不含 `.git` 内部） |
| 统计脚本 | `E:\repo\.tmp-title-audit\audit{,2,3}.mjs`（临时脚本，可删；`deriveTitle`/`firstH1`/`sanitizeName` 三处语义按源码逐行复刻） |
| 不改动的目录 | `.git`、`.opennote`（只读） |

---

## 1. 现状：标题这一路是怎么长的

### 1.1 `Note.title` 是**派生字段**，不是真源

- `src/data/library.ts:194-214` `makeNote()`：`title: deriveTitle(text, stripExtension(baseName(path)))`。
- `src/data/library.ts:216-228` `refresh()`：`title: note.titleOverride ?? deriveTitle(text, stripExtension(baseName(note.id)))`。
- `src/lib/utils.ts:61-86` `deriveTitle(md, fallback)`：**「第一个标题」赢，没有标题时「第一个非空行」赢**；`/^(#{1,6})\s+/` —— 也就是 **H2~H6 也算标题**，围栏代码、front matter、引用块、表格、分隔线被跳过。文件名只是最后的 fallback。

这就是 dce308b 之前「改名会被顶回去」的根因，也是 dce308b 补上 `titleOverride` 的原因。

### 1.2 dce308b 覆盖了什么（覆盖得很准，但只覆盖「显示名」）

`git show dce308b`：只动 3 个文件（`README.md`、`src/data/library.files.test.ts`、`src/data/library.ts`，+162/-3）。

| 覆盖到的 | 落点 |
| --- | --- |
| 显式重命名写 `titleOverride` 并落 `state.json` | `library.ts:1169-1176` |
| 打字（`refresh`）不再把名字顶回去 | `library.ts:223` |
| 重扫（`makeNote`）后把显示名挂回去 | `library.ts:471-480` |
| 键跟着笔记走（改名/移动/回收站/恢复/删除） | `library.ts:1126-1145`、`1886-1902` |

**没覆盖到的**（正是本次任务要补的）：

1. `renameNote()` 是**唯一**能改磁盘文件名的入口（`library.ts:1147`），没有任何「正文 H1 变了 → 文件名跟着变」的路径。用户改了 H1，`Note.title` 变了、侧栏变了，**磁盘文件名一格不动**。
2. `titleOverride` 一旦写入就**永久压制** H1（`refresh()` 的 `??`）。所以自动改名若复用 `renameNote()`，第一次自动改名就把自己锁死。
3. 「新建笔记」的初始文件名仍是 `无标题.md`（`library.ts:988-989`），并且**新建的笔记正文是空的**（`App.tsx:848` 传 `content: ""`），所以它**没有 H1**——H1 自动命名在这条路径上无源可取。

---

## 2. 影响面逐条判断（读 `note.title` / 依赖文件名的调用方）

> 判定口径：**自动改名 = 磁盘文件名变化 + `note.id` 变化**（`renameNote` → `remapIds`）。`note.title` 的变化本身是廉价的，会疼的是 id 变化与「按名字/按路径查找」的那些地方。

### 2.1 按名字查找（**最危险的一类**）

| # | 位置 | 现在怎么用 title | 改后的后果 | 等级 |
| --- | --- | --- | --- | --- |
| 1 | `App.tsx:500-508` `openWikiLink(title)` | `Object.values(library.notes).find(note => note.title === title)`；找不到就 `createNote({ title, content: \`# ${title}\n\n\` })` | **双链不会因为「改文件名」而断**——匹配的是 `note.title`，而自动改名只改文件名、H1 原文不动，`title` 不变。**但有一个既存的真实缺口**：`createNote` 内部先 `sanitizeName(title)` 再拿净化后的名字造文件名与正文 H1（`library.ts:988-989`）。写 `[[a/b]]` → 造出 `a b.md`，正文却是 `# a/b`。此后 `openWikiLink("a/b")` 仍然能靠 `note.title`（= `a/b`）找到它，但**磁盘文件名和正文 H1 从此不一致**，任何「按文件名对账」的检查都会误报。建议：`openWikiLink` 建笔记时把 H1 写成 `sanitizeName(title)` 的结果。 | **中高** |
| 2 | `App.tsx:510` `hasNote(title)` | 决定 `[[x]]` 显示为「已存在」还是「待创建」 | 同上，自动改名不破坏它；但 `deriveTitle` 的兜底（首行/非 H1 标题）会让「显示名」与「文件名」分叉，用户看到的 `[[名字]]` 与磁盘名对不上 | 中 |
| 3 | `App.tsx:1297` `getTitles()` → `editor/completion.ts:6-28` wiki 补全 | 补全列表来自 `note.title` | 改名后补全项仍是显示名（对）；但**用户按文件名搜不到笔记**（补全不认 id） | 中 |
| 4 | `components/InboxPanel.tsx:275` `findPreviousCapture()` | 按 front matter `source:` 找上次剪藏，返回 `title: note.title`，用于「这个网址之前剪藏过 → 入库时会追加到《X》」 | 改名后提示句跟着显示名走（对）；**但 `lib/clip/receive.ts:729` 的 `append` 是按 `envelope.target.notePath` / 来源索引的**path** 找目标的** | **高** |
| 5 | `lib/clip/receive.ts:717-731` `resolveAppendTarget()` | `notePath` 存在性检查 + `existing.path` 比对 | 自动改名之后，`.opennote/import-index.json` 里那条 `path` 指向**已经不存在的旧路径** → `IMP-4009` 或（`notePath` 为空时）`existing.path` 命中不到 → `resolveAppendTarget` 返回 `null` → **降级为新建一篇**（`receive.ts:676-712`）。用户视角：「同一篇文章又被剪了一遍，多出一个新文件」。 | **高** |
| 6 | `lib/clip/receive.ts:733-736, 760-787` `isBeingEdited()` / `appendTo()` | `state.dirty[path]` + `known.content !== existingText` | 自动改名会把 `dirty`/`knownStats`/`plainCache` 一起 remap（`library.ts:1863-1885`），所以「改名中途又敲字」这条已有护栏；但**改名后旧的 index 条目失配**仍会走 `IMP-W004` 警告 + 新建 | 中高 |

### 2.2 「新建笔记」的初始文件名

| # | 位置 | 现状 | 改后 | 等级 |
| --- | --- | --- | --- | --- |
| 7 | `App.tsx:846-851` `newNote()` → `library.ts:985-1001` `createNote()` | `title = options.title ?? "无标题"`，`fileName = sanitizeName(title, "无标题") + ".md"`，`content` 默认 `""` | 若坚持「新建即 `无标题.md`，写 H1 后 5 秒落盘」，**新建后 5 秒内仍会看到 `无标题.md`**（这是用户明确接受的中间态）。真正的坑是 `uniquePath`：同时建 3 篇空笔记会得到 `无标题.md / 无标题 2.md / 无标题 3.md`，随后自动改名分别落成不同名字——` 2`/` 3` 序号**不会**被继承（这是对的，但要在迁移/测试里说清楚） | 中 |
| 8 | `App.tsx:944-947` / `library.ts:1246-1251` `duplicateNote()` | `createNote({ content, title: \`${note.title} 副本\` })` | 复制出来的笔记正文 H1 仍是原 H1，**文件名是「X 副本」而 H1 是「X」** → 5 秒防抖一触发就被自动改回 `X 2.md`（或 `X.md`）。**必须豁免「复制」这条路径**，否则用户点一次「创建副本」文件名自己变一次 | **高** |
| 9 | `library.ts:2536-2539` `seedWelcome()` | `createNote({ content: WELCOME_CONTENT, title: "欢迎来到 Opennote" })`，正文首行 `# 欢迎来到 Opennote`（`welcome.ts:2-4`） | H1 == 文件名，自动改名是空操作，安全 | 低 |
| 10 | `App.tsx:506` `openWikiLink` 的建笔记 | 见 #1 | 同上 | 中高 |

### 2.3 收件箱 / 导入的落点与显示名

| # | 位置 | 现状 | 改后 | 等级 |
| --- | --- | --- | --- | --- |
| 11 | `lib/clip/landing.ts:25-28` `requestedNotePath()`；`receive.ts:681-712` `createNew()` | 落点 = `sanitizeName(envelope.title) + ".md"`；正文由 `frontmatter.ts:119` `renderBodyBlock(envelope.title, body)` 写成 `# <envelope.title>` | 剪藏落盘时 H1 与文件名天然一致（`envelope.title` 同时进两处）→ 自动改名是空操作。**只有用户事后改 H1 才会改名**，那是预期行为 | 低 |
| 12 | `components/InboxPanel.tsx:141-144` `displayTitle()` / `:615` `safeRequestedPath(effectiveFolder, entry.title \|\| "无标题")` / `:639-641` 说明句 | 显示名与「入库时会另存为《X 2》」的预告 | 预告句是**预测**，实际落点由 `allocateNotePath`/`resolveAvailablePath` 定（`landing.ts:58-70`），序号可能不是 2（例如已有 `X 2.md`）。**与本次改动无关的既有偏差**，但自动改名会让「已入库条目」的 `entry.notePath` 与实际文件再次分叉 | 中 |
| 13 | `lib/import.ts:80-89, 158-175, 188-200` `writeNote()` | 文件名 = 导入文件的**文件名**（`stripExtension(fileName)`），正文原样 | 导入一份正文 H1 与文件名不同的 md → 5 秒防抖一触发就把用户精心命名的文件改掉。**批量导入必须豁免**（至少：导入过程中与导入后一段静默期内） | **高** |
| 14 | `lib/import.ts:238-276` `migrateLegacyData()` | 文件名 = `sanitizeName(note.title \|\| "旧笔记")` | 旧数据迁移同样会踩 #13 | 中 |
| 15 | `lib/clip/receive.ts:744-758` `askAboutEditing()` 的 `title` | `target.entry?.title \|\| baseName(stripExtension(path))` | 显示用，无害 | 低 |
| 16 | `lib/clip/receive.ts:749, 815, 872` 提示句 | 同上 | 显示用，无害 | 低 |

### 2.4 导出 / 搜索 / 排序 / 冲突 / 其它显示

| # | 位置 | 现状 | 改后 | 等级 |
| --- | --- | --- | --- | --- |
| 17 | `lib/export.ts:35, 73, 83` | 导出文件名与 `<title>` 用 `sanitizeName(note.title)` | 自动改名后 `note.title` 不变（H1 原文），导出名仍是显示名。**注意**：若采纳「显示名也收窄成 H1」，`README.md` 这类笔记的导出名会从 `软技能 代码之外的生存指南.md` 变成 `README.md`（因为文件名不变）——**这是行为回退，必须在报告里显式承认** | 中 |
| 18 | `library.ts:2014-2020` `sortNotes()` 的 `SortKey === "title"` | `a.title.localeCompare(...)` | 自动改名不改 `title`（H1 原文不变），所以排序**不动**。**但若采纳「显示名跟着 H1」的现状**，用户每敲一个字侧栏就重排一次（`Sidebar.tsx:454, 648` → `notesInFolder(..., { sort: ui.sort })`）。改名落盘那一下不会额外重排（title 没变）。结论：**排序不是自动改名的风险点，`deriveTitle` 的实时性才是** | 低（改名维度）/ 中（既有实时重排） |
| 19 | `components/ConflictDialog.tsx:34-50, 146-158, 246` | `renamedTitle?: string \| null`，缺省 `${request.title} 2`，文案「自动改名为《X 2》，原文件不动」 | 目前**全仓没有一处传 `renamedTitle`**（grep 只有 `ConflictDialog.tsx` 自己 2 处）。这条字段是给自动改名/落点预留的接口：改名后请把**真实分配到的名字**（`allocateNotePath` 的结果）传进来，别让界面继续猜 ` 2` | 中 |
| 20 | `App.tsx:447` `document.title`；`components/TabBar.tsx:45,61`；`Sidebar.tsx:976,1098,1112,1136,1289`；`App.tsx:1058` 命令面板 | 全部读 `note.title` | 无害（显示名） | 低 |
| 21 | `App.tsx:951`、`Sidebar.tsx:825,830,847,923`、`InboxPanel.tsx:275` | 通知/对话框里的《X》 | 无害 | 低 |
| 22 | `data/importLog.ts:303` | `title: note.title ?? ""` | 无害；但 `App.tsx:262-277` 的 `recent` 通道把 `title` 当**幂等索引的显示名**回给客户端，客户端若拿它当定位键会失配（应当用 `path`） | 中 |
| 23 | `lib/import.ts:243` | 旧数据迁移的落点名 | 见 #14 | 中 |

### 2.5 文件名变化本身的连带（`note.id` 变了）

| # | 机制 | 现状 | 自动改名会不会踩 | 等级 |
| --- | --- | --- | --- | --- |
| 24 | `library.ts:1840-1903` `remapIds()` | 同步搬 `notes`/`folders`/`trash`/`dirty`/`writeTimers`/`plainCache`/`knownStats`/`lastSnapshotAt`/`ui.tabs/activeId/lastNoteId`/`meta.starred/expanded/lastOpened/titleOverrides` | **这是自动改名唯一可以依赖的护栏**，已经过 D01 测试（「重命名过程中敲入的正文会跟着新文件名落盘」）。但**它不搬的东西**：`createGuards`、`pendingWrites`、`pendingSnapshots`、`snapshotNames`、`lastSnapshotAt` 之外的快照失败集 `snapshotFailures`、以及 `.opennote/import-index.json` 里的 `path` | **高** |
| 25 | `library.ts:1077-1095` `moveHistory()` | 历史目录跟着新 id 搬 | 安全（有 D15 测试） | 低 |
| 26 | 图片引用 | `renameNote()` **不调** `rebaseNoteAssets()`（只有 `moveNote`/`trashNote`/`restoreNote` 调，`library.ts:1237, 1314, 1621`）。同目录改名 ⇒ 相对前缀不变 ⇒ 共享 `.assets/` 引用安全 | 共享 `.assets/` 引用安全。**但旧布局 `<笔记名>.assets/x.png` 会断**——`assetsDirFor()` 现在恒为 `.assets`（`landing.ts:87-92`），`renameNote` 不会去搬那个目录。真实笔记本里确实还有旧布局（`notes/.opennote/trash/无标题.assets/`、`notes/看过的书/.../assets/`）。 | **中高** |
| 27 | `.opennote/history/<path>/` | 目录名 = 笔记路径 | 跟着搬（`moveHistory`） | 低 |
| 28 | `notes/.opennote/state.json` 的 `titleOverrides` | 键 = 笔记路径，值 = 净化后的显示名 | `renameNote` 会 `moveTitleOverride`（`library.ts:1126-1134`）。**但自动改名若复用 `renameNote`，会把「H1 文本」写成一条永久 override**（见 §4(a)） | **高** |

---

## 3. 自动改名的时序风险（重点）

### 3.1 内容变更的回调链（现状）

```
CodeMirror update → editor/setup.ts 的 onChange(doc)
  → EditorPane.tsx:67-70  propsRef.current.onDocChange(doc)
  → App.tsx:1299-1302   if (!activeId) return; updateNoteContent(activeId, doc)
  → library.ts:1037-1053 updateNoteContent()
       refresh() → patchNotes() → markDirty() → invalidateSearchCache(id)
       → options.immediate ? flushNote() : persistNoteSoon(id)   // 默认 450ms
       → maybeSnapshot()
```

**挂 5 秒防抖最自然的位置：`library.ts:1048-1051` 之间**（`markDirty` 之后、`persistNoteSoon` 旁边），理由：

1. 所有编辑入口都汇到这里（编辑器、快照恢复 `library.ts:2483`、剪藏追加前的 flush 路径、导入 `import.ts:285` 导出的同一个 `updateNoteContent`），挂在别处就要挂多次。
2. 数据层在这里已经拿到 `refresh()` 之后的新 `title`（H1 派生结果）和 `note.id`（文件名），判定「要不要改」不需要再问界面。
3. 界面层（`App.tsx`）拿不到 `note.id` 的**旧值**，改名后 `activeId` 会被 `remapIds` 改掉，`onDocChange` 的闭包会捕获旧 id（`App.tsx:1299-1302` 依赖 `activeId`，React 重渲染后才是新值）——**放在数据层可以完全绕开这个 stale-closure 问题**。

**⚠️ 现成的坑（必须绕）**：`App.tsx:119` 的 `cursor` 是 **React state**（`const [cursor, setCursor] = useState<CursorInfo>(...)`），`onCursor={setCursor}`（`:1303`）。数据层拿不到它；而任何 5 秒定时器回调里读 `cursor.line` 都是**过期的闭包值**。若要实现「光标还在 H1 那一行就不改名」，必须新增一个 `cursorRef`（`useRef`）或在数据层维护 `lastEditedLine`。

### 3.2 抑制机制：**现在完全没有，需要新增**

| 检查项 | 现状 |
| --- | --- |
| 「刚被用户显式重命名过就不要再自动改名」 | **不存在**。唯一相关的是 `titleOverride`（`library.ts:223`）——它压制的是**显示名派生**，不是「改名动作」。而且它一旦写入就永久生效，没有时间窗。 |
| 「用户显式重命名」的标记 | 只有 `meta.titleOverrides`（`state.json`），语义是「这个名字是用户定的」，**没有**来源、没有时间戳。要区分「显式命名」与「自动改名」，得新增字段（见 §4(a) 建议的 `titlePinnedAt`/`autoTitle: false`）。 |
| 「正在输入」 | 只有 `state.dirty[id]`（`library.ts:813-815`），语义是「还没落盘」，不是「用户刚敲过」。 |
| 「外部改动」 | `knownStats`（`library.ts:144, 875-890`）能发现，但只在 `flushNote` 里用。 |

### 3.3 与正在写的正文撞车（`flushNote` / `persistNoteSoon` 与 `move` 的顺序）

`renameNote()` 的顺序是**对的**：`flushNote(id)` → `resolveAvailablePath` → `move` → `remapIds` → `moveHistory` → 写 `titleOverride` → `flushMeta`（`library.ts:1161-1176`）。`remapIds` 会把改名期间敲进来的正文连 `dirty` + `writeTimers` 一起搬到新 id（`library.ts:1860-1882`，有 D01 测试兜底：`library.regression.test.ts:294-312`）。

自动改名要复用的就是这条顺序，**不要另写一遍 move**。三个必须显式处理的点：

1. **改名触发前必须先 `flushNote`**：否则 `move` 之后，那个指向旧路径的 450ms 定时器会把新内容写进一个已经不存在（或已被别人占用）的路径。`renameNote` 已经这么做了，复用即可。
2. **`createGuards` / `pendingWrites` 不参与 remap**（`library.ts:146, 126`）：如果自动改名恰好撞上「新建笔记的名字 preflight」（`library.ts:1008-1029`），`createGuards` 里那条 gate 仍挂在旧 id 上，`flushNote(newId)` 不会等它。建议自动改名**跳过创建后 N 秒内的笔记**（或直接跳过 `createGuards.has(id)` 的笔记）。
3. **`persistNoteSoon` 的 450ms 与 5 秒窗**：两者独立即可。5 秒窗到期 → 先 `flushNote`（内部会 `clearTimeout` 掉 450ms 定时器）→ 再 `move`。不要在 `move` 之后再 arm 一个写旧路径的定时器。

### 3.4 改名途中用户又敲字

三种可能的策略，建议**「取消 + 重排」**（不是「排队」也不是「丢弃」）：

| 策略 | 行为 | 评价 |
| --- | --- | --- |
| 取消（推荐） | 定时器每次内容变化就 `clearTimeout` 重排；只在真正静默 5 秒后才改名 | 最简单、最符合用户直觉「停笔 5 秒才落盘」。连续打字永远不会触发改名。 |
| 固定 5 秒后无条件执行 | 不重排，第一次敲字起 5 秒后就改名 | 会在用户正打字时搬文件（虽然 `remapIds` 兜得住），体验差。**不推荐**。 |
| 排队 + 延后 | 改名中又敲字 → 记 pending，等当前改名完再补一次 | 实现最复杂，且容易和 `remapIds` 的 dirty 转移叠出双写。**不推荐**。 |

**已经改名在途时**：`renameNote` 的 `await move` 期间 `remapIds` 还没跑，此时 `onDocChange` 仍用旧 id 调 `updateNoteContent` → 写入 `notes[oldId]`，`persistNoteSoon(oldId)` arm 一个定时器；`remapIds` 之后这些一起被搬到新 id（`library.ts:1863-1882`）。**这条已有测试（D01）覆盖，但它是为「用户点重命名」写的，自动改名是它的新触发源**——建议补一条「自动改名在途时继续打字」的判据。

**还一个真实竞态**：`renameNote` 里 `move` 完成后会触发桌面端文件监听（`WATCH_DEBOUNCE_MS = 500`，`library.ts:622`）→ `rescanWorkspace`。若此刻内存里的 `content` 与磁盘一致，重扫是幂等的（`library.ts:760-783`）；若不一致，`keptDirty` 会保住本地正文并重新 arm 定时器（`library.ts:797`）。**但自动改名把这条路径的触发频率从「用户偶尔点一次」提高到「每次停笔都可能触发」**，建议在实现时显式给自动改名加一个「同一篇笔记两次自动改名之间的最小间隔」（例如 30 秒），避免抖动。

---

## 4. 迁移风险：真实笔记本的统计（只读，`E:\repo\notes`）

### 4.1 核心数字

| 指标 | 数字 | 说明 |
| --- | --- | --- |
| 可识别笔记（`.md/.markdown/.mdown/.mkd/.txt`，排除 `.git`） | **481** | 另有 `.png` 230、`.py` 51 等非笔记文件 |
| 文件名形如 `无标题` / `无标题 N` / `未命名` | **5** | 见下表 |
| └ 其中「正文有真标题」（首行非空且 ≠ 文件名） | **4** | 但**没有一个**是 H1（见 4.2） |
| └ 其中「首行 ≠ 文件名」且首行是 **H1** | **0** | ⚠️ **这是本次审计最重要的一个数字** |
| 正文首行与文件名不一致（含各级标题/首段） | **364** | 其中 **87** 条只是「文件名被压成 slug」（`00-索引.md` vs `# agent-browser 中文文档索引`），**277** 条是实打实的差异 |
| 正文首行是 **H1** | 154 | |
| 正文首行是 **H2~H6** | 238 | `deriveTitle` 会把它们当标题 |
| 正文首行是普通段落 | 49 | 同上 |
| 正文里一个标题都没有（空文件或纯代码/图片） | 41 | 其中 40 个是**空文件** |
| 文件名形如时间戳 / 长哈希 / 乱码 | **0** | 任务里提到的这一类在真实笔记本里**不存在**（`.opennote/history/` 下的时间戳是快照文件名，不是笔记名） |
| `state.json` 里 `titleOverrides` 条数 | **1** | `项目实战/system_panel/系统设计ABC.md → 系统设计ABC` |

### 4.2 5 个占位文件的**全部**样本（这是迁移决策的全部依据）

| 文件 | 正文首行 | 是不是 H1 |
| --- | --- | --- |
| `AI智能时代/无标题.md` | （空文件） | — |
| `无标题.md` | `3f1c9589f284944860bef0e22aecc5b0_720.png` | 否（普通段落） |
| `项目实战/system_panel/无标题.md` | `修改提示词` | 否（普通段落） |
| `项目实战/恋爱模拟器/无标题 2.md` | `恋爱模拟器综合设计` | 否（普通段落） |
| `项目实战/恋爱模拟器/无标题 3.md` | `恋爱模拟器设计提示词` | 否（普通段落） |

**结论**：用户说的「大量 `无标题.md`」在**当前**笔记本里只剩 5 个，而且**没有一个是「H1 式真标题」**——它们是「首行是普通段落」或「空文件」。所以：

- 「按 H1 自动改名」这版方案，**对用户的真实痛点命中率 = 0/5**。
- 历史证据说明用户**确实**踩过这个坑并自己修好了：`.opennote/history/` 下存在过 **10** 个不同的占位路径（`无标题.md`、`项目实战/system_panel/无标题.md`、`项目实战/恋爱模拟器/无标题 2.md`、`游戏开发/无标题.md`、`面试大师/每日一问/无标题.md`、`.opennote/trash/…` 等），其中 `项目实战/system_panel/无标题.md` 后来变成了 `项目实战/system_panel/系统设计ABC.md`（并且是 `state.json` 里**唯一**一条 `titleOverride`）。也就是说：**用户是靠「改正文 + 手动重命名」绕过去的，而不是靠应用**。

### 4.3 「按 H1 自动改名」的爆炸半径（模拟）

用「第一个非空 **H1** → `sanitizeName()` → 与文件名比较」这套规则跑一遍全库：

| 指标 | 数字 |
| --- | --- |
| 有 H1 的笔记 | 154 |
| **会被自动改名** | **104**（其中占位文件 **0** 个） |
| H1 里含非法字符、落盘名会被 `sanitizeName` 改字面量 | 5 |

**会被改名的代表性样本**（节选，全部来自「用户已经整理好的目录」）：

```
AI智能时代/agent-browser中文整理/00-索引.md              →  agent-browser 中文文档索引.md
AI智能时代/claudecn.com/docs/.../index.md               →  入门指南.md
AI智能时代/claudecn.com/README.md                       →  Claude 中文文档整理结果.md
云原生/docker/docker.md                                 →  docker 学习.md
云原生/k8s/k8s.md                                       →  kubernetes.md
命令行和软件相关/vim best editor.md                      →  QAQ.md
操作系统/操作系统设备概念.md                              →  操作系统.md
数据库/redis/redis-缓存穿透.md                           →  缓存穿透.md
看过的书/Soft Skills/README.md                           →  软技能 代码之外的生存指南.md
看过的书/Learn JavaScript/README.md                     →  Learn JavaScript.md
看过的书/计算机系统要素/calculator.md                     →  计算机系统要素.md
算法和数据结构/LRU算法.md                                →  LRU 算法.md
```

**其中 5 个 H1 会因 `sanitizeName` 改字面量**（`/`、`:` 会被换成空格）：

| 现文件名 | H1 | 自动改名后的落盘名 |
| --- | --- | --- |
| `Agent 产出/Opennote 移动端移植方案调研(安卓 iOS).md` | `Opennote 移动端移植方案调研(安卓 / iOS)` | `Opennote 移动端移植方案调研(安卓 iOS).md` |
| `Agent 产出/Premiere Pro 接入 Agent 调研 CLI MCP 能力现状.md` | `Premiere Pro 接入 Agent 调研:CLI / MCP 能力现状` | `Premiere Pro 接入 Agent 调研 CLI MCP 能力现状.md` |
| `看过的书/Soft Skills/README.md` | `软技能: 代码之外的生存指南` | `软技能 代码之外的生存指南.md` |
| `语言和技术学习/python/单多线程对比.md` | `单/多线程对比` | `单 多线程对比.md` |
| `Agent 产出/ComfyUI 图片内嵌工作流：作者说明摘录（Qwen-Image 2.1 MiniMax H3）.md` | `…（Qwen-Image 2.1 / MiniMax H3）` | `…（Qwen-Image 2.1 MiniMax H3）.md` |

### 4.4 迁移裁定

**不做全库批量迁移。** 理由：

1. 真正该修的是 **4** 个文件（`无标题.md` + 3 个），不是 104 个；为了 4 个文件去改 104 个文件的名字，收益为负。
2. 那 4 个文件的首行**都不是 H1**。要修它们，规则必须是「首行非空且 ≠ 文件名」——这正是 `deriveTitle()` 现在的语义，也就是「把 364 个文件的名字改一遍」（其中 277 个是实打实的重命名）。**这是不可接受的破坏性**：`index.md`、`README.md`、`docker.md` 这些名字是用户在文件系统/git/编辑器里刻意选的。
3. 占位文件里有一个是**空文件**（`AI智能时代/无标题.md`），自动改名对它无解。

**建议的迁移形态（只读检查 + 用户确认 + 复用既有入口）**：

- 新增一个只读「命名体检」结果（可以在命令面板/状态栏里给一条可点的提示）：
  - 只报「文件名匹配 `^(无标题|未命名|untitled)(\s\d+)?$` 且 `deriveTitle(正文) !== 文件名`」的笔记 —— 真实笔记本上是 **4 条**。
  - 每条给出「现文件名 / 建议文件名（`sanitizeName(H1 或首行)`）/ 冲突提示」，用户逐条点「改名」。
  - 复用 `renameNote(id, 建议名)`，**不要**另写批量 move：它会走 `flushNote → move → remapIds → moveHistory → setTitleOverride → flushMeta` 全套。
- 对那 1 个空文件不提供建议（空正文 ⇒ 没有真标题）。
- 迁移**必须在应用内、逐条、可撤销**（回收站 + 历史快照都在），不要写一个跑在启动时的批量脚本。

**不破坏 `[[双链]]` 与图片相对路径的论证**：

| 资产 | 是否受影响 | 依据 |
| --- | --- | --- |
| `[[显示名]]` 双链 | **不受影响** | 解析按 `note.title`（`App.tsx:500-510`）；`renameNote` 写 `titleOverride = clean`，`title` 与文件名**同时**变成同一个净化串（`library.ts:1169-1173`），`note.title` 从 H1 派生的值切到新名字；只要新名字与旧 `title` 相同（迁移场景下「建议名 = 现 title」），匹配结果不变 |
| `![图](.assets/x.png)`（共享目录） | **不受影响** | 相对前缀只由**目录**决定（`landing.ts:103-111`）；改名不换目录，`renameNote` 也不调 `rebaseNoteAssets` |
| `![图](<笔记名>.assets/x.png)`（0.4.0 前的旧布局） | **会断** | 目录名与笔记名绑定，而 `renameNote` 不会搬它。真实笔记本里存在（`notes/.opennote/trash/无标题.assets/`、`看过的书/*/assets/`）。**迁移前必须先扫一遍：待改名笔记的正文里有没有 `旧名.assets/` 引用**；有就跳过并告知用户 |
| `](/绝对或相对 md 链接)` | **会断** | 自动改名会改 id；没有任何代码改写正文里的 `.md` 链接。真实笔记本里这类链接很少（`[[ ]]` 是主流），但迁移前应当扫一遍 |

---

## 5. 文件名合法化与冲突：`sanitizeName()` 到底做了什么

`src/fs/paths.ts:84-92`（`src/lib/utils.ts:229-237` 的 `safeFileName()` 是同一套逻辑的另一份产地，`fallback` 分别是 `未命名` / `untitled`）：

```ts
.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")   // 非法字符 → 空格
.replace(/\s+/g, " ")                          // 连续空白压成一个
.replace(/^[.\s]+|[.\s]+$/g, "")               // 去掉首尾的点与空白
.trim()
// 空串 → fallback；最后 .slice(0, 80) 截到 80 个 UTF-16 码元
```

| 输入 | 输出 | 备注 |
| --- | --- | --- |
| `a/b:c*d` | `a b c d` | 四个非法字符各变一个空格，再合并 |
| `单/多线程对比` | `单 多线程对比` | 中文里的 `/` 也照换 |
| `软技能: 代码之外的生存指南` | `软技能 代码之外的生存指南` | 冒号 + 已有空格 → 只剩一个空格 |
| `***` | `未命名`（`renameNote`/`createNote` 用 `无标题`，`requestedNotePath` 用 `未命名`） | **fallback 不是唯一产地**：`library.ts:989` 用 `无标题`，`landing.ts:27` 用 `未命名`，`import.ts:82` 用 `未命名`。自动改名要显式选一个并写进注释 |
| `  ...名字...  ` | `名字` | 首尾点/空白被剥（`.` 开头的名字会变成**隐藏文件**，所以必须剥） |
| 超过 80 个码元 | 截断 | 中英混排下按 UTF-16 截，可能截在代理对中间（emoji 会碎） |

**H1 带 `/ : *` 时自动改名会变成什么**：见 §4.3 的 5 行样本 —— 全部是「字符变空格」。**注意这不是唯一风险**：改名后文件名变了，但正文 H1 原文**一个字都没改**（这正是对话框承诺的「正文里的一级标题不会被改写」）。所以自动改名会造成**文件名与 H1 永久分叉**，下一次 `deriveTitle()` 又会算出不同的 `title`，与文件名对不上。**这是自动改名语义里最需要显式裁定的一条**（见 §6(a)）。

**冲突**：`uniquePath()`（`paths.ts:101-127`）在名字被占时给出 `名字 2.md` / `名字 3.md`；`resolveAvailablePath()`（`library.ts:822-838`）再叠加一次真实磁盘 `exists()` 探测，并且带 `guard > 500` 的兜底（会放弃循环并返回一个仍被占用的候选，`landing.ts:63-67` 专门为此抛 `IMP-4010`）。自动改名必须走 `resolveAvailablePath`，否则「磁盘上刚出现同名文件」会让新笔记清空旧文件（D03/D30，已有回归测试 `library.regression.test.ts:382-421`）。

---

## 6. 必须回答的四个问题

### (a) 推荐的精确语义

**三条通道，优先级从高到低：**

```
① 用户显式命名（唯一权威，永久）
      renameNote(id, name) → titleOverride = sanitizeName(name)
      ⇒ 之后 H1 再怎么变，文件名与显示名都不动，自动改名对该笔记永久停用

② 自动命名（H1 → 文件名，可回退、不落 override）
     只在「没有 titleOverride」且「有真 H1」时生效
     ⇒ 写 H1 → 5 秒 → 文件名 = sanitizeName(H1)；显示名继续由 deriveTitle() 现算

③ 兜底（无 H1）
     新建笔记的初始文件名 / 导入的原始文件名 / 现有文件名，一律不动
```

**关键设计决定：自动改名必须与 `renameNote()` 分开，走一条「不写 `titleOverride`」的路径。**

理由（这是最容易踩的坑）：`renameNote()` 会写 `titleOverride = clean`（`library.ts:1169-1173`），而 `refresh()` 是 `titleOverride ?? deriveTitle(...)`（`library.ts:223`）。如果自动改名复用它：

1. 第一次自动改名之后，`titleOverride` 被写成当时 H1 的文本；
2. 用户接着把 H1 从「会议记录」改成「会议记录 2026」——**文件名再也不会变**（被 override 锁死），用户看到的现象和修复前一样：「改了标题，文件名不动」；
3. 而且这条 override 是**永久**的，重启、重扫都还在（这正是 dce308b 想要的、但在这里变成了障碍）。

所以：

- 新增 `titleOverride` 的**来源标记**（例如 `titlePinnedAt?: number`，或把 `titleOverrides` 的值从 `string` 升级成 `{ title: string; pinnedAt: number; source: "user" | "auto" }` —— 后者是 `state.json` 的破坏性格式变更，需要迁移；**推荐前者**，只加一个并行的 `Record<Id, number>`）。
- 自动改名走一个新函数（例如 `autoRenameFromH1(id)`）：`flushNote` → `resolveAvailablePath` → `move`/`moveCaseOnly` → `remapIds` → `moveHistory`，**不碰** `titleOverride`，并在 `remapIds` 之后**清掉**该 id 上可能存在的旧 override（否则 `remapIds` 会把 `titleOverrides[old]` 搬到 `new`，见 `library.ts:1897-1900`）。
- **`deriveTitle()` 必须收窄**，或新增一个 `deriveH1()`：现在的 `deriveTitle` 认任意级标题与首行（`utils.ts:75-84`）。若拿它当改名依据，爆炸半径是 **364** 个文件（§4.1），而不是 104 个。自动改名**只认 `^#\s+` 的一级标题**。

**明确「不该自动改文件名」的情形**（建议全部实现，一条都不要省）：

| # | 情形 | 依据 / 后果 |
| --- | --- | --- |
| 1 | 该笔记有 `titleOverride`（用户显式命名过） | `library.ts:223`；用户权威 |
| 2 | 笔记在回收站里（`state.trash[id]`） | 回收站里的名字是「还原后的名字」，自动改会与 `moveTitleOverride` 打架（`library.ts:1316`） |
| 3 | H1 为空 / 纯空白 / 只有 inline 标记（`cleanInline()` 后为空） | `deriveTitle` 会 fallback（`utils.ts:79`），拿 fallback 当名字就是改名成 `无标题` |
| 4 | `sanitizeName(H1)` 落到 fallback（全是非法字符） | `paths.ts:91` |
| 5 | 净化后的名字与当前文件名**逐字相同** | 空操作；但**只差大小写**时走 `moveCaseOnly`（D07，`library.ts:1055-1066`） |
| 6 | 光标/最后编辑行**就在第一个 H1 那一行** | 「H1 是临时输入」：用户还在改这一行 |
| 7 | 笔记刚被显式重命名过（例如 30 秒静默期） | 防「用户点重命名 → 旧的 H1 立刻把名字顶回去」 |
| 8 | 笔记在「复制」路径里刚被创建（`duplicateNote`，`library.ts:1246-1251`） | 否则 `X 副本.md` 会被 H1 改回 `X 2.md` |
| 9 | 笔记来自批量导入（`import.ts`），且仍在导入静默期内 | 文件名是用户从外部带来的 |
| 10 | 笔记来自剪藏且从未被人工编辑过（H1 == 文件名） | 天然空操作；无需特判，但测试要覆盖 |
| 11 | 磁盘上的文件在应用外被改过（`knownStats` 不匹配，`library.ts:875-890`） | 别人可能正在用这个名字 |
| 12 | 改名会与 `createGuards` 里的 preflight 撞车（刚 `createNote` 的笔记） | `library.ts:1008-1029`；gate 不参与 `remapIds` |
| 13 | 该笔记被设为只读锁（`ui.lockedNotes`） | 只读笔记不该被应用改文件；与「只读」语义一致 |

**关于「显示名」要不要一起收窄成 H1**：建议**不要**在这一轮动。若把 `deriveTitle()` 改成只认 H1，`README.md` 这类笔记的侧栏名/导出名/搜索命中会从「正文标题」退回「文件名」，是可见的行为回退（§2.4 #17），且会红掉 `utils.test.ts:20-23`（「falls back to the first plain line」）。**让「显示名」保持现状，只让「文件名」在 H1 存在时跟随 H1**，两条规则各自有明确依据，风险最小。

### (b) 防抖与抑制策略

**5 秒窗口的实现位置**：`library.ts` 的 `updateNoteContent()`（`:1048-1051` 之间）。新增：

```ts
const autoRenameTimers = new Map<Id, ReturnType<typeof setTimeout>>();
const AUTO_RENAME_DELAY = 5000;
const AUTO_RENAME_QUIET_MS = 30_000;   // 显式重命名后的静默期（情形 7）
const explicitRenamedAt = new Map<Id, number>();
```

- `updateNoteContent` 末尾：`scheduleAutoRename(id)`。
- `scheduleAutoRename(id)`：**每次内容变化都 `clearTimeout` 重排**（策略「取消 + 重排」，§3.4）——连续打字永远不触发，只在真正静默 5 秒后执行。
- 定时器回调里**重新读取**最新状态（`libraryStore.get().notes[id]`），不要闭包捕获 `note` 对象。
- 工作区切换/关闭时清空（放进 `resetWorkspaceTransients()`，`library.ts:598-606`）；`renameNote`/`trashNote`/`deleteFolder`/`purgeNote`/`emptyTrash`/`importIntoWorkspace`/`duplicateNote` 里 `clearTimeout`。
- **光标行判定**：需要新增 `cursorRef`（`App.tsx:119` 的 `cursor` 是 state，定时器读到的会是旧值，§3.1）。或者更简单：定时器回调时若 `state.dirty[id]` 仍为真（还没落盘）就再等一轮——**但 `dirty` 会在 450ms 后清掉**，所以这个判据不够，还是得靠光标行。

**什么条件下暂停**：§6(a) 那张表的 13 条，实现成 `shouldAutoRename(id): boolean` 一个纯函数，**逐条写单测**（这是本次改动里最值得测试密集的一块）。

**改名途中又敲字**：见 §3.4。核心是复用 `renameNote` 的 `flushNote → move → remapIds` 顺序（`remapIds` 已经会搬 `dirty`/`writeTimers`，`library.ts:1860-1882`），并补一条新判据「自动改名在途时继续打字」。

### (c) 迁移策略

见 §4.4。要点复述：

1. **不做全库批量改名**：真实笔记本里该修的只有 4 个文件，而「按首行改名」会波及 364 个。
2. 提供一个**只读体检 + 逐条确认**的入口，复用 `renameNote()`（它已经处理了 flush / 冲突 / 历史 / override / 元数据落盘）。
3. 那 4 个占位文件的首行都不是 H1，所以**体检规则不能只认 H1**；它应该复用 `deriveTitle()` 的语义（首行/任意级标题），但**只在文件名是占位符时**才给建议——把「爆炸半径」限制在 `^(无标题|未命名|untitled)(\s\d+)?$` 这 5 个文件上。
4. 空文件（1 个）不给建议。
5. 改名前列一遍「该笔记的正文里有没有 `旧名.assets/` 或 `](旧名.md)` 这类**按旧名写死**的引用」；有就跳过并如实告知（§2.5 #26、§4.4 表格）。
6. 迁移必须**在应用内、逐条、可撤销**（回收站与 `.opennote/history/` 都在），不要写启动时跑的批量脚本。
7. 用户将来新写的笔记：靠 §6(a) 的自动命名，**不需要**迁移。

### (d) 必须同步修改的调用方与测试清单

**源码（按改动优先级）**

| # | 文件 | 位置 | 要改什么 |
| --- | --- | --- | --- |
| 1 | `src/lib/utils.ts` | `:61-86` | 新增 `deriveH1(md)`（只认 `^#\s+`，跳过 front matter/围栏），或给 `deriveTitle` 加 `{ onlyH1?: boolean }`。**不要直接改 `deriveTitle` 的默认行为**（会红掉 `utils.test.ts:20-23` 并让导出名回退） |
| 2 | `src/data/library.ts` | `:1037-1053` `updateNoteContent` | 挂 5 秒防抖（`scheduleAutoRename`） |
| 3 | `src/data/library.ts` | 新增（挨着 `:1147` `renameNote`） | `autoRenameFromH1(id)`：复用 `flushNote`/`resolveAvailablePath`/`move`/`moveCaseOnly`/`remapIds`/`moveHistory`，**不写** `titleOverride`；并在 `remapIds` 后清掉该 id 的旧 override |
| 4 | `src/data/library.ts` | `:1116-1134` | `titleOverride` 的来源标记（推荐新增 `titlePinnedAt: Record<Id, number>`，避开 `state.json` 破坏性格式变更）+ `readMeta` 校验（`:287-317`）+ `flushMeta` 写入（`:945-958`）+ `remapIds` 里一起搬（`:1898-1900`） |
| 5 | `src/data/library.ts` | `:1840-1903` `remapIds` | 一并搬新增的 `titlePinnedAt`；确认 `createGuards`/`pendingWrites` 的豁免策略（§3.3 #2） |
| 6 | `src/data/library.ts` | `:1246-1251` `duplicateNote`、`:2536-2539` `seedWelcome`、`:985-1001` `createNote` | 复制/欢迎笔记要豁免自动改名；`createNote` 的 `content: ""` 路径保留（用户接受中间态） |
| 7 | `src/data/library.ts` | `:598-606` `resetWorkspaceTransients`、`1301+` `trashNote`、`1565/1618/1653/1689/1719` 各 move/删除分支 | `clearTimeout` 自动改名定时器 |
| 8 | `src/App.tsx` | `:119, 1303` | 新增 `cursorRef`（`cursor` 是 state，定时器会读到过期值）；或把光标行下推到数据层 |
| 9 | `src/App.tsx` | `:499-529` `openWikiLink` / `hasNote` | 建笔记时 H1 用 `sanitizeName(title)`（消掉「文件名 `a b.md` + 正文 `# a/b`」的既存分叉）；可选：把匹配从 `note.title === title` 放宽成「显示名或文件名 stem 相等」，避免自动改名后同一个 `[[X]]` 被误判为「不存在」而重复建笔记 |
| 10 | `src/App.tsx` | `:846-851` `newNote` | 保持 `无标题.md` 初始名（用户已定）；但要保证它**不会**在用户还没写 H1 时被改名（§6(a) 情形 3/4） |
| 11 | `src/App.tsx` | `:944-947` `duplicateNote` | 同上，豁免 |
| 12 | `src/lib/import.ts` | `:80-89, 158-200, 238-276` | 导入/迁移期间与之后一段静默期豁免自动改名（否则 104 个文件里有一部分是被导入名"改回去"的） |
| 13 | `src/lib/clip/receive.ts` | `:717-731` `resolveAppendTarget`、`:783-787` | 改名后 `import-index.json` 的 `path` 会失配 → 降级新建。建议：改名时**顺手改写** `.opennote/import-index.json` 里的 `path`（或用内容哈希/稳定 id 当键，而不是路径） |
| 14 | `src/components/ConflictDialog.tsx` | `:39, 146-158` | 把**真实分配到的名字**（`allocateNotePath` 结果）传进 `renamedTitle`；全仓目前 0 个调用方传它 |
| 15 | `src/components/InboxPanel.tsx` | `:611-641` | 已入库条目的 `entry.notePath` 与实际文件在自动改名后会分叉；说明句要么跟着走，要么明确标注 |
| 16 | `src/lib/export.ts` | `:35, 73, 83` | 不改（保持 `note.title`）；但要在文档里写明「自动改名不改导出名」 |
| 17 | `src/data/types.ts` | `:33-51` `Note` | 若采纳 `titlePinnedAt`，加字段与注释 |
| 18 | `src/fs/paths.ts` | `:84-92` `sanitizeName` | 不改；但自动改名要显式选定 fallback（`无标题` vs `未命名`），并把「不唯一产地」写进注释 |

**测试：锁定当前命名行为的断言（逐条）**

| 文件:行 | 断言 | 为什么是「锁定当前行为」 | 会不会被本次改动打破 |
| --- | --- | --- | --- |
| `src/lib/utils.test.ts:17` | `deriveTitle("# 标题\n\n正文")` → `"标题"` | H1 赢 | 不破（若只新增 `deriveH1`） |
| `src/lib/utils.test.ts:21-22` | `deriveTitle("intro\n\n# 标题\n\n正文")` → `"intro"`；`deriveTitle("只是第一行\n第二行")` → `"只是第一行"` | **首行/任意级标题赢** | **如果拿 `deriveTitle` 当改名依据，这条语义就是「364 个文件会被改名」的根据** |
| `src/lib/utils.test.ts:26-27` | 跳过 front matter、围栏、分隔线 | | 不破 |
| `src/lib/utils.test.ts:31-32` | `deriveTitle("   \n\n")` → `"无标题"`；`deriveTitle("", "九月")` → `"九月"` | **无标题回落派生标题** | **必须保住**：自动改名要在「空 H1」上停手，靠的就是这个 fallback 的语义 |
| `src/lib/utils.test.ts:36` | `deriveTitle("# **重点** 与 [链接](x) 和 \`code\`")` → `"重点 与 链接 和 code"` | `cleanInline` 清洗 | 不破（`deriveH1` 必须复用 `cleanInline`，否则 H1 里的 inline 标记会进文件名） |
| `src/lib/utils.test.ts:103` | `safeFileName("九月/日记: 第一周?")` → `"九月 日记 第一周"` | 非法字符 → 空格 | 不破（与 `sanitizeName` 同语义） |
| `src/lib/utils.test.ts:107` | `safeFileName("///")` → `"untitled"` | 全非法 → fallback | 不破 |
| `src/lib/utils.test.ts:112` | `uniqueName("笔记.md", {"笔记.md"})` → `"笔记 2.md"` | 序号规则 | 不破 |
| `src/fs/paths.test.ts:101` | `sanitizeName("///")` → `"未命名"` | fallback 值 | 不破 |
| `src/data/library.files.test.ts:167-168` | 重命名前先 flush：`故事/改名.md` 内容 = 最新正文，旧文件不存在 | 改名的顺序契约 | **自动改名必须复用这条顺序**，否则会破 |
| `src/data/library.files.test.ts:188-194` | 重命名后 **重扫**，`notes["故事/改名.md"].title === "改名"` | 「重命名后 H1 不改写、显示名不被顶回去」 | **如果自动改名也写 `titleOverride`，这条会继续绿、但用户的功能坏掉**（第一次自动改名后 H1 再也不生效） |
| `src/data/library.files.test.ts:197-200` | 重命名后**打字**（`refresh`），title 仍是 `"改名"` | 同上（打字不顶回去） | 同上 |
| `src/data/library.files.test.ts:203-210` | 重开笔记本后 title 仍是 `"改名"` | `state.json` 持久化 | 不破（只要 `titlePinnedAt` 也进 `state.json`） |
| `src/data/library.files.test.ts:213-225` | 进回收站再恢复，title 仍 `"改名"` | override 的键跟着走 | 不破 |
| `src/data/library.regression.test.ts:294-312` | 「重命名笔记期间敲入的正文会跟着新文件名落盘」 | `remapIds` 的 dirty 转移 | **自动改名会复用这条**，必须保持绿 |
| `src/data/library.regression.test.ts:302-304` | 同上（`updateNoteContent("旧名.md", …)` 在 `rename` 之后同步调用） | 同上 | 同上 |
| `src/data/library.regression.test.ts:382-392` | `createNote()` → `无标题 2.md`，磁盘上的 `无标题.md` 不被清空 | 初始文件名 + D03 | 不破（新建仍走 `无标题`） |
| `src/data/library.regression.test.ts:394-401` | `createNote({title:"README"})` → `README 2.md`（大小写不敏感） | 初始文件名 + D30 | 不破 |
| `src/data/library.regression.test.ts:412-421` | 导入同名 md → `导入 2.md` | 导入落点 | 不破 |
| `src/data/library.regression.test.ts:581-590` | 只改大小写的重命名 → `故事/note.md`，不产生 ` 2.md` | `moveCaseOnly` | **自动改名必须复用**（H1 从 `abc` 改成 `ABC` 时） |
| `src/data/library.p2.test.ts:322-338` | 重命名后历史跟着走，新建同名笔记看不到别人的历史 | `moveHistory` | 不破 |
| `src/data/library.p2.test.ts:351-358` | 只改大小写的重命名也把历史带上 | `moveHistory` + `moveCaseOnly` | 同上 |
| `src/data/library.p2.test.ts:380-382` | `createNote({title:"笔记"})` 继承不到回收站里的历史 | 路径即身份 | 不破 |
| `src/fs/paths.gate.test.ts:74-84, 102-116` | 扫描后出现的同名文件 → 落点让开为 `无标题 2.md` | 冲突让位 | **自动改名必须走 `resolveAvailablePath`**，否则会踩 |
| `src/lib/clip/receive.test.ts:184-190` | `title: "a/b:c*d"` → `a b c d.md`；`"***"` → `未命名.md` | `sanitizeName` 的落点语义 | **自动改名必须与这条一致**（H1 里的 `/`、`:`、`*`） |

**需要新增的判据（建议）**

1. 「写 H1 → 5 秒 → 文件名变成 `sanitizeName(H1).md`，且 `titleOverride` 仍为空」。
2. 「用户显式重命名之后，改 H1 不再动文件名」（用户权威）。
3. 「H1 是临时输入（光标还在那一行）时，5 秒到点也不改名」。
4. 「H1 为空 / 全非法字符时改名是空操作」。
5. 「自动改名在途时继续打字，正文不丢、不产生 `dirty` 幽灵键」（对标 `library.regression.test.ts:294`）。
6. 「只改大小写的 H1（`abc` → `ABC`）走 `moveCaseOnly`，不产生 ` 2.md`」（对标 `D07`）。
7. 「`duplicateNote` 出来的 `X 副本.md` 不会被 H1 改回 `X 2.md`」。
8. 「批量导入的 md 在导入后静默期内不被改名」。
9. 「`H1 = "a/b"` → 文件名 `a b.md`，且再触发一次自动改名是空操作（不产生 `a b 2.md`）」。
10. 「自动改名之后 `knownStats` / `plainCache` / `dirty` / `writeTimers` / `ui.tabs` / `titleOverrides` 全部指向新 id」（可复用 `remapIds` 的既有测试思路）。

---

## 7. 风险等级总表

| 风险 | 等级 | 一句话 |
| --- | --- | --- |
| 拿 `deriveTitle()` 当改名依据 | **阻断级** | 会改名 **364** 个文件（`index.md`/`README.md`/`docker.md` 全在内），必须先用只认 H1 的 `deriveH1()` |
| 自动改名复用 `renameNote()`（会写 `titleOverride`） | **阻断级** | 第一次自动改名就把该笔记的 H1→文件名通道永久锁死，用户看到的现象与修复前一模一样 |
| 按 H1 自动命名**修不了用户的占位文件** | **阻断级（需求层面）** | 真实笔记本 5 个占位文件里 **0 个**有 H1；用户的核心诉求与 H1 方案不匹配，需要另行裁定「首行式真标题」要不要一起支持 |
| 旧布局 `<笔记名>.assets/` 引用 | 中高 | `renameNote` 不搬附件目录，改名即裂图（真实笔记本里存在这类旧布局） |
| `.opennote/import-index.json` 的 `path` 失配 | 高 | 改名后同 URL 再剪藏会降级为「新建一篇」 |
| `duplicateNote` / 批量导入被自动改名 | 高 | 「创建副本」「导入」出来的文件名会被 H1 改回去 |
| 光标行用 React state（过期闭包） | 中高 | 「H1 还在改」的判定会失效，必须在数据层或 `useRef` 里拿行号 |
| 文件监听（500ms）与自动改名叠加 | 中 | 触发频率从「偶尔」变成「每次停笔」，需要最小间隔节流 |
| `createGuards` 不参与 `remapIds` | 中 | 刚 `createNote` 的笔记被自动改名时，写入闸门会指错 id |
| 导出名/侧栏名/排序 | 低 | 自动改名不动 `note.title`；只有「把 `deriveTitle` 也收窄」才会回退 |
| `[[双链]]` | 低 | 按显示名解析，自动改名不破 |
| 共享 `.assets/` 图片 | 低 | 同目录改名，相对前缀不变 |

---

## 8. 附：本次审计的证据清单

| 证据 | 位置 |
| --- | --- |
| `deriveTitle` 认任意级标题与首行 | `src/lib/utils.ts:61-86` |
| `sanitizeName` 的字符规则与 80 字截断 | `src/fs/paths.ts:84-92` |
| `Note.title` 的派生与 override 压制 | `src/data/library.ts:194-228` |
| 重扫时挂回显示名 | `src/data/library.ts:464-480` |
| `renameNote` 的完整顺序 | `src/data/library.ts:1147-1180` |
| `remapIds` 搬哪些、不搬哪些 | `src/data/library.ts:1840-1903` |
| `updateNoteContent` 的写入节流（450ms） | `src/data/library.ts:1037-1053` |
| `createNote` 的 `无标题` 初始名 | `src/data/library.ts:985-1001` |
| `duplicateNote` | `src/data/library.ts:1246-1251` |
| 文件监听 500ms | `src/data/library.ts:616-632` |
| `openWikiLink` 按 `note.title` 匹配 | `src/App.tsx:499-529` |
| 新建笔记（空正文） | `src/App.tsx:846-851` |
| `cursor` 是 React state | `src/App.tsx:119, 1303` |
| 收件箱落点与说明句 | `src/components/InboxPanel.tsx:211-217, 608-644` |
| `renamedTitle` 无调用方 | `src/components/ConflictDialog.tsx:39, 146` |
| 剪藏 `append` 按路径找目标 | `src/lib/clip/receive.ts:717-731, 760-787` |
| 剪藏落点名 | `src/lib/clip/landing.ts:25-28` |
| 导入按外部文件名落盘 | `src/lib/import.ts:80-89, 158-200` |
| dce308b 的改动范围 | `git show --stat dce308b` |
| 真实笔记本 `state.json`（唯一 1 条 override） | `E:\repo\notes\.opennote\state.json:32-34` |
| 真实笔记本占位文件 5 个、H1 命中 0 个 | `E:\repo\.tmp-title-audit\audit3.mjs` 输出 |
| 历史快照里 10 个不同的占位路径 | `E:\repo\notes\.opennote\history\**\无标题*.md\` |
