# 标题真源与优先级：全量测绘报告

> 调研任务：`t1`（团队 `opennote-rename-title`）· 只读调研，未修改任何源码
> 测绘基线：`main` @ `9a57021`（`git status --short` 仅 `.agent-teams/` 未跟踪，工作区干净）
> 撰写日期：2026-10-09

---

## 0. 一句话结论

**标题的真源是「正文派生」，文件名只是兜底；「手动改过的显示名」（`Note.titleOverride`）可以压过正文。**
全仓**没有任何一处**会把 H1 的变化写回文件名 —— 这个能力不是「坏了」，而是**从未存在**。
H1 → 显示名是**每敲一个键就现算**的（`updateNoteContent` → `refresh`），
H1 → 磁盘文件名则**一层都没有**：数据层没有搬文件的调用，编辑器回调层没有对应的钩子，调度层也没有任何「停笔计时器」。

---

## 1. 结论速览（对应任务的 (a)–(d)）

### (a) 当前优先级次序的精确表述

```
① Note.titleOverride      （手动重命名写下的显示名；唯一能压过正文的东西）
② deriveTitle(正文, 文件名兜底)（正文里第一个「标题行」；正文里没有可用标题时用文件名的去扩展名形式）
③ 常量 "无标题"            （deriveTitle 的默认 fallback，只有连文件名都没有时才会出现）
```

- ① 只在一个地方产生：`renameNote()`（`src/data/library.ts:1147`）。
- ② 的规则见 §2。
- **文件名只在一种情况下被用作标题**：`deriveTitle()` 扫完整篇正文都没找到可用行
  （空文件、只有空白、只有 front matter、正文全是围栏代码块 / 引用块 / 分隔线）时，
  退回 `stripExtension(baseName(note.id))`（`src/data/library.ts:201` 与 `:223`）。
  新建笔记默认就是这一态：`createNote()` 写的是**空正文**（`src/data/library.ts:992`），
  文件名是 `无标题.md`（`:988-989`），所以显示名 = `无标题`。

**注意一个反直觉事实**：只要正文里出现了任何一行「普通文本」，
它就会**压过文件名**成为显示名 —— 不限于 H1，也不限于标题行。
`deriveTitle` 的判定是「第一个非空、非围栏、非引用/表格/分隔线的行」，
若它以 `#{1,6}` 开头则取标题文本（`src/lib/utils.ts:64-84`）。

### (b) 现在有几处会算出标题：**恰好 2 处**

| # | 位置 | 何时跑 | 读 `titleOverride` 吗 |
|---|---|---|---|
| 1 | `makeNote()` — `src/data/library.ts:194-214`，标题在 `:201` | 扫描工作区时对**每一个 md 文件**跑一遍（`scanWorkspace` → `emit` → `:451`） | ❌ 不读，先写成 `deriveTitle`，`titleOverride: null`（`:202`） |
| 2 | `refresh()` — `src/data/library.ts:216-228`，标题在 `:223` | 编辑器每敲一个键（`updateNoteContent` → `:1044`） | ✅ 读，`note.titleOverride ?? deriveTitle(...)` |

`deriveTitle` 在 `src/` 下的**全部**调用点只有这 2 处（外加它自己的单测 `src/lib/utils.test.ts:17-36`
与剪藏侧的两处断言 `src/lib/clip/frontmatter.test.ts:94`）。
全仓搜索 `deriveTitle` 的 import 者：只有 `src/data/library.ts:21`。

**没有第三处。** 但有一个**必须知道的「补挂点」**：
`scanWorkspace` 在第 3 阶段发布完之后，于 `:471-480` 把 `state.json` 里的 `titleOverrides`
挂回 `Note.title` / `Note.titleOverride` —— 它不是第三个「算标题」的地方，
而是**把 ① 重新贴回被 ② 算出来的结果上**的落点。改规则时它必须跟着改，否则重扫会把规则改回去。

> 所以「改标题规则要改几个地方」的答案是：**改 `deriveTitle` 的语义（1 个函数）+ 确认 `refresh` 与 `scan 挂回` 两处的一致**，
> 而不是「有 N 处各写了一遍规则」。

### (c) 「正文标题优先于文件名」是有意设计还是历史遗留

**两者都有，要分开说**：

**文档明说（有原文可引）**——「标题必须来自正文 H1 或 state 里的 `titleOverride`」这句话**确实存在**，
但它在**导入/剪藏**这条设计线上，不在「重命名」这条线上：

- `docs/import/00-项目简报与范围锁定.md:36`（事实基线 §2 第 5 条，原文）：
  > **其他 front-matter 键（如 `title:`、`source:`）当前是惰性的**——会被 `deriveTitle()`/`stripMarkdown()` 当元数据跳过后忽略。
  > …（**写了 `title:` 不会改变笔记标题**，标题必须来自正文 H1 或 state 里的 `titleOverride`）。
- `docs/import/00-项目简报与范围锁定.md:37`（第 6 条）：
  > **标题推导规则**：`deriveTitle()` 取正文（去 front-matter 后）**第一个标题行**，否则第一行非空文本（`src/lib/utils.ts:61`）。
  > 所以「导入标题」的正确写法是写入 `# 标题`，而不是依赖文件名或 front-matter。
- `docs/import/02-接口契约-导入信封与通道.md:270`（原文，**明确承认文件名与 H1 可以不一致**）：
  > 标题为 200 字符时，文件名只取清洗后的前 80 字符——**文件名与 H1 允许不一致**，这是既有行为
  > （`deriveTitle()` 的上限是 90，`src/lib/utils.ts:51`）。
