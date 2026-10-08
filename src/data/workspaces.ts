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

const STORAGE_KEY = "opennote.workspaces.v1";

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
    const workspaces = Array.isArray(parsed.workspaces) ? (parsed.workspaces as WorkspaceRecord[]) : [];
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
