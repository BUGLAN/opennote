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
 * 密钥保管（`keys.ts`）、绑定竞态（`binding.ts`）、attach（`attach.ts`）、
 * 账本落盘（`state.ts`）各自只做一件事；这里把它们拼起来，并持有三样
 * **进程级**的状态：当前绑定的 backend / 账本 / 会话，以及解锁后的 `encRoot`
 * （**只在内存**，退出即失效 —— 它是加密根，落盘就违背红线 3）。
 */

import { createStore } from "../lib/store";
import type { FileSystemBackend } from "../fs/types";
import type { WorkspaceRecord } from "../data/workspaces";
import { desktopSyncBridge } from "./http";
import { attachWorkspaceSync, type AttachResult, type AttachSkipReason } from "./attach";
import {
  createRegistrationMaterial,
  decodeAccountKey,
  deriveFromAccountKey,
  deriveNotebookKey,
  encodeAccountKey,
  unwrapEncRoot,
  type RegistrationMaterial,
} from "./accountKey";
import { describeKeyStorage, resolveAccountKeyStore, type AccountKeyStore } from "./keys";
import { openAccountApi, type NotebookSummary } from "./accountApi";
import { createSyncLedger, isSameRemote, readSyncLedger, writeSyncLedger, type SyncLedger } from "./state";
import { createHashCache, readHashCache, writeHashCache, type HashCache } from "./hashCache";
import { resolveCursorStore } from "./cursor";
import { createDesktopEventStream, supportsDesktopStream } from "./desktopStream";
import type { EventStreamLike } from "./stream";
import { createWorkspaceSyncBinding, type BindingPhase } from "./binding";
import { setSyncActive } from "./mode";
import type { SyncStatus } from "./runner";
/* `syncStatusBarInfo` 已移到 `statusBar.ts`（纯函数，可单独测），这里只转发。 */
import { normalizeSyncConfig, updateWorkspaceSync } from "../data/workspaces";
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
  hasKey: boolean;
  accountId: string | null;
  storage: { where: string; risk: string | null } | null;
}

export const syncUiStore = createStore<SyncUiState>({
  phase: "idle",
  reason: null,
  status: null,
  last: null,
  error: null,
  logs: [],
  hasKey: false,
  accountId: null,
  storage: null,
});

export { syncStatusBarInfo } from "./statusBar";
export type { SyncBarInfo, SyncBarTone } from "./statusBar";

/* ============================================================================
   模块状态与内部工具
   ============================================================================ */

const keyStore: AccountKeyStore = resolveAccountKeyStore();
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
let flushUnsubscribed: (() => void) | null = null;
/**
 * 解锁后的加密根。**只存内存**（红线 3）：退出应用就要重新解锁 ——
 * 桌面端密钥在主进程，解锁是一次静默的 `POST /v1/account/unlock`，代价可以接受。
 */
let encRootCache: { accountId: string; encRoot: Uint8Array } | null = null;

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

/** 刷新「有没有密钥 / 是谁的」这块事实（注册、导入、清除之后都要调）。 */
export async function refreshAccountState(): Promise<void> {
  try {
    const text = await keyStore.load();
    if (!text) {
      syncUiStore.set((prev) => ({ ...prev, hasKey: false, accountId: null, storage: describeKeyStorage(keyStore) }));
      return;
    }
    const parsed = decodeAccountKey(text);
    syncUiStore.set((prev) => ({ ...prev, hasKey: true, accountId: parsed.accountId, storage: describeKeyStorage(keyStore) }));
  } catch {
    syncUiStore.set((prev) => ({ ...prev, hasKey: false, accountId: null, storage: describeKeyStorage(keyStore) }));
  }
}

async function loadMaterial(): Promise<{ keyText: string; authToken: string; accountId: string; wrapKey: Uint8Array }> {
  const text = await keyStore.load();
  if (!text) throw new Error("这台设备还没有导入账号密钥");
  const parsed = decodeAccountKey(text);
  const derived = deriveFromAccountKey(parsed);
  return { keyText: text, authToken: derived.authToken, accountId: parsed.accountId, wrapKey: derived.wrapKey };
}

