import { createStore } from "../lib/store";
// 引用解析的**唯一产地**在 `../fs/workspaceRef`（迁移器与命令行也要用同一套语义，
// 而它们不能把 `library` / `ui` / `legacy` 那一串前端运行时拉起来）。这里 re-export，
// 保持既有导入路径（`from "../data/assets"`）一个字都不用改。
import { resolveWorkspacePath } from "../fs/workspaceRef";
import { currentBackend, libraryStore } from "./library";
import { getUi, uiStore } from "./ui";
import { getLegacyAsset } from "./legacy";

export { resolveWorkspacePath };

/**
 * Images live in a directory derived from the note's own path
 * (`<note dir>/<note name>.assets/…`) and are referenced with plain relative
 * markdown paths, so a note stays readable in any other editor and its images
 * follow it when the single note is moved. Because a relative path only makes
 * sense together with the note's folder, the editor passes its own **note path**
 * in as `notePath` (the writer is `saveImage` in `./library`).
 *
 * Legacy layout: images pasted before this rule live in the shared
 * `<note dir>/assets/` and are **not migrated** — the markdown already points at
 * them, so they keep working; new images never go there any more.
 */
export const imageUrlStore = createStore<Record<string, string>>({});
const inflight = new Map<string, Promise<string | null>>();
/** Bumped whenever the cached URLs stop being valid (workspace switched). */
let assetEpoch = 0;

export function imageUrl(path: string): string | undefined {
  return imageUrlStore.get()[path];
}

/**
 * Markdown image references that point at local files (skips remote/data URLs).
 *
 * Two destination spellings have to be understood, because {@link markdownRef}
 * emits the angle-bracket form whenever the path contains whitespace:
 *   `![x](./备注 2.assets/a.png)`   — plain destination, no whitespace allowed
 *   `![x](<./备注 2.assets/a.png>)` — CommonMark angle-bracket destination
 * Missing the second form is silent: the image would simply never be preloaded
 * and would stay blank in the preview (no error anywhere).
 */
