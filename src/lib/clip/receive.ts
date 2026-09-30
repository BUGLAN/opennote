/**
 * L2 应用内接收端：信封校验 → 落点决策 → 前像与日志 → 幂等 → 可撤销回执。
 *
 * 这一层是「外部世界往用户磁盘写文件」的唯一入口（契约 §1.1 / §7），所以三条硬约束
 * 在这里必须同时成立：
 * 1. **永不静默覆盖**：`append` 是加法，`overwrite` 要同时满足四道闸门（00 号 §6.7①），
 *    用户正在编辑的笔记**永不自动覆盖**；
 * 2. **一切改变既有内容的操作都要留逐字节前像**（00 号 §6.7④），否则回执
 *    `revertible: false` 并回 `IMP-W008`，UI 只能承诺「移入回收站 / 看快照」；
 * 3. **同一件事做两次与做一次结果相同**（契约 §4）：`importId` 幂等、`url`+正文哈希去重。
 *
 * 冻结的跨模块接口（C2/C3 依赖，字段名逐字）：
 * - `receiveEnvelope(raw)`：应用内调用，域错误抛 `ImportRejection`；
 * - `receiveEnvelopeOutcome(raw)`：渲染层 ↔ 主进程的 IPC 转交用，**永不抛**（Electron 的
 *   `ipcMain.handle` 会把抛出的异常退化成字符串，`code`/`http` 会丢）；
 * - `validateEnvelope(value)`：纯函数校验器（在 `./envelope`）；
 * - `undoImport(receipt)`：撤销。
 */

import { baseName, stripExtension } from "../../fs/paths";
import type { FileSystemBackend } from "../../fs/types";
import {
  currentBackend,
  flushAll,
  libraryStore,
  rescanWorkspace,
  trashNote,
} from "../../data/library";
import {
  forgetImport,
  lookupImportById,
  lookupImportByContent,
  lookupLatestBySourceUrl,
  markImportUndone,
  nowIso,
  readPreimage,
  recordImport,
  rememberImport,
  writePreimage,
  type ImportIndexEntry,
  type ImportLogEntry,
} from "../../data/importLog";
import { notify } from "../toast";
import {
  ImportRejection,
  checkResolvedBody,
  importProblem,
  isImportRejection,
  isSafeSvg,
  toImportErrorBody,
  validateImportEnvelope,
  utf8Bytes,
  warningText,
  MAX_REQUEST_BYTES,
  serializeEnvelopeJson,
  type ImportEnvelope,
  type ImportProblem,
} from "./envelope";
import { renderAppended, renderMarkdown } from "./frontmatter";
import { bodyHashOf, contentHashOf, sha256Ref, sourceHashOf } from "./hash";
import {
  allocateAssetPath,
  allocateNotePath,
  assetsDirFor,
  ensureFolderDirs,
  findUndeclaredAssetRefs,
  requestedNotePath,
  rewriteAssetRefs,
  type AssetRename,
} from "./landing";

/* ============================== 冻结的接口 ============================== */

/**
 * API-02 的回执（契约 §4.5）。字段名逐字来自契约表；`path` 是**最终**落点
 * （`deduped` / `duplicate` 给首次/既有落点，`pending` 为 `null`）。
 *
 * `message` 与 `undoSeconds` 是 task-2 冻结的附加字段（UI 直接可显示 + 撤销窗口），
 * 不重命名契约里的任何字段。
 */
export interface ImportReceipt {
  status: "created" | "appended" | "deduped" | "duplicate" | "pending" | "skipped";
  importId: string;
  path: string | null;
  inboxId: string | null;
  /** `deduped` 与 `duplicate` 皆为 `true`。 */
  deduped: boolean;
  /**
   * 命中原因（排障用）。`deduped` → `"importId"`，`duplicate` → `"contentHash"`；
   * 其余状态（含 `appended` / `pending` / `skipped`）恒为 `null` —— 00 号 §6.9⑩ 裁定
   * `"sourceUrl"` 枚举只是保留，判定链不产出，验收只看 `importId`/`contentHash`/`null`。
   */
  dedupedBy: "importId" | "contentHash" | "sourceUrl" | null;
  /** `false` 时 UI 只能承诺「移入回收站 / 查看快照」。 */
  revertible: boolean;
  preimage: { path: string; bytes: number; sha256: string } | null;
  /** **实际写入**的附件路径（不是请求里的 `name`）。 */
  assets: string[];
  /** **最终生效**的标签集合（含正文 `#tag` 扫描结果 —— 这里就是信封过滤后的集合）。 */
  tags: string[];
  /** 形如 `"IMP-W002 正文里有未声明的本地附件引用，已原样保留。"` */
  warnings: string[];
  /** 用户可见中文；`duplicate` 恒为规范文案 `已在笔记中（未重复入库）。`。 */
  message: string;
  /** 撤销窗口秒数（仅 append/overwrite 且留有前像时给出）。 */
  undoSeconds?: number;
}

export type EnvelopeOutcome =
  | {
      ok: true;
      /**
       * 契约 §4.1「HTTP」列的状态码（`created` 201 / `pending` 202 / 其余 200）。
       * 桥（`electron/bridge.cjs` 的 `respondWithReceipt`）优先用这个数字，否则它会按
       * 「只有 deduped/skipped 是 200」的启发式把 `duplicate`/`appended` 报成 201、`pending` 报成 201。
       */
      status: number;
      result: ImportReceipt;
    }
  | {
      ok: false;
      error: { code: string; message: string; userMessage: string; http: number; retryable: boolean; detail?: unknown };
    };

/** 重复剪藏的**唯一**规范文案（00 号 §6.12①）：客户端内联显示，**不是应用内 toast**。 */
export const DUPLICATE_MESSAGE = "已在笔记中（未重复入库）。";

/** 撤销窗口：10 秒。必须**显式**传给 `notify()`（`src/lib/toast.ts:28` 对 action 分支默认 6000ms）。 */
export const UNDO_WINDOW_MS = 10_000;

/* ============================== 通道上下文 ============================== */

export type ImportChannel = "in-app" | "local-bridge" | "inbox" | "inpage";

export interface ImportChannelContext {
  /**
   * 落盘请求来自哪条通道。`overwrite` 只在 `"local-bridge"` 上可能生效
   * （00 号 §6.7①：CLI / 扩展 / MCP / Skill / URL scheme / 收件箱一律拒绝或降级）。
   */
  channel: ImportChannel;
  /** 设置里「允许覆盖」的进阶开关，**默认关闭**。 */
  overwriteEnabled: boolean;
}

let channelContext: ImportChannelContext = { channel: "in-app", overwriteEnabled: false };

export function setImportChannelContext(patch: Partial<ImportChannelContext>): void {
  channelContext = { ...channelContext, ...patch };
}

export function getImportChannelContext(): ImportChannelContext {
  return { ...channelContext };
}

