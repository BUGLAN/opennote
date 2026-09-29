import JSZip from "jszip";
import { assetMeta, collectAssetIds } from "../data/assets";
import type { Asset, Folder, Id, Note } from "../data/types";
import { renderMarkdown } from "./markdown";
import { blobToDataUrl, download, escapeHtml, formatDateTime, safeFileName, uniqueName } from "./utils";

export const BACKUP_FORMAT = "opennote-backup";
export const BACKUP_VERSION = 1;

const ASSET_RE = /asset:\/\/([A-Za-z0-9-]+)/g;

export interface AssetManifestEntry {
  id: Id;
  name: string;
  mime: string;
  size: number;
  path: string;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: number;
  app: string;
  exportedAt: string;
  folders: Partial<Folder>[];
  notes: Partial<Note>[];
  assets: AssetManifestEntry[];
}

export function assetFileName(asset: Pick<Asset, "id" | "name">): string {
  return `${asset.id}__${safeFileName(asset.name, "asset")}`;
}

/** Pure: where a note lives inside the archive / a folder mirror. */
export function zipPathFor(note: Pick<Note, "title" | "folderId">, folders: Folder[]): string {
  const parts: string[] = [];
  let cursor: Id | null = note.folderId;
  let guard = 0;
  while (cursor && guard < 32) {
    const folder: Folder | undefined = folders.find((candidate) => candidate.id === cursor);
    if (!folder) break;
    parts.unshift(safeFileName(folder.name, "文件夹"));
    cursor = folder.parentId;
    guard += 1;
  }
  if (!parts.length) parts.push("未归档");
  return `notes/${parts.join("/")}/${safeFileName(note.title, "未命名")}.md`;
}

/** Replace `asset://<id>` references with portable paths (or inline data URLs). */
export async function noteToPortableMarkdown(
  note: Pick<Note, "content">,
  opts: { inlineAssets?: boolean } = {},
): Promise<string> {
  const ids = collectAssetIds(note.content);
  if (!ids.length) return note.content;
  const replacements = new Map<Id, string>();
  for (const id of ids) {
    const asset = assetMeta(id);
    if (!asset) continue;
    if (opts.inlineAssets) {
      try {
        replacements.set(id, await blobToDataUrl(asset.blob));
      } catch {
        /* keep the raw reference when the blob cannot be read */
      }
    } else {
      replacements.set(id, `./assets/${assetFileName(asset)}`);
    }
  }
  return note.content.replace(ASSET_RE, (match, id: Id) => replacements.get(id) ?? match);
}

export async function exportNoteMarkdown(note: Note, opts: { inlineAssets?: boolean } = {}): Promise<void> {
  const markdown = await noteToPortableMarkdown(note, opts);
  download(new Blob([markdown], { type: "text/markdown;charset=utf-8" }), `${safeFileName(note.title, "未命名")}.md`);
}

/* ------------------------------------------------------------ standalone html */

const HTML_THEME = `
:root{--paper:#fbf8f3;--paper-2:#fffdf9;--paper-3:#f2ece1;--ink:#221d17;--ink-2:#5c5347;--ink-3:#97897a;--rule:#e8dfd1;--code:#f4eee4;--accent:#b23a2e}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:"Newsreader","Songti SC","Noto Serif SC",Georgia,serif;font-size:17px;line-height:1.78;-webkit-font-smoothing:antialiased}
main{max-width:46rem;margin:0 auto;padding:72px 24px 120px}
h1,h2,h3,h4,h5,h6{font-weight:600;line-height:1.32;letter-spacing:-.005em}
h1{font-size:1.85em;margin:1.1em 0 .7em;padding-bottom:.28em;border-bottom:2px solid var(--rule)}
h2{font-size:1.45em;margin:1.7em 0 .6em;padding-bottom:.24em;border-bottom:1px solid var(--rule)}
h3{font-size:1.2em;margin:1.6em 0 .5em}h4{font-size:1.06em;margin:1.5em 0 .45em}
h5,h6{font-size:.95em;margin:1.4em 0 .4em;color:var(--ink-2)}
p{margin:.85em 0}
a{color:var(--accent);text-decoration:none;border-bottom:1px solid rgba(178,58,46,.35)}
blockquote{margin:1.1em 0;padding:.1em 0 .1em 1.1em;border-left:2px solid var(--rule);color:var(--ink-2)}
code{font-family:"JetBrains Mono",ui-monospace,Consolas,monospace;font-size:.875em;background:var(--code);border:1px solid var(--rule);border-radius:4px;padding:.12em .34em}
pre{margin:1.05em 0;padding:.9em 1.05em;background:var(--code);border:1px solid var(--rule);border-left:2px solid rgba(178,58,46,.34);border-radius:8px;overflow-x:auto;line-height:1.62}
pre code{background:none;border:none;padding:0}
table{border-collapse:collapse;margin:1.05em 0;font-size:.94em}
th,td{border:1px solid var(--rule);padding:.42em .7em;text-align:left}
thead th{background:var(--paper-3)}
img{max-width:100%;height:auto;border-radius:8px;box-shadow:0 1px 2px rgba(52,39,22,.06)}
hr{border:none;border-top:1px solid var(--rule);margin:2em 0}
ul,ol{padding-left:1.5em}li{margin:.3em 0}
footer{margin-top:56px;padding-top:16px;border-top:1px solid var(--rule);font-size:12.5px;color:var(--ink-3);font-family:system-ui,"PingFang SC","Microsoft YaHei",sans-serif}
@media print{body{background:#fff}main{padding:0}}
`.trim();

