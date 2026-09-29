import JSZip from "jszip";
import { putAsset } from "../data/assets";
import { clearAll, writeFolders, writeNotes } from "../data/db";
import { getLibrary, mergeIntoLibrary, reconcileTabs, replaceLibrary } from "../data/library";
import type { Folder, Id, Note } from "../data/types";
import { BACKUP_FORMAT } from "./export";
import { countText, deriveTags, deriveTitle, normalizeEol, readFileAsText, uid } from "./utils";

export interface ImportResult {
  notes: number;
  folders: number;
  assets: number;
  skipped: number;
  replaced: boolean;
}

interface AssetMeta {
  id: string;
  name: string;
  mime: string;
  size: number;
  path: string;
}

export interface ParsedBackup {
  notes: Partial<Note>[];
  folders: Partial<Folder>[];
  assets: AssetMeta[];
}

const MAX_ENTRY_BYTES = 25 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const ASSET_RE = /asset:\/\/([A-Za-z0-9-]+)/g;
const MARKDOWN_RE = /\.(md|markdown|txt|text|mdown|mkd)$/i;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

/** Pure, total: parse an `opennote.json` backup or return null. */
export function parseBackupJson(text: string): ParsedBackup | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (record.format !== BACKUP_FORMAT) return null;
  const notes = Array.isArray(record.notes) ? (record.notes.filter(isObject) as Partial<Note>[]) : [];
  const folders = Array.isArray(record.folders) ? (record.folders.filter(isObject) as Partial<Folder>[]) : [];
  const assets = Array.isArray(record.assets)
    ? (record.assets.filter(isObject) as Record<string, unknown>[]).map((entry) => ({
        id: String(entry.id ?? ""),
        name: String(entry.name ?? "asset"),
        mime: String(entry.mime ?? "application/octet-stream"),
        size: Number(entry.size ?? 0),
        path: String(entry.path ?? ""),
      }))
    : [];
  return { notes, folders, assets };
}

function isObject(value: unknown): boolean {
  return Boolean(value) && typeof value === "object";
}