export function resetImportChannelContext(): void {
  channelContext = { channel: "in-app", overwriteEnabled: false };
}

/* ============================== 落点偏好（00 §6.14㉕㉖） ============================== */

/**
 * 应用侧「导入落点偏好」= `UiSettings.importConflict` 的**行为层输入**。
 * 四个值与设置面板的选项一一对应，`"inbox"` 就是「先进入收件箱（默认）」。
 */
export type ImportLandingPreference = "new" | "append" | "skip" | "inbox";

/**
 * 默认 `"inbox"`，与 `DEFAULT_UI.importConflict`（00 §6.14㉕：由 `"new"` 改为 `"inbox"`）一致。
 * 这样即使界面接线（task-14）还没落地，行为层也已经是 0.3.0 的语义 —— 不会再出现「改了设置没反应」。
 */
const DEFAULT_LANDING_PREFERENCE: ImportLandingPreference = "inbox";
const LANDING_PREFERENCES: readonly ImportLandingPreference[] = ["new", "append", "skip", "inbox"];

let landingPreference: ImportLandingPreference = DEFAULT_LANDING_PREFERENCE;

/**
 * 接线入口（00 §6.14㉖）：把 UI 层的 `UiSettings.importConflict` 接到行为层。
 *
 * **为什么必须有这个函数**：0.2.0 里 `importConflict` 只被 `ImportApiPanel`（改 UI 值）与 `AppDialogs`（传值）
 * 引用，`receive.ts` 从不读它 —— 用户改了「先进入收件箱」而行为不变，是**假开关**（第 4 例同类缺陷：
 * UI 层的偏好没有通向行为层）。界面侧 mount 时与设置变更时各调一次即可。
 *
 * 运行时脏值（持久化里存的旧值 / 未类型化的调用方）**不采信**：保持当前值并告警，绝不静默落到某个选项上。
 */
export function setImportLandingPreference(pref: ImportLandingPreference): void {
  if (!LANDING_PREFERENCES.includes(pref)) {
    console.warn("[opennote] 忽略非法的导入落点偏好", pref);
    return;
  }
  landingPreference = pref;
}

/** 读回当前偏好（自证 / 设置面板诊断用；不是 `useStore`，不触发渲染）。 */
export function getImportLandingPreference(): ImportLandingPreference {
  return landingPreference;
}

/** 复位到默认（`"inbox"`）；测试与「恢复默认设置」用。 */
export function resetImportLandingPreference(): void {
  landingPreference = DEFAULT_LANDING_PREFERENCE;
}

/**
 * 这次投递是不是「外部通道投递」（需要按偏好强制进收件箱）。
 *
 * - `in-app`：应用内自己发起（AI 面板粘贴等）→ **不受偏好影响**，仍直接落盘 + 可撤销（㉕）。
 * - `inbox`：`commitInbox()` 复投收件箱里那条信封（`src/data/inbox.ts` 传 `channel: "inbox"`）。
 *   这是**用户已经做过决定**的动作（他点了「确认入库」），再强制 pending 会把条目原样塞回收件箱；
 *   所以它**不算外部投递**。㉕ 括号里列了「收件箱」，那指的是「投递进收件箱」这种通道语义，
 *   而确认入库复用了同一个通道值 —— 这里必须排除，否则确认入库会变成死循环。
 * - `local-bridge`（插件 / CLI / MCP / Skill / URL scheme）与 `inpage`（页面内桥）→ 外部投递。
 */
function isExternalDeliveryChannel(channel: ImportChannel): boolean {
  return channel !== "in-app" && channel !== "inbox";
}

/** 客户端在信封里**指明了落点**（`target.folder` 非空、非空白）。 */
function hasExplicitFolder(envelope: ImportEnvelope): boolean {
  const folder = envelope.target && typeof envelope.target.folder === "string" ? envelope.target.folder : "";
  return folder.trim() !== "";
}

/**
 * ㉕「先进入收件箱」是否把这次外部投递强制成 `pending`。
 *
 * 0.3.3 收窄（Lead 裁定，见 `00` 号 §6.16（52））：**偏好管的是「没有指明落点的投递」**。
 *
 * 为什么必须收窄：网页版剪藏页的落点下拉是**用户在确认页上做的决定**（原话「先编辑，确认后
 * 再入库」「支持移动到收件箱或者说其他目录」）。在默认偏好（`importConflict === "inbox"`）下
 * 无条件强制入箱，会让那个下拉变成一个**假开关**：选了「归档」照样进收件箱 —— 而
 * 端到端用**真接收端**一跑就露出来了（桥的替身回 `created`，真接收端回 `pending`）。
 * 本项目已经抓过 4 个假开关，这是第 5 个的同类。
 *
 * **一条都不放松的地方**：㉕.2 的 `overwrite` 仍然**在偏好面前一律优先** ——
 * 「覆盖」是最不可逆的无审阅写入，客户端不能靠「顺手指定一个目录」绕过它。
 */
function inboxPreferenceForcesPending(envelope: ImportEnvelope): boolean {
  if (landingPreference !== "inbox") return false;
  if (!isExternalDeliveryChannel(getImportChannelContext().channel)) return false;
  // ㉕.2：客户端下发的 `overwrite` 在「先进入收件箱」下永远不可达。
  if (envelope.conflict === "overwrite") return true;
  // 指明落点 = 已经做过决定 ⇒ 偏好的作用对象（「没说落点的投递」）不成立。
  return !hasExplicitFolder(envelope);
}

/* ============================ 冲突决策挂钩 ============================ */

export type ImportConflictChoice = "new" | "append" | "skip" | "inbox";

export interface ImportConflictPrompt {
  kind: "editing" | "same-url";
  /** 既有笔记的标题。 */
  title: string;
  /** 既有笔记的工作区相对路径。 */
  path: string;
  /** 上次剪藏时间（ISO 8601），用于 UI-06/S2 的副行。 */
  lastCapturedAt: string | null;
  recommended: ImportConflictChoice;
}

/**
 * UI-06 的挂钩：`src/components/ConflictDialog.tsx` 由 C3 装到 App 上，这里只留一个
 * 「问人」的口子。没有装（CLI / 桥 / 收件箱等无 UI 场景）时走下面的确定性默认策略。
 */
export type ImportConflictResolver = (prompt: ImportConflictPrompt) => ImportConflictChoice | Promise<ImportConflictChoice>;

let conflictResolver: ImportConflictResolver | null = null;

export function setImportConflictResolver(resolver: ImportConflictResolver | null): void {
  conflictResolver = resolver;
}

/* ============================== 通知开关 ============================== */

let notificationsEnabled = true;

/** 无 UI 场景（CLI / 收件箱入库 / 单测）关掉 toast，避免噪声与悬挂的定时器。 */
export function setImportNotifications(enabled: boolean): void {
  notificationsEnabled = enabled;
}

/* ============================== 提交串行化 ============================== */

