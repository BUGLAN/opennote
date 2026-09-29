import {
  ASSETS_DIR,
  HISTORY_DIR,
  META_DIR,
  STATE_FILE,
  TRASH_DIR,
  baseName,
  extName,
  formatStamp,
  isMarkdownPath,
  joinPath,
  parentPath,
  sanitizeName,
  stripExtension,
  uniquePath,
  type FileSystemBackend,
} from "../fs";
import { createStore, useStore } from "../lib/store";
import { countText, deriveTags, deriveTitle, normalizeEol, splitFrontMatter, stripMarkdown, uid } from "../lib/utils";
import type { Folder, Id, Note, Snapshot, SnapshotReason, SortKey } from "./types";
import { getUi, patchUi } from "./ui";
import { activeWorkspaceRecord, resolveBackend, setActiveWorkspace, type WorkspaceRecord } from "./workspaces";

/* ============================================================================
   The vault: a folder on disk, mirrored in memory for instant search and
   rendering. Files are the single source of truth — every mutation is written
   back through the active filesystem backend.
   ========================================================================= */

export interface LibraryState {
  ready: boolean;
  loading: boolean;
  workspace: WorkspaceRecord | null;
  notes: Record<Id, Note>;
  folders: Record<Id, Folder>;
  trash: Record<Id, Note>;
  dirty: Record<Id, true>;
  error: string | null;
  lastSavedAt: number | null;
  stats: { files: number; bytes: number };
}

const emptyState: LibraryState = {
  ready: false,
  loading: false,
  workspace: null,
  notes: {},
  folders: {},
  trash: {},
  dirty: {},
  error: null,
  lastSavedAt: null,
  stats: { files: 0, bytes: 0 },
};

export const libraryStore = createStore<LibraryState>(emptyState);

export function useLibrary(): LibraryState {
  return useStore(libraryStore);
}

export function getLibrary(): LibraryState {
  return libraryStore.get();
}

interface WorkspaceMeta {
  version: number;
  starred: Id[];
  expanded: Id[];
  lastOpened: Id | null;
}

const defaultMeta: WorkspaceMeta = { version: 1, starred: [], expanded: [], lastOpened: null };

let backend: FileSystemBackend | null = null;
let meta: WorkspaceMeta = { ...defaultMeta };
let metaTimer: ReturnType<typeof setTimeout> | null = null;
const writeTimers = new Map<Id, ReturnType<typeof setTimeout>>();
const lastSnapshotAt = new Map<Id, number>();
const SNAPSHOT_INTERVAL = 3 * 60_000;
const SNAPSHOT_KEEP = 60;

export function currentBackend(): FileSystemBackend | null {
  return backend;
}

export function currentWorkspace(): WorkspaceRecord | null {
  return libraryStore.get().workspace;
}

function requireBackend(): FileSystemBackend {
  if (!backend) throw new Error("还没有打开任何笔记本文件夹");
  return backend;
}

export function isWorkspaceOpen(): boolean {
  return backend !== null;
}

/** Folder of a note, as the editor needs it for relative image paths. */
export function parentPathOf(path: Id): string {
  return parentPath(path) || "";
}

/** Surface write failures as toasts without React having to poll the store. */
export function watchLibraryErrors(onError: (message: string) => void): () => void {
  let last = libraryStore.get().error;
  return libraryStore.subscribe(() => {
    const next = libraryStore.get().error;
    if (next && next !== last) onError(next);
    last = next;
  });
}

/* ------------------------------------------------------------------ helpers */

function makeFolder(path: string, mtimeMs: number): Folder {
  return {
    id: path,
    name: baseName(path),
    parentId: parentPath(path) || null,
    createdAt: mtimeMs || Date.now(),
    updatedAt: mtimeMs || Date.now(),
  };
}

function makeNote(path: string, content: string, mtimeMs: number, options: { starred?: boolean; trashed?: boolean } = {}): Note {
  const text = normalizeEol(content);
  const counts = countText(text);
  const stamp = mtimeMs || Date.now();
  return {
    id: path,
    folderId: parentPath(path) || null,
    title: deriveTitle(text, stripExtension(baseName(path))),
    titleOverride: null,
    content: text,
    createdAt: stamp,
    updatedAt: stamp,
    openedAt: stamp,
    starred: Boolean(options.starred),
    tags: deriveTags(text),
    chars: counts.chars,
    words: counts.words,
    trashed: Boolean(options.trashed),
    trashedAt: options.trashed ? stamp : null,
  };
}

