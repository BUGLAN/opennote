import { createStore, useStore } from "../lib/store";
import {
  countText,
  deriveTags,
  deriveTitle,
  normalizeEol,
  splitFrontMatter,
  stripMarkdown,
  uid,
} from "../lib/utils";
import * as repo from "./db";
import { requestPersistence } from "./db";
import type { Folder, Id, Note, Snapshot, SnapshotReason, SortKey } from "./types";
import { getUi, patchUi } from "./ui";
import { WELCOME_CONTENT } from "./welcome";

export interface LibraryState {
  ready: boolean;
  notes: Record<Id, Note>;
  folders: Record<Id, Folder>;
  error: string | null;
  /** Ids whose content was edited this session (drives the "dirty" dot). */
  dirty: Record<Id, true>;
  lastSavedAt: number | null;
}

export const libraryStore = createStore<LibraryState>({
  ready: false,
  notes: {},
  folders: {},
  error: null,
  dirty: {},
  lastSavedAt: null,
});

export function useLibrary(): LibraryState {
  return useStore(libraryStore);
}

export function getLibrary(): LibraryState {
  return libraryStore.get();
}

/* ------------------------------------------------------------------ helpers */

function buildNote(content: string, folderId: Id | null, titleOverride: string | null = null): Note {
  const now = Date.now();
  const text = normalizeEol(content);
  const title = titleOverride?.trim() || deriveTitle(text);
  const counts = countText(text);
  return {
    id: uid(),
    folderId,
    title,
    titleOverride,
    content: text,
    createdAt: now,
    updatedAt: now,
    openedAt: now,
    starred: false,
    tags: deriveTags(text),
    chars: counts.chars,
    words: counts.words,
    trashed: false,
    trashedAt: null,
  };
}

function rehydrate(note: Note, content: string): Note {
  const text = normalizeEol(content);
  const counts = countText(text);
  return {
    ...note,
    content: text,
    title: note.titleOverride?.trim() || deriveTitle(text),
    tags: deriveTags(text),
    chars: counts.chars,
    words: counts.words,
  };
}

/** Search runs over plain text; cache it per note and invalidate on write. */
const plainCache = new Map<Id, string>();

function plainOf(note: Note): string {
  const cached = plainCache.get(note.id);
  if (cached !== undefined) return cached;
  const text = stripMarkdown(note.content).toLowerCase();
  plainCache.set(note.id, text);
  return text;
}

function setNotes(updater: (notes: Record<Id, Note>) => Record<Id, Note>): void {
  libraryStore.set((prev) => ({ ...prev, notes: updater(prev.notes) }));
}

function setFolders(updater: (folders: Record<Id, Folder>) => Record<Id, Folder>): void {
  libraryStore.set((prev) => ({ ...prev, folders: updater(prev.folders) }));
}

/* --------------------------------------------------------------------- init */

let seededFolders: Id[] = [];
let initPromise: Promise<void> | null = null;

/** Idempotent: React StrictMode mounts twice in development. */
export function initLibrary(): Promise<void> {
  if (!initPromise) initPromise = openLibrary();
  return initPromise;
}

async function openLibrary(): Promise<void> {
  try {
    const [notes, folders] = await Promise.all([repo.readAllNotes(), repo.readAllFolders()]);
    const noteMap: Record<Id, Note> = {};
    for (const note of notes) noteMap[note.id] = note;
    const folderMap: Record<Id, Folder> = {};
    for (const folder of folders) folderMap[folder.id] = folder;

    if (notes.length === 0 && folders.length === 0) {
      const welcome = seed();
      noteMap[welcome.note.id] = welcome.note;
      for (const folder of welcome.folders) folderMap[folder.id] = folder;
      await repo.writeNotes([welcome.note]);
      await repo.writeFolders(welcome.folders);
      libraryStore.set({
        ready: true,
        notes: noteMap,
        folders: folderMap,
        error: null,
        dirty: {},
        lastSavedAt: Date.now(),
      });
      void requestPersistence();
      return;
    }

    libraryStore.set({
      ready: true,
      notes: noteMap,
      folders: folderMap,
      error: null,
      dirty: {},
      lastSavedAt: Date.now(),
    });
    void requestPersistence();
  } catch (error) {
    console.error("[opennote] 数据库打开失败", error);
    libraryStore.set((prev) => ({
      ...prev,
      ready: true,
      error: "无法打开本地数据库：浏览器可能禁用了 IndexedDB（隐私模式？）。本次会话的改动不会被保存。",
    }));
  }
}

