import {
  ASSETS_DIR,
  HISTORY_DIR,
  META_DIR,
  STATE_FILE,
  TRASH_DIR,
  baseName,
  extName,
  formatStamp,
  isHiddenPath,
  isMarkdownPath,
  joinPath,
  parentPath,
  sanitizeName,
  stripExtension,
  uniquePath,
  type EntryInfo,
  type FileSystemBackend,
} from "../fs";
import { createStore, useStore } from "../lib/store";
import { countText, deriveTags, deriveTitle, normalizeEol, splitFrontMatter, stripMarkdown, uid } from "../lib/utils";
// 附件目录的**唯一产地**（`<目录>/<笔记名>.assets/`）。这里只 import，绝不自己再写一遍
// 派生规则 —— 剪藏接收端（`src/lib/clip/receive.ts`）用的是同一个函数，两个产地会漂移。
// 同理，引用文本的写法（带空格时要写成 `<…>`）也只从 `markdownRef` 来。
import { assetsDirFor, markdownRef } from "../lib/clip/landing";
import { desktopBridge } from "../desktop/bridge";
import { listOptionalDirectory, readOptionalText } from "./optionalFiles";
import type { Folder, FolderChoice, Id, Note, SidebarTab, Snapshot, SnapshotReason, SortKey } from "./types";
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
  /** UI bits that belong to this notebook rather than to this machine (D27). */
  ui?: { sidebarTab: SidebarTab };
  /**
   * 手动改过的显示名（`renameNote`），按笔记路径存。
   *
   * 为什么必须存在这里：`Note.title` 是**派生字段** —— `makeNote()` / `refresh()` 都拿
   * `deriveTitle(正文, 文件名)` 现算（正文里第一个标题赢，文件名只是兜底）。用户实测
   * （0.5.0）：「重命名完成后，再点击其他地方，文件名又会恢复，或者直接就不修改」——
   * 就是只写了内存里的 `title`，随后任何一次 `refresh()`（在编辑器里打字）或
   * `rescanWorkspace()`（桌面端文件监听、Ctrl+S、外部改动都会触发）把它算了回去。
   *
   * 「重命名只改显示名；正文里的一级标题不会被改写」（重命名对话框的原话）要成立，
   * 新名字就得是**这一态的真源**：写进 `state.json`，重扫时挂回 `Note.titleOverride`，
   * 键跟着笔记走（重命名 / 移动 / 进回收站 / 恢复）。
   */
  titleOverrides?: Record<Id, string>;
}

const defaultMeta: WorkspaceMeta = { version: 1, starred: [], expanded: [], lastOpened: null };

/** `state.json` 里的 `titleOverrides`：只留「非空字符串 → 非空字符串」，别的一律丢掉。 */
function readTitleOverrides(value: unknown): Record<Id, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<Id, string> = {};
  for (const [path, title] of Object.entries(value as Record<string, unknown>)) {
    if (path && typeof title === "string" && title) out[path] = title;
  }
  return Object.keys(out).length ? out : null;
}

const SIDEBAR_TABS: SidebarTab[] = ["files", "search", "tags", "starred"];

function isSidebarTab(value: unknown): value is SidebarTab {
  return typeof value === "string" && (SIDEBAR_TABS as string[]).includes(value);
}

let backend: FileSystemBackend | null = null;
let meta: WorkspaceMeta = { ...defaultMeta };
let metaTimer: ReturnType<typeof setTimeout> | null = null;
const writeTimers = new Map<Id, ReturnType<typeof setTimeout>>();
const pendingWrites = new Map<Id, Promise<void>>();
const lastSnapshotAt = new Map<Id, number>();
/** Snapshot file names handed out this session, so two clicks in one millisecond differ (D14). */
const snapshotNames = new Map<Id, Set<string>>();
/** Notes whose last snapshot write failed: the next edit retries instead of waiting 3 min (D22). */
const snapshotFailures = new Set<Id>();
/** In-flight snapshot writes; `flushAll` waits for them so closing cannot drop one (D22). */
const pendingSnapshots = new Set<Promise<void>>();
const SNAPSHOT_INTERVAL = 3 * 60_000;
const SNAPSHOT_KEEP = 60;
/** Per-note memory of handed-out names; the on-disk check still catches recycled ones. */
const SNAPSHOT_NAME_MEMORY = 200;
/** Backend calls a workspace scan keeps in flight — the walk used to be one IPC call at a time (D25). */
const SCAN_CONCURRENCY = 12;

/** Bumped by every open/close: a slow scan must never publish into a newer workspace (D02). */
let generation = 0;
/** Last stamp we know for a file on disk; a mismatch means somebody else edited it (D08). */
const knownStats = new Map<Id, { size: number; mtimeMs: number }>();
/** In-flight create preflights. Writes wait for them, so a late clash cannot clobber a file (D03). */
const createGuards = new Map<Id, Promise<void>>();
/** Raised while reading a broken state file, surfaced once the workspace state has settled (D10). */
let metaWarning: string | null = null;

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
    // 手动改过显示名的笔记（`renameNote`）不被正文的 H1 顶回去；没改过的照旧由正文派生。
    title: note.titleOverride ?? deriveTitle(text, stripExtension(baseName(note.id))),
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
  /** On-disk stamps per note id, seeded into `knownStats` by open/rescan (D08). */
  stamps: Record<Id, { size: number; mtimeMs: number }>;
}

/**
 * A broken state file used to be silently replaced with defaults (D10). Keep the
 * original bytes next to it so nothing is unrecoverable.
 */
async function backupCorruptState(target: FileSystemBackend, raw: string): Promise<string> {
  const backup = `${STATE_FILE}.corrupt-${Date.now()}`;
  try {
    await target.writeText(backup, raw);
  } catch (error) {
    console.warn("[opennote] 无法备份损坏的状态文件", error);
  }
  return backup;
}

async function readMeta(target: FileSystemBackend): Promise<WorkspaceMeta> {
  let raw: string | undefined;
  try {
    raw = await readOptionalText(target, STATE_FILE);
  } catch (error) {
    // A state file that cannot be read (locked, EACCES, a directory in its
    // place) must not take the whole notebook down with it (D26).
    console.warn("[opennote] 无法读取笔记本状态文件", error);
    metaWarning = "状态文件无法读取，本次使用默认状态";
    return { ...defaultMeta };
  }
  if (raw === undefined) return { ...defaultMeta };
  try {
    const parsed = JSON.parse(raw) as Partial<WorkspaceMeta>;
    const sidebarTab = parsed.ui?.sidebarTab;
    const titleOverrides = readTitleOverrides(parsed.titleOverrides);
    return {
      version: 1,
      starred: Array.isArray(parsed.starred) ? parsed.starred.map(String) : [],
      expanded: Array.isArray(parsed.expanded) ? parsed.expanded.map(String) : [],
      lastOpened: parsed.lastOpened ? String(parsed.lastOpened) : null,
      ...(isSidebarTab(sidebarTab) ? { ui: { sidebarTab } } : {}),
      ...(titleOverrides ? { titleOverrides } : {}),
    };
  } catch (error) {
    const backup = await backupCorruptState(target, raw);
    metaWarning = `原文件已备份为 ${backup}，本次使用默认状态`;
    console.warn("[opennote] 笔记本状态文件无法解析", backup, error);
    return { ...defaultMeta };
  }
}

/** One directory of a scan; `entries` keeps the order `list()` returned. */
interface ScanDir {
  path: string;
  inTrash: boolean;
  entries: EntryInfo[];
  listed: boolean;
}

/** Run `work` over `items` with at most `limit` calls in flight (D25). */
async function forEachLimited<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      if (index >= items.length) return;
      cursor += 1;
      await work(items[index]);
    }
  });
  await Promise.all(workers);
}

/**
 * Read the folder on disk into memory. Directories are discovered level by
 * level and notes are read afterwards, both with a bounded number of backend
 * calls in flight: the old walk awaited every `list()` and `readText()` before
 * issuing the next one, i.e. one IPC round trip per file (D25). The published
 * records are still emitted in the same depth-first order as before, and a
 * directory or note that cannot be read is still skipped with a warning.
 */