function refresh(note: Note, content: string): Note {
  const text = normalizeEol(content);
  const counts = countText(text);
  return {
    ...note,
    content: text,
    title: deriveTitle(text, stripExtension(baseName(note.id))),
    tags: deriveTags(text),
    chars: counts.chars,
    words: counts.words,
  };
}

function setState(updater: (prev: LibraryState) => LibraryState): void {
  libraryStore.set(updater);
}

function patchNotes(updater: (notes: Record<Id, Note>) => Record<Id, Note>): void {
  setState((prev) => ({ ...prev, notes: updater(prev.notes) }));
}

function patchFolders(updater: (folders: Record<Id, Folder>) => Record<Id, Folder>): void {
  setState((prev) => ({ ...prev, folders: updater(prev.folders) }));
}

function reportError(error: unknown, message = "写入文件失败"): void {
  console.error("[opennote]", message, error);
  const detail = error instanceof Error ? error.message : String(error);
  setState((prev) => ({ ...prev, error: `${message}：${detail}` }));
}

/* -------------------------------------------------------------- open / scan */

export interface ScanResult {
  notes: Record<Id, Note>;
  folders: Record<Id, Folder>;
  trash: Record<Id, Note>;
  meta: WorkspaceMeta;
  files: number;
  bytes: number;
}

async function readMeta(target: FileSystemBackend): Promise<WorkspaceMeta> {
  try {
    const raw = await target.readText(STATE_FILE);
    const parsed = JSON.parse(raw) as Partial<WorkspaceMeta>;
    return {
      version: 1,
      starred: Array.isArray(parsed.starred) ? parsed.starred.map(String) : [],
      expanded: Array.isArray(parsed.expanded) ? parsed.expanded.map(String) : [],
      lastOpened: parsed.lastOpened ? String(parsed.lastOpened) : null,
    };
  } catch {
    return { ...defaultMeta };
  }
}

export async function scanWorkspace(target: FileSystemBackend): Promise<ScanResult> {
  const notes: Record<Id, Note> = {};
  const folders: Record<Id, Folder> = {};
  const trash: Record<Id, Note> = {};
  let files = 0;
  let bytes = 0;

  const walk = async (dir: string, inTrash: boolean): Promise<void> => {
    let entries;
    try {
      entries = await target.list(dir);
    } catch (error) {
      console.warn("[opennote] 无法读取目录", dir || "/", error);
      return;
    }
    for (const entry of entries) {
      const path = joinPath(dir, entry.name);
      if (entry.kind === "directory") {
        if (path === META_DIR) continue;
        const isTrash = path === TRASH_DIR;
        if (!isTrash) folders[path] = makeFolder(path, entry.mtimeMs);
        await walk(path, inTrash || isTrash);
        continue;
      }
      if (!isMarkdownPath(path)) continue;
      let content = "";
      try {
        content = await target.readText(path);
      } catch (error) {
        console.warn("[opennote] 无法读取笔记", path, error);
        continue;
      }
      files += 1;
      bytes += entry.size || content.length;
      const note = makeNote(path, content, entry.mtimeMs, { trashed: inTrash });
      if (inTrash) trash[path] = note;
      else notes[path] = note;
    }
  };

  await walk("", false);
  const workspaceMeta = await readMeta(target);
  for (const path of workspaceMeta.starred) {
    if (notes[path]) notes[path] = { ...notes[path], starred: true };
  }
  return { notes, folders, trash, meta: workspaceMeta, files, bytes };
}

/** Restore the workspace the user had open last time. */
export async function initLibrary(): Promise<void> {
  if (libraryStore.get().ready || libraryStore.get().loading) return;
  const record = activeWorkspaceRecord();
  if (!record) {
    setState((prev) => ({ ...prev, ready: true }));
    return;
  }
  try {
    await openWorkspace(record, { silent: true });
  } catch (error) {
    console.warn("[opennote] 上次的笔记本打不开了", error);
    setState((prev) => ({
      ...prev,
      ready: true,
      workspace: null,
      error: error instanceof Error ? error.message : "无法打开上次的笔记本",
    }));
  }
}

export async function openWorkspace(
  record: WorkspaceRecord,
  options: { silent?: boolean; requestPermission?: boolean } = {},
): Promise<void> {
  setState((prev) => ({ ...prev, loading: true, error: null }));
  try {
    const resolved = await resolveBackend(record, options.requestPermission ?? false);
    backend = resolved;
    const scanned = await scanWorkspace(resolved);
    meta = scanned.meta;
    setActiveWorkspace(record.id);
    setState((prev) => ({
      ...prev,
      ready: true,
      loading: false,
      workspace: record,
      notes: scanned.notes,
      folders: scanned.folders,
      trash: scanned.trash,
      dirty: {},
      error: null,
      lastSavedAt: Date.now(),
      stats: { files: scanned.files, bytes: scanned.bytes },
    }));
    patchUi({ expanded: meta.expanded, tabs: [], activeId: null });
    const last = meta.lastOpened && scanned.notes[meta.lastOpened] ? meta.lastOpened : null;
    if (last) openNote(last);
    if (!options.silent) {
      await ensureWorkspaceScaffold(resolved);
    }
  } catch (error) {
    setState((prev) => ({ ...prev, loading: false, ready: true }));
    throw error;
  }
}

