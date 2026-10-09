/**
 * CLI 用的 Node 文件系统后端（`scripts/migrate-assets.mjs` 唯一需要的那一块「薄」适配）。
 *
 * 为什么需要它：迁移器只认 `FileSystemBackend`（`src/fs/types.ts`）—— 这是 R11 的落点，
 * 「网页版/OPFS 也能跑」靠的就是这层抽象。桌面端的 `createNodeBackend()` 走的是 Electron
 * preload 桥（渲染进程里才有），命令行里没有桥，所以这里直接用 `node:fs/promises` 实现同一套接口。
 *
 * 安全边界：**所有路径先过 `assertSafeRelative()`**，再拼到工作区根下。迁移器不该、
 * 也不能碰工作区之外的东西（`..`、绝对路径、`a.md:secret` 这类 NTFS 备用数据流一律当场报错）。
 */

import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertSafeRelative } from "../fs/paths";
import type { EntryInfo, FileSystemBackend } from "../fs/types";

export interface NodeBackendOptions {
  /** `false` = 只读后端（迁移器的 dry-run 就是这种姿态：能读、写会当场抛错）。 */
  canWrite?: boolean;
}

export function createNodeFsBackend(root: string, options: NodeBackendOptions = {}): FileSystemBackend {
  const canWrite = options.canWrite !== false;
  const absolute = (relPath: string): string => path.join(root, assertSafeRelative(relPath || ""));
  const guardWrite = (): void => {
    if (!canWrite) throw new Error(`只读后端：拒绝写入 ${root}`);
  };

  return {
    kind: "node",
    label: "本机磁盘",
    canWrite,

    async list(relPath: string): Promise<EntryInfo[]> {
      const entries = await readdir(absolute(relPath), { withFileTypes: true });
      const out: EntryInfo[] = [];
      for (const entry of entries) {
        const child = path.join(absolute(relPath), entry.name);
        const info = await lstat(child).catch(() => null);
        out.push({
          name: entry.name,
          kind: entry.isDirectory() ? "directory" : "file",
          size: info?.size ?? 0,
          mtimeMs: info?.mtimeMs ?? 0,
        });
      }
      return out;
    },

    async readText(relPath: string): Promise<string> {
      return readFile(absolute(relPath), "utf8");
    },

    async readBytes(relPath: string): Promise<Uint8Array> {
      return new Uint8Array(await readFile(absolute(relPath)));
    },

    async writeText(relPath: string, text: string): Promise<void> {
      guardWrite();
      const target = absolute(relPath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, text, "utf8");
    },

    async writeBytes(relPath: string, data: Uint8Array | Blob): Promise<void> {
      guardWrite();
      const target = absolute(relPath);
      await mkdir(path.dirname(target), { recursive: true });
      const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
      await writeFile(target, bytes);
    },

    async mkdir(relPath: string): Promise<void> {
      guardWrite();
      await mkdir(absolute(relPath), { recursive: true });
    },

    async remove(relPath: string, removeOptions?: { recursive?: boolean }): Promise<void> {
      guardWrite();
      const target = absolute(relPath);
      /*
       * **三支，不能合成一支**（D1 回修）。`fs.rm()` 在 Node 22 / win32 上对**目录**一律抛
       * `ERR_FS_EISDIR` —— 空目录也一样（实测见 src/data/migrateAssets.test.ts 的
       * 「真实 node 后端」一组用例）。迁移器的 `removeIfEmpty()` 收空目录时走的是
       * `remove(dir)`（不带 recursive），异常被它 `.catch(() => undefined)` 吞掉，
       * 结果就是「报告说收了、目录还在」。
       *
       * - `recursive === true` → 保持 `rm`（真要递归删时才走这支）；
       * - 目录（非 recursive）→ **`rmdir`**：空目录删得掉，非空目录抛 `ENOTEMPTY`。
       *   这条 `ENOTEMPTY` 是**安全边界**，不是要绕过的东西：调用方（`removeIfEmpty`）
       *   自己的「`list()` 为空」判据是唯一护栏，后端这里再兜一层，两边都拦；
       * - 文件（非 recursive）→ **`unlink`**：`rmdir` 对文件会抛 `ENOTDIR`，而阶段 D
       *   删迁移过的源附件走的正是这一支（同一个 `remove()` 要同时服务「删文件」与「收空目录」）。
       *
       * `rm` 那支的 `force:false` 是刻意的：删不掉就报错，让调用方知道「以为删了其实没删」。
       */
      if (removeOptions?.recursive === true) {
        await rm(target, { recursive: true, force: false });
        return;
      }
      const info = await lstat(target);
      if (info.isDirectory()) {
        await rmdir(target);
        return;
      }
      await unlink(target);
    },

    async move(from: string, to: string): Promise<void> {
      guardWrite();
      const target = absolute(to);
      await mkdir(path.dirname(target), { recursive: true });
      await rename(absolute(from), target);
    },

    async exists(relPath: string): Promise<boolean> {
      return lstat(absolute(relPath))
        .then(() => true)
        .catch(() => false);
    },

    async stat(relPath: string): Promise<{ size: number; mtimeMs: number } | null> {
      // `lstat`（不是 `stat`）：断链的符号链接也应当如实报告「存在」，别让 `stat` 的 ENOENT
      // 把它伪装成「什么都没有」。
      const info = await lstat(absolute(relPath)).catch(() => null);
      return info ? { size: info.size, mtimeMs: info.mtimeMs } : null;
    },
  };
}
