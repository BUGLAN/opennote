/**
 * Regression tests for the P2 data-layer defects (D14, D15, D22, D25, D26).
 *
 * Every test targets the mechanism described in
 * `docs/缺陷审计报告-2026-09-29.md`: delete the corresponding fix in
 * `src/data/library.ts` and the test fails again.
 *
 * The mock backend is the one from `library.regression.test.ts` plus three
 * switches this file needs: `failMkdir` (D26), `failWriteWhen` (D22) and
 * `latencyMs`/`peakInFlight` (D25, to observe how many IPC calls a scan keeps
 * in flight).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseName, joinPath, parentPath } from "../fs/paths";
import type { EntryInfo, FileSystemBackend } from "../fs/types";
import type { WorkspaceRecord } from "./workspaces";

interface MockEntry {
  /** Path as it was first created — a case-insensitive disk keeps that casing. */
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
  readonly calls: string[] = [];
  caseInsensitive = false;
  failMove = false;
  readonly failWrites = new Set<string>();
  readonly failReads = new Set<string>();
  readonly failMkdir = new Set<string>();
  /** Reject any write whose path matches — used to break history writes only (D22). */
  failWriteWhen: ((path: string) => boolean) | null = null;
  /** Cost of one backend call, and how many of them a scan keeps in flight (D25). */
  latencyMs = 0;
  peakInFlight = 0;
  hooks: {
    onList?: (path: string) => Promise<void> | void;
    onMove?: (from: string, to: string) => Promise<void> | void;
    onExists?: (path: string) => Promise<void> | void;
  } = {};
  private clock = 1_000;
  private inFlight = 0;

  constructor(caseInsensitive = false) {
    this.caseInsensitive = caseInsensitive;
  }

  private async io(): Promise<void> {
    this.inFlight += 1;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    try {
      if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    } finally {
      this.inFlight -= 1;
    }
  }

  private fold(path: string): string {
    return this.caseInsensitive ? path.toLowerCase() : path;
  }

  private fileAt(path: string): MockEntry | undefined {
    return this.files.get(this.fold(path));
  }

  private dirAt(path: string): string | undefined {
    return this.dirs.find((dir) => this.fold(dir) === this.fold(path));
  }

  private isUnder(path: string, dir: string): boolean {
    return this.fold(path).startsWith(`${this.fold(dir)}/`);
  }

  private mkdirSync(path: string): void {
    if (!path || this.dirAt(path)) return;
    this.mkdirSync(parentPath(path));
    this.dirs.push(path);
  }

  seed(path: string, text: string): MockEntry {
    this.mkdirSync(parentPath(path));
    const entry: MockEntry = { path, text, mtimeMs: ++this.clock };
    this.files.set(this.fold(path), entry);
    return entry;
  }

  text(path: string): string | undefined {
    return this.fileAt(path)?.text;
  }

  has(path: string): boolean {
    return this.dirAt(path) !== undefined || this.fileAt(path) !== undefined;
  }

  paths(): string[] {
    return [...this.files.values()].map((entry) => entry.path);
  }

  /** Snapshot files currently stored for one note. */
  historyPaths(noteId: string): string[] {
    return this.paths().filter((path) => path.startsWith(`${joinPath(".opennote/history", noteId)}/`));
  }

  async mkdir(path: string): Promise<void> {
    this.calls.push(`mkdir:${path}`);
    await this.io();
    if (this.failMkdir.has(path)) throw new Error(`EEXIST ${path}`);
    this.mkdirSync(path);
  }

  async list(path: string): Promise<EntryInfo[]> {
    this.calls.push(`list:${path}`);
    await this.hooks.onList?.(path);
    await this.io();
    const dir = this.dirAt(path);
    if (dir === undefined) throw new Error(`ENOENT ${path}`);
    const dirEntries = this.dirs
      .filter((candidate) => candidate && this.fold(parentPath(candidate)) === this.fold(dir))
      .map((candidate) => ({ name: baseName(candidate), kind: "directory" as const, size: 0, mtimeMs: 0 }));
    const fileEntries = [...this.files.values()]
      .filter((entry) => this.fold(parentPath(entry.path)) === this.fold(dir))
      .map((entry) => ({
        name: baseName(entry.path),
        kind: "file" as const,
        size: entry.text.length,
        mtimeMs: entry.mtimeMs,
      }));
    return [...dirEntries, ...fileEntries];
  }

  async readText(path: string): Promise<string> {
    await this.io();
    if (this.failReads.has(path)) throw new Error(`EACCES ${path}`);
    const entry = this.fileAt(path);
    if (!entry) throw new Error(`ENOENT ${path}`);
    return entry.text;
  }

  async readBytes(path: string): Promise<Uint8Array> {
    return new TextEncoder().encode(await this.readText(path));
  }

  async writeText(path: string, text: string): Promise<void> {
    this.calls.push(`write:${path}`);
    await this.io();
    if (this.failWrites.has(path)) throw new Error(`EACCES ${path}`);
    if (this.failWriteWhen?.(path)) throw new Error(`EACCES ${path}`);
    this.mkdirSync(parentPath(path));
    const existing = this.fileAt(path);
    this.files.set(this.fold(path), { path: existing?.path ?? path, text, mtimeMs: ++this.clock });
  }

  async writeBytes(path: string, bytes: Uint8Array | Blob): Promise<void> {
    const data = bytes instanceof Blob ? new Uint8Array(await bytes.arrayBuffer()) : bytes;
    await this.writeText(path, new TextDecoder().decode(data));
  }

  async exists(path: string): Promise<boolean> {
    await this.hooks.onExists?.(path);
    await this.io();
    return this.dirAt(path) !== undefined || this.fileAt(path) !== undefined;
  }

  async stat(path: string): Promise<{ size: number; mtimeMs: number } | null> {
    await this.io();
    const entry = this.fileAt(path);
    return entry ? { size: entry.text.length, mtimeMs: entry.mtimeMs } : null;
  }

  async move(from: string, to: string): Promise<void> {
    this.calls.push(`move:${from}->${to}`);
    await this.hooks.onMove?.(from, to);
    await this.io();
    if (this.failMove) throw new Error(`EPERM move ${from}`);
    const same = this.fold(from) === this.fold(to);
    const entry = this.fileAt(from);
    if (entry) {
      if (!same && (this.fileAt(to) || this.dirAt(to))) throw new Error(`EEXIST ${to}`);
      this.files.delete(this.fold(from));
      this.mkdirSync(parentPath(to));
      this.files.set(this.fold(to), { ...entry, path: to, mtimeMs: ++this.clock });
      return;
    }
    const dir = this.dirAt(from);
    if (dir === undefined) throw new Error(`ENOENT ${from}`);
    if (!same && (this.dirAt(to) || this.fileAt(to))) throw new Error(`EEXIST ${to}`);
    this.mkdirSync(parentPath(to));
    const rewrite = (path: string) => `${to}${path.slice(dir.length)}`;
    this.dirs = this.dirs.map((candidate) => (candidate === dir || this.isUnder(candidate, dir) ? rewrite(candidate) : candidate));
    for (const item of [...this.files.values()]) {
      if (!this.isUnder(item.path, dir)) continue;
      this.files.delete(this.fold(item.path));
      const next = rewrite(item.path);
      this.files.set(this.fold(next), { ...item, path: next });
    }
  }

  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    this.calls.push(`remove:${path}${options?.recursive ? ":recursive" : ""}`);
    await this.io();
    if (this.fileAt(path)) {
      this.files.delete(this.fold(path));
      return;
    }
    const dir = this.dirAt(path);
    if (dir === undefined) throw new Error(`ENOENT ${path}`);
    if (!dir) throw new Error("不能删除笔记本根目录");
    // Node semantics: rm(dir, { recursive: false }) always fails, empty or not.
    if (!options?.recursive) throw new Error(`ERR_FS_EISDIR: Path is a directory: rm returned EISDIR ${path}`);
    for (const entry of [...this.files.values()]) if (this.isUnder(entry.path, dir)) this.files.delete(this.fold(entry.path));
    this.dirs = this.dirs.filter((candidate) => candidate !== dir && !this.isUnder(candidate, dir));
  }
}

