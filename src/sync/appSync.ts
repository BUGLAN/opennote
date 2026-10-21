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
import { createSyncLedger, readSyncLedger, writeSyncLedger, type SyncLedger } from "./state";
import { createWorkspaceSyncBinding, type BindingPhase } from "./binding";
import { setSyncActive } from "./mode";
import { describeSyncStatus, type SyncStatus } from "./runner";
import { normalizeSyncConfig, updateWorkspaceSync } from "../data/workspaces";
import type { SyncOnceResult } from "./engine";
import type { SyncSession } from "./session";
import { resolveConflictWithLocal, resolveConflictWithRemote, type ResolutionOutcome } from "./resolution";

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
  hasKey: false,
  accountId: null,
  storage: null,
});

/** 状态栏那两行字。没有打开笔记本 ⇒ null（那一位整个不渲染）。 */
export function syncStatusBarInfo(
  state: SyncUiState,
  hasWorkspace: boolean,
): { label: string; title: string } | null {
  if (!hasWorkspace) return null;
  if (!state.hasKey) {
    return { label: "同步 · 未导入密钥", title: "点击打开同步设置，注册或导入账号密钥" };
  }
  if (state.reason === "disabled") {
    return { label: "同步 · 关", title: "这个笔记本还没有开启同步；点击配置" };
  }
  if (state.reason === "incomplete") {
    return { label: "同步 · 未配置", title: "还差服务地址或笔记本；点击补全" };
  }
  if (state.status) {
    const text = describeSyncStatus(state.status);
    const title = text.detail ? `${text.label} — ${text.detail}` : text.label;
    return { label: `同步 · ${text.label}`, title };
  }
  if (state.phase === "attaching") {
    return { label: "同步 · 连接中", title: "正在接上同步服务" };
  }
  return { label: "同步 · 关", title: "点击配置同步" };
}

/* ============================================================================
   模块状态与内部工具
   ============================================================================ */

const keyStore: AccountKeyStore = resolveAccountKeyStore();

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

function onBindingStatus(status: SyncStatus): void {
  syncUiStore.set((prev) => ({ ...prev, status }));
}

function onBindingPhase(phase: BindingPhase): void {
  syncUiStore.set((prev) => ({ ...prev, phase, reason: phase === "skipped" ? binding.reason() : null }));
}

function onBindingLog(line: string): void {
  // 绑定层只把「真的意外」打到这里；可预期的跳过走 reason。
  syncUiStore.set((prev) => ({ ...prev, error: line.replace(/^\[binding\] /, "") }));
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
  if (
    existing &&
    existing.remote.notebookId === config.notebookId &&
    existing.remote.baseUrl === config.baseUrl &&
    existing.remote.cryptoMode === config.cryptoMode
  ) {
    return existing;
  }
  return createSyncLedger({
    baseUrl: config.baseUrl,
    notebookId: config.notebookId,
    cryptoMode: config.cryptoMode,
    protocolVersion: 1,
  });
}

/** 每一轮成功同步：账本落盘 + 概要进 UI（含冲突列表 —— 对话框从这里取）。 */
function handleSynced(backend: FileSystemBackend, ledger: SyncLedger, result: SyncOnceResult): void {
  void writeSyncLedger(backend, ledger).catch((error: unknown) => {
    syncUiStore.set((prev) => ({ ...prev, error: `账本落盘失败：${error instanceof Error ? error.message : String(error)}` }));
  });
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
  const gitignoreText = await backend.readText(".gitignore").catch(() => "");
  // 桌面 CSP 不放 https，`/v1/events` 的 SSE 订阅要走主进程 —— 那条桥还没接，
  // 所以桌面端先不开实时（启动 / 保存 / 回前台 / 手动四个触发源照常工作）。
  const isDesktop = desktopSyncBridge() !== null;

  const result = await attachWorkspaceSync({
    record,
    ledger,
    backend,
    accountKeyText: material.keyText,
    gitignoreText,
    notebookKeyForNotebook: (notebookId) =>
      config.cryptoMode === "user-key" ? deriveNotebookKey(encRootCache?.encRoot ?? new Uint8Array(), notebookId) : undefined,
    onSynced: (synced) => handleSynced(backend, ledger, synced),
    ...(isDesktop ? {} : { openEventStream: (url: string) => new EventSource(url) }),
    log: (line) => syncUiStore.set((prev) => ({ ...prev, error: line })),
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
  currentRecord = record;
  currentBackend = backend;
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
  syncUiStore.set((prev) => ({ ...prev, status: null, last: prev.last }));
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
