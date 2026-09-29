/**
 * 导入的可撤销前像、导入日志与幂等索引（契约 §3.3.4 / §4.3 / 00 号 §6.10①）。
 *
 * 三份数据都在 `.opennote/` 下，都由**渲染层**写（与 `.opennote/state.json` 同一条写盘路径）：
 *
 * | 文件 | 作用 | 上限 |
 * | --- | --- | --- |
 * | `.opennote/import-preimages/<importId>.md` | 逐字节前像本体（撤销依赖它） | 与日志同源：500 |
 * | `.opennote/import-log.json` | 前像元数据 + 操作类型 + `undoneAt` | 500 条 |
 * | `.opennote/import-index.json` | 幂等与去重索引 | 2000 条 |
 *
 * **为什么前像不放 `.opennote/history/`**（00 号 §6.10① 裁定）：`history/` 是版本快照域，
 * 有既成的保留策略（自动快照上限 60 份、导出整库 zip 的 `includeHistory` 可整体排除）。
 * 把撤销依赖的前像放进去，等于把「可恢复性」交给另一套无关的保留策略 —— 快照被清理或
 * 不被导出时，撤销会静默失效。历史快照还有约 3 分钟节流（`src/data/library.ts:99`），
 * 两次连续追加之间不保证产生新快照，**不得**用它顶替前像。
 *
 * 写盘方式：三种后端的 `writeText` 本身已经是「先写临时文件、再覆盖目标」（node 走主进程的
 * tmp+rename，fsa/opfs 走 `writeFileSafely`，见 `src/data/library.ts:843` 的 D10 注释）。
 * 所以一次 `writeText` 就等价于 tmp + move 的加固 —— 而 `move` **不覆盖已存在的目标**，
 * 拿 tmp+move 写第二遍是注定失败的调用，别用。
 */

import { baseName, joinPath, stripExtension } from "../fs/paths";
import type { FileSystemBackend } from "../fs/types";
import { sha256Ref } from "../lib/clip/hash";
import { currentBackend, libraryStore } from "./library";

/** 前像本体目录。**不得**放在 `.opennote/history/` 之下（00 号 §6.10①）。 */
export const PREIMAGE_DIR = ".opennote/import-preimages";
export const IMPORT_LOG_FILE = ".opennote/import-log.json";
export const IMPORT_INDEX_FILE = ".opennote/import-index.json";
/** 日志与前像**同源**清理的上限：删日志条目时同步删对应前像。 */
export const LOG_LIMIT = 500;
/** 幂等索引上限（约一个重度用户两年的剪藏量，≈800 KB）。 */
export const INDEX_LIMIT = 2000;

export type ImportOp = "created" | "appended" | "overwritten" | "duplicate" | "deduped" | "pending" | "skipped";

export interface ImportLogEntry {
  importId: string;
  op: ImportOp;
  path: string;
  preimagePath: string | null;
  preimageBytes: number;
  preimageSha256: string | null;
  revertible: boolean;
  at: string;
  undoneAt: string | null;
}

export interface ImportLogInput {
  importId: string;
  op: ImportOp;
  path: string;
  preimagePath?: string | null;
  preimageBytes?: number;
  preimageSha256?: string | null;
  revertible?: boolean;
  at?: string;
  undoneAt?: string | null;
}

export interface ImportLogFile {
  version: 1;
  updatedAt: string;
  entries: ImportLogEntry[];
}

/** 幂等索引条目字段逐字来自契约 §4.3.1。 */
export interface ImportIndexEntry {
  importId: string;
  path: string;
  title: string;
  sourceUrl: string | null;
  site: string | null;
  publishedAt: string | null;
  selection: boolean;
  sourceHash: string;
  bodyHash: string;
  contentHash: string;
  tags: string[];
  client: string;
  at: string;
  action: string;
}

export interface ImportIndexFile {
  version: 1;
  updatedAt: string;
  entries: ImportIndexEntry[];
}

/* ============================== 基础设施 ============================== */

export function nowIso(at: number = Date.now()): string {
  return new Date(at).toISOString();
}

function requireBackend(): FileSystemBackend {
  const backend = currentBackend();
  if (!backend) throw new Error("还没有打开任何笔记本文件夹");
  return backend;
}

async function readJson<T>(backend: FileSystemBackend, path: string): Promise<T | null> {
  try {
    if (!(await backend.exists(path))) return null;
    return JSON.parse(await backend.readText(path)) as T;
  } catch (error) {
    // 解析失败 = 损坏：调用方按「空文件」继续（契约 §4.3.2 的精神：以磁盘为准、
    // 不让损坏的元数据挡住用户的正文）。
    console.warn("[opennote] 导入元数据无法解析，已按空文件继续", path, error);
    return null;
  }
}