/** Make sure the workspace has the folders the notebook expects. */
async function ensureWorkspaceScaffold(target: FileSystemBackend): Promise<void> {
  await target.mkdir(ASSETS_DIR).catch(() => undefined);
  await target.mkdir(META_DIR).catch(() => undefined);
}

export function closeWorkspace(): void {
  flushAll();
  flushMeta();
  backend = null;
  meta = { ...defaultMeta };
  libraryStore.set({ ...emptyState, ready: true });
}

/** Re-read the folder from disk (after an import, or when files changed outside). */
export async function rescanWorkspace(): Promise<void> {
  const target = backend;
  if (!target) return;
  const scanned = await scanWorkspace(target);
  meta = { ...scanned.meta, expanded: getUi().expanded, lastOpened: getUi().activeId ?? scanned.meta.lastOpened };
  invalidateSearchCache();
  setState((prev) => ({
    ...prev,
    notes: scanned.notes,
    folders: scanned.folders,
    trash: scanned.trash,
    error: null,
    stats: { files: scanned.files, bytes: scanned.bytes },
  }));
  reconcileTabs();
}

/* -------------------------------------------------------------------- writes */

function markClean(id: Id): void {
  setState((prev) => {
    if (!prev.dirty[id]) return { ...prev, lastSavedAt: Date.now() };
    const dirty = { ...prev.dirty };
    delete dirty[id];
    return { ...prev, dirty, lastSavedAt: Date.now() };
  });
}

function flushNote(id: Id): void {
  const timer = writeTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    writeTimers.delete(id);
  }
  const note = libraryStore.get().notes[id];
  const target = backend;
  if (!note || !target) return;
  target
    .writeText(note.id, note.content)
    .then(() => markClean(id))
    .catch((error) => reportError(error, "写入笔记失败"));
}

function persistNoteSoon(id: Id, delay = 450): void {
  const existing = writeTimers.get(id);
  if (existing) clearTimeout(existing);
  writeTimers.set(
    id,
    setTimeout(() => flushNote(id), delay),
  );
}

export function flushAll(): void {
  for (const id of [...writeTimers.keys()]) flushNote(id);
}

function scheduleMeta(delay = 700): void {
  if (metaTimer) clearTimeout(metaTimer);
  metaTimer = setTimeout(() => flushMeta(), delay);
}

export function flushMeta(): void {
  if (metaTimer) {
    clearTimeout(metaTimer);
    metaTimer = null;
  }
  const target = backend;
  if (!target) return;
  target
    .writeText(STATE_FILE, `${JSON.stringify(meta, null, 2)}\n`)
    .catch((error) => reportError(error, "写入笔记本元数据失败"));
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    flushAll();
    flushMeta();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushAll();
      flushMeta();
    }
  });
}

/* --------------------------------------------------------------------- notes */

function uniqueNotePath(title: string, folderId: Id | null, taken: Set<string>): string {
  const dir = folderId ?? "";
  const name = `${sanitizeName(title, "无标题")}.md`;
  return uniquePath(joinPath(dir, name), taken);
}

export function createNote(options: { folderId?: Id | null; content?: string; title?: string | null; open?: boolean } = {}): Note {
  const target = backend;
  const folderId = options.folderId ?? null;
  const title = options.title ?? "无标题";
  const path = target
    ? uniqueNotePath(title, folderId, new Set(Object.keys(libraryStore.get().notes)))
    : `${sanitizeName(title, "无标题")}.md`;
  const content = options.content ?? "";
  const note = makeNote(path, content, Date.now());
  patchNotes((notes) => ({ ...notes, [note.id]: note }));
  setState((prev) => ({ ...prev, dirty: { ...prev.dirty, [note.id]: true } }));
  void target?.writeText(path, content).then(() => markClean(note.id)).catch((error) => reportError(error, "新建笔记失败"));
  if (folderId) expandFolder(folderId);
  if (options.open !== false) openNote(note.id);
  return note;
}

