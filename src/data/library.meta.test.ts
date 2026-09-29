/**
 * Regression test for the `.opennote/state.json` write path.
 *
 * The bug this file locks down: `writeStateFile` used to write `state.json.tmp`
 * and then call `move(tmp, state.json)`, using the *failure* of that move as the
 * probe for "the target already exists". Every backend's `move` refuses to
 * overwrite (see the `FileSystemBackend.move` contract, and the main process's
 * `opennote:fs:move`), so from the second metadata flush onward that move always
 * failed. The renderer caught it and fell back to remove+move, so the data was
 * fine — but Electron logs every rejected `ipcMain.handle`, which filled the
 * console with
 * `Error occurred in handler for 'opennote:fs:move': 目标路径已存在：.opennote/state.json`
 * on every debounced metadata write.
 *
 * The mock backend below reproduces the desktop (node) semantics: `move` throws
 * when the target exists and records that rejection in `rejectedMoves`. The test
 * therefore fails on the old implementation (rejectedMoves.length > 0) and passes
 * once the write goes through a single atomic `writeText`.
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

class MockBackend implements FileSystemBackend {
  readonly kind = "node";
  readonly label = "模拟磁盘";
  readonly canWrite = true;
  dirs: string[] = [""];
  readonly files = new Map<string, MockEntry>();
  /** Every move that was refused because the target already existed (the console spam). */
  readonly rejectedMoves: string[] = [];
  readonly failWrites = new Set<string>();
  private clock = 1_000;

  seed(path: string, text: string): MockEntry {
    this.mkdirSync(parentPath(path));
    const entry: MockEntry = { path, text, mtimeMs: ++this.clock };
    this.files.set(path, entry);
    return entry;
  }

  has(path: string): boolean {
    return this.dirs.includes(path) || this.files.has(path);
  }

  text(path: string): string | undefined {
    return this.files.get(path)?.text;
  }

  private mkdirSync(path: string): void {
    if (!path || this.dirs.includes(path)) return;
    this.mkdirSync(parentPath(path));
    this.dirs.push(path);
  }

  async mkdir(path: string): Promise<void> {
    this.mkdirSync(path);
  }

  async list(path: string): Promise<EntryInfo[]> {
    if (!this.dirs.includes(path)) throw new Error(`ENOENT ${path}`);
    const dirs = this.dirs
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
    if (this.failWrites.has(path)) throw new Error(`EACCES ${path}`);
    this.mkdirSync(parentPath(path));
    const existing = this.files.get(path);
    this.files.set(path, { path: existing?.path ?? path, text, mtimeMs: ++this.clock });
  }

  async writeBytes(path: string, bytes: Uint8Array | Blob): Promise<void> {
    const data = bytes instanceof Blob ? new Uint8Array(await bytes.arrayBuffer()) : bytes;
    await this.writeText(path, new TextDecoder().decode(data));
  }

  /** Desktop semantics: renaming onto an existing entry is refused, never silently replaced. */
  async move(from: string, to: string): Promise<void> {
    if (from === to) return;
    const entry = this.files.get(from);
    if (entry) {
      if (this.has(to)) {
        this.rejectedMoves.push(`${from} -> ${to}`);
        throw new Error(`目标路径已存在：${to}`);
      }
      this.files.delete(from);
      this.mkdirSync(parentPath(to));
      this.files.set(to, { ...entry, path: to, mtimeMs: ++this.clock });
      return;
    }
    if (!this.dirs.includes(from)) throw new Error(`ENOENT ${from}`);
    if (this.has(to)) {
      this.rejectedMoves.push(`${from} -> ${to}`);
      throw new Error(`目标路径已存在：${to}`);
    }
    this.mkdirSync(parentPath(to));
    this.dirs = this.dirs.map((candidate) => (candidate === from || candidate.startsWith(`${from}/`) ? `${to}${candidate.slice(from.length)}` : candidate));
    for (const item of [...this.files.values()]) {
      if (!item.path.startsWith(`${from}/`)) continue;
      this.files.delete(item.path);
      const next = `${to}${item.path.slice(from.length)}`;
      this.files.set(next, { ...item, path: next });
    }
  }

  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    if (this.files.delete(path)) return;
    if (!this.dirs.includes(path)) throw new Error(`ENOENT ${path}`);
    const canDelete = options?.recursive === true || !this.dirs.some((d) => d !== path && d.startsWith(`${path}/`));
    if (!canDelete) throw new Error(`ERR_FS_EISDIR: Path is a directory: rm returned EISDIR ${path}`);
    this.dirs = this.dirs.filter((candidate) => candidate !== path && !candidate.startsWith(`${path}/`));
    for (const item of [...this.files.values()]) if (item.path.startsWith(`${path}/`)) this.files.delete(item.path);
  }

  async exists(path: string): Promise<boolean> {
    return this.has(path);
  }

  async stat(path: string): Promise<{ size: number; mtimeMs: number } | null> {
    const entry = this.files.get(path);
    return entry ? { size: entry.text.length, mtimeMs: entry.mtimeMs } : null;
  }
}