/**
 * 契约 §4.4 场景 3：两个请求同时写 `测试.md` 时，各自独立跑 `resolveAvailablePath` 会
 * 双双选中同一路径、后写者覆盖先写者。**所有提交必须串行化**（单并发）。
 */
let commitQueue: Promise<unknown> = Promise.resolve();

function enqueueCommit<T>(task: () => Promise<T>): Promise<T> {
  const run = commitQueue.then(task, task);
  commitQueue = run.catch(() => undefined);
  return run;
}

/* ================================ 入口 ================================ */

/** 应用内调用：域错误抛 `ImportRejection`（带 `code` / `http` / `userMessage`）。 */
export async function receiveEnvelope(raw: string | unknown): Promise<ImportReceipt> {
  const parsed = parseRaw(raw);
  const validation = validateImportEnvelope(parsed);
  if (!validation.ok) throw new ImportRejection(validation.problem);
  const backend = currentBackend();
  if (!backend) throw new ImportRejection(importProblem("IMP-4007"));
  const envelope = await resolveExternalBody(backend, validation.envelope);
  const sourceHash = await sourceHashOf(envelope.source.url);
  const bodyHash = await bodyHashOf(envelope.body);
  const contentHash = await contentHashOf(sourceHash, bodyHash);
  const hashes: CommitHashes = { sourceHash, bodyHash, contentHash, warnings: [...envelope.warnings] };
  return enqueueCommit(() => runCommit(backend, envelope, hashes));
}

/** 契约 §4.1「HTTP」列 → 桥要用的 HTTP 状态码。 */
export function httpStatusOf(receipt: ImportReceipt): number {
  if (receipt.status === "created") return 201;
  if (receipt.status === "pending") return 202;
  // `deduped` / `duplicate` / `appended` / `skipped` 都是 200（契约 §4.1）。
  return 200;
}

/** IPC 转交：**永不抛**，把结构化错误原样交回主进程（`ipcMain.handle` 会吞掉异常字段）。 */
export async function receiveEnvelopeOutcome(raw: string | unknown): Promise<EnvelopeOutcome> {
  try {
    const result = await receiveEnvelope(raw);
    return { ok: true, status: httpStatusOf(result), result };
  } catch (error) {
    // 按**结构**认域错误（`IMP-####` + `userMessage`），不按类：跨模块传过来的错误对象
    // 可能是别的模块的类（`InboxError`、未来别的写者），带的信息一样完整。
    const domain = toImportErrorBody(error);
    if (domain) return { ok: false, error: domain };
    if (isImportRejection(error)) return { ok: false, error: error.toResponse().error };
    const problem = importProblem("IMP-4014", { reason: error instanceof Error ? error.message : String(error) });
    return { ok: false, error: problem };
  }
}

/* ============================== 解析与预处理 ============================== */

function parseRaw(raw: string | unknown): unknown {
  if (typeof raw !== "string") return raw;
  if (!raw.trim()) throw new ImportRejection(importProblem("IMP-3003"));
  // 契约 §2.6：整个请求体 > 16 MiB 在解析 JSON **之前**拒绝，避免内存放大。
  if (raw.length > MAX_REQUEST_BYTES && utf8Bytes(raw) > MAX_REQUEST_BYTES) {
    throw new ImportRejection(importProblem("IMP-4005", { bytes: utf8Bytes(raw) }));
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ImportRejection(importProblem("IMP-3002"));
  }
}

/**
 * `bodyFile`（通道级扩展）读完盘后才算得出哈希与字节 —— 哈希只认**最终正文**，
 * 所以外置形态必须在这里补齐，不能在校验器里做（校验器是纯函数，不碰磁盘）。
 */
async function resolveExternalBody(backend: FileSystemBackend, envelope: ImportEnvelope): Promise<ImportEnvelope> {
  if (!envelope.bodyFile) return envelope;
  let text: string;
  try {
    text = await backend.readText(envelope.bodyFile);
  } catch (error) {
    throw new ImportRejection(
      importProblem("IMP-4003", { field: "bodyFile", reason: error instanceof Error ? error.message : "read-failed" }),
    );
  }
  const checked = checkResolvedBody(text, { field: "bodyFile" });
  return { ...envelope, body: checked.body, bodyFile: null, warnings: [...envelope.warnings, ...checked.warnings] };
}

interface CommitHashes {
  sourceHash: string;
  bodyHash: string;
  contentHash: string;
  warnings: string[];
}

interface AppendTarget {
  path: string;
  entry: ImportIndexEntry | null;
}

/* ============================== 判定链 ============================== */