export async function scanWorkspace(target: FileSystemBackend): Promise<ScanResult> {
  const notes: Record<Id, Note> = {};
  const folders: Record<Id, Folder> = {};
  const trash: Record<Id, Note> = {};
  const stamps: Record<Id, { size: number; mtimeMs: number }> = {};
  let files = 0;
  let bytes = 0;

  const children = new Map<Id, ScanDir>();
  const root: ScanDir = { path: "", inTrash: false, entries: [], listed: false };

  const listDir = async (node: ScanDir): Promise<void> => {
    try {
      node.entries = await target.list(node.path);
      node.listed = true;
    } catch (error) {
      console.warn("[opennote] 无法读取目录", node.path || "/", error);
    }
  };

  // Phase 1: discover the tree. Each wave lists its directories concurrently.
  const discover = async (start: ScanDir): Promise<void> => {
    let wave: ScanDir[] = [start];
    while (wave.length) {
      await forEachLimited(wave, SCAN_CONCURRENCY, listDir);
      const next: ScanDir[] = [];
      for (const node of wave) {
        if (!node.listed) continue;
        for (const entry of node.entries) {
          if (entry.kind !== "directory") continue;
          const path = joinPath(node.path, entry.name);
          // 附件目录不是「文件夹」：公共 `assets/` 与**按笔记名派生**的 `<笔记名>.assets/`
          // 都只是图片的家，出现在左栏里会把用户的目录树弄脏（`foo.assets` 不是他建的目录）。
          // **这条规则的镜像在 `electron/main.cjs` 的 `listWorkspaceFoldersForClip()`**
          // （剪藏页的落点候选也必须是「真的文件夹」）—— 改一处就要改两处。
          if (
            !node.inTrash &&
            (isHiddenPath(path) ||
              entry.name === ASSETS_DIR ||
              entry.name.endsWith(".assets") ||
              entry.name === "node_modules" ||
              entry.name === "dist" ||
              entry.name === "release")
          ) {
            continue;
          }
          const child: ScanDir = { path, inTrash: node.inTrash, entries: [], listed: false };
          children.set(path, child);
          next.push(child);
        }
      }
      wave = next;
    }
  };

  await discover(root);
  // The trash keeps whatever layout it was given, so it is walked on its own —
  // after the main tree, exactly like the recursive walk it replaces.
  let trashRoot: ScanDir | null = null;
  if (await target.exists(TRASH_DIR)) {
    trashRoot = { path: TRASH_DIR, inTrash: true, entries: [], listed: false };
    children.set(TRASH_DIR, trashRoot);
    await discover(trashRoot);
  }

  // Phase 2: read every markdown file, again with bounded concurrency.
  const pending: { path: Id; size: number; mtimeMs: number }[] = [];
  for (const node of [root, ...children.values()]) {
    if (!node.listed) continue;
    for (const entry of node.entries) {
      if (entry.kind !== "file") continue;
      const path = joinPath(node.path, entry.name);
      if (!isMarkdownPath(path)) continue;
      pending.push({ path, size: entry.size, mtimeMs: entry.mtimeMs });
    }
  }
  const contents = new Map<Id, string>();
  await forEachLimited(pending, SCAN_CONCURRENCY, async (item) => {
    try {
      contents.set(item.path, await target.readText(item.path));
    } catch (error) {
      console.warn("[opennote] 无法读取笔记", item.path, error);
    }
  });

  // Phase 3: publish in depth-first order, without touching the backend again.
  const emit = (node: ScanDir): void => {
    if (!node.listed) return;
    for (const entry of node.entries) {
      const path = joinPath(node.path, entry.name);
      if (entry.kind === "directory") {
        const child = children.get(path);
        if (!child) continue;
        if (!node.inTrash) folders[path] = makeFolder(path, entry.mtimeMs);
        emit(child);
        continue;
      }
      if (!isMarkdownPath(path)) continue;
      const content = contents.get(path);
      if (content === undefined) continue;
      files += 1;
      bytes += entry.size || content.length;
      const note = makeNote(path, content, entry.mtimeMs, { trashed: node.inTrash });
      stamps[path] = { size: entry.size || content.length, mtimeMs: entry.mtimeMs || note.updatedAt };
      if (node.inTrash) trash[path] = note;
      else notes[path] = note;
    }
  };
  emit(root);
  if (trashRoot) emit(trashRoot);

  const workspaceMeta = await readMeta(target);
  for (const path of workspaceMeta.starred) {
    if (notes[path]) notes[path] = { ...notes[path], starred: true };
  }
  /*
   * 手动改过的显示名挂回去 —— 这一步就是「重命名之后重扫，名字不许被正文 H1 顶回去」的落点。
   *
   * 这里**不**顺手清理「路径已经不在扫描结果里」的条目：一次与 move 擦肩而过的重扫
   * （桌面端文件监听 / OPFS 的非原子 move）可能短暂看不到文件，那会把用户刚改的名字静静丢掉。
   * 真正确定删除的路径由 `purgeNote` / `emptyTrash` / 删文件夹负责清账。
   */
  const overrides = workspaceMeta.titleOverrides;
  if (overrides) {
    for (const [path, title] of Object.entries(overrides)) {
      const note = notes[path] ?? trash[path];
      if (!note) continue;
      const pinned = { ...note, titleOverride: title, title };
      if (notes[path]) notes[path] = pinned;
      else trash[path] = pinned;
    }
  }
  return { notes, folders, trash, meta: workspaceMeta, files, bytes, stamps };
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

/** Remember what the notes looked like on disk, so a later save can spot an external edit. */
function applyStamps(stamps: ScanResult["stamps"]): void {
  knownStats.clear();
  for (const [id, stamp] of Object.entries(stamps)) knownStats.set(id, stamp);
}

/** Surface a warning collected while scanning, once the new state is in place (D10). */
function flushMetaWarning(): void {
  if (!metaWarning) return;
  const warning = metaWarning;
  metaWarning = null;
  reportError(new Error(warning), "笔记本状态文件损坏");
}

export async function openWorkspace(
  record: WorkspaceRecord,
  options: { silent?: boolean; requestPermission?: boolean } = {},
): Promise<void> {
  const myGen = ++generation;
  // The notebook being replaced must not deliver change notifications into the
  // next one (a failed open leaves no watcher behind either) — see D02/D08.
  stopWatching();
  setState((prev) => ({ ...prev, loading: true, error: null }));
  // The notebook that is being replaced is only abandoned once its edits are on
  // disk; a failure before that point must not throw them away.
  let flushed = false;
  try {
    await flushAll();
    await flushMeta();
    flushed = true;
    const resolved = await resolveBackend(record, options.requestPermission ?? false);
    const scanned = await scanWorkspace(resolved);
    // A newer open/close won the race: dropping this result beats publishing a
    // stale tree (and later writing its notes into the wrong folder) — see D02.
    if (myGen !== generation) return;
    backend = resolved;
    // The throttle keys are note paths, and the same path in another notebook
    // is a different note, so nothing may carry over (D22).
    resetWorkspaceTransients();
    meta = scanned.meta;
    applyStamps(scanned.stamps);
    invalidateSearchCache();
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
    patchUi({
      expanded: meta.expanded,
      tabs: [],
      activeId: null,
      ...(meta.ui ? { sidebarTab: meta.ui.sidebarTab } : {}),
    });
    const last = meta.lastOpened && scanned.notes[meta.lastOpened] ? meta.lastOpened : null;
    if (last) openNote(last);
    if (!options.silent) {
      await ensureWorkspaceScaffold(resolved);
    }
    flushMetaWarning();
    startWatching(record.location);
  } catch (error) {
    if (myGen === generation) {
      stopWatching();
      if (flushed) {
        // A failed open must not leave a live backend behind a "no notebook"
        // UI: the next keystroke would land in a folder nobody can see (D26).
        backend = null;
        meta = { ...defaultMeta };
        knownStats.clear();
        resetWorkspaceTransients();
        invalidateSearchCache();
        setState(() => ({
          ...emptyState,
          ready: true,
          error: error instanceof Error ? error.message : "无法打开笔记本",
        }));
      } else {
        setState((prev) => ({ ...prev, loading: false, ready: true }));
      }
    }
    throw error;
  }
}

/** Drop everything that only means something while one notebook is open (D22/D26). */
function resetWorkspaceTransients(): void {
  lastSnapshotAt.clear();
  snapshotNames.clear();
  snapshotFailures.clear();
  createGuards.clear();
  for (const timer of writeTimers.values()) clearTimeout(timer);
  writeTimers.clear();
}

/** Make sure the workspace has the folders the notebook expects. */
async function ensureWorkspaceScaffold(target: FileSystemBackend): Promise<void> {
  await target.mkdir(ASSETS_DIR).catch(() => undefined);
  await target.mkdir(META_DIR).catch(() => undefined);
}

/* ------------------------------------------------------------------ watching */

/**
 * D08, second half: the main process watches the workspace folder and tells us
 * when something changed outside the app (editor, sync client, git). Its own
 * debounce is 450ms, so this layer only waits for the writes to settle before
 * reading — two layers, not a chain of them.
 */
const WATCH_DEBOUNCE_MS = 500;

/** Unsubscribe function of the current `fs.onWorkspaceChanged` listener. */
let watchUnsubscribe: (() => void) | null = null;
/** Absolute root we are currently watching; also filters foreign events. */
let watchedRoot: string | null = null;
/** Pending debounce timer for a change notification. */
let watchTimer: ReturnType<typeof setTimeout> | null = null;
/** A rescan is in flight; further notifications only ask for one trailing pass. */
let watchRescanRunning = false;
let watchRescanQueued = false;

/** The main process reports absolute paths; Windows/macOS compare case-insensitively. */
function sameRoot(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return normalize(a) === normalize(b);
}

/**
 * Subscribe to external changes of `root` and ask the main process to watch the
 * folder. Older preloads and the browser fallback have no such API, so this is a
 * silent no-op there (D08 must not change the startup path).
 */
function startWatching(root: string): void {
  stopWatching();
  const bridge = desktopBridge();
  const fs = bridge?.fs;
  if (typeof fs?.watchWorkspace !== "function" || typeof fs.onWorkspaceChanged !== "function") return;
  watchedRoot = root;
  watchUnsubscribe = fs.onWorkspaceChanged((changed) => {
    // The event is broadcast to every window: ignore other notebooks.
    if (!sameRoot(changed, watchedRoot)) return;
    scheduleWatchRescan();
  });
  void fs.watchWorkspace(root).catch((error) => {
    console.warn("[opennote] 无法监听工作区变化", error);
  });
}

/** Drop the listener, the pending rescan and the main-process watcher. */
function stopWatching(): void {
  if (watchTimer) {
    clearTimeout(watchTimer);
    watchTimer = null;
  }
  // A trailing pass that was queued for a notebook we just left is meaningless.
  watchRescanQueued = false;
  const unsubscribe = watchUnsubscribe;
  watchUnsubscribe = null;
  if (unsubscribe) {
    try {
      unsubscribe();
    } catch (error) {
      console.warn("[opennote] 退订工作区变更失败", error);
    }
  }
  const root = watchedRoot;
  watchedRoot = null;
  if (!root) return;
  const bridge = desktopBridge();
  if (typeof bridge?.fs?.unwatchWorkspace !== "function") return;
  void bridge.fs.unwatchWorkspace(root).catch((error) => {
    console.warn("[opennote] 取消监听工作区失败", error);
  });
}

function scheduleWatchRescan(): void {
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    watchTimer = null;
    void runWatchRescan();
  }, WATCH_DEBOUNCE_MS);
  watchTimer.unref?.();
}