async function writeJson(backend: FileSystemBackend, path: string, value: unknown): Promise<void> {
  await backend.writeText(path, `${JSON.stringify(value, null, 2)}\n`);
  // 清掉旧方案（tmp + move）可能留在磁盘上的临时文件；缺失时静默忽略。
  await backend.remove(`${path}.tmp`).catch(() => undefined);
}

/* ================================ 前像 ================================ */

export interface PreimageOptions {
  importId?: string;
  backend?: FileSystemBackend;
}

function preimageToken(notePath: string, importId?: string): string {
  const name = importId
    ? `${importId.replace(/[^A-Za-z0-9_-]/g, "-")}.md`
    : `${baseName(stripExtension(notePath)) || "preimage"}-${Date.now().toString(36)}.md`;
  return joinPath(PREIMAGE_DIR, name);
}

/**
 * 写入**逐字节**前像，返回前像 token（工作区相对路径）。
 * 失败时抛错：调用方据此把回执的 `revertible` 置 `false` 并回 `IMP-W008`
 * （`overwrite` 则直接降级为 `new`）。
 */
export async function writePreimage(notePath: string, bytes: Uint8Array, options: PreimageOptions = {}): Promise<string> {
  const backend = options.backend ?? requireBackend();
  const token = preimageToken(notePath, options.importId);
  await backend.mkdir(PREIMAGE_DIR);
  await backend.writeBytes(token, bytes);
  return token;
}

/** 读取前像字节；token 必须落在 `PREIMAGE_DIR` 之下（不接受任意路径）。 */
export async function readPreimage(token: string, backend: FileSystemBackend | null = currentBackend()): Promise<Uint8Array | null> {
  const target = backend ?? requireBackend();
  if (!token || !token.startsWith(`${PREIMAGE_DIR}/`)) return null;
  try {
    if (!(await target.exists(token))) return null;
    return await target.readBytes(token);
  } catch (error) {
    console.warn("[opennote] 前像无法读取", token, error);
    return null;
  }
}

/** 前像的 `sha256:<16 hex>` 摘要（回执与日志用）。 */
export async function preimageRef(bytes: Uint8Array): Promise<string> {
  return sha256Ref(bytes);
}

/** 删除一个前像文件；不存在时静默忽略。 */
export async function removePreimage(token: string | null, backend: FileSystemBackend | null = currentBackend()): Promise<void> {
  if (!token || !backend || !token.startsWith(`${PREIMAGE_DIR}/`)) return;
  await backend.remove(token).catch(() => undefined);
}

/* ============================== 日志读写 ============================== */

function normalizeLogEntry(input: ImportLogInput): ImportLogEntry {
  return {
    importId: input.importId,
    op: input.op,
    path: input.path,
    preimagePath: input.preimagePath ?? null,
    preimageBytes: input.preimageBytes ?? 0,
    preimageSha256: input.preimageSha256 ?? null,
    revertible: input.revertible ?? false,
    at: input.at ?? nowIso(),
    undoneAt: input.undoneAt ?? null,
  };
}

export async function readImportLogFile(backend: FileSystemBackend = requireBackend()): Promise<ImportLogFile> {
  const parsed = await readJson<ImportLogFile>(backend, IMPORT_LOG_FILE);
  const entries = Array.isArray(parsed?.entries) ? parsed.entries.filter((entry) => entry && typeof entry.importId === "string") : [];
  return { version: 1, updatedAt: parsed?.updatedAt ?? nowIso(), entries };
}

/** 日志条目，**按 `at` 倒序**（最新的在前）。 */
export async function readImportLog(backend?: FileSystemBackend): Promise<ImportLogEntry[]> {
  const file = await readImportLogFile(backend ?? requireBackend());
  return file.entries;
}

export async function findImportLogEntry(importId: string, backend?: FileSystemBackend): Promise<ImportLogEntry | null> {
  const entries = await readImportLog(backend);
  return entries.find((entry) => entry.importId === importId) ?? null;
}

/**
 * 追加一条日志。**超出 500 条时丢弃最旧的条目并同步删除其前像文件** ——
 * 两件事必须在同一次操作里完成（只删日志或只删前像都会留下隐患）。
 */