async function runCommit(backend: FileSystemBackend, envelope: ImportEnvelope, hashes: CommitHashes): Promise<ImportReceipt> {
  // ── 第 1 步：同一 importId → 幂等命中，**完全不写盘**，返回首次落点。
  const byId = await lookupImportById(envelope.importId);
  if (byId) {
    if (await backend.exists(byId.path)) return dedupedReceipt(envelope, byId);
    // 索引说 `a.md`，文件已不在 → 以磁盘为准，剔除该条继续往下判定（契约 §4.3.2）。
    await forgetImport(envelope.importId, backend);
  }

  // ── 00 §6.14㉕（0.3.0 核心规则）：应用侧「先进入收件箱」是**行为层的真输入**。
  // `importConflict === "inbox"`（本接收端的默认值）且**外部通道投递** → 强制 `pending`，
  // **跳过判定链第 2–6 步**（含第 2 步的 duplicate、第 3/4 步的追加、以及 `overwrite` 分支），
  // 并且**不写笔记文件**。第 1 步在它之前：重投同一 `importId` 仍然幂等（见 §6.14㉕ 第二点）。
  //
  // 为什么连 `conflict: "overwrite"` 也拦：㉕.2 已裁定「该设置优先于客户端下发的 conflict」——
  // 覆盖是本系统里**最不可逆的无审阅写入**，正是这个设置要拦的对象；若客户端能靠显式传值绕过它，
  // 这个设置又会变成假开关（本项目已抓过 4 个）。四道闸门代码保留不动（纵深防御），只是此偏好下不可达。
  //
  // ⚠️ 这条判断**不是**原来的 `landingPreference === "inbox" && isExternalDeliveryChannel(...)`：
  // 那种写法把「客户端**指明了落点**」的投递也吞掉，于是网页版剪藏页的落点下拉成了假开关。
  // 收窄后的完整口径与理由见 `inboxPreferenceForcesPending()` 的注释（`00` 号 §6.16（52））。
  if (inboxPreferenceForcesPending(envelope)) {
    return enqueuePending(envelope, hashes);
  }

  // ── 第 2 步：同 `source.url` 且 `bodyHash` 相同 → duplicate，**不追加、不写盘**。
  const byContent = await lookupImportByContent(envelope.source.url, hashes.bodyHash);
  if (byContent && (await backend.exists(byContent.path))) {
    await logOnly(backend, envelope, "duplicate", byContent.path);
    return duplicateReceipt(envelope, byContent);
  }

  // 第 3/4 步：同 `source.url`、哈希不同。
  // `lookupLatestBySourceUrl(null)` **刻意**返回 null：null 不是一种来源，只在第 2 步参与判定。
  // 否则两次无关的 AI/CLI 记录（正文不同、都没有 URL）会被静默追加到一起 —— 毁内容比多一篇严重。
  const byUrl = await lookupLatestBySourceUrl(envelope.source.url);
  let existing: ImportIndexEntry | null = null;
  if (byUrl) {
    if (await backend.exists(byUrl.path)) existing = byUrl;
    else await forgetImport(byUrl.importId, backend);
  }

  const explicit = envelope.conflictExplicit ? envelope.conflict : null;

  // `skip`：命中既有笔记 → 静默 `skipped`（第 1、2 步不受它影响）。
  if (explicit === "skip" && existing) return skippedReceipt(envelope, existing);

  // `overwrite`：四道闸门；任一不满足 → **降级为 new** + `IMP-4011` 警告。
  if (explicit === "overwrite") {
    const target = await resolveAppendTarget(backend, envelope, existing);
    let reason: string | null = target ? await overwriteGate(backend, envelope, target) : "没有可覆盖的目标";
    if (target && reason === null) {
      const written = await overwriteTarget(backend, envelope, target, hashes);
      if (written) return written;
      reason = "写入前无法留下可回退前像";
    }
    hashes.warnings.push(overwriteDowngradeWarning(reason ?? "覆盖条件未全部满足"));
    return createNew(backend, envelope, hashes);
  }

  // `append`：显式强制追加；或判定链第 3 步（同 URL + 选区二次剪藏）。
  const wantsAppend = explicit === "append" || (explicit === null && existing !== null && envelope.source.selection === true);
  if (wantsAppend) {
    const target = await resolveAppendTarget(backend, envelope, existing);
    if (!target) {
      // 契约 §3.3.3 第 3 条：找不到目标 → 退化为 `new` + `IMP-W003`。
      hashes.warnings.push(warningText("IMP-W003"));
      return createNew(backend, envelope, hashes);
    }
    const choice = await askAboutEditing(target);
    if (choice === "skip") return skippedReceipt(envelope, target.entry);
    if (choice === "new") return createNew(backend, envelope, hashes);
    if (choice === "inbox") return enqueuePending(envelope, hashes);
    return appendTo(backend, envelope, target, hashes);
  }

  // 第 4 步：整页二次剪藏 → **进收件箱**（不静默追加）。
  if (existing && explicit === null) return enqueuePending(envelope, hashes);

  // 第 5/6 步：新建（URL 不同但哈希相同 = 两条独立笔记，拒绝误合并）。
  return createNew(backend, envelope, hashes);
}

/* ============================== 回执构造 ============================== */

function baseReceipt(envelope: ImportEnvelope, hashes: CommitHashes): Pick<ImportReceipt, "importId" | "tags" | "warnings"> {
  return { importId: envelope.importId, tags: envelope.tags, warnings: hashes.warnings };
}

function dedupedReceipt(envelope: ImportEnvelope, entry: ImportIndexEntry): ImportReceipt {
  return {
    status: "deduped",
    importId: envelope.importId,
    path: entry.path,
    inboxId: null,
    deduped: true,
    dedupedBy: "importId",
    // 无写入 → 语义为 true（契约 §4.5）。
    revertible: true,
    preimage: null,
    assets: [],
    tags: entry.tags.length ? entry.tags : envelope.tags,
    warnings: [],
    // 同一 importId 一律静默：不 toast、不内联、不算失败感。
    message: "",
  };
}

function duplicateReceipt(envelope: ImportEnvelope, entry: ImportIndexEntry): ImportReceipt {
  return {
    status: "duplicate",
    importId: envelope.importId,
    path: entry.path,
    inboxId: null,
    deduped: true,
    dedupedBy: "contentHash",
    revertible: true,
    preimage: null,
    assets: [],
    tags: entry.tags.length ? entry.tags : envelope.tags,
    warnings: [],
    message: DUPLICATE_MESSAGE,
  };
}

function skippedReceipt(envelope: ImportEnvelope, entry: ImportIndexEntry | null): ImportReceipt {
  return {
    status: "skipped",
    importId: envelope.importId,
    path: entry?.path ?? null,
    inboxId: null,
    deduped: false,
    // 00 号 §6.9⑩：`"sourceUrl"` 枚举保留，但判定链不产出该值 —— `deduped === false` 时
    // `dedupedBy` 恒为 `null`（追加/进收件箱/跳过的命中原因在 `status` 与导入日志的 `op` 里看）。
    dedupedBy: null,
    revertible: true,
    preimage: null,
    assets: [],
    tags: envelope.tags,
    warnings: [],
    message: "已存在同名笔记，按设置跳过。",
  };
}

function clipMessage(envelope: ImportEnvelope): string {
  return envelope.source.url ? `已从网页剪藏：${envelope.title}` : `已导入笔记：${envelope.title}`;
}

/* ============================== 落盘：新建 ============================== */

async function createNew(backend: FileSystemBackend, envelope: ImportEnvelope, hashes: CommitHashes): Promise<ImportReceipt> {
  const warnings = hashes.warnings;
  const taken = new Set<string>(Object.keys(libraryStore.get().notes));
  await ensureFolderDirs(backend, envelope.target.folder);
  const requested = requestedNotePath(envelope.target.folder, envelope.title);
  const path = await allocateNotePath(backend, requested, taken);
  const assets = await writeAssets(backend, path, envelope, taken, warnings);
  const text = renderMarkdown(envelope, rewriteAssetRefs(envelope.body, assets.renames));
  try {
    await backend.writeText(path, text);
  } catch (error) {
    throw new ImportRejection(
      importProblem("IMP-5001", { path, partial: { assets: assets.paths }, reason: errorMessage(error) }),
    );
  }
  const receipt: ImportReceipt = {
    ...baseReceipt(envelope, hashes),
    status: "created",
    path,
    inboxId: null,
    deduped: false,
    dedupedBy: null,
    // 新建文件删掉即可，恒为可回退（契约 §4.5）。
    revertible: true,
    preimage: null,
    assets: assets.paths,
    message: clipMessage(envelope),
  };
  await indexImport(backend, envelope, receipt, hashes, "created");
  announce(receipt);
  return receipt;
}

/* ============================== 落盘：追加 ============================== */

