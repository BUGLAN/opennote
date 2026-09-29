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

## 2. 我**没有**实现什么（如实，别当已做）

1. **S10 批量模式未做**：没有 batch 接口、没有 `assets` 追加接口、没有并发多封入队的编排。任务只要求单封信封的 L2 接收端。
2. **`overwrite` 实际上永远走不到**：桥侧 `electron/bridge.cjs` 的 `getAdvancedOverwrite()` 恒 `false`（0.2.0 没做高级覆盖开关），
   所以 `conflict:"overwrite"` 到渲染层之前就被降级成 `new` + `IMP-4011`。**我的四道闸门代码是真的、也有测试**，
   但在当前版本里只能通过直接调用 `receiveEnvelope()`（绕开桥）才能触发。
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
Test Files  4 passed (4)
     Tests  120 passed (120)

$ pnpm test
Test Files  28 passed | 1 skipped (29)
     Tests  464 passed | 2 skipped (466)

$ node scripts/verify-contract.cjs
PASS 66 / FAIL 0 / SKIP 1 / INFO 11        exit 0

$ node scripts/verify-e2e.cjs
PASS 81 / FAIL 0 / UNVERIFIED 3 / INFO 4   exit 0
  其中：S1.4/S1.5 字节模板与 8 键顺序、S2.x duplicate 零写入、S3.x ` 2` 后缀、
        S4.x 前像逐字节 + 10 秒窗口、S5.2 pending + inboxId 目录名、S8.2 收件箱满 IMP-4013
```

单测分布：`receive.test.ts` 61 · `envelope.test.ts` 38 · `frontmatter.test.ts` 14 · `hash.test.ts` 7 · `importLog.test.ts` 22（合计 142）。
关键断言都用「能独立红」的方式验过：把修复临时回退后，对应用例会失败（域错误透传 3 条红、`inboxId` 目录名 1 条红、
`IMP-4013` 文案 1 条红），恢复后全绿。

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