function seed(): { note: Note; folders: Folder[] } {
  const now = Date.now();
  const make = (name: string, parentId: Id | null): Folder => ({
    id: uid(),
    name,
    parentId,
    createdAt: now,
    updatedAt: now,
  });
  const inbox = make("随笔", null);
  const project = make("项目", null);
  seededFolders = [inbox.id, project.id];
  const note = buildNote(WELCOME_CONTENT, inbox.id);
  return { note, folders: [inbox, project] };
}

export function seededFolderIds(): Id[] {
  return seededFolders;
}

/* -------------------------------------------------------------------- notes */

export function createNote(options: {
  folderId?: Id | null;
  content?: string;
  title?: string | null;
  open?: boolean;
} = {}): Note {
  const folderId = options.folderId === undefined ? null : options.folderId;
  const note = buildNote(options.content ?? `# ${options.title ?? "无标题"}\n\n`, folderId, options.title ?? null);
  setNotes((notes) => ({ ...notes, [note.id]: note }));
  void repo.writeNote(note).catch(reportWriteError);
  if (options.open !== false) openNote(note.id);
  return note;
}

const writeTimers = new Map<Id, ReturnType<typeof setTimeout>>();

function reportWriteError(error: unknown): void {
  console.error("[opennote] 写入失败", error);
  libraryStore.set((prev) => ({ ...prev, error: "写入本地数据库失败，请检查浏览器存储空间。" }));
}

/** Persist a note now. */
function flushNote(id: Id): void {
  const note = libraryStore.get().notes[id];
  if (!note) return;
  const timer = writeTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    writeTimers.delete(id);
  }
  repo
    .writeNote(note)
    .then(() => {
      libraryStore.set((prev) => {
        const dirty = { ...prev.dirty };
        delete dirty[id];
        return { ...prev, dirty, lastSavedAt: Date.now() };
      });
    })
    .catch(reportWriteError);
}

/** Coalesce rapid keystrokes into one IndexedDB write. */
function persistNoteSoon(id: Id, delay = 350): void {
  const existing = writeTimers.get(id);
  if (existing) clearTimeout(existing);
  writeTimers.set(
    id,
    setTimeout(() => flushNote(id), delay),
  );
}

export function flushAll(): void {
  for (const id of writeTimers.keys()) flushNote(id);
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", flushAll);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAll();
  });
}

export function updateNoteContent(id: Id, content: string, options: { immediate?: boolean } = {}): void {
  const previous = libraryStore.get().notes[id];
  if (!previous) return;
  const next = rehydrate(previous, content);
  if (next.content === previous.content) return;
  plainCache.delete(id);
  next.updatedAt = Date.now();
  setNotes((notes) => ({ ...notes, [id]: next }));
  libraryStore.set((prev) => ({ ...prev, dirty: { ...prev.dirty, [id]: true } }));
  if (options.immediate) flushNote(id);
  else persistNoteSoon(id);
  maybeSnapshot(previous, next);
}

export function renameNote(id: Id, title: string): void {
  const note = libraryStore.get().notes[id];
  if (!note) return;
  const clean = title.trim() || "无标题";
  const next: Note = { ...note, titleOverride: clean, title: clean, updatedAt: Date.now() };
  setNotes((notes) => ({ ...notes, [id]: next }));
  flushNote(id);
}

export function clearTitleOverride(id: Id): void {
  const note = libraryStore.get().notes[id];
  if (!note) return;
  const next = rehydrate({ ...note, titleOverride: null }, note.content);
  setNotes((notes) => ({ ...notes, [id]: next }));
  flushNote(id);
}

export function setStarred(id: Id, starred: boolean): void {
  const note = libraryStore.get().notes[id];
  if (!note) return;
  setNotes((notes) => ({ ...notes, [id]: { ...note, starred } }));
  flushNote(id);
}

