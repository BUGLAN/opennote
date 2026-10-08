/** A file or folder as reported by a backend. */
export interface EntryInfo {
  name: string;
  kind: "file" | "directory";
  size: number;
  mtimeMs: number;
}

export type BackendKind = "node" | "fsa" | "opfs" | "capacitor";

/**
 * Everything the notebook needs from "a folder on some disk". Three backends
 * implement it: Node's `fs` (Electron desktop), the File System Access API
 * (Chromium, a real folder the user picked) and OPFS (any modern browser, a
 * private file system that survives reloads).
 *
 * All paths are workspace-relative and POSIX-style; see `paths.ts`.
 */
export interface FileSystemBackend {
  readonly kind: BackendKind;
  /** Human label for the UI: 本机磁盘 / 浏览器文件夹 / 浏览器本地存储. */
  readonly label: string;
  readonly canWrite: boolean;
  list(relPath: string): Promise<EntryInfo[]>;
  readText(relPath: string): Promise<string>;
  readBytes(relPath: string): Promise<Uint8Array>;
  writeText(relPath: string, text: string): Promise<void>;
  writeBytes(relPath: string, data: Uint8Array | Blob): Promise<void>;
  mkdir(relPath: string): Promise<void>;
  remove(relPath: string, options?: { recursive?: boolean }): Promise<void>;
  move(from: string, to: string): Promise<void>;
  exists(relPath: string): Promise<boolean>;
  /**
   * 文件元数据。**只对文件有保证**：`size` 为字节数，`mtimeMs` 为毫秒时间戳；
   * 缺失路径一律返回 `null`。
   *
   * 目录不受保证：`handleBackend`（FSA / OPFS）对目录返回 `null`（浏览器不暴露目录
   * 元数据），而 `node` 后端会返回宿主机的真实值。因此调用方不得依赖目录的
   * `size` / `mtimeMs`，判定目录是否存在请用 `exists()`（D33）。
   */
  stat(relPath: string): Promise<{ size: number; mtimeMs: number } | null>;
}

export function describeBackend(kind: BackendKind): string {
  switch (kind) {
    case "node":
      return "本机磁盘";
    case "fsa":
      return "浏览器文件夹";
    case "capacitor":
      return "手机文件夹";
    default:
      return "浏览器本地";
  }
}