- 同文件 `:304`：> 6. **正文首行必须是 `# {title}`**。因为 `deriveTitle()` …取正文（去 front-matter 后）第一个标题行，写 `title:` 键**完全无效**。
- `docs/import/04-评审报告-一致性核查.md:86-88` 逐条核过 F-1/F-2/F-3，结论「**正确**」，
  其中 F-3 还特意指出 `titleOverride` 只是应用内状态、**不由 front-matter 驱动**。
- 代码注释也复述了这条设计：`src/lib/clip/frontmatter.ts:24`「`deriveTitle()` …**不读 front-matter**，只认正文第一个标题行」。

**代码推断（无文档背书）**——「**文件名**只是兜底、且永远不反向同步」这一条：

- `deriveTitle` 的形参名与注释就写死了这个立场：`fallback = "无标题"`（`src/lib/utils.ts:61`），
  调用点传的是 `stripExtension(baseName(path))`（`src/data/library.ts:201`）——**文件名被降级成 fallback**。
- `Note.title` 的类型注释：「Denormalised title, kept in sync with the content (or with `titleOverride`)」
  （`src/data/types.ts:36`）——同步方向只有「正文 → 标题」，**没有一个字提到文件名**。
- 反面证据（曾有过「改标题就改文件名」的念头，但只是审计记录，从未落地）：
  `docs/缺陷审计报告-2026-09-29.md:225` 补充段写着
  > 把字打进**第一行**时会触发「改标题→改文件名→note id 变化」，新 id 天然缓存未命中，因此该路径看不出问题
  这是 D05 的**排查备注**，描述的是当时的**假想链路**；当前 HEAD 的 `updateNoteContent`（`:1037-1053`）
  **完全不碰 `note.id`、不碰 `target.move`**，该链路不存在。

**裁定**：优先级的**方向**（正文优先、front-matter 无效）是**有意设计且有文档**；
「文件名永远不跟随正文」是**历史遗留的副作用** —— 它是「把文件名当 fallback」这条实现的自然结果，
文档只在一处**顺带承认**了它（`02:270`「文件名与 H1 允许不一致，这是既有行为」），
**没有任何一处把它当作一条要遵守的规则来论证**。用户 2026-10-09 的诉求正是要打破这一条。

### (d) 「H1 停笔 5 秒后自动改名文件」缺在哪一层

三层里**只缺最后一层**，前两层现成：

| 层 | 现状 | 证据 |
|---|---|---|
| **数据层（搬文件）** | ⚠️ **有零件、没有产品**。`renameNote()` 是一个完整的「改名 + 重挂 override + 落 state.json」实现，但它只被右键菜单调用，**没有任何自动调用方** | `src/data/library.ts:1147-1180`；唯一调用点 `src/components/Sidebar.tsx:896` |
| **编辑器回调** | ✅ **通着**。CodeMirror `updateListener` → `onChange` → `EditorPane` → `onDocChange` → `updateNoteContent`，**每一次 docChanged 都到数据层** | `src/editor/setup.ts:168-169` → `src/components/EditorPane.tsx:67-70` → `src/App.tsx:1299-1302` → `src/data/library.ts:1037` |
| **防抖调度（停笔计时器）** | ❌ **完全没有**。数据层只有「落盘去抖」`persistNoteSoon`（`:904-908`，450ms）和「元数据去抖」`scheduleMeta`（`:920-923`，700ms），两者都**不判断 H1 是否变化、也不搬文件**。`src/lib/utils.ts:16-34` 有现成的 `debounce()`（带 `cancel`/`flush`），但 `src/data/` 下**没有任何文件 import 它**（全仓 `debounce` 命中：`utils.ts` 定义 + `library.ts:619/628` 的注释文字） | `src/lib/utils.ts:16-34`；`grep debounce src/` |

**结论**：这条能力的缺口是**「一个坐在 `updateNoteContent` 旁边的、按笔记计时的调度器」**，
而不是编辑器接线，也不是「没有 rename 能力」。

---

## 2. `deriveTitle()` 的完整规则（逐行）

`src/lib/utils.ts:51` + `:54-58` + `:61-86`

```
TITLE_LIMIT = 90                                    // :51

splitFrontMatter(md)                                // :54-58
  └ 正则 /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/   // :55
    · 要求 `---` 位于**文件最开头**（允许一个 BOM）
    · 命中则整块（含结束的 --- 行）从正文里切掉 → 后续只扫 body

deriveTitle(md, fallback = "无标题")                 // :61
  对 body.split("\n") 逐行：
  1. line = rawLine.trim()                          // :65
  2. 围栏代码：/^(```+|~~~+)/                        // :66
     · 开栏 → fence = marker（marker 只取首字符 ` 或 ~）
     · 同字符再出现 → fence = null
     · 该行本身 continue（围栏行永远不是标题）        // :71
  3. fence !== null → continue（围栏内的 # 一律不认） // :73
  4. 空行 → continue                                // :74
  5. 标题行：/^(#{1,6})\s+(.*)$/                     // :75  ★ H1–H6 全部算，不只是 H1
     · cleanInline(heading[2]) 后非空 → return 文本.slice(0, 90)   // :77-78
     · 空标题（如 `#` 后无内容、或 `# ** **`）→ continue，继续往下找  // :79
  6. 引用/表格/分隔线：/^(>|\||-{3,}|\*{3,}|_{3,})/ → continue      // :81
  7. 其它任何非空行：cleanInline(line) 非空 → return 文本.slice(0, 90) // :82-83
  8. 全篇扫完没有可用的行 → return fallback          // :85
