/**
 * Workspace-relative, POSIX-style paths. Every backend speaks this dialect:
 * `''` is the workspace root, `日记/2025-05.md` a nested note, `assets/a.png`
 * an image. Absolute paths and `..` never leave this module unresolved.
 *
 * ▍实现不在这里（2026-10-13 单仓改造，`docs/执行-三端同步…` §1.6）
 *
 * 路径的纯函数（归一化、`assertSafeRelative`、`isHiddenPath`、`joinPath` / `parentPath` /
 * `baseName` / `extName` / `stripExtension`、`sanitizeName` / `uniquePath`、`sameBytes`）
 * 已搬到 **`shared/paths.ts`**，客户端与服务端 **import 同一个文件**。
 * 这里只做 re-export，于是既有 import 路径（`../fs/paths`）一行不用改，
 * 而实现只有一份 —— 不是「两端各照规格实现一遍」。
 *
 * 留在本文件的只有**客户端自己的**东西：扩展名判据（`isMarkdownPath` / `isImagePath`）
 * 与 `.opennote/` 下的具体文件名常量。
 */

export {
  META_DIR,
  assertSafeRelative,
  base64urlDecode,
  base64urlEncode,
  baseName,
  extName,
  findCaseFoldCollisions,
  foldCaseKey,
  idForPath,
  isHiddenPath,
  isImagePath,
  isMarkdownPath,
  isMaterializable,
  isValidPathDocId,
  joinPath,
  normalizeNfc,
  normalizePath,
  parentPath,
  pathFromLegacyId,
  pathSegments,
  sameBytes,
  sanitizeName,
  stripExtension,
  uniquePath,
  utf8Decode,
  utf8Encode,
} from "../../shared/paths";
export type { CaseFoldCollision } from "../../shared/paths";

/** Metadata directory that travels with a workspace. */
export const ASSETS_DIR = "assets";
export const STATE_FILE = ".opennote/state.json";
export const HISTORY_DIR = ".opennote/history";
export const TRASH_DIR = ".opennote/trash";
export const INBOX_DIR = ".opennote/inbox";

/** 人类可读的时间戳（列表里展示「最后修改」用）。 */
export function formatStamp(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