export function updateNoteContent(id: Id, content: string, options: { immediate?: boolean } = {}): void {
  const previous = libraryStore.get().notes[id];
  if (!previous || previous.content === normalizeEol(content)) return;
  const next = refresh(previous, content);
  next.updatedAt = Date.now();
  patchNotes((notes) => ({ ...notes, [id]: next }));
  setState((prev) => ({ ...prev, dirty: { ...prev.dirty, [id]: true } }));
  if (options.immediate) flushNote(id);
  else persistNoteSoon(id);
  maybeSnapshot(previous, next);
}

export function renameNote(id: Id, title: string): void {
  const note = libraryStore.get().notes[id];
  if (!note) return;
  const clean = sanitizeName(title, "无标题");
  const target = backend;
  const taken = new Set(Object.keys(libraryStore.get().notes));
  taken.delete(id);
  const nextPath = uniquePath(joinPath(parentPath(id), `${clean}${extName(id) || ".md"}`), taken);
  if (nextPath === id) return;
  patchNotes((notes) => {
    const next = { ...notes };
    delete next[id];
    next[nextPath] = { ...note, id: nextPath, title: clean, updatedAt: Date.now() };
    return next;
  });
  remapIds(id, nextPath);
  void target?.move(id, nextPath).catch((error) => reportError(error, "重命名失败"));
}

export function setStarred(id: Id, starred: boolean): void {
  const note = libraryStore.get().notes[id];
  if (!note) return;
  patchNotes((notes) => ({ ...notes, [id]: { ...note, starred } }));
  const set = new Set(meta.starred);
  if (starred) set.add(id);
  else set.delete(id);
  meta = { ...meta, starred: [...set] };
  scheduleMeta(200);
}

export function moveNote(id: Id, folderId: Id | null): void {
  const note = libraryStore.get().notes[id];
  if (!note || (note.folderId ?? null) === folderId) return;
  const taken = new Set(Object.keys(libraryStore.get().notes));
  taken.delete(id);
  const nextPath = uniquePath(joinPath(folderId ?? "", baseName(id)), taken);
  patchNotes((notes) => {
    const next = { ...notes };
    delete next[id];
    next[nextPath] = { ...note, id: nextPath, folderId: folderId ?? null, updatedAt: Date.now() };
    return next;
  });
  remapIds(id, nextPath);
  void backend?.move(id, nextPath).catch((error) => reportError(error, "移动笔记失败"));
}

export function duplicateNote(id: Id): Note | null {
  const note = libraryStore.get().notes[id];
  if (!note) return null;
  const copy = createNote({ folderId: note.folderId, content: note.content, title: `${note.title} 副本` });
  return copy;
}

export function touchNoteOpened(id: Id): void {
  const note = libraryStore.get().notes[id];
  if (!note) return;
  patchNotes((notes) => ({ ...notes, [id]: { ...note, openedAt: Date.now() } }));
  meta = { ...meta, lastOpened: id };
  scheduleMeta(1200);
}

/* --------------------------------------------------------------------- trash */

export function trashNote(id: Id): void {
  const note = libraryStore.get().notes[id];
  if (!note) return;
  const trashed: Note = { ...note, trashed: true, trashedAt: Date.now() };
  const target = joinPath(TRASH_DIR, id);
  patchNotes((notes) => {
    const next = { ...notes };
    delete next[id];
    return next;
  });
  setState((prev) => ({ ...prev, trash: { ...prev.trash, [target]: trashed } }));
  closeTab(id);
  void backend?.move(id, target).catch((error) => reportError(error, "移入回收站失败"));
}

export function restoreNote(id: Id): void {
  const note = libraryStore.get().trash[id];
  if (!note) return;
  const original = id.startsWith(`${TRASH_DIR}/`) ? id.slice(TRASH_DIR.length + 1) : baseName(id);
  const taken = new Set(Object.keys(libraryStore.get().notes));
  const nextPath = uniquePath(original, taken);
  const restored: Note = { ...note, id: nextPath, folderId: parentPath(nextPath) || null, trashed: false, trashedAt: null };
  setState((prev) => {
    const trash = { ...prev.trash };
    delete trash[id];
    return { ...prev, trash, notes: { ...prev.notes, [nextPath]: restored } };
  });
  if (parentPath(nextPath)) expandFolder(parentPath(nextPath));
  void backend?.move(id, nextPath).catch((error) => reportError(error, "恢复失败"));
}

export async function purgeNote(id: Id): Promise<void> {
  setState((prev) => {
    const trash = { ...prev.trash };
    delete trash[id];
    return { ...prev, trash };
  });
  await backend?.remove(id, { recursive: false }).catch((error) => reportError(error, "删除失败"));
}

