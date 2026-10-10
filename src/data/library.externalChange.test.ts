/**
 * 「外部改动检测」特征测试 —— 编码 0.9.x 的**当前**行为，含一个已知误判。
 *
 * 来源：2026-10-10 事故现场（`项目实战/system_panel/无限变强系统提示词(修复问题).conflict-2026-10-10-13-35.md`）。
 * 用户正在打字，应用自己的两次自动保存之间夹了一次整库重扫；重扫把 `knownStats`
 * 冲回旧版本，下一次保存就把**应用自己刚写的内容**当成了「外部改动」——
 * 凭空生成 `.conflict-*.md` 并弹「检测到外部修改」。
 *
 * ▍本文件是「同步层重构」的锚点（docs/设计-同步层与索引重构-2026-10-10.md）：
 *   - 标了【P1-改写】的用例现在断言旧行为（保持套件绿）；P1 落地后翻转为新语义：
 *     应用自己的写入 ⇒ 不产生副本、不提示。
 *   - 「真外部改动」的行为不受重构影响，回归测试在 `library.regression.test.ts` 的
 *     D08 块（那条用例 P1 之后仍然必须成立，只是提示与副本形态按产品决定改为
 *     「磁盘赢 + 隐藏前像」）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { baseName, parentPath } from "../fs/paths";
import type { EntryInfo, FileSystemBackend } from "../fs/types";
import type { WorkspaceRecord } from "./workspaces";

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

import { closeWorkspace, getLibrary, openWorkspace, updateNoteContent } from "./library";

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
  await closeWorkspace().catch(() => undefined);
});

describe("外部改动检测（特征：0.9.x 现状）", () => {
  it("【P1-改写】重扫期间应用自己落盘的一版，会被下一次保存当成外部改动并另存 .conflict 副本", async () => {
    const bridge = installBridge();
    // `sub/` 只是为了让扫描有第二次 `list()` 波次：根目录列表（带着 a.md 的
    // size/mtime 戳记）先完成，写入发生在它之后。
    const backend = scenario("A", (b) => {
      b.seed("a.md", "# 原始内容");
      b.seed("sub/别的.md", "# 子目录里的笔记");
    });
    await openWorkspace(records.get("A")!, { silent: true });

    // 全程没有外部写者：下面两个写入都来自应用自己。
    backend.hooks.onList = (path) => {
      if (path !== "sub") return;
      // (1) 应用自己的自动保存落在「扫描已经给 a.md 盖过戳」之后；
      updateNoteContent("a.md", "# 应用自己刚落盘的一版", { immediate: true });
      // (2) 用户在下一次（去抖的）保存之前接着打字。
      updateNoteContent("a.md", "# 用户接着敲的一行");
    };
    bridge.emit(rootOf("A"));
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    backend.hooks.onList = undefined;

    const copies = backend.paths().filter((path) => path.includes(".conflict-"));
    // 当前行为：把应用自己的中间版本另存为冲突副本并提示「外部修改」。
    // P1 之后：不产生副本、不提示（内容溯源判定——磁盘上那版就是 `fileStates` 记的「我们写的」）。
    expect(copies).toHaveLength(1);
    expect(backend.text(copies[0])).toBe("# 应用自己刚落盘的一版");
    expect(getLibrary().error).toContain("外部修改");
    expect(backend.text("a.md")).toBe("# 用户接着敲的一行");
  });
});
