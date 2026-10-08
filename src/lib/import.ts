import JSZip from "jszip";
import {
  ASSETS_DIR,
  assertSafeRelative,
  baseName,
  isHiddenPath,
  isImagePath,
  isMarkdownPath,
  joinPath,
  sanitizeName,
  stripExtension,
} from "../fs";
import { getLegacyAsset, readLegacyNotes } from "../data/legacy";
import { listOptionalDirectory } from "../data/optionalFiles";
import {
  createFolder,
  currentBackend,
  flushAll,
  flushMeta,
  invalidateSearchCache,
  libraryStore,
  rescanWorkspace,
  resolveAvailablePath,
  updateNoteContent,
} from "../data/library";
import type { Id } from "../data/types";
import { assetsDirFor, relativeAssetRef } from "../lib/clip/landing";
import { normalizeEol, readFileAsText, uid } from "./utils";

export interface ImportResult {
  notes: number;
  folders: number;
  attachments: number;
  skipped: number;
  migrated?: number;
}

const MAX_ENTRY_BYTES = 32 * 1024 * 1024;

/** Write imported markdown/images straight into the workspace folder. */
export async function importIntoWorkspace(
  input: FileList | File[],
  targetFolder: Id | null,
): Promise<ImportResult> {
  const backend = currentBackend();
  if (!backend) throw new Error("请先打开一个笔记本文件夹");
  const files = Array.from(input);
  if (!files.length) throw new Error("没有选择任何文件");

  const result: ImportResult = { notes: 0, folders: 0, attachments: 0, skipped: 0 };
  const taken = new Set<string>(Object.keys(libraryStore.get().notes));
  const folderCache = new Map<string, Id>();

  const ensureFolder = async (segments: string[]): Promise<Id | null> => {
    let parent = targetFolder;
    for (const raw of segments) {
      const name = sanitizeName(raw, "文件夹");
      const key = `${parent ?? ""}/${name}`;
      const cached = folderCache.get(key);
      if (cached !== undefined) {
        parent = cached;
        continue;
      }
      const existing = Object.values(libraryStore.get().folders).find(
        (folder) => (folder.parentId ?? null) === (parent ?? null) && folder.name === name,
      );
      if (existing) {
        folderCache.set(key, existing.id);
        parent = existing.id;
        continue;
      }
      const created = createFolder(name, parent);
      folderCache.set(key, created.id);
      result.folders += 1;
      parent = created.id;
    }
    return parent;
  };

  const writeNote = async (content: string, folderId: Id | null, name: string): Promise<void> => {
    const dir = folderId ?? "";
    const requested = joinPath(dir, `${sanitizeName(name, "未命名")}.md`);
    // Check the disk too: a file that appeared after the last scan must not be
    // overwritten just because memory has never heard of it (D03).
    const path = await resolveAvailablePath(backend, requested, taken);
    taken.add(path);
    await backend.writeText(path, normalizeEol(content));
    result.notes += 1;
  };

  /**
   * 附件落盘到**公共** `<目标目录>/assets/`。
   *
   * 为什么这里不是新约定的 `<笔记名>.assets/`：本函数只有两个调用方，两边都**没有**
   * 「能派生的笔记名」这个事实 ——
   * 1. **独立导入一张图片**（没有配套的 `.md`）：没有笔记就没有笔记名。凭空按图片名造一个
   *    `<图片名>.assets/` 会造出「暗示存在同名笔记」的目录，而那个笔记根本不存在：
   *    一个目录名两种含义。所以这里如实落公共目录，这是**裸附件（无归属笔记）唯一的例外**；
   *    将来真需要它跟某篇笔记走，由用户自己移动（或另立「裸附件」的正式约定），
   *    本函数不承诺那个未来。
   * 2. **zip 导入里的图片**：见 `handleZip()` 里的裁定注释 —— 那些正文写着旧写法 `./assets/`，
   *    属于「旧数据不迁移」，原样落地。
   *
   * 新图（编辑器粘贴/拖拽 → `saveImage`；剪藏 → `receive.ts` 的 `writeAssets`）一律走
   * `assetsDirFor(笔记路径)`，**不许**再从这条路径写。
   */
  const writeAttachment = async (blob: Blob, name: string, folderId: Id | null): Promise<Id> => {
    const dir = joinPath(folderId ?? "", ASSETS_DIR);
    const existing = await listOptionalDirectory(backend, dir);
    const used = new Set(existing.map((entry) => joinPath(dir, entry.name)));
    const finalName = await resolveAvailablePath(backend, joinPath(dir, sanitizeName(name, "attachment")), used);
    await backend.writeBytes(finalName, blob);
    result.attachments += 1;
    return finalName;
  };

  const handleZip = async (file: File): Promise<void> => {
    const zip = await JSZip.loadAsync(file);
    const entries = Object.values(zip.files).filter((entry) => !entry.dir);
    if (entries.length > 5000) throw new Error("压缩包条目过多，已中止导入");
    const safe = entries.filter((entry) => {
      try {
        assertSafeRelative(entry.name);
        return !isHiddenPath(entry.name) && entry.name !== "README.txt";
      } catch {
        result.skipped += 1;
        return false;
      }
    });
    const notes = safe.filter((entry) => isMarkdownPath(entry.name));
    const images = safe.filter((entry) => isImagePath(entry.name));
    const legacyPrefix = notes.length > 0 && notes.every((entry) => entry.name.startsWith("notes/")) ? "notes/" : "";
    const movedImages = new Map<string, string>();

    // Write images first so a renamed attachment can be reflected in the
    // markdown that refers to it. Keep each assets/ folder next to its notes.
    //
    // 裁定（Lead，本轮）：**zip 导入保持旧布局不动**。zip 里的正文是**外部给的**，写的
    // 就是旧写法 `./assets/x.png` —— 那些图片属于「旧数据」，按 `assets/` 原样落地，
    // 正文**不做** `<笔记名>.assets/` 改写（`不迁移旧数据` 的直接推论）。
    // 将来若真要按新约定改写，必须**整篇正文一起按类改写**（像 `landing.ts` 的
    // `rewriteAssetRefs()` 那样），不许只改 `:145/:146` 那处字符串替换的「一半」——
    // 「一半改写」会比不改更坏：正文与磁盘会各说一套。
    for (const entry of images) {
      const parts = entry.name.split("/").filter(Boolean);
      const name = parts.pop() ?? "image.png";
      // 这里只剥公共 `assets/` 段（旧导出布局的写法）。
      if (parts.at(-1) === ASSETS_DIR) parts.pop();
      const folderId = await ensureFolder(parts);
      const blob = await entry.async("blob");
      if (blob.size > MAX_ENTRY_BYTES) {
        result.skipped += 1;
        continue;
      }
      movedImages.set(entry.name, await writeAttachment(blob, name, folderId));
    }

    for (const entry of notes) {
      const relative = entry.name.slice(legacyPrefix.length);
      const segments = relative.split("/").filter(Boolean);
      const fileName = segments.pop() ?? "未命名.md";
      const folderId = await ensureFolder(segments);
      let text = await entry.async("string");
      if (!text.trim() || new TextEncoder().encode(text).length > MAX_ENTRY_BYTES) {
        result.skipped += 1;
        continue;
      }
      const sourceDir = entry.name.slice(0, entry.name.lastIndexOf("/") + 1);
      for (const [original, destination] of movedImages) {
        if (original !== `${sourceDir}${ASSETS_DIR}/${baseName(original)}`) continue;
        text = text.split(`](./${ASSETS_DIR}/${baseName(original)})`)
          .join(`](./${ASSETS_DIR}/${baseName(destination)})`);
      }
      await writeNote(text, folderId, stripExtension(fileName));
    }
  };

  for (const file of files) {
    if (file.size > MAX_ENTRY_BYTES && !/\.zip$/i.test(file.name)) {
      result.skipped += 1;
      continue;
    }
    try {
      if (/\.zip$/i.test(file.name)) {
        await handleZip(file);
        continue;
      }
      if (isMarkdownPath(file.name)) {
        const text = await readFileAsText(file);
        if (!text.trim()) {
          result.skipped += 1;
          continue;
        }
        const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        const segments = relative.split("/").filter(Boolean);
        const fileName = segments.pop() ?? file.name;
        const folderId = await ensureFolder(segments);
        await writeNote(text, folderId, stripExtension(fileName));
        continue;
      }
      if (isImagePath(file.name) || file.type.startsWith("image/")) {
        await writeAttachment(file, file.name, targetFolder);
        continue;
      }
      result.skipped += 1;
    } catch (error) {
      console.warn("[opennote] 导入失败", file.name, error);
      result.skipped += 1;
    }
  }

  if (!result.notes && !result.attachments && !result.folders) throw new Error("没有找到可以导入的内容");

  await flushAll();
  await flushMeta();
  await rescanWorkspace();
  invalidateSearchCache();
  return result;
}