/**
 * A sync client can touch hundreds of files in a second. Only one rescan runs at
 * a time; everything that arrives meanwhile collapses into a single trailing
 * pass, so a storm never queues up a backlog of scans.
 */
async function runWatchRescan(): Promise<void> {
  if (watchRescanRunning) {
    watchRescanQueued = true;
    return;
  }
  watchRescanRunning = true;
  try {
    do {
      watchRescanQueued = false;
      await rescanWorkspace();
    } while (watchRescanQueued);
  } catch (error) {
    console.warn("[opennote] 重扫工作区失败", error);
  } finally {
    watchRescanRunning = false;
  }
}

export async function closeWorkspace(): Promise<void> {
  generation += 1;
  // Leaving the notebook: no late notification may rescan into it (D02/D08).
  stopWatching();
  await flushAll();
  await flushMeta();
  backend = null;
  meta = { ...defaultMeta };
  knownStats.clear();
  // Snapshot throttling is per notebook, so closing releases the table (D22).
  resetWorkspaceTransients();
  invalidateSearchCache();
  libraryStore.set({ ...emptyState, ready: true });
}

/** Re-read the folder from disk (after an import, or when files changed outside). */
export async function rescanWorkspace(): Promise<void> {
  const target = backend;
  if (!target) return;
  const myGen = generation;
  // A broken state file is reported after the new state is published; a conflict
  // notice raised while flushing below must survive this rescan as well (D08).
  const errorBefore = libraryStore.get().error;
  // Everything that is still only in memory when the scan starts. `flushAll()`
  // writes it, but a scan that raced with a slow write can still read the older
  // bytes, so these ids are compared against the scan before publishing (D01/D08).
  const dirtyBefore = new Set(Object.keys(libraryStore.get().dirty));
  await flushAll();
  if (myGen !== generation || target !== backend) return;
  const scanned = await scanWorkspace(target);
  if (myGen !== generation || target !== backend) return;
  meta = { ...scanned.meta, expanded: getUi().expanded, lastOpened: getUi().activeId ?? scanned.meta.lastOpened };
  applyStamps(scanned.stamps);
  invalidateSearchCache();
  const keptDirty: Id[] = [];
  setState((prev) => {
    const notes = { ...scanned.notes };
    const dirty: Record<Id, true> = {};
    for (const id of new Set([...Object.keys(prev.dirty), ...dirtyBefore])) {
      const disk = notes[id];
      // The file is gone (deleted or moved outside): a dirty key could never be
      // flushed again, so it is dropped like before.
      if (!disk) continue;
      const local = prev.notes[id];
      // Disk is at least as new as memory: nothing to protect.
      if (!local || local.content === disk.content) continue;
      // The scan read bytes older than what the user has typed: keep the local
      // text (and its title/tags) so a rescan never reverts an open editor, and
      // keep the key dirty so the next flush writes it.
      notes[id] = {
        ...disk,
        content: local.content,
        title: local.title,
        titleOverride: local.titleOverride,
        tags: local.tags,
        words: local.words,
        chars: local.chars,
        updatedAt: local.updatedAt,
        starred: local.starred || disk.starred,
      };
      dirty[id] = true;
      keptDirty.push(id);
    }
    const error = prev.error && prev.error !== errorBefore ? prev.error : null;
    return {
      ...prev,
      notes,
      folders: scanned.folders,
      trash: scanned.trash,
      dirty,
      error,
      stats: { files: scanned.files, bytes: scanned.bytes },
    };
  });
  // A kept note whose write already finished has no timer left: arm one so the
  // "unsaved" marker clears by itself instead of staying forever.
  for (const id of keptDirty) if (!writeTimers.has(id)) persistNoteSoon(id, 300);
  reconcileTabs();
  flushMetaWarning();
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

function markDirty(id: Id): void {
  setState((prev) => ({ ...prev, dirty: { ...prev.dirty, [id]: true } }));
}

/**
 * The first candidate path that neither memory nor the backend reports as taken.
 * `ignore` is the path the caller is moving away from: on a case-insensitive
 * disk `exists()` still answers true for its own case-variant (D07/D30).
 */
export async function resolveAvailablePath(
  target: FileSystemBackend,
  requested: string,
  taken: Set<string>,
  ignore?: Id,
): Promise<string> {
  const ignored = ignore?.toLowerCase();
  let candidate = requested;
  let guard = 0;
  while ((await target.exists(candidate)) && candidate.toLowerCase() !== ignored) {
    taken.add(candidate);
    candidate = uniquePath(requested, taken);
    guard += 1;
    if (guard > 500) break;
  }
  return candidate;
}

/**
 * Keep the disk version of a file that was changed behind our back; the caller
 * then writes the in-memory version, so both survive (D08).
 */
async function preserveConflictCopy(target: FileSystemBackend, id: Id): Promise<string> {
  const content = await target.readText(id);
  const dir = parentPath(id);
  const ext = extName(id) || ".md";
  const base = baseName(stripExtension(id));
  const stamp = formatStamp(Date.now()).replace(/[: ]/g, "-");
  const taken = new Set<string>();
  const path = await resolveAvailablePath(target, joinPath(dir, `${base}.conflict-${stamp}${ext}`), taken);
  await target.writeText(path, content);
  return path;
}

async function flushNote(id: Id): Promise<void> {
  const timer = writeTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    writeTimers.delete(id);
  }
  // A brand-new note waits for its name preflight: writing before it settles is
  // exactly how an existing file used to get emptied (D03).
  const gate = createGuards.get(id);
  if (gate) await gate.catch(() => undefined);
  // 回收站里的笔记就地编辑：落盘路径相同（`.opennote/trash/…`），只是条目住在另一个桶。
  const note = libraryStore.get().notes[id] ?? libraryStore.get().trash[id];
  const target = backend;
  if (!note || !target) {
    await pendingWrites.get(id);
    return;
  }
  const prior = pendingWrites.get(id);
  const write = (prior?.catch(() => undefined) ?? Promise.resolve()).then(async () => {
    const known = knownStats.get(id);
    const current = await target.stat(id).catch(() => null);
    if (known && current && (current.mtimeMs !== known.mtimeMs || current.size !== known.size)) {
      const onDisk = await target.readText(id).catch(() => null);
      if (onDisk === null || normalizeEol(onDisk) !== note.content) {
        const copy = await preserveConflictCopy(target, id);
        reportError(
          new Error(`磁盘上的文件在应用外被修改，原内容已保留为 ${copy}`),
          "检测到外部修改",
        );
      }
    }
    await target.writeText(id, note.content);
    const after = await target.stat(id).catch(() => null);
    if (after) knownStats.set(id, after);
    else knownStats.delete(id);
  });
  pendingWrites.set(id, write);
  try {
    await write;
    if (backend === target && (libraryStore.get().notes[id] ?? libraryStore.get().trash[id])?.content === note.content) markClean(id);
  } catch (error) {
    reportError(error, "写入笔记失败");
    throw error;
  } finally {
    if (pendingWrites.get(id) === write) pendingWrites.delete(id);
  }
}

function persistNoteSoon(id: Id, delay = 450): void {
  const existing = writeTimers.get(id);
  if (existing) clearTimeout(existing);
  writeTimers.set(id, setTimeout(() => { void flushNote(id).catch(() => undefined); }, delay));
}

export async function flushAll(): Promise<void> {
  if (createGuards.size) await Promise.allSettled([...createGuards.values()]);
  const ids = new Set([...writeTimers.keys(), ...Object.keys(libraryStore.get().dirty)]);
  await Promise.all([...ids].map((id) => flushNote(id)));
  await Promise.all([...pendingWrites.values()]);
  // History counts as "written": a snapshot that is still on its way must not be
  // left behind by a close, and a rename must not move the directory it writes into (D22).
  if (pendingSnapshots.size) await Promise.allSettled([...pendingSnapshots.values()]);
}

function scheduleMeta(delay = 700): void {
  if (metaTimer) clearTimeout(metaTimer);
  metaTimer = setTimeout(() => { void flushMeta(); }, delay);
}