```

`cleanInline()`（`:89-101`）会剥掉图片/链接语法（**保留 alt 与链接文字**）、行内代码、
粗斜体/删除线/高亮标记、HTML 标签，并把连续空白压成一个空格 —— 所以
`# **重点** 与 [链接](x) 和 \`code\`` → `重点 与 链接 和 code`（单测 `src/lib/utils.test.ts:36`）。

**已由单测钉住的行为**（`src/lib/utils.test.ts:15-37`，本次实跑通过）：

| 输入 | 期望 | 依据 |
|---|---|---|
| `# 标题\n\n正文` | `标题` | `:17` |
| `intro\n\n# 标题\n\n正文` | `intro`（**普通首行压过 H2/H3**） | `:21` |
| `只是第一行\n第二行` | `只是第一行` | `:22` |
| front matter 后才是真标题 | `真正的标题` | `:27` |
| 全空白 | `无标题`（fallback） | `:31` |
| `""` + 自定义 fallback | 该 fallback | `:32` |
| 行内语法剥离 | `重点 与 链接 和 code` | `:36` |

---

## 3. `title` / `titleOverride` 的每一个写入 / 读取点（`src/data/library.ts`）

### 3.1 类型与注释原文（`src/data/types.ts:33-51`）

```ts
export interface Note {
  id: Id;
  folderId: Id | null;
  /** Denormalised title, kept in sync with the content (or with `titleOverride`). */   // :36
  title: string;                                                                        // :37
  /** Set when the user renames a note from the tree; wins over the derived title. */    // :38
  titleOverride: string | null;                                                          // :39
  content: string;
  ...
}
```

`WorkspaceMeta.titleOverrides` 的注释原文（`src/data/library.ts:88-101`）：
> 手动改过的显示名（`renameNote`），按笔记路径存。
> 为什么必须存在这里：`Note.title` 是**派生字段** …（正文里第一个标题赢，文件名只是兜底）。
> 用户实测（0.5.0）：「重命名完成后，再点击其他地方，文件名又会恢复，或者直接就不修改」……
> 「重命名只改显示名；正文里的一级标题不会被改写」（重命名对话框的原话）要成立，
> 新名字就得是**这一态的真源**：写进 `state.json`，重扫时挂回 `Note.titleOverride`，键跟着笔记走。

### 3.2 写入点（谁把标题写进内存 / 磁盘）

| # | 行号 | 函数 | 写什么 | 备注 |
|---|---|---|---|---|
| W1 | `:201` | `makeNote()` | `title: deriveTitle(text, stripExtension(baseName(path)))` | 扫描时对每个文件跑 |
| W2 | `:202` | `makeNote()` | `titleOverride: null` | 每次扫描都从 null 开始 |
| W3 | `:223` | `refresh()` | `title: note.titleOverride ?? deriveTitle(text, stripExtension(baseName(note.id)))` | 打字时跑 |
| W4 | `:471-480` | `scanWorkspace()` 第 3 阶段收尾 | 把 `workspaceMeta.titleOverrides` 挂回：`{ ...note, titleOverride: title, title }`（`:476`），按 `notes[path] ?? trash[path]` 落到对应桶（`:477-478`） | **重扫后名字还在的唯一落点**；注释 `:464-470` 说明**刻意不清**「路径已不在扫描结果里」的条目 |
| W5 | `:769-780` | `rescanWorkspace()` 的「保脏」分支 | `title: local.title, titleOverride: local.titleOverride`（`:773-774`） | 扫描读到的字节比内存旧时，**保留本地标题**，别被重扫回退 |
| W6 | `:1116-1123` | `setTitleOverride(id, title\|null)` | 写 `meta.titleOverrides[id]`；空表时置 `undefined`（`:1121`）；`scheduleMeta(200)` | 「手动显示名」的**唯一真源** |
| W7 | `:1126-1134` | `moveTitleOverride(from, to)` | 删旧键、写新键；`scheduleMeta(400)` | 回收站 / 恢复两条路 |
| W8 | `:1137-1145` | `dropTitleOverrides(within)` | 按谓词清账；空表置 `undefined`；`scheduleMeta(400)` | 彻底删除 / 清空回收站 / 删文件夹 |
| W9 | `:1169-1173` | `renameNote()` | `patchNotes(... title: clean, titleOverride: clean ...)`（`:1171`）+ `setTitleOverride(nextPath, clean)`（`:1173`） | **同时**写内存与 meta |
| W10 | `:1898-1900` | `remapIds()` | `titleOverrides` 的**每个键**过一遍 `replace(path)` | 重命名 / 移动 / 文件夹前缀提升时键跟着走 |
| W11 | `:302` / `:309` | `readMeta()` | 解析并校验 `parsed.titleOverrides`（`:302`），有值才放进 meta（`:309`） | 空表不写进 `state.json` |
| W12 | `:107-114` | `readTitleOverrides()` | 只留「非空字符串 → 非空字符串」，其余一律丢掉（`:111`） | 防手改坏的 state.json |
| W13 | `:945-958` | `flushMeta()` → `writeStateFile()`（`:939-943`） | 把整个 meta 写成 `.opennote/state.json` | `renameNote` 在 `:1176` **立刻** `await flushMeta()`，不等 200ms 去抖 |

