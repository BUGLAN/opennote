import { createStore } from "../lib/store";
import { joinPath, normalizePath } from "../fs";
import { currentBackend } from "./library";
import { getLegacyAsset } from "./legacy";

/**
 * Images live next to the notes (`<note dir>/assets/…`) and are referenced with
 * plain relative markdown paths, so a note stays readable in any other editor.
 * Because a relative path only makes sense together with the note's folder, the
 * editor passes its own directory in as `baseDir`.
 */
export const imageUrlStore = createStore<Record<string, string>>({});
const inflight = new Map<string, Promise<string | null>>();

export function imageUrl(path: string): string | undefined {
  return imageUrlStore.get()[path];
}

/** Markdown image references that point at local files (skips remote/data URLs). */
export function collectImagePaths(markdown: string): string[] {
  const out = new Set<string>();
  const pattern = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of markdown.matchAll(pattern)) {
    const src = match[1];
    if (/^(https?:|data:|blob:)/i.test(src)) continue;
    out.add(src);
  }
  return [...out];
}

export function resolveWorkspacePath(src: string, baseDir: string): string | null {
  const value = src.trim().replace(/^<|>$/g, "").split(/[?#]/)[0];
  if (!value) return null;
  if (value.startsWith("asset://")) return null;
  const clean = normalizePath(value);
  if (!clean) return null;
  if (value.startsWith("/")) return clean;
  return joinPath(baseDir, clean);
}

export async function ensureImageUrl(path: string, candidates: string[] = []): Promise<string | null> {
  const cached = imageUrlStore.get()[path];
  if (cached) return cached;
  const running = inflight.get(path);
  if (running) return running;
  const task = (async () => {
    const backend = currentBackend();
    if (!backend) return null;
    for (const candidate of [path, ...candidates]) {
      try {
        const bytes = await backend.readBytes(candidate);
        const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
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

export async function preloadImages(markdown: string, baseDir: string): Promise<void> {
  await Promise.all(collectImagePaths(markdown).map((src) => resolveImageSrc(src, baseDir)));
}

export function releaseImageUrls(): void {
  for (const url of Object.values(imageUrlStore.get())) URL.revokeObjectURL(url);
  imageUrlStore.set({});
}

export function isImageName(name: string, mime = ""): boolean {
  if (mime.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(name);
}

export function imageNameForPaste(blob: Blob): string {
  const ext = blob.type.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `image-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${ext}`;
}
