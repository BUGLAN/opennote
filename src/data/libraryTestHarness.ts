/**
 * 库层测试的共用夹具（内存假后端 + 假桌面桥）。
 *
 * **为什么要有它**：`library.externalChange.test.ts` 与 `library.watch.test.ts` 各自抄了一份
 * 一模一样的 `MockBackend`。同步的用例（冲突账本、`applyExternalPaths`、SSE 脏标记）还要再加几份，
 * 三份拷贝一旦漂移，测出来的是夹具而不是产品。
 *
 * ⚠️ 现状如实说明：**目前只有 `library.conflict.test.ts` 用它**。把已有的两份旧拷贝也并过来
 * 是一次纯粹的测试重构，会碰到那两个文件的 400+ 行用例，所以单独做，不和语义改动混在一次提交里。
 *
 * ⚠️ **`vi.mock("./workspaces", …)` 不能搬进来** —— vitest 会把 `vi.mock` 提升到文件顶部，
 * 而它引用的 `backends` / `records` 必须是**调用方文件里的**模块级绑定。所以每个用例文件
 * 仍然自己写那 5 行 mock，然后 import 这里造出来的 `backends` / `records` / `scenario`。
 */
import { expect, vi } from "vitest";
import { baseName, parentPath } from "../fs/paths";
import type { EntryInfo, FileSystemBackend } from "../fs/types";
import type { WorkspaceRecord } from "./workspaces";

export interface MockEntry {
  path: string;
  text: string;
  mtimeMs: number;
}

/** Just enough of a disk for `scanWorkspace` + `flushNote` + `writeStateFile`. */
export class MockBackend implements FileSystemBackend {
  readonly kind = "node";
  readonly label = "模拟磁盘";
  readonly canWrite = true;
  readonly files = new Map<string, MockEntry>();
  readonly dirs = new Set<string>([""]);
  readonly calls: string[] = [];
  hooks: { onList?: (path: string) => void | Promise<void> } = {};
  private clock = 1_000;

  private mkdirParents(path: string): void {
    if (!path) return;
    this.dirs.add(path);
    this.mkdirParents(parentPath(path));
  }

  seed(path: string, text: string): void {
    this.mkdirParents(parentPath(path));
    this.files.set(path, { path, text, mtimeMs: ++this.clock });
  }

  /**
   * 以**指定的旧 mtime** 写一份内容 —— 模拟「从别的机器 / 网盘 / git clone 来的写入」。
   * 跨设备下 mtime 完全不可比：远端那一版可能比我们本地记录**更旧**。
   */
  seedWithMtime(path: string, text: string, mtimeMs: number): void {
    this.mkdirParents(parentPath(path));
    this.files.set(path, { path, text, mtimeMs });
  }

  text(path: string): string | undefined {
    return this.files.get(path)?.text;
  }

  paths(): string[] {
    return [...this.files.values()].map((entry) => entry.path);
  }

  async mkdir(path: string): Promise<void> {
    this.mkdirParents(path);
  }

  async list(path: string): Promise<EntryInfo[]> {
    this.calls.push(`list:${path}`);
    await this.hooks.onList?.(path);
    if (!this.dirs.has(path)) throw new Error(`ENOENT ${path}`);
    const dirs = [...this.dirs]
      .filter((candidate) => candidate && parentPath(candidate) === path)
      .map((candidate) => ({ name: baseName(candidate), kind: "directory" as const, size: 0, mtimeMs: 0 }));
    const files = [...this.files.values()]
      .filter((entry) => parentPath(entry.path) === path)
      .map((entry) => ({ name: baseName(entry.path), kind: "file" as const, size: entry.text.length, mtimeMs: entry.mtimeMs }));
    return [...dirs, ...files];
  }

  async readText(path: string): Promise<string> {
    const entry = this.files.get(path);
    if (!entry) throw new Error(`ENOENT ${path}`);
    return entry.text;
  }

  async readBytes(path: string): Promise<Uint8Array> {
    return new TextEncoder().encode(await this.readText(path));
  }

  async writeText(path: string, text: string): Promise<void> {
    this.calls.push(`write:${path}`);
    this.mkdirParents(parentPath(path));
    this.files.set(path, { path, text, mtimeMs: ++this.clock });
  }

  async writeBytes(path: string, bytes: Uint8Array | Blob): Promise<void> {
    const data = bytes instanceof Blob ? new Uint8Array(await bytes.arrayBuffer()) : bytes;
    await this.writeText(path, new TextDecoder().decode(data));
  }

  async exists(path: string): Promise<boolean> {
    return this.dirs.has(path) || this.files.has(path);
  }

  async stat(path: string): Promise<{ size: number; mtimeMs: number } | null> {
    const entry = this.files.get(path);
    return entry ? { size: entry.text.length, mtimeMs: entry.mtimeMs } : null;
  }