### 3.3 调用关系（谁调谁）

```
createNote()                    :985-1001  ── makeNote()               :194  (W1/W2)
scanWorkspace()                 :349-482   ── makeNote()               :451  (W1/W2)
                                          └─ readMeta()               :460  (W11/W12)
                                          └─ 挂回 titleOverrides       :471-480 (W4)
updateNoteContent()             :1037-1053 ── refresh()                :1044 (W3)
restoreSnapshot()               :2479-2484 ── updateNoteContent()      :2483 (W3)
renameNote()                    :1147-1180 ── setTitleOverride()       :1173 (W6)
                                          └─ flushMeta()              :1176 (W13)
                                          └─ remapIds()               :1165 (W10)
                                          └─ moveHistory()            :1166
trashNote()                     :1301-1340 ── moveTitleOverride()      :1316 (W7)
restoreNote()                   :1342-1402 ── moveTitleOverride()      :1361 (W7)
purgeNote()                     :1498-1513 ── dropTitleOverrides()     :1504 (W8)
emptyTrash()                    :1515-1530 ── dropTitleOverrides()     :1523 (W8)
deleteFolder()                  :1647-1704 ── remapIds(prefix)         :1673/:1689 (W10)
moveNote() / moveFolder() / renameFolder() ── remapIds()               :1234/:1722/:1621 (W10)
rescanWorkspace()               :737-800   ── 保脏分支保留本地标题      :770-780 (W5)
```

**清理动作的调用点清单**（改规则时别漏）：
`purgeNote:1504`（`path === id`）、`emptyTrash:1523`（`path === TRASH_DIR || startsWith`）、
`deleteFolder` 走的是 `remapIds` 的 prefix 分支（`:1673`、`:1689`）。

---

## 4. 数据流：从编辑器敲键到标题出现在界面上

```
用户敲键
  └─ CodeMirror updateListener（src/editor/setup.ts:168-169）
       if (update.docChanged) hooks.onChange(update.state.doc.toString())
     └─ EditorPane 的 onChange 钩子（src/components/EditorPane.tsx:67-70）
          expectedRef.current = doc
          propsRef.current.onDocChange(doc)
        └─ App.tsx 的 onDocChange（src/App.tsx:1299-1302）
             if (!activeId) return;
             updateNoteContent(activeId, doc);
           └─ updateNoteContent(id, content)（src/data/library.ts:1037-1053）
                · 内容没变 → 直接 return（:1043）  ★ 纯改 H1 时内容一定变了，能走到下一步
                · const next = refresh(previous, content)   （:1044）
                   └─ refresh()（:216-228）
                        title = note.titleOverride ?? deriveTitle(text, 文件名)   （:223）  ★ 显示名在这里现算
                · 写进 notes 或 trash（:1046-1047）
                · markDirty(id)（:1048）、invalidateSearchCache(id)（:1049）
                · persistNoteSoon(id)（:1051，450ms 去抖落盘正文）
                · maybeSnapshot(previous, next)（:1052，3 分钟节流）
                ★★ 到此为止：没有 target.move，没有改 note.id，没有改磁盘文件名 ★★

界面因此自动更新（订阅同一个 store）：
  · 侧栏文件树行  <Sidebar.tsx:976>  {note.title}
  · 侧栏搜索命中  <Sidebar.tsx:1289> {hit.note.title}
  · 侧栏回收站行  <Sidebar.tsx:1112> {note.title}
  · 标签栏        <TabBar.tsx:61>    {note.title}
  · 浏览器标题    <App.tsx:447>      document.title = `${activeNote.title} · Opennote`
  · 命令面板条目  <CommandPalette.tsx:59/124> entry.title（由 App.tsx:1058 note.title 喂入）
```

**「停笔 5 秒」最自然的挂点就在 `updateNoteContent` 内部、`refresh()` 之后**（`:1044` 与 `:1048` 之间），
理由：
1. 它是**唯一**「正文变化」的入口（打字、快照恢复、导入入库全走它）；
2. 它已经按 `id` 分桶，天然能拿到「这一篇笔记」的当前标题与当前路径；
3. 它已经在做去抖落盘（`persistNoteSoon`，450ms），旁边再加一个**语义不同的**计时器不会打架，
   但**必须分开命名**（例如 `titleFollowTimers`），否则「落盘去抖」与「改名去抖」会互相取消。

---

## 5. 全量 `target.move(` 调用点：**没有一处由 H1 触发**

`grep -n "\.move\(" src/` 的结果（排除三个后端自身的实现与它们的单测）：