/** `append` / `overwrite` 的目标解析顺序（契约 §3.3.3）：`notePath` → 来源索引 → 无。 */
async function resolveAppendTarget(
  backend: FileSystemBackend,
  envelope: ImportEnvelope,
  existing: ImportIndexEntry | null,
): Promise<AppendTarget | null> {
  const notePath = envelope.target.notePath;
  if (notePath) {
    if (!(await backend.exists(notePath))) {
      throw new ImportRejection(importProblem("IMP-4009", { field: "target.notePath", value: notePath }));
    }
    return { path: notePath, entry: existing && existing.path === notePath ? existing : null };
  }
  if (existing) return { path: existing.path, entry: existing };
  return null;
}

function isBeingEdited(path: string): boolean {
  const state = libraryStore.get();
  return state.dirty[path] === true;
}

/**
 * 用户正在编辑既有笔记时（UI-06/S3）：
 * - 装了 `ConflictDialog`（C3）→ 问人；
 * - 没装（CLI / 桥 / 收件箱）→ 先 `flushAll()` 把用户未保存的输入落盘，再追加。
 *   这样「追加会在你保存后又写入一段」不会丢字 —— 追加是加法，永不覆盖。
 */
async function askAboutEditing(target: AppendTarget): Promise<ImportConflictChoice> {
  if (!isBeingEdited(target.path) || !conflictResolver) return "append";
  try {
    return await conflictResolver({
      kind: "editing",
      title: target.entry?.title || baseName(stripExtension(target.path)),
      path: target.path,
      lastCapturedAt: target.entry?.at ?? null,
      recommended: "append",
    });
  } catch (error) {
    console.warn("[opennote] 冲突对话框失败，按追加处理", error);
    return "append";
  }
}

async function appendTo(
  backend: FileSystemBackend,
  envelope: ImportEnvelope,
  target: AppendTarget,
  hashes: CommitHashes,
): Promise<ImportReceipt> {
  const warnings = hashes.warnings;
  const path = target.path;
  // 目标正在编辑：先把编辑器里的输入落盘，避免「你保存后覆盖掉刚追加的一段」。
  if (isBeingEdited(path)) {
    try {
      await flushAll();
      await rescanWorkspace();
    } catch (error) {
      console.warn("[opennote] 追加前落盘失败，改为新建", error);
      warnings.push(warningText("IMP-W004"));
      return createNew(backend, envelope, hashes);
    }
  }

  const existingBytes = await readBytesOrThrow(backend, path);
  const existingText = decodeUtf8(existingBytes);
  // D08：磁盘版本与内存版本不一致（应用外被改过、或文件根本不是扫描进来的）→ 放弃追加。
  const known = libraryStore.get().notes[path];
  if (!known || known.content !== existingText) {
    warnings.push(warningText("IMP-W004"));
    return createNew(backend, envelope, hashes);
  }

  const preimage = await recordPreimage(backend, envelope, path, existingBytes, "appended", warnings);
  const taken = new Set<string>(Object.keys(libraryStore.get().notes));
  const assets = await writeAssets(backend, path, envelope, taken, warnings);
  const next = renderAppended(
    existingText,
    envelope,
    rewriteAssetRefs(envelope.body, assets.renames),
    Date.parse(envelope.source.capturedAt),
  );
  try {
    await backend.writeText(path, next);
  } catch (error) {
    throw new ImportRejection(
      importProblem("IMP-5001", { path, partial: { assets: assets.paths }, reason: errorMessage(error) }),
    );
  }
  const receipt: ImportReceipt = {
    ...baseReceipt(envelope, hashes),
    status: "appended",
    path,
    inboxId: null,
    deduped: false,
    dedupedBy: null,
    revertible: Boolean(preimage),
    preimage,
    assets: assets.paths,
    message: `已追加到《${target.entry?.title || baseName(stripExtension(path))}》`,
  };
  if (preimage) receipt.undoSeconds = UNDO_WINDOW_MS / 1000;
  await indexImport(backend, envelope, receipt, hashes, "appended");
  announce(receipt);
  return receipt;
}

/* ============================== 落盘：覆盖 ============================== */

/** `overwrite` 的闸门 2/3（闸门 1「显式传值」由调用点保证；闸门 4 在写前像时才可知）。 */
async function overwriteGate(
  backend: FileSystemBackend,
  envelope: ImportEnvelope,
  target: AppendTarget,
): Promise<string | null> {
  const context = getImportChannelContext();
  if (context.channel !== "local-bridge") return `通道 ${context.channel} 不接受覆盖`;
  if (!context.overwriteEnabled) return "设置里未开启「允许覆盖」";
  if (isBeingEdited(target.path)) return "目标笔记正在编辑";
  if (!(await backend.exists(target.path))) return "目标笔记不存在";
  if (envelope.target.notePath && envelope.target.notePath !== target.path) return "target.notePath 与来源索引不一致";
  return null;
}

/** 闸门 4：写前像。拿不到前像 → 返回 `null`，由调用点降级为 `new` + `IMP-4011`。 */
async function overwriteTarget(
  backend: FileSystemBackend,
  envelope: ImportEnvelope,
  target: AppendTarget,
  hashes: CommitHashes,
): Promise<ImportReceipt | null> {
  const path = target.path;
  const existingBytes = await readBytesOrThrow(backend, path);
  const warnings = hashes.warnings;
  const preimage = await recordPreimage(backend, envelope, path, existingBytes, "overwritten", warnings);
  if (!preimage) return null;
  const taken = new Set<string>(Object.keys(libraryStore.get().notes));
  const assets = await writeAssets(backend, path, envelope, taken, warnings);
  const text = renderMarkdown(envelope, rewriteAssetRefs(envelope.body, assets.renames));
  try {
    await backend.writeText(path, text);
  } catch (error) {
    throw new ImportRejection(
      importProblem("IMP-5001", { path, partial: { assets: assets.paths }, reason: errorMessage(error) }),
    );
  }
  const receipt: ImportReceipt = {
    ...baseReceipt(envelope, hashes),
    status: "created",
    path,
    inboxId: null,
    deduped: false,
    dedupedBy: null,
    revertible: true,
    preimage,
    assets: assets.paths,
    message: `已用这次剪藏替换《${target.entry?.title || baseName(stripExtension(path))}》的正文`,
    undoSeconds: UNDO_WINDOW_MS / 1000,
  };
  await indexImport(backend, envelope, receipt, hashes, "overwritten");
  announce(receipt);
  return receipt;
}

function overwriteDowngradeWarning(reason: string): string {
  return `IMP-4011 覆盖未生效（${reason}），已改为新建一篇。`;
}

/* ============================== 落盘：收件箱 ============================== */

interface InboxMeta {
  title: string;
  sourceUrl: string | null;
  tags: string[];
  targetFolder: string | null;
  bodyHash: string;
}

interface InboxModule {
  enqueueInbox?: (envelopeJson: string, meta: InboxMeta) => Promise<unknown>;
  readInboxDetail?: (id: string) => Promise<unknown>;
}

function readString(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field.trim() : "";
}

