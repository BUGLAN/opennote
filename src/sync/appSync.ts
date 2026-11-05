/**
 * App ↔ 同步的装配层（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §5.3）。
 *
 * ## 它是唯一同时认识「两边」的地方
 *
 * `App.tsx` 只需要认识这一个模块：
 *
 * ```tsx
 * // 工作区打开/关闭时：
 * openWorkspaceSync(record, backend)   // 或 closeWorkspaceSync()
 * // 本地写盘后（library 的 onLocalFlush 已经接好）自动去抖推送；
 * // 状态栏：
 * const ui = useStore(syncUiStore);
 * syncStatusBarInfo(ui, hasWorkspace)
 * // 对话框：
 * <SyncDialog … />
 * ```
 *
 * 账号与凭据（`account.ts`）、绑定竞态（`binding.ts`）、attach（`attach.ts`）、
 * 账本落盘（`state.ts`）各自只做一件事；这里把它们拼起来，并持有**进程级**的状态：
 * 当前绑定的 backend / 账本 / 会话。登录、退出、解锁都会让它重新接上（`onAccountChange`）。
 *
 * ## 只同步当前打开的笔记本（`docs/执行-同步重写-2026-11-02.md`）
 *
 * 每个笔记本自己的 `record.sync` 记着「开没开、对应云端哪个笔记本」。设置页里打开一个
 * 还没对上云端的笔记本时只记下 `enabled + 服务器`，`notebookId` 留空 —— 等它被打开时
 * 在这里按名字配对（云端有同名的就合并，没有就新建），配好写回 `record.sync`。
 */

import { createStore } from "../lib/store";
import type { FileSystemBackend } from "../fs/types";
import type { WorkspaceRecord } from "../data/workspaces";
import { desktopSyncBridge } from "./http";
import { attachWorkspaceSync, type AttachResult, type AttachSkipReason } from "./attach";
import { deriveNotebookKey } from "./accountKey";
import { derivePathMapKey } from "./crypto";
import { createRemoteNotebook, currentCredentials, currentEncRoot, devicePlatform, loadAccount, onAccountChange, remoteNotebooks, reportSessionProblem } from "./account";
import { announceLocalWrite, onRemoteTabLocalWrite, syncLockKey, tryAcquireSyncLock, waitForSyncLock, type HeldSyncLock } from "./tabLock";
import type { NotebookSummary } from "../../shared/contract";
import { createSyncLedger, isSameRemote, readSyncLedger, writeSyncLedger, type SyncLedger } from "./state";
import { PROTOCOL_VERSION } from "./contract";
import { entryFromResult, failureEntry, recordSyncHistory } from "./history";
import { createHashCache, readHashCache, writeHashCache, type HashCache } from "./hashCache";
import { resolveCursorStore } from "./cursor";
import { createDesktopEventStream, supportsDesktopStream } from "./desktopStream";
import type { EventStreamLike } from "./stream";
import { createWorkspaceSyncBinding, type BindingPhase } from "./binding";
import { createDefaultIgnoreRules, shouldSkipEntry } from "./ignore";
import { onWorkspaceWrite } from "../fs/writeLog";
import { normalizePath } from "../fs/paths";
import { setSyncActive } from "./mode";
import type { SyncStatus } from "./runner";
/* `syncStatusBarInfo` 已移到 `statusBar.ts`（纯函数，可单独测），这里只转发。 */
import { normalizeSyncConfig, updateWorkspaceSync, workspaceDisplayName, type WorkspaceSyncConfig } from "../data/workspaces";
import type { SyncOnceResult } from "./engine";
import type { SyncSession } from "./session";
import { previewConflict as readConflictPreview, resolveConflictWithLocal, resolveConflictWithRemote, type ConflictPreview, type ResolutionOutcome } from "./resolution";

/* ============================================================================
   UI 状态（React 经 `useStore(syncUiStore)` 订阅）
   ============================================================================ */

export interface LastSyncSummary {
  at: number;
  pushed: number;
  pulled: number;
  deleted: number;
  remoteDeleted: number;
  conflicts: { path: string; kind: string }[];
  unknownDids: number;
  /**
   * 因远端树没取全而**挂起**的删除条数。
   *
   * 这个数字必须露出来：挂起意味着「远端说它没了，但我们不敢删」，
   * 用户不看到它就只会觉得「我删掉的笔记又回来了」。
   */
  suspendedDeletes: number;
  /** 远端树**仍然没取全**（翻页到头也没拿到完整树）。正常应为 `false`。 */
  treeTruncated: boolean;
  /**
   * 这一轮**本地扫描**没扫全（有目录读不到）⇒ 推送侧的删除推断被挂起（H3）。
   *
   * 与 `treeTruncated` 对称：一个是远端列表不全，一个是本机列表不全。
   */
  scanIncomplete?: boolean;
  /** 因本地扫描不完整而挂起的**推送删除**条数。 */
  suspendedPushDeletes?: number;
  /** 服务端拒收（空间满了 / 单个文件太大）、这一轮没上传的文件。 */
  rejected?: { path: string; reason: "quota" | "too-large"; message: string }[];
}