export async function emptyTrash(): Promise<number> {
  const count = Object.keys(libraryStore.get().trash).length;
  setState((prev) => ({ ...prev, trash: {} }));
  await backend?.remove(TRASH_DIR, { recursive: true }).catch((error) => reportError(error, "清空回收站失败"));
  return count;
}

/* ------------------------------------------------------------------- folders */

export function createFolder(name: string, parentId: Id | null = null): Folder {
  const folderName = sanitizeName(name, "新文件夹");
  const path = uniquePath(joinPath(parentId ?? "", folderName), new Set(Object.keys(libraryStore.get().folders)));
  const folder: Folder = {
    id: path,
    name: baseName(path),
    parentId: parentId ?? null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  patchFolders((folders) => ({ ...folders, [path]: folder }));
  void backend?.mkdir(path).catch((error) => reportError(error, "新建文件夹失败"));
  expandFolder(path);
  return folder;
}

export function renameFolder(id: Id, name: string): void {
  const folder = libraryStore.get().folders[id];
  if (!folder) return;
  const clean = sanitizeName(name, "文件夹");
  const nextPath = joinPath(parentPath(id), clean);
  if (nextPath === id) return;
  remapIds(id, nextPath, { prefix: true });
  void backend?.move(id, nextPath).catch((error) => reportError(error, "重命名文件夹失败"));
}

export function descendantFolderIds(id: Id, folders = libraryStore.get().folders): Id[] {
  const out: Id[] = [];
  const walk = (parent: Id) => {
    for (const folder of Object.values(folders)) {
      if (folder.parentId === parent) {
        out.push(folder.id);
        walk(folder.id);
      }
    }
  };
  walk(id);
  return out;
}

export function isDescendant(candidate: Id, ancestor: Id): boolean {
  return descendantFolderIds(ancestor).includes(candidate);
}

export async function deleteFolder(id: Id, mode: "trash" | "promote"): Promise<void> {
  const folders = libraryStore.get().folders;
  const folder = folders[id];
  if (!folder) return;
  const doomed = [id, ...descendantFolderIds(id, folders)];
  const target = backend;
  const affected = Object.values(libraryStore.get().notes).filter(
    (note) => note.folderId && doomed.includes(note.folderId),
  );

  if (mode === "trash") {
    for (const note of affected) trashNote(note.id);
    await target?.remove(id, { recursive: true }).catch((error) => reportError(error, "删除文件夹失败"));
    await target?.remove(joinPath(TRASH_DIR, id), { recursive: true }).catch(() => undefined);
  } else {
    const parent = folder.parentId;
    for (const note of affected) moveNote(note.id, parent);
    for (const folderId of doomed.slice(1)) {
      const child = folders[folderId];
      moveFolder(folderId, parent && child ? parent : null);
    }
    await target?.remove(id, { recursive: true }).catch((error) => reportError(error, "删除文件夹失败"));
  }

  patchFolders((all) => {
    const next = { ...all };
    for (const folderId of doomed) delete next[folderId];
    return next;
  });
  patchUi({ expanded: getUi().expanded.filter((folderId) => !doomed.includes(folderId)) });
}

export function moveFolder(id: Id, parentId: Id | null): void {
  const folders = libraryStore.get().folders;
  const folder = folders[id];
  if (!folder || (folder.parentId ?? null) === (parentId ?? null)) return;
  if (parentId && (parentId === id || isDescendant(parentId, id))) return;
  const nextPath = joinPath(parentId ?? "", baseName(id));
  remapIds(id, nextPath, { prefix: true });
  if (parentId) expandFolder(parentId);
  void backend?.move(id, nextPath).catch((error) => reportError(error, "移动文件夹失败"));
}

export function folderPath(id: Id, folders = libraryStore.get().folders): Folder[] {
  const path: Folder[] = [];
  let cursor: Id | null = id;
  let guard = 0;
  while (cursor && guard < 64) {
    const folder: Folder | undefined = folders[cursor];
    if (!folder) break;
    path.unshift(folder);
    cursor = folder.parentId;
    guard += 1;
  }
  return path;
}

export function folderPathLabel(id: Id | null, folders = libraryStore.get().folders): string {
  if (!id) return "根目录";
  const parts = folderPath(id, folders).map((folder) => folder.name);
  return parts.length ? parts.join(" / ") : baseName(id);
}

/** Rewrite every id that starts with (or equals) `oldId` after a rename/move. */
function remapIds(oldId: Id, newId: Id, options: { prefix?: boolean } = {}): void {
  const replace = (value: Id): Id =>
    value === oldId ? newId : options.prefix && value.startsWith(`${oldId}/`) ? `${newId}${value.slice(oldId.length)}` : value;

  patchNotes((notes) => {
    const next: Record<Id, Note> = {};
    for (const [key, note] of Object.entries(notes)) {
      const id = replace(key);
      next[id] = { ...note, id, folderId: note.folderId ? replace(note.folderId) : null };
    }
    return next;
  });
  patchFolders((folders) => {
    const next: Record<Id, Folder> = {};
    for (const [key, folder] of Object.entries(folders)) {
      const id = replace(key);
      next[id] = { ...folder, id, parentId: folder.parentId ? replace(folder.parentId) : null, name: baseName(id) };
    }
    return next;
  });
  setState((prev) => {
    const trash: Record<Id, Note> = {};
    for (const [key, note] of Object.entries(prev.trash)) trash[replace(key)] = note;
    return { ...prev, trash };
  });
  const ui = getUi();
  const patch: Record<string, unknown> = {};
  if (ui.activeId) patch.activeId = replace(ui.activeId);
  if (ui.lastNoteId) patch.lastNoteId = replace(ui.lastNoteId);
  if (ui.tabs.some((tab) => replace(tab) !== tab)) patch.tabs = ui.tabs.map(replace);
  if (Object.keys(patch).length) patchUi(patch as never);
  meta = {
    ...meta,
    starred: meta.starred.map(replace),
    expanded: meta.expanded.map(replace),
    lastOpened: meta.lastOpened ? replace(meta.lastOpened) : null,
  };
  scheduleMeta(400);
}

/* --------------------------------------------------------------- tree state */

export function expandFolder(id: Id): void {
  const ui = getUi();
  const expanded = ui.expanded.includes(id) ? ui.expanded : [...ui.expanded, id];
  patchUi({ expanded, collapsed: ui.collapsed.filter((folderId) => folderId !== id) });
  meta = { ...meta, expanded };
  scheduleMeta();
}

export function collapseFolder(id: Id): void {
  const ui = getUi();
  const expanded = ui.expanded.filter((folderId) => folderId !== id);
  patchUi({
    expanded,
    collapsed: ui.collapsed.includes(id) ? ui.collapsed : [...ui.collapsed, id],
  });
  meta = { ...meta, expanded };
  scheduleMeta();
}

export function toggleFolder(id: Id): void {
  const ui = getUi();
  if (ui.expanded.includes(id)) {
    collapseFolder(id);
    return;
  }
  const children = descendantFolderIds(id).filter((folderId) => !ui.collapsed.includes(folderId));
  const expanded = [...new Set([...ui.expanded, id, ...children])];
  patchUi({ expanded });
  meta = { ...meta, expanded };
  scheduleMeta();
}

/* ---------------------------------------------------------------------- tabs */

export function openNote(id: Id, options: { activate?: boolean } = {}): void {
  const note = libraryStore.get().notes[id];
  if (!note) return;
  const ui = getUi();
  const tabs = ui.tabs.includes(id) ? ui.tabs : [...ui.tabs, id];
  if (options.activate === false) {
    patchUi({ tabs });
    return;
  }
  patchUi({ tabs, activeId: id, lastNoteId: id });
  touchNoteOpened(id);
}

export function closeTab(id: Id): void {
  const ui = getUi();
  if (!ui.tabs.includes(id)) return;
  const index = ui.tabs.indexOf(id);
  const tabs = ui.tabs.filter((tabId) => tabId !== id);
  const activeId = ui.activeId === id ? (tabs[Math.min(index, tabs.length - 1)] ?? null) : ui.activeId;
  patchUi({ tabs, activeId });
}

export function closeOtherTabs(id: Id): void {
  patchUi({ tabs: [id], activeId: id });
}

export function closeTabsToRight(id: Id): void {
  const ui = getUi();
  const index = ui.tabs.indexOf(id);
  if (index < 0) return;
  patchUi({ tabs: ui.tabs.slice(0, index + 1), activeId: id });
}

export function closeAllTabs(): void {
  patchUi({ tabs: [], activeId: null });
}

export function cycleTab(direction: 1 | -1): void {
  const ui = getUi();
  if (ui.tabs.length < 2) return;
  const index = ui.activeId ? ui.tabs.indexOf(ui.activeId) : 0;
  const next = (index + direction + ui.tabs.length) % ui.tabs.length;
  patchUi({ activeId: ui.tabs[next] });
}

export function reconcileTabs(): void {
  const ui = getUi();
  const notes = libraryStore.get().notes;
  const tabs = ui.tabs.filter((id) => notes[id]);
  const activeId = ui.activeId && tabs.includes(ui.activeId) ? ui.activeId : (tabs[tabs.length - 1] ?? null);
  if (tabs.length !== ui.tabs.length || activeId !== ui.activeId) patchUi({ tabs, activeId });
}

/* ----------------------------------------------------------------- selectors */

export function sortNotes(notes: Note[], sort: SortKey): Note[] {
  const copy = [...notes];
  if (sort === "title") copy.sort((a, b) => a.title.localeCompare(b.title, "zh-Hans-CN"));
  else if (sort === "created") copy.sort((a, b) => b.createdAt - a.createdAt);
  else copy.sort((a, b) => b.updatedAt - a.updatedAt);
  return copy;
}

export function notesInFolder(
  state: LibraryState,
  folderId: Id | null | undefined,
  options: { descendants?: boolean; sort?: SortKey; includeTrashed?: boolean } = {},
): Note[] {
  const { descendants = false, sort = "updated", includeTrashed = false } = options;
  if (includeTrashed) return sortNotes(Object.values(state.trash), sort);
  const scope =
    folderId && descendants ? new Set([folderId, ...descendantFolderIds(folderId, state.folders)]) : null;
  const list = Object.values(state.notes).filter((note) => {
    if (folderId === undefined) return true;
    if (scope) return note.folderId !== null && scope.has(note.folderId);
    return (note.folderId ?? null) === (folderId ?? null);
  });
  return sortNotes(list, sort);
}

export function childFolders(state: LibraryState, parentId: Id | null): Folder[] {
  return Object.values(state.folders)
    .filter((folder) => (folder.parentId ?? null) === (parentId ?? null))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

export function folderStats(state: LibraryState, folderId: Id): { notes: number; folders: number } {
  const scope = new Set([folderId, ...descendantFolderIds(folderId, state.folders)]);
  let notes = 0;
  for (const note of Object.values(state.notes)) {
    if (note.folderId && scope.has(note.folderId)) notes += 1;
  }
  let folders = 0;
  for (const folder of Object.values(state.folders)) {
    if (folder.parentId && scope.has(folder.parentId) && scope.has(folder.id)) folders += 1;
  }
  return { notes, folders };
}

export function starredNotes(state: LibraryState, sort: SortKey = "updated"): Note[] {
  return sortNotes(Object.values(state.notes).filter((note) => note.starred), sort);
}

export function trashedNotes(state: LibraryState): Note[] {
  return sortNotes(Object.values(state.trash), "updated");
}

export function allTags(state: LibraryState): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const note of Object.values(state.notes)) {
    for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "zh-Hans-CN"));
}

