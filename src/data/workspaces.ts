import { createStore, useStore } from "../lib/store";
import { desktopBridge } from "../desktop/bridge";
import {
  capacitorWorkspaceDir,
  createHandleBackend,
  createCapacitorBackend,
  createNodeBackend,
  deleteDirectoryHandle,
  ensureCapacitorPermissions,
  getDirectoryHandle,
  hasPermission,
  isCapacitorNative,
  joinPath,
  opfsWorkspaceDir,
  pickDirectory,
  putDirectoryHandle,
  sanitizeName,
  supportsFileSystemAccess,
  supportsOpfs,
  type BackendKind,
  type FileSystemBackend,
} from "../fs";
import { uid } from "../lib/utils";
import type { CryptoMode } from "../../shared/contract";

const STORAGE_KEY = "opennote.workspaces.v1";

/**
 * 工作区的同步配置（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §5.3「后端/同步选择的唯一接缝」）。
 *
 * ## 三条纪律
 *
 * 1. **默认关**（§5.3 原文：「**默认关**」）。同步是**旁路**（§5.1）——
 *    不开就不碰网络、不发任何请求。所以「读到一个坏值」时的正确退化是
 *    **关掉**，而不是猜一个配置去连。
 * 2. **`accountRef` 是引用，不是密钥。** 账号密钥由 `src/sync/keys.ts` 保管
 *    （桌面端在主进程里），这里只放一个指向它的标识 —— 工作区记录会进 `localStorage`，
 *    把密钥放进来等于把它放进一个可被 XSS 读的地方。
 * 3. **`enabled: true` 但没有可用的 `baseUrl`/`notebookId` ⇒ 视为关。**
 *    半配好的同步**绝不能**跑起来：那会往一个没验证过的地址发数据。
 */
export interface WorkspaceSyncConfig {
  enabled: boolean;
  /** 同步服务的公开地址（`https://notes.example.com`）。 */
  baseUrl: string;
  notebookId: string;
  cryptoMode: CryptoMode;
  /** 账号的**引用**（不是密钥本身）。 */
  accountRef: string;
}

/** 关掉的同步（也是所有坏值的退化目标）。 */
export const DISABLED_SYNC: WorkspaceSyncConfig = {
  enabled: false,
  baseUrl: "",
  notebookId: "",
  cryptoMode: "none",
  accountRef: "",
};

/**
 * 把一个**来路不明**的值规范化成一份可用的同步配置。
 *
 * 为什么必须有它：`load()` 是把 `localStorage` 里的 JSON **直接断言**成
 * `WorkspaceRecord[]` 的（没有逐字段校验）。加了一个嵌套对象之后，
 * `record.sync.enabled` 在一个坏记录上会是 `undefined` ——
 * 而 `undefined` 在真值判断里是假，看着「恰好安全」，
 * 但 `record.sync` 本身可能是 `"yes"` 这种字符串，于是 `record.sync.enabled` 直接抛。
 *
 * 所以这里逐字段校验，并且**任何一处不成立就退回「关」**。
 */