export interface SyncUiState {
  phase: BindingPhase;
  /** `skipped` 时的原因（对话框据此解释「为什么没同步」）。 */
  reason: AttachSkipReason | null;
  status: SyncStatus | null;
  /** 最近一次成功同步的概要；null = 本次会话还没同步过。 */
  last: LastSyncSummary | null;
  /** 绑定/接上过程中的意外错误（可预期的跳过走 `reason`，不进这里）。 */
  error: string | null;
  /**
   * 诊断日志（最近的若干行，**只进「诊断」折叠区**）。
   *
   * ★ 以前这里没有单独的字段：所有 `log` 输出都写进 `error`，于是
   * 「[sync] 收到远端信号（游标 1152-g1AAAACR…）」这种例行信息被当成错误，
   * 以红字长条的形式怼在界面上，还撑出了横向滚动条。
   * 日志是排查用的，不该占用「出问题了」的位置。
   */
  logs: string[];
}

export const syncUiStore = createStore<SyncUiState>({
  phase: "idle",
  reason: null,
  status: null,
  last: null,
  error: null,
  logs: [],
});

export { syncStatusBarInfo } from "./statusBar";
export type { SyncBarInfo, SyncBarTone } from "./statusBar";

/* ============================================================================
   模块状态与内部工具
   ============================================================================ */

/**
 * 增量同步的游标（`/v1/changes?since=`）。**每设备一份**，不进笔记本目录 ——
 * 理由见 `cursor.ts` 模块头（跟着目录走会让另一台设备静默漏变更）。
 */
const cursorStore = resolveCursorStore();

let binding = createWorkspaceSyncBinding({ attach: () => attachCurrent(), onStatus: onBindingStatus, onPhase: onBindingPhase, log: onBindingLog });
let currentRecord: WorkspaceRecord | null = null;
let currentBackend: FileSystemBackend | null = null;
/** 当前接上的会话（冲突裁决与「保存后去抖」都要用它）。 */
let activeSession: SyncSession | null = null;
/** 每次 attach（与关工作区）+1：只有最新那次 attach 的结果才能接管 `activeSession`。 */
let attachToken = 0;
/** 「有字节落盘」的订阅退订句柄（见 `subscribeWorkspaceWrites`）。 */
let writeUnsubscribed: (() => void) | null = null;
/**
 * 账本「心跳式落盘」的间隔（毫秒）。
 *
 * 为什么不是「每篇都写」：账本是整份 JSON（几百条时已 100+ KB），
 * 每篇写一次 = 每 200ms 一次全量写盘，纯浪费。
 * 为什么不是「只在整轮成功时写」：见 `onProgress` 的说明 —— 一轮几分钟，
 * 中途失败就全丢。2 秒是「丢失窗口」与「写盘次数」的折中。
 */
const LEDGER_HEARTBEAT_MS = 2000;

function onBindingStatus(status: SyncStatus): void {
  syncUiStore.set((prev) => ({ ...prev, status }));
  recordFailure(status);
  // 服务端说这台设备的登录失效了 / 账号停了：账号状态上也要标出来（设置页据此给「重新登录」）。
  if (status.phase === "signed-out") reportSessionProblem("signed-out");
  if (status.phase === "disabled") reportSessionProblem("disabled");
}

function onBindingPhase(phase: BindingPhase): void {
  syncUiStore.set((prev) => ({ ...prev, phase, reason: phase === "skipped" ? binding.reason() : null }));
}

function onBindingLog(line: string): void {
  // 绑定层只把「真的意外」打到这里；可预期的跳过走 reason。
  syncUiStore.set((prev) => ({
    ...prev,
    // 只进诊断区：日志不是错误（见 `logs` 的说明）。
    logs: [...prev.logs, line.replace(/^\[(binding|sync|stream)\] /, "")].slice(-40),
  }));
}

/**
 * 还没对上云端的笔记本（`notebookId` 为空）：按名字配对，没有就新建。配好写回 `record.sync`。
 *
 * 按名字是原型定的规则：两台设备上叫同一个名字的笔记本就是同一个；同名的加密方式以云端为准
 * （云端已经有密文了，本机不能把它当明文推）。
 */
