import JSZip from "jszip";
import {
  ASSETS_DIR,
  HISTORY_DIR,
  TRASH_DIR,
  baseName,
  isImagePath,
  isMarkdownPath,
  joinPath,
  sanitizeName,
  stripExtension,
  uniquePath,
} from "../fs";
import { getLegacyAsset, readLegacyNotes } from "../data/legacy";
import {
  createFolder,
  currentBackend,
  flushAll,
  flushMeta,
  invalidateSearchCache,
  libraryStore,
  rescanWorkspace,
  updateNoteContent,
} from "../data/library";
import type { Id } from "../data/types";
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
    const path = uniquePath(joinPath(dir, `${sanitizeName(name, "未命名")}.md`), taken);
    taken.add(path);
    await backend.writeText(path, normalizeEol(content));
    result.notes += 1;
  };

  const writeAttachment = async (blob: Blob, name: string, folderId: Id | null): Promise<Id> => {
    const dir = joinPath(folderId ?? "", ASSETS_DIR);
    const existing = await backend.list(dir).catch(() => []);
    const used = new Set(existing.map((entry) => entry.name));
    const finalName = uniquePath(sanitizeName(name, "attachment"), used);
    await backend.writeBytes(joinPath(dir, finalName), blob);
    result.attachments += 1;
    return dir;
  };

  const handleZip = async (file: File): Promise<void> => {
    const zip = await JSZip.loadAsync(file);
    const entries = Object.values(zip.files).filter((entry) => !entry.dir);
    if (entries.length > 5000) throw new Error("压缩包条目过多，已中止导入");
    const notes = entries.filter((entry) => isMarkdownPath(entry.name) && !entry.name.startsWith(`${TRASH_DIR}/`));
    const images: { name: string; blob: Blob }[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(`${HISTORY_DIR}/`) || entry.name.startsWith(`${ASSETS_DIR}/`)) continue;
      if (isImagePath(entry.name)) {
        const blob = await entry.async("blob");
        if (blob.size > MAX_ENTRY_BYTES) {
          result.skipped += 1;
          continue;
        }
        images.push({ name: baseName(entry.name), blob });
      }
    }

    // if the archive is a full notebook, mirror its structure
    const rootTrim = notes.every((entry) => entry.name.startsWith("notes/")) ? 4 : 0;
    for (const entry of notes) {
      const relative = entry.name.slice(rootTrim);
      const segments = relative.split("/").filter(Boolean);
      const fileName = segments.pop() ?? "未命名.md";
      const folderId = await ensureFolder(segments);
      const text = await entry.async("string");
      if (!text.trim()) {
        result.skipped += 1;
        continue;
      }
      await writeNote(text, folderId, stripExtension(fileName));
    }
    for (const image of images) {
      await writeAttachment(image.blob, image.name, targetFolder);
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

  flushAll();
  flushMeta();
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
  const assetNames = new Map<string, string>();
  for (const note of notes) {
    const folderId = note.folderId ? (folderMap.get(note.folderId) ?? null) : null;
    let content = note.content ?? "";
    for (const match of content.matchAll(/asset:\/\/([A-Za-z0-9-]+)/g)) {
      const assetId = match[1];
      let name = assetNames.get(assetId);
      if (!name) {
        const blob = await getLegacyAsset(assetId);
        if (!blob) continue;
        const dir = joinPath(folderId ?? "", ASSETS_DIR);
        const existing = await backend.list(dir).catch(() => []);
        name = uniquePath(sanitizeName(`legacy-${assetId.slice(0, 8)}.png`), new Set(existing.map((e) => e.name)));
        await backend.writeBytes(joinPath(dir, name), blob);
        assetNames.set(assetId, name);
        result.attachments += 1;
      }
      content = content.split(`asset://${assetId}`).join(`./${ASSETS_DIR}/${name}`);
    }
    const title = sanitizeName(note.title || stripExtension(baseName(`legacy-${uid()}.md`)), "旧笔记");
    const path = uniquePath(joinPath(folderId ?? "", `${title}.md`), taken);
    taken.add(path);
    await backend.writeText(path, normalizeEol(content));
    result.notes += 1;
    result.migrated = (result.migrated ?? 0) + 1;
  }

  flushAll();
  flushMeta();
  await rescanWorkspace();
  invalidateSearchCache();
  return result;
}

export { updateNoteContent };
