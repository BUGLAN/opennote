/**
 * 「外部改动检测」——同步核心（P1，磁盘赢）的行为锚点。
 *
 * 来源：2026-10-10 事故现场（`项目实战/system_panel/无限变强系统提示词(修复问题).conflict-2026-10-10-13-35.md`）。
 * 0.9.x 的行为是：应用自己的两次自动保存之间夹了一次整库重扫，重扫把 stat 表冲回
 * 旧版本，下一次保存就把**应用自己刚写的内容**当成「外部改动」——凭空生成
 * `.conflict-*.md` 并弹「检测到外部修改」。
 *
 * 重构后的语义（docs/设计-同步层与索引重构-2026-10-10.md，决定 D3/D4）：
 *   - 磁盘赢：磁盘出现了我们不知道的版本 → 未保存改动进**隐藏前像**
 *     （`.opennote/history/<笔记>/…-before-disk.md`），然后采纳磁盘版本；
 *   - 应用自己的写入（磁盘上就是 `fileStates` 记的那一版）⇒ 永远不会误判；
 *   - 不再生成 `.conflict-*.md`，不再弹「检测到外部修改」。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { baseName, parentPath } from "../fs/paths";
import type { EntryInfo, FileSystemBackend } from "../fs/types";
import type { WorkspaceRecord } from "./workspaces";
import { patchUi } from "./ui";

interface MockEntry {
  path: string;
  text: string;
  mtimeMs: number;
}

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

const backends = new Map<string, MockBackend>();
const records = new Map<string, WorkspaceRecord>();

vi.mock("./workspaces", () => ({
  activeWorkspaceRecord: () => null,
  resolveBackend: async (record: WorkspaceRecord) => backends.get(record.id),
  setActiveWorkspace: () => undefined,
}));

import { closeWorkspace, flushAll, getLibrary, openWorkspace, updateNoteContent } from "./library";

interface WatchCalls {
  emit(root: string): void;
}

function installBridge(): WatchCalls {
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
}

function scenario(id: string, seed: (backend: MockBackend) => void): MockBackend {
  const backend = new MockBackend();
  seed(backend);
  backends.set(id, backend);
  records.set(id, { id, name: `笔记本 ${id}`, kind: "node", location: `C:\\笔记\\${id}`, addedAt: 1, lastOpenedAt: 1 });
  return backend;
}

function rootOf(id: string): string {
  return records.get(id)!.location;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 60; index += 1) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(10);
  for (let index = 0; index < 60; index += 1) await Promise.resolve();
}

beforeEach(async () => {
  backends.clear();
  records.clear();
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  // 同步语义用例不关心默认延时的具体值：夹回 450ms 让「停笔 → 落盘」落在
  // 600ms 的时钟推进窗口里，断言保持确定。模式相关行为有专项用例（见文末）。
  patchUi({ autoSave: "afterDelay", autoSaveDelay: 450 });
  await closeWorkspace().catch(() => undefined);
});

describe("外部改动检测（同步核心：磁盘赢）", () => {
  it("【P1 已修复】重扫夹在自己两次保存之间：不再误判，磁盘上就是用户最新那版", async () => {
    const bridge = installBridge();
    // `sub/` 只是为了让扫描有第二次 `list()` 波次：根目录列表（带着 a.md 的
    // size/mtime 戳记）先完成，写入发生在它之后——0.9.x 在这里产生误判。
    const backend = scenario("A", (b) => {
      b.seed("a.md", "# 原始内容");
      b.seed("sub/别的.md", "# 子目录里的笔记");
    });
    await openWorkspace(records.get("A")!, { silent: true });

    // 全程没有外部写者：两个写入都来自应用自己。
    backend.hooks.onList = (path) => {
      if (path !== "sub") return;
      updateNoteContent("a.md", "# 应用自己刚落盘的一版", { immediate: true });
      updateNoteContent("a.md", "# 用户接着敲的一行");
    };
    bridge.emit(rootOf("A"));
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    backend.hooks.onList = undefined;

    // 磁盘上就是用户最新那版；没有副本、没有前像、没有提示。
    expect(backend.paths().some((path) => path.includes(".conflict-"))).toBe(false);
    expect(backend.paths().some((path) => path.includes("-before-disk"))).toBe(false);
    expect(getLibrary().error).toBeNull();
    expect(backend.text("a.md")).toBe("# 用户接着敲的一行");
    expect(getLibrary().notes["a.md"]?.content).toBe("# 用户接着敲的一行");
    expect(getLibrary().dirty["a.md"]).toBeUndefined();
  });

  it("【新】dirty 笔记被外部改动：本地未保存文本进隐藏前像，采纳磁盘版本", async () => {
    const bridge = installBridge();
    const backend = scenario("A", (b) => b.seed("a.md", "# 磁盘旧内容"));
    await openWorkspace(records.get("A")!, { silent: true });

    // 用户敲了字还没落盘，外部同步盘整篇重写了这个文件。
    updateNoteContent("a.md", "# 我没保存的编辑");
    backend.seed("a.md", "# 外部新版本");
    bridge.emit(rootOf("A"));
    await vi.advanceTimersByTimeAsync(600);
    await settle();

    // 磁盘赢：笔记显示磁盘版本；应用那版在隐藏前像里，可从「历史版本」捞回。
    expect(backend.text("a.md")).toBe("# 外部新版本");
    expect(getLibrary().notes["a.md"]?.content).toBe("# 外部新版本");
    expect(getLibrary().dirty["a.md"]).toBeUndefined();
    const preimages = backend.paths().filter((path) => path.includes("-before-disk"));
    expect(preimages).toHaveLength(1);
    expect(backend.text(preimages[0])).toBe("# 我没保存的编辑");
    expect(backend.paths().some((path) => path.includes(".conflict-"))).toBe(false);
    expect(getLibrary().error).toBeNull();
  });

  it("【新】干净笔记被外部改动：重扫直接采纳磁盘版本（无前像、无提示）", async () => {
    const bridge = installBridge();
    const backend = scenario("A", (b) => b.seed("a.md", "# 旧版本"));
    await openWorkspace(records.get("A")!, { silent: true });

    backend.seed("a.md", "# 外部新版本");
    bridge.emit(rootOf("A"));
    await vi.advanceTimersByTimeAsync(600);
    await settle();

    expect(backend.text("a.md")).toBe("# 外部新版本");
    expect(getLibrary().notes["a.md"]?.content).toBe("# 外部新版本");
    expect(backend.paths().some((path) => path.includes("-before-disk"))).toBe(false);
    expect(getLibrary().error).toBeNull();
  });
});

describe("自动保存模式（D5：三档，无 off）", () => {
  it("afterDelay：默认停笔 1000ms 才落盘，600ms 时还没写", async () => {
    scenario("A", (b) => b.seed("a.md", "# 旧"));
    await openWorkspace(records.get("A")!, { silent: true });
    patchUi({ autoSave: "afterDelay", autoSaveDelay: 1000 });

    updateNoteContent("a.md", "# 停笔落盘");
    await vi.advanceTimersByTimeAsync(600);
    expect(backends.get("A")!.text("a.md")).toBe("# 旧");

    await vi.advanceTimersByTimeAsync(600);
    expect(backends.get("A")!.text("a.md")).toBe("# 停笔落盘");
  });

  it("onFocusChange：不按延时落盘，flushAll（焦点离开）才写", async () => {
    scenario("A", (b) => b.seed("a.md", "# 旧"));
    await openWorkspace(records.get("A")!, { silent: true });
    patchUi({ autoSave: "onFocusChange" });

    updateNoteContent("a.md", "# 失焦才写");
    await vi.advanceTimersByTimeAsync(5000);
    expect(backends.get("A")!.text("a.md")).toBe("# 旧");

    await flushAll();
    expect(backends.get("A")!.text("a.md")).toBe("# 失焦才写");
  });
});