async function resolveRemoteNotebook(record: WorkspaceRecord, config: WorkspaceSyncConfig): Promise<WorkspaceSyncConfig> {
  if (config.notebookId !== "") return config;
  const name = workspaceDisplayName(record);
  const existing = (await remoteNotebooks()).find((notebook) => notebook.name === name && notebook.role !== "viewer");
  const notebook = existing ?? (await createRemoteNotebook({ name, cryptoMode: config.cryptoMode }));
  const resolved: WorkspaceSyncConfig = { ...config, notebookId: notebook.notebookId, cryptoMode: notebook.cryptoMode };
  onBindingLog(`[sync] 「${name}」${existing ? "对上了云端的同名笔记本" : "在云端新建了笔记本"}（${notebook.notebookId}）`);
  updateWorkspaceSync(record.id, resolved);
  return resolved;
}

/** 账本：盘上有且远端信息一致就复用；换了笔记本/地址/模式 ⇒ 新账本（旧文件会被覆盖）。 */
async function loadLedger(backend: FileSystemBackend, record: WorkspaceRecord): Promise<SyncLedger> {
  const config = normalizeSyncConfig(record.sync);
  const existing = await readSyncLedger(backend).catch(() => null);
  /*
   * ★ 用 `isSameRemote()` 比较，**不是逐字比字符串**：`http://host:8787/` 与
   * `http://host:8787` 是同一个服务。逐字比会判成「换了服务器」⇒ 丢掉账本 ⇒
   * 每次打开应用全量重推（真机事故：880 篇、每次 2~3 分钟，远端文档被反复改写）。
   */
  if (existing && isSameRemote(existing.remote, config)) {
    /*
     * 旧客户端建账本时把 `protocolVersion` 写死成了 1（服务端早就是 2）。只是记录，不参与判定，
     * 所以不重建账本，原地改正即可（同步完照常落盘）。
     */
    if (existing.remote.protocolVersion !== PROTOCOL_VERSION) existing.remote.protocolVersion = PROTOCOL_VERSION;
    return existing;
  }
  /*
   * 丢掉账本意味着**下一轮会把整个库重推一遍**（几百篇 = 几分钟）。这件事必须留一行日志：
   * 它是「为什么又全量了」的唯一线索，而且它在这里**只发生一次**（重建之后身份就对上了）。
   */
  if (existing) {
    onBindingLog(
      `[sync] 账本与当前配置不一致（账本 ${existing.remote.baseUrl} / ${existing.remote.notebookId}，当前 ${config.baseUrl} / ${config.notebookId}），重建账本`,
    );
  }
  return createSyncLedger({
    baseUrl: config.baseUrl,
    notebookId: config.notebookId,
    cryptoMode: config.cryptoMode,
    // 本客户端说的协议版本（`shared/contract.ts`，与服务端同一份常量）。以前写死成 1。
    protocolVersion: PROTOCOL_VERSION,
  });
}

/**
 * 冲突清单 = **账本里还挂着的 `pendingConflict`** ∪ 本次结果（按路径去重，本次结果优先）。
 *
 * 为什么不只看本次结果：冲突要一直列到用户裁决为止（H1）。引擎每轮会把账本里挂着的
 * 冲突并进 `result.conflicts`，但这里再从账本兜一遍 —— 清单的来源就是账本本身，
 * 不依赖引擎某一条分支有没有记得把它报出来。
 */
function collectConflicts(ledger: SyncLedger, result: SyncOnceResult): { path: string; kind: string }[] {
  const byPath = new Map<string, string>();
  for (const item of [...result.conflicts, ...result.pushConflicts]) {
    if (!byPath.has(item.path)) byPath.set(item.path, item.kind);
  }
  for (const [path, file] of Object.entries(ledger.files)) {
    if (file.pendingConflict !== undefined && !byPath.has(path)) byPath.set(path, file.pendingConflict.kind);
  }
  return [...byPath].map(([path, kind]) => ({ path, kind }));
}

/**
 * 失败 / 离线进「最近同步」（`history.ts`）。连续同样的失败在那边合并成一条，
 * 所以重试时每次都调到这里也不会刷屏。
 */
function recordFailure(status: SyncStatus): void {
  const notebookId = currentRecord ? normalizeSyncConfig(currentRecord.sync).notebookId : "";
  if (status.phase === "offline") recordSyncHistory(notebookId, failureEntry("offline", status.error, Date.now()));
  else if (status.phase === "error") recordSyncHistory(notebookId, failureEntry("error", status.error, Date.now()));
  else if (status.phase === "signed-out") recordSyncHistory(notebookId, failureEntry("error", "这台设备的同步登录已失效，需要重新登录", Date.now()));
  else if (status.phase === "disabled") recordSyncHistory(notebookId, failureEntry("error", "同步账号已被管理员停用", Date.now()));
}

