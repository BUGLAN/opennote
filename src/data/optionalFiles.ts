import type { EntryInfo, FileSystemBackend } from "../fs/types";

// Missing metadata and snapshot directories are normal in a new workspace.
// Check existence before invoking Electron IPC: a rejected handler logs an error
// in the main process even when the renderer catches that rejection.
export async function readOptionalText(backend: FileSystemBackend, path: string): Promise<string | undefined> {
  if (!(await backend.exists(path))) return undefined;
  return backend.readText(path);
}

export async function listOptionalDirectory(backend: FileSystemBackend, path: string): Promise<EntryInfo[]> {
  if (!(await backend.exists(path))) return [];
  return backend.list(path);
}
