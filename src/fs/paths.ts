/**
 * Workspace-relative, POSIX-style paths. Every backend speaks this dialect:
 * `''` is the workspace root, `日记/2025-05.md` a nested note, `assets/a.png`
 * an image. Absolute paths and `..` never leave this module unresolved.
 */

export function normalizePath(input: string): string {
  const parts: string[] = [];
  for (const raw of String(input ?? "").replace(/\\/g, "/").split("/")) {
    const segment = raw.trim();
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

export function assertSafeRelative(input: string): string {
  const value = String(input ?? "");
  if (value.includes("\0")) throw new Error("路径包含非法字符");
  if (/^([a-zA-Z]:|[\\/])/.test(value.trim())) throw new Error("不允许使用绝对路径");
  if (value.replace(/\\/g, "/").split("/").includes("..")) throw new Error("路径越界");
  return normalizePath(value);
}

export function joinPath(...parts: (string | null | undefined)[]): string {
  return normalizePath(parts.filter((part): part is string => Boolean(part && part.length)).join("/"));
}

export function parentPath(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index < 0 ? "" : normalized.slice(0, index);
}

export function baseName(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index < 0 ? normalized : normalized.slice(index + 1);
}

export function extName(path: string): string {
  const name = baseName(path);
  const index = name.lastIndexOf(".");
  return index <= 0 ? "" : name.slice(index).toLowerCase();
}

export function stripExtension(path: string): string {
  const ext = extName(path);
  return ext ? path.slice(0, path.length - ext.length) : path;
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdown|mkd|txt)$/i.test(path);
}

export function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(path);
}

/** Files and folders the notebook manages itself (`.opennote`, `.git`, …). */
export function isHiddenPath(path: string): boolean {
  return normalizePath(path)
    .split("/")
    .some((segment) => segment.startsWith("."));
}

/** Metadata directory that travels with a workspace. */
export const META_DIR = ".opennote";
export const ASSETS_DIR = "assets";
export const STATE_FILE = `${META_DIR}/state.json`;
export const HISTORY_DIR = `${META_DIR}/history`;
export const TRASH_DIR = `${META_DIR}/trash`;

/** Filesystem-safe name that keeps CJK readable. */
export function sanitizeName(name: string, fallback = "未命名"): string {
  const cleaned = String(name ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .trim();
  return (cleaned || fallback).slice(0, 80);
}

/** `a.md` → `a 2.md` when `a.md` is taken. */
export function uniquePath(candidate: string, taken: Set<string>): string {
  if (!taken.has(candidate)) return candidate;
  const dir = parentPath(candidate);
  const ext = extName(candidate);
  const base = baseName(stripExtension(candidate));
  let counter = 2;
  let next = joinPath(dir, `${base} ${counter}${ext}`);
  while (taken.has(next)) {
    counter += 1;
    next = joinPath(dir, `${base} ${counter}${ext}`);
  }
  return next;
}

/** Snapshot files live flat in `.opennote/history`, so paths must be encoded. */
export function encodeHistoryName(path: string, stamp: number): string {
  const safe = normalizePath(path).replace(/[^\w\u4e00-\u9fff.-]+/g, "_").slice(-60);
  return `${safe}.${stamp}.md`;
}

export function formatStamp(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