export function collectImagePaths(markdown: string): string[] {
  const out = new Set<string>();
  const pattern = /!\[[^\]]*\]\(\s*(?:<([^>]*)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g;
  for (const match of markdown.matchAll(pattern)) {
    const src = match[1] ?? match[2];
    if (!src) continue;
    if (/^(https?:|data:|blob:)/i.test(src)) continue;
    out.add(src);
  }
  return [...out];
}

export async function ensureImageUrl(path: string, candidates: string[] = []): Promise<string | null> {
  const cached = imageUrlStore.get()[path];
  if (cached) return cached;
  const running = inflight.get(path);
  if (running) return running;
  const task = (async () => {
    const backend = currentBackend();
    if (!backend) return null;
    const epoch = assetEpoch;
    for (const candidate of [path, ...candidates]) {
      try {
        const bytes = await backend.readBytes(candidate);
        const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
        // The workspace was closed/switched while we were reading: this URL
        // belongs to a folder the app no longer shows.
        if (epoch !== assetEpoch) {
          URL.revokeObjectURL(url);
          return null;
        }
        imageUrlStore.set((prev) => ({ ...prev, [path]: url }));
        return url;
      } catch {
        /* try the next candidate */
      }
    }
    return null;
  })().finally(() => inflight.delete(path));
  inflight.set(path, task);
  return task;
}

/** Turn whatever sits inside `![]()` into something an `<img>` can display. */
export async function resolveImageSrc(src: string, baseDir = ""): Promise<string | null> {
  const value = src.trim().replace(/^<|>$/g, "");
  if (!value) return null;
  if (/^(https?:|data:|blob:)/i.test(value)) return value;

  if (value.startsWith("asset://")) {
    // notes written by the older IndexedDB version — best-effort recovery
    const legacy = await getLegacyAsset(value.slice("asset://".length));
    if (!legacy) return null;
    const url = URL.createObjectURL(legacy);
    imageUrlStore.set((prev) => ({ ...prev, [value]: url }));
    return url;
  }

  const path = resolveWorkspacePath(value, baseDir);
  if (!path) return null;
  const fallback = baseDir ? resolveWorkspacePath(value, "") : null;
  return ensureImageUrl(path, fallback && fallback !== path ? [fallback] : []);
}

/**
 * 本地图片的**原始字节**（带正确的 MIME）。远程地址、`data:` 与 `blob:` 没有本地字节，
 * 一律返回 null —— 那是「读不出文件」的不同情形，由调用方各走各的退路，不在这里编一个空 Blob。
 *
 * 候选回退与 {@link ensureImageUrl} 逐字一致（笔记目录优先、再试工作区根目录）：
 * 图片在屏幕上能显示、复制却读不出来，两个产地分家就是同一类静默缺陷。
 */
export async function readLocalImageBlob(src: string, baseDir = ""): Promise<Blob | null> {
  const value = src.trim().replace(/^<|>$/g, "");
  if (!value || /^(https?:|data:|blob:)/i.test(value)) return null;

  if (value.startsWith("asset://")) {
    return (await getLegacyAsset(value.slice("asset://".length))) ?? null;
  }

  const backend = currentBackend();
  if (!backend) return null;
  const path = resolveWorkspacePath(value, baseDir);
  if (!path) return null;
  const fallback = baseDir ? resolveWorkspacePath(value, "") : null;
  for (const candidate of [path, ...(fallback && fallback !== path ? [fallback] : [])]) {
    try {
      const bytes = await backend.readBytes(candidate);
      return new Blob([bytes as BlobPart], { type: imageMimeFor(candidate) });
    } catch {
      /* 试下一个候选 */
    }
  }
  return null;
}

export async function preloadImages(markdown: string, baseDir: string): Promise<void> {
  await Promise.all(collectImagePaths(markdown).map((src) => resolveImageSrc(src, baseDir)));
}

/** Drop every cached blob URL (workspace closed, or a different notebook opened). */
export function releaseImageUrls(): void {
  assetEpoch += 1;
  for (const url of Object.values(imageUrlStore.get())) revoke(url);
  imageUrlStore.set({});
}

/**
 * Blob URLs used to live for the whole app session, so opening notes leaked
 * memory (D27). Release the ones no open tab can display any more.
 */
export function releaseUnusedImageUrls(): number {
  const keep = imagePathsInUse();
  const current = imageUrlStore.get();
  const next: Record<string, string> = {};
  let released = 0;
  for (const [path, url] of Object.entries(current)) {
    if (keep.has(path) || path.startsWith("asset://")) {
      next[path] = url;
      continue;
    }
    revoke(url);
    released += 1;
  }
  if (released) imageUrlStore.set(next);
  return released;
}

/** Workspace-relative paths referenced by the notes that are open in tabs. */
function imagePathsInUse(): Set<string> {
  const state = libraryStore.get();
  const keep = new Set<string>();
  for (const id of getUi().tabs) {
    const note = state.notes[id];
    if (!note) continue;
    for (const src of collectImagePaths(note.content)) {
      const path = resolveWorkspacePath(src, note.folderId ?? "");
      if (path) keep.add(path);
    }
  }
  return keep;
}

function revoke(url: string): void {
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* already revoked or unsupported */
  }
}

let releaseTimer: ReturnType<typeof setTimeout> | null = null;
let activeWorkspaceId: string | null = libraryStore.get().workspace?.id ?? null;

function scheduleImageRelease(): void {
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    releaseUnusedImageUrls();
  }, 250);
}

// Closing a tab frees its images; switching notebooks must free all of them,
// because paths are only unique inside one workspace.
uiStore.subscribe(scheduleImageRelease);
libraryStore.subscribe(() => {
  const id = libraryStore.get().workspace?.id ?? null;
  if (id === activeWorkspaceId) return;
  activeWorkspaceId = id;
  releaseImageUrls();
});

export function isImageName(name: string, mime = ""): boolean {
  if (mime.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(name);
}

/** 扩展名 → 图片 MIME（`isImageName` 认得的那几种，一份名单）。认不出来时返回空串，绝不猜。 */
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

export function imageMimeFor(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "";
  return IMAGE_MIME[name.slice(dot + 1).toLowerCase()] ?? "";
}

export function imageNameForPaste(blob: Blob): string {
  const ext = blob.type.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `image-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${ext}`;
}