const backends = new Map<string, MockBackend>();
const records = new Map<string, WorkspaceRecord>();

vi.mock("./workspaces", () => ({
  activeWorkspaceRecord: () => null,
  resolveBackend: async (record: WorkspaceRecord) => {
    const backend = backends.get(record.id);
    if (!backend) throw new Error(`ENOENT ${record.location}`);
    return backend;
  },
  setActiveWorkspace: () => undefined,
}));

import { closeWorkspace, flushMeta, openWorkspace, setStarred } from "./library";

const STATE_FILE = ".opennote/state.json";

async function openSingle(seed: (backend: MockBackend) => void): Promise<MockBackend> {
  const backend = new MockBackend();
  seed(backend);
  backends.set("test", backend);
  records.set("test", { id: "test", name: "笔记本 test", kind: "node", location: "unused", addedAt: 1, lastOpenedAt: 1 });
  await openWorkspace(records.get("test")!, { silent: true });
  return backend;
}

beforeEach(async () => {
  backends.clear();
  records.clear();
  await closeWorkspace().catch(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  await closeWorkspace().catch(() => undefined);
  vi.restoreAllMocks();
});

describe("state.json 落盘不再用「注定失败的 move」当探测", () => {
  it("连续三次写元数据都不会产生被拒绝的 move（控制台不再刷 handler 错误）", async () => {
    const backend = await openSingle((b) => b.seed("a.md", "# 笔记"));
    backend.rejectedMoves.length = 0;

    await flushMeta();
    await flushMeta();
    await flushMeta();

    expect(backend.rejectedMoves).toEqual([]);
    // 正面证据：元数据确实写进去了，而且没有留下临时文件。
    expect(JSON.parse(backend.text(STATE_FILE)!)).toMatchObject({ version: 1 });
    expect(backend.has(`${STATE_FILE}.tmp`)).toBe(false);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("元数据内容每次都会更新，且最后一次写入生效", async () => {
    const backend = await openSingle((b) => b.seed("a.md", "# 笔记"));
    setStarred("a.md", true);
    await flushMeta();
    expect(backend.text(STATE_FILE)).toContain("a.md");

    setStarred("a.md", false);
    await flushMeta();
    expect(backend.rejectedMoves).toEqual([]);
    expect(JSON.parse(backend.text(STATE_FILE)!).starred).toEqual([]);
  });

  it("旧方案遗留的 state.json.tmp 会被清理，不残留也不被当成状态读回", async () => {
    const backend = await openSingle((b) => {
      b.seed("a.md", "# 笔记");
      b.seed(`${STATE_FILE}.tmp`, "旧方案遗留的半截内容");
    });
    await flushMeta();
    expect(backend.has(`${STATE_FILE}.tmp`)).toBe(false);
    expect(backend.text(STATE_FILE)).not.toContain("半截内容");
  });

  it("state.json 写不进去时 flushMeta 不抛出（不产生未处理的拒绝）", async () => {
    const backend = await openSingle((b) => b.seed("a.md", "# 笔记"));
    backend.failWrites.add(STATE_FILE);
    await expect(flushMeta()).resolves.toBeUndefined();
  });
});