const plainCache = new Map<Id, string>();

function plainOf(note: Note): string {
  const cached = plainCache.get(note.id);
  if (cached !== undefined) return cached;
  const text = stripMarkdown(note.content).toLowerCase();
  plainCache.set(note.id, text);
  return text;
}

export function invalidateSearchCache(id?: Id): void {
  if (id) plainCache.delete(id);
  else plainCache.clear();
}

export interface SearchHit {
  note: Note;
  score: number;
  snippet: string;
}

export function searchNotes(query: string, options: { limit?: number; sort?: SortKey } = {}): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const { limit = 80, sort = "updated" } = options;
  const state = libraryStore.get();
  const terms = q.split(/\s+/).filter(Boolean);
  const raw: { note: Note; score: number; position: number }[] = [];

  for (const note of Object.values(state.notes)) {
    const title = note.title.toLowerCase();
    const tags = note.tags.join(" ").toLowerCase();
    const body = plainOf(note);
    let score = 0;
    let matchedAll = true;
    let position = -1;

    for (const term of terms) {
      const inTitle = title.indexOf(term);
      const inTags = tags.indexOf(term);
      const inBody = body.indexOf(term);
      if (inTitle < 0 && inTags < 0 && inBody < 0) {
        matchedAll = false;
        break;
      }
      if (inTitle >= 0) score += 60 - Math.min(30, inTitle);
      else if (inTags >= 0) score += 34;
      if (inBody >= 0) {
        score += 16;
        if (position < 0 || inBody < position) position = inBody;
      }
    }
    if (!matchedAll) continue;
    score += Math.max(0, 8 - Math.floor((Date.now() - note.updatedAt) / 86_400_000));
    raw.push({ note, score, position });
  }

  const buildSnippet = (note: Note, position: number): string => {
    const text = stripMarkdown(splitFrontMatter(note.content).body).replace(/\s+/g, " ").trim();
    if (!text) return "";
    if (position < 0) return text.slice(0, 96);
    const start = Math.max(0, position - 34);
    const end = Math.min(text.length, position + 82);
    return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
  };

  const hits = raw
    .sort((a, b) => b.score - a.score || b.note.updatedAt - a.note.updatedAt)
    .slice(0, limit)
    .map((entry) => ({ note: entry.note, score: entry.score, snippet: buildSnippet(entry.note, entry.position) }));
  return sort === "updated" ? hits : hits.sort((a, b) => a.note.title.localeCompare(b.note.title, "zh-Hans-CN"));
}