| 行号 | 所在函数 | from → to | 触发者 |
|---|---|---|---|
| `library.ts:1059` | `moveCaseOnly()` | `id` → 临时名 | 只改大小写的重命名（D07） |
| `library.ts:1061` | `moveCaseOnly()` | 临时名 → `nextPath` | 同上 |
| `library.ts:1063` | `moveCaseOnly()` 回滚 | 临时名 → `id` | 失败回滚 |
| `library.ts:1091` | `moveHistory()` | `history/<oldId>` → `history/<newId>` | 重命名/移动的**副作用**（快照目录跟随） |
| `library.ts:1104` | `mergeHistory()` | 历史目录内逐条 | 合并两套历史目录 |
| `library.ts:1164` | `renameNote()` | `id` → `nextPath` | **右键菜单「重命名」**（`Sidebar.tsx:896`） |
| `library.ts:1233` | `moveNote()` | `id` → 目标目录 | 菜单「移动到…」/ 拖放（`Sidebar.tsx:965` 等） |
| `library.ts:1310` | `trashNote()` | `id` → `.opennote/trash/<id>` | 菜单「移到回收站」 |
| `library.ts:1351` | `restoreNote()` | 回收站路径 → 原路径 | 回收站「恢复」 |
| `library.ts:1356` | `restoreNote()` | 旧布局 `assets/` → 恢复后位置 | 旧数据兼容 |
| `library.ts:1620` | `renameFolder()` | 文件夹 → 新名 | 文件夹右键「重命名」 |
| `library.ts:1660` | `deleteFolder("trash")` | 整个目录 → 回收站 | 删除文件夹 |
| `library.ts:1688` | `deleteFolder("promote")` | 目录内条目逐个上移 | 删除文件夹（笔记上移） |
| `library.ts:1721` | `moveFolder()` | 文件夹 → 新父目录 | 拖放 / 菜单 |

**逐条判定「是否由 H1 触发」：全部为否。** 每一个调用点都在一个**用户显式动作**（右键菜单、拖放、删除）
或该动作的**配套副作用**（历史目录跟随、附件引用重算）之下，没有一条的输入是 `deriveTitle(...)` 的结果。

**反向确认**（三层都空）：
- 数据层：`updateNoteContent`（`:1037-1053`）里没有任何 `target.move`；
- 编辑器层：`EditorPane`（`src/components/EditorPane.tsx` 全文 230 行）只有一个 `onDocChange` 回调，没有改名逻辑；
- 调度层：`src/data/` 下没有 import `debounce`（`src/lib/utils.ts:16-34` 的定义只被注释提及）。

**导入路径也不改文件名**（用户「笔记本里大量文件就叫 `无标题.md`」的成因在这里）：
- 手动导入 `src/lib/import.ts:80-89`：文件名来自**源文件自身的名字**（`sanitizeName(name)`，`:82`），正文原样写入（`:87`）；
- 剪藏入库 `src/lib/clip/landing.ts:25-28` `requestedNotePath()`：文件名来自**信封的 `title`**，
  正文首行由 `frontmatter.ts` 写成 `# {title}` —— 这条路上两者**恰好一致**，但一致的原因是**两个产地都读了 `title`**，
  不是「一方跟随另一方」；
- 因此「外部给的文件名」与「正文里的 H1」可以永久不一致，**没有任何机制会去收敛它们**。

---

## 6. 标题在界面上被显示的位置（消费者全表）

| 界面 | 文件:行 | 显示哪个字段 | 备注 |
|---|---|---|---|
| 侧栏 · 文件树行 | `Sidebar.tsx:976` | `note.title` | 行 `title=` 属性在 `:1098`（回收站）；`:45` 是标签栏 |
| 侧栏 · 回收站行 | `Sidebar.tsx:1112` | `note.title` | 彻底删除确认框 `:1136` |
| 侧栏 · 搜索命中（平铺） | `Sidebar.tsx:1289` | `hit.note.title` + `hit.snippet` | 命中理由用 `note.title`（`library.ts:2197`） |
| 侧栏 · 筛选高亮 | `Sidebar.tsx:1197` | `note.title` 参与 `haystack` | 本地二次过滤 |
| 标签栏 | `TabBar.tsx:45`（`title=`）、`:61`（可见文本） | `note.title` | |
| 浏览器 / 窗口标题 | `App.tsx:447` | `document.title = \`${activeNote.title} · Opennote\`` | |
| 命令面板 · 笔记条目 | `App.tsx:1058` → `CommandPalette.tsx:59/124` | `entry.title` | 同处 `:1078-1084` 的「本页」标题条目走**另一条**：`extractHeadings(content)`（`App.tsx:150`，`src/lib/outline.ts:14-38`）——**大纲读正文、不读 `note.title`** |
| 命令面板 · 标题搜索权重 | `library.ts:2197`、`:2212`（`60 - min(30, inTitle)`）、`:2237` | `note.title` | 标题命中权重最高 |
| 侧栏 · 排序 | `library.ts:2016` | `a.title.localeCompare(...)` | `SortKey = "title"` |
| 大纲面板 | `src/lib/outline.ts:14-38` → `Outline.tsx:34` | **`extractHeadings(正文)`** | **不读 `note.title`**；H1–H6 全收（`:33`） |
| 快照历史面板 | `AppDialogs.tsx:644-654` | **不显示标题**，只显示时间 + 类型 + 字符数 | `Snapshot.title` 恒为 `""`（`library.ts:2461`） |
| 收件箱 | `InboxPanel.tsx:142/615/639-641` | `entry.title`（**信封的 title**，不是 `Note.title`） | 入库后展示 `entry.notePath`（`:612-613`） |
| 导出 · Markdown | `src/lib/export.ts:35` | `sanitizeName(note.title) + ".md"` | 下载文件名 |
| 导出 · HTML | `src/lib/export.ts:73` | `<title>${escapeHtml(note.title)}</title>` | |
| 通知 / toast | `Sidebar.tsx:825/830/923`、`App.tsx:951` | `note.title` | 「「X」已移入回收站」等 |
| 复制路径 | `Sidebar.tsx:912-913` → `src/lib/notePath.ts` | 用 `note.id`（**不是 title**） | 路径与显示名是两回事 |
| wiki 链接补全 / 跳转 | `App.tsx:501`、`:510`、`App.tsx:1297` → `setup.ts:148` | `note.title` | **按显示名匹配**：`notes.find(n => n.title === title)` |