/** 解开 `wrappedEncRoot`（账号级、一次），缓存进内存；E2EE attach 前必须已解锁。 */
async function ensureUnlocked(baseUrl: string, material: Awaited<ReturnType<typeof loadMaterial>>): Promise<Uint8Array> {
  if (encRootCache && encRootCache.accountId === material.accountId) return encRootCache.encRoot;
  const api = await openAccountApi({ baseUrl, authToken: material.authToken });
  const unlocked = await api.unlock();
  const encRoot = unwrapEncRoot(material.wrapKey, unlocked.wrappedEncRoot, unlocked.accountId);
  encRootCache = { accountId: unlocked.accountId, encRoot };
  return encRoot;
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
    protocolVersion: 1,
  });
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
  syncUiStore.set((prev) => ({
    ...prev,
    last: {
      at: Date.now(),
      pushed: result.pushed,
      pulled: result.pulled,
      deleted: result.deleted,
      remoteDeleted: result.remoteDeleted,
      conflicts: [...result.conflicts, ...result.pushConflicts].map((item) => ({ path: item.path, kind: item.kind })),
      unknownDids: result.unknownDids.length,
      suspendedDeletes: result.suspendedDeletes.length,
      treeTruncated: result.treeTruncated,
      scanIncomplete: result.scanIncomplete,
      suspendedPushDeletes: result.suspendedPushDeletes.length,
    },
  }));
}

/** attach 的真身：读密钥 → （E2EE）解锁 → 账本 → attach。可预期的跳过返回 ok:false。 */
async function attachCurrent(): Promise<AttachResult> {
  const record = currentRecord;
  const backend = currentBackend;
  if (!record || !backend) return { ok: false, reason: "disabled", message: "没有打开的笔记本" };
  const config = normalizeSyncConfig(record.sync);

  let material: Awaited<ReturnType<typeof loadMaterial>>;
  try {
    material = await loadMaterial();
  } catch {
    return { ok: false, reason: "no-account-key", message: "这台设备还没有导入账号密钥" };
  }

  if (config.cryptoMode === "user-key") {
    // 解不开就**抛**（attach 的纪律：绝不退回明文）。binding 会把它记成意外错误。
    await ensureUnlocked(config.baseUrl, material);
  }

  const ledger = await loadLedger(backend, record);
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
    record,
    ledger,
    backend,
    accountKeyText: material.keyText,
    gitignoreText,
    hashCache,
    cursorStore,
    notebookKeyForNotebook: (notebookId) => {
      if (config.cryptoMode !== "user-key") return undefined;
      /*
       * ★★ 拿不到 `encRoot` 时**必须返回 undefined**（让 attach 抛「还没有它的密钥」），
       * **绝不能**退化成 `new Uint8Array()`：HKDF 对空输入**不报错**，会派生出一把
       * 「错误但形状正确」的密钥 —— 推上去的密文其它设备全都解不开，而服务端不会拒绝
       * （它只有密文）。这正是 L7 里那个极端时序的窗口。
       *
       * 顺带核对账号：`.opennote` 里没有 `encRoot`，但内存缓存可能还留着**上一个账号**的。
       */
      const cached = encRootCache;
      if (cached === null || cached.accountId !== material.accountId) return undefined;
      return deriveNotebookKey(cached.encRoot, notebookId);
    },
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
    onStatus: (status) => syncUiStore.set((prev) => ({ ...prev, status })),
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
  if (!flushUnsubscribed) {
    // 懒订阅：让 library 的落盘事件在这里转成「去抖推一次」。
    const { onLocalFlush } = await import("../data/library");
    flushUnsubscribed = onLocalFlush(() => scheduleAfterLocalWrite());
  }
  await refreshAccountState();
  await binding.start();
}

/** 工作区关闭时调用：停掉绑定、清掉会话、退出「同步开着」的库层语义。 */
export function closeWorkspaceSync(): void {
  currentRecord = null;
  currentBackend = null;
  activeSession = null;
  binding.stop();
  setSyncActive(false);
  /*
   * ★ `last` 必须一起清掉（L8）：它是「最近一次成功同步的概要」，带着冲突清单、
   * 增删计数与 `treeTruncated` —— 但这些事实都属于**上一个工作区**。
   * 留着它，新工作区在第一轮同步完成前会显示别人的统计（状态栏「N 条删除已暂缓」、
   * 对话框里一串不属于它的冲突），用户可能据此做错误操作。
   */
  syncUiStore.set((prev) => ({ ...prev, status: null, last: null }));
}

