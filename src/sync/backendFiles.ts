/**
 * 把 `FileSystemBackend`（真实文件系统的统一接口）适配成同步引擎要的
 * `SyncFileBackend`（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §5.3、§3.11）。
 *
 * ## 为什么是两层而不是一层
 *
 * `FileSystemBackend`（`src/fs/types.ts`）服务的是**整个应用**：读写笔记、列目录、
 * 改名、看元数据。它不知道同步，也不该知道。
 *
 * `SyncFileBackend`（`workspaceFiles.ts`）服务的是**同步**：只需要
 * 「列出全部条目 / 读 / 写 / 删」四件事，而且刻意做成「列出全部」而不是「递归遍历」——
 * 因为过滤与哈希才是同步相关的逻辑，遍历是各后端自己的事。
 *
 * 夹在中间的这一层只做**递归遍历**，并且是**唯一**一处递归：
 * 三个后端（node / fsa / opfs）的 `list()` 都只列**一层**，所以谁来走这棵树
 * 必须只有一份实现 —— 否则三个后端的同步行为会不一致，而那种不一致极难发现。
 *
 * ## 一个容易踩的坑：递归要有**深度上限**
 *
 * 同步会遍历用户的工作区。如果那里有一个符号链接指回上层目录（或 OPFS 里
 * 某种自引用结构），一个没有上限的递归会**把内存吃光**。
 * 所以这里限制深度，并在超限时**明确报错**而不是静默截断 ——
 * 静默截断意味着「一部分文件永远不同步」，而用户看不出为什么。
 */

import type { FileSystemBackend } from "../fs/types";
import type { LocalEntry, SyncFileBackend } from "./workspaceFiles";

/** 目录递归的深度上限（防符号链接环 / 异常深的工作区）。 */
export const MAX_SYNC_DEPTH = 32;

/** 一次同步最多看多少个条目（与扫描的 `maxFiles` 同族的护栏）。 */
export const MAX_SYNC_ENTRIES = 20000;

export interface BackendSyncFilesOptions {
  backend: FileSystemBackend;
  maxDepth?: number;
  maxEntries?: number;
}

/** 把工作区相对路径拼起来（永远用 `/`，与 did 的规范化一致）。 */
function joinPath(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}

/**
 * 递归列出**全部**条目（含被忽略的 —— 过滤是 `workspaceFiles.ts` 的事）。
 *
 * 顺序：深度优先，同一层内**按名字排序**。排序不是装饰：
 * 它让「同一棵树两次列出得到同样的顺序」，于是用例与诊断输出可比对。
 */
async function listAll(options: BackendSyncFilesOptions): Promise<LocalEntry[]> {
  const maxDepth = options.maxDepth ?? MAX_SYNC_DEPTH;
  const maxEntries = options.maxEntries ?? MAX_SYNC_ENTRIES;
  const out: LocalEntry[] = [];
  /** 显式的栈，避免深目录把调用栈压爆。 */
  const queue: { path: string; depth: number }[] = [{ path: "", depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth > maxDepth) {
      // 明确报错，不静默截断 —— 静默截断意味着「一部分文件永远不同步」。
      throw new Error(`工作区目录太深（超过 ${maxDepth} 层）：${current.path || "."}`);
    }
    let entries;
    try {
      entries = await options.backend.list(current.path);
    } catch {
      // 读不了的目录（权限 / 竞态删掉了）跳过这一支，而不是让整轮同步失败。
      continue;
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = joinPath(current.path, entry.name);
      const isDir = entry.kind === "directory";
      out.push({ path, isDir });
      if (out.length > maxEntries) {
        throw new Error(`工作区条目太多（超过 ${maxEntries} 个），请检查是否误选了很大的目录`);
      }
      if (isDir) queue.push({ path, depth: current.depth + 1 });
    }
  }
  return out;
}

/**
 * 造一个给同步用的后端。
 *
 * `remove()` 用 `recursive: true`：远端确认删除一条路径时，本地那一侧可能
 * 已经变成了目录（或反过来），不递归删会留下半棵树 —— 而半棵树会被下一轮
 * 同步当成「新增」，于是**刚删掉的东西又回来了**。
 */
export function createBackendSyncFiles(options: BackendSyncFilesOptions): SyncFileBackend {
  return {
    list: () => listAll(options),
    read: (path) => options.backend.readBytes(path),
    write: (path, bytes) => options.backend.writeBytes(path, bytes),
    remove: async (path) => {
      await options.backend.remove(path, { recursive: true });
    },
  };
}
