/**
 * 给 `FileSystemBackend` 套一层「写完就报告」的装饰器。
 *
 * ## 为什么是装饰器，而不是在四个产地各加一行
 *
 * 写入产地有四个（编辑器保存 / 收件箱入库 / 导入与迁移 / GitHub 拉取），
 * 它们唯一的共同点是：**都经由同一个 `FileSystemBackend` 对象写盘**。
 * 所以通知挂在这里，新增产地**自动**接入 —— 这正是本次缺陷的成因
 * （四个产地各写各的，谁也没想起要通知同步层）。
 *
 * ## 它只做加法，不改任何语义
 *
 * - 所有方法原样转发，返回值、异常一字不改；
 * - 只有**写成功之后**才报告（`writeText` / `writeBytes` / `move` / `remove`）。
 *   `mkdir` 也报告，但标 `content: false`（目录不同步）。
 * - 读方法（`list` / `readText` / `readBytes` / `stat` / `exists`）**完全不碰** ——
 *   读不该有任何副作用，报告一次读会让同步层在扫描时自己触发自己。
 *
 * ## 为什么不在这里做忽略过滤
 *
 * 「哪些路径不该触发同步」是同步层的知识（`ignore.ts` 的内置集 + `.gitignore`），
 * 文件系统层不知道、也不该知道。这里只如实报告「写了什么」，
 * 由订阅方（`sync/appSync.ts`）自己判。
 *
 * 尤其重要的一条：**账本落盘（`.opennote/sync.json`）走的是同一个后端**。
 * 在这里过滤就等于把 `.opennote/` 的排除规则复制一份到 fs 层 ——
 * 复制出来的表迟早与 `ignore.ts` 漂移。
 */

import type { EntryInfo, FileSystemBackend } from "./types";
import { reportWorkspaceWrite } from "./writeLog";

export interface WriteObserverOptions {
  /**
   * 报告失败时要不要让它冒泡。默认 `false`：
   * **通知是事后的事，不能把已经成功的写盘变成一次失败**。
   */
  strict?: boolean;
}

/**
 * 把 `backend` 包成「写成功即通知」的版本。
 *
 * `kind` / `label` / `canWrite` 三个只读字段**原样透出**：调用方（尤其
 * `library.ts` 里按 `kind` 分支的逻辑，例如「opfs 不做 focus 重扫」）依赖它们。
 */
export function observeWrites(backend: FileSystemBackend, options: WriteObserverOptions = {}): FileSystemBackend {
  const report = (paths: string[], content: boolean): void => {
    try {
      reportWorkspaceWrite({ paths, content });
    } catch (error) {
      if (options.strict) throw error;
      console.warn("[opennote] 写入通知失败（写盘本身已成功）", error);
    }
  };

  const wrapped: FileSystemBackend = {
    kind: backend.kind,
    label: backend.label,
    canWrite: backend.canWrite,

    list: (relPath: string): Promise<EntryInfo[]> => backend.list(relPath),
    readText: (relPath: string): Promise<string> => backend.readText(relPath),
    readBytes: (relPath: string): Promise<Uint8Array> => backend.readBytes(relPath),
    stat: (relPath: string) => backend.stat(relPath),
    exists: (relPath: string): Promise<boolean> => backend.exists(relPath),

    async writeText(relPath: string, text: string): Promise<void> {
      await backend.writeText(relPath, text);
      report([relPath], true);
    },

    async writeBytes(relPath: string, data: Uint8Array | Blob): Promise<void> {
      await backend.writeBytes(relPath, data);
      report([relPath], true);
    },

    async mkdir(relPath: string): Promise<void> {
      await backend.mkdir(relPath);
      // 目录不同步（`selectSyncableEntries` 丢弃 `isDir`），所以不单独触发一轮推送。
      report([relPath], false);
    },

    async remove(relPath: string, removeOptions?: { recursive?: boolean }): Promise<void> {
      await backend.remove(relPath, removeOptions);
      /*
       * 删除**一定**报告 `content: true`：同步层要靠它把「本地没了」推成墓碑。
       * 不传 `recursive` 也会落到这里 —— 是否递归不影响「这条路径没了」这个事实。
       */
      report([relPath], true);
    },

    async move(from: string, to: string): Promise<void> {
      await backend.move(from, to);
      // 源与目标**都要**报告：只报目标会让「源不见了」被当成远端删除。
      report([from, to], true);
    },
  };
  return markObserved(wrapped);
}

/**
 * 这个后端是不是已经被包过了。
 *
 * 用来防「包两层」：两层会在一次落盘里报告两次（功能上不致命，但会让
 * 「一次写入 = 一次触发」这条断言变得不可靠，也会让诊断日志翻倍）。
 */
const observed = new WeakSet<object>();

export function isObserved(backend: FileSystemBackend): boolean {
  return observed.has(backend as unknown as object);
}

/** 给 `observeWrites` 的产物做标记（内部用；`observeWrites` 自己会调）。 */
export function markObserved(backend: FileSystemBackend): FileSystemBackend {
  observed.add(backend as unknown as object);
  return backend;
}