> 最后一行值得单独标出：**wiki 链接（`[[标题]]`）是按 `note.title` 匹配的**。
> 这意味着「自动改名」一旦落地，`[[无标题]]` 这类链接的解析结果会**跟着显示名一起变**——
> 属于实施时必须一并评估的影响面（见 §8 待验证）。

---

## 7. `dce308b` 修了什么、没修什么

提交原文（`git log -1 --format=%B dce308b`，逐字摘要）：

```
fix(data): 重命名后显示名不再被正文里的 H1 顶回去
用户实测：「重命名完成后，再点击其他地方，文件名又会恢复，或者直接就不修改」。
根因：Note.title 是派生字段 —— makeNote() / refresh() 都拿 deriveTitle(正文, 文件名) 现算
（正文里第一个标题赢，文件名只是兜底），而 renameNote() 只把新名字写进内存里的 title。
于是 ① 在编辑器里打字 → refresh() → 正文 H1 顶回去；② 任何一次重扫 → makeNote() → 同样顶回去；
③ 重开笔记本只能读 state.json，而新名字从来没落过盘。
按既有设计补齐（Note.titleOverride 这个字段本来就在类型里，`00` §2.5 也写着
「标题必须来自正文 H1 或 state 里的 titleOverride」，但从来没有代码写过它）：
 - renameNote：写 Note.titleOverride 并落成 .opennote/state.json 的 titleOverrides，随后立刻 flushMeta
 - refresh()：认 note.titleOverride ?? deriveTitle(...)，打字不再覆盖
 - scanWorkspace()：每次扫描后把显示名挂回 Note
 - 键跟着笔记走：remapIds 与回收站/恢复各搬一次；彻底删除、清空回收站、删文件夹时清账
 - README.md：.opennote/state.json 的说明补上「手动改过的显示名（重命名）」
验证：先写的 4 条判据在修复前有 3 条当场变红，修复后 4 条全绿。pnpm typecheck 0 错、pnpm test 762 通过。
```

改动文件（`git show --name-only dce308b`）：`README.md`、`src/data/library.files.test.ts`、`src/data/library.ts`。

**它引用的「`00` §2.5」在仓库里存在，原文如下**（`docs/import/00-项目简报与范围锁定.md`，事实基线 §2 第 5 条，文件第 36 行）：
> **front-matter 目前只被用于 tags** … **其他 front-matter 键（如 `title:`、`source:`）当前是惰性的** …
> 这也是关键陷阱（**写了 `title:` 不会改变笔记标题**，标题必须来自正文 H1 或 state 里的 `titleOverride`）。

→ 所以 `dce308b` 的「按既有设计补齐」是**有据可依**的：那句话确实是设计文档的原文。
但**那句话谈的是「标题的真源」，不是「文件名的真源」** —— 它没有、也从未主张过「文件名要跟随 H1」。

**`dce308b` 的覆盖边界**：

| 现象 | `dce308b` 后 | 证据 |
|---|---|---|
| 右键改名 → 侧栏即时更新 | ✅ 修好 | `renameNote` 同时写 `title` + `titleOverride`（`:1169-1173`） |
| 右键改名 → 磁盘文件名跟着改 | ✅ **本来就成立** | `target.move(id, nextPath)`（`:1164`），早于 `dce308b` |
| 改完名 → 打字 → 名字被正文 H1 顶回去 | ✅ 修好 | `refresh()` 认 override（`:223`） |
| 改完名 → 重扫（文件监听 / Ctrl+S）→ 名字被顶回去 | ✅ 修好 | `scanWorkspace` 挂回（`:471-480`） |
| 改完名 → 重启 → 名字还在 | ✅ 修好 | `state.json` 的 `titleOverrides`（`:1169-1176`、`:302`） |
| **写 H1 → 磁盘文件名自动变成 H1** | ❌ **完全不存在**（`dce308b` 之前之后都没有） | §5 全部 `target.move` 调用点均无此触发 |

**回归证据**（`src/data/library.files.test.ts:186-227`，本次实跑 30/30 通过）：
重扫后 / 打字后 / 重开笔记本后 / 进回收站再恢复后，四条都断言 `title === "改名"`。

---

## 8. 「H1 停笔 5 秒自动改名」的实施建议（只给方案，本次不改代码）

### 8.1 要补的三样东西

| 补什么 | 挂在哪 | 为什么是这里 |
|---|---|---|
| ① 一个按笔记 id 的停笔计时器表 | `src/data/library.ts` 模块级，紧邻 `writeTimers`（`:125`）/`lastSnapshotAt`（`:127`） | 与既有去抖表同一层，`resetWorkspaceTransients()`（`:599-606`）要一并清 |
| ② 在正文变化处重置计时器 | `updateNoteContent()`（`:1037-1053`）`refresh()` 之后、`persistNoteSoon` 旁边 | 唯一入口；`options.immediate`（快照恢复）应**跳过**自动改名或立即执行，二者需明确裁定 |
| ③ 一个「按内容算出的标题 → 改名」的执行体 | 复用 `renameNote()`（`:1147`）**或**抽一个内部 `applyAutoTitle(id, title)` | `renameNote` 已处理：大小写特例（`moveCaseOnly`）、重名序号（`resolveAvailablePath`）、历史目录跟随（`moveHistory`）、override 落盘（`setTitleOverride` + `flushMeta`）——**不要另写一份**，否则「右键改名」与「自动改名」两条路会漂移 |

