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
  sameBytes,
  sanitizeName,
  stripExtension,
  uniquePath,
  type EntryInfo,
  type FileSystemBackend,
} from "../fs";
import { createStore, useStore } from "../lib/store";
import {
  countText,
  derivePlaceholderTitle,
  deriveTags,
  deriveTitle,
  isPlaceholderName,
  normalizeEol,
  splitFrontMatter,
  stripMarkdown,
  uid,
} from "../lib/utils";
// 附件目录的**唯一产地**（`<目录>/<笔记名>.assets/`）。这里只 import，绝不自己再写一遍
// 派生规则 —— 剪藏接收端（`src/lib/clip/receive.ts`）用的是同一个函数，两个产地会漂移。
// 同理，引用文本的写法（带空格时要写成 `<…>`）也只从 `markdownRef` 来。
import {
  assetFinalName,
  assetsDirFor,
  markdownRef,
  rebaseSharedAssetRefs,
  relativeAssetRef,
  sharedAssetFilesIn,
} from "../lib/clip/landing";
import { desktopBridge, type WorkspaceFileChange } from "../desktop/bridge";
import { fileStates, type FileRecord, type FileStamp } from "./fileStates";
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
  /**
   * 「这个名字是用户手定的」的**来源标记与时间戳**，按笔记路径存，与 `titleOverrides`
   * 一一对应。并行映射而不是把 `titleOverrides` 的值升级成对象 —— 后者是 `state.json`
   * 的破坏性格式变更（旧版本读不了新文件），这里只加一个键。
   *
   * 用途：① 排查「这个名字是谁写的」（用户手定的 vs 正文派生的）；
   *       ② 将来做「撤销自动改名」时判断来源。
   * 语义边界：**存在** = 用户手定过这个名字，不代表当前文件名的来源 ——
   * 自动改名（`autoRenameFromPlaceholder`）**不写、不删**这张表，所以它永远不会
   * 因为一次自动改名而被写上。
   *
   * 旧的 `state.json` 没有这个键 → `undefined` → 所有既有笔记视为「早已过静默期」，
   * 行为与不引入该字段时一致。
   */
  titlePinnedAt?: Record<Id, number>;
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