/**
 * 回执里的 `inboxId` 是**收件箱目录名**（契约 §4.5 + §5.8.2：`<UTC YYYYMMDDTHHMMSS>-<importId 前 8 位>`），
 * **不是** `InboxEntry.id`。
 *
 * 这两个东西容易混：`InboxEntry.id` 是**条目身份**（完整 `importId` 派生，收件箱状态机、
 * 幂等判定、面板操作全用它），目录名是**磁盘上的位置**（客户端唯一的路径抓手）。
 * 回执里已经有 `importId` 字段了，`inboxId` 再返回 `importId` 就是冗余且误导 —— 客户端会
 * 拿它去拼 `.opennote/inbox/<inboxId>/` 而直接失败（D-V04）。
 *
 * 目录名只从磁盘侧的视图取（`readInboxDetail().dirName`），**不自己拼**：拼错了客户端照样找不到，
 * 取不到就如实报 `IMP-4014`，绝不拿 `id` 冒充。
 */
async function resolveInboxDirName(module: InboxModule, result: unknown, entryId: string): Promise<string> {
  const direct = readString(result, "dirName");
  if (direct && !direct.includes("/")) return direct;
  if (typeof module.readInboxDetail === "function" && entryId) {
    try {
      const detail = await module.readInboxDetail(entryId);
      const dirName = readString(detail, "dirName");
      if (dirName && !dirName.includes("/")) return dirName;
    } catch (error) {
      console.warn("[opennote] 读取收件箱目录名失败", error);
    }
  }
  throw new ImportRejection(importProblem("IMP-4014", { reason: "inbox-dir-name-missing", importId: entryId }));
}

/** 收件箱条目里已有的标签（`InboxDetail.entry.tags`）。 */
function readEntryTags(detail: unknown): string[] {
  if (!detail || typeof detail !== "object") return [];
  const entry = (detail as Record<string, unknown>).entry;
  if (!entry || typeof entry !== "object") return [];
  const tags = (entry as Record<string, unknown>).tags;
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
}

/**
 * 同 `importId` 是否**已经在收件箱里排队**？（00 §6.14㉕「第 1 步依然优先」在半路的落点）
 *
 * 为什么要在收件箱侧再判一次：笔记索引（`import-index.json`）只记得**落过盘的笔记**，
 * 而「先进入收件箱」的条目一个笔记文件都没写 → 索引里没有它。若不查收件箱，
 * 第二次投递会假报 `pending`（明明没有新增条目），客户端会以为又入队了一条。
 *
 * 为什么不改索引去记 `path: null`：`.opennote/import-index.json` 的 `path` 是非空字符串
 * （契约 §4.3.3 的磁盘格式），为收件箱条目放宽它会把「索引 = 笔记落点表」的语义搞混，
 * 而收件箱本身就是 pending 条目的权威记录（`entry.json` 里有完整 `importId`）。
 *
 * 查不到（C2 侧 `IMP-4017`）或读不动 → 返回 `null`，交给 `enqueueInbox()` 定夺
 * （它自己也做同 id 幂等：同 id 已有条目就直接返回既有条目）。
 */
async function findQueuedInboxEntry(module: InboxModule, importId: string): Promise<{ dirName: string; tags: string[] } | null> {
  if (typeof module.readInboxDetail !== "function" || !importId) return null;
  try {
    const detail = await module.readInboxDetail(importId);
    const dirName = readString(detail, "dirName");
    if (!dirName || dirName.includes("/")) return null;
    return { dirName, tags: readEntryTags(detail) };
  } catch {
    return null;
  }
}

/**
 * 同 `importId` 重投、而首次落点是**收件箱**时的回执：`deduped` + 首次入队的 `inboxId`。
 * `path` 为 `null`：这次导入从来没写过笔记文件，不能编一个路径出来。
 * 与 `dedupedReceipt()` 一样静默（`message: ""`）——同一封信封重复投递不是错误，也不该弹提示。
 */
function dedupedPendingReceipt(envelope: ImportEnvelope, queued: { dirName: string; tags: string[] }): ImportReceipt {
  return {
    status: "deduped",
    importId: envelope.importId,
    path: null,
    inboxId: queued.dirName,
    deduped: true,
    dedupedBy: "importId",
    revertible: true,
    preimage: null,
    assets: [],
    tags: queued.tags.length ? queued.tags : envelope.tags,
    warnings: [],
    message: "",
  };
}

/** 第 4 步：整页二次剪藏 → 进收件箱（`pending`，HTTP 202，`path` 为 `null`）。 */async function enqueuePending(envelope: ImportEnvelope, hashes: CommitHashes): Promise<ImportReceipt> {
  let module: InboxModule;
  try {
    module = (await import("../../data/inbox")) as InboxModule;
  } catch (error) {
    throw new ImportRejection(importProblem("IMP-5001", { reason: "inbox-unavailable", message: errorMessage(error) }));
  }
  if (typeof module.enqueueInbox !== "function") {
    throw new ImportRejection(importProblem("IMP-5001", { reason: "inbox-unavailable" }));
  }

  // ── 幂等（00 §6.14㉕「第 1 步依然优先」在收件箱场景的落点）：同 `importId` 已经在收件箱里排队
  // → 返回 `deduped` + 首次入队的 `inboxId`，**不再产生第二条条目**。
  // `enqueueInbox()` 自身也做同 id 幂等（返回既有条目），这里显式先判一次是为了把 `status`
  // 如实报成 `deduped`（否则第二次投递会假报 `pending`，客户端会以为又入队了一条）。
  // 注意顺序：**笔记索引优先于收件箱** —— 条目若已被「确认入库」，第 1 步会先在索引里命中，
  // 回执给的是笔记落点，而不是过期的收件箱目录。
  const queued = await findQueuedInboxEntry(module, envelope.importId);
  if (queued) return dedupedPendingReceipt(envelope, queued);

  const meta: InboxMeta = {
    title: envelope.title,
    sourceUrl: envelope.source.url,
    tags: envelope.tags,
    targetFolder: envelope.target.folder,
    bodyHash: hashes.bodyHash,
  };
  let result: unknown;
  try {
    result = await module.enqueueInbox(serializeEnvelopeJson(envelope), meta);
  } catch (error) {
    // `enqueueInbox` 的域错误（`IMP-4013` 收件箱满、`IMP-4010` 目录名耗尽、`IMP-4007` 无后端、
    // `IMP-4001/4002/4003` 信封复校）必须**原样透传**：原因和下一步都在它自己的 `code` +
    // `userMessage` 里。曾经这里只按类判（`isImportRejection`），而 `InboxError.name === "InboxError"`
    // → 判定 false → 全部被包成 `IMP-5001 磁盘可能已满`，把用户指去查磁盘（真因是收件箱满）。
    // 判定改走 `toImportErrorBody()`：按结构判（`IMP-####` + 非空 `userMessage`），不按类。
    const domain = toImportErrorBody(error);
    if (domain) throw new ImportRejection(domain);
    if (isImportRejection(error)) throw error;
    throw new ImportRejection(importProblem("IMP-5001", { reason: "inbox-enqueue-failed", message: errorMessage(error) }));
  }
  // 条目身份（完整 importId）：只用它去查磁盘侧目录名，**不要**直接当 `inboxId` 回执（D-V04）。
  const entryId =
    typeof result === "string"
      ? result
      : readString(result, "id");
  const inboxId = await resolveInboxDirName(module, result, entryId);
  return {
    ...baseReceipt(envelope, hashes),
    status: "pending",
    path: null,
    inboxId,
    deduped: false,
    // 见 `skippedReceipt()`：`deduped === false` 时 `dedupedBy` 恒为 `null`（00 号 §6.9⑩）。
    dedupedBy: null,
    revertible: true,
    preimage: null,
    assets: [],
    message: "已放入导入收件箱，等待你确认。",
  };
}