### 8.2 必须一起裁定的语义冲突（这是本方案真正的风险点）

1. **与现有承诺冲突**：右键重命名对话框写着「重命名只改显示名；正文里的一级标题不会被改写」
   （`Sidebar.tsx:893`），且 `renameNote` 会**写下 `titleOverride`**（`:1173`）。
   一旦用户手动改过名，`refresh()`（`:223`）就永远不再看正文 ——
   **自动改名必须先判断「这篇有没有 override」**，否则用户手改的名字会被下一次停笔顶掉。
2. **自动改名后要不要留 override**：
   - 留 → 显示名与文件名一致，但从此正文再变也不跟随（除非清 override）；
   - 清 → 标题回到 `deriveTitle(正文)`（此时与文件名相同），跟随能力持续有效，但「用户手改过」的痕迹丢失。
   建议**留 override**（与「手动改过就是真源」一致），并在**下一次正文 H1 变化时**再触发一次跟随。
3. **递归风险**：自动改名走 `renameNote` → `remapIds`（`:1840-1903`）→ 会改 `ui.tabs/activeId`（`:1886-1891`）。
   计时器必须**按新路径重新挂**，否则改名后计时器指向一个不存在的 id。
4. **磁盘监听回环**：改名会触发主进程的文件监听 → `scheduleWatchRescan`（`:689-696`，500ms 去抖）→ `rescanWorkspace`。
   现有代码已能承受（重扫会挂回 override，`:471-480`），但要**确认不会与「停笔计时器」互相触发成环**。
5. **空 H1 / 退化情形**：`deriveTitle` 在正文没标题时返回**文件名的 stem**（`:201`/`:223`）。
   若不加判断就执行改名，会出现「文件名 → 标题 → 文件名」的同名空操作（`renameNote:1153` 已 return，安全）
   以及「把 `无标题.md` 改成 `无标题.md`」的无意义调用。建议**只在正文里真的存在标题行时**才自动改名。
6. **影响面**：wiki 链接按 `note.title` 匹配（`App.tsx:501/510`）、命令面板标题权重（`library.ts:2197`）、
   侧栏排序（`:2016`）、导出文件名（`export.ts:35`）都会跟着变 —— 这些是**期望行为**，但要在验收清单里列明。
7. **建议的开关**：`UiSettings` 里加一项（例如 `autoRenameFromH1: boolean`），默认值需产品裁定；
   设置项落在 `src/data/types.ts:118-183` 的 `UiSettings` 与 `src/data/ui.ts` 的默认值里。
8. **可撤销**：改名是 `target.move`，没有历史快照可回退；参考既有做法，
   要么给一个 toast + 「撤销」（回调 `renameNote` 改回去），要么明确不做（并如实写进文案）。

---

## 9. 已确认 vs 待验证

### 9.1 已确认（本次读码 + 实跑，逐条可复核）

| # | 结论 | 证据 |
|---|---|---|
| C1 | `deriveTitle` 认 `#{1,6}`（**H2–H6 也会赢**），跳过围栏代码 / 空行 / 引用 / 表格 / 分隔线，上限 90 | `src/lib/utils.ts:51,64-86` |
| C2 | `deriveTitle` 在 `src/` 下只有 2 个调用点：`makeNote:201`、`refresh:223`；`import` 它的只有 `library.ts:21` | 全仓 grep |
| C3 | 优先级：`titleOverride` > 正文派生 > 文件名 stem > `"无标题"` | `library.ts:223`、`:201`、`utils.ts:61` |
| C4 | 文件名只在「正文里没有任何可用行」时被当标题 | `library.ts:201/223` + `utils.ts:64-85` |
| C5 | 手动显示名落 `.opennote/state.json` 的 `titleOverrides`，键是**笔记路径** | `library.ts:101,107-114,302,309,1116-1123` |
| C6 | `renameNote` 会**同时**改磁盘文件名与显示名，并立刻 `flushMeta` | `library.ts:1164,1169-1176` |
| C7 | 14 个 `target.move` 调用点，**没有一处**的输入是 `deriveTitle` 的结果 | §5 表 + `library.ts:1059-1721` |
| C8 | 编辑器链路是通的：`setup.ts:168` → `EditorPane.tsx:67` → `App.tsx:1299` → `library.ts:1037` | 三处代码 + 逐级回调 |
| C9 | 数据层**没有**任何 import `debounce` 的地方；只有 450ms 落盘去抖与 700ms 元数据去抖 | `library.ts:904,920`；`utils.ts:16-34` |
| C10 | 「停笔 5 秒改名」缺的是**调度层**（+ 一个执行体），不是编辑器接线 | §1(d)、§8.1 |
| C11 | 设计文档**明说**「标题必须来自正文 H1 或 state 里的 `titleOverride`」 | `docs/import/00-…md:36`；`02-…md:270,304`；`04-…md:86-88` |
| C12 | 设计文档**只在 `02:270` 顺带承认**「文件名与 H1 允许不一致」，未把它当规则论证 | `docs/import/02-…md:270` |
| C13 | `dce308b` 引用的是 `docs/import/00-…md:36`，原文与提交信息一致 | `git log -1 --format=%B dce308b` + 文件原文 |
| C14 | `dce308b` 只动 3 个文件（README / library.ts / library.files.test.ts），**不涉及任何 `target.move`** | `git show --name-only dce308b` |
| C15 | 大纲 / 快照面板**不读** `note.title`（大纲读正文标题，快照面板不显示标题） | `outline.ts:14-38`、`AppDialogs.tsx:644-654`、`library.ts:2461` |
| C16 | 导入与剪藏都**不把文件名同步到 H1**（手动导入用源文件名；剪藏两条路各自读信封 `title`） | `import.ts:80-89`、`landing.ts:25-28`、`frontmatter.ts:119` |
| C17 | 测试基线绿：`library.files` 30 + `library.p2` 20 + `utils` 21 + `library.meta` 4 + `library.watch` 11 = **86 passed** | 见 §10 |