/** Pure: `2024/日记/九月.md` → folders ["2024","日记"], title "九月". */
export function parseMarkdownFileName(relativePath: string): { folderNames: string[]; title: string } {
  const clean = relativePath.replace(/\\/g, "/").replace(/^\.?\//, "");
  const parts = clean.split("/").filter(Boolean);
  const file = parts.pop() ?? "";
  const title = file.replace(MARKDOWN_RE, "").trim() || "未命名";
  return { folderNames: parts, title };
}

function timestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

function makeNote(content: string, folderId: Id | null, fallbackTitle: string, meta: Partial<Note> = {}): Note {
  const text = normalizeEol(content);
  const counts = countText(text);
  const now = Date.now();
  const titleOverride = typeof meta.titleOverride === "string" && meta.titleOverride.trim() ? meta.titleOverride.trim() : null;
  return {
    id: uid(),
    folderId,
    title: titleOverride ?? deriveTitle(text, fallbackTitle),
    titleOverride,
    content: text,
    createdAt: timestamp(meta.createdAt ?? now),
    updatedAt: timestamp(meta.updatedAt ?? now),
    openedAt: now,
    starred: Boolean(meta.starred),
    tags: deriveTags(text),
    chars: counts.chars,
    words: counts.words,
    trashed: false,
    trashedAt: null,
  };
}

function remapAssets(content: string, map: Map<string, string>): string {
  if (!map.size) return content;
  return content.replace(ASSET_RE, (match, id: string) => {
    const next = map.get(id);
    return next ? `asset://${next}` : match;
  });
}

/**
 * The single entry point for the UI: a zip backup, a json backup, or a pile of
 * loose markdown / image files (including a picked directory tree).
 */
export async function importPaths(
  fileList: FileList | File[],
  opts: { folderId: Id | null; mode: "merge" | "replace" },
): Promise<ImportResult> {
  const files = Array.from(fileList);
  if (!files.length) throw new Error("没有选择任何文件");

  const result: ImportResult = { notes: 0, folders: 0, assets: 0, skipped: 0, replaced: opts.mode === "replace" };
  const pendingAssets: { blob: Blob; name: string; oldId: string }[] = [];
  const assetIdMap = new Map<string, string>();
  const folderIdMap = new Map<string, string>();
  const newFolders: Folder[] = [];
  const newNotes: Note[] = [];

  const addFolder = (raw: Partial<Folder>): Folder => {
    const now = Date.now();
    const folder: Folder = {
      id: uid(),
      name: String(raw.name ?? "文件夹").slice(0, 120) || "文件夹",
      parentId: raw.parentId ? (folderIdMap.get(String(raw.parentId)) ?? null) : null,
      createdAt: timestamp(raw.createdAt ?? now),
      updatedAt: timestamp(raw.updatedAt ?? now),
    };
    if (raw.id) folderIdMap.set(String(raw.id), folder.id);
    newFolders.push(folder);
    return folder;
  };

  const zipFile = files.find((file) => /\.zip$/i.test(file.name));
  const jsonFile = files.find((file) => /\.json$/i.test(file.name) && file.size < MAX_ENTRY_BYTES);

  if (zipFile) {
    const zip = await JSZip.loadAsync(zipFile);
    const entries = Object.values(zip.files);
    if (entries.length > MAX_ENTRIES) throw new Error("压缩包条目过多，已中止导入");
    const manifestEntry = zip.file("opennote.json");
    const manifest = manifestEntry ? parseBackupJson(await manifestEntry.async("string")) : null;

    if (manifest) {
      // folders first so parent links can be remapped
      const ordered = [...manifest.folders].sort((a, b) => (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0));
      for (const raw of ordered) addFolder(raw);

      for (const meta of manifest.assets) {
        const entry = meta.path ? zip.file(meta.path) : entries.find((candidate) => candidate.name.startsWith(`assets/${meta.id}__`));
        if (!entry) {
          result.skipped += 1;
          continue;
        }
        const blob = await entry.async("blob");
        if (blob.size > MAX_ENTRY_BYTES) {
          result.skipped += 1;
          continue;
        }
        pendingAssets.push({ blob, name: meta.name || "asset", oldId: meta.id });
      }

      for (const raw of manifest.notes) {
        const content = typeof raw.content === "string" ? raw.content : "";
        const folderId = raw.folderId ? (folderIdMap.get(String(raw.folderId)) ?? null) : null;
        newNotes.push(makeNote(content, folderId, String(raw.title ?? "未命名"), raw));
      }
    } else {
      // a zip without a manifest: import every markdown file inside
      for (const entry of entries) {
        if (entry.dir) continue;
        if (!MARKDOWN_RE.test(entry.name)) {
          result.skipped += 1;
          continue;
        }
        const text = await entry.async("string");
        if (!text.trim()) {
          result.skipped += 1;
          continue;
        }
        const { title } = parseMarkdownFileName(entry.name.replace(/^notes\//, ""));
        newNotes.push(makeNote(text, opts.folderId, title));
      }
    }
  } else if (jsonFile) {
    const parsed = parseBackupJson(await readFileAsText(jsonFile));
    if (!parsed) throw new Error("这个 JSON 不是 Opennote 备份文件");
    const ordered = [...parsed.folders].sort((a, b) => (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0));
    for (const raw of ordered) addFolder(raw);
    for (const raw of parsed.notes) {
      const folderId = raw.folderId ? (folderIdMap.get(String(raw.folderId)) ?? null) : null;
      newNotes.push(makeNote(typeof raw.content === "string" ? raw.content : "", folderId, String(raw.title ?? "未命名"), raw));
    }
  } else {
    const existing = Object.values(getLibrary().folders);
    const folderCache = new Map<string, Id>();
    const ensureFolder = (name: string, parentId: Id | null): Id => {
      const key = `${parentId ?? "root"}/${name}`;
      const cached = folderCache.get(key);
      if (cached) return cached;
      const found = existing.find((folder) => folder.parentId === parentId && folder.name === name);
      if (found) {
        folderCache.set(key, found.id);
        return found.id;
      }
      const created = addFolder({ name, parentId: null });
      created.parentId = parentId;
      result.folders += 1;
      folderCache.set(key, created.id);
      return created.id;
    };

    for (const file of files) {
      const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      if (file.size > MAX_ENTRY_BYTES) {
        result.skipped += 1;
        continue;
      }
      if (MARKDOWN_RE.test(file.name)) {
        const text = await readFileAsText(file);
        if (!text.trim()) {
          result.skipped += 1;
          continue;
        }
        const { folderNames, title } = parseMarkdownFileName(relative);
        let parent = opts.folderId;
        for (const name of folderNames) parent = ensureFolder(name, parent);
        newNotes.push(makeNote(text, parent, title));
        continue;
      }
      if (file.type.startsWith("image/") || IMAGE_RE.test(file.name)) {
        pendingAssets.push({ blob: file, name: file.name, oldId: "" });
        continue;
      }
      result.skipped += 1;
    }
  }

  if (!newNotes.length && !newFolders.length && !pendingAssets.length) {
    throw new Error("没有找到可以导入的内容");
  }

  if (opts.mode === "replace") await clearAll();

  for (const pending of pendingAssets) {
    try {
      const asset = await putAsset(pending.blob, pending.name);
      result.assets += 1;
      if (pending.oldId) assetIdMap.set(pending.oldId, asset.id);
    } catch {
      result.skipped += 1;
    }
  }

  if (assetIdMap.size) {
    for (const note of newNotes) {
      note.content = remapAssets(note.content, assetIdMap);
      note.tags = deriveTags(note.content);
      const counts = countText(note.content);
      note.chars = counts.chars;
      note.words = counts.words;
    }
  }

  try {
    if (newFolders.length) await writeFolders(newFolders);
    if (newNotes.length) await writeNotes(newNotes);
  } catch (error) {
    console.error("[opennote] 导入写入失败", error);
  }

  result.notes = newNotes.length;
  result.folders = Math.max(result.folders, newFolders.length);

  if (opts.mode === "replace") replaceLibrary(newNotes, newFolders);
  else mergeIntoLibrary(newNotes, newFolders);
  reconcileTabs();

  return result;
}