/** One-time migration of the notes written by the IndexedDB version. */
export async function migrateLegacyData(): Promise<ImportResult> {
  const backend = currentBackend();
  if (!backend) throw new Error("请先打开一个笔记本文件夹");
  const { notes, folders } = await readLegacyNotes();
  const result: ImportResult = { notes: 0, folders: 0, attachments: 0, skipped: 0, migrated: 0 };
  if (!notes.length) return result;

  const folderMap = new Map<string, Id>();
  const ordered = [...folders].sort((a, b) => (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0));
  for (const folder of ordered) {
    const parent = folder.parentId ? (folderMap.get(folder.parentId) ?? null) : null;
    const created = createFolder(folder.name || "文件夹", parent);
    folderMap.set(folder.id, created.id);
    result.folders += 1;
  }

  const taken = new Set<string>(Object.keys(libraryStore.get().notes));
  for (const note of notes) {
    const folderId = note.folderId ? (folderMap.get(note.folderId) ?? null) : null;
    // 落点与附件目录**先**定下来：附件目录按**最终笔记路径**派生（`assetsDirFor`），
    // 正文改写的引用前缀和图片落盘目录都由它决定，所以不能等写完图再算路径。
    const title = sanitizeName(note.title || stripExtension(baseName(`legacy-${uid()}.md`)), "旧笔记");
    const path = await resolveAvailablePath(backend, joinPath(folderId ?? "", `${title}.md`), taken);
    taken.add(path);
    const dir = assetsDirFor();
    /*
     * 引用前缀从**笔记所在目录**算到共享 `.assets/`（`relativeAssetRef`，唯一产地）：
     * 笔记嵌在 `操作系统/产品/` 里就该是 `../../.assets/x.png`，少一层就是裂图。
     * 旧版这里是 `./${baseName(dir)}/`，那是「附件目录与笔记同级」时代的写法。
     */
    const refPrefix = relativeAssetRef(path, dir) + "/";
    // `asset://` 的 id 是**全局**的，但**同一篇笔记里**重复引用同一个 id 只写一份：
    // 缓存按这一篇的作用域建，跨笔记共用一张表会让第二篇的引用指向前一篇的落点。
    const assetNames = new Map<string, string>();
    let content = note.content ?? "";
    for (const match of content.matchAll(/asset:\/\/([A-Za-z0-9-]+)/g)) {
      const assetId = match[1];
      let name = assetNames.get(assetId);
      if (!name) {
        const blob = await getLegacyAsset(assetId);
        if (!blob) continue;
        const existing = await listOptionalDirectory(backend, dir);
        const used = new Set(existing.map((entry) => joinPath(dir, entry.name)));
        const suggested = sanitizeName(`legacy-${assetId.slice(0, 8)}.png`);
        name = baseName(await resolveAvailablePath(backend, joinPath(dir, suggested), used));
        await backend.writeBytes(joinPath(dir, name), blob);
        assetNames.set(assetId, name);
        result.attachments += 1;
      }
      content = content.split(`asset://${assetId}`).join(`${refPrefix}${name}`);
    }
    await backend.writeText(path, normalizeEol(content));
    result.notes += 1;
    result.migrated = (result.migrated ?? 0) + 1;
  }

  await flushAll();
  await flushMeta();
  await rescanWorkspace();
  invalidateSearchCache();
  return result;
}

export { updateNoteContent };