export function moveNote(id: Id, folderId: Id | null): void {
  const note = libraryStore.get().notes[id];
  if (!note || note.folderId === folderId) return;
  setNotes((notes) => ({ ...notes, [id]: { ...note, folderId, updatedAt: Date.now() } }));
  flushNote(id);
}

export function duplicateNote(id: Id): Note | null {
  const note = libraryStore.get().notes[id];
  if (!note) return null;
  const copy = buildNote(note.content, note.folderId, note.titleOverride ? `${note.title} 副本` : null);
  copy.starred = note.starred;
  setNotes((notes) => ({ ...notes, [copy.id]: copy }));
  void repo.writeNote(copy).catch(reportWriteError);
  openNote(copy.id);
  return copy;
}

export function trashNote(id: Id): void {
  const note = libraryStore.get().notes[id];
  if (!note) return;
  const next: Note = { ...note, trashed: true, trashedAt: Date.now() };
  setNotes((notes) => ({ ...notes, [id]: next }));
  flushNote(id);
  closeTab(id);
}

export function restoreNote(id: Id): void {
  const note = libraryStore.get().notes[id];
  if (!note) return;
  setNotes((notes) => ({ ...notes, [id]: { ...note, trashed: false, trashedAt: null } }));
  flushNote(id);
}

export async function purgeNote(id: Id): Promise<void> {
  const snapshots = await repo.readSnapshots(id).catch(() => []);
  await repo.removeSnapshots(snapshots.map((snapshot) => snapshot.id)).catch(reportWriteError);
  await repo.removeNote(id).catch(reportWriteError);
  plainCache.delete(id);
  setNotes((notes) => {
    const next = { ...notes };
    delete next[id];
    return next;
  });
  closeTab(id);
}

export async function emptyTrash(): Promise<number> {
  const doomed = Object.values(libraryStore.get().notes).filter((note) => note.trashed);
  for (const note of doomed) await purgeNote(note.id);
  return doomed.length;
}

export function touchNoteOpened(id: Id): void {
  const note = libraryStore.get().notes[id];
  if (!note) return;
  setNotes((notes) => ({ ...notes, [id]: { ...note, openedAt: Date.now() } }));
}

/* ------------------------------------------------------------------ folders */

export function createFolder(name: string, parentId: Id | null = null): Folder {
  const now = Date.now();
  const folder: Folder = { id: uid(), name: name.trim() || "新文件夹", parentId, createdAt: now, updatedAt: now };
  setFolders((folders) => ({ ...folders, [folder.id]: folder }));
  void repo.writeFolder(folder).catch(reportWriteError);
  expandFolder(folder.id);
  if (parentId) expandFolder(parentId);
  return folder;
}