/**
 * D10: 元数据（`.opennote/state.json`）落盘。
 *
 * 三种后端的 `writeText` 本身就已经是「先写临时文件、再覆盖目标」：
 * node 走主进程的 tmp+rename，fsa/opfs 走 `writeFileSafely`。所以一次 `writeText`
 * 就等价于过去 tmp + move 的加固，而且**没有**「目标已删掉、新内容还没就位」的窗口。
 *
 * 这里曾经写成「写 tmp → move(tmp, state.json)，失败再 remove + move」：所有后端的
 * `move` 都不覆盖已存在的目标（见 FileSystemBackend.move 契约），于是第二次起的那次
 * move 是**注定失败**的。渲染层 catch 得住，但 Electron 会为每个被拒绝的
 * `ipcMain.handle` 打印一条错误 —— 每次元数据落盘都在控制台刷一条
 * `Error occurred in handler for 'opennote:fs:move': 目标路径已存在：.opennote/state.json`，
 * 真正的故障被淹没。别再拿一次注定失败的调用当探测手段。
 */
async function writeStateFile(target: FileSystemBackend, contents: string): Promise<void> {
  await target.writeText(STATE_FILE, contents);
  // 清掉旧方案（tmp + move）可能在磁盘上留下的临时文件；缺失时静默忽略。
  await target.remove(`${STATE_FILE}.tmp`).catch(() => undefined);
}

export async function flushMeta(): Promise<void> {
  if (metaTimer) {
    clearTimeout(metaTimer);
    metaTimer = null;
  }
  const target = backend;
  if (!target) return;
  const contents = `${JSON.stringify(meta, null, 2)}\n`;
  try {
    await writeStateFile(target, contents);
  } catch (error) {
    reportError(error, "写入笔记本元数据失败");
  }
}

/** Notes first, metadata second, never a floating rejection (D11). */
export async function flushForClose(): Promise<void> {
  try {
    await flushAll();
  } catch (error) {
    console.warn("[opennote] 关闭前仍有笔记没有写入磁盘", error);
  }
  try {
    await flushMeta();
  } catch (error) {
    console.warn("[opennote] 关闭前元数据写入失败", error);
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    void flushForClose();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushForClose();
  });
}

/* --------------------------------------------------------------------- notes */

export function createNote(options: { folderId?: Id | null; content?: string; title?: string | null; open?: boolean } = {}): Note {
  const target = backend;
  const folderId = options.folderId ?? null;
  const title = options.title ?? "无标题";
  const fileName = `${sanitizeName(title, "无标题")}.md`;
  const taken = new Set(Object.keys(libraryStore.get().notes));
  const path = target ? uniquePath(joinPath(folderId ?? "", fileName), taken) : fileName;
  const content = options.content ?? "";
  const note = makeNote(path, content, Date.now());
  patchNotes((notes) => ({ ...notes, [note.id]: note }));
  markDirty(note.id);
  if (folderId) expandFolder(folderId);
  if (options.open !== false) openNote(note.id);
  if (target) preflightCreateNote(target, note.id);
  else void flushNote(note.id).catch(() => undefined);
  return note;
}

/**
 * Names are reserved in memory first and then re-checked against the disk. A
 * file that appeared after the last scan (external editor, sync client, git)
 * must never be emptied by a new note that happens to share its name (D03/D30).
 */
function preflightCreateNote(target: FileSystemBackend, id: Id): void {
  const taken = new Set(Object.keys(libraryStore.get().notes));
  let settle!: () => void;
  const gate = new Promise<void>((resolve) => { settle = resolve; });
  createGuards.set(id, gate);
  void (async () => {
    let free = id;
    try {
      if (backend === target) {
        free = await resolveAvailablePath(target, id, taken);
        if (free !== id) remapIds(id, free);
      }
    } catch (error) {
      reportError(error, "新建笔记失败");
    } finally {
      // Release the gate before the write, otherwise flushNote() would await itself.
      createGuards.delete(id);
      settle();
    }
    if (backend === target) await flushNote(free).catch(() => undefined);
  })();
}

function replaceExpandedId(oldId: Id, newId: Id): void {
  const ui = getUi();
  if (!ui.expanded.includes(oldId)) return;
  patchUi({ expanded: [...new Set(ui.expanded.map((id) => (id === oldId ? newId : id)))] });
}

export function updateNoteContent(id: Id, content: string, options: { immediate?: boolean } = {}): void {
  const state = libraryStore.get();
  // 回收站里的笔记就地编辑：内容写回**它自己的桶**（文件仍在 `.opennote/trash/…`），
  // 恢复时照旧只是把文件搬回去 —— 编辑不会因为「在回收站里」而丢。
  const inTrash = Boolean(state.trash[id]);
  const previous = state.notes[id] ?? state.trash[id];
  if (!previous || previous.content === normalizeEol(content)) return;
  const next = refresh(previous, content);
  next.updatedAt = Date.now();
  if (inTrash) setState((prev) => ({ ...prev, trash: { ...prev.trash, [id]: next } }));
  else patchNotes((notes) => ({ ...notes, [id]: next }));
  markDirty(id);
  invalidateSearchCache(id);
  if (options.immediate) void flushNote(id).catch(() => undefined);
  else persistNoteSoon(id);
  maybeSnapshot(previous, next);
}

/** Case-only rename: away to a hidden temp name and back (D07). */
async function moveCaseOnly(target: FileSystemBackend, id: Id, nextPath: Id): Promise<void> {
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const temp = joinPath(parentPath(id), `.opennote-tmp-${token}${extName(id)}`);
  await target.move(id, temp);
  try {
    await target.move(temp, nextPath);
  } catch (error) {
    await target.move(temp, id).catch(() => undefined);
    throw error;
  }
}

/**
 * Snapshot directories are keyed by the note's path, so a rename/move has to
 * take the directory along: otherwise the history is orphaned and a brand-new
 * note that reuses the old name inherits it — including a "restore" that would
 * paste somebody else's text into the new note (D15).
 *
 * Never throws: a rename that succeeded on disk must not be reported as failed
 * because its history could not follow.
 */
async function moveHistory(target: FileSystemBackend, oldId: Id, newId: Id): Promise<void> {
  const from = joinPath(HISTORY_DIR, oldId);
  const to = joinPath(HISTORY_DIR, newId);
  if (from === to) return;
  try {
    if (!(await target.exists(from))) return;
    // A case-only rename points at the very same directory on a case-insensitive
    // disk, where `exists(to)` answers true for the source itself (D07).
    const caseOnly = from.toLowerCase() === to.toLowerCase();
    if (!caseOnly && (await target.exists(to))) {
      await mergeHistory(target, from, to);
      return;
    }
    await target.mkdir(parentPath(to)).catch(() => undefined);
    await target.move(from, to);
  } catch (error) {
    console.warn("[opennote] 历史快照未能跟随移动", oldId, error);
  }
}

/** Two history directories for one path (an older layout left one behind): keep both. */
async function mergeHistory(target: FileSystemBackend, from: Id, to: Id): Promise<void> {
  const entries = await listOptionalDirectory(target, from);
  const taken = new Set((await listOptionalDirectory(target, to)).map((entry) => entry.name));
  for (const entry of entries) {
    const name = uniquePath(entry.name, taken, { foldCase: true });
    taken.add(name);
    await target.move(joinPath(from, entry.name), joinPath(to, name)).catch(() => undefined);
  }
  await target.remove(from, { recursive: true }).catch(() => undefined);
}

/**
 * 把「手动改过的显示名」写进笔记本状态（`.opennote/state.json`）—— 这条路的**唯一真源**。
 *
 * `Note.title` 是派生字段（`makeNote()` / `refresh()` 都拿 `deriveTitle(正文, 文件名)` 现算），
 * 只写内存会被下一次 `refresh()`（在编辑器里打字）或 `rescanWorkspace()`（文件监听 / Ctrl+S）
 * 算回去 —— 用户实测的「重命名完成后，再点击其他地方，文件名又会恢复」就是这个。
 */
function setTitleOverride(id: Id, title: string | null): void {
  const next: Record<Id, string> = { ...(meta.titleOverrides ?? {}) };
  if (title) next[id] = title;
  else delete next[id];
  const keys = Object.keys(next);
  meta = { ...meta, titleOverrides: keys.length ? next : undefined };
  scheduleMeta(200);
}

/** 显示名的键跟着文件走：重命名 / 移动走 `remapIds()`，进回收站与恢复这两条不走。 */
function moveTitleOverride(from: Id, to: Id): void {
  const title = meta.titleOverrides?.[from];
  if (!title) return;
  const next: Record<Id, string> = { ...meta.titleOverrides };
  delete next[from];
  next[to] = title;
  meta = { ...meta, titleOverrides: next };
  scheduleMeta(400);
}

/** 文件真的没了：把它的显示名一起清账（删文件夹 / 彻底删除 / 清空回收站）。 */
function dropTitleOverrides(within: (path: Id) => boolean): void {
  if (!meta.titleOverrides) return;
  const next: Record<Id, string> = {};
  for (const [path, title] of Object.entries(meta.titleOverrides)) {
    if (!within(path)) next[path] = title;
  }
  meta = { ...meta, titleOverrides: Object.keys(next).length ? next : undefined };
  scheduleMeta(400);
}

