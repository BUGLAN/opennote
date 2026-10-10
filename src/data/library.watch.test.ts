/**
 * D08 (second half): the renderer subscribes to the main-process workspace
 * watcher, so an edit made outside the app is noticed instead of only being
 * detected on the next save. The bridge is faked at `window.opennote` exactly
 * like the real preload exposes it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseName, parentPath } from "../fs/paths";
import type { EntryInfo, FileSystemBackend } from "../fs/types";
import type { WorkspaceRecord } from "./workspaces";

interface MockEntry {
  path: string;
  text: string;
  mtimeMs: number;
}

/** Just enough of a disk for `scanWorkspace` + `flushNote` + `writeStateFile`. */
class MockBackend implements FileSystemBackend {
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

  text(path: string): string | undefined {
    return this.files.get(path)?.text;
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

  /** Like the real backends: refuses to overwrite an existing target. */
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

const backends = new Map<string, MockBackend>();
const records = new Map<string, WorkspaceRecord>();

vi.mock("./workspaces", () => ({
  activeWorkspaceRecord: () => null,
  resolveBackend: async (record: WorkspaceRecord) => backends.get(record.id),
  setActiveWorkspace: () => undefined,
}));

import { closeWorkspace, getLibrary, openWorkspace, updateNoteContent } from "./library";
import { patchUi } from "./ui";

interface WatchCalls {
  calls: string[];
  /** Roots the preload was asked to watch and has not been told to unwatch. */
  watched: Set<string>;
  listenerCount: number;
  emit(event: string | { v: 2; root: string; changes: Array<{ path: string; type: string }> }): void;
}

/** A fake `window.opennote`; `watch: false` mimics a preload without the watch API. */
function installBridge(options: { watch?: boolean; withWindow?: boolean } = {}): WatchCalls {
  const listeners = new Set<(event: string | { v: 2; root: string; changes: Array<{ path: string; type: string }> }) => void>();
  const watched = new Set<string>();
  const calls: string[] = [];
  const fs: Record<string, unknown> = options.watch === false
    ? {}
    : {
        watchWorkspace: async (root: string) => {
          calls.push(`watch:${root}`);
          watched.add(root);
          return true;
        },
        unwatchWorkspace: async (root: string) => {
          calls.push(`unwatch:${root}`);
          watched.delete(root);
          return true;
        },
        onWorkspaceChanged: (callback: (event: string | { v: 2; root: string; changes: Array<{ path: string; type: string }> }) => void) => {
          calls.push("subscribe");
          listeners.add(callback);
          return () => {
            calls.push("unsubscribe");
            listeners.delete(callback);
          };
        },
      };
  if (options.withWindow !== false) {
    vi.stubGlobal("window", { opennote: { isElectron: true, platform: "win32", version: "0.2.0", fs } });
  }
  return {
    calls,
    watched,
    get listenerCount() {
      return listeners.size;
    },
    emit(event: string | { v: 2; root: string; changes: Array<{ path: string; type: string }> }) {
      for (const callback of [...listeners]) callback(event);
    },
  };
}

function scenario(id: string, seed: (backend: MockBackend) => void): MockBackend {
  const backend = new MockBackend();
  seed(backend);
  backends.set(id, backend);
  records.set(id, {
    id,
    name: `笔记本 ${id}`,
    kind: "node",
    location: `C:\\笔记\\${id}`,
    addedAt: 1,
    lastOpenedAt: 1,
  });
  return backend;
}

function rootOf(id: string): string {
  return records.get(id)!.location;
}

async function openRecord(id: string): Promise<void> {
  await openWorkspace(records.get(id)!, { silent: true });
}

/** How often the workspace root was listed: one per full scan. */
function scans(backend: MockBackend): number {
  return backend.calls.filter((call) => call === "list:").length;
}

/** Let pending promise chains finish while the fake clock advances a little. */
async function settle(): Promise<void> {
  for (let index = 0; index < 60; index += 1) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(10);
  for (let index = 0; index < 60; index += 1) await Promise.resolve();
}

beforeEach(async () => {
  backends.clear();
  records.clear();
  vi.useFakeTimers();
  // 这些用例的时钟推进按旧默认延时 450ms 写死；自动保存默认值改为 1000ms 后，
  // 统一在这里夹回 450，让「停笔 → 落盘」仍落在 600ms 的推进窗口里。
  patchUi({ autoSave: "afterDelay", autoSaveDelay: 450 });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await closeWorkspace().catch(() => undefined);
});

afterEach(async () => {
  await closeWorkspace().catch(() => undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("D08 目录监听接线", () => {
  it("打开工作区时订阅并开始监听，关闭时退订并停止监听", async () => {
    const bridge = installBridge();
    scenario("A", (backend) => backend.seed("a.md", "# a"));
    await openRecord("A");
    expect(bridge.listenerCount).toBe(1);
    expect(bridge.watched.has(rootOf("A"))).toBe(true);
    expect(bridge.calls).toEqual(["subscribe", `watch:${rootOf("A")}`]);

    await closeWorkspace();
    expect(bridge.listenerCount).toBe(0);
    expect(bridge.watched.size).toBe(0);
    expect(bridge.calls).toEqual(["subscribe", `watch:${rootOf("A")}`, "unsubscribe", `unwatch:${rootOf("A")}`]);
  });

  it("外部改动被通知后重新读取磁盘（新增文件与外部编辑都能看到）", async () => {
    const bridge = installBridge();
    const backend = scenario("A", (b) => b.seed("a.md", "# 磁盘上的旧内容"));
    await openRecord("A");
    const before = scans(backend);

    backend.seed("外部新增.md", "# 同步盘放进来的文件");
    backend.seed("a.md", "# 外部编辑器改过的内容");
    bridge.emit(rootOf("A"));
    await vi.advanceTimersByTimeAsync(600);
    await settle();

    expect(scans(backend) - before).toBe(1);
    expect(getLibrary().notes["外部新增.md"]?.content).toBe("# 同步盘放进来的文件");
    expect(getLibrary().notes["a.md"]?.content).toBe("# 外部编辑器改过的内容");
  });

  it("通知风暴（去抖窗口内多次）只触发一次重扫", async () => {
    const bridge = installBridge();
    const backend = scenario("A", (b) => b.seed("a.md", "# a"));
    await openRecord("A");
    const before = scans(backend);

    for (let index = 0; index < 5; index += 1) bridge.emit(rootOf("A"));
    await vi.advanceTimersByTimeAsync(600);
    await settle();

    expect(scans(backend) - before).toBe(1);
  });

  it("v2 载荷（带变化路径）按路径增量刷新；其他笔记本的 v2 事件不触发", async () => {
    const bridge = installBridge();
    const backend = scenario("A", (b) => b.seed("a.md", "# a"));
    await openRecord("A");
    const before = scans(backend);

    // 变化的是一个不存在的路径：按路径刷新发现文件不在 ⇒ 无事发生，且不做全量重扫。
    bridge.emit({ v: 2, root: rootOf("A"), changes: [{ path: "不存在.md", type: "add" }] });
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    expect(scans(backend) - before).toBe(0);

    bridge.emit({ v: 2, root: "C:\\别的地方", changes: [{ path: "x.md", type: "update" }] });
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    expect(scans(backend) - before).toBe(0);
  });

  it("v2 按路径刷新：干净笔记被外部改动 → 采纳该文件，且不做全量重扫", async () => {
    const bridge = installBridge();
    const backend = scenario("A", (b) => {
      b.seed("a.md", "# a");
      b.seed("b.md", "# b");
    });
    await openRecord("A");
    const before = scans(backend);

    backend.seed("a.md", "# 外部新版本");
    bridge.emit({ v: 2, root: rootOf("A"), changes: [{ path: "a.md", type: "update" }] });
    await vi.advanceTimersByTimeAsync(600);
    await settle();

    expect(getLibrary().notes["a.md"]?.content).toBe("# 外部新版本");
    expect(backend.text("a.md")).toBe("# 外部新版本");
    expect(getLibrary().dirty["a.md"]).toBeUndefined();
    expect(scans(backend) - before).toBe(0);
  });

  it("v2 按路径刷新：外部新增 .md 入树（父目录节点补齐）", async () => {
    const bridge = installBridge();
    const backend = scenario("A", (b) => b.seed("a.md", "# a"));
    await openRecord("A");

    backend.seed("新建目录/新笔记.md", "# 新笔记");
    bridge.emit({ v: 2, root: rootOf("A"), changes: [{ path: "新建目录/新笔记.md", type: "add" }] });
    await vi.advanceTimersByTimeAsync(600);
    await settle();

    expect(getLibrary().notes["新建目录/新笔记.md"]?.content).toBe("# 新笔记");
    expect(getLibrary().folders["新建目录"]).toBeDefined();
  });

  it("v2 按路径刷新：外部删除 → 笔记出树", async () => {
    const bridge = installBridge();
    const backend = scenario("A", (b) => {
      b.seed("a.md", "# a");
      b.seed("b.md", "# b");
    });
    await openRecord("A");

    backend.remove("b.md");
    bridge.emit({ v: 2, root: rootOf("A"), changes: [{ path: "b.md", type: "delete" }] });
    await vi.advanceTimersByTimeAsync(600);
    await settle();

    expect(getLibrary().notes["b.md"]).toBeUndefined();
    expect(getLibrary().notes["a.md"]).toBeDefined();
  });

  it("事件批超限（git checkout 风暴）退回一次全量重扫", async () => {
    const bridge = installBridge();
    const backend = scenario("A", (b) => b.seed("a.md", "# a"));
    await openRecord("A");
    const before = scans(backend);

    const changes: Array<{ path: string; type: string }> = [];
    for (let index = 0; index < 51; index += 1) {
      backend.seed(`风暴-${index}.md`, "# x");
      changes.push({ path: `风暴-${index}.md`, type: "add" });
    }
    bridge.emit({ v: 2, root: rootOf("A"), changes });
    await vi.advanceTimersByTimeAsync(600);
    await settle();

    expect(scans(backend) - before).toBe(1);
    expect(getLibrary().notes["风暴-0.md"]).toBeDefined();
    expect(getLibrary().notes["风暴-50.md"]).toBeDefined();
  });

  it("重扫期间的更多通知只合并为一次尾随重扫", async () => {
    const bridge = installBridge();
    const backend = scenario("A", (b) => b.seed("a.md", "# a"));
    await openRecord("A");
    const before = scans(backend);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let blockNext = true;
    backend.hooks.onList = async (path) => {
      if (path === "" && blockNext) {
        blockNext = false;
        await gate;
      }
    };

    bridge.emit(rootOf("A"));
    await vi.advanceTimersByTimeAsync(600); // 第一次重扫开始并卡在 list()
    for (let index = 0; index < 3; index += 1) bridge.emit(rootOf("A"));
    await vi.advanceTimersByTimeAsync(600); // 三次通知都在「重扫进行中」到达
    release();
    await settle();
    backend.hooks.onList = undefined;

    expect(scans(backend) - before).toBe(2);
  });

  it("重扫不会把尚未落盘的本地正文回灌成磁盘旧内容", async () => {
    const bridge = installBridge();
    const backend = scenario("A", (b) => b.seed("a.md", "# 磁盘旧内容"));
    await openRecord("A");

    // 用户正在打字（450ms 去抖还没到），此时外部改动触发了重扫。
    updateNoteContent("a.md", "# 我还没保存的编辑");
    expect(getLibrary().dirty["a.md"]).toBe(true);
    backend.seed("外部新增.md", "# 同步盘放进来的文件");
    bridge.emit(rootOf("A"));
    await vi.advanceTimersByTimeAsync(600);
    await settle();

    // 重扫确实发生了（外部文件可见），而内存正文既没被覆盖，也确实落了盘。
    expect(getLibrary().notes["外部新增.md"]).toBeDefined();
    expect(getLibrary().notes["a.md"].content).toBe("# 我还没保存的编辑");
    expect(backend.text("a.md")).toBe("# 我还没保存的编辑");
    expect(getLibrary().dirty["a.md"]).toBeUndefined();
  });

  it("扫描进行中敲入的正文在 rescan 后仍保留并随后落盘", async () => {
    const bridge = installBridge();
    const backend = scenario("A", (b) => b.seed("a.md", "# 磁盘旧内容"));
    await openRecord("A");

    // 扫描读盘的那一刻用户敲了字：磁盘快照比内存旧，不得回灌。
    backend.hooks.onList = (path) => {
      if (path === "") updateNoteContent("a.md", "# 扫描期间敲的正文");
    };
    bridge.emit(rootOf("A"));
    await vi.advanceTimersByTimeAsync(600);
    backend.hooks.onList = undefined;

    expect(getLibrary().notes["a.md"].content).toBe("# 扫描期间敲的正文");
    expect(getLibrary().dirty["a.md"]).toBe(true);

    await vi.advanceTimersByTimeAsync(600); // 打字时的去抖写入
    await settle();
    expect(backend.text("a.md")).toBe("# 扫描期间敲的正文");
    expect(getLibrary().dirty["a.md"]).toBeUndefined();
  });

  it("关闭工作区后到达的通知不再触发重扫", async () => {
    const bridge = installBridge();
    const backend = scenario("A", (b) => b.seed("a.md", "# a"));
    await openRecord("A");

    // 对照组：打开时通知确实会重扫
    const open = scans(backend);
    bridge.emit(rootOf("A"));
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    expect(scans(backend) - open).toBe(1);

    await closeWorkspace();
    const before = scans(backend);
    bridge.emit(rootOf("A"));
    await vi.advanceTimersByTimeAsync(600);
    await settle();

    expect(bridge.listenerCount).toBe(0);
    expect(scans(backend)).toBe(before);
    expect(getLibrary().workspace).toBeNull();
  });

  it("切换工作区后旧工作区的通知不会重扫新工作区", async () => {
    const bridge = installBridge();
    scenario("A", (backend) => backend.seed("a.md", "# A 的内容"));
    const b = scenario("B", (backend) => backend.seed("b.md", "# B 的内容"));
    await openRecord("A");
    await openRecord("B");
    expect(bridge.watched.has(rootOf("A"))).toBe(false);
    expect(bridge.watched.has(rootOf("B"))).toBe(true);
    const before = scans(b);

    bridge.emit(rootOf("A"));      // 旧工作区的迟到通知
    bridge.emit("C:\\别的地方");    // 与本工作区无关的路径
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    expect(scans(b)).toBe(before);

    bridge.emit(rootOf("B"));
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    expect(scans(b) - before).toBe(1);
    expect(getLibrary().workspace?.id).toBe("B");
  });

  it("多次打开/关闭不累积监听器，也不重复重扫", async () => {
    const bridge = installBridge();
    const backend = scenario("A", (b) => b.seed("a.md", "# a"));
    for (let round = 0; round < 3; round += 1) {
      await openRecord("A");
      expect(bridge.listenerCount).toBe(1);
      await closeWorkspace();
      expect(bridge.listenerCount).toBe(0);
    }
    expect(bridge.calls.filter((call) => call === "subscribe")).toHaveLength(3);
    expect(bridge.calls.filter((call) => call === "unsubscribe")).toHaveLength(3);
    expect(bridge.watched.size).toBe(0);

    await openRecord("A");
    const before = scans(backend);
    bridge.emit(rootOf("A"));
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    expect(scans(backend) - before).toBe(1);
  });

  it("旧版 preload（没有监听 API）与浏览器端都不报错", async () => {
    const legacy = installBridge({ watch: false });
    scenario("A", (backend) => backend.seed("a.md", "# a"));
    await expect(openRecord("A")).resolves.toBeUndefined();
    expect(legacy.calls).toEqual([]);
    await expect(closeWorkspace()).resolves.toBeUndefined();

    // 浏览器端：连 window.opennote 都不存在
    vi.unstubAllGlobals();
    await expect(openRecord("A")).resolves.toBeUndefined();
    await expect(closeWorkspace()).resolves.toBeUndefined();
  });

  it("打开的失败路径不会留下监听器", async () => {
    const bridge = installBridge();
    scenario("A", (backend) => backend.seed("a.md", "# a"));
    await openRecord("A");
    expect(bridge.listenerCount).toBe(1);
    // 打开一个新的、后端解析失败的笔记本
    records.set("bad", { id: "bad", name: "坏笔记本", kind: "node", location: "C:\\笔记\\bad", addedAt: 1, lastOpenedAt: 1 });
    await expect(openRecord("bad")).rejects.toThrow();
    expect(bridge.listenerCount).toBe(0);
    expect(bridge.watched.size).toBe(0);
  });
});