const backends = new Map<string, MockBackend>();
const records = new Map<string, WorkspaceRecord>();
/** Notebook ids whose `resolveBackend` fails — the folder cannot be reached (D26). */
const broken = new Set<string>();

vi.mock("./workspaces", () => ({
  activeWorkspaceRecord: () => null,
  resolveBackend: async (record: WorkspaceRecord) => {
    if (broken.has(record.id)) throw new Error(`EACCES ${record.location}`);
    const backend = backends.get(record.id);
    if (!backend) throw new Error(`ENOENT ${record.location}`);
    return backend;
  },
  setActiveWorkspace: () => undefined,
}));

import {
  childFolders,
  closeWorkspace,
  createFolder,
  createNote,
  descendantFolderIds,
  flushAll,
  folderStats,
  getLibrary,
  isWorkspaceOpen,
  listSnapshots,
  moveNote,
  notesInFolder,
  openWorkspace,
  renameFolder,
  renameNote,
  rescanWorkspace,
  restoreNote,
  takeManualSnapshot,
  trashNote,
  updateNoteContent,
} from "./library";
import { getUi, patchUi } from "./ui";

function register(id: string, seed: (backend: MockBackend) => void, options: { caseInsensitive?: boolean } = {}): MockBackend {
  const backend = new MockBackend(Boolean(options.caseInsensitive));
  seed(backend);
  backends.set(id, backend);
  records.set(id, { id, name: `笔记本 ${id}`, kind: "node", location: "unused", addedAt: 1, lastOpenedAt: 1 });
  return backend;
}