/** 每一轮成功同步：账本 + 哈希缓存落盘 + 概要进 UI（含冲突列表 —— 对话框从这里取）。 */
function handleSynced(
  backend: FileSystemBackend,
  ledger: SyncLedger,
  result: SyncOnceResult,
  hashCache: HashCache | null,
): void {
  void writeSyncLedger(backend, ledger).catch((error: unknown) => {
    syncUiStore.set((prev) => ({ ...prev, error: `账本落盘失败：${error instanceof Error ? error.message : String(error)}` }));
  });
  /*
   * 哈希缓存与账本同一次落盘。少了它，下次启动的全部文件都要重算一遍哈希
   * （500 篇 ≈ 几秒的纯 CPU/IO，而且是在「打开笔记本」这个最不该慢的时刻）。
   */
  if (hashCache !== null) {
    void writeHashCache(backend, hashCache, { keep: Object.keys(ledger.files) }).catch(() => undefined);
  }
  const conflicts = collectConflicts(ledger, result);
  // 动了东西的一轮进「最近同步」（空跑的一轮 `entryFromResult` 返回 null，不记）。
  const entry = entryFromResult(result, conflicts.map((item) => item.path), Date.now());
  if (entry !== null) recordSyncHistory(ledger.remote.notebookId, entry);
  syncUiStore.set((prev) => ({
    ...prev,
    last: {
      at: Date.now(),
      pushed: result.pushed,
      pulled: result.pulled,
      deleted: result.deleted,
      remoteDeleted: result.remoteDeleted,
      conflicts,
      unknownDids: result.unknownDids.length,
      suspendedDeletes: result.suspendedDeletes.length,
      treeTruncated: result.treeTruncated,
      scanIncomplete: result.scanIncomplete,
      suspendedPushDeletes: result.suspendedPushDeletes.length,
      rejected: (result.rejectedPushes ?? []).map(({ path, reason, message }) => ({ path, reason, message })),
    },
  }));
}

/* ============================================================================
   多标签页互斥（issue #3，`tabLock.ts`）
   ============================================================================ */

/** 这个标签页持有的同步锁（只在网页端；桌面 / Android 永远是 null）。 */
let heldLock: HeldSyncLock | null = null;
/** 正在排队等的锁：持锁的标签页关掉 / 切走后，浏览器把锁交过来，这边随即接上同步。 */
let lockWait: { key: string; abort: AbortController } | null = null;
/** 持锁期间：收别的标签页的「有本地改动」通知。 */
let remoteWritesOff: (() => void) | null = null;

function lockKeyFor(record: WorkspaceRecord): string | null {
  // 桌面版一个笔记本一个窗口、主进程管同步；Android 是单 WebView —— 都不需要标签页互斥。
  if (devicePlatform() !== "web") return null;
  return syncLockKey(record);
}

function adoptSyncLock(lock: HeldSyncLock): void {
  heldLock = lock;
  remoteWritesOff?.();
  remoteWritesOff = onRemoteTabLocalWrite((key) => {
    if (key === lock.key) void checkLocalChangesAndSchedule();
  });
}

/** 放掉持有的锁、停止排队（关笔记本 / 换笔记本 / 这个笔记本不再需要同步）。 */
function releaseSyncLock(): void {
  remoteWritesOff?.();
  remoteWritesOff = null;
  heldLock?.release();
  heldLock = null;
  lockWait?.abort.abort();
  lockWait = null;
}

function waitForTurn(key: string): void {
  if (lockWait?.key === key) return;
  lockWait?.abort.abort();
  const abort = new AbortController();
  lockWait = { key, abort };
  void waitForSyncLock(key, abort.signal).then((lock) => {
    if (!lock) return;
    const stillWanted = lockWait?.abort === abort && currentRecord !== null && lockKeyFor(currentRecord) === key;
    if (!stillWanted) {
      lock.release();
      return;
    }
    lockWait = null;
    adoptSyncLock(lock);
    // 轮到我们了：重新接上（这次 `claimSyncLock` 会看到锁已经在手上）。
    void binding.start();
  });
}

/**
 * 为当前笔记本拿同步锁。`ok` = 可以建会话（拿到了 / 本来就持有 / 环境不支持锁）；
 * `busy` = 另一个标签页正在同步它，已经排上队。
 */
async function claimSyncLock(record: WorkspaceRecord): Promise<"ok" | "busy"> {
  const key = lockKeyFor(record);
  if (!key) return "ok";
  if (heldLock?.key === key) return "ok";
  releaseSyncLock();
  const result = await tryAcquireSyncLock(key);
  if (result.kind === "unsupported") return "ok";
  // 拿锁期间笔记本被关掉 / 换掉了：这把锁已经不属于任何人，立刻还回去。
  if (currentRecord === null || lockKeyFor(currentRecord) !== key) {
    if (result.kind === "held") result.lock.release();
    return "busy";
  }
  if (result.kind === "held") {
    adoptSyncLock(result.lock);
    return "ok";
  }
  waitForTurn(key);
  return "busy";
}

/**
 * attach 的外壳：除了「另一个标签页在同步」，其余跳过（没开同步、没登录、待解锁……）
 * 都不该占着锁 —— 否则排在后面的标签页永远轮不到。
 */
