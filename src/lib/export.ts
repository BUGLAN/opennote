import JSZip from "jszip";
import { ASSETS_DIR, META_DIR, joinPath, parentPath, sanitizeName, stripExtension, baseName } from "../fs";
import { currentBackend } from "../data/library";
import { resolveImageSrc, collectImagePaths } from "../data/assets";
import type { Note } from "../data/types";
import { renderMarkdown } from "./markdown";
import { blobToDataUrl, download, escapeHtml, formatDateTime } from "./utils";

/* ------------------------------------------------------------ single notes */

/** Rewrite relative image paths, optionally inlining them as data URLs. */
export async function noteToPortableMarkdown(note: Note, opts: { inlineAssets?: boolean } = {}): Promise<string> {
  const paths = collectImagePaths(note.content);
  if (!paths.length) return note.content;
  const baseDir = parentPath(note.id);
  let out = note.content;
  for (const src of paths) {
    const url = await resolveImageSrc(src, baseDir);
    if (!url) continue;
    if (opts.inlineAssets) {
      try {
        const response = await fetch(url);
        const dataUrl = await blobToDataUrl(await response.blob());
        out = out.split(`](${src})`).join(`](${dataUrl})`);
      } catch {
        /* keep the relative path when the bytes cannot be read */
      }
    }
  }
  return opts.inlineAssets ? out : out.split("](./").join("](");
}

export async function exportNoteMarkdown(note: Note, opts: { inlineAssets?: boolean } = {}): Promise<void> {
  const markdown = await noteToPortableMarkdown(note, opts);
  download(new Blob([markdown], { type: "text/markdown;charset=utf-8" }), `${sanitizeName(note.title)}.md`);
}

const HTML_THEME = `
:root{--paper:#fbf8f3;--ink:#221d17;--ink-2:#5c5347;--ink-3:#97897a;--rule:#e8dfd1;--code:#f4eee4;--accent:#b23a2e}
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
thead th{background:#f2ece1}
img{max-width:100%;height:auto;border-radius:8px}
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
  download(new Blob([html], { type: "text/html;charset=utf-8" }), `${sanitizeName(note.title)}.html`);
}

/* --------------------------------------------------------------- workspace */

export interface ZipOptions {
  includeHistory?: boolean;
  includeMeta?: boolean;
}

/** Zip exactly what is on disk, so the archive *is* the folder. */
export async function buildWorkspaceZip(options: ZipOptions = {}): Promise<Blob> {
  const backend = currentBackend();
  if (!backend) throw new Error("还没有打开任何笔记本文件夹");
  const zip = new JSZip();

  const walk = async (dir: string): Promise<void> => {
    const entries = await backend.list(dir);
    for (const entry of entries) {
      const path = joinPath(dir, entry.name);
      if (entry.kind === "directory") {
        if (path === `${META_DIR}/history` && !options.includeHistory) continue;
        await walk(path);
        continue;
      }
      if (path === `${META_DIR}/state.json` && !options.includeMeta) continue;
      try {
        zip.file(path, await backend.readBytes(path));
      } catch (error) {
        console.warn("[opennote] 打包时跳过", path, error);
      }
    }
  };

  await walk("");
  zip.file(
    "README.txt",
    [
      "Opennote 笔记本备份",
      `导出时间：${formatDateTime(Date.now())}`,
      "",
      "这个压缩包就是笔记本文件夹本身：目录结构、Markdown 正文、assets/ 里的图片都在。",
      `直接解压到任意位置，再用 Opennote「打开文件夹」选择它即可继续写。`,
      `${META_DIR}/ 里是星标、历史快照等附加信息，不需要可以直接删掉。`,
      "",
    ].join("\n"),
  );

  return zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

export async function exportWorkspaceZip(options: ZipOptions = {}): Promise<void> {
  const blob = await buildWorkspaceZip(options);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  download(blob, `opennote-backup-${stamp}.zip`);
}

/** Copy an attachment out of the workspace (used by the asset context menu). */
export async function exportAttachment(path: string): Promise<void> {
  const backend = currentBackend();
  if (!backend) return;
  const bytes = await backend.readBytes(path);
  download(new Blob([bytes as BlobPart]), baseName(path));
}

export { ASSETS_DIR, stripExtension };