### 9.2 待验证（本任务未取得确定性证据，**不要当作结论使用**）

| # | 待验证项 | 为什么没定 | 建议怎么验 |
|---|---|---|---|
| V1 | 用户真实笔记本里「大量 `无标题.md`」的成因分布 | 本任务只读代码，没有用户磁盘 | 让用户提供一个脱敏的文件名清单，或跑一次 `scanWorkspace` 统计「文件名 ≠ `deriveTitle(正文)`」的比例 |
| V2 | 自动改名与主进程文件监听的**回环行为** | 需要真机 Electron + 文件监听（`library.watch.test.ts` 用的是测试后端，不是真 `fs.watch`） | 真机跑：写 H1 → 等 5s → 看 `workspace-changed` 触发几次、是否重扫回退名字 |
| V3 | `docs/import/04-…md:88` 引用的行号（`types.ts:19`、`library.ts:166`）已失效 | 该报告写于更早的版本，当前 `titleOverride` 在 `types.ts:39`、`setTitleOverride` 在 `library.ts:1116` | 已在 §3.1 给出当前行号；若下游要引旧报告，须标注「行号已漂移」 |
| V4 | `Note.title` 变化对 `[[wiki 链接]]` 解析的**具体影响范围** | 只确认了匹配用 `title`（`App.tsx:501/510`），没确认是否有反向索引 | 搜一遍现有笔记本里的 `[[...]]`，确认有多少指向「显示名」而非「文件名」 |
| V5 | 快照恢复（`restoreSnapshot` → `updateNoteContent(..., {immediate:true})`）与自动改名的交互 | 需产品裁定「恢复快照要不要顺手改名」 | 在实现阶段作为一条判据写进测试 |
| V6 | 移动端（Capacitor 壳）上 `target.move` 的可用性 | 本任务未跑移动端后端 | `src/fs/capacitorBackend.test.ts:276-292` 有 move 用例（读码可见），但未在真机跑 |

---

## 10. 本次实跑命令与输出

```
$ npx vitest run src/data/library.files.test.ts src/lib/utils.test.ts
 ✓ src/lib/utils.test.ts (21 tests) 15ms
 ✓ src/data/library.files.test.ts (30 tests) 44ms
 Test Files  2 passed (2)   Tests  51 passed (51)

$ npx vitest run src/data/library.files.test.ts src/data/library.p2.test.ts src/lib/utils.test.ts \
                src/data/library.meta.test.ts src/data/library.watch.test.ts
 ✓ src/lib/utils.test.ts (21 tests) 16ms
 ✓ src/data/library.meta.test.ts (4 tests) 10ms
 ✓ src/data/library.watch.test.ts (11 tests) 22ms
 ✓ src/data/library.files.test.ts (30 tests) 45ms
 ✓ src/data/library.p2.test.ts (20 tests) 362ms
 Test Files  5 passed (5)   Tests  86 passed (86)
```

`git status --short` 只显示 `?? .agent-teams/`（团队状态目录），**源码与文档在本任务前未被改动**。

---

## 11. 证据索引（按结论回溯）

| 结论 | 主证据 |
|---|---|
| 优先级 / 派生 | `src/data/library.ts:201`、`:223`、`src/data/types.ts:36-39` |
| 手动名真源 | `src/data/library.ts:88-101`、`:107-114`、`:1116-1123`、`:1169-1176`、`:302/309` |
| 重扫挂回 | `src/data/library.ts:464-480`、`:769-780` |
| 键跟随 | `src/data/library.ts:1126-1134`、`:1137-1145`、`:1892-1903` |
| 无自动改名 | §5 全部 `target.move` 调用点；`src/data/library.ts:1037-1053` |
| 编辑器链路 | `src/editor/setup.ts:168-169`、`src/components/EditorPane.tsx:67-70`、`src/App.tsx:1299-1302` |
| 设计文档 | `docs/import/00-项目简报与范围锁定.md:35-37`、`docs/import/02-接口契约-导入信封与通道.md:263-273,304`、`docs/import/04-评审报告-一致性核查.md:86-88` |
| `dce308b` | `git log -1 --format=%B dce308b`、`git show --name-only dce308b`、`src/data/library.files.test.ts:172-227` |
| 界面消费者 | `Sidebar.tsx:976/1112/1289`、`TabBar.tsx:61`、`App.tsx:447/1058/1297`、`export.ts:35/73`、`CommandPalette.tsx:59` |
| 导入不改名 | `src/lib/import.ts:80-89`、`src/lib/clip/landing.ts:25-28`、`src/lib/clip/receive.ts:681-711` |