export function notesArray(state: LibraryState = libraryStore.get()): Note[] {
  return Object.values(state.notes);
}

export function foldersArray(state: LibraryState = libraryStore.get()): Folder[] {
  return Object.values(state.folders);
}

/* ----------------------------------------------------------------- snapshots */

function maybeSnapshot(previous: Note, next: Note): void {
  const ui = getUi();
  if (!ui.snapshots || !backend) return;
  const last = lastSnapshotAt.get(next.id) ?? 0;
  if (Date.now() - last < SNAPSHOT_INTERVAL) return;
  if (previous.content.trim() === next.content.trim()) return;
  lastSnapshotAt.set(next.id, Date.now());
  void writeSnapshot(next.id, previous.content, "auto");
}

async function writeSnapshot(noteId: Id, content: string, reason: SnapshotReason): Promise<void> {
  const target = backend;
  if (!target) return;
  const dir = joinPath(HISTORY_DIR, noteId);
  const file = joinPath(dir, `${formatStamp(Date.now()).replace(/[: ]/g, "-")}-${reason}.md`);
  try {
    await target.writeText(file, content);
    await pruneSnapshots(noteId);
  } catch (error) {
    console.warn("[opennote] 快照写入失败", error);
  }
}

async function pruneSnapshots(noteId: Id): Promise<void> {
  const target = backend;
  if (!target) return;
  const dir = joinPath(HISTORY_DIR, noteId);
  const entries = await target.list(dir).catch(() => []);
  const files = entries.filter((entry) => entry.kind === "file").sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of files.slice(SNAPSHOT_KEEP)) {
    await target.remove(joinPath(dir, entry.name)).catch(() => undefined);
  }
}