async function attachCurrent(): Promise<AttachResult> {
  const result = await attachCurrentInner();
  if (!result.ok && result.reason !== "other-tab") releaseSyncLock();
  return result;
}

/** attach 的真身：读密钥 → 标签页互斥 → （E2EE）解锁 → 账本 → attach。可预期的跳过返回 ok:false。 */
async function attachCurrentInner(): Promise<AttachResult> {
  const record = currentRecord;
  const backend = currentBackend;
  const token = ++attachToken;
  // 旧会话的 runner 已被绑定层停掉（dispose 后不再响应），别再往它身上挂写入通知。
  activeSession = null;
  if (!record || !backend) return { ok: false, reason: "disabled", message: "没有打开的笔记本" };
  // 先看这个笔记本开没开同步：没开就是一个普通笔记本，登没登录都与它无关。
  let config = normalizeSyncConfig(record.sync);
  if (!config.enabled) return { ok: false, reason: "disabled", message: "这个笔记本没有开启同步" };
  const credentials = currentCredentials();
  if (!credentials) return { ok: false, reason: "signed-out", message: "这台设备还没有登录同步账号" };
  if (config.baseUrl !== credentials.server) {
    return { ok: false, reason: "other-server", message: `这个笔记本绑的是 ${config.baseUrl}，而这台设备登录的是 ${credentials.server}` };
  }
  /*
   * 标签页互斥（issue #3）放在**一切会动云端或账本的事之前**：按名字配对云端笔记本
   * （可能新建）、读写 `.opennote/sync.json` 都只该由持锁的那一个标签页做。
   */
  if ((await claimSyncLock(record)) === "busy") {
    return { ok: false, reason: "other-tab", message: "这个笔记本正在另一个标签页里同步" };
  }
  if (token !== attachToken) return { ok: false, reason: "disabled", message: "已经换了笔记本" };
  config = await resolveRemoteNotebook(record, config);
  if (token !== attachToken) return { ok: false, reason: "disabled", message: "已经换了笔记本" };
  const boundRecord: WorkspaceRecord = { ...record, sync: config };
  currentRecord = boundRecord;

  // 加密笔记本要先解锁：没有 encRoot 就停在「待解锁」，**绝不**退回明文。
  const encRoot = config.cryptoMode === "user-key" ? currentEncRoot() : null;
  if (config.cryptoMode === "user-key" && encRoot === null) {
    return { ok: false, reason: "locked", message: "这个笔记本是端到端加密的，输入加密口令解锁后才能同步" };
  }

  const ledger = await loadLedger(backend, boundRecord);
  /*
   * 本地哈希缓存：读不到（第一次同步 / 文件坏了 / 换了加密模式）就新建一份空的。
   * 空缓存 = 这一轮把每个文件读一遍（正确），之后就是增量的。
   */
  const hashCache: HashCache = (await readHashCache(backend, config.cryptoMode)) ?? createHashCache(config.cryptoMode);
  /** 上一次把账本落盘的时间（见下面 `heartbeat` 的说明：心跳式落盘）。 */
  let lastLedgerWriteAt = 0;
  /**
   * 账本「心跳式落盘」：**与进度回调解耦**（L3）。
   *
   * 以前只有 `onProgress` 会触发它，而进度只在"真的写成功了"时才推进 ——
   * 冲突多的一轮心跳次数就被压低，长轮次中途失败时可恢复的断点变粗。
   * 现在进度、落地、轮次成功三处都会调它，2 秒节流仍然负责压住写盘频率。
   */
  const heartbeat = (): void => {
    const at = Date.now();
    if (at - lastLedgerWriteAt < LEDGER_HEARTBEAT_MS) return;
    lastLedgerWriteAt = at;
    void writeSyncLedger(backend, ledger).catch(() => undefined);
  };
  const gitignoreText = await backend.readText(".gitignore").catch(() => "");
  /*
   * 实时推送：网页/移动用 `EventSource`；桌面端由主进程建流、经 IPC 推事件
   * （桌面 CSP 不放 https，渲染层里 `new EventSource(远端)` 会被静默拦掉）。
   *
   * 主进程那条桥是**可选**的：旧版 preload 没有它时 `supportsDesktopStream()` 为假，
   * 这里退回 `EventSource` —— 桌面端在旧版上会拿不到实时（四个触发源照常工作），
   * 而不是整条同步挂掉。
   */
  const streamBridge = desktopSyncBridge();
  const openEventStream = (url: string) =>
    supportsDesktopStream(streamBridge)
      ? createDesktopEventStream({ url, bridge: streamBridge })
      : (new EventSource(url) as unknown as EventStreamLike);

  const result = await attachWorkspaceSync({
    record: boundRecord,
    ledger,
    backend,
    authToken: credentials.token,
    gitignoreText,
    hashCache,
    cursorStore,
    notebookKeyForNotebook: (notebookId) => {
      if (config.cryptoMode !== "user-key" || encRoot === null) return undefined;
      /*
       * ★★ 拿不到 `encRoot` 时**必须返回 undefined**（让 attach 抛），**绝不能**退化成空字节：
       * HKDF 对空输入不报错，会派生出一把「错误但形状正确」的密钥 —— 推上去的密文其它设备全都解不开，
       * 而服务端不会拒绝（它只有密文）。
       */
      return deriveNotebookKey(encRoot, notebookId);
    },
    // 文件名对照表（`m:pathmap`）的密钥：全新设备靠它认出别的设备建的加密文件。
    ...(encRoot === null ? {} : { pathMapKey: derivePathMapKey(encRoot) }),
    onSynced: (synced) => handleSynced(backend, ledger, synced, hashCache),
    /**
     * ★ **拉取落地后按路径刷新界面**。
     *
     * 这一条以前是**缺的**（`attach.ts` 根本没有这个口子），后果是：
     * 同步把 500 篇笔记拉到了磁盘上，而侧栏还是空的 —— 用户看到的就是
     * 「A 同步完了，B 什么都没收到」。桌面端的主进程 watcher 救不了它，
     * 因为它会把「应用自己经 IPC 写过的路径」在 1.5 秒窗口内过滤掉，
     * 而拉取落盘走的正是同一条 IPC（见 `library.applyExternalPaths` 的注释）。
     */
    onApplied: (paths) => {
      heartbeat();
      void (async () => {
        try {
          const { applyExternalPaths } = await import("../data/library");
          await applyExternalPaths(paths);
        } catch (error) {
          console.warn("[opennote] 同步落地后刷新界面失败", error);
        }
      })();
    },
    /**
     * 进度回调同时充当**账本落盘的心跳**。
     *
     * 为什么要它：`handleSynced` 只在**整轮成功**后写账本（`appSync.ts` 的
     * `onSynced`），而一轮同步可能跑几分钟（500 篇 ≈ 4 分钟）。
     * 中途撞限流 429 / 用户关窗 / 断网 ⇒ 这一轮抛异常 ⇒ 一次都不写 ⇒
     * 下一轮**从第 1 篇重新拉**，永远同步不完（实测：拉到 65 篇被中断，账本目录都不存在）。
     * 这里每 2 秒落一次盘，让「已经拉下来的那些」算数。
     */
    onProgress: () => heartbeat(),
    // 实时状态（含进度）进 store —— 对话框与状态栏都从这里读。
    // 与绑定层同一个出口：401 / 账号停用还要落到账号状态上（设置页据此切到「重新登录」）。
    onStatus: (status) => onBindingStatus(status),
    openEventStream,
    /*
     * ★ 日志进 `logs`（诊断折叠区），**不进 `error`**。
     *
     * 以前这行是 `error: line`，于是「[sync] 收到远端信号（游标 …）」这种例行信息
     * 被当成错误，以红字长条的形式压在状态卡片里，还把面板撑出了横向滚动条。
     * 日志是排查用的；`error` 只留给真正要用户看见的失败。
     */
    log: (line) =>
      syncUiStore.set((prev) => ({
        ...prev,
        logs: [...prev.logs, line.replace(/^\[(binding|sync|stream)\] /, "")].slice(-40),
      })),
  });
  /*
   * ★ 迟到的结果不许接管（绑定层按代次停掉它的 controller，但这里的模块状态它管不到）：
   * 切工作区 / 改配置时两次 attach 交错，慢的那次后回来会把 `activeSession` 换成一个
   * **已被停掉**的会话 —— 之后每次保存都排进一个 dispose 过的 runner，再也不推送；
   * 关掉工作区之后才回来的那次还会把「同步开着」重新打开。
   */
  if (token !== attachToken) return result;
  if (result.ok) {
    activeSession = result.session;
    // 库层的「外部改动」处置要看这个开关（开着同步 ⇒ 两边都改是冲突，不是磁盘赢）。
    setSyncActive(true);
  }
  return result;
}

