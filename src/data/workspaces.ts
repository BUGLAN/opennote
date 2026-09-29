import { createStore, useStore } from "../lib/store";
import { desktopBridge } from "../desktop/bridge";
import {
  createHandleBackend,
  createNodeBackend,
  deleteDirectoryHandle,
  getDirectoryHandle,
  hasPermission,
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
   * `fsa`: key of the directory handle stored in IndexedDB.
   * `opfs`: directory name inside the browser's private file system.
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
  if (typeof localStorage === "undefined") return { workspaces: [], activeId: null };
  try {
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

/** Resolve a record into a live backend, asking for permission when required. */
export async function resolveBackend(record: WorkspaceRecord, requestPermission = false): Promise<FileSystemBackend> {
  if (record.kind === "node") {
    const bridge = desktopBridge();
    if (!bridge) throw new Error("桌面版本才能直接读写本机文件夹");
    return createNodeBackend(record.location, bridge);
  }
  if (record.kind === "fsa") {
    const handle = await getDirectoryHandle(record.location);
    if (!handle) throw new Error("找不到之前授权的文件夹，请重新添加");
    if (!(await hasPermission(handle, requestPermission))) throw new WorkspacePermissionError(record);
    return createHandleBackend(handle, "fsa");
  }
  return createHandleBackend(await opfsWorkspaceDir(record.location), "opfs");
}

/* ------------------------------------------------------------ add / create */

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
  const record = rememberWorkspace({ name: `${handle.name}（浏览器）`, kind: "fsa", location: "" });
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

export function workspaceDisplayName(record: WorkspaceRecord): string {
  if (record.kind === "node") return record.name;
  return record.name;
}

export { joinPath };