/* ============================== 前像与附件 ============================== */

/** 逐字节前像 + 日志（一份操作里两件事都做完才算成功，契约 §3.3.3）。 */
async function recordPreimage(
  backend: FileSystemBackend,
  envelope: ImportEnvelope,
  path: string,
  bytes: Uint8Array,
  op: "appended" | "overwritten",
  warnings: string[],
): Promise<{ path: string; bytes: number; sha256: string } | null> {
  try {
    const token = await writePreimage(path, bytes, { importId: envelope.importId, backend });
    const sha256 = await sha256Ref(bytes);
    await recordImport(
      {
        importId: envelope.importId,
        op,
        path,
        preimagePath: token,
        preimageBytes: bytes.byteLength,
        preimageSha256: sha256,
        revertible: true,
        at: nowIso(),
      },
      backend,
    );
    return { path: token, bytes: bytes.byteLength, sha256 };
  } catch (error) {
    // 前像不可得时 append 仍可入库，但回执必须如实写 `revertible: false` + `IMP-W008`。
    console.warn("[opennote] 前像写入失败，撤销降级", error);
    warnings.push(warningText("IMP-W008"));
    return null;
  }
}

async function writeAssets(
  backend: FileSystemBackend,
  notePath: string,
  envelope: ImportEnvelope,
  taken: Set<string>,
  warnings: string[],
): Promise<{ paths: string[]; renames: AssetRename[] }> {
  const paths: string[] = [];
  const renames: AssetRename[] = [];
  const assets = await resolveAssetBytes(backend, envelope, paths);
  if (!assets.length) {
    const declared: string[] = [];
    const undeclared = findUndeclaredAssetRefs(envelope.body, declared);
    if (undeclared.length) warnings.push(warningText("IMP-W002"));
    return { paths, renames };
  }
  const dir = assetsDirFor(notePath);
  try {
    await backend.mkdir(dir);
  } catch (error) {
    throw new ImportRejection(importProblem("IMP-4009", { segment: dir, reason: errorMessage(error) }));
  }
  for (const [index, asset] of assets.entries()) {
    const bytes = asset.bytes;
    if (!bytes) throw new ImportRejection(importProblem("IMP-4012", { assetIndex: index, reason: "no-payload" }));
    if (asset.mime === "image/svg+xml" && !isSafeSvg(bytes)) {
      throw new ImportRejection(
        importProblem("IMP-4012", { assetIndex: index, reason: "svg", partial: { assets: [...paths] } }),
      );
    }
    const target = await allocateAssetPath(backend, dir, asset.name, bytes, taken);
    try {
      await backend.writeBytes(target.path, bytes);
    } catch (error) {
      throw new ImportRejection(
        importProblem("IMP-5001", { assetIndex: index, partial: { assets: [...paths] }, reason: errorMessage(error) }),
      );
    }
    paths.push(target.path);
    renames.push({ name: asset.name, finalPath: target.path });
  }
  const undeclared = findUndeclaredAssetRefs(envelope.body, renames.map((item) => item.name));
  if (undeclared.length) warnings.push(warningText("IMP-W002"));
  return { paths, renames };
}

/** `assets[].file`（通道级扩展）读完盘；路径越界在校验阶段已拒。 */
async function resolveAssetBytes(
  backend: FileSystemBackend,
  envelope: ImportEnvelope,
  writtenSoFar: string[],
): Promise<ImportEnvelope["assets"]> {
  const resolved: ImportEnvelope["assets"] = [];
  for (const [index, asset] of envelope.assets.entries()) {
    if (asset.bytes || !asset.file) {
      resolved.push(asset);
      continue;
    }
    try {
      const bytes = await backend.readBytes(asset.file);
      resolved.push({ ...asset, bytes });
    } catch (error) {
      throw new ImportRejection(
        importProblem("IMP-4012", {
          assetIndex: index,
          partial: { assets: [...writtenSoFar] },
          reason: errorMessage(error),
        }),
      );
    }
  }
  return resolved;
}

/* ============================== 索引与通知 ============================== */

async function indexImport(
  backend: FileSystemBackend,
  envelope: ImportEnvelope,
  receipt: ImportReceipt,
  hashes: CommitHashes,
  action: string,
): Promise<void> {
  if (receipt.path) {
    try {
      await rememberImport(
        {
          importId: envelope.importId,
          path: receipt.path,
          title: envelope.title,
          sourceUrl: envelope.source.url,
          site: envelope.source.site,
          publishedAt: envelope.source.publishedAt,
          selection: envelope.source.selection,
          sourceHash: hashes.sourceHash,
          bodyHash: hashes.bodyHash,
          contentHash: hashes.contentHash,
          tags: receipt.tags,
          client: envelope.client.name,
          at: nowIso(),
          action,
        },
        backend,
      );
    } catch (error) {
      // 索引失败只影响去重，不影响用户数据（契约 §3.6）：回执仍然成功 + `IMP-W005`。
      console.warn("[opennote] 幂等索引写入失败", error);
      receipt.warnings.push(warningText("IMP-W005"));
    }
  }
  if (action === "created") {
    try {
      await recordImport(
        {
          importId: envelope.importId,
          op: "created",
          path: receipt.path ?? "",
          preimagePath: null,
          preimageBytes: 0,
          preimageSha256: null,
          revertible: receipt.revertible,
          at: nowIso(),
        },
        backend,
      );
    } catch (error) {
      console.warn("[opennote] 导入日志写入失败", error);
    }
  }
  // 落盘后必须让界面可见：调用既有 `rescanWorkspace()`，**不要**自己发明重扫通道。
  await rescanWorkspace();
}

/** 只写日志、不碰索引（`duplicate` 不产生新的幂等条目，否则重试会静默成 deduped）。 */
async function logOnly(backend: FileSystemBackend, envelope: ImportEnvelope, op: "duplicate", path: string): Promise<void> {
  try {
    await recordImport(
      { importId: envelope.importId, op, path, preimagePath: null, preimageBytes: 0, preimageSha256: null, revertible: true, at: nowIso() },
      backend,
    );
  } catch (error) {
    console.warn("[opennote] 导入日志写入失败", error);
  }
}