  async move(from: string, to: string): Promise<void> {
    this.calls.push(`move:${from}->${to}`);
    if (await this.exists(to)) throw new Error(`EEXIST ${to}`);
    const entry = this.files.get(from);
    if (!entry) throw new Error(`ENOENT ${from}`);
    this.files.delete(from);
    this.mkdirParents(parentPath(to));
    this.files.set(to, { ...entry, path: to, mtimeMs: ++this.clock });
  }

  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    this.calls.push(`remove:${path}${options?.recursive ? ":recursive" : ""}`);
    if (this.files.delete(path)) return;
    if (!this.dirs.has(path)) throw new Error(`ENOENT ${path}`);
    if (!options?.recursive) throw new Error(`ERR_FS_EISDIR ${path}`);
    for (const candidate of [...this.dirs]) if (candidate === path || candidate.startsWith(`${path}/`)) this.dirs.delete(candidate);
    for (const key of [...this.files.keys()]) if (key.startsWith(`${path}/`)) this.files.delete(key);
  }
}

/**
 * 每个用例文件各持一份（`vi.mock` 的工厂要引用它们，不能跨文件共享状态）。
 * 用 `createHarness()` 造，`beforeEach` 里 `reset()`。
 */
export interface LibraryHarness {
  backends: Map<string, MockBackend>;
  records: Map<string, WorkspaceRecord>;
  /** 造一个笔记本 + 它的假磁盘。 */
  scenario(id: string, seed: (backend: MockBackend) => void): MockBackend;
  /** 同一笔记本的假磁盘。 */
  backendOf(id: string): MockBackend;
  /** 该笔记本的「根路径」（假桌面桥按它过滤事件）。 */
  rootOf(id: string): string;
  /** 清空（`beforeEach` 里调）。 */
  reset(): void;
  /** 装假桌面桥：返回一个能手动触发「工作区变化」的句柄。 */
  installBridge(): WatchCalls;
}

export interface WatchCalls {
  emit(root: string): void;
}

export function createHarness(): LibraryHarness {
  const backends = new Map<string, MockBackend>();
  const records = new Map<string, WorkspaceRecord>();

  const harness: LibraryHarness = {
    backends,
    records,
    scenario(id, seed) {
      const backend = new MockBackend();
      seed(backend);
      backends.set(id, backend);
      records.set(id, { id, name: `笔记本 ${id}`, kind: "node", location: `C:\\笔记\\${id}`, addedAt: 1, lastOpenedAt: 1 });
      return backend;
    },
    backendOf(id) {
      const backend = backends.get(id);
      if (!backend) throw new Error(`没有这个笔记本：${id}`);
      return backend;
    },
    rootOf(id) {
      const record = records.get(id);
      if (!record) throw new Error(`没有这个笔记本：${id}`);
      return record.location;
    },
    reset() {
      backends.clear();
      records.clear();
    },
    installBridge() {
      const listeners = new Set<(root: string) => void>();
      const fs: Record<string, unknown> = {
        watchWorkspace: async () => true,
        unwatchWorkspace: async () => true,
        onWorkspaceChanged: (callback: (root: string) => void) => {
          listeners.add(callback);
          return () => listeners.delete(callback);
        },
      };
      vi.stubGlobal("window", { opennote: { isElectron: true, platform: "win32", version: "0.2.0", fs } });
      return {
        emit(root: string) {
          for (const callback of [...listeners]) callback(root);
        },
      };
    },
  };
  return harness;
}

/** 让被去抖 / 排队的工作跑完（微任务 + 定时器各走一轮）。 */
export async function settle(): Promise<void> {
  for (let index = 0; index < 60; index += 1) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(10);
  for (let index = 0; index < 60; index += 1) await Promise.resolve();
}

/**
 * 反复「推进时钟 + 冲刷微任务」直到 `predicate()` 为真，或超时。
 *
 * **为什么需要它**（踩过一次）：`settle()` 只推进固定时长，而一次外部改动要走
 * 「去抖 450ms → 重扫 → flushAll → 写前像 → 采纳磁盘」好几跳异步；固定时长在某些用例里
 * 会在链条中间就返回，于是断言读到的是**中间态** —— 表现为「明明打了 `count=1` 的日志，
 * 测试却看到 `list=[]`」。用条件等待而不是猜时长。
 */
export async function settleUntil(predicate: () => boolean, options: { steps?: number; msPerStep?: number } = {}): Promise<boolean> {
  const steps = options.steps ?? 40;
  const msPerStep = options.msPerStep ?? 50;
  for (let index = 0; index < steps; index += 1) {
    await settle();
    if (predicate()) return true;
    await vi.advanceTimersByTimeAsync(msPerStep);
  }
  await settle();
  return predicate();
}

/**
 * 断言假磁盘上**没有**产生冲突副本。
 *
 * 「绝不静默覆盖」的另一半是「也不要凭空造文件」：历史上前像写成过 `.conflict-*.md`，
 * 那会让用户以为自己多了几篇笔记（见 externalChange 用例的模块头）。
 */
export function expectNoConflictArtifacts(backend: MockBackend): void {
  expect(backend.paths().some((path) => path.includes(".conflict-"))).toBe(false);
}
