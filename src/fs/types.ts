/** A file or folder as reported by a backend. */
export interface EntryInfo {
  name: string;
  kind: "file" | "directory";
  size: number;
  mtimeMs: number;
}

export type BackendKind = "node" | "fsa" | "opfs";

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
  stat(relPath: string): Promise<{ size: number; mtimeMs: number } | null>;
}

export function describeBackend(kind: BackendKind): string {
  switch (kind) {
    case "node":
      return "本机磁盘";
    case "fsa":
      return "浏览器文件夹";
    default:
      return "浏览器本地";
  }
}