export function normalizeSyncConfig(raw: unknown): WorkspaceSyncConfig {
  if (raw === null || typeof raw !== "object") return { ...DISABLED_SYNC };
  const value = raw as Record<string, unknown>;

  // 只有**恰好** `true` 才算开 —— 坏值不许把同步意外打开。
  const wantsEnabled = value.enabled === true;
  const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl.trim() : "";
  const notebookId = typeof value.notebookId === "string" ? value.notebookId.trim() : "";
  const accountRef = typeof value.accountRef === "string" ? value.accountRef : "";
  const cryptoMode: CryptoMode = value.cryptoMode === "user-key" ? "user-key" : "none";

  // 地址必须是 http/https（`javascript:` / `file:` 之类的值不许被当成服务地址）。
  const usableUrl = (() => {
    if (!baseUrl) return false;
    try {
      const parsed = new URL(baseUrl);
      return parsed.protocol === "https:" || parsed.protocol === "http:";
    } catch {
      return false;
    }
  })();

  /*
   * ★ 半配好的同步视为**关**。
   * 缺 notebookId 就没法知道同步哪个笔记本；地址不可用就没法知道发给谁 ——
   * 这两种情况下「跑起来」都意味着往一个没验证过的目的地发数据。
   */
  const enabled = wantsEnabled && usableUrl && notebookId !== "";
  return { enabled, baseUrl, notebookId, cryptoMode, accountRef };
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  kind: BackendKind;
  /**
   * `node`: absolute folder path on disk.
   * `fsa`: key of the directory handle stored in IndexedDB — a uid, because the
   * old fixed `""` key made a second browser folder overwrite the first (D32).
   * `opfs`: directory name inside the browser's private file system.
   * `capacitor`: folder name under the phone's `Documents/OpenNote/`.
   */
  location: string;
  addedAt: number;
  lastOpenedAt: number;
  /**
   * 这个工作区的同步配置（§5.3）。**可选**：老记录里没有它，`normalizeSyncConfig` 会补上「关」。
   */
  sync?: WorkspaceSyncConfig;
}

interface RegistryState {
  workspaces: WorkspaceRecord[];
  activeId: string | null;
}

function load(): RegistryState {
  try {
    // D04 同源：浏览器「阻止所有站点数据」时 localStorage 是一个抛 SecurityError 的
    // getter，`typeof localStorage` 本身就会抛。守卫必须在 try 里，否则模块加载阶段
    // 就炸掉整个应用（白屏），而不是退化成「空注册表」。
    if (typeof localStorage === "undefined") return { workspaces: [], activeId: null };
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { workspaces: [], activeId: null };
    const parsed = JSON.parse(raw) as Partial<RegistryState>;
    const workspaces = Array.isArray(parsed.workspaces)
      ? (parsed.workspaces as WorkspaceRecord[]).map((record) => ({
          ...record,
          // 坏值一律退化成「关」（见 `normalizeSyncConfig` 的说明）。
          sync: normalizeSyncConfig((record as { sync?: unknown } | null)?.sync),
        }))
      : [];
    return { workspaces, activeId: parsed.activeId ?? null };
  } catch {
    return { workspaces: [], activeId: null };
  }
}

export const workspaceStore = createStore<RegistryState>(load());

export function useWorkspaces(): RegistryState {
  return useStore(workspaceStore);
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(workspaceStore.get()));
  } catch {
    /* storage full or blocked — the session keeps working */
  }
}