/** 本地写盘之后（library 的 onLocalFlush）→ 去抖推一次。 */
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
  if (outcome.ok) await manualSync();
  return outcome;
}

/* ============================================================================
   对话框用的账号动作
   ============================================================================ */

/** 注册第一步：**客户端**生成全部密钥材料（服务端不生成任何密钥，红线 3）。 */
export function prepareRegistration(): { material: RegistrationMaterial; keyText: string; accountId: string } {
  const material = createRegistrationMaterial();
  return {
    material,
    keyText: encodeAccountKey({ accountId: material.accountId, accountKey: material.accountKey }),
    accountId: material.accountId,
  };
}

/** 注册第二步：用户确认已保存密钥之后才允许调（引导码 `boot_` / 邀请码 `inv_` 按前缀分派）。 */
export async function completeRegistration(input: {
  baseUrl: string;
  code: string;
  material: RegistrationMaterial;
  keyText: string;
  label?: string;
}): Promise<{ accountId: string; isAdmin: boolean }> {
  const code = input.code.trim();
  const field = code.startsWith("boot_") ? "bootstrapCode" : code.startsWith("inv_") ? "inviteCode" : null;
  if (!field) throw new Error("看不懂这个码：管理员引导码以 boot_ 开头，注册邀请码以 inv_ 开头");
  const api = await openAccountApi({ baseUrl: input.baseUrl });
  const body = await api.register({
    accountId: input.material.accountId,
    authToken: input.material.authToken,
    wrappedEncRoot: input.material.wrappedEncRoot,
    label: input.label,
    [field]: code,
  });
  await keyStore.save(input.keyText);
  encRootCache = null;
  await refreshAccountState();
  return { accountId: body.accountId, isAdmin: body.isAdmin };
}

/** 导入已有账号密钥（另一台设备导出的那份文本）。 */
export async function importAccountKey(text: string): Promise<void> {
  const trimmed = text.trim();
  decodeAccountKey(trimmed); // 形状不对就抛（可读的错误），不进存储
  await keyStore.save(trimmed);
  encRootCache = null;
  await refreshAccountState();
}

/**
 * 取当前保存的密钥文本（已登录状态下「复制密钥」用）。
 *
 * 多设备流程的必需品：注册之后密钥文本只在注册表单里出现过一次，
 * 没有它，第二台设备永远拿不到正确的钥匙（真机踩过：用户拿着旧环境的
 * 密钥导入新环境，症状是「令牌无效」）。
 */
export async function exportCurrentKey(): Promise<string | null> {
  return keyStore.load();
}

/** 清除本机密钥（账号不变，只是这台设备退出登录）。同步随之停掉。 */
export async function forgetAccountKey(): Promise<void> {
  await keyStore.clear();
  encRootCache = null;
  closeWorkspaceSync();
  await refreshAccountState();
}

/** E2EE 解锁（拉取/推送前必须成功；成功后缓存进内存，本会话不再重复解锁）。 */
export async function unlockAccount(baseUrl: string): Promise<void> {
  const material = await loadMaterial();
  await ensureUnlocked(baseUrl, material);
}

/* ============================================================================
   对话框用的笔记本动作
   ============================================================================ */

export async function listNotebooks(baseUrl: string): Promise<NotebookSummary[]> {
  const material = await loadMaterial();
  const api = await openAccountApi({ baseUrl, authToken: material.authToken });
  const body = await api.listNotebooks();
  return body.notebooks;
}

export async function createNotebook(
  baseUrl: string,
  input: { name: string; cryptoMode: "none" | "user-key" },
): Promise<NotebookSummary> {
  const material = await loadMaterial();
  const api = await openAccountApi({ baseUrl, authToken: material.authToken });
  return api.createNotebook(input);
}

/** 保存连接配置（设置对话框「保存并连接」）。绑定重启由 App 的 effect 兜底。 */
export function saveWorkspaceConnection(
  record: WorkspaceRecord,
  input: { baseUrl: string; notebookId: string; cryptoMode: "none" | "user-key"; enabled: boolean },
): WorkspaceRecord | null {
  return updateWorkspaceSync(record.id, {
    enabled: input.enabled,
    baseUrl: input.baseUrl.trim(),
    notebookId: input.notebookId.trim(),
    cryptoMode: input.cryptoMode,
    accountRef: syncUiStore.get().accountId ?? record.sync?.accountRef ?? "",
  });
}