export async function renameNote(id: Id, title: string): Promise<void> {
  const note = libraryStore.get().notes[id];
  const target = backend;
  if (!note || !target) return;
  const clean = sanitizeName(title, "无标题");
  const requested = joinPath(parentPath(id), `${clean}${extName(id) || ".md"}`);
  if (requested === id) return;
  // Only the casing changes: a temp-name round trip is what every backend
  // accepts on a case-insensitive disk, while uniquePath() would hand back
  // "名字 2.md" because exists() still sees the file itself (D07).
  const caseOnly = requested.toLowerCase() === id.toLowerCase();
  const taken = new Set(Object.keys(libraryStore.get().notes));
  taken.delete(id);
  try {
    await flushNote(id);
    const nextPath = caseOnly ? requested : await resolveAvailablePath(target, requested, taken, id);
    if (caseOnly) await moveCaseOnly(target, id, nextPath);
    else await target.move(id, nextPath);
    remapIds(id, nextPath);
    await moveHistory(target, id, nextPath);
    // 新名字**同时**写进 `Note.titleOverride` 与笔记本状态：只写 `title` 会被下一次
    // `refresh()` / 重扫按正文 H1 算回去（用户实测：改完名再点别处又变回去）。
    patchNotes((notes) => ({
      ...notes,
      [nextPath]: { ...notes[nextPath], title: clean, titleOverride: clean, updatedAt: Date.now() },
    }));
    setTitleOverride(nextPath, clean);
    // 立刻落盘，别等 200ms 去抖：重命名一返回，**随后任何一次重扫**都必须读到这条记录
    // （桌面端文件监听是 500ms 去抖，但不能指望每个触发源都比去抖慢 —— Ctrl+S 就能随时重扫）。
    await flushMeta();
  } catch (error) {
    reportError(error, "重命名失败");
  }
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

/**
 * The sidebar tab is real state: it lives in the local UI settings and travels
 * with the notebook's state.json (D27).
 */
export function setSidebarTab(tab: SidebarTab): void {
  if (!isSidebarTab(tab)) return;
  if (getUi().sidebarTab !== tab) patchUi({ sidebarTab: tab });
  meta = { ...meta, ui: { ...(meta.ui ?? {}), sidebarTab: tab } };
  scheduleMeta();
}

/**
 * `moveNote()` 的结果。
 *
 * 为什么不是 `void`：搬一篇笔记有**两件事**可能各自成败 —— 笔记文件搬没搬成，以及
 * 按笔记名派生的附件目录有没有跟着搬。第二件失败时笔记已经在新位置了，正文里的
 * `./笔记名.assets/x.png` 会指到别处（或者指空），**而界面上没有任何东西说这件事**。
 * 所以把结果交回调用方，由它决定说什么；拖放那些不看结果的调用方仍然可以忽略它。
 */
export interface MoveNoteResult {
  /** 笔记移动后的实际路径；失败、空操作、或路径其实没变时为 `null`。 */
  path: Id | null;
  /** 笔记已就位、但附件目录没能跟过来的原因（有值 = 必须如实告诉用户）。 */
  assetsWarning: string | null;
}

const NO_MOVE: MoveNoteResult = { path: null, assetsWarning: null };

export async function moveNote(id: Id, folderId: Id | null): Promise<MoveNoteResult> {
  const note = libraryStore.get().notes[id];
  const target = backend;
  if (!note || !target || (note.folderId ?? null) === folderId) return NO_MOVE;
  const taken = new Set(Object.keys(libraryStore.get().notes));
  taken.delete(id);
  const requested = joinPath(folderId ?? "", baseName(id));
  try {
    await flushNote(id);
    const nextPath = await resolveAvailablePath(target, requested, taken, id);
    // Same file, only the folder name differs in casing: it is already there.
    if (nextPath.toLowerCase() === id.toLowerCase()) return NO_MOVE;
    await target.move(id, nextPath);
    remapIds(id, nextPath);
    await moveHistory(target, id, nextPath);
    // 换目录就是换路径 ⇒ 派生附件目录必须跟着换（否则单篇笔记挪走后正文引用指空）。
    const assetsWarning = await moveNoteAssets(target, id, nextPath);
    return { path: nextPath, assetsWarning };
  } catch (error) {
    reportError(error, "移动笔记失败");
    return NO_MOVE;
  }
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

/**
 * 图片跟笔记走（用户原话「从收件箱移动到其他位置时，图片位置也应改变」）。
 *
 * 剪藏落盘的笔记把附件放在**按笔记名派生**的 `<笔记名>.assets/` 里，所以「笔记换到哪条路径」
 * 就决定了「附件应该在哪条路径」——搬笔记时**必须**把附件目录一起搬，否则正文里的
 * `./foo.assets/x.png` 就指空（图丢了，而且不报错）。
 *
 * 两个方向都要走同一条派生规则（`assetsDirFor`，唯一产地）：
 *   入回收站：`assetsDirFor(笔记原路径)` → `assetsDirFor(回收站路径)`
 *   恢复/移动：`assetsDirFor(来源路径)` → `assetsDirFor(目标路径)`
 *
 * 目标已存在 → **绝不静默覆盖**（那是丢图的第二种写法）：如实报告，把原目录留在原地。
 * 返回值就是那句报告（`null` = 没有异常）；调用方决定它在界面上怎么出现。
 */
async function moveNoteAssets(target: FileSystemBackend, fromNote: Id, toNote: Id): Promise<string | null> {
  const from = assetsDirFor(fromNote);
  const to = assetsDirFor(toNote);
  if (from === to) return null;
  if (!(await target.exists(from))) return null;
  if (await target.exists(to)) {
    const message = `图片目录已存在，未覆盖：${to}`;
    reportError(new Error(message), "图片未随笔记移动");
    return message;
  }
  await target.move(from, to);
  return null;
}

export async function trashNote(id: Id): Promise<void> {
  const note = libraryStore.get().notes[id];
  const target = backend;
  if (!note || !target) return;
  const requested = joinPath(TRASH_DIR, id);
  const taken = new Set(Object.keys(libraryStore.get().trash));
  try {
    await flushNote(id);
    const trashPath = await resolveAvailablePath(target, requested, taken, id);
    await target.move(id, trashPath);
    await moveHistory(target, id, trashPath);
    // 附件目录随笔记进回收站：留着它就会变成「删了再恢复，图丢了」（或在 trash 里留孤儿）。
    await moveNoteAssets(target, id, trashPath);
    // 显示名的键跟到回收站路径下：重扫时回收站里的这一条也要保持用户改过的名字。
    moveTitleOverride(id, trashPath);
    const current = libraryStore.get().notes[id] ?? note;
    setState((prev) => {
      const notes = { ...prev.notes };
      delete notes[id];
      return {
        ...prev,
        notes,
        trash: { ...prev.trash, [trashPath]: { ...current, id: trashPath, trashed: true, trashedAt: Date.now() } },
      };
    });
    closeTab(id);
  } catch (error) {
    reportError(error, "移入回收站失败");
  }
}

export async function restoreNote(id: Id): Promise<void> {
  const note = libraryStore.get().trash[id];
  const target = backend;
  if (!note || !target) return;
  const original = id.startsWith(`${TRASH_DIR}/`) ? id.slice(TRASH_DIR.length + 1) : baseName(id);
  const taken = new Set(Object.keys(libraryStore.get().notes));
  try {
    await flushAll();
    const nextPath = await resolveAvailablePath(target, original, taken, id);
    await target.move(id, nextPath);
    await moveHistory(target, id, nextPath);
    const sourceAssets = joinPath(parentPath(id), ASSETS_DIR);
    const restoredAssets = joinPath(parentPath(nextPath), ASSETS_DIR);
    if (await target.exists(sourceAssets) && !(await target.exists(restoredAssets))) {
      await target.move(sourceAssets, restoredAssets);
    }
    // 派生附件目录（`<笔记名>.assets/`）按**恢复后的最终路径**搬回来。
    // 必须用 `nextPath` 而不是 `id`：`id` 还在回收站前缀下，派生出来的目录会指错地方
    // （“方向反了”就是这一条：两个方向用了同一个基准，等于一个方向都没修）。
    await moveNoteAssets(target, id, nextPath);
    // 恢复后的路径可能带序号（`第一章 2.md`）：显示名的键跟着落到最终路径上。
    moveTitleOverride(id, nextPath);
    setState((prev) => {
      const trash = { ...prev.trash };
      delete trash[id];
      return {
        ...prev,
        trash,
        notes: { ...prev.notes, [nextPath]: { ...note, id: nextPath, folderId: parentPath(nextPath) || null, trashed: false, trashedAt: null } },
      };
    });
    // Rebuild every ancestor folder node, otherwise a restore into a folder
    // that only existed inside the trash is invisible in the tree (D09).
    for (const ancestor of ancestorPaths(nextPath)) {
      const known = libraryStore.get().folders[ancestor];
      if (!known) patchFolders((folders) => ({ ...folders, [ancestor]: makeFolder(ancestor, Date.now()) }));
      expandFolder(ancestor);
    }
    // 这篇笔记正开着时，标签跟着文件走：回收站里打开、恢复后仍停在编辑器里
    //（条目 id 变了 = 标签里的旧 id 失效，App 会把它当成「没有这篇笔记」而清掉 active）。
    const ui = getUi();
    if (ui.tabs.includes(id)) {
      patchUi({
        tabs: ui.tabs.map((tab) => (tab === id ? nextPath : tab)),
        activeId: ui.activeId === id ? nextPath : ui.activeId,
        lastNoteId: ui.lastNoteId === id ? nextPath : ui.lastNoteId,
      });
    }
  } catch (error) {
    reportError(error, "恢复失败");
    await rescanWorkspace().catch(() => undefined);
  }
}

/** `a/b/c.md` → ["a", "a/b"] */
function ancestorPaths(path: Id): Id[] {
  const out: Id[] = [];
  let current = parentPath(path);
  while (current) {
    out.unshift(current);
    current = parentPath(current);
  }
  return out;
}

/** Notes still living in (or trashed from) `dir`, so a purge keeps their images (D16). */
function otherNoteInFolder(dir: Id, except: Id): boolean {
  const state = libraryStore.get();
  const inside = (path: Id) => (dir ? path.startsWith(`${dir}/`) : true);
  for (const note of [...Object.values(state.notes), ...Object.values(state.trash)]) {
    if (note.id === except) continue;
    if ((note.folderId ?? "") === dir) return true;
    // A trashed note keeps the path it came from; it may be restored later.
    if (inside(note.id) || inside(note.id.slice(`${TRASH_DIR}/`.length))) return true;
  }
  return false;
}

/**
 * Snapshots and the note's own `assets/` folder used to outlive the note (D16).
 * A shared `assets/` folder is only dropped when no other note lives there —
 * images in it may belong to the siblings that are still around.
 */
async function removeNoteArtifacts(target: FileSystemBackend, id: Id): Promise<void> {
  const history = joinPath(HISTORY_DIR, id);
  if (await target.exists(history)) await target.remove(history, { recursive: true });
  // 派生附件目录是**这一篇笔记自己的**（按笔记名派生），所以没有兄弟笔记共用的问题：
  // 笔记被真删了，它就必须一起消失，否则回收站里永远留着孤儿图片。
  const own = assetsDirFor(id);
  if (await target.exists(own)) await target.remove(own, { recursive: true });
  const folders = new Set<Id>([parentPath(id)]);
  // A trashed note keeps the path it came from, and its images stay there.
  if (id.startsWith(`${TRASH_DIR}/`)) folders.add(parentPath(id.slice(TRASH_DIR.length + 1)));
  for (const dir of folders) {
    const assets = joinPath(dir, ASSETS_DIR);
    if (!(await target.exists(assets))) continue;
    if (otherNoteInFolder(dir, id)) continue;
    await target.remove(assets, { recursive: true });
  }
}

export async function purgeNote(id: Id): Promise<void> {
  const target = backend;
  if (!target) return;
  try {
    await target.remove(id, { recursive: true });
    await removeNoteArtifacts(target, id);
    dropTitleOverrides((path) => path === id);
    setState((prev) => {
      const trash = { ...prev.trash };
      delete trash[id];
      return { ...prev, trash };
    });
  } catch (error) {
    reportError(error, "删除失败");
  }
}

export async function emptyTrash(): Promise<number> {
  const target = backend;
  if (!target) return 0;
  const ids = Object.keys(libraryStore.get().trash);
  const count = ids.length;
  try {
    for (const id of ids) await removeNoteArtifacts(target, id);
    if (await target.exists(TRASH_DIR)) await target.remove(TRASH_DIR, { recursive: true });
    dropTitleOverrides((path) => path === TRASH_DIR || path.startsWith(`${TRASH_DIR}/`));
    setState((prev) => ({ ...prev, trash: {} }));
    return count;
  } catch (error) {
    reportError(error, "清空回收站失败");
    return 0;
  }
}

/* ------------------------------------------------------------------- folders */

export function createFolder(name: string, parentId: Id | null = null): Folder {
  const folderName = sanitizeName(name, "新文件夹");
  const requested = joinPath(parentId ?? "", folderName);
  const taken = new Set(Object.keys(libraryStore.get().folders));
  const path = uniquePath(requested, taken);
  const folder: Folder = {
    id: path,
    name: baseName(path),
    parentId: parentId ?? null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  patchFolders((folders) => ({ ...folders, [path]: folder }));
  expandFolder(path);
  const target = backend;
  if (target) preflightCreateFolder(target, folder, requested, taken);
  return folder;
}

/** A folder that only differs in casing from one on disk must not be created twice (D30). */
function preflightCreateFolder(target: FileSystemBackend, folder: Folder, requested: string, taken: Set<string>): void {
  const id = folder.id;
  let settle!: () => void;
  const gate = new Promise<void>((resolve) => { settle = resolve; });
  createGuards.set(id, gate);
  void (async () => {
    let path = id;
    try {
      if (backend === target) {
        path = await resolveAvailablePath(target, requested, taken);
        if (path !== id) {
          remapIds(id, path, { prefix: true });
          replaceExpandedId(id, path);
          // Callers keep the object they got back; let them see the final id.
          folder.id = path;
          folder.name = baseName(path);
        }
      }
    } catch (error) {
      reportError(error, "新建文件夹失败");
    } finally {
      createGuards.delete(id);
      settle();
    }
    if (backend !== target) return;
    try {
      await target.mkdir(path);
    } catch (error) {
      reportError(error, "新建文件夹失败");
      rollbackFolder(target, path);
    }
  })();
}

/**
 * The folder node was published before the disk was asked to create it; if that
 * fails the node has to go, otherwise the tree shows a folder that does not
 * exist and every note "inside" it keeps failing to write (D26).
 */
function rollbackFolder(target: FileSystemBackend, path: Id): void {
  if (backend !== target) return;
  const index = folderIndexOf(getLibrary());
  // Anything the user managed to put inside in the meantime keeps the node alive.
  if (index.notesByFolder.get(path)?.length) return;
  if (index.childFolders.get(path)?.length) return;
  patchFolders((folders) => {
    if (!folders[path]) return folders;
    const next = { ...folders };
    delete next[path];
    return next;
  });
  patchUi({ expanded: getUi().expanded.filter((id) => id !== path) });
}

export async function renameFolder(id: Id, name: string): Promise<void> {
  const folder = libraryStore.get().folders[id];
  const target = backend;
  if (!folder || !target) return;
  const clean = sanitizeName(name, "文件夹");
  const nextPath = joinPath(parentPath(id), clean);
  if (nextPath === id) return;
  const caseOnly = nextPath.toLowerCase() === id.toLowerCase();
  try {
    if (!caseOnly && (await target.exists(nextPath))) throw new Error(`目标文件夹已存在：${nextPath}`);
    await flushAll();
    if (caseOnly) await moveCaseOnly(target, id, nextPath);
    else await target.move(id, nextPath);
    remapIds(id, nextPath, { prefix: true });
    // One directory move carries the history of every note below it (D15).
    await moveHistory(target, id, nextPath);
  } catch (error) {
    reportError(error, "重命名文件夹失败");
  }
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
  const folder = libraryStore.get().folders[id];
  const target = backend;
  if (!folder || !target) return;
  const within = (path: Id): boolean => path === id || path.startsWith(`${id}/`);
  try {
    await flushAll();
    if (mode === "trash") {
      const requested = joinPath(TRASH_DIR, id);
      const taken = new Set<string>();
      const trashPath = await resolveAvailablePath(target, requested, taken);
      // Move the entire directory, including nested notes and their assets,
      // before touching the in-memory tree. No recursive delete follows this.
      await target.move(id, trashPath);
      await moveHistory(target, id, trashPath);
      meta = {
        ...meta,
        starred: meta.starred.filter((path) => !within(path)),
        expanded: meta.expanded.filter((path) => !within(path)),
        lastOpened: meta.lastOpened && within(meta.lastOpened) ? null : meta.lastOpened,
      };
      // Text typed while the directory was moving still belongs to these notes:
      // let their ids follow the files into the trash, so the pending flush
      // lands in the trashed copy instead of being rolled back by the rescan (D01).
      for (const noteId of Object.keys(libraryStore.get().notes)) {
        if (!within(noteId)) continue;
        remapIds(noteId, `${trashPath}${noteId.slice(id.length)}`);
      }
    } else {
      const parent = folder.parentId ?? "";
      const entries = await target.list(id);
      // Preflight every destination so assets/ and markdown relative links keep
      // their names. A conflict leaves the original directory untouched.
      for (const entry of entries) {
        if (await target.exists(joinPath(parent, entry.name))) {
          throw new Error(`上级目录已有同名文件或文件夹：${entry.name}`);
        }
      }
      for (const entry of entries) {
        const source = joinPath(id, entry.name);
        const destination = joinPath(parent, entry.name);
        await target.move(source, destination);
        remapIds(source, destination, { prefix: entry.kind === "directory" });
        await moveHistory(target, source, destination);
      }
      // Everything moved out, so the now-empty directory must go recursively:
      // `recursive: false` throws ERR_FS_EISDIR on the desktop backend (D06).
      await target.remove(id, { recursive: true });
      meta = { ...meta, expanded: meta.expanded.filter((path) => !within(path)) };
    }
    patchUi({ expanded: getUi().expanded.filter((path) => !within(path)) });
    await flushMeta();
    await rescanWorkspace();
  } catch (error) {
    reportError(error, "删除文件夹失败");
    await rescanWorkspace().catch(() => undefined);
  }
}

export async function moveFolder(id: Id, parentId: Id | null): Promise<void> {
  const folder = libraryStore.get().folders[id];
  const target = backend;
  if (!folder || !target || (folder.parentId ?? null) === (parentId ?? null)) return;
  if (parentId && (parentId === id || isDescendant(parentId, id))) return;
  const nextPath = joinPath(parentId ?? "", baseName(id));
  try {
    // A folder name that already exists under a different casing is the same
    // directory on a case-insensitive disk: silently "moving" into it is what
    // produced two ids pointing at one folder (D30).
    if (nextPath.toLowerCase() !== id.toLowerCase() && (await target.exists(nextPath))) {
      throw new Error(`目标文件夹已存在：${nextPath}`);
    }
    await flushAll();
    if (nextPath.toLowerCase() === id.toLowerCase()) return;
    await target.move(id, nextPath);
    remapIds(id, nextPath, { prefix: true });
    await moveHistory(target, id, nextPath);
    if (parentId) expandFolder(parentId);
  } catch (error) {
    reportError(error, "移动文件夹失败");
  }
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

/**
 * 文件夹树的**拍平**形态，给「移动到…」选择器用。
 *
 * 顺序与左栏文件树**逐字一致**（深度优先、同层按名字 `localeCompare`）：选择器里第 n 项
 * 和文件树里第 n 行指向同一个目录。两份各自排序的实现迟早会漂移，用户看到的就是
 * 「树里在上、选择器里在下」——所以这里复用 `childFolders()`（同一份排序）而不是再排一次。
 *
 * `currentFolderId` 那一项标成 `disabled`：把笔记移到它已经在的目录是一次空操作，
 * 与其让用户白点一次、再由数据层静默 return，不如在界面上就说「你已经在这儿了」。
 */
export function folderChoiceList(currentFolderId: Id | null, state = libraryStore.get()): FolderChoice[] {
  const out: FolderChoice[] = [];
  const walk = (parentId: Id | null, depth: number): void => {
    for (const folder of childFolders(state, parentId)) {
      out.push({
        id: folder.id,
        label: folder.name,
        path: folder.id,
        depth,
        disabled: folder.id === currentFolderId,
      });
      // 循环父链会让这里无限递归；`folderPath` 有 64 层护栏，这里也按同一个上限截断。
      if (depth < 64) walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return [
    { id: null, label: "笔记本根目录", path: "", depth: 0, disabled: currentFolderId === null },
    ...out,
  ];
}

/**
 * 「移动到…」选择器树形视图的一个节点：候选项 + 它的孩子。
 *
 * 界面层（`Overlays.tsx` 的 `FolderDialog`）拿它画可折叠的树；
 * 数据层只负责把拍平的候选挂回去，不做任何界面决定。
 */
export interface FolderChoiceNode {
  choice: FolderChoice;
  children: FolderChoiceNode[];
}

/**
 * 把 `folderChoiceList()` 的**拍平 DFS 序**按 `depth` 挂回树形。
 *
 * 为什么不从 `folders` 直接重建：候选列表里那些选择器专属的语义（根目录项、
 * 「置灰当前目录」）唯一的产地是 `folderChoiceList()`，树形只是同一份候选的另一种摆法
 * —— 从拍平结果重建，两边才不会各长各的。`depth` 在产出侧是逐层 +1 的（见上），
 * 所以一个按深度弹栈的扫描就足以还原父子。
 */
export function folderChoiceTree(choices: FolderChoice[]): FolderChoiceNode[] {
  const roots: FolderChoiceNode[] = [];
  const stack: FolderChoiceNode[] = [];
  for (const choice of choices) {
    const node: FolderChoiceNode = { choice, children: [] };
    while (stack.length && stack[stack.length - 1].choice.depth >= choice.depth) stack.pop();
    (stack.length ? stack[stack.length - 1].children : roots).push(node);
    stack.push(node);
  }
  return roots;
}

/**
 * 从根到 `id`（含）的**祖先链**。
 *
 * 给选择器在打开时把选中项沿途的分支全部展开：目标藏在收起的分支里，
 * 用户就看不见「我现在选的到底是哪」。
 */
export function folderChoiceTrail(choices: FolderChoice[], id: Id | null): FolderChoice[] {
  const stack: FolderChoice[] = [];
  for (const choice of choices) {
    while (stack.length && stack[stack.length - 1].depth >= choice.depth) stack.pop();
    stack.push(choice);
    if (choice.id === id) return [...stack];
  }
  return [];
}

/** Move the keys of an id-keyed map along with a rename/move. */
function remapKeyed<V>(map: Map<Id, V>, replace: (id: Id) => Id): void {
  for (const [key, value] of [...map]) {
    const id = replace(key);
    if (id === key) continue;
    map.delete(key);
    map.set(id, value);
  }
}

/** Rewrite every id that starts with (or equals) `oldId` after a rename/move. */
function remapIds(oldId: Id, newId: Id, options: { prefix?: boolean } = {}): void {
  const replace = (value: Id): Id =>
    value === oldId ? newId : options.prefix && value.startsWith(`${oldId}/`) ? `${newId}${value.slice(oldId.length)}` : value;

  patchNotes((notes) => {
    const next: Record<Id, Note> = {};
    for (const [key, note] of Object.entries(notes)) {
      const id = replace(key);
      next[id] = { ...note, id, folderId: parentPath(id) || null };
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
  // Edits typed while the operation was in flight are keyed by the old id: they
  // must follow their note, or the text is silently dropped and `dirty` keeps a
  // ghost key forever (D01).
  const movedDirty: [Id, Id][] = [];
  setState((prev) => {
    const trash: Record<Id, Note> = {};
    for (const [key, note] of Object.entries(prev.trash)) trash[replace(key)] = note;
    const dirty: Record<Id, true> = {};
    for (const [key, value] of Object.entries(prev.dirty)) {
      const id = replace(key);
      if (id !== key) movedDirty.push([key, id]);
      dirty[id] = value;
    }
    return { ...prev, trash, dirty };
  });
  for (const [from, to] of movedDirty) {
    const timer = writeTimers.get(from);
    if (timer) {
      clearTimeout(timer);
      writeTimers.delete(from);
    }
    persistNoteSoon(to, 200);
  }
  remapKeyed(plainCache, replace);
  remapKeyed(knownStats, replace);
  remapKeyed(lastSnapshotAt, replace);
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
    // 显示名的键也要跟着走，否则移动/重命名之后那条改名记录就指空、重扫时名字又变回正文 H1。
    titleOverrides: meta.titleOverrides
      ? Object.fromEntries(Object.entries(meta.titleOverrides).map(([path, title]) => [replace(path), title]))
      : undefined,
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
  // 回收站里的笔记也能「正常打开」（0.3.4 用户：「回收站其实它也只是一个普通的目录，
  // 就让这个文件正常一样打开就行，也不用给只读」）：它在 `library.trash` 里、
  // 路径仍是 `.opennote/trash/…`，打开的只是**这个文件**，不是把它恢复成普通笔记。
  const note = libraryStore.get().notes[id] ?? libraryStore.get().trash[id];
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

/* -------------------------------------------------------------- folder index */

/**
 * One `Map<folderId, Note[]>` per state object, built on first use (D25).
 *
 * The sidebar asks for every folder's notes and counters on every render, and
 * each of those used to walk all notes and rebuild the descendant list. The
 * cache is keyed by the state object itself: every mutation publishes a fresh
 * object (see `patchNotes`/`patchFolders`), so a stale index is impossible and
 * a superseded one is simply collected.
 */
interface FolderIndex {
  all: Note[];
  childFolders: Map<Id | null, Folder[]>;
  notesByFolder: Map<Id | null, Note[]>;
  totals: Map<Id, { notes: number; folders: number }>;
  scope: Map<Id, Set<Id>>;
  scopedNotes: Map<Id, Note[]>;
}

const folderIndexCache = new WeakMap<LibraryState, FolderIndex>();

function folderIndexOf(state: LibraryState): FolderIndex {
  const cached = folderIndexCache.get(state);
  if (cached) return cached;
  const all = Object.values(state.notes);
  const folders = Object.values(state.folders);
  const childFolders = new Map<Id | null, Folder[]>();
  for (const folder of folders) {
    const key = folder.parentId ?? null;
    const siblings = childFolders.get(key);
    if (siblings) siblings.push(folder);
    else childFolders.set(key, [folder]);
  }
  for (const siblings of childFolders.values()) {
    siblings.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  }
  const notesByFolder = new Map<Id | null, Note[]>();
  for (const note of all) {
    const key = note.folderId ?? null;
    const list = notesByFolder.get(key);
    if (list) list.push(note);
    else notesByFolder.set(key, [note]);
  }
  // A single bottom-up pass gives every folder its descendant note/folder
  // counts, so `folderStats` becomes a lookup instead of a walk per folder.
  const totals = new Map<Id, { notes: number; folders: number }>();
  const visiting = new Set<Id>();
  const visit = (id: Id): { notes: number; folders: number } => {
    const known = totals.get(id);
    if (known) return known;
    // A parentId cycle would recurse forever; cut it at the closing edge.
    if (visiting.has(id)) return { notes: 0, folders: 0 };
    visiting.add(id);
    let notes = (notesByFolder.get(id) ?? []).length;
    let below = 0;
    for (const child of childFolders.get(id) ?? []) {
      const nested = visit(child.id);
      notes += nested.notes;
      below += 1 + nested.folders;
    }
    visiting.delete(id);
    const total = { notes, folders: below };
    totals.set(id, total);
    return total;
  };
  for (const folder of folders) visit(folder.id);
  const index: FolderIndex = { all, childFolders, notesByFolder, totals, scope: new Map(), scopedNotes: new Map() };
  folderIndexCache.set(state, index);
  return index;
}

/** `folderId` plus every folder below it, built once per state and folder. */
function scopeOf(index: FolderIndex, folderId: Id): Set<Id> {
  const cached = index.scope.get(folderId);
  if (cached) return cached;
  const scope = new Set<Id>([folderId]);
  const stack: Id[] = [folderId];
  while (stack.length) {
    const current = stack.pop() as Id;
    for (const child of index.childFolders.get(current) ?? []) {
      if (scope.has(child.id)) continue;
      scope.add(child.id);
      stack.push(child.id);
    }
  }
  index.scope.set(folderId, scope);
  return scope;
}

export function notesInFolder(
  state: LibraryState,
  folderId: Id | null | undefined,
  options: { descendants?: boolean; sort?: SortKey; includeTrashed?: boolean } = {},
): Note[] {
  const { descendants = false, sort = "updated", includeTrashed = false } = options;
  if (includeTrashed) return sortNotes(Object.values(state.trash), sort);
  const index = folderIndexOf(state);
  if (folderId === undefined) return sortNotes(index.all, sort);
  if (!descendants || folderId === null) {
    return sortNotes(index.notesByFolder.get(folderId ?? null) ?? [], sort);
  }
  let scoped = index.scopedNotes.get(folderId);
  if (!scoped) {
    const scope = scopeOf(index, folderId);
    scoped = index.all.filter((note) => note.folderId !== null && scope.has(note.folderId));
    index.scopedNotes.set(folderId, scoped);
  }
  return sortNotes(scoped, sort);
}

export function childFolders(state: LibraryState, parentId: Id | null): Folder[] {
  return [...(folderIndexOf(state).childFolders.get(parentId ?? null) ?? [])];
}

export function folderStats(state: LibraryState, folderId: Id): { notes: number; folders: number } {
  const total = folderIndexOf(state).totals.get(folderId);
  return total ? { notes: total.notes, folders: total.folders } : { notes: 0, folders: 0 };
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
/** Bound the body cache so a huge notebook cannot grow it without limit (D05). */
const PLAIN_CACHE_LIMIT = 400;

function plainOf(note: Note): string {
  const cached = plainCache.get(note.id);
  if (cached !== undefined) return cached;
  const text = stripMarkdown(note.content).toLowerCase();
  plainCache.set(note.id, text);
  while (plainCache.size > PLAIN_CACHE_LIMIT) {
    const oldest = plainCache.keys().next();
    if (oldest.done) break;
    plainCache.delete(oldest.value);
  }
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

/**
 * Milliseconds, not minutes: `formatStamp` stops at the minute, so two manual
 * snapshots inside the same minute used to share one name and the second one
 * silently replaced the first (D14).
 */
function snapshotStamp(at: number): string {
  const date = new Date(at);
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  );
}

/**
 * Reserve a file name before writing it. The session-level set covers two
 * clicks inside the same millisecond; the `exists()` loop in `writeSnapshot`
 * covers a name an earlier session (or another process) already took.
 */
function reserveSnapshotName(noteId: Id, reason: SnapshotReason): string {
  const used = snapshotNames.get(noteId) ?? new Set<string>();
  snapshotNames.set(noteId, used);
  const name = uniquePath(`${snapshotStamp(Date.now()).replace(/[: ]/g, "-")}-${reason}.md`, used, { foldCase: true });
  used.add(name);
  if (used.size > SNAPSHOT_NAME_MEMORY) {
    used.clear();
    used.add(name);
  }
  return name;
}

/** `false` means nothing reached the disk, so the caller can retry later (D22). */
async function writeSnapshot(
  noteId: Id,
  content: string,
  reason: SnapshotReason,
  options: { quiet?: boolean } = {},
): Promise<boolean> {
  const target = backend;
  if (!target) return false;
  const dir = joinPath(HISTORY_DIR, noteId);
  let file = joinPath(dir, reserveSnapshotName(noteId, reason));
  try {
    let guard = 0;
    while (await target.exists(file)) {
      file = joinPath(dir, reserveSnapshotName(noteId, reason));
      guard += 1;
      if (guard > 20) break;
    }
    await target.writeText(file, content);
    await pruneSnapshots(noteId);
    return true;
  } catch (error) {
    // One toast per failing streak beats one per keystroke; the failure stays
    // visible in the console either way (D22).
    if (options.quiet) console.warn("[opennote] 快照仍未能写入", noteId, error);
    else reportError(error, "记录历史版本失败");
    return false;
  }
}

/**
 * Auto snapshots are throttled per note, but the throttle may only start once a
 * snapshot is really on disk: a failed write used to block retries for three
 * minutes, and the table used to survive a notebook switch, where the same note
 * path means a different note (D22).
 */
function maybeSnapshot(previous: Note, next: Note): void {
  const ui = getUi();
  if (!ui.snapshots || !backend) return;
  if (previous.content.trim() === next.content.trim()) return;
  const noteId = next.id;
  const failing = snapshotFailures.has(noteId);
  if (!failing && Date.now() - (lastSnapshotAt.get(noteId) ?? 0) < SNAPSHOT_INTERVAL) return;
  const work = writeSnapshot(noteId, previous.content, "auto", { quiet: failing })
    .then((ok) => {
      if (ok) {
        lastSnapshotAt.set(noteId, Date.now());
        snapshotFailures.delete(noteId);
      } else {
        snapshotFailures.add(noteId);
      }
    })
    .catch(() => undefined);
  pendingSnapshots.add(work);
  void work.then(() => pendingSnapshots.delete(work));
}

async function pruneSnapshots(noteId: Id): Promise<void> {
  const target = backend;
  if (!target) return;
  const dir = joinPath(HISTORY_DIR, noteId);
  const entries = await listOptionalDirectory(target, dir);
  const files = entries.filter((entry) => entry.kind === "file").sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of files.slice(SNAPSHOT_KEEP)) {
    await target.remove(joinPath(dir, entry.name)).catch(() => undefined);
  }
}

export async function listSnapshots(noteId: Id): Promise<Snapshot[]> {
  const target = backend;
  if (!target) return [];
  const dir = joinPath(HISTORY_DIR, noteId);
  let entries;
  try {
    entries = await listOptionalDirectory(target, dir);
  } catch (error) {
    reportError(error, "读取历史版本失败");
    return [];
  }
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
  const ok = await writeSnapshot(noteId, note.content, "manual");
  // The three-minute throttle starts after the file exists, not before (D22).
  if (ok) {
    lastSnapshotAt.set(noteId, Date.now());
    snapshotFailures.delete(noteId);
  } else {
    snapshotFailures.add(noteId);
  }
}

export async function restoreSnapshot(snapshot: Snapshot): Promise<void> {
  const note = libraryStore.get().notes[snapshot.noteId];
  if (!note) return;
  await writeSnapshot(note.id, note.content, "restore");
  updateNoteContent(note.id, snapshot.content, { immediate: true });
}

/* ------------------------------------------------------- images & uploads */

/**
 * Persist an image next to the note and return the markdown-ready relative path.
 *
 * 第三参是**最终笔记路径**（`归档/foo 2.md`），不是笔记所在目录 —— 附件目录按笔记名派生
 * （`assetsDirFor`：`归档/foo 2.md` → `归档/foo 2.assets/`），这样「只把一篇笔记挪走」
 * 时图片跟着走，不依赖任何搬迁代码记得搬。旧数据不迁移：老笔记的图仍在公共
 * `<目录>/assets/` 里，正文照旧引用 `./assets/x.png`，照样能读。
 */
export async function saveImage(
  blob: Blob,
  suggestedName: string,
  notePath: string,
): Promise<{ path: string; markdown: string }> {
  /*
   * 守卫：第三参必须是**笔记文件路径**，不是笔记所在目录。
   *
   * 为什么需要它：这两个参数的**类型都是 `string`**，TypeScript 一个字都拦不住 ——
   * 调用方仍旧传目录时（`assetsDirFor("")` → `未命名.assets/`）编译通过、类型检查通过、
   * 单测也可能照样绿，只有用户会发现图片跑去了一个莫名其妙的目录。
   * 这类「静默接错来源」正是本轮 P0 的根因形态（`body: payload.body` 那次）。
   * 所以把一个**语义**约束写成一条**运行期**断言：错了就大声报，绝不猜。
   */
  if (!isMarkdownPath(notePath)) {
    throw new Error(`saveImage 的第三参必须是笔记路径（如 归档/foo.md），收到的是「${notePath || "(空)"}」`);
  }
  const target = requireBackend();
  const dir = assetsDirFor(notePath);
  const existing = await listOptionalDirectory(target, dir);
  const taken = new Set(existing.map((entry) => entry.name));
  const name = uniquePath(sanitizeName(suggestedName, `图片-${Date.now()}.png`), taken);
  const path = joinPath(dir, name);
  await target.writeBytes(path, blob);
  // 引用里的目录名从**同一个派生结果**现取，别在这里再拼一次 `<笔记名>.assets`。
  // 目标串再过一次 `markdownRef`（唯一产地）：笔记名带空格时（`备注 2.md`、`无标题 2.md`）
  // 目录名也带空格，裸写会被**空格截断** —— 图片不渲染，而且不报错。
  return { path, markdown: markdownRef(`./${baseName(dir)}/${name}`) };
}

/* ------------------------------------------------------------------ bootstrap */

/** Seed a brand-new workspace with the welcome note (awaits the disk write). */
export async function seedWelcome(content: string, title = "欢迎来到 Opennote"): Promise<Note> {
  const note = createNote({ folderId: null, content, title });
  await flushNote(note.id);
  return note;
}

export { uid, formatStamp };