export async function recordImport(entry: ImportLogInput, backend?: FileSystemBackend): Promise<ImportLogEntry> {
  const target = backend ?? requireBackend();
  const file = await readImportLogFile(target);
  const next = normalizeLogEntry(entry);
  const entries = [next, ...file.entries.filter((item) => item.importId !== next.importId)];
  await persistLog(target, entries);
  return next;
}

/** 撤销后打标记（保留记录便于排障，不删行）。 */
export async function markImportUndone(importId: string, at: string = nowIso(), backend?: FileSystemBackend): Promise<boolean> {
  const target = backend ?? requireBackend();
  const file = await readImportLogFile(target);
  let changed = false;
  const entries = file.entries.map((entry) => {
    if (entry.importId !== importId) return entry;
    changed = true;
    return { ...entry, undoneAt: at };
  });
  if (!changed) return false;
  await persistLog(target, entries);
  return true;
}

/** 写入日志并按 500 条上限清理（前像同源删除）。 */
async function persistLog(backend: FileSystemBackend, entries: ImportLogEntry[]): Promise<void> {
  const kept = entries.slice(0, LOG_LIMIT);
  const dropped = entries.slice(LOG_LIMIT);
  for (const entry of dropped) {
    // 仍被保留条目引用的前像不能删（同名 token 可能被多条日志引用）。
    if (entry.preimagePath && !kept.some((item) => item.preimagePath === entry.preimagePath)) {
      await removePreimage(entry.preimagePath, backend);
    }
  }
  await writeJson(backend, IMPORT_LOG_FILE, { version: 1, updatedAt: nowIso(), entries: kept });
}

/** 按上限清理前像与日志；返回被清掉的条目数。 */
export async function prunePreimages(backend?: FileSystemBackend): Promise<number> {
  const target = backend ?? requireBackend();
  const file = await readImportLogFile(target);
  if (file.entries.length <= LOG_LIMIT) return 0;
  const dropped = file.entries.slice(LOG_LIMIT);
  await persistLog(target, file.entries);
  return dropped.length;
}

/* ============================== 幂等索引 ============================== */

interface IndexCache {
  backend: FileSystemBackend;
  byId: Map<string, ImportIndexEntry>;
  byContent: Map<string, ImportIndexEntry>;
  byUrl: Map<string, ImportIndexEntry>;
  entries: ImportIndexEntry[];
}

let cache: IndexCache | null = null;

function contentKey(sourceUrl: string | null, bodyHash: string): string {
  return `${sourceUrl ?? ""}\u0000${bodyHash}`;
}

function emptyCache(backend: FileSystemBackend): IndexCache {
  return { backend, byId: new Map(), byContent: new Map(), byUrl: new Map(), entries: [] };
}

/** 工作区切换（后端对象变化）或测试收尾时丢弃内存索引。 */
export function resetImportIndexCache(): void {
  cache = null;
}

