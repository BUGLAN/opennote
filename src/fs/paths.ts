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
  // D36: Windows 上 `a.md:secret` 是 NTFS 备用数据流——list() 看不到、内容却真实存在，
  // 破坏「文件即笔记」的不变量。主进程按同样规则拒绝段内 ':'；sanitizeName 本来就会
  // 剥掉 ':'，所以正常笔记名不受影响。
  for (const segment of value.replace(/\\/g, "/").split("/")) {
    if (segment.includes(":")) throw new Error("路径不能包含冒号");
  }
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

/**
 * 两份字节**完全相同**吗（长度 + 逐字节）。
 *
 * 「这个路径已经存在」不等于「里面的内容就是我们的」：附件目录里可能有用户手放的
 * 同名文件，也可能发生（极端的）哈希碰撞。凡是要拿内容当判据的地方都走这一条：
 *   - 剪藏落点 `allocateAssetPath`（`src/lib/clip/landing.ts`）；
 *   - 编辑器粘贴 `saveImage`（`src/data/library.ts`）—— 两条路径的语义必须一致；
 *   - 旧附件迁移的「复制后逐字节校验」与「已存在同名文件是否可复用」
 *     （`src/data/migrateAssets.ts`）。
 *
 * 放在 `paths.ts` 是因为三个调用方都要用它，而它只是「两份字节」的比较、没有别的前提；
 * 常量时间比较（哈希）会引入「哈希碰撞即误判」的新风险，逐字节比不会。
 */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
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

/**
 * `a.md` → `a 2.md` when `a.md` is taken.
 *
 * D30: 调用方可以要求按大小写折叠比较（Windows / macOS 的磁盘上 `README.md` 与
 * `readme.md` 是同一个文件）。默认保持大小写敏感，因为浏览器 OPFS 实测是大小写
 * 敏感的——「哪个后端不敏感」是后端的能力，不能靠平台猜测写死在这里。
 */
export function uniquePath(
  candidate: string,
  taken: Set<string>,
  options: { foldCase?: boolean } = {},
): string {
  const key = (value: string) => (options.foldCase ? value.toLowerCase() : value);
  const has = (value: string): boolean => {
    if (taken.has(value)) return true;
    if (!options.foldCase) return false;
    const folded = key(value);
    for (const entry of taken) {
      if (key(entry) === folded) return true;
    }
    return false;
  };
  if (!has(candidate)) return candidate;
  const dir = parentPath(candidate);
  const ext = extName(candidate);
  const base = baseName(stripExtension(candidate));
  let counter = 2;
  let next = joinPath(dir, `${base} ${counter}${ext}`);
  while (has(next)) {
    counter += 1;
    next = joinPath(dir, `${base} ${counter}${ext}`);
  }
  return next;
}

export function formatStamp(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