export function renameFolder(id: Id, name: string): void {
  const folder = libraryStore.get().folders[id];
  if (!folder) return;
  const next = { ...folder, name: name.trim() || "文件夹", updatedAt: Date.now() };
  setFolders((folders) => ({ ...folders, [id]: next }));
  void repo.writeFolder(next).catch(reportWriteError);
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

/** Delete a folder; notes and sub-folders move to the trash or to the parent. */
export async function deleteFolder(id: Id, mode: "trash" | "promote"): Promise<void> {
  const folders = libraryStore.get().folders;
  const folder = folders[id];
  if (!folder) return;
  const doomed = [id, ...descendantFolderIds(id, folders)];
  const now = Date.now();
  const noteUpdates: Note[] = [];
  const nextNotes = { ...libraryStore.get().notes };
  for (const note of Object.values(nextNotes)) {
    if (!note.folderId || !doomed.includes(note.folderId)) continue;
    if (mode === "trash") {
      nextNotes[note.id] = { ...note, trashed: true, trashedAt: now };
    } else {
      nextNotes[note.id] = { ...note, folderId: folder.parentId };
    }
    noteUpdates.push(nextNotes[note.id]);
  }
  const nextFolders = { ...folders };
  for (const folderId of doomed) delete nextFolders[folderId];

  libraryStore.set((prev) => ({ ...prev, notes: nextNotes, folders: nextFolders }));
  patchUi({ expanded: getUi().expanded.filter((folderId) => !doomed.includes(folderId)) });
  await Promise.all([
    repo.removeFolder(id).catch(reportWriteError),
    ...doomed.slice(1).map((folderId) => repo.removeFolder(folderId).catch(reportWriteError)),
    repo.writeNotes(noteUpdates).catch(reportWriteError),
  ]);
}

export function moveFolder(id: Id, parentId: Id | null): void {
  const folders = libraryStore.get().folders;
  const folder = folders[id];
  if (!folder || folder.parentId === parentId) return;
  if (parentId && (parentId === id || isDescendant(parentId, id))) return; // no cycles
  const next = { ...folder, parentId, updatedAt: Date.now() };
  setFolders((all) => ({ ...all, [id]: next }));
  void repo.writeFolder(next).catch(reportWriteError);
  if (parentId) expandFolder(parentId);
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
  if (!id) return "未归档";
  return folderPath(id, folders)
    .map((folder) => folder.name)
    .join(" / ");
}

/* --------------------------------------------------------------- tree state */

export function expandFolder(id: Id): void {
  const ui = getUi();
  if (ui.expanded.includes(id)) return;
  patchUi({ expanded: [...ui.expanded, id], collapsed: ui.collapsed.filter((folderId) => folderId !== id) });
}

export function collapseFolder(id: Id): void {
  const ui = getUi();
  patchUi({
    expanded: ui.expanded.filter((folderId) => folderId !== id),
    collapsed: ui.collapsed.includes(id) ? ui.collapsed : [...ui.collapsed, id],
  });
}

export function toggleFolder(id: Id): void {
  const ui = getUi();
  const children = descendantFolderIds(id);
  const isExpanded = ui.expanded.includes(id);
  if (isExpanded) collapseFolder(id);
  else {
    // Expanding a branch also opens its children, unless the user closed them before.
    const expand = [id, ...children].filter((folderId) => !ui.collapsed.includes(folderId));
    patchUi({ expanded: [...new Set([...ui.expanded, ...expand])] });
  }
}

/* -------------------------------------------------------------------- tabs */

export function openNote(id: Id, options: { activate?: boolean } = {}): void {
  const ui = getUi();
  const note = libraryStore.get().notes[id];
  if (!note) return;
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
  let activeId = ui.activeId;
  if (ui.activeId === id) {
    activeId = tabs[Math.min(index, tabs.length - 1)] ?? null;
  }
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

/** Drop tab ids whose notes vanished (e.g. after an import that replaced the library). */
export function reconcileTabs(): void {
  const ui = getUi();
  const notes = libraryStore.get().notes;
  const tabs = ui.tabs.filter((id) => notes[id] && !notes[id].trashed);
  const activeId = ui.activeId && tabs.includes(ui.activeId) ? ui.activeId : (tabs[tabs.length - 1] ?? null);
  if (tabs.length !== ui.tabs.length || activeId !== ui.activeId) patchUi({ tabs, activeId });
}

/* --------------------------------------------------------------- selectors */

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
  const scope = folderId && descendants ? new Set([folderId, ...descendantFolderIds(folderId, state.folders)]) : null;
  const list = Object.values(state.notes).filter((note) => {
    if (note.trashed !== includeTrashed) return false;
    if (folderId === undefined) return true; // all notes
    if (scope) return note.folderId !== null && scope.has(note.folderId);
    return note.folderId === folderId;
  });
  return sortNotes(list, sort);
}

export function childFolders(state: LibraryState, parentId: Id | null): Folder[] {
  return Object.values(state.folders)
    .filter((folder) => folder.parentId === parentId)
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

export function folderStats(state: LibraryState, folderId: Id): { notes: number; folders: number } {
  const scope = new Set([folderId, ...descendantFolderIds(folderId, state.folders)]);
  let notes = 0;
  for (const note of Object.values(state.notes)) {
    if (!note.trashed && note.folderId && scope.has(note.folderId)) notes += 1;
  }
  let folders = 0;
  for (const folder of Object.values(state.folders)) {
    if (folder.parentId && scope.has(folder.parentId) && scope.has(folder.id)) folders += 1;
  }
  return { notes, folders };
}

export function starredNotes(state: LibraryState, sort: SortKey = "updated"): Note[] {
  return sortNotes(
    Object.values(state.notes).filter((note) => note.starred && !note.trashed),
    sort,
  );
}

export function trashedNotes(state: LibraryState): Note[] {
  return sortNotes(
    Object.values(state.notes).filter((note) => note.trashed),
    "updated",
  );
}

export function allTags(state: LibraryState): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const note of Object.values(state.notes)) {
    if (note.trashed) continue;
    for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "zh-Hans-CN"));
}