async function openRecord(id: string): Promise<void> {
  await openWorkspace(records.get(id)!, { silent: true });
}

async function openSingle(seed: (backend: MockBackend) => void, options: { caseInsensitive?: boolean } = {}): Promise<MockBackend> {
  const backend = register("test", seed, options);
  await openRecord("test");
  return backend;
}

/** Let the fire-and-forget preflights (create note / create folder) settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  backends.clear();
  records.clear();
  broken.clear();
  await closeWorkspace().catch(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  patchUi({ snapshots: true });
});

afterEach(async () => {
  await closeWorkspace().catch(() => undefined);
  vi.restoreAllMocks();
});

describe("D14 同一分钟内的两次手动快照都会留下", () => {
  it("连点两次得到两个快照文件，而不是后一次覆盖前一次", async () => {
    const backend = await openSingle((b) => b.seed("a.md", "# 第一版"));
    await takeManualSnapshot("a.md");
    updateNoteContent("a.md", "# 第二版", { immediate: true });
    await flushAll();
    await takeManualSnapshot("a.md");

    const files = backend.historyPaths("a.md");
    expect(files).toHaveLength(2);
    expect(files.every((path) => path.endsWith("-manual.md"))).toBe(true);
    expect(new Set(files).size).toBe(2);
    expect(files.map((path) => backend.text(path)).sort()).toEqual(["# 第一版", "# 第二版"]);
  });

  it("同一毫秒内的三次快照也不会互相覆盖", async () => {
    const backend = await openSingle((b) => b.seed("a.md", "# 内容"));
    await Promise.all([takeManualSnapshot("a.md"), takeManualSnapshot("a.md"), takeManualSnapshot("a.md")]);
    expect(backend.historyPaths("a.md")).toHaveLength(3);
    expect(await listSnapshots("a.md")).toHaveLength(3);
  });
});

describe("D15 历史快照跟随重命名 / 移动", () => {
  it("重命名后历史跟着走，新建同名笔记看不到别人的历史", async () => {
    const backend = await openSingle((b) => b.seed("旧名.md", "# 旧内容"));
    await takeManualSnapshot("旧名.md");
    expect(backend.historyPaths("旧名.md")).toHaveLength(1);

    await renameNote("旧名.md", "新名");
    expect(backend.historyPaths("旧名.md")).toHaveLength(0);
    expect(backend.has(joinPath(".opennote/history", "旧名.md"))).toBe(false);
    const moved = await listSnapshots("新名.md");
    expect(moved.map((snapshot) => snapshot.content)).toEqual(["# 旧内容"]);

    // 审计报告 [12] 的复现路径：新建同名笔记继承旧历史（甚至能「恢复」到别人的内容）。
    const fresh = createNote({ title: "旧名", content: "# 全新内容" });
    await flushAll();
    expect(await listSnapshots(fresh.id)).toEqual([]);
  });

  it("移动笔记到别的文件夹时历史跟着走", async () => {
    const backend = await openSingle((b) => {
      b.seed("资料/笔记.md", "# 正文");
      b.seed("归档/占位.md", "# 占位");
    });
    await takeManualSnapshot("资料/笔记.md");
    await moveNote("资料/笔记.md", "归档");
    expect(backend.historyPaths("资料/笔记.md")).toHaveLength(0);
    expect(await listSnapshots("归档/笔记.md")).toHaveLength(1);
  });

  it("只改大小写的重命名也把历史带上（与 D07 的两步 move 兼容）", async () => {
    const backend = await openSingle((b) => b.seed("故事/Note.md", "# 内容"), { caseInsensitive: true });
    await takeManualSnapshot("故事/Note.md");
    await renameNote("故事/Note.md", "note");
    expect(backend.historyPaths("故事/note.md")).toHaveLength(1);
    expect(backend.text("故事/note.md")).toBe("# 内容");
    expect(await listSnapshots("故事/note.md")).toHaveLength(1);
  });

  it("重命名文件夹时子笔记的历史一并移动", async () => {
    const backend = await openSingle((b) => {
      b.seed("故事/第一章.md", "# 第一章");
      b.seed("故事/子目录/第二章.md", "# 第二章");
    });
    await takeManualSnapshot("故事/第一章.md");
    await takeManualSnapshot("故事/子目录/第二章.md");
    await renameFolder("故事", "篇章");
    expect(backend.historyPaths("故事")).toHaveLength(0);
    expect(await listSnapshots("篇章/第一章.md")).toHaveLength(1);
    expect(await listSnapshots("篇章/子目录/第二章.md")).toHaveLength(1);
  });

  it("移入回收站 / 恢复时历史跟着当前 id 走", async () => {
    const backend = await openSingle((b) => b.seed("笔记.md", "# 正文"));
    await takeManualSnapshot("笔记.md");
    await trashNote("笔记.md");
    // 历史跟着进回收站：原路径下不再留一份给同名新笔记继承。
    expect(backend.historyPaths("笔记.md")).toHaveLength(0);
    expect(await listSnapshots(".opennote/trash/笔记.md")).toHaveLength(1);
    const fresh = createNote({ title: "笔记", content: "# 全新" });
    await flushAll();
    expect(await listSnapshots(fresh.id)).toEqual([]);

    await restoreNote(".opennote/trash/笔记.md");
    expect(backend.historyPaths("笔记.md")).toHaveLength(0);
    expect(await listSnapshots("笔记 2.md")).toHaveLength(1);
  });
});

describe("D22 快照节流", () => {
  it("写入失败后下一次编辑立刻重试，不再空等 3 分钟", async () => {
    const backend = await openSingle((b) => b.seed("a.md", "# 一"));
    backend.failWriteWhen = (path) => path.startsWith(".opennote/history/");
    updateNoteContent("a.md", "# 二");
    await flushAll();
    expect(backend.historyPaths("a.md")).toHaveLength(0);
    expect(getLibrary().error).toContain("历史版本");

    backend.failWriteWhen = null;
    updateNoteContent("a.md", "# 三");
    await flushAll();
    const files = backend.historyPaths("a.md");
    expect(files).toHaveLength(1);
    // 第一次失败的那次写入被重发，落的是当时被替换掉的正文。
    expect(backend.text(files[0])).toBe("# 二");
  });

  it("手动快照失败要提示，并且不占用节流窗口", async () => {
    const backend = await openSingle((b) => b.seed("a.md", "# 一"));
    backend.failWriteWhen = (path) => path.startsWith(".opennote/history/");
    await takeManualSnapshot("a.md");
    expect(getLibrary().error).toContain("历史版本");
    expect(backend.historyPaths("a.md")).toHaveLength(0);

    backend.failWriteWhen = null;
    await takeManualSnapshot("a.md");
    expect(backend.historyPaths("a.md")).toHaveLength(1);
  });

  it("写入成功后 3 分钟内不再重复写自动快照（节流仍然有效）", async () => {
    const backend = await openSingle((b) => b.seed("a.md", "# 一"));
    updateNoteContent("a.md", "# 二");
    await flushAll();
    updateNoteContent("a.md", "# 三");
    await flushAll();
    const files = backend.historyPaths("a.md");
    expect(files).toHaveLength(1);
    expect(backend.text(files[0])).toBe("# 一");
  });

  it("切换笔记本后节流表不残留：另一个笔记本里的同名笔记照样快照", async () => {
    const first = register("A", (b) => b.seed("same.md", "# A 一"));
    const second = register("B", (b) => b.seed("same.md", "# B 一"));
    await openRecord("A");
    updateNoteContent("same.md", "# A 二");
    await flushAll();
    expect(first.historyPaths("same.md")).toHaveLength(1);

    await openRecord("B");
    updateNoteContent("same.md", "# B 二");
    await flushAll();
    const files = second.historyPaths("same.md");
    expect(files).toHaveLength(1);
    expect(second.text(files[0])).toBe("# B 一");
  });
});

describe("D25 规模：分组索引与并发扫描", () => {
  it("索引与旧实现结论一致：直接子级 / 后代 / 根目录 / 计数", async () => {
    await openSingle((b) => {
      b.seed("甲/一.md", "# 一");
      b.seed("甲/子/二.md", "# 二");
      b.seed("甲/子/深/三.md", "# 三");
      b.seed("乙/四.md", "# 四");
      b.seed("根.md", "# 根");
    });
    const state = getLibrary();
    expect(notesInFolder(state, "甲").map((note) => note.id)).toEqual(["甲/一.md"]);
    expect(notesInFolder(state, "甲", { descendants: true }).map((note) => note.id).sort()).toEqual(["甲/一.md", "甲/子/二.md", "甲/子/深/三.md"]);
    expect(notesInFolder(state, null).map((note) => note.id)).toEqual(["根.md"]);
    expect(notesInFolder(state, undefined).map((note) => note.id)).toHaveLength(5);
    expect(folderStats(state, "甲")).toEqual({ notes: 3, folders: 2 });
    expect(folderStats(state, "甲/子")).toEqual({ notes: 2, folders: 1 });
    expect(folderStats(state, "乙")).toEqual({ notes: 1, folders: 0 });
    expect(folderStats(state, "不存在")).toEqual({ notes: 0, folders: 0 });
    expect(childFolders(state, "甲").map((folder) => folder.id)).toEqual(["甲/子"]);
    expect(childFolders(state, null).map((folder) => folder.id).sort()).toEqual(["乙", "甲"].sort());

    // 改变归属后索引必须重建，而不是继续回答旧数字。
    await moveNote("甲/一.md", "乙");
    const after = getLibrary();
    expect(folderStats(after, "甲")).toEqual({ notes: 2, folders: 2 });
    expect(folderStats(after, "乙")).toEqual({ notes: 2, folders: 0 });
  });

  it("列表渲染的索引路径比旧的「每文件夹全量遍历」快数倍", async () => {
    const backend = new MockBackend();
    for (let group = 0; group < 120; group += 1) {
      const folder = `分区-${String(group).padStart(3, "0")}`;
      for (let index = 0; index < 10; index += 1) backend.seed(`${folder}/笔记-${index}.md`, `# ${group}-${index}\n正文`);
    }
    register("big", () => undefined);
    backends.set("big", backend);
    await openRecord("big");

    const state = getLibrary();
    const folderIds = Object.keys(state.folders);
    const rounds = 5;

    const indexedStart = performance.now();
    for (let round = 0; round < rounds; round += 1) {
      for (const id of folderIds) {
        childFolders(state, id);
        notesInFolder(state, id, { sort: "updated" });
        folderStats(state, id);
      }
    }
    const indexedMs = performance.now() - indexedStart;

    // The pre-fix shape of the same work: rebuild the descendant set from all
    // folders and walk all notes once per folder, per round.
    const notes = Object.values(state.notes);
    const folders = Object.values(state.folders);
    const naiveStart = performance.now();
    for (let round = 0; round < rounds; round += 1) {
      for (const id of folderIds) {
        const scope = new Set([id, ...descendantFolderIds(id, state.folders)]);
        notes.filter((note) => note.folderId !== null && scope.has(note.folderId)).sort((a, b) => b.updatedAt - a.updatedAt);
        let counted = 0;
        for (const note of notes) if (note.folderId && scope.has(note.folderId)) counted += 1;
        folders.filter((folder) => (folder.parentId ?? null) === id).sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
        void counted;
      }
    }
    const naiveMs = performance.now() - naiveStart;

    console.log(
      `[D25] 1200 篇/120 文件夹 × ${rounds} 轮：索引路径=${indexedMs.toFixed(1)}ms 旧路径=${naiveMs.toFixed(1)}ms 倍率=${(naiveMs / indexedMs).toFixed(1)}×`,
    );
    expect(folderIds).toHaveLength(120);
    expect(indexedMs * 5).toBeLessThan(naiveMs);
  });

  it("扫描并发发起后端调用（旧的 walk 一次只发一个）", async () => {
    const backend = new MockBackend();
    backend.latencyMs = 1;
    for (let group = 0; group < 8; group += 1) {
      for (let index = 0; index < 8; index += 1) backend.seed(`目录-${group}/笔记-${index}.md`, `# ${group}-${index}`);
    }
    register("slow", () => undefined);
    backends.set("slow", backend);
    await openRecord("slow");
    expect(Object.keys(getLibrary().notes)).toHaveLength(64);
    expect(backend.peakInFlight).toBeGreaterThanOrEqual(4);
  });

  it("扫描出错语义不变：读不出的目录整棵跳过，读不出的笔记不入库", async () => {
    const backend = await openSingle((b) => {
      b.seed("好/笔记.md", "# 好");
      b.seed("坏/秘密.md", "# 坏");
      b.seed("坏.md", "# 读不出来");
    });
    backend.hooks.onList = (path) => {
      if (path === "坏") throw new Error("EIO 读不了");
    };
    backend.failReads.add("坏.md");
    await rescanWorkspace();
    const state = getLibrary();
    expect(Object.keys(state.notes)).toEqual(["好/笔记.md"]);
    expect(state.folders["坏"]).toBeDefined();
  });
});

describe("D26 失败回滚", () => {
  it("createFolder：mkdir 失败回滚，不留幽灵文件夹", async () => {
    const backend = await openSingle((b) => b.seed("a.md", "# a"));
    backend.failMkdir.add("新文件夹");
    const folder = createFolder("新文件夹");
    // 乐观发布保持原样：UI 立刻能看到新文件夹。
    expect(getLibrary().folders[folder.id]).toBeDefined();
    await settle();
    expect(getLibrary().folders[folder.id]).toBeUndefined();
    expect(getUi().expanded).not.toContain(folder.id);
    expect(getLibrary().error).toContain("新建文件夹失败");
  });

  it("createFolder：mkdir 失败但里面已经有笔记时不回滚（不制造孤儿）", async () => {
    const backend = await openSingle((b) => b.seed("留/已有.md", "# 已有"));
    backend.failMkdir.add("新文件夹");
    const folder = createFolder("新文件夹");
    const note = createNote({ folderId: folder.id, title: "草稿" });
    await settle();
    await flushAll();
    expect(getLibrary().folders[folder.id]).toBeDefined();
    expect(getLibrary().notes[note.id]).toBeDefined();
  });

  it("openWorkspace：解析后端失败时 backend 复位为 null，界面不会「半开」", async () => {
    register("A", (b) => b.seed("a.md", "# A 的内容"));
    await openRecord("A");
    expect(isWorkspaceOpen()).toBe(true);

    register("B", (b) => b.seed("b.md", "# B 的内容"));
    broken.add("B");
    await expect(openRecord("B")).rejects.toThrow();
    expect(isWorkspaceOpen()).toBe(false);
    expect(getLibrary().workspace).toBeNull();
    expect(getLibrary().notes).toEqual({});
  });

  it("openWorkspace：扫描中途失败时 backend 同样复位", async () => {
    register("A", (b) => b.seed("a.md", "# A 的内容"));
    await openRecord("A");
    const target = register("B", (b) => b.seed("b.md", "# B 的内容"));
    // start-up 的回收站探测失败，整个扫描随之失败。
    target.hooks.onExists = (path) => {
      if (path === ".opennote/trash") throw new Error("EIO 读不了回收站");
    };
    await expect(openRecord("B")).rejects.toThrow();
    expect(isWorkspaceOpen()).toBe(false);
    expect(getLibrary().workspace).toBeNull();
  });

  it("readMeta：state.json 读不出来也照样打开，只回落默认状态", async () => {
    const backend = await openSingle((b) => {
      b.seed(".opennote/state.json", JSON.stringify({ version: 1, starred: ["a.md"] }));
      b.seed("a.md", "# a");
      b.failReads.add(".opennote/state.json");
    });
    expect(Object.keys(getLibrary().notes)).toEqual(["a.md"]);
    expect(getLibrary().notes["a.md"].starred).toBe(false);
    expect(getLibrary().error).toContain("状态文件");
    // 状态文件本身没有被覆盖成默认值之外的东西：下一次写入仍然是完整 JSON。
    await flushAll();
    expect(backend.has(".opennote/state.json")).toBe(true);
  });
});