/**
 * 入库后的 toast（契约 §6.4「已从网页剪藏：xxx · 撤销」）。
 * `deduped` / `duplicate` / `skipped` / `pending` 一律静默（客户端内联文案、收件箱面板自己说）。
 *
 * 不可回退时**不许**承诺「撤销后恢复原样」（00 号 §6.7④）：文案换成降级说法，动作按钮也换成
 * 「移入回收站」，但仍然显式给足 10 秒窗口。
 */
function announce(receipt: ImportReceipt): void {
  if (!notificationsEnabled || !receipt.path) return;
  const action = {
    label: receipt.revertible ? "撤销" : "移入回收站",
    run: () => {
      void undoImport(receipt);
    },
  };
  const message = receipt.revertible
    ? receipt.message
    : // 现在只有 append 会出现 revertible === false；其余状态走这条防御分支，同样不能撒谎。
      receipt.status === "appended"
      ? "内容已合并进已有笔记，撤销会把整篇移入回收站。"
      : "这次导入没有留下可回退的前像，撤销会把笔记移入回收站。";
  // 撤销窗口 10 秒，**必须显式传 duration**：`notify()` 对 action 分支默认 6000ms。
  notify(message, { action, duration: UNDO_WINDOW_MS });
}

/* ================================ 撤销 ================================ */

export interface ImportUndoResult {
  ok: boolean;
  /** `preimage` = 用前像逐字节还原；`trash` = 降级为移入回收站；`none` = 什么都没做成。 */
  mode: "preimage" | "trash" | "none";
  message: string;
}

/**
 * 撤销：有前像 → 用前像**逐字节覆盖回原文件**；没有前像（或前像读不回来）→
 * 只能是「移入回收站」，且文案必须如实说明是**降级撤销**（契约 §3.3.3、00 号 §6.7④）。
 *
 * `options.silent` 只给「批量/程序化撤销」用；界面点「撤销」会拿到一条结果 toast（6 秒）。
 */
export async function undoImport(receipt: ImportReceipt, options: { silent?: boolean } = {}): Promise<ImportUndoResult> {
  const result = await runUndo(receipt);
  if (!options.silent && notificationsEnabled) {
    notify(result.message, { kind: result.ok ? "info" : "danger", duration: 6000 });
  }
  return result;
}

async function runUndo(receipt: ImportReceipt): Promise<ImportUndoResult> {
  const backend = currentBackend();
  const path = receipt.path;
  const title = path ? baseName(stripExtension(path)) : "";
  if (!backend || !path) return { ok: false, mode: "none", message: "没有可撤销的落点。" };

  if (receipt.preimage) {
    const bytes = await readPreimage(receipt.preimage.path, backend);
    if (bytes) {
      try {
        await backend.writeBytes(path, bytes);
        // 正文回到导入前了，**这次新增的图片也必须跟着回退**：还原后的正文不再引用它们，
        // 留着就是孤儿（用户看不到、磁盘上却在）。复用的旧图片不动（见 `rollbackImportAssets`）。
        const leftover = await rollbackImportAssets(backend, path, receipt, decodeUtf8(bytes));
        await markImportUndone(receipt.importId).catch(() => false);
        await rescanWorkspace();
        return {
          ok: true,
          mode: "preimage",
          message: leftover
            ? `已还原《${title}》到导入前的版本；但这次新增的 ${leftover} 个图片文件没能清理，请手动删除 ${assetsDirFor(path)}。`
            : `已还原《${title}》到导入前的版本。`,
        };
      } catch (error) {
        console.warn("[opennote] 前像还原失败，降级为移入回收站", error);
      }
    }
  }

  try {
    await rescanWorkspace();
    /*
     * 附件目录**不在这里搬**：`trashNote()` 已经是「笔记 + 它的 `<笔记名>.assets/` 一起进
     * 回收站」的**唯一产地**（`src/data/library.ts:moveNoteAssets`，两个方向共用一条派生规则）。
     *
     * 这里原来自己也搬一次（`trashAssetsDir` → `.opennote/trash/<附件目录>`）。两处搬同一个
     * 目录 = 同一个事实两个产地：目标路径**恰好相同**，所以功能上看不出来，但第二处必然
     * 失败（源目录已经被搬走了）→ 用户会收到一句**假的**告警「图片目录 x.assets 没能一起
     * 移入回收站，请手动处理」，而其实图片好好地躺在回收站里。判据误报一次，就等于教别人
     * 忽略它一次 —— 所以删掉第二处，而不是留着一个「反正结果一样」的重复。
     */
    await trashNote(path);
    await markImportUndone(receipt.importId).catch(() => false);
    const removed = libraryStore.get().notes[path] === undefined;
    return {
      ok: removed,
      mode: "trash",
      message: removed ? `已把《${title}》移入回收站，可以再找回来。` : "撤销失败，请在回收站里手动处理。",
    };
  } catch (error) {
    console.warn("[opennote] 撤销失败", error);
    return { ok: false, mode: "none", message: "撤销失败，请在回收站里手动处理。" };
  }
}

/**
 * 撤销「追加/覆盖」时清理**这次新增**的附件。
 *
 * 只删两种都成立的文件：①本次导入写过（`receipt.assets`）；②**还原后的正文不再引用它**。
 * ②是「复用」的护栏 —— 内容哈希命中的旧图片本来就被导入前的正文引用着，删掉会毁掉别人的图。
 * 返回**没删掉的个数**（如实报，不假装成功）；目录空了顺手收掉，不留空壳。
 */
async function rollbackImportAssets(
  backend: FileSystemBackend,
  notePath: string,
  receipt: ImportReceipt,
  restoredBody: string,
): Promise<number> {
  const dir = assetsDirFor(notePath);
  if (!receipt.assets.length || !(await backend.exists(dir))) return 0;
  let failed = 0;
  for (const file of receipt.assets) {
    if (restoredBody.includes(baseName(file))) continue;
    try {
      await backend.remove(file);
    } catch (error) {
      console.warn("[opennote] 撤销：附件清理失败", file, error);
      failed += 1;
    }
  }
  try {
    const left = await backend.list(dir);
    if (!left.length) await backend.remove(dir);
  } catch {
    // 目录已经被删/从来不存在：不是失败。
  }
  return failed;
}

/* ============================== 小工具 ============================== */

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

async function readBytesOrThrow(backend: FileSystemBackend, path: string): Promise<Uint8Array> {
  try {
    return await backend.readBytes(path);
  } catch (error) {
    throw new ImportRejection(importProblem("IMP-4009", { path, reason: errorMessage(error) }));
  }
}

/** 供 C2/C3 复用的日志读取（前像元数据 + `undoneAt`）。 */
export type { ImportLogEntry, ImportProblem };