/* ============================================================================
   对 App 暴露的生命周期
   ============================================================================ */

/** 工作区打开（或同步配置变更）时调用；内部自会处理「关掉旧的、接上新的」。 */
export async function openWorkspaceSync(record: WorkspaceRecord, backend: FileSystemBackend): Promise<void> {
  const previous = currentRecord;
  currentRecord = record;
  currentBackend = backend;
  // 换了一个工作区（不是同一个重开）⇒ 上一份同步概要不再属于这里（L8，见 closeWorkspaceSync 的说明）。
  if (previous === null || previous.id !== record.id) {
    syncUiStore.set((prev) => ({ ...prev, last: null }));
  }
  subscribeWorkspaceWrites();
  await loadAccount();
  await binding.start();
}

/** 工作区关闭时调用：停掉绑定、清掉会话、退出「同步开着」的库层语义。 */
export function closeWorkspaceSync(): void {
  currentRecord = null;
  currentBackend = null;
  activeSession = null;
  attachToken += 1;
  unsubscribeWorkspaceWrites();
  binding.stop();
  releaseSyncLock();
  setSyncActive(false);
  /*
   * ★ `last` 必须一起清掉（L8）：它是「最近一次成功同步的概要」，带着冲突清单、
   * 增删计数与 `treeTruncated` —— 但这些事实都属于**上一个工作区**。
   * 留着它，新工作区在第一轮同步完成前会显示别人的统计（状态栏「N 条删除已暂缓」、
   * 对话框里一串不属于它的冲突），用户可能据此做错误操作。
   */
  syncUiStore.set((prev) => ({ ...prev, status: null, last: null }));
}

