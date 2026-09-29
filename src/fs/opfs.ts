import { writeInto } from "./io";
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

async function namesIn(dir: FileSystemDirectoryHandle): Promise<Set<string>> {
  const names = new Set<string>();
  const anyDir = dir as unknown as {
    keys?: () => AsyncIterableIterator<string>;
    entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
  };
  if (typeof anyDir.keys === "function") {
    for await (const key of anyDir.keys()) names.add(key);
    return names;
  }
  if (typeof anyDir.entries === "function") {
    for await (const [name] of anyDir.entries()) names.add(name);
  }
  return names;
}

async function entryExists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  if (await dir.getFileHandle(name).then(
    () => true,
    () => false,
  )) {
    return true;
  }
  return dir.getDirectoryHandle(name).then(
    () => true,
    () => false,
  );
}

async function ensureDirectory(root: FileSystemDirectoryHandle, relPath: string): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const segment of relPath.split("/").filter(Boolean)) {
    dir = await dir.getDirectoryHandle(segment, { create: true });
  }
  return dir;
}

/**
 * Copy uploaded / dropped files into an OPFS directory, recreating the folder
 * structure that `webkitRelativePath` provides. Returns a count so the UI can
 * report what happened.
 *
 * D12: 「不覆盖、不误改名」。旧实现把 `taken` 建成一次性、只按 basename 去重的集合，
 * 于是导入同名文件会直接覆盖磁盘上的既有内容，`b/x.png` 还会被改名成 `b/x 2.png`
 * 导致笔记里的相对链接失效。现在每个目录各自维护一份「完整相对路径」集合，并先用
 * 目录里真实存在的名字种子化，写入前还会再探测一次。
 */
export async function importFilesIntoOpfs(
  files: FileList | File[],
  targetDir: string,
  options: { maxBytes?: number } = {},
): Promise<UploadResult> {
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const root = await opfsWorkspaceDir(targetDir);
  const takenByDir = new Map<string, Set<string>>();
  const dirHandles = new Map<string, FileSystemDirectoryHandle>();
  const result: UploadResult = { files: 0, bytes: 0, skipped: 0 };

  for (const file of Array.from(files)) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
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
    let dir = dirHandles.get(directory);
    if (!dir) {
      dir = await ensureDirectory(root, directory);
      dirHandles.set(directory, dir);
    }
    let taken = takenByDir.get(directory);
    if (!taken) {
      taken = await namesIn(dir);
      takenByDir.set(directory, taken);
    }

    // 先按磁盘现状种子化，再逐个候选路径复核（别的标签页可能刚写过同名文件）
    let candidate = joinPath(directory, baseName(safe));
    while (await entryExists(dir, baseName(candidate))) {
      taken.add(candidate);
      candidate = uniquePath(joinPath(directory, baseName(safe)), taken);
    }
    const finalPath = joinPath(directory, baseName(candidate));
    taken.add(finalPath);

    let created: FileSystemFileHandle | null = null;
    try {
      created = await dir.getFileHandle(baseName(finalPath), { create: true });
      await writeInto(created, file, finalPath);
      result.files += 1;
      result.bytes += file.size;
    } catch (error) {
      // 名字是这次刚占下的（写之前探测过不存在），失败就清掉，别在笔记本里留空文件
      if (created) await dir.removeEntry(baseName(finalPath), { recursive: false }).catch(() => undefined);
      console.warn("[opennote] 写入失败", finalPath, error);
      result.skipped += 1;
    }
  }
  return result;
}