export async function listSnapshots(noteId: Id): Promise<Snapshot[]> {
  const target = backend;
  if (!target) return [];
  const dir = joinPath(HISTORY_DIR, noteId);
  const entries = await target.list(dir).catch(() => []);
  const snapshots: Snapshot[] = [];
  for (const entry of entries) {
    if (entry.kind !== "file") continue;
    const path = joinPath(dir, entry.name);
    let content = "";
    try {
      content = await target.readText(path);
    } catch {
      continue;
    }
    const reason: SnapshotReason = entry.name.includes("-manual")
      ? "manual"
      : entry.name.includes("-restore")
        ? "restore"
        : "auto";
    snapshots.push({ id: path, noteId, title: "", content, createdAt: entry.mtimeMs || Date.now(), reason });
  }
  return snapshots.sort((a, b) => b.createdAt - a.createdAt);
}

export async function takeManualSnapshot(noteId: Id): Promise<void> {
  const note = libraryStore.get().notes[noteId];
  if (!note) return;
  lastSnapshotAt.set(noteId, Date.now());
  await writeSnapshot(noteId, note.content, "manual");
}

export async function restoreSnapshot(snapshot: Snapshot): Promise<void> {
  const note = libraryStore.get().notes[snapshot.noteId];
  if (!note) return;
  await writeSnapshot(note.id, note.content, "restore");
  updateNoteContent(note.id, snapshot.content, { immediate: true });
}

/* ------------------------------------------------------- images & uploads */

export function assetsDirectory(): string {
  return ASSETS_DIR;
}

/** Persist an image next to the note and return the markdown-ready relative path. */
export async function saveImage(blob: Blob, suggestedName: string, baseDir = ""): Promise<{ path: string; markdown: string }> {
  const target = requireBackend();
  const dir = joinPath(baseDir, ASSETS_DIR);
  const existing = await target.list(dir).catch(() => []);
  const taken = new Set(existing.map((entry) => entry.name));
  const name = uniquePath(sanitizeName(suggestedName, `图片-${Date.now()}.png`), taken);
  const path = joinPath(dir, name);
  await target.writeBytes(path, blob);
  return { path, markdown: `./${ASSETS_DIR}/${name}` };
}

/* ------------------------------------------------------------------ bootstrap */

/** Seed a brand-new workspace with the welcome note (awaits the disk write). */
export async function seedWelcome(content: string, title = "欢迎来到 Opennote"): Promise<Note> {
  const note = createNote({ folderId: null, content, title });
  const target = backend;
  if (target) {
    await target.writeText(note.id, note.content);
    markClean(note.id);
  }
  return note;
}

export { uid, formatStamp };
