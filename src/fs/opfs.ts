import { assertSafeRelative, baseName, joinPath, parentPath, sanitizeName, uniquePath } from "./paths";

/**
 * Origin Private File System: a real file system the browser owns, with no
 * permission prompts and no note data in IndexedDB. It is what "上传文件夹"
 * copies into when the app runs as a remote web service.
 */
const NAMESPACE = "opennote";

export function supportsOpfs(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function";
}

async function namespaceRoot(create = true): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(NAMESPACE, { create });
}

export async function opfsWorkspaceDir(name: string, create = true): Promise<FileSystemDirectoryHandle> {
  const root = await namespaceRoot(create);
  return root.getDirectoryHandle(sanitizeName(name, "workspace"), { create });
}

export async function listOpfsWorkspaces(): Promise<string[]> {
  if (!supportsOpfs()) return [];
  const root = await namespaceRoot(true);
  const names: string[] = [];
  const anyRoot = root as unknown as { keys?: () => AsyncIterableIterator<string> };
  if (typeof anyRoot.keys === "function") {
    for await (const key of anyRoot.keys()) names.push(key);
  }
  return names.sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

export async function deleteOpfsWorkspace(name: string): Promise<void> {
  const root = await namespaceRoot(true);
  await root.removeEntry(sanitizeName(name, "workspace"), { recursive: true });
}

export interface UploadResult {
  files: number;
  bytes: number;
  skipped: number;
}

/**
 * Copy uploaded / dropped files into an OPFS directory, recreating the folder
 * structure that `webkitRelativePath` provides. Returns a count so the UI can
 * report what happened.
 */
export async function importFilesIntoOpfs(
  files: FileList | File[],
  targetDir: string,
  options: { maxBytes?: number } = {},
): Promise<UploadResult> {
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const root = await opfsWorkspaceDir(targetDir);
  const taken = new Set<string>();
  const result: UploadResult = { files: 0, bytes: 0, skipped: 0 };

  for (const file of Array.from(files)) {
    const relative =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    // strip the picked folder's own name when the browser includes it
    const parts = relative.replace(/\\/g, "/").split("/").filter(Boolean);
    if (parts.length > 1) parts.shift();
    const cleaned = parts.map((part) => sanitizeName(part, "file"));
    const safe = assertSafeRelative(joinPath(...cleaned));
    if (!safe || file.size > maxBytes) {
      result.skipped += 1;
      continue;
    }
    const directory = parentPath(safe);
    let dir = root;
    for (const segment of directory.split("/").filter(Boolean)) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }
    const name = uniquePath(baseName(safe), taken);
    taken.add(name);
    try {
      const handle = await dir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(file);
      await writable.close();
      result.files += 1;
      result.bytes += file.size;
    } catch (error) {
      console.warn("[opennote] 写入失败", safe, error);
      result.skipped += 1;
    }
  }
  return result;
}