/** §4.3.3 的降级路径：索引丢了，但 front-matter 里的 `opennote_import_id` 还在。 */
export function seedImportIndexFromNotes(backend: FileSystemBackend): number {
  const notes = libraryStore.get().notes;
  const target = cache && cache.backend === backend ? cache : emptyCache(backend);
  let seeded = 0;
  for (const [path, note] of Object.entries(notes)) {
    const content = note?.content ?? "";
    const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    if (!match) continue;
    const front = match[1];
    const idMatch = /^opennote_import_id:\s*(.+)$/m.exec(front);
    if (!idMatch) continue;
    const importId = idMatch[1].trim().replace(/^["']|["']$/g, "");
    if (!importId || target.byId.has(importId)) continue;
    const urlMatch = /^source:\s*(.+)$/m.exec(front);
    const url = urlMatch ? urlMatch[1].trim().replace(/^["']|["']$/g, "") : "";
    const entry: ImportIndexEntry = {
      importId,
      path,
      title: note.title ?? "",
      sourceUrl: url || null,
      site: null,
      publishedAt: null,
      selection: false,
      sourceHash: "",
      bodyHash: "",
      contentHash: "",
      tags: Array.isArray(note.tags) ? note.tags : [],
      client: "manual",
      at: nowIso(note.updatedAt ?? Date.now()),
      action: "created",
    };
    target.byId.set(importId, entry);
    target.entries.push(entry);
    seeded += 1;
  }
  cache = target;
  return seeded;
}

function reindex(target: IndexCache, entries: ImportIndexEntry[]): void {
  target.entries = entries;
  target.byId = new Map();
  target.byContent = new Map();
  target.byUrl = new Map();
  for (const entry of entries) {
    if (!target.byId.has(entry.importId)) target.byId.set(entry.importId, entry);
    if (entry.bodyHash) {
      const key = contentKey(entry.sourceUrl, entry.bodyHash);
      if (!target.byContent.has(key)) target.byContent.set(key, entry);
    }
    if (entry.sourceUrl) {
      const key = entry.sourceUrl;
      if (!target.byUrl.has(key)) target.byUrl.set(key, entry);
    }
  }
}

async function loadIndex(backend: FileSystemBackend = requireBackend()): Promise<IndexCache> {
  if (cache && cache.backend === backend) return cache;
  const parsed = await readJson<ImportIndexFile>(backend, IMPORT_INDEX_FILE);
  const target = emptyCache(backend);
  const entries = Array.isArray(parsed?.entries)
    ? parsed.entries.filter((entry) => entry && typeof entry.importId === "string" && typeof entry.path === "string")
    : [];
  reindex(target, entries);
  cache = target;
  if (!entries.length) {
    // 索引缺失/为空：用扫描时已在内存里的正文重建会话级索引（§4.3.3）。
    seedImportIndexFromNotes(backend);
  }
  return cache;
}

/** 磁盘上的原始索引条目（`at` 倒序）。 */
export async function readImportIndex(backend?: FileSystemBackend): Promise<ImportIndexEntry[]> {
  const target = await loadIndex(backend ?? requireBackend());
  return target.entries;
}

/** 同 `importId` → 首次落点（判定链第 1 步）。 */
export async function lookupImportById(importId: string): Promise<ImportIndexEntry | null> {
  const target = await loadIndex();
  return target.byId.get(importId) ?? null;
}

/** 同 `source.url` 且同 `bodyHash` → 判为重复（判定链第 2 步）。`url: null` 视为同一个空来源。 */
export async function lookupImportByContent(sourceUrl: string | null, bodyHash: string): Promise<ImportIndexEntry | null> {
  const target = await loadIndex();
  return target.byContent.get(contentKey(sourceUrl, bodyHash)) ?? null;
}

/**
 * 同 `source.url` 的既有笔记（`append` 的目标解析顺序第 2 步）。
 *
 * **`url: null` 一律返回 `null`，这是刻意的**（00 §6.8⑦ / §4.1 推论 5 的读法）：第 3/4 步的前提是
 * 「同一个来源 URL」，而「没有 URL」不是一种来源。若把 `null` 当成可追加来源，两次无关的
 * AI/CLI「记录一下这段文字」（正文不同）就会被**静默追加到一起** —— 那是毁内容，比多出一篇
 * 新笔记严重得多。所以 `null` 只在第 2 步（同正文哈希 → `duplicate`）参与判定，第 3/4 步
 * 不命中 → 落到第 6 步新建。
 */
export async function lookupLatestBySourceUrl(sourceUrl: string | null): Promise<ImportIndexEntry | null> {
  if (!sourceUrl) return null;
  const target = await loadIndex();
  return target.byUrl.get(sourceUrl) ?? null;
}

/** 已记住的 `contentHash`（仅用于异常提示，不参与判定）。 */
export async function lookupImportByContentHash(contentHash: string): Promise<ImportIndexEntry | null> {
  const target = await loadIndex();
  return target.entries.find((entry) => entry.contentHash === contentHash) ?? null;
}

/**
 * 记住一次导入。写入失败**不影响本次导入成功**：调用方把 `IMP-W005` 放进 `warnings[]` 即可。
 * `at` 倒序、上限 2000，超出丢弃最旧的。
 */
export async function rememberImport(entry: ImportIndexEntry, backend?: FileSystemBackend): Promise<void> {
  const target = backend ?? requireBackend();
  const current = await loadIndex(target);
  const entries = [entry, ...current.entries.filter((item) => item.importId !== entry.importId)].slice(0, INDEX_LIMIT);
  reindex(current, entries);
  await writeJson(target, IMPORT_INDEX_FILE, { version: 1, updatedAt: nowIso(), entries });
}

/** 磁盘上的条目已不存在（文件被删/改名）→ 从索引里剔除该条（契约 §4.3.2）。 */
export async function forgetImport(importId: string, backend?: FileSystemBackend): Promise<void> {
  const target = backend ?? requireBackend();
  const current = await loadIndex(target);
  const entries = current.entries.filter((entry) => entry.importId !== importId);
  if (entries.length === current.entries.length) return;
  reindex(current, entries);
  await writeJson(target, IMPORT_INDEX_FILE, { version: 1, updatedAt: nowIso(), entries });
}
