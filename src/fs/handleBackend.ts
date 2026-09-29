import { assertSafeRelative, baseName, parentPath } from "./paths";
import type { BackendKind, EntryInfo, FileSystemBackend } from "./types";

/**
 * Backend for any `FileSystemDirectoryHandle` root. Both the File System Access
 * API (a folder the user picked) and OPFS (the browser's own file system)
 * hand out the same handle types, so one implementation serves both.
 */
export function createHandleBackend(root: FileSystemDirectoryHandle, kind: BackendKind): FileSystemBackend {
  const segments = (relPath: string): string[] => assertSafeRelative(relPath).split("/").filter(Boolean);

  async function directory(relPath: string, create = false): Promise<FileSystemDirectoryHandle> {
    let current = root;
    for (const segment of segments(relPath)) {
      current = await current.getDirectoryHandle(segment, { create });
    }
    return current;
  }

  async function file(relPath: string, create = false): Promise<FileSystemFileHandle> {
    const safe = assertSafeRelative(relPath);
    if (!safe) throw new Error("缺少文件名");
    const dir = await directory(parentPath(safe), create);
    return dir.getFileHandle(baseName(safe), { create });
  }

  async function ensureParent(relPath: string): Promise<void> {
    const parent = parentPath(relPath);
    if (parent) await directory(parent, true);
  }

  /** Safari shipped OPFS without `entries()`; fall back to `keys()`. */
  async function entriesOf(dir: FileSystemDirectoryHandle): Promise<[string, FileSystemHandle][]> {
    const anyDir = dir as unknown as {
      entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
      keys?: () => AsyncIterableIterator<string>;
    };
    const out: [string, FileSystemHandle][] = [];
    if (typeof anyDir.entries === "function") {
      for await (const entry of anyDir.entries()) out.push(entry);
      return out;
    }
    if (typeof anyDir.keys === "function") {
      for await (const key of anyDir.keys()) {
        const handle =
          (await dir.getFileHandle(key).catch(() => null)) ?? (await dir.getDirectoryHandle(key).catch(() => null));
        if (handle) out.push([key, handle]);
      }
      return out;
    }
    throw new Error("当前浏览器不支持读取文件夹列表");
  }

  return {
    kind,
    label: kind === "fsa" ? "浏览器文件夹" : "浏览器本地",
    canWrite: true,

    async list(relPath) {
      const dir = await directory(relPath);
      const entries = await entriesOf(dir);
      const infos: EntryInfo[] = [];
      for (const [name, handle] of entries) {
        if (handle.kind === "directory") {
          infos.push({ name, kind: "directory", size: 0, mtimeMs: 0 });
          continue;
        }
        try {
          const entry = await (handle as FileSystemFileHandle).getFile();
          infos.push({ name, kind: "file", size: entry.size, mtimeMs: entry.lastModified });
        } catch {
          infos.push({ name, kind: "file", size: 0, mtimeMs: 0 });
        }
      }
      return infos.sort(
        (a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, "zh-Hans-CN") : a.kind === "directory" ? -1 : 1),
      );
    },

    async readText(relPath) {
      const handle = await file(relPath);
      return (await handle.getFile()).text();
    },

    async readBytes(relPath) {
      const handle = await file(relPath);
      return new Uint8Array(await (await handle.getFile()).arrayBuffer());
    },

    async writeText(relPath, text) {
      await ensureParent(relPath);
      const handle = await file(relPath, true);
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
    },

    async writeBytes(relPath, data) {
      await ensureParent(relPath);
      const handle = await file(relPath, true);
      const writable = await handle.createWritable();
      await writable.write(data instanceof Blob ? data : new Blob([data as BlobPart]));
      await writable.close();
    },

    async mkdir(relPath) {
      const safe = assertSafeRelative(relPath);
      if (safe) await directory(safe, true);
    },

    async remove(relPath, options) {
      const safe = assertSafeRelative(relPath);
      if (!safe) return;
      const parent = await directory(parentPath(safe));
      await parent.removeEntry(baseName(safe), { recursive: options?.recursive ?? true });
    },

    async move(from, to) {
      const source = assertSafeRelative(from);
      const target = assertSafeRelative(to);
      if (source === target) return;
      const bytes = await this.readBytes(source);
      await ensureParent(target);
      const handle = await file(target, true);
      const writable = await handle.createWritable();
      await writable.write(new Blob([bytes as BlobPart]));
      await writable.close();
      const parent = await directory(parentPath(source));
      await parent.removeEntry(baseName(source));
    },

    async exists(relPath) {
      const safe = assertSafeRelative(relPath);
      if (!safe) return true;
      try {
        const dir = await directory(parentPath(safe));
        const name = baseName(safe);
        if (await dir.getFileHandle(name).then(
          () => true,
          () => false,
        )) {
          return true;
        }
        return await dir.getDirectoryHandle(name).then(
          () => true,
          () => false,
        );
      } catch {
        return false;
      }
    },

    async stat(relPath) {
      try {
        const handle = await file(relPath);
        const entry = await handle.getFile();
        return { size: entry.size, mtimeMs: entry.lastModified };
      } catch {
        return null;
      }
    },
  } satisfies FileSystemBackend;
}