/**
 * 订阅「有字节落盘」→ 去抖推一次。
 *
 * ## 为什么订阅的不是 `library.onLocalFlush`
 *
 * 那个事件只在库层的 `flushNote()` / `flushAll()` 里发 ——
 * 于是**绕过库层直写后端的产地（收件箱入库、导入 / 迁移、GitHub 拉取）一条都不通知**。
 * 用户实测的症状：「收件箱入库后 A 设备不推送，B 设备要等 A 手动同步」。
 *
 * 现在订阅的是 `FileSystemBackend` 那一层的写入通知（`src/fs/writeLog.ts`）：
 * 所有产地共用一个后端对象，所以新增产地自动接入，不需要谁记得来加一行。
 *
 * ## 两道过滤，缺一不可
 *
 * 1. **只有真的动了内容才推**（`write.content`）：`mkdir` 不推 ——
 *    目录本身不过同步（`selectSyncableEntries` 丢弃 `isDir`），推一轮也只会是空转。
 * 2. **不在同步范围里的路径不推**：最要紧的是 `.opennote/**` ——
 *    账本（`sync.json`）、元数据、收件箱暂存在这个目录下，**每轮同步自己都会写它们**。
 *    不排除的话，一轮同步写完账本就触发下一轮，形成自我驱动的循环。
 *
 *    这里用的是 `ignore.ts` 的**同一套内置判定**（不是另抄一张目录表）：
 *    同步范围只有一个产地，过滤它就必须走它，否则两张表迟早漂移。
 *    注意内置集里没有「所有隐藏路径」这条规则 —— `.gitignore` 是精确文件名命中、
 *    `.assets` 是正常目录（要同步的附件），所以这里只按内置集判，不额外加「点开头就排除」。
 */
function subscribeWorkspaceWrites(): void {
  if (writeUnsubscribed) return;
  const rules = createDefaultIgnoreRules();
  writeUnsubscribed = onWorkspaceWrite((write) => {
    if (!write.content) return;
    // 说不出路径的外部改动：没法按路径过滤，先核对本地有没有真改动再决定推不推。
    if (write.pathsUnknown) {
      if (!activeSession && lockWait) announceLocalWrite(lockWait.key);
      else void checkLocalChangesAndSchedule();
      return;
    }
    // 全是忽略路径（账本 / 元数据 / 收件箱暂存）⇒ 这一批与同步范围无关。
    if (write.paths.every((path) => shouldSkipEntry(rules, normalizePath(path), false))) return;
    if (activeSession) activeSession.runner.scheduleAfterLocalWrite();
    // 另一个标签页在同步这个笔记本（issue #3）：本地写入照常，只是告诉它去推。
    else if (lockWait) announceLocalWrite(lockWait.key);
  });
}

/** 正在核对本地（聚焦 + visibilitychange 常常一起来，不必扫两遍）。 */
let localCheckRunning = false;

/**
 * 外部改动但路径未知时：只扫本地（有哈希缓存，不发请求），真有未推改动才排一次推送。
 *
 * 不直接排推送是因为浏览器 / 手机每次回到前台都会来这么一下 —— 无条件推一轮
 * 就是每次切回来都白发两三个请求。
 */
async function checkLocalChangesAndSchedule(): Promise<void> {
  const session = activeSession;
  if (!session || localCheckRunning) return;
  // 正在同步：直接排一次，单飞会把它合并成「这一轮跑完再来一轮」。
  if (session.runner.status().phase === "syncing") {
    session.runner.scheduleAfterLocalWrite();
    return;
  }
  localCheckRunning = true;
  try {
    const dirty = await session.hasLocalChanges().catch(() => true);
    if (dirty && activeSession === session) session.runner.scheduleAfterLocalWrite();
  } finally {
    localCheckRunning = false;
  }
}

/** 退订写入通知（关工作区 / 登出）。没开同步的笔记本一个监听都不该留。 */
function unsubscribeWorkspaceWrites(): void {
  const off = writeUnsubscribed;
  writeUnsubscribed = null;
  if (off) off();
}