export async function exportNoteHtml(note: Note): Promise<void> {
  const markdown = await noteToPortableMarkdown(note, { inlineAssets: true });
  const body = renderMarkdown(markdown);
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(note.title)}</title>
<style>${HTML_THEME}</style>
</head>
<body>
<main>
${body}
<footer>由 Opennote 导出 · ${formatDateTime(Date.now())}</footer>
</main>
</body>
</html>`;
  download(new Blob([html], { type: "text/html;charset=utf-8" }), `${safeFileName(note.title, "未命名")}.html`);
}

/* --------------------------------------------------------------- archives */

function manifestFor(notes: Note[], folders: Folder[], assets: AssetManifestEntry[]): BackupManifest {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    app: "Opennote",
    exportedAt: new Date().toISOString(),
    folders: folders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      parentId: folder.parentId,
      createdAt: folder.createdAt,
      updatedAt: folder.updatedAt,
    })),
    notes: notes.map((note) => ({
      id: note.id,
      folderId: note.folderId,
      title: note.title,
      titleOverride: note.titleOverride,
      content: note.content,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      starred: note.starred,
      tags: note.tags,
    })),
    assets,
  };
}

export function buildLibraryJson(notes: Note[], folders: Folder[]): Promise<Blob> {
  const manifest = manifestFor(notes, folders, []);
  return Promise.resolve(new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" }));
}

export async function buildLibraryZip(
  notes: Note[],
  folders: Folder[],
  opts: { includeAssets?: boolean; json?: boolean } = {},
): Promise<Blob> {
  const zip = new JSZip();
  const used = new Set<string>();

  for (const note of notes) {
    const path = uniqueName(zipPathFor(note, folders), used);
    used.add(path);
    zip.file(path, await noteToPortableMarkdown(note, { inlineAssets: false }));
  }

  const assetEntries: AssetManifestEntry[] = [];
  if (opts.includeAssets !== false) {
    const seen = new Set<Id>();
    for (const note of notes) {
      for (const id of collectAssetIds(note.content)) {
        if (seen.has(id)) continue;
        seen.add(id);
        const asset = assetMeta(id);
        if (!asset) continue;
        const path = `assets/${assetFileName(asset)}`;
        zip.file(path, asset.blob);
        assetEntries.push({ id, name: asset.name, mime: asset.mime, size: asset.size, path });
      }
    }
  }

  const manifest = manifestFor(notes, folders, assetEntries);
  if (opts.json !== false) zip.file("opennote.json", JSON.stringify(manifest, null, 2));
  zip.file(
    "README.txt",
    [
      "Opennote 备份包",
      `导出时间：${formatDateTime(Date.now())}`,
      "",
      "opennote.json   完整数据（笔记正文、文件夹、标签、时间）",
      "notes/          每一条笔记的 Markdown 副本，可直接用任何编辑器打开",
      "assets/         笔记里粘贴的图片等附件，文件名前缀是它在库中的编号",
      "",
      "恢复方法：打开 Opennote → 设置 · 数据 · 导入 → 选择这个 zip。",
      "只想要文字的话，直接把 notes/ 目录拷走即可，Markdown 里已经不含私有格式。",
      "",
    ].join("\n"),
  );

  return zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

export async function exportLibraryZip(
  notes: Note[],
  folders: Folder[],
  opts: { includeAssets?: boolean } = {},
): Promise<void> {
  const blob = await buildLibraryZip(notes, folders, opts);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  download(blob, `opennote-backup-${stamp}.zip`);
}