/** `state.json` 里的 `titlePinnedAt`：只留「非空路径 → 有限正数」，别的一律丢掉（照 `readTitleOverrides`）。 */
function readTitlePinnedAt(value: unknown): Record<Id, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<Id, number> = {};
  for (const [path, at] of Object.entries(value as Record<string, unknown>)) {
    if (path && typeof at === "number" && Number.isFinite(at) && at > 0) out[path] = at;
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

/* ------------------------------------------------- 占位名笔记的自动改名（停笔 5 秒）

   背景（用户实测 0.5.0）：「重命名完成后，文件名又会恢复，或者直接就不修改」的镜像问题 ——
   用户在 `无标题.md` 里写了个标题，**磁盘文件名一格不动**。全仓 14 个 `target.move(`
   调用点里没有一处的输入是正文标题，这条通道从来没有存在过。

   三条硬约束（调研报告 t2 的阻断级发现，实现里逐条落地）：
     1. **绝不复用 `renameNote()`** —— 它写 `titleOverride`，而 `refresh()` 是
        `titleOverride ?? deriveTitle(...)`。复用一次就把该笔记的「正文标题 → 文件名」
        通道**永久锁死**，用户第二次改标题时文件名不再跟随（现象与修复前完全一样）。
        所以另开一条 `autoRenameFromPlaceholder()`，不写 override、不写 pinnedAt。
     2. **必须抑制「用户手改过名字」的笔记** —— `titleOverride` 存在即永久跳过，
        另外给「刚显式重命名过」加 30 秒静默期（防止用户点了重命名、旧标题立刻顶回去）。
     3. **光标行判定不能用 React state** —— 此条已随「光标还在标题行」判据一起删除
        （真机教训 2026-10-09：打完标题光标必然停在标题行，该判据让功能永不触发；
        「用户还在编辑标题」由 5 秒防抖保证，不需要光标位置）。

   范围**只有占位名**（`无标题` / `未命名` / `untitled` 及带序号变体）：真实笔记本
   （`E:\repo\notes`）的占位名笔记只有个位数，其余几百篇一律不动 —— 入口条件唯一，
   爆炸半径因此为 0。

   ⚠️ **不要在注释里写死「N 篇」**：真实笔记本每天都在变（本方案定稿时 5 篇占位名，
   到复核时已经是 7 篇）。**当前读数与逐篇判定统一记在
   `docs/标题命名规则-改动方案.md` §3**（附只读盘点脚本与日期），要引用数字就引用那里。
   代码里只表达机制：「只有占位名出身的笔记进候选集」。 */

/** 停笔多久才落盘（方案 §2.4：窗口内再敲字 = 取消 + 重排，不是排队）。 */
const AUTO_RENAME_DELAY = 5000;
/** 同一篇笔记两次自动改名之间的最小间隔（文件监听 500ms 抖动 + 重扫会反复触发）。 */
const AUTO_RENAME_MIN_INTERVAL = 30_000;
/** 用户显式重命名之后的静默期。 */
const EXPLICIT_RENAME_QUIET_MS = 30_000;
/**
 * 新建笔记的静默期：刚 `createNote()` 的笔记正文还空着，别急着改名。
 *
 * **导入 / 剪藏走的是同一条**（口径已按实际实现统一，见方案 §2.5 的口径说明）：
 * 方案 #6 原本要一张独立的 `importQuietUntil: Map<Id, number>`（60 秒），实际没有实现它，
 * 而是复用本条件 —— `import.ts` 与 `clip/receive.ts` 落盘后都会 `rescanWorkspace()`，
 * 而 `makeNote()` 的 `createdAt` 取的就是**刚写下去的文件 mtime**，所以「刚导入的笔记」
 * 天然落在本窗口内。差 60s → 10s 的代价是：导入后第 10~60 秒之间若用户编辑正文，
 * 文件会被改名（导入时带来的文件名会被正文标题顶掉）。判据 N9 覆盖本窗口内的行为。
 * 补 `importQuietUntil` 需要动 `src/lib/import.ts` / `src/lib/clip/`（本轮 in-scope 之外）。
 */
const NEW_NOTE_QUIET_MS = 10_000;

/**
 * 瞬态拦截的重试参数。**真机教训 2026-10-09**：排定时器时的预检曾经把「光标在标题行 /
 * 输入法合成中 / 新建静默期」这类**瞬态**拦截当成终态，定时器整个不排 —— 而打字的整个
 * 过程里这些条件必然成立，停笔后没有任何新触发点，功能在它的主场景里（新建 → 打标题 →
 * 停笔等 5 秒）**一次都不会触发**。现在：瞬态失败照排定时器，到点再判；仍不满足就按
 * `AUTO_RENAME_RETRY_MS` 短重试（至多 `AUTO_RENAME_MAX_RETRIES` 次 ≈ 90 秒）；只有
 * **稳定**失败（非占位 / 有 override / 无真标题 / 旧附件引用 / 只读锁…）才直接放弃。
 */
const AUTO_RENAME_RETRY_MS = 2_000;
const AUTO_RENAME_MAX_RETRIES = 45;

/** 测试缝：停笔窗口（真实计时器下 5 秒太慢，测试改成 20ms 之类）。 */
let autoRenameDelay = AUTO_RENAME_DELAY;
/** 待执行的自动改名定时器，按笔记 id 一张表 —— 与 `writeTimers` / `scheduleMeta` 互不取消。 */
const autoRenameTimers = new Map<Id, ReturnType<typeof setTimeout>>();
/** 正在改名途中的笔记：期间再敲字只重排，绝不并发第二个 `move`。 */
const autoRenameInFlight = new Set<Id>();
/**
 * 瞬态拦截原因（`shouldAutoRename` 的返回值）：到点仍不满足就短重试，而不是放弃。
 * 判据清单与 `shouldAutoRename` 逐条对齐；时间窗类条件到期自然放行，所以重试必然收敛。
 */
const AUTO_RENAME_TRANSIENT_REASONS = new Set<string>([
  "新建笔记静默期（10 秒）",
  "刚显式重命名过（30 秒静默期）",
  "新建 preflight 还没落定",
  "输入法合成中",
  "距上次自动改名不足 30 秒",
  "正在改名途中",
]);
/** 每篇笔记已重试的次数（内容一变就清零；防两个笔记互踩无上限空转）。 */
const autoRenameRetries = new Map<Id, number>();
/** 用户显式重命名的时间戳（30 秒静默期）。 */
const explicitRenamedAt = new Map<Id, number>();
/** 同一篇笔记上一次自动改名的时间戳（30 秒最小间隔）。 */
const lastAutoRenameAt = new Map<Id, number>();
/** 界面下推的输入法合成状态：中文输入法合成期间用户可能停顿数秒，不许在这期间搬文件。 */
const editorComposing = new Map<Id, boolean>();
/**
 * **占位名出身的笔记**（当前文件名是占位名，或者曾经是 —— 被自动改名之后就不再是了）。
 *
 * 为什么需要它：入口条件不能只看「当前文件名是不是占位名」。第一次自动改名之后文件名
 * 就变成正文标题了，若按当前名字判定，用户**第二次**改标题时文件名不会再跟随 ——
 * 那正是本次要修的原始缺陷，等于没修。所以记住「这篇笔记是占位名出身的」：
 *   ① 扫描时：文件名匹配占位名的笔记入集；
 *   ② `createNote()`：新建笔记（`无标题.md` / `无标题 2.md`）入集；
 *   ③ 自动改名：**留在集里**（键跟着新路径走），所以下一次改标题还会跟随；
 *   ④ 用户显式重命名：出集（用户手定的名字之后不再自动跟随，见 `renameNote`）。
 */
const placeholderOrigin = new Set<Id>();

/** 一次自动改名的结果，供测试与排查用（只增不改，测试读它当证据）。 */
export interface AutoRenameOutcome {
  at: number;
  from: Id;
  to: Id | null;
  status: "renamed" | "skipped";
  /** `renamed` 时是落盘名；`skipped` 时是**被哪一条拦下的**（不用猜）。 */
  reason: string;
}
const autoRenameOutcomes: AutoRenameOutcome[] = [];

/** Bumped by every open/close: a slow scan must never publish into a newer workspace (D02). */
let generation = 0;
// 磁盘状态记账收口在 ./fileStates（P0 搬家；P1 升级为含内容溯源的 FileRecord）。
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
  // 占位名出身：扫描到的第一篇 `无标题.md` 就靠这一行进候选集（自动改名的入口条件）。
  if (!options.trashed && isPlaceholderName(stripExtension(baseName(path)))) placeholderOrigin.add(path);
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

/**
 * 只换一篇笔记的正文（移动时重算图片引用前缀后同步内存）。
 *
 * 内存与磁盘必须**一起**变：只写盘会让编辑器/预览拿着旧正文继续渲染（图是裂的），
 * 而且下一次 `flushNote` 会把旧正文写回去，等于白改。
 */
function patchNoteContent(id: Id, content: string): void {
  const note = libraryStore.get().notes[id];
  if (!note || note.content === content) return;
  patchNotes((notes) => ({ ...notes, [id]: { ...note, content } }));
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
  /** On-disk stamps per note id, seeded into `fileStates` by open/rescan (D08). */
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
    const titlePinnedAt = readTitlePinnedAt(parsed.titlePinnedAt);
    return {
      version: 1,
      starred: Array.isArray(parsed.starred) ? parsed.starred.map(String) : [],
      expanded: Array.isArray(parsed.expanded) ? parsed.expanded.map(String) : [],
      lastOpened: parsed.lastOpened ? String(parsed.lastOpened) : null,
      ...(isSidebarTab(sidebarTab) ? { ui: { sidebarTab } } : {}),
      ...(titleOverrides ? { titleOverrides } : {}),
      ...(titlePinnedAt ? { titlePinnedAt } : {}),
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
    fileStates.seedFromScan(scanned);
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
  // 磁盘状态记账也在这里清：同一路径在另一个笔记本是**另一篇笔记**，A 库的记录
  // 绝不能参与 B 库的「外部改动」判定（否则会把 A 的正文当 B 的前像，D22 实测）。
  fileStates.clear();
  lastSnapshotAt.clear();
  snapshotNames.clear();
  snapshotFailures.clear();
  createGuards.clear();
  for (const timer of writeTimers.values()) clearTimeout(timer);
  writeTimers.clear();
  // 自动改名与写盘同层：离开笔记本时未到点的定时器一律取消（否则它会在下一个笔记本上开火）。
  for (const timer of autoRenameTimers.values()) clearTimeout(timer);
  autoRenameTimers.clear();
  autoRenameInFlight.clear();
  autoRenameRetries.clear();
  explicitRenamedAt.clear();
  lastAutoRenameAt.clear();
  editorComposing.clear();
  placeholderOrigin.clear();
  autoRenameDelay = AUTO_RENAME_DELAY;
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
 *
 * 非桌面后端（fsa/capacitor）没有监听源：窗口重新聚焦（浏览器切回标签页、手机从
 * 后台回来）时重扫一次，作为这两个端唯一可用的「外部改动」信号。opfs 除外——
 * 只有应用自己会写它（I1 已覆盖），聚焦刷新纯浪费。
 */
function startWatching(root: string): void {
  stopWatching();
  const bridge = desktopBridge();
  const fs = bridge?.fs;
  const unsubscribers: Array<() => void> = [];
  const hasWatcherApi = typeof fs?.watchWorkspace === "function" && typeof fs.onWorkspaceChanged === "function";
  watchedRoot = root;
  if (hasWatcherApi) {
    unsubscribers.push(
      fs.onWorkspaceChanged((changed) => {
        // The event is broadcast to every window: ignore other notebooks.
        // v2 载荷带变化路径 → 按路径增量刷新（成本 ∝ 变化文件数）；拿不到路径
        // （旧载荷/平台不给文件名）→ 整库重扫兜底。
        const root = typeof changed === "string" ? changed : (changed?.root ?? "");
        if (!sameRoot(root, watchedRoot)) return;
        const target = backend;
        const changes = typeof changed === "string" ? null : (changed?.changes ?? null);
        if (!target || !changes || changes.length === 0) {
          scheduleWatchRescan();
          return;
        }
        queuePathRefresh(target, changes);
      }),
    );
    void fs.watchWorkspace(root).catch((error) => {
      console.warn("[opennote] 无法监听工作区变化", error);
    });
  } else if (
    backend?.kind !== "opfs" &&
    typeof window !== "undefined" &&
    typeof window.addEventListener === "function" &&
    typeof document !== "undefined"
  ) {
    const onFocus = () => {
      if (document.visibilityState === "visible") scheduleWatchRescan();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    unsubscribers.push(() => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    });
  }
  if (unsubscribers.length === 0) return;
  watchUnsubscribe = () => {
    for (const off of unsubscribers) off();
  };
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

/**
 * 按路径增量刷新（P2a）：v2 事件只重读变化的文件，不再整库重扫——
 * 外部事件的处理成本 ∝ 变化的文件数，与库的总大小无关（D7）。
 *
 * 处置与 flushNote 的保存前检查同源（`reconcileExternalChange`，磁盘赢 D3）：
 *   - 干净笔记被外部改了 → 直接采纳磁盘（编辑器重载保光标），不占前像；
 *   - dirty 笔记被外部改了 → 未保存文本进隐藏前像，然后采纳磁盘；
 *   - 磁盘上还是我们自己写的上一版（自写过滤漏网）→ 我的赢，照常走保存；
 *   - 新 .md → 入树（父目录节点一并补）；已知笔记消失 → 出树并关标签。
 *
 * 兜底：一次事件批超过 PATH_REFRESH_LIMIT（git checkout 这类风暴）、拿不到路径、
 * 或处理中出任何错 → 退回一次整库重扫（rescanWorkspace）。
 */
const PATH_REFRESH_LIMIT = 50;
let pathRefreshTail: Promise<void> = Promise.resolve();

function queuePathRefresh(target: FileSystemBackend, changes: WorkspaceFileChange[]): void {
  pathRefreshTail = pathRefreshTail
    .then(() => refreshPaths(target, changes))
    .catch((error) => {
      console.warn("[opennote] 按路径刷新失败，退回整库重扫", error);
      void rescanWorkspace().catch(() => undefined);
    });
}

async function refreshPaths(target: FileSystemBackend, changes: WorkspaceFileChange[]): Promise<void> {
  const myGen = generation;
  if (backend !== target) return;
  const md = changes.filter((change) => isMarkdownPath(change.path));
  const dirs = changes.filter((change) => !isMarkdownPath(change.path) && !isHiddenPath(change.path) && change.type !== "delete");
  if (md.length > PATH_REFRESH_LIMIT) {
    await rescanWorkspace();
    return;
  }
  for (const change of md) {
    if (myGen !== generation || backend !== target) return;
    const id = change.path;
    const known = libraryStore.get().notes[id] ?? libraryStore.get().trash[id];
    const exists = await target.exists(id).catch(() => false);
    if (!exists) {
      if (known) {
        // 外部删除：出树、关标签、清记录。历史快照留在磁盘上（purge 才真正删）。
        setState((prev) => {
          const notes = { ...prev.notes };
          delete notes[id];
          const trash = { ...prev.trash };
          delete trash[id];
          return { ...prev, notes, trash };
        });
        fileStates.delete(id);
        invalidateSearchCache(id);
        closeTab(id);
        reconcileTabs();
      }
      continue;
    }
    const stat = await target.stat(id).catch(() => null);
    const onDisk = stat === null ? null : await target.readText(id).catch(() => null);
    if (stat === null || onDisk === null) continue;
    if (known) {
      const dirty = Boolean(libraryStore.get().dirty[id]);
      if (!dirty) {
        // 干净：磁盘为准，直接采纳（不占前像——旧版本本就在历史里）。
        adoptExternal(id, onDisk, stat);
        continue;
      }
      const latest = libraryStore.get().notes[id] ?? libraryStore.get().trash[id];
      await reconcileExternalChange(id, { content: onDisk, stat }, fileStates.get(id), latest?.content ?? known.content);
      continue;
    }
    // 新笔记：入树（父目录节点一并补，与 restoreNote 同款）。
    const note = makeNote(id, onDisk, stat.mtimeMs);
    patchNotes((notes) => ({ ...notes, [id]: note }));
    for (const ancestor of ancestorPaths(id)) {
      if (!libraryStore.get().folders[ancestor]) {
        patchFolders((folders) => ({ ...folders, [ancestor]: makeFolder(ancestor, Date.now()) }));
      }
      expandFolder(ancestor);
    }
    fileStates.adoptFromDisk(id, onDisk, stat);
    invalidateSearchCache(id);
  }
  // 非 md 的新增目录（外部建了个空文件夹）：补个节点，树里看得见。目录删除不处理
  //（纯装饰性，下一次全量重扫自会清）。
  for (const change of dirs) {
    if (myGen !== generation || backend !== target) return;
    if (change.type === "delete") continue;
    if (libraryStore.get().folders[change.path]) continue;
    if (!(await target.exists(change.path).catch(() => false))) continue;
    patchFolders((folders) => ({ ...folders, [change.path]: makeFolder(change.path, Date.now()) }));
  }
  reconcileTabs();
}

export async function closeWorkspace(): Promise<void> {
  generation += 1;
  // Leaving the notebook: no late notification may rescan into it (D02/D08).
  stopWatching();
  await flushAll();
  await flushMeta();
  backend = null;
  meta = { ...defaultMeta };
  // Snapshot throttling is per notebook, so closing releases the table (D22).
  // 磁盘状态记账也随 resetWorkspaceTransients() 一起清（同一条 D22 规则）。
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
  // 重扫会重建整个 `notes`，但「占位名出身」不是能从磁盘读出来的事实（自动改名之后的
  // 文件名已经是正文标题了）—— 所以这一份必须原样保住，否则重扫一次第二次改名就没了。
  const originBefore = new Set(placeholderOrigin);
  await flushAll();
  if (myGen !== generation || target !== backend) return;
  const scanned = await scanWorkspace(target);
  if (myGen !== generation || target !== backend) return;
  meta = { ...scanned.meta, expanded: getUi().expanded, lastOpened: getUi().activeId ?? scanned.meta.lastOpened };
  // 播种前先抓一份旧记录：下面 dirty 守卫的「真外部改动」判定要用它做内容溯源
  //（播种自己按三态规则决定保留哪一份，见 fileStates.seedFromScan）。
  const recordsBefore = new Map(fileStates.entries());
  fileStates.seedFromScan(scanned);
  invalidateSearchCache();
  const keptDirty: Id[] = [];
  // 【磁盘赢】dirty 笔记在磁盘上出现了我们不知道的版本（内容溯源 + 时间戳双重确认）
  // 时：未保存的本地文本先进前像，然后采纳磁盘——不再走「保留本地」。
  const superseded: { id: Id; buffer: string }[] = [];
  const keepLocal = new Set<Id>();
  for (const id of new Set([...Object.keys(libraryStore.get().dirty), ...dirtyBefore])) {
    const disk = scanned.notes[id];
    // The file is gone (deleted or moved outside): a dirty key could never be
    // flushed again, so it is dropped like before.
    if (!disk) continue;
    const local = libraryStore.get().notes[id];
    // Disk is at least as new as memory: nothing to protect.
    if (!local || local.content === disk.content) continue;
    const seen = recordsBefore.get(id);
    const stamp = scanned.stamps[id];
    const isForeign =
      !seen || (disk.content !== seen.content && (!stamp || stamp.mtimeMs > seen.stat.mtimeMs));
    if (isForeign) {
      superseded.push({ id, buffer: local.content });
      continue;
    }
    // The scan read bytes older than what the user has typed: keep the local
    // text (and its title/tags) so a rescan never reverts an open editor, and
    // keep the key dirty so the next flush writes it.
    keepLocal.add(id);
  }
  for (const item of superseded) await stashPreImage(item.id, item.buffer);
  if (myGen !== generation || target !== backend) return;
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
      if (!keepLocal.has(id)) continue; // 已被磁盘版本取代（前像已留档），不保本地
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
  // 扫描会把当前名字仍是占位名的笔记补进集里（新出现的 `无标题.md`）；这一句保住
  // 「已经被自动改名过、名字不再是占位名」的那些（见上面 `originBefore` 的注释）。
  for (const id of originBefore) if (libraryStore.get().notes[id] || libraryStore.get().trash[id]) placeholderOrigin.add(id);
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
 * 【磁盘赢】把即将被丢弃的未保存 buffer 存进历史（隐藏前像）：
 * 不在笔记本目录生成文件、不弹提示——但真丢了能从「历史版本」里捞回来。
 * 空内容没有可保留的，直接跳过。
 */
async function stashPreImage(id: Id, buffer: string): Promise<void> {
  if (buffer.trim() === "") return;
  await writeSnapshot(id, buffer, "before-disk", { quiet: true });
}

/**
 * 采纳磁盘版本进内存：正文/标题/标签按磁盘内容重算并清 dirty。
 * **不**调度自动改名——文件名跟随用户的编辑，不跟随外部改动。
 */
function adoptExternal(id: Id, content: string, stat: FileStamp): void {
  const state = libraryStore.get();
  const inTrash = Boolean(state.trash[id]);
  const previous = state.notes[id] ?? state.trash[id];
  if (previous) {
    const next = refresh(previous, content);
    next.updatedAt = stat.mtimeMs || Date.now();
    if (inTrash) setState((prev) => ({ ...prev, trash: { ...prev.trash, [id]: next } }));
    else patchNotes((notes) => ({ ...notes, [id]: next }));
  }
  fileStates.adoptFromDisk(id, content, stat);
  markClean(id);
  invalidateSearchCache(id);
}

/**
 * I4：外部改动的唯一处置入口（磁盘赢，D3）。
 * - 磁盘 = buffer → 磁盘已是内存那版：刷新记录、清 dirty（`unchanged`）；
 * - 磁盘 = record.content（我们自己写的上一版）→ 我的赢，调用方照常覆盖（`mine-wins`）；
 * - 其余 = 真外部改动 → buffer 进前像，采纳磁盘（`adopted`）。
 */
async function reconcileExternalChange(
  id: Id,
  disk: { content: string; stat: FileStamp },
  record: FileRecord | undefined,
  bufferContent: string,
): Promise<"adopted" | "unchanged" | "mine-wins"> {
  const diskNorm = normalizeEol(disk.content);
  const bufferNorm = normalizeEol(bufferContent);
  if (diskNorm === bufferNorm) {
    fileStates.adoptFromDisk(id, disk.content, disk.stat);
    markClean(id);
    invalidateSearchCache(id);
    return "unchanged";
  }
  if (record && diskNorm === normalizeEol(record.content)) return "mine-wins";
  await stashPreImage(id, bufferContent);
  adoptExternal(id, disk.content, disk.stat);
  return "adopted";
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
    const record = fileStates.get(id);
    const current = await target.stat(id).catch(() => null);
    // 读盘的两个理由（I2：元数据只决定要不要读，判定看字节）：
    //   1. 没有记录 —— 缺账 = 先读再定，绝不静默覆盖（旧 trash/restore 缺口的病根）；
    //   2. stat 与记录不符 —— 磁盘可能被别人动过。
    if (!record || (current && (current.mtimeMs !== record.stat.mtimeMs || current.size !== record.stat.size))) {
      const onDisk = await target.readText(id).catch(() => null);
      if (onDisk !== null) {
        // buffer 取**最新**的内存正文：判定与留前像都不能用过期的快照。
        const latest = libraryStore.get().notes[id] ?? libraryStore.get().trash[id];
        const outcome = await reconcileExternalChange(
          id,
          { content: onDisk, stat: current ?? { size: onDisk.length, mtimeMs: Date.now() } },
          record,
          latest?.content ?? note.content,
        );
        // adopted：磁盘赢，buffer 已进前像、内存已是磁盘版本；
        // unchanged：磁盘本来就是内存那一版，无需写。两者都直接收工。
        if (outcome !== "mine-wins") return;
      }
    }
    // 链上可能有更新的写入，或 buffer 已被「磁盘赢」采纳替换：只写**当前**内存那版。
    // 过期的捕获直接丢弃——否则旧快照会在采纳之后又把磁盘盖回去（D08 用例实测）。
    const latestNow = libraryStore.get().notes[id] ?? libraryStore.get().trash[id];
    if (!latestNow || latestNow.content !== note.content) return;
    await target.writeText(id, note.content);
    const after = await target.stat(id).catch(() => null);
    if (after) fileStates.commitWrite(id, note.content, after);
    else fileStates.delete(id);
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

function autoSaveDelayMs(): number {
  const raw = Math.round(getUi().autoSaveDelay);
  return Number.isFinite(raw) ? Math.min(5000, Math.max(300, raw)) : 1000;
}

function persistNoteSoon(id: Id, delay = autoSaveDelayMs()): void {
  // 只有 afterDelay 按停笔延时落盘；onFocusChange / onWindowChange 等各自的焦点
  // 事件（内容保持 dirty，关窗握手 D11 仍会兜底），重扫/搬键的保底写也不排。
  if (getUi().autoSave !== "afterDelay") return;
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
  // `makeNote` 会把名字匹配占位名的笔记记进「占位名出身」（新建笔记走的就是这条）。
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

/* --------------------------------------- 占位名笔记的自动改名：判定、调度、执行体 */

/** 判定自动改名要看的**全部**输入，由 `autoRenameContext()` 现取 —— 纯函数便于逐条写单测。 */
export interface AutoRenameContext {
  /** 笔记当前路径（= 磁盘文件名）。 */
  id: Id;
  /** `stripExtension(baseName(id))`。 */
  stem: string;
  /** 这篇笔记是不是**占位名出身**（当前名字是占位名，或曾经是）。 */
  placeholderOrigin: boolean;
  /** 正文（已 `normalizeEol`）。 */
  content: string;
  /** `Note.titleOverride`。 */
  titleOverride: string | null;
  /** 是否在回收站里。 */
  trashed: boolean;
  /** 创建时间（毫秒）。 */
  createdAt: number;
  /** 当前时刻。 */
  now: number;
  /** 输入法是否正在合成。 */
  composing: boolean;
  /** 新建 preflight 还没落定（`createGuards`）。 */
  creating: boolean;
  /** 只读锁（`ui.lockedNotes`）。 */
  locked: boolean;
  /** 同一篇笔记上一次自动改名的时间戳。 */
  lastAutoRenameAt: number | null;
  /** 用户显式重命名的时间戳（本会话）。 */
  explicitRenamedAt: number | null;
  /** `state.json` 里持久化的「这个名字是用户手定的」时间戳。 */
  pinnedAt: number | null;
  /** 正在改名途中。 */
  inFlight: boolean;
  /** 设置里的总开关（`ui.autoTitleFromPlaceholder`，默认开、可关）。 */
  autoTitleFromPlaceholder: boolean;
}

/**
 * 「这篇笔记现在能不能自动改名」—— 收窄后**唯一**的入口判定，纯函数，逐条可测。
 *
 * 返回 `null` = 可以改；返回字符串 = 不能改的**原因**（写进 `AutoRenameOutcome`，
 * 排查时不用猜是哪一条拦的）。
 */
export function shouldAutoRename(ctx: AutoRenameContext): string | null {
  // 条件 -1：设置里的总开关（设置 · 文件 → 「写完标题自动改名」，默认开）。
  // 关掉之后**所有**占位名笔记一律不动 —— 这是用户能自己收回这个功能的那条路。
  if (!ctx.autoTitleFromPlaceholder) return "设置里已关闭自动改名";
  // 条件 0 ★ 本次收窄的核心：只有**占位名出身**的笔记才在候选集里，其余笔记一律不动。
  // （`placeholderOrigin` 而不是「当前名字是占位名」：第一次自动改名之后名字就变了，
  //   按当前名字判定会让第二次改标题不再跟随 —— 那正是本次要修的缺陷。）
  if (!ctx.placeholderOrigin) return "非占位名笔记";
  // 条件 1：回收站里的名字是「还原后的名字」，自动改会与 `moveTitleOverride` 打架。
  if (ctx.trashed) return "在回收站里";
  // 条件 2 ★ 用户显式命名过 ⇒ 永久停用（【实测】A7b：不判就会顶掉用户手改的名字）。
  if (ctx.titleOverride) return "有 titleOverride（用户显式命名过）";
  // 条件 3/4：正文里必须有**真正的标题行**（H1–H6），且绝不是「正文首行」兜底。
  const title = derivePlaceholderTitle(ctx.content);
  if (!title) return "正文里没有真标题行";
  // 条件 5/6：净化后与当前文件名逐字相同 = 空操作（只差大小写走 `moveCaseOnly`，不算相同）。
  const clean = sanitizeName(title, "无标题");
  if (!clean || clean === "无标题") return "标题全是非法字符";
  if (`${clean}${extName(ctx.id) || ".md"}` === ctx.id) return "与当前文件名相同（空操作）";
  // 条件 7：刚新建的笔记正文还空着/还在变，先让它安静下来。
  if (ctx.now - ctx.createdAt <= NEW_NOTE_QUIET_MS) return "新建笔记静默期（10 秒）";
  // 条件 8 ★ 用户刚点了「重命名」：别让旧标题立刻把名字顶回去（30 秒静默期）。
  const renamedAt = Math.max(ctx.explicitRenamedAt ?? 0, ctx.pinnedAt ?? 0);
  if (renamedAt && ctx.now - renamedAt < EXPLICIT_RENAME_QUIET_MS) return "刚显式重命名过（30 秒静默期）";
  // 条件 10：`createGuards` 的 gate 不参与 `remapIds`，改名会让写入闸门指错 id。
  if (ctx.creating) return "新建 preflight 还没落定";
  // 条件 11：只读笔记不该被应用改文件。
  if (ctx.locked) return "只读锁";
  // 条件 12 ★ 旧布局 `<旧文件名>.assets/`：改名不会搬那个目录 ⇒ 图立刻全裂。
  //   【实测】本机 `项目实战/system_panel/无标题.md` 正是这一态（5 处 `./无标题.assets/…`）。
  //
  //   为什么这里**只跳过、不弹提示**（复核 R8 的裁定，见方案 §6.2 的「未做」记录）：
  //   附件迁移是一次性 CLI，顺序由流程保证（先关 Opennote、先跑迁移、再上线自动改名），
  //   而条件 12 已经保证「不裂图」这条数据安全底线。界面提示是另一件事，本轮不做。
  if (hasLegacyAssetRef(ctx.content, ctx.stem)) return "正文里有按旧文件名写死的附件引用";
  // 条件 13：文件监听 500ms + 重扫会反复触发，同一篇笔记两次改名之间要隔开。
  if (ctx.lastAutoRenameAt && ctx.now - ctx.lastAutoRenameAt < AUTO_RENAME_MIN_INTERVAL) return "距上次自动改名不足 30 秒";
  // 条件 14：改名途中不再排第二个（改完由 `remapIds` 按新路径重挂）。
  if (ctx.inFlight) return "正在改名途中";
  // 条件（§2.4）：中文输入法合成期间用户可能停顿数秒，不许在这期间搬文件。
  //   【真机教训 2026-10-09】曾经还有一条「光标还在标题那一行就不改名」——已删除。
  //   自然流程（新建 → 打标题 → 停笔）里光标**必然**停在标题行，这条判据等于让功能
  //   在它的主场景里永不触发；「用户还在编辑」由 5 秒防抖保证，不需要光标位置。
  if (ctx.composing) return "输入法合成中";
  return null;
}

/** 正文里有没有按旧文件名写死的附件引用（旧布局 `<旧名>.assets/…`，改名即裂图）。 */
export function hasLegacyAssetRef(content: string, stem: string): boolean {
  if (!stem) return false;
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 允许前面是空白、引号、括号、`./`、`../` 或路径分隔符 —— 真实正文里这几种写法都出现过
  // （`![image.png](./无标题.assets/image.png)`、`](无标题.assets/x.png)`）。
  // 前面的边界必须存在，否则 `A无标题.assets/` 也会被算成命中（那不是这篇笔记的附件目录）。
  return new RegExp(`(^|[\\s("'<]|/|\\.\\./)\\.?${escaped}\\.assets/`).test(content);
}

/** 从当前状态现取判定输入 —— 定时器回调里**必须**现取，绝不闭包捕获 `Note` 对象。 */
function autoRenameContext(id: Id, now = Date.now()): AutoRenameContext | null {
  const state = libraryStore.get();
  const note = state.notes[id];
  const trashed = Boolean(state.trash[id]);
  const subject = note ?? state.trash[id];
  if (!subject) return null;
  return {
    id,
    stem: stripExtension(baseName(id)),
    placeholderOrigin: placeholderOrigin.has(id) || isPlaceholderName(stripExtension(baseName(id))),
    content: subject.content,
    titleOverride: subject.titleOverride,
    trashed,
    createdAt: subject.createdAt,
    now,
    composing: editorComposing.get(id) === true,
    creating: createGuards.has(id),
    locked: getUi().lockedNotes.includes(id),
    lastAutoRenameAt: lastAutoRenameAt.get(id) ?? null,
    explicitRenamedAt: explicitRenamedAt.get(id) ?? null,
    pinnedAt: meta.titlePinnedAt?.[id] ?? null,
    inFlight: autoRenameInFlight.has(id),
    // 兜底成「开」：`data/ui.ts` 的 `load()` 已经用 `{ ...DEFAULT_UI, ...parsed }` 覆盖了
    // 「旧 localStorage 缺键」，这里再兜一次手改 localStorage 塞进来的非布尔值 ——
    // 失败方向选「功能可用」，而不是「静默失效」。
    autoTitleFromPlaceholder: getUi().autoTitleFromPlaceholder !== false,
  };
}

/**
 * 界面下推输入法合成状态（§2.4 的 IME 保护）。
 *
 * 合成结束时（`composing=false`）**顺手重排一次**：定时器可能在合成期间到点、被瞬态
 * 重试兜着，合成一结束就该按正常 5 秒窗口重新计时 —— 否则用户得再敲一个字才触发改名
 * （真机教训 2026-10-09：合成结束是停笔的自然终点，不能要求用户「再改一次内容」）。
 */
export function setEditorComposing(id: Id | null, composing: boolean): void {
  if (!id) return;
  if (composing) editorComposing.set(id, true);
  else {
    editorComposing.delete(id);
    scheduleAutoRename(id);
  }
}

/** 内容变化时排定时器：**每次变化都重排**（连续打字永远不会触发改名）。 */
function scheduleAutoRename(id: Id): void {
  const existing = autoRenameTimers.get(id);
  if (existing) {
    clearTimeout(existing);
    autoRenameTimers.delete(id);
  }
  // 内容一变，重试计数就作废：这是全新的一轮观察。
  autoRenameRetries.delete(id);
  // 预检只拦**稳定**失败（非占位 / 有 override / 无真标题 / 旧附件引用 / 只读锁 / 总开关关）。
  // **瞬态**失败（合成中 / 新建静默期 / preflight / 改名途中 / 30 秒窗口）必须照排定时器：
  // 这些条件在打字过程里必然成立，如果在这里就放弃，停笔后没有任何新触发点，功能永不触发。
  // 到点时 `autoRenameFromPlaceholder()` 会拿最新状态再判一遍，瞬态未消就短重试。
  const ctx = autoRenameContext(id);
  const reason = ctx ? shouldAutoRename(ctx) : "笔记不存在";
  if (reason !== null && !AUTO_RENAME_TRANSIENT_REASONS.has(reason)) return;
  armAutoRename(id, autoRenameDelay);
}

/** 挂一个到点开火的定时器（schedule 与瞬态重试共用同一条开火路径）。 */
function armAutoRename(id: Id, delay: number): void {
  autoRenameTimers.set(
    id,
    setTimeout(() => {
      autoRenameTimers.delete(id);
      void fireAutoRename(id);
    }, delay),
  );
}

/** 定时器到点：改一次名；被瞬态条件拦下就按短窗口重试（有上限），稳定失败才放弃。 */
async function fireAutoRename(id: Id): Promise<void> {
  const outcome = await autoRenameFromPlaceholder(id);
  if (outcome.status !== "skipped" || !outcome.reason || !AUTO_RENAME_TRANSIENT_REASONS.has(outcome.reason)) {
    autoRenameRetries.delete(id);
    return;
  }
  const tries = (autoRenameRetries.get(id) ?? 0) + 1;
  if (tries > AUTO_RENAME_MAX_RETRIES) {
    autoRenameRetries.delete(id);
    return;
  }
  autoRenameRetries.set(id, tries);
  armAutoRename(id, AUTO_RENAME_RETRY_MS);
}

/** 取消一篇笔记待执行的自动改名（重命名 / 删除 / 移动 / 离开笔记本时都要清）。 */
function cancelAutoRename(id: Id): void {
  const timer = autoRenameTimers.get(id);
  if (timer) clearTimeout(timer);
  autoRenameTimers.delete(id);
}

/**
 * 改名/移动之后，把这一份自动改名状态搬到新 id 上。
 *
 * 关键一条是**定时器按新路径重挂**：`remapIds()` 会改 `ui.tabs` / `ui.activeId`，
 * 而旧定时器的回调闭包里是旧 id —— 不重挂的话，5 秒后它会去改一个已经不存在（或已被
 * 别人占用）的路径。这里只搬键 + 重挂，不重新判定条件（到点时会拿最新状态再判一遍）。
 */
function moveAutoRenameState(oldId: Id, newId: Id, replace: (id: Id) => Id): void {
  const timer = autoRenameTimers.get(oldId);
  const wasInFlight = autoRenameInFlight.has(oldId);
  if (timer) {
    clearTimeout(timer);
    autoRenameTimers.delete(oldId);
  }
  // 「占位名出身」的键跟着笔记走：**自动改名之后必须留在集里**，否则用户第二次改标题
  // 时文件名不再跟随（那正是本次要修的缺陷）。用户显式重命名会在 `renameNote` 里先出集。
  //
  // 第二半（`|| isPlaceholderName(newId 的 stem)`）是安全网：只要**新名字本身就是占位名**，
  // 无条件入集。它与 `autoRenameContext()` 的 `|| isPlaceholderName(...)` 同一条口径，
  // 保证「名字是占位名 ⇒ 一定在候选集里」这条不变式不会因为某条搬键路径漏掉而破掉。
  if (placeholderOrigin.has(oldId) || isPlaceholderName(stripExtension(baseName(newId)))) {
    placeholderOrigin.delete(oldId);
    placeholderOrigin.add(newId);
  }
  remapKeyed(explicitRenamedAt, replace);
  remapKeyed(lastAutoRenameAt, replace);
  remapKeyed(editorComposing, replace);
  if (autoRenameInFlight.has(oldId)) {
    autoRenameInFlight.delete(oldId);
    autoRenameInFlight.add(newId);
  }
  // 只有「改名期间又被敲字」那一拍才有待执行的定时器需要重挂：那时 `remapIds` 会把
  // 它从旧 id 搬到新 id，5 秒后按新路径再判一次（内容可能又变了）。
  //
  // 注意**不要**无条件重挂：定时器一旦已经开火，`autoRenameFromPlaceholder()` 里
  // `cancelAutoRename(id)` 早就清过它了，这时再挂一个是多余的一拍 —— 它到点后会撞上
  // 「距上次自动改名不足 30 秒」而空跑，却把那 30 秒静默期白白续上一轮。
  if (timer || wasInFlight) {
    armAutoRename(newId, autoRenameDelay);
  }
}

/**
 * 文件真的没了：把它那一份自动改名状态一起清账
 * （删文件夹 / 彻底删除 / 清空回收站，与 `dropTitleOverrides` 同款谓词）。
 */
function dropAutoRenameState(within: (path: Id) => boolean): void {
  for (const [id, timer] of [...autoRenameTimers]) {
    if (!within(id)) continue;
    clearTimeout(timer);
    autoRenameTimers.delete(id);
  }
  for (const map of [explicitRenamedAt, lastAutoRenameAt, editorComposing]) {
    for (const id of [...map.keys()]) if (within(id)) map.delete(id);
  }
  for (const id of [...autoRenameInFlight]) if (within(id)) autoRenameInFlight.delete(id);
  for (const id of [...placeholderOrigin]) if (within(id)) placeholderOrigin.delete(id);
}

/**
 * 改名动作的**独立路径**（§2.6）。与 `renameNote()` 的唯一差别在第 11 步：
 * **不写 `titleOverride`、不写 `titlePinnedAt`、不 `flushMeta`**。
 *
 * 为什么这条差别是阻断级的：`refresh()` 是 `titleOverride ?? deriveTitle(...)`。
 * 复用 `renameNote()` 的话，第一次自动改名就把该笔记的「正文标题 → 文件名」通道
 * 永久锁死 —— 用户第二次改标题时文件名不再跟随，现象与修复前一模一样。
 */
export async function autoRenameFromPlaceholder(id: Id): Promise<AutoRenameOutcome> {
  const target = backend;
  const note = libraryStore.get().notes[id];
  const now = Date.now();
  const block = (reason: string): AutoRenameOutcome => {
    const outcome: AutoRenameOutcome = { at: now, from: id, to: null, status: "skipped", reason };
    autoRenameOutcomes.push(outcome);
    return outcome;
  };
  if (!target || !note) return block("没有打开的笔记本 / 笔记不存在");
  if (autoRenameInFlight.has(id)) return block("正在改名途中");

  const reason = shouldAutoRename(autoRenameContext(id, now)!);
  if (reason) return block(reason);

  const title = derivePlaceholderTitle(note.content)!;
  const clean = sanitizeName(title, "无标题");
  const requested = joinPath(parentPath(id), `${clean}${extName(id) || ".md"}`);
  if (requested === id) return block("与当前文件名相同（空操作）");

  const caseOnly = requested.toLowerCase() === id.toLowerCase();
  const taken = new Set(Object.keys(libraryStore.get().notes));
  taken.delete(id);
  autoRenameInFlight.add(id);
  cancelAutoRename(id);
  try {
    // 复用 `renameNote()` 的顺序：先 flush（否则 450ms 那个指向旧路径的定时器会把新内容
    // 写进一个已经不存在/已被别人占用的路径），再探测落点，再搬。
    await flushNote(id);
    const nextPath = caseOnly ? requested : await resolveAvailablePath(target, requested, taken, id);
    if (caseOnly) await moveCaseOnly(target, id, nextPath);
    else await target.move(id, nextPath);
    // ★ 必须在 `remapIds` **之前**摘掉「在途」标记：`moveAutoRenameState` 靠它判断
    //   「改名途中又被敲字、有一个待执行的定时器要按新路径重挂」。不摘的话，它会以为
    //   旧 id 上还挂着一个定时器，于是在新 id 上重挂一个 —— 那一拍到点后撞上
    //   「正在改名途中」，而且会把 30 秒节流重新计时（用户第二次改标题就再也不跟随了）。
    autoRenameInFlight.delete(id);
    // `remapIds` 会把改名期间敲进来的正文、dirty、writeTimers、ui.tabs/activeId 一起搬到新 id。
    remapIds(id, nextPath);
    await moveHistory(target, id, nextPath);
    // ★ 与 `renameNote()` 的**唯一**差别：只把派生标题同步到内存，**不写** override。
    //   `refresh()` 之后 `title` 仍由正文标题现算，所以下一次改标题文件名还会跟随。
    patchNotes((notes) => {
      const moved = notes[nextPath];
      if (!moved) return notes;
      return { ...notes, [nextPath]: { ...moved, title: deriveTitle(moved.content, stripExtension(baseName(nextPath))), titleOverride: null, updatedAt: Date.now() } };
    });
    // 防御性：正常路径下新 id 上不该有 pin（自动改名从不写它），有就清掉，免得它把
    // 之后的自动改名按 30 秒静默期一直拦住。
    //
    // 为什么敢在这里直接改 `meta`：上面那次 `remapIds()` 已经 `scheduleMeta(400)`，
    // 这份 meta 会被那次去抖写盘带上；这里不需要再排一个（多排一次只是多写一次文件）。
    // 判据：「防御分支」那条用例（先手工往 `state.json` 里塞一个 pin，再触发自动改名，
    // 断言改名后 `titlePinnedAt` 被清掉）。
    if (meta.titlePinnedAt?.[nextPath] !== undefined) {
      const next = { ...meta.titlePinnedAt };
      delete next[nextPath];
      meta = { ...meta, titlePinnedAt: Object.keys(next).length ? next : undefined };
    }
    lastAutoRenameAt.delete(id);
    lastAutoRenameAt.set(nextPath, Date.now());
    explicitRenamedAt.delete(id);
    const outcome: AutoRenameOutcome = { at: now, from: id, to: nextPath, status: "renamed", reason: clean };
    autoRenameOutcomes.push(outcome);
    return outcome;
  } catch (error) {
    reportError(error, "自动改名失败");
    const outcome: AutoRenameOutcome = {
      at: now,
      from: id,
      to: null,
      status: "skipped",
      reason: error instanceof Error ? error.message : String(error),
    };
    autoRenameOutcomes.push(outcome);
    return outcome;
  } finally {
    // 正常路径上这一句是空操作（成功分支已经在 `remapIds` 之前摘过标记）；失败时它保证
    // 「在途」标记不会把这篇笔记的自动改名永久卡住。
    autoRenameInFlight.delete(id);
  }
}

/* 测试缝：把停笔窗口改短（真实计时器下 5 秒太慢），用完由 `resetWorkspaceTransients()` 复位。 */
export function setAutoRenameDelayForTests(ms: number): void {
  autoRenameDelay = ms;
}

/**
 * 测试缝：清掉 30 秒节流与「刚显式重命名过」的静默期读数。
 *
 * 为什么必须有这条缝：这两张表的**语义就是「等 30 秒」**，而 30 秒的真实时间不可能塞进
 * 单测。要验证「第二次改标题文件名还会跟随」这条核心判据，就必须能把时间快进过去 ——
 * 与其把窗口改成可注入的假时钟（库里的 450ms/700ms/200ms 定时器会跟它打结），
 * 不如让测试显式声明「这 30 秒已经过去了」。
 */
export function resetAutoRenameHistoryForTests(id?: Id): void {
  if (id === undefined) {
    explicitRenamedAt.clear();
    lastAutoRenameAt.clear();
    return;
  }
  explicitRenamedAt.delete(id);
  lastAutoRenameAt.delete(id);
}

/** 本会话自动改名的读数（只读副本，测试与排查用）。 */
export function autoRenameOutcomeLog(): readonly AutoRenameOutcome[] {
  return autoRenameOutcomes;
}

/** 有没有待执行的自动改名定时器（测试用来证明「5 秒内再敲字 = 重排，不是并发两个改名」）。 */
export function hasPendingAutoRename(id: Id): boolean {
  return autoRenameTimers.has(id);
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
  // 占位名笔记的「停笔 5 秒落盘」：所有编辑入口都汇到这里（编辑器、快照恢复、剪藏追加前的
  // flush、导入），挂在别处就要挂多次。定时器**按笔记 id 独立**，与 `writeTimers` /
  // `scheduleMeta` 互不取消（一个是 450ms 的写盘、一个是 700ms 的元数据，语义完全不同）。
  // 回收站里的笔记不参与（`shouldAutoRename` 的条件 1 会拦掉）。
  scheduleAutoRename(id);
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

/**
 * 「这个名字是用户手定的」的**唯一写入点**（`renameNote`）。
 *
 * 自动改名（`autoRenameFromPlaceholder`）**不写这张表** —— 这是「正文标题 → 文件名」
 * 通道不被永久锁死的关键：pin 的存在意味着「用户手定过这个名字」，而自动改名写的是
 * 正文派生的名字，写进去就等于把用户的名字锁住了。
 */
function pinTitle(id: Id, at: number): void {
  meta = { ...meta, titlePinnedAt: { ...(meta.titlePinnedAt ?? {}), [id]: at } };
  scheduleMeta(400);
}

/** 文件真的没了：把它的显示名与 pin 一起清账（删文件夹 / 彻底删除 / 清空回收站）。 */
function dropTitleOverrides(within: (path: Id) => boolean): void {
  if (meta.titleOverrides) {
    const next: Record<Id, string> = {};
    for (const [path, title] of Object.entries(meta.titleOverrides)) {
      if (!within(path)) next[path] = title;
    }
    meta = { ...meta, titleOverrides: Object.keys(next).length ? next : undefined };
  }
  if (meta.titlePinnedAt) {
    const next: Record<Id, number> = {};
    for (const [path, at] of Object.entries(meta.titlePinnedAt)) {
      if (!within(path)) next[path] = at;
    }
    meta = { ...meta, titlePinnedAt: Object.keys(next).length ? next : undefined };
  }
  scheduleMeta(400);
}

export async function renameNote(id: Id, title: string): Promise<void> {
  const note = libraryStore.get().notes[id];
  const target = backend;
  if (!note || !target) return;
  const clean = sanitizeName(title, "无标题");
  const requested = joinPath(parentPath(id), `${clean}${extName(id) || ".md"}`);
  if (requested === id) return;
  // 用户显式改名 ⇒ 这篇笔记的自动改名必须立刻收手：取消待执行的定时器 + 打 30 秒静默期
  // 时间戳（否则「用户点了重命名 → 旧标题 5 秒后把名字顶回去」），并且**退出占位名出身**
  // （`titleOverride` 已经是永久停用，这里再退一层：用户手定的名字之后不再自动跟随）。
  cancelAutoRename(id);
  placeholderOrigin.delete(id);
  const renamedAt = Date.now();
  explicitRenamedAt.set(id, renamedAt);
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
    //
    // ★ 写的是**落盘名**（`nextPath` 的 stem），不是请求名 `clean`（方案 §2.6 第 1 点、
    //   §7.1 指定的断言）。撞名时两者会分叉：请求「系统设计」而磁盘上让位成
    //   `系统设计 2.md`，若把请求名写进 override，侧栏显示名是「系统设计」、磁盘叫
    //   `系统设计 2.md`，而 `refresh()` 是 `titleOverride ?? deriveTitle(...)` —— override
    //   赢，于是这个分叉**永久**存在（重扫也按 override 挂回「系统设计」）。
    const landed = stripExtension(baseName(nextPath));
    patchNotes((notes) => ({
      ...notes,
      [nextPath]: { ...notes[nextPath], title: landed, titleOverride: landed, updatedAt: Date.now() },
    }));
    setTitleOverride(nextPath, landed);
    // 「这个名字是用户手定的」的来源标记：与 `titleOverrides` 一一对应，跟着键走。
    pinTitle(nextPath, renamedAt);
    explicitRenamedAt.delete(id);
    explicitRenamedAt.set(nextPath, renamedAt);
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
    cancelAutoRename(id);
    await flushNote(id);
    const nextPath = await resolveAvailablePath(target, requested, taken, id);
    // Same file, only the folder name differs in casing: it is already there.
    if (nextPath.toLowerCase() === id.toLowerCase()) return NO_MOVE;
    await target.move(id, nextPath);
    remapIds(id, nextPath);
    await moveHistory(target, id, nextPath);
    // 换目录 = 引用前缀变了 ⇒ 把指向共享 `.assets/` 的引用按新位置重算（图片本身不搬）。
    const assets = await rebaseNoteAssets(target, id, nextPath);
    if (assets.content) patchNoteContent(nextPath, assets.content);
    return { path: nextPath, assetsWarning: assets.warning };
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
 * 图片**不再跟着笔记搬**（0.4.0 用户裁定：整库共用一个 `.assets/`，git 里只有一个附件目录）。
 *
 * 取而代之的是**改写正文引用**：笔记换了目录层数，`../../.assets/x.png` 这段前缀就得跟着变，
 * 否则「编辑器里能显示、搬一次变裂图」——而且不报错。
 *
 * 两条护栏：
 *   1. **同目录改名不动一个字**（层数没变、前缀没变）——绝大多数改名走这条，零风险；
 *   2. 只改**字面指向 `.assets/`** 的引用（`rebaseSharedAssetRefs`）：旧布局
 *      （`<笔记名>.assets/…`、公共 `assets/<笔记名>/…`）一格不碰，旧数据零迁移。
 *
 * 返回值：`content` = **新的正文**（没变 = `null`）；`warning` = 必须如实告诉用户的那句话
 * （写盘/读盘失败时非空，绝不假装成功）。
 */
async function rebaseNoteAssets(
  target: FileSystemBackend,
  fromNote: Id,
  toNote: Id,
): Promise<{ content: string | null; warning: string | null }> {
  const nothing = { content: null, warning: null };
  if (fromNote === toNote) return nothing;
  if (parentPath(fromNote) === parentPath(toNote)) return nothing;
  const content = await readOptionalText(target, toNote).catch(() => undefined);
  if (content === undefined) {
    // 读不到就什么都不做：笔记文件已经搬好了，引用最多维持原样，不会更坏。
    return { content: null, warning: `图片引用没能随笔记更新（读不到 ${toNote}）` };
  }
  const next = rebaseSharedAssetRefs(content, toNote);
  if (next === content) return nothing;
  try {
    await target.writeText(toNote, next);
  } catch (error) {
    reportError(error, "图片引用未更新");
    return { content: null, warning: `图片引用没能随笔记更新：${toNote}` };
  }
  return { content: next, warning: null };
}

export async function trashNote(id: Id): Promise<void> {
  const note = libraryStore.get().notes[id];
  const target = backend;
  if (!note || !target) return;
  const requested = joinPath(TRASH_DIR, id);
  const taken = new Set(Object.keys(libraryStore.get().trash));
  try {
    cancelAutoRename(id);
    await flushNote(id);
    const trashPath = await resolveAvailablePath(target, requested, taken, id);
    await target.move(id, trashPath);
    await moveHistory(target, id, trashPath);
    // 「占位名出身」跟着进回收站。**必须搬**，不能留在旧的工作区路径上：一次重扫
    // （桌面端文件监听 500ms 就会来）的 `originBefore` 只保住「还存在的 id」，留在旧路径
    // 的那一条会被丢掉，还原之后这篇笔记再也不自动改名 —— 与本次要修的缺陷同一现象。
    if (placeholderOrigin.has(id)) {
      placeholderOrigin.delete(id);
      placeholderOrigin.add(trashPath);
    }
    // 回收站比工作区深两层 ⇒ 指向共享 `.assets/` 的引用要跟着加前缀，
    // 否则「删了再恢复」或「在回收站里看一眼」时图片全是裂图（而且不报错）。
    const assets = await rebaseNoteAssets(target, id, trashPath);
    // 显示名的键跟到回收站路径下：重扫时回收站里的这一条也要保持用户改过的名字。
    moveTitleOverride(id, trashPath);
    const current = libraryStore.get().notes[id] ?? note;
    setState((prev) => {
      const notes = { ...prev.notes };
      delete notes[id];
      return {
        ...prev,
        notes,
        trash: {
          ...prev.trash,
          [trashPath]: {
            ...current,
            content: assets.content ?? current.content,
            id: trashPath,
            trashed: true,
            trashedAt: Date.now(),
          },
        },
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
    cancelAutoRename(id);
    await flushAll();
    const nextPath = await resolveAvailablePath(target, original, taken, id);
    await target.move(id, nextPath);
    await moveHistory(target, id, nextPath);
    const sourceAssets = joinPath(parentPath(id), ASSETS_DIR);
    const restoredAssets = joinPath(parentPath(nextPath), ASSETS_DIR);
    if (await target.exists(sourceAssets) && !(await target.exists(restoredAssets))) {
      await target.move(sourceAssets, restoredAssets);
    }
    // 共享 `.assets/` 的引用按恢复后的路径重算前缀（回收站深两层，回来就要去掉）。
    const assets = await rebaseNoteAssets(target, id, nextPath);
    // 恢复后的路径可能带序号（`第一章 2.md`）：显示名的键跟着落到最终路径上。
    moveTitleOverride(id, nextPath);
    // 「占位名出身」从回收站路径（或它来时的路径）搬到最终路径上。两条判据都要：
    //   ① `placeholderOrigin` 里有回收站路径或它原来的路径 —— 覆盖「已经被自动改名过、
    //      名字不再是占位名」的笔记（这类笔记的名字必须继续跟随正文标题）；
    //   ② 还原后的 stem 本身就是占位名 —— 覆盖「丢过一次标记」的现场。
    // 不补这一步的话，用户把一篇占位名笔记丢进回收站再还原，它之后**再也不会**自动改名。
    const carriedOrigin = placeholderOrigin.has(id) || placeholderOrigin.has(original);
    if (carriedOrigin || isPlaceholderName(stripExtension(baseName(nextPath)))) {
      placeholderOrigin.delete(id);
      placeholderOrigin.add(nextPath);
    }
    setState((prev) => {
      const trash = { ...prev.trash };
      delete trash[id];
      return {
        ...prev,
        trash,
        notes: {
          ...prev.notes,
          [nextPath]: {
            ...note,
            content: assets.content ?? note.content,
            id: nextPath,
            folderId: parentPath(nextPath) || null,
            trashed: false,
            trashedAt: null,
          },
        },
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
 * Snapshots and the note's own images used to outlive the note (D16).
 *
 * 三处各自清算，顺序就是「最专属 → 最公共」：
 *   1. 前像目录（`history/<id>`）—— 只属于这一篇，直接删；
 *   2. **旧布局**的 `<笔记名>.assets/` —— 也只属于这一篇（它是按笔记名派生的），跟着删；
 *   3. **共享 `.assets/`** —— 这里**只删这篇笔记正文真正引用的那些文件**。
 *      曾经这里是 `remove(assetsDirFor(id), { recursive: true })`：落点改成整库一个
 *      `.assets/` 之后，那句话的含义就变成「删掉这一整本笔记的图片」——**别人的图一起没**。
 *      所以必须按引用挑（`sharedAssetFilesIn`），而且别的笔记也引用同一个文件时**不删**。
 *   4. 老的公共 `<目录>/assets/`：只有那个目录里没有别的笔记时才收（图可能是邻居的）。
 */
async function removeNoteArtifacts(target: FileSystemBackend, id: Id): Promise<void> {
  const history = joinPath(HISTORY_DIR, id);
  if (await target.exists(history)) await target.remove(history, { recursive: true });

  // 旧布局的自有附件目录（按笔记名派生）：笔记真删了它就该消失，否则回收站里永远留着孤儿图片。
  const stem = sanitizeName(stripExtension(baseName(id)), "未命名");
  const legacyOwn = joinPath(parentPath(id), `${stem}.assets`);
  if (await target.exists(legacyOwn)) await target.remove(legacyOwn, { recursive: true });

  await removeSharedAssetsOfNote(target, id);

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

/**
 * 共享 `.assets/` 里属于**这一篇**的文件：正文引用得到、且没有别的笔记也引用同一个文件。
 *
 * 「别的笔记也引用」这一条是必要的：复制笔记（`duplicateNote`）与手工复用都会让两篇笔记
 * 指向同一个文件，按引用删就会把还活着的那篇的图删掉。邻居的正文就在内存里（`content`），
 * 判断是白拿的。
 */
async function removeSharedAssetsOfNote(target: FileSystemBackend, id: Id): Promise<void> {
  const state = libraryStore.get();
  const note = state.notes[id] ?? state.trash[id];
  if (!note) return;
  const dir = assetsDirFor();
  if (!(await target.exists(dir))) return;
  const mine = sharedAssetFilesIn(note.content);
  if (!mine.length) return;
  const others = new Set<string>();
  for (const item of [...Object.values(state.notes), ...Object.values(state.trash)]) {
    if (item.id === id) continue;
    for (const file of sharedAssetFilesIn(item.content)) others.add(file);
  }
  for (const file of mine) {
    if (others.has(file)) continue;
    try {
      await target.remove(joinPath(dir, file));
    } catch {
      /* 已经不在了：按「删过了」处理，不报错 */
    }
  }
  try {
    const left = await target.list(dir);
    if (!left.length) await target.remove(dir);
  } catch {
    /* 目录已经没了：不是失败 */
  }
}

export async function purgeNote(id: Id): Promise<void> {
  const target = backend;
  if (!target) return;
  try {
    await target.remove(id, { recursive: true });
    await removeNoteArtifacts(target, id);
    dropTitleOverrides((path) => path === id);
    dropAutoRenameState((path) => path === id);
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
    dropAutoRenameState((path) => path === TRASH_DIR || path.startsWith(`${TRASH_DIR}/`));
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
  fileStates.remap(replace);
  remapKeyed(lastSnapshotAt, replace);
  // 自动改名的状态也跟着走：定时器**必须按新路径重挂**（旧 id 上那个定时器的回调闭包
  // 指向的是一个已经不存在的路径），静默期/光标行/合成状态同理。
  moveAutoRenameState(oldId, newId, replace);
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
    // pin 与 `titleOverrides` 一一对应，必须在同一处做键替换，否则两张表会指不同的路径。
    titlePinnedAt: meta.titlePinnedAt
      ? Object.fromEntries(Object.entries(meta.titlePinnedAt).map(([path, at]) => [replace(path), at]))
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

/**
 * 把一篇笔记的**祖先目录链全部展开**（0.4.0 用户要求：从搜索结果点开一篇笔记时，
 * 左侧目录层级也要跟着打开 —— 不然「这篇是从哪个目录来的」在树里看不到）。
 *
 * 用 `folderPath()` 走 `parentId` 链（文件夹 id 不是路径，不能靠字符串切分），
 * 逐个 `expandFolder()`：它同时维护 `ui.expanded` 与 `state.json` 的 meta，
 * 是「展开一个目录」的唯一实现，不在这里另写一份。
 */
export function revealNoteInTree(id: Id): void {
  const state = libraryStore.get();
  const note = state.notes[id] ?? state.trash[id];
  if (!note || !note.folderId) return;
  for (const folder of folderPath(note.folderId, state.folders)) expandFolder(folder.id);
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

export interface FolderSearchHit {
  folder: Folder;
  /** 工作区相对路径（含自身名字），给次行展示。 */
  path: string;
  /** 文件夹里（含子树）的笔记数，给次行展示。 */
  notes: number;
}

/**
 * 按**文件夹名**搜索（0.4.0 用户建议）。与 `searchNotes` 同一套打分习惯：
 * 名字里命中比路径里命中高分，越靠前越高分；多关键词是 AND。
 * 只有一个调用方（侧栏搜索页），上限给小值就够 —— 文件夹本来就少。
 */
export function searchFolders(query: string, options: { limit?: number } = {}): FolderSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const limit = options.limit ?? 12;
  const state = libraryStore.get();
  const terms = q.split(/\s+/).filter(Boolean);
  const raw: { folder: Folder; score: number }[] = [];

  for (const folder of Object.values(state.folders)) {
    const name = folder.name.toLowerCase();
    const path = folderPathLabel(folder.id, state.folders).toLowerCase();
    let score = 0;
    let matchedAll = true;
    for (const term of terms) {
      const inName = name.indexOf(term);
      const inPath = path.indexOf(term);
      if (inName < 0 && inPath < 0) {
        matchedAll = false;
        break;
      }
      if (inName >= 0) score += 60 - Math.min(30, inName);
      else score += 20;
    }
    if (!matchedAll) continue;
    score += Math.max(0, 8 - Math.floor((Date.now() - folder.updatedAt) / 86_400_000));
    raw.push({ folder, score });
  }

  return raw
    .sort((a, b) => b.score - a.score || a.folder.name.localeCompare(b.folder.name, "zh-Hans-CN"))
    .slice(0, limit)
    .map((entry) => ({
      folder: entry.folder,
      path: folderPathLabel(entry.folder.id, state.folders),
      notes: folderStats(state, entry.folder.id).notes,
    }));
}

export function foldersArray(state: LibraryState = libraryStore.get()): Folder[] {
  return Object.values(state.folders);
}

/**
 * 过滤（搜索 / 筛选）时**文件树里可见的东西**：命中的笔记 + 要显示的目录。
 *
 * 为什么是「集合」而不是「另一套搜索结果组件」：用户原话「直接使用原来的那一份加个筛选就行了」——
 * 侧栏只应该有一棵树（`TreeBody`/`FolderBranch`），过滤只是给它一个可见集合：
 * 命中的笔记照常渲染在**它们真实的目录层级**里，目录行仍是树上那一行（真 caret、能展开能收缩）。
 *
 * 两类命中都收进来：
 *   - 正文/标题/标签命中（`searchNotes`）→ 笔记 + 它的**祖先目录链**（`folderPath`）；
 *   - **文件夹名命中**（`searchFolders`）→ 那个目录 + 它的直接笔记（搜「操作系统」时想看的是
 *     那个目录里的东西，而不是「没有找到」）。
 *
 * 返回 `null` = 没有查询词（调用方据此渲染未过滤的整棵树）。
 */
export function treeFilterFor(query: string): { notes: Set<Id>; folders: Set<Id> } | null {
  const text = query.trim();
  if (!text) return null;
  const state = libraryStore.get();
  const notes = new Set<Id>();
  const folders = new Set<Id>();

  for (const hit of searchNotes(text)) {
    notes.add(hit.note.id);
    if (!hit.note.folderId) continue;
    for (const folder of folderPath(hit.note.folderId, state.folders)) folders.add(folder.id);
  }
  for (const hit of searchFolders(text)) {
    for (const folder of folderPath(hit.folder.id, state.folders)) folders.add(folder.id);
    for (const note of Object.values(state.notes)) {
      if (note.folderId === hit.folder.id) notes.add(note.id);
    }
  }
  return { notes, folders };
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
        : entry.name.includes("-before-disk")
          ? "before-disk"
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
 * 第三参是**最终笔记路径**（`归档/foo 2.md`），不是笔记所在目录 —— 引用要按**笔记所在目录**
 * 到共享附件目录的层数现算（`relativeAssetRef`：`归档/foo 2.md` + `.assets/x.png`
 * → `../.assets/x.png`）。旧数据不迁移：老笔记的图仍在 `<笔记名>.assets/` 或公共
 * `<目录>/assets/` 里，正文照旧引用，照样能读。
 *
 * 去重语义与剪藏落点 `allocateAssetPath`（`src/lib/clip/landing.ts`）**逐条一致**：
 * 1. `.assets/<内容 uuid>.<ext>` 不存在 → 写它；
 * 2. 已存在 + **字节相同** → **复用**（不写、不改 mtime），返回同一个路径 ——
 *    「同一张图连粘两次只留一个文件」；
 * 3. 已存在 + 字节不同 → 按 `-2`、`-3`… 让位（**绝不静默覆盖**）。
 *
 * 为什么不能再用 `uniquePath`：它只认**文件名清单**、从不比对字节，于是第二次粘贴同一张图时
 * `assetFinalName` 明明算出了同一个 uuid，却被推成 `X 2.png`（` 2` 带空格 ⇒ 引用还得退化成
 * `<…>` 角括号形式）。序号形态统一成 `-2` 的理由见 `allocateAssetPath`（空格会截断链接目标）。
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
   * 附件引用是按笔记**所在目录**算前缀的，传目录进来会算出少一层的前缀，编译通过、
   * 类型检查通过、单测也可能照样绿，只有用户会发现图片是裂图。
   * 这类「静默接错来源」正是本轮 P0 的根因形态（`body: payload.body` 那次）。
   * 所以把一个**语义**约束写成一条**运行期**断言：错了就大声报，绝不猜。
   */
  if (!isMarkdownPath(notePath)) {
    throw new Error(`saveImage 的第三参必须是笔记路径（如 归档/foo.md），收到的是「${notePath || "(空)"}」`);
  }
  const target = requireBackend();
  const dir = assetsDirFor();
  /*
   * 粘贴/拖进来的图与剪藏落盘的图**同一套命名规则**（`assetFinalName`，唯一产地）：
   * `<内容派生的 uuid>.<ext>`。0.4.0 用户原话「复制过来的默认路径不对，默认为 …uuid 命名即可」——
   * 名字里不再出现原始文件名（截图会叫 `图片-1738…png`、网页图会带一长串 URL 片段）。
   */
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const candidate = joinPath(dir, await assetFinalName(bytes, suggestedName));
  const path = await reuseOrDedupe(target, candidate, bytes);
  if (!(await target.exists(path))) await target.writeBytes(path, bytes);
  // 引用从**笔记所在目录**算到附件路径（`relativeAssetRef`，唯一产地），不在这里手拼一层前缀：
  // 笔记嵌在 `操作系统/产品/` 里就该是 `../../.assets/x.png`，少一层就是裂图。
  // 目标串再过一次 `markdownRef`：路径带空格时写成 `<…>`，否则会被**空格截断**、图片不渲染。
  return { path, markdown: markdownRef(relativeAssetRef(notePath, path)) };
}

/**
 * `candidate` 能用就用它，否则让位成 `-2`、`-3`…（上限与剪藏路径的 `allocateAssetPath` 相同）。
 *
 * 判据是**字节**，不是「文件在不在」：
 * - 不存在 → `candidate`（调用方随后写它）；
 * - 存在且字节相同 → `candidate`（调用方**不**重写：复用不产生新文件、不动 mtime）；
 * - 存在且字节不同 → 第一个可用的 `-N`（绝不覆盖别人的图）。
 */
async function reuseOrDedupe(target: FileSystemBackend, candidate: string, bytes: Uint8Array): Promise<string> {
  const existing = await target.readBytes(candidate).catch(() => null);
  if (existing === null || sameBytes(existing, bytes)) return candidate;
  for (let index = 2; index <= 52; index += 1) {
    const next = dedupePath(candidate, index);
    if (await target.exists(next)) continue;
    return next;
  }
  throw new Error(`附件目录里同名文件太多，放弃去重：${candidate}`);
}

/** `foo/a1b2-x.png` + 3 → `foo/a1b2-x-3.png`（扩展名之前插序号，与剪藏路径同一形态）。 */
function dedupePath(candidate: string, index: number): string {
  const ext = extName(candidate);
  return ext ? `${candidate.slice(0, candidate.length - ext.length)}-${index}${ext}` : `${candidate}-${index}`;
}


/* ------------------------------------------------------------------ bootstrap */

/** Seed a brand-new workspace with the welcome note (awaits the disk write). */
export async function seedWelcome(content: string, title = "欢迎来到 Opennote"): Promise<Note> {
  const note = createNote({ folderId: null, content, title });
  await flushNote(note.id);
  return note;
}

export { uid, formatStamp };
