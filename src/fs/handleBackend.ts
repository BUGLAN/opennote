import { isDomError, notFoundError, toUserError, writeInto } from "./io";
import { assertSafeRelative, baseName, parentPath } from "./paths";
import type { BackendKind, EntryInfo, FileSystemBackend } from "./types";

/**
 * 临时文件名的标记。以 `.` 开头是故意的：万一在覆盖目标前进程被杀，残骸会被
 * `isHiddenPath` 当成隐藏文件，不会作为一篇「笔记」出现在笔记本里。
 */
const TEMP_MARK = ".opennote-";

/**
 * Backend for any `FileSystemDirectoryHandle` root. Both the File System Access
 * API (a folder the user picked) and OPFS (the browser's own file system)
 * hand out the same handle types, so one implementation serves both.
 *
 * Error semantics are deliberately the same as the Node backend's (D33):
 * missing entries throw 中文「找不到：<path>」, `remove('')` refuses to delete the
 * workspace root, `remove` of a missing path succeeds (like `rm force:true`),
 * `exists('')` is true, `stat` of a directory / missing path is `null`.
 */
export function createHandleBackend(root: FileSystemDirectoryHandle, kind: BackendKind): FileSystemBackend {
  const segments = (relPath: string): string[] => assertSafeRelative(relPath).split("/").filter(Boolean);
  /** D34: Windows / macOS 上 `NOTE.md` 与 `note.md` 是同一个文件，比较一律折叠大小写。 */
  const fold = (value: string): string => value.toLowerCase();

  /** 内部查找只抛原始 DOM 异常，由各公开方法统一翻译成中文（见 io.ts）。 */
  async function directory(relPath: string, create = false): Promise<FileSystemDirectoryHandle> {
    let current = root;
    for (const segment of segments(relPath)) {
      current = await current.getDirectoryHandle(segment, { create });
    }
    return current;
  }

  async function fileHandle(relPath: string, create = false): Promise<FileSystemFileHandle> {
    const safe = assertSafeRelative(relPath);
    if (!safe) throw new Error("缺少文件名");
    const dir = await directory(parentPath(safe), create);
    return dir.getFileHandle(baseName(safe), { create });
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

  /** D34(b): 目录内是否已有「折叠大小写后同名」的条目。 */
  async function hasFoldedEntry(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
    try {
      const wanted = fold(name);
      return (await entriesOf(dir)).some(([entry]) => fold(entry) === wanted);
    } catch {
      // 枚举不可用时退化成精确探测：宁可漏判，也不能覆盖别人的文件
      return entryExists(dir, name);
    }
  }

  async function temporaryName(dir: FileSystemDirectoryHandle, name: string): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = `.${name}${TEMP_MARK}${Math.random().toString(36).slice(2, 10)}.tmp`;
      if (!(await entryExists(dir, candidate).catch(() => false))) return candidate;
    }
    return `.${name}${TEMP_MARK}${Date.now()}.tmp`;
  }

  /**
   * D21: FSA 没有 `rename`，`createWritable()` 直接作用在目标文件上——写一半失败
   * 就毁掉原文。这里先把整份内容写进同目录临时文件，成功后再覆盖目标：失败只损失
   * 临时文件，原文件一个字节都没动。
   *
   * 注意：这不是真正的原子替换（浏览器里没有可用的 rename），只是把「半截内容」
   * 的窗口缩到最小；最后的覆盖写如果失败，目标仍可能不完整。
   */
  async function writeFileSafely(
    dir: FileSystemDirectoryHandle,
    name: string,
    data: BlobPart,
    relPath: string,
  ): Promise<void> {
    const tempName = await temporaryName(dir, name);
    const tempHandle = await dir.getFileHandle(tempName, { create: true });
    let ready = false;
    try {
      await writeInto(tempHandle, data, relPath);
      ready = true;
    } finally {
      if (!ready) await dir.removeEntry(tempName).catch(() => undefined);
    }
    try {
      await writeInto(await dir.getFileHandle(name, { create: true }), data, relPath);
    } finally {
      await dir.removeEntry(tempName).catch(() => undefined);
    }
  }

  async function copyDirectory(source: FileSystemDirectoryHandle, destination: FileSystemDirectoryHandle): Promise<void> {
    for (const [name, handle] of await entriesOf(source)) {
      if (handle.kind === "directory") {
        await copyDirectory(handle as FileSystemDirectoryHandle, await destination.getDirectoryHandle(name, { create: true }));
      } else {
        const bytes = await (await (handle as FileSystemFileHandle).getFile()).arrayBuffer();
        await writeInto(await destination.getFileHandle(name, { create: true }), bytes, name);
      }
    }
  }

  /**
   * D34(c): 回滚目标前先确认它还是本次调用创建的那个条目（TOCTOU：另一个标签页
   * 可能已经把目标替换成自己的文件，那种情况下一个字节都不能删）。
   */
  async function rollbackTarget(
    parent: FileSystemDirectoryHandle,
    name: string,
    created: FileSystemHandle | null,
  ): Promise<void> {
    if (!created) return;
    const current =
      (await parent.getFileHandle(name).catch(() => null)) ??
      (await parent.getDirectoryHandle(name).catch(() => null));
    if (!current) return;
    if (typeof current.isSameEntry === "function") {
      const same = await current.isSameEntry(created).catch(() => true);
      if (!same) return;
    }
    await parent.removeEntry(name, { recursive: true }).catch(() => undefined);
  }

  async function performMove(source: string, target: string): Promise<void> {
    const sourceParent = await directory(parentPath(source));
    const sourceName = baseName(source);
    const sourceFile = await sourceParent.getFileHandle(sourceName).catch(() => null);
    const sourceDir = sourceFile ? null : await sourceParent.getDirectoryHandle(sourceName).catch(() => null);
    if (!sourceFile && !sourceDir) throw notFoundError(source);

    const targetParent = await directory(parentPath(target), true);
    const targetName = baseName(target);
    // D34(b): 存在性判定必须是折叠大小写后的，否则会覆盖同名但大小写不同的既有文件
    if (await hasFoldedEntry(targetParent, targetName)) throw new Error(`目标路径已存在：${target}`);

    let createdHandle: FileSystemHandle | null = null;
    try {
      if (sourceFile) {
        createdHandle = await targetParent.getFileHandle(targetName, { create: true });
        await writeInto(createdHandle as FileSystemFileHandle, await (await sourceFile.getFile()).arrayBuffer(), target);
      } else if (sourceDir) {
        createdHandle = await targetParent.getDirectoryHandle(targetName, { create: true });
        await copyDirectory(sourceDir, createdHandle as FileSystemDirectoryHandle);
      }
      await sourceParent.removeEntry(sourceName, { recursive: Boolean(sourceDir) });
    } catch (error) {
      // D34(c): 只有本次调用确实创建了目标，才允许回滚它
      await rollbackTarget(targetParent, targetName, createdHandle);
      throw error;
    }
  }

  return {
    kind,
    label: kind === "fsa" ? "浏览器文件夹" : "浏览器本地",
    canWrite: true,

    async list(relPath) {
      const safe = assertSafeRelative(relPath);
      try {
        const dir = await directory(safe);
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
      } catch (error) {
        throw toUserError(error, safe, "directory");
      }
    },

    async readText(relPath) {
      const safe = assertSafeRelative(relPath);
      try {
        const handle = await fileHandle(safe);
        return await (await handle.getFile()).text();
      } catch (error) {
        throw toUserError(error, safe, "file");
      }
    },

    async readBytes(relPath) {
      const safe = assertSafeRelative(relPath);
      try {
        const handle = await fileHandle(safe);
        return new Uint8Array(await (await handle.getFile()).arrayBuffer());
      } catch (error) {
        throw toUserError(error, safe, "file");
      }
    },

    async writeText(relPath, text) {
      const safe = assertSafeRelative(relPath);
      if (!safe) throw new Error("缺少文件名");
      try {
        await writeFileSafely(await directory(parentPath(safe), true), baseName(safe), text, safe);
      } catch (error) {
        throw toUserError(error, safe, "file");
      }
    },

    async writeBytes(relPath, data) {
      const safe = assertSafeRelative(relPath);
      if (!safe) throw new Error("缺少文件名");
      try {
        const payload = data instanceof Blob ? data : new Blob([data as BlobPart]);
        await writeFileSafely(await directory(parentPath(safe), true), baseName(safe), payload, safe);
      } catch (error) {
        throw toUserError(error, safe, "file");
      }
    },

    async mkdir(relPath) {
      const safe = assertSafeRelative(relPath);
      if (!safe) return;
      try {
        await directory(safe, true);
      } catch (error) {
        throw toUserError(error, safe, "directory");
      }
    },

    async remove(relPath, options) {
      const safe = assertSafeRelative(relPath);
      if (!safe) throw new Error("不能删除笔记本根目录");
      let parent: FileSystemDirectoryHandle;
      try {
        parent = await directory(parentPath(safe));
      } catch (error) {
        // 与桌面端 rm(force:true) 一致：连父目录都不存在时也算删除成功
        if (isDomError(error, "NotFoundError")) return;
        throw toUserError(error, safe, "directory");
      }
      try {
        await parent.removeEntry(baseName(safe), { recursive: options?.recursive ?? false });
      } catch (error) {
        if (isDomError(error, "NotFoundError")) return;
        throw toUserError(error, safe, "directory");
      }
    },

    async move(from, to) {
      const source = assertSafeRelative(from);
      const target = assertSafeRelative(to);
      if (!source || !target) throw new Error("不能移动笔记本根目录");
      // D34(a): 折叠大小写后相同 → 直接返回，绝不删除任何文件
      // （浏览器端「只改大小写」的重命名因此是 no-op，UX 由数据层用两步 move 完成）
      if (fold(source) === fold(target)) return;
      if (fold(target).startsWith(`${fold(source)}/`)) throw new Error("不能将文件夹移动到自身内部");
      try {
        await performMove(source, target);
      } catch (error) {
        throw toUserError(error, source);
      }
    },

    async exists(relPath) {
      const safe = assertSafeRelative(relPath);
      if (!safe) return true;
      try {
        return await entryExists(await directory(parentPath(safe)), baseName(safe));
      } catch {
        return false;
      }
    },

    async stat(relPath) {
      const safe = assertSafeRelative(relPath);
      if (!safe) return null;
      try {
        const handle = await fileHandle(safe);
        const entry = await handle.getFile();
        return { size: entry.size, mtimeMs: entry.lastModified };
      } catch {
        // 缺失 / 是目录 / 无权限统一返回 null。目录不受保证：浏览器不暴露目录元数据，
        // 契约见 FileSystemBackend.stat（判定目录存在请用 exists()）。
        return null;
      }
    },
  } satisfies FileSystemBackend;
}
