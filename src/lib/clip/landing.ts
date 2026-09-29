/**
 * 落点决策与附件落盘（契约 §3.1 / §3.3 / §3.4 / §3.6）。
 *
 * 本模块只做「给定后端与快照 → 得到路径与字节」的确定性运算，不碰全局状态，
 * 方便单测直接喂一个内存后端。
 */

import { ASSETS_DIR, baseName, joinPath, parentPath, sanitizeName, uniquePath } from "../../fs/paths";
import type { FileSystemBackend } from "../../fs/types";
import { resolveAvailablePath } from "../../data/library";
import { ImportRejection, importProblem, normalizeFolder } from "./envelope";
import { contentHash8 } from "./hash";

/**
 * 请求路径 = `joinPath(folder, sanitizeName(title, "未命名") + ".md")`（契约 §3.1）。
 * `folder` 为 `null`/`""` 时是**工作区根目录**；目录不存在时逐段创建，不是失败。
 */
export function requestedNotePath(folder: string | null, title: string): string {
  const dir = normalizeFolder(folder);
  return joinPath(dir, `${sanitizeName(title, "未命名")}.md`);
}

/** 逐段 `mkdir`（幂等；三段后端都会自动创建中间层）。 */
export async function ensureFolderDirs(backend: FileSystemBackend, folder: string | null): Promise<void> {
  const dir = normalizeFolder(folder);
  if (!dir) return;
  const segments = dir.split("/");
  let prefix = "";
  for (const segment of segments) {
    prefix = joinPath(prefix, segment);
    try {
      await backend.mkdir(prefix);
    } catch (error) {
      throw new ImportRejection(
        importProblem("IMP-4009", {
          field: "target.folder",
          segment,
          reason: error instanceof Error ? error.message : "mkdir-failed",
        }),
      );
    }
  }
}

/**
 * 唯一决定文件名的两步（契约 §3.3.2）：
 * `uniquePath()` 的内存序号语义（` 2`、` 3`…）**叠加**磁盘 `exists()` 真实探测。
 * 必须走 `resolveAvailablePath()`，不得只用 `uniquePath()`：`taken` 只来自内存，
 * 「上次扫描之后由外部程序创建的同名文件」不在内存里（D03）。
 */
export async function allocateNotePath(
  backend: FileSystemBackend,
  requested: string,
  taken: Set<string>,
): Promise<string> {
  const candidate = await resolveAvailablePath(backend, requested, taken);
  // `resolveAvailablePath` 的 `guard > 500` 会放弃循环并返回一个仍被占用的候选路径。
  if (await backend.exists(candidate)) {
    throw new ImportRejection(importProblem("IMP-4010", { requested, candidate }));
  }
  taken.add(candidate);
  return candidate;
}

/** 附件目录：与笔记**同级**的 `assets/`（不放进 `.opennote/`，删掉 `.opennote/` 不能丢图）。 */
export function assetsDirFor(notePath: string): string {
  return joinPath(parentPath(notePath), ASSETS_DIR);
}

/** 附件最终名：`contentHash8(bytes) + "-" + sanitizeName(name, "attachment")`（契约 §3.4）。 */
export async function assetFinalName(bytes: Uint8Array, name: string): Promise<string> {
  return `${await contentHash8(bytes)}-${sanitizeName(name, "attachment")}`;
}

export interface AssetTarget {
  path: string;
  /** `true` = 命中了已存在的内容哈希路径（重试幂等，字节相同，覆盖无害）。 */
  reused: boolean;
}

/**
 * 附件落点。设计意图（契约 §3.4）：名字里带内容哈希 → **重试幂等**，部分成功后的重试会
 * 命中同一路径，不会产生 `assets/a 2.png`、`assets/a 3.png` 的垃圾堆积；同名不同内容
 * 天然区分。因此「已存在」时直接复用路径，而不是退化成 ` 2`。
 */
export async function allocateAssetPath(
  backend: FileSystemBackend,
  dir: string,
  name: string,
  bytes: Uint8Array,
  taken: Set<string>,
): Promise<AssetTarget> {
  const candidate = joinPath(dir, await assetFinalName(bytes, name));
  if (taken.has(candidate)) return { path: candidate, reused: true };
  if (await backend.exists(candidate)) {
    taken.add(candidate);
    return { path: candidate, reused: true };
  }
  const path = uniquePath(candidate, taken);
  taken.add(path);
  return { path, reused: false };
}

export interface AssetRename {
  /** 信封里的原始 `name`（正文引用的就是它）。 */
  name: string;
  /** 实际落盘路径（工作区相对）。 */
  finalPath: string;
}

/**
 * 正文引用改写（契约 §3.4，三次字面替换，**顺序不可颠倒**）：
 * 1. `./assets/<name>` → `./assets/<新名>`
 * 2. `assets/<name>` → `assets/<新名>`（无 `./` 前缀的变体）
 * 3. `](<name>)` → `](./assets/<新名>)`（不含目录的裸名）
 */
export function rewriteAssetRefs(body: string, renames: AssetRename[]): string {
  let next = body;
  for (const { name, finalPath } of renames) {
    const finalRef = `./${ASSETS_DIR}/${baseName(finalPath)}`;
    next = next.split(`./${ASSETS_DIR}/${name}`).join(finalRef);
    next = next.split(`${ASSETS_DIR}/${name}`).join(`${ASSETS_DIR}/${baseName(finalPath)}`);
    next = next.split(`](${name})`).join(`](${finalRef})`);
  }
  return next;
}

/** 正文里引用了 `assets/xxx` 但 `assets[]` 未声明 → `IMP-W002`（原样保留，不静默删除）。 */
export function findUndeclaredAssetRefs(body: string, declaredNames: string[]): string[] {
  const found = new Set<string>();
  const pattern = /(?:\.\/)?assets\/([^\s)"'<>\]]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) {
    if (!declaredNames.includes(match[1])) found.add(match[1]);
  }
  return [...found];
}

/**
 * `overwrite` 的反面：第一段之前的内容必须原样保留。测试与撤销都用它做前后像比对。
 */
export function isAppendOf(existing: string, next: string): boolean {
  return next.startsWith(existing.replace(/\r\n?/g, "\n").trimEnd());
}