export function listWorkspaces(): WorkspaceRecord[] {
  return [...workspaceStore.get().workspaces].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

export function activeWorkspaceRecord(): WorkspaceRecord | null {
  const state = workspaceStore.get();
  return state.workspaces.find((workspace) => workspace.id === state.activeId) ?? null;
}

export function rememberWorkspace(input: { name: string; kind: BackendKind; location: string }): WorkspaceRecord {
  const state = workspaceStore.get();
  const existing = state.workspaces.find(
    (workspace) => workspace.kind === input.kind && workspace.location === input.location,
  );
  const now = Date.now();
  if (existing) {
    const updated: WorkspaceRecord = { ...existing, name: input.name || existing.name, lastOpenedAt: now };
    workspaceStore.set({
      workspaces: state.workspaces.map((workspace) => (workspace.id === existing.id ? updated : workspace)),
      activeId: existing.id,
    });
    persist();
    return updated;
  }
  const record: WorkspaceRecord = {
    id: uid(),
    name: input.name || "未命名笔记本",
    kind: input.kind,
    location: input.location,
    addedAt: now,
    lastOpenedAt: now,
  };
  workspaceStore.set({ workspaces: [...state.workspaces, record], activeId: record.id });
  persist();
  return record;
}

export function setActiveWorkspace(id: string | null): void {
  const state = workspaceStore.get();
  workspaceStore.set({
    workspaces: state.workspaces.map((workspace) =>
      workspace.id === id ? { ...workspace, lastOpenedAt: Date.now() } : workspace,
    ),
    activeId: id,
  });
  persist();
}

export async function forgetWorkspace(id: string): Promise<void> {
  const state = workspaceStore.get();
  const record = state.workspaces.find((workspace) => workspace.id === id);
  if (!record) return;
  if (record.kind === "fsa") await deleteDirectoryHandle(record.location).catch(() => undefined);
  const remaining = state.workspaces.filter((workspace) => workspace.id !== id);
  workspaceStore.set({
    workspaces: remaining,
    activeId: state.activeId === id ? (remaining[0]?.id ?? null) : state.activeId,
  });
  persist();
}

export class WorkspacePermissionError extends Error {
  constructor(readonly record: WorkspaceRecord) {
    super("需要重新授权访问这个文件夹");
    this.name = "WorkspacePermissionError";
  }
}

/**
 * D32: 0.1 时代的 FSA 记录 location 恒为 `""`，句柄存在 IndexedDB 的 `""` 键下，
 * 于是第二个浏览器文件夹必然覆盖第一个。旧句柄还能读到就重新登记到新的 uid 键；
 * 读不到时无法猜测它原本是哪个文件夹，只能明确要求用户重新选择。
 */
async function migrateLegacyFsaRecord(record: WorkspaceRecord): Promise<WorkspaceRecord> {
  if (record.location !== "") return record;
  const legacy = await getDirectoryHandle("").catch(() => null);
  if (!legacy) throw new Error("旧版本的浏览器文件夹记录已失效，请用「添加文件夹」重新选择一次");
  const key = uid();
  await putDirectoryHandle(key, legacy, legacy.name);
  await deleteDirectoryHandle("").catch(() => undefined);
  const updated: WorkspaceRecord = { ...record, location: key };
  const state = workspaceStore.get();
  workspaceStore.set({
    workspaces: state.workspaces.map((workspace) => (workspace.id === record.id ? updated : workspace)),
    activeId: state.activeId,
  });
  persist();
  return updated;
}

/** Resolve a record into a live backend, asking for permission when required. */
export async function resolveBackend(record: WorkspaceRecord, requestPermission = false): Promise<FileSystemBackend> {
  if (record.kind === "node") {
    const bridge = desktopBridge();
    if (!bridge) throw new Error("桌面版本才能直接读写本机文件夹");
    // D20: 主进程只接受「本次会话里用户授权过的 root」。旧版 preload 没有这道闸门时
    // 跳过探测，保证开发态 / 旧安装包还能用。
    if (typeof bridge.fs.authorizeRoot === "function") {
      const granted = await bridge.fs.authorizeRoot(record.location);
      if (!granted) throw new Error("这个文件夹还没有授权，请用「添加文件夹」重新选择一次");
    }
    return createNodeBackend(record.location, bridge);
  }
  if (record.kind === "fsa") {
    const current = record.location === "" ? await migrateLegacyFsaRecord(record) : record;
    const handle = await getDirectoryHandle(current.location);
    if (!handle) throw new Error("找不到之前授权的文件夹，请重新添加");
    if (!(await hasPermission(handle, requestPermission))) throw new WorkspacePermissionError(current);
    return createHandleBackend(handle, "fsa");
  }
  if (record.kind === "capacitor") {
    // capacitorWorkspaceDir 返回带 OpenNote/ 前缀的完整根目录，后端的
    // 所有相对路径都以它为基准——不能只传 location，否则会写到 Documents 顶层。
    return createCapacitorBackend(await capacitorWorkspaceDir(record.location));
  }
  return createHandleBackend(await opfsWorkspaceDir(record.location), "opfs");
}

/* ------------------------------------------------------------ add / create */

/** 同一个文件夹被再次选中时复用旧记录，而不是多出一个句柄键。 */
async function findWorkspaceForHandle(handle: FileSystemDirectoryHandle): Promise<WorkspaceRecord | null> {
  const canCompare = (handle as { isSameEntry?: unknown }).isSameEntry;
  if (typeof canCompare !== "function") return null;
  for (const workspace of workspaceStore.get().workspaces) {
    if (workspace.kind !== "fsa" || !workspace.location) continue;
    const stored = await getDirectoryHandle(workspace.location).catch(() => null);
    if (!stored) continue;
    const same = await (handle as FileSystemDirectoryHandle).isSameEntry(stored).catch(() => false);
    if (same) return workspace;
  }
  return null;
}

export async function addLocalFolder(): Promise<WorkspaceRecord | null> {
  const bridge = desktopBridge();
  if (bridge) {
    const path = await bridge.dialog.pickFolder();
    if (!path) return null;
    const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
    const record = rememberWorkspace({ name, kind: "node", location: path });
    await bridge.app.addRecentWorkspace(path).catch(() => undefined);
    return record;
  }
  if (!supportsFileSystemAccess()) throw new Error("这个浏览器不能直接读写磁盘文件夹，请改用「导入文件夹」");
  const handle = await pickDirectory();
  if (!handle) return null;
  const existing = await findWorkspaceForHandle(handle);
  if (existing) {
    await putDirectoryHandle(existing.location, handle, handle.name);
    return rememberWorkspace({ name: existing.name, kind: "fsa", location: existing.location });
  }
  // D32: 句柄键必须是唯一的。旧实现固定用 ""，第二个浏览器文件夹会把第一个的句柄覆盖掉。
  const key = uid();
  const record = rememberWorkspace({ name: `${handle.name}（浏览器）`, kind: "fsa", location: key });
  await putDirectoryHandle(record.location, handle, handle.name);
  return record;
}

/** A brand-new private notebook inside the browser (works in every modern browser). */
export async function createBrowserWorkspace(name = "我的笔记"): Promise<WorkspaceRecord> {
  if (!supportsOpfs()) throw new Error("这个浏览器不支持本地文件系统（OPFS）");
  const directory = sanitizeName(name, "笔记");
  await opfsWorkspaceDir(directory);
  return rememberWorkspace({ name: directory, kind: "opfs", location: directory });
}

/**
 * 手机 App（Capacitor 壳）里的笔记本：一个真正的文件夹，位于系统
 * `Documents/OpenNote/<名字>`，iOS 的「文件」App 与 Android 文件管理器都能看到。
 */
export async function createMobileWorkspace(name = "我的笔记"): Promise<WorkspaceRecord> {
  if (!isCapacitorNative()) throw new Error("只有在手机 App 里才能把笔记存成手机里的文件");
  await ensureCapacitorPermissions();
  const directory = sanitizeName(name, "笔记");
  await capacitorWorkspaceDir(directory);
  return rememberWorkspace({ name: directory, kind: "capacitor", location: directory });
}

/**
 * 从 GitHub 导入的镜像笔记本（网页版）。
 *
 * **显示名与目录名是两个东西**：显示名要能读出「这是谁的仓库」（`BUGLAN/opennote`），
 * 而 OPFS 的目录名在 `sanitizeName()` 之后会把 `/` 换成空格 —— 所以目录名走
 * `owner-repo`，显示名原样保留。`location`（= 目录名）仍是「同一个笔记本」的判据，
 * 重复导入同一个仓库因此复用同一条记录，而不是多出一个副本。
 */
export async function createMirrorWorkspace(displayName: string, directoryName: string): Promise<WorkspaceRecord> {
  if (!supportsOpfs()) throw new Error("这个浏览器不支持本地文件系统（OPFS），GitHub 导入暂时用不了");
  const directory = sanitizeName(directoryName, "repo");
  await opfsWorkspaceDir(directory);
  return rememberWorkspace({ name: displayName, kind: "opfs", location: directory });
}

export function workspaceDisplayName(record: WorkspaceRecord): string {
  if (record.kind === "node") return record.name;
  return record.name;
}

export { joinPath };