/** 本地写盘之后 → 去抖推一次。**保留给显式调用方**（写入通知是主路径）。 */
export function scheduleAfterLocalWrite(): void {
  activeSession?.runner.scheduleAfterLocalWrite();
}

/** 手动「立即同步」。返回值给对话框展示；错误已经落在 status 里。 */
export function manualSync(): Promise<SyncOnceResult | null> {
  const controller = binding.controller();
  return controller ? controller.syncNow() : Promise.resolve(null);
}

/**
 * 冲突裁决：用户点「采用远端」或「保留我的版本」之后调用。
 * 裁决成功后**自动再同步一轮**，把另一端也带到收敛状态。
 */
/**
 * 读一份冲突的**两边正文**（界面画 diff 用）。只读 —— 在用户还没决定之前，
 * 绝不能顺手把任何一边写下去。
 */
export async function previewConflict(path: string): Promise<ConflictPreview | null> {
  const session = activeSession;
  if (!session) return null;
  return readConflictPreview(session, path);
}

export async function resolveConflict(path: string, direction: "remote" | "local"): Promise<ResolutionOutcome> {
  const session = activeSession;
  if (!session) return { path, ok: false, error: "同步还没有接上" };
  const outcome = direction === "remote" ? await resolveConflictWithRemote(session, path) : await resolveConflictWithLocal(session, path);
  if (outcome.ok) {
    // 先把这一条从清单里摘掉：随后那一轮同步若失败/被跳过，界面也不该还挂着已裁决的冲突。
    syncUiStore.set((prev) =>
      prev.last === null ? prev : { ...prev, last: { ...prev.last, conflicts: prev.last.conflicts.filter((item) => item.path !== path) } },
    );
    await manualSync();
  }
  return outcome;
}

/* ============================================================================
   设置页用的笔记本动作
   ============================================================================ */

/** 登录 / 退出 / 解锁之后：当前笔记本重新接上（没打开笔记本就什么都不做）。 */
onAccountChange(() => {
  if (currentRecord && currentBackend) void binding.start();
});

/**
 * 打开 / 关掉一个笔记本的同步。打开时只记「开 + 服务器 + 新建时用的加密方式」，
 * 对上云端哪个笔记本留到它被打开时再定（见 `resolveRemoteNotebook`）。
 */
export function setWorkspaceSyncEnabled(record: WorkspaceRecord, enabled: boolean, cryptoMode: "none" | "user-key" = "none"): WorkspaceRecord | null {
  const credentials = currentCredentials();
  const current = normalizeSyncConfig(record.sync);
  let updated: WorkspaceRecord | null;
  if (!enabled) {
    updated = updateWorkspaceSync(record.id, { ...current, enabled: false });
  } else {
    if (!credentials) throw new Error("还没有登录同步账号");
    // 换了服务器：之前对上的云端笔记本不作数了。
    const sameServer = current.baseUrl === credentials.server;
    updated = updateWorkspaceSync(record.id, {
      enabled: true,
      baseUrl: credentials.server,
      notebookId: sameServer ? current.notebookId : "",
      cryptoMode: sameServer && current.notebookId !== "" ? current.cryptoMode : cryptoMode,
      accountRef: credentials.accountId,
    });
  }
  // 改的是正打开的那个：立刻按新配置重新接上（关掉就停）。
  if (updated && currentRecord?.id === updated.id) {
    currentRecord = updated;
    void binding.start();
    if (!enabled) setSyncActive(false);
  }
  return updated;
}

/** 把一个本机笔记本绑到指定的云端笔记本（「下载到本机」用）。 */
export function bindWorkspaceToRemote(record: WorkspaceRecord, notebook: NotebookSummary): WorkspaceRecord | null {
  const credentials = currentCredentials();
  if (!credentials) throw new Error("还没有登录同步账号");
  return updateWorkspaceSync(record.id, {
    enabled: true,
    baseUrl: credentials.server,
    notebookId: notebook.notebookId,
    cryptoMode: notebook.cryptoMode,
    accountRef: credentials.accountId,
  });
}

/** 当前打开的笔记本的记录（设置页要知道「哪个是这台正在用的」）。 */
export function currentWorkspaceRecord(): WorkspaceRecord | null {
  return currentRecord;
}

/*
 * ★ 开发时这个模块**不许热替换**，改了就整页刷新。
 *
 * 它是有状态的：绑定、调度器、定时器、和服务器之间那条长连接都挂在模块级变量上。Vite 热替换会
 * 执行一份**新的**模块，而旧的那份（正在跑的同步循环）原样留着 —— App / 设置页改用新那份的
 * store，同步却还在旧那份里跑旧代码。真机踩过：加了「最近同步」之后同步照常，记录却一条都没有。
 * 自己接住更新（这样同步层的改动不会冒泡成 App 的热替换），然后整页刷新。生产构建里没有 `import.meta.hot`。
 */
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    window.location.reload();
  });
}