export interface SearchHit {
  note: Note;
  score: number;
  /** Plain-text window around the first content match. */
  snippet: string;
}

export function searchNotes(
  query: string,
  options: { limit?: number; sort?: SortKey } = {},
): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const { limit = 80, sort = "updated" } = options;
  const state = libraryStore.get();
  const terms = q.split(/\s+/).filter(Boolean);
  const raw: { note: Note; score: number; position: number }[] = [];

  for (const note of Object.values(state.notes)) {
    if (note.trashed) continue;
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
    // freshness nudge so equally-good hits surface recent notes first
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

/* --------------------------------------------------------------- snapshots */

const SNAPSHOT_INTERVAL = 3 * 60_000;
const SNAPSHOT_KEEP = 60;
const lastSnapshotAt = new Map<Id, number>();

function maybeSnapshot(previous: Note, next: Note): void {
  const ui = getUi();
  if (!ui.snapshots) return;
  const last = lastSnapshotAt.get(next.id) ?? 0;
  if (Date.now() - last < SNAPSHOT_INTERVAL) return;
  if (previous.content.trim() === next.content.trim()) return;
  lastSnapshotAt.set(next.id, Date.now());
  void saveSnapshot(next.id, previous.content, previous.title, "auto");
}

export async function saveSnapshot(
  noteId: Id,
  content: string,
  title: string,
  reason: SnapshotReason,
): Promise<Snapshot> {
  const snapshot: Snapshot = { id: uid(), noteId, content, title, createdAt: Date.now(), reason };
  try {
    await repo.writeSnapshot(snapshot);
    await repo.pruneSnapshots(noteId, SNAPSHOT_KEEP);
  } catch (error) {
    console.warn("[opennote] 快照写入失败", error);
  }
  return snapshot;
}

export async function listSnapshots(noteId: Id): Promise<Snapshot[]> {
  const all = await repo.readSnapshots(noteId).catch(() => []);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function takeManualSnapshot(noteId: Id): Promise<void> {
  const note = libraryStore.get().notes[noteId];
  if (!note) return;
  lastSnapshotAt.set(noteId, Date.now());
  await saveSnapshot(noteId, note.content, note.title, "manual");
}

export async function restoreSnapshot(snapshot: Snapshot): Promise<void> {
  const note = libraryStore.get().notes[snapshot.noteId];
  if (!note) return;
  await saveSnapshot(note.id, note.content, note.title, "restore");
  updateNoteContent(note.id, snapshot.content, { immediate: true });
}

/* ------------------------------------------------------------- bulk actions */

export function replaceLibrary(notes: Note[], folders: Folder[]): void {
  const noteMap: Record<Id, Note> = {};
  for (const note of notes) noteMap[note.id] = note;
  const folderMap: Record<Id, Folder> = {};
  for (const folder of folders) folderMap[folder.id] = folder;
  plainCache.clear();
  libraryStore.set((prev) => ({ ...prev, notes: noteMap, folders: folderMap, ready: true }));
  reconcileTabs();
}

export function mergeIntoLibrary(notes: Note[], folders: Folder[]): { notes: number; folders: number } {
  const state = libraryStore.get();
  const nextNotes = { ...state.notes };
  const nextFolders = { ...state.folders };
  let noteCount = 0;
  let folderCount = 0;
  for (const folder of folders) {
    if (!nextFolders[folder.id]) {
      nextFolders[folder.id] = folder;
      folderCount += 1;
    }
  }
  for (const note of notes) {
    if (!nextNotes[note.id]) {
      nextNotes[note.id] = note;
      noteCount += 1;
    }
  }
  libraryStore.set((prev) => ({ ...prev, notes: nextNotes, folders: nextFolders }));
  return { notes: noteCount, folders: folderCount };
}

export function notesArray(state: LibraryState = libraryStore.get()): Note[] {
  return Object.values(state.notes);
}

export function foldersArray(state: LibraryState = libraryStore.get()): Folder[] {
  return Object.values(state.folders);
}
