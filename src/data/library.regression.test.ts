/**
 * Regression tests for the P0/P1 data-layer defects (D01–D11, D27, D30).
 *
 * Every test targets the mechanism described in
 * `docs/缺陷审计报告-2026-09-29.md`: delete the corresponding fix in
 * `src/data/library.ts` and the test fails again. `MockBackend` can emulate a
 * case-insensitive disk (Windows/macOS), throws `ERR_FS_EISDIR` when a
 * directory is removed without `recursive`, and refuses to overwrite on move —
 * exactly like the real node/handle backends.
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
  hooks: {
    onList?: (path: string) => Promise<void> | void;
    onMove?: (from: string, to: string) => Promise<void> | void;
  } = {};
  private clock = 1_000;

  constructor(caseInsensitive = false) {
    this.caseInsensitive = caseInsensitive;
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

  /** Another program (editor, sync client, git) writes behind the app's back. */
  externalWrite(path: string, text: string): void {
    this.seed(path, text);
  }

  text(path: string): string | undefined {
    return this.fileAt(path)?.text;
  }

  has(path: string): boolean {
    return this.dirAt(path) !== undefined || this.fileAt(path) !== undefined;
  }

  /** Every stored path, for assertions like "no .conflict copy was written". */
  paths(): string[] {
    return [...this.files.values()].map((entry) => entry.path);
  }

  async mkdir(path: string): Promise<void> {
    this.calls.push(`mkdir:${path}`);
    this.mkdirSync(path);
  }

  async list(path: string): Promise<EntryInfo[]> {
    this.calls.push(`list:${path}`);
    await this.hooks.onList?.(path);
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
    const entry = this.fileAt(path);
    if (!entry) throw new Error(`ENOENT ${path}`);
    return entry.text;
  }

  async readBytes(path: string): Promise<Uint8Array> {
    return new TextEncoder().encode(await this.readText(path));
  }

  async writeText(path: string, text: string): Promise<void> {
    this.calls.push(`write:${path}`);
    if (this.failWrites.has(path)) throw new Error(`EACCES ${path}`);
    this.mkdirSync(parentPath(path));
    const existing = this.fileAt(path);
    this.files.set(this.fold(path), { path: existing?.path ?? path, text, mtimeMs: ++this.clock });
  }

  async writeBytes(path: string, bytes: Uint8Array | Blob): Promise<void> {
    const data = bytes instanceof Blob ? new Uint8Array(await bytes.arrayBuffer()) : bytes;
    await this.writeText(path, new TextDecoder().decode(data));
  }

  async exists(path: string): Promise<boolean> {
    return this.dirAt(path) !== undefined || this.fileAt(path) !== undefined;
  }

  async stat(path: string): Promise<{ size: number; mtimeMs: number } | null> {
    const entry = this.fileAt(path);
    return entry ? { size: entry.text.length, mtimeMs: entry.mtimeMs } : null;
  }

  async move(from: string, to: string): Promise<void> {
    this.calls.push(`move:${from}->${to}`);
    await this.hooks.onMove?.(from, to);
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

vi.mock("./workspaces", () => ({
  activeWorkspaceRecord: () => null,
  resolveBackend: async (record: WorkspaceRecord) => backends.get(record.id),
  setActiveWorkspace: () => undefined,
}));

import { imageUrlStore, releaseImageUrls, releaseUnusedImageUrls } from "./assets";
import { importIntoWorkspace } from "../lib/import";
import {
  closeTab,
  closeWorkspace,
  createFolder,
  createNote,
  deleteFolder,
  emptyTrash,
  flushAll,
  flushForClose,
  flushMeta,
  getLibrary,
  notesInFolder,
  openNote,
  openWorkspace,
  purgeNote,
  renameFolder,
  renameNote,
  rescanWorkspace,
  restoreNote,
  searchFolders,
  searchNotes,
  setSidebarTab,
  trashNote,
  updateNoteContent,
} from "./library";
import { getUi } from "./ui";

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

/** Resolve on the next macrotask; used to let the debounced image release run. */
function sleep(ms = 400): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const firstChapter = (backend: MockBackend): void => {
  backend.seed("故事/第一章.md", "# 第一章\n初稿");
  backend.seed("故事/子目录/第二章.md", "# 第二章\n草稿");
  backend.seed("故事/assets/封面.png", "pixels");
};

beforeEach(async () => {
  backends.clear();
  records.clear();
  await closeWorkspace().catch(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const backend of backends.values()) backend.failWrites.clear();
  await closeWorkspace().catch(() => undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("D01 操作进行中的输入不再静默丢失", () => {
  it("删除文件夹（笔记上移）期间敲入的正文会落到新路径", async () => {
    const backend = await openSingle(firstChapter);
    // Type while the operation is mid-flight: the folder listing is the first
    // await of the promote branch, exactly like a slow multi-step move.
    backend.hooks.onList = (path) => {
      if (path === "故事") updateNoteContent("故事/第一章.md", "# 移动过程中敲的正文");
    };
    await deleteFolder("故事", "promote");
    backend.hooks.onList = undefined;
    expect(backend.text("第一章.md")).toBe("# 移动过程中敲的正文");
    expect(getLibrary().notes["第一章.md"]).toBeDefined();
    expect(Object.keys(getLibrary().dirty)).toEqual([]);
  });

  it("重命名笔记期间敲入的正文会跟着新文件名落盘", async () => {
    const backend = await openSingle((b) => b.seed("旧名.md", "# 旧内容"));
    const flush = deferred();
    const write = backend.writeText.bind(backend);
    const flushGate = vi.spyOn(backend, "writeText").mockImplementation(async (path, text) => {
      await flush.promise;
      await write(path, text);
    });
    const rename = renameNote("旧名.md", "新名");
    // The rename flushes the note first; type while that write is slow.
    updateNoteContent("旧名.md", "# 重命名过程中敲的正文");
    flush.resolve();
    await rename;
    flushGate.mockRestore();
    await flushAll();
    expect(backend.text("新名.md")).toBe("# 重命名过程中敲的正文");
    expect(backend.has("旧名.md")).toBe(false);
    expect(Object.keys(getLibrary().dirty)).toEqual([]);
  });

  it("移入回收站期间敲入的正文会落到回收站副本，且不留 dirty 幽灵键", async () => {
    const backend = await openSingle((b) => b.seed("资料/笔记.md", "# 旧内容"));
    // Type while the directory is being moved to the trash.
    backend.hooks.onMove = (from) => {
      if (from === "资料") updateNoteContent("资料/笔记.md", "# 删除过程中敲的正文");
    };
    await deleteFolder("资料", "trash");
    backend.hooks.onMove = undefined;
    expect(backend.text(".opennote/trash/资料/笔记.md")).toBe("# 删除过程中敲的正文");
    expect(getLibrary().notes["资料/笔记.md"]).toBeUndefined();
    expect(Object.keys(getLibrary().dirty)).toEqual([]);
  });
});

describe("D02 过期扫描不覆盖新工作区", () => {
  it("切换笔记本期间结束的 rescan 不会发布旧树", async () => {
    const a = register("A", (b) => {
      b.seed("A-only.md", "# A 的内容");
      b.seed("共享.md", "# A 的共享");
    });
    const b = register("B", (x) => {
      x.seed("B-only.md", "# B 的内容");
      x.seed("共享.md", "# B 的共享");
    });
    await openRecord("A");

    const blocked = deferred();
    const entered = deferred();
    a.hooks.onList = async (path) => {
      if (path !== "") return;
      entered.resolve();
      await blocked.promise;
    };
    const stale = rescanWorkspace();
    await entered.promise;
    await openRecord("B");
    blocked.resolve();
    await stale;

    expect(Object.keys(getLibrary().notes).sort()).toEqual(["B-only.md", "共享.md"]);
    expect(getLibrary().notes["共享.md"].content).toBe("# B 的共享");
    updateNoteContent("共享.md", "# 只应写进 B", { immediate: true });
    await flushAll();
    expect(b.text("共享.md")).toBe("# 只应写进 B");
    expect(a.text("共享.md")).toBe("# A 的共享");
    expect(a.has("B-only.md")).toBe(false);
  });

  it("并发的两次 openWorkspace 只有最后一次生效", async () => {
    const a = register("A", (x) => x.seed("A-only.md", "# A"));
    register("B", (x) => x.seed("B-only.md", "# B"));
    const blocked = deferred();
    const entered = deferred();
    a.hooks.onList = async (path) => {
      if (path !== "") return;
      entered.resolve();
      await blocked.promise;
    };
    const slowOpen = openWorkspace(records.get("A")!, { silent: true });
    await entered.promise;
    await openRecord("B");
    blocked.resolve();
    await slowOpen;
    expect(getLibrary().workspace?.id).toBe("B");
    expect(Object.keys(getLibrary().notes)).toEqual(["B-only.md"]);
  });
});

describe("D03 / D30 新建与导入不覆盖磁盘上的同名文件", () => {
  it("D03：扫描之后出现的同名文件不会被新笔记清空", async () => {
    const backend = await openSingle((b) => b.seed("a.md", "# a"));
    backend.externalWrite("无标题.md", "# 外部程序写的重要文件");
    createNote();
    await flushAll();
    expect(backend.text("无标题.md")).toBe("# 外部程序写的重要文件");
    expect(backend.text("无标题 2.md")).toBe("");
    expect(getLibrary().notes["无标题 2.md"]).toBeDefined();
    expect(getLibrary().notes["无标题.md"]).toBeUndefined();
  });

  it("D30：大小写不敏感磁盘上新建 README 不会覆盖 readme.md", async () => {
    const backend = await openSingle((b) => b.seed("readme.md", "# 已有内容"), { caseInsensitive: true });
    createNote({ title: "README" });
    await flushAll();
    expect(backend.text("readme.md")).toBe("# 已有内容");
    expect(backend.text("README 2.md")).toBe("");
    expect(getLibrary().notes["README 2.md"]).toBeDefined();
  });

  it("D30：createFolder 不会造出两个指向同一目录的 id", async () => {
    const backend = await openSingle((b) => b.seed("Docs/说明.md", "# 说明"), { caseInsensitive: true });
    const folder = createFolder("docs");
    await flushAll();
    expect(folder.id).toBe("docs 2");
    expect(Object.keys(getLibrary().folders).sort()).toEqual(["Docs", "docs 2"]);
    expect(backend.has("docs 2")).toBe(true);
    expect(backend.text("Docs/说明.md")).toBe("# 说明");
  });
  it("D03：导入同名 markdown 不覆盖磁盘上已有内容", async () => {
    const backend = await openSingle((b) => b.seed("a.md", "# a"));
    backend.externalWrite("导入.md", "# 磁盘上的原文件");
    vi.stubGlobal("FileReader", NodeFileReader);
    const result = await importIntoWorkspace([new File(["# 导入内容"], "导入.md", { type: "text/markdown" })], null);
    expect(result.notes).toBe(1);
    expect(backend.text("导入.md")).toBe("# 磁盘上的原文件");
    expect(backend.text("导入 2.md")).toBe("# 导入内容");
    expect(getLibrary().notes["导入 2.md"]).toBeDefined();
  });
});

describe("D05 全文搜索缓存", () => {
  it("编辑后新词能搜到、删掉的旧词不再命中", async () => {
    await openSingle((b) => b.seed("a.md", "# 图片\n只有图片这个词"));
    expect(searchNotes("图片")).toHaveLength(1);
    updateNoteContent("a.md", "# 图片\nQAMARKER-END-9");
    await flushAll();
    expect(searchNotes("QAMARKER-END-9")).toHaveLength(1);
    updateNoteContent("a.md", "# 什么都没有了");
    await flushAll();
    expect(searchNotes("QAMARKER-END-9")).toHaveLength(0);
  });

  it("切换笔记本后旧工作区的内容不再命中", async () => {
    register("A", (b) => b.seed("note.md", "# tokA-唯一词"));
    register("B", (b) => b.seed("note.md", "# B 本 完全不同的内容"));
    await openRecord("A");
    expect(searchNotes("tokA-唯一词")).toHaveLength(1);
    await openRecord("B");
    expect(searchNotes("tokA-唯一词")).toHaveLength(0);
    expect(searchNotes("完全不同")).toHaveLength(1);
  });

  it("正文缓存有上限：超出后仍能搜到最早的笔记", async () => {
    const backend = new MockBackend();
    for (let index = 0; index < 420; index += 1) backend.seed(`批量/笔记-${index}.md`, `# 笔记 ${index}\n关键词-${index}`);
    register("big", () => undefined);
    backends.set("big", backend);
    await openRecord("big");
    expect(searchNotes("关键词-0")).toHaveLength(1);
    expect(searchNotes("关键词-419")).toHaveLength(1);
  });
});

describe("搜索文件夹（0.4.0 设置「搜索时显示文件夹」的数据层）", () => {
  it("文件夹名与路径段都能命中；名字命中排在路径命中前面", async () => {
    await openSingle((b) => {
      b.seed("递归/笔记.md", "# 递归");
      b.seed("算法/递归入门/笔记.md", "# 入门");
    });
    const hits = searchFolders("递归");
    expect(hits.length).toBe(2);
    // 名字就是「递归」的排在「路径里带递归」的前面
    expect(hits[0].folder.name).toBe("递归");
    expect(hits[0].notes).toBe(1);
    expect(hits[1].folder.name).toBe("递归入门");
  });

  it("多关键词是 AND；没有命中返回空数组（不抛错）", async () => {
    await openSingle((b) => b.seed("算法/动态规划/笔记.md", "# 规划"));
    expect(searchFolders("算法 规划")).toHaveLength(1);
    expect(searchFolders("算法 递归")).toHaveLength(0);
    expect(searchFolders("")).toEqual([]);
  });

  it("关闭开关是纯界面行为：数据层不读这个设置，开关不影响 searchNotes", async () => {
    await openSingle((b) => b.seed("递归/笔记.md", "# 递归"));
    // 数据层只提供 searchFolders()；「要不要显示」由 SearchBody 按 ui.searchFolders 决定
    expect(searchFolders("递归").length).toBe(1);
    expect(searchNotes("递归").length).toBe(1);
  });
});

describe("D06 桌面端「只删文件夹、笔记上移」", () => {
  it("目录内容上移后，空目录用递归删除而不是 ERR_FS_EISDIR", async () => {
    const backend = await openSingle(firstChapter);
    await deleteFolder("故事", "promote");
    expect(backend.text("第一章.md")).toBe("# 第一章\n初稿");
    expect(backend.text("子目录/第二章.md")).toBe("# 第二章\n草稿");
    expect(backend.text("assets/封面.png")).toBe("pixels");
    expect(backend.has("故事")).toBe(false);
    expect(backend.calls).toContain("remove:故事:recursive");
    expect(getLibrary().error).toBeNull();
  });
});

describe("D07 只改大小写的重命名", () => {
  it("笔记不会变成「note 2.md」", async () => {
    const backend = await openSingle((b) => b.seed("故事/Note.md", "# 内容"), { caseInsensitive: true });
    await renameNote("故事/Note.md", "note");
    expect(backend.text("故事/note.md")).toBe("# 内容");
    expect(backend.paths()).toContain("故事/note.md");
    expect(backend.paths()).not.toContain("故事/Note.md");
    expect(backend.paths().some((path) => path.includes(" 2.md"))).toBe(false);
    expect(getLibrary().notes["故事/note.md"]).toBeDefined();
  });

  it("文件夹同样只改大小写", async () => {
    const backend = await openSingle((b) => b.seed("Docs/说明.md", "# 说明"), { caseInsensitive: true });
    await renameFolder("Docs", "docs");
    expect(backend.text("docs/说明.md")).toBe("# 说明");
    expect(backend.paths()).toContain("docs/说明.md");
    expect(backend.paths()).not.toContain("Docs/说明.md");
    expect(getLibrary().folders["docs"]).toBeDefined();
    expect(getLibrary().folders["Docs"]).toBeUndefined();
  });
});

describe("D08 外部改动不被静默覆盖", () => {
  it("保存前发现磁盘被改过：保留冲突副本并提示", async () => {
    const backend = await openSingle((b) => b.seed("a.md", "# 原始内容"));
    backend.externalWrite("a.md", "# 外部编辑器 / 同步盘改过的内容");
    updateNoteContent("a.md", "# 应用里又敲了一行", { immediate: true });
    await flushAll();
    expect(backend.text("a.md")).toBe("# 应用里又敲了一行");
    const copies = backend.paths().filter((path) => path.includes(".conflict-"));
    expect(copies).toHaveLength(1);
    expect(backend.text(copies[0])).toBe("# 外部编辑器 / 同步盘改过的内容");
    expect(getLibrary().error).toContain("外部修改");
  });

  it("自己写入不会误判成冲突", async () => {
    const backend = await openSingle((b) => b.seed("a.md", "# 一"));
    updateNoteContent("a.md", "# 二", { immediate: true });
    await flushAll();
    updateNoteContent("a.md", "# 三", { immediate: true });
    await flushAll();
    updateNoteContent("a.md", "# 四", { immediate: true });
    await flushAll();
    expect(backend.text("a.md")).toBe("# 四");
    expect(backend.paths().some((path) => path.includes(".conflict-"))).toBe(false);
    expect(getLibrary().error).toBeNull();
  });
});

describe("D09 回收站恢复后父文件夹可见", () => {
  it("恢复单篇会补回多级父文件夹节点", async () => {
    const backend = await openSingle(firstChapter);
    await deleteFolder("故事", "trash");
    expect(getLibrary().folders["故事"]).toBeUndefined();
    await restoreNote(".opennote/trash/故事/子目录/第二章.md");
    expect(backend.text("故事/子目录/第二章.md")).toBe("# 第二章\n草稿");
    expect(getLibrary().folders["故事"]).toBeDefined();
    expect(getLibrary().folders["故事/子目录"]).toBeDefined();
    expect(notesInFolder(getLibrary(), "故事", { descendants: true }).map((note) => note.id)).toContain("故事/子目录/第二章.md");
    expect(getUi().expanded).toContain("故事/子目录");
  });
});

describe("D10 元数据原子写与损坏备份", () => {
  it("写元数据只经一次 writeText 落到最终路径，不删除 state.json 也不用 move", async () => {
    const backend = await openSingle((b) => b.seed("a.md", "# a"));
    await flushMeta();
    expect(backend.has(".opennote/state.json")).toBe(true);
    expect(backend.has(".opennote/state.json.tmp")).toBe(false);
    expect(JSON.parse(backend.text(".opennote/state.json") ?? "{}").version).toBe(1);

    backend.calls.length = 0;
    setSidebarTab("search");
    await flushMeta();

    // 元数据保护现在由后端负责：三种后端的 writeText 内部就是「临时文件 + 覆盖目标」
    // （node 走主进程 tmp+rename，fsa/opfs 走 writeFileSafely）。渲染层因此不能再
    // 「先删掉 state.json 再 move」——那既留下「文件不存在」的窗口，又因为所有后端的
    // move 都不覆盖已存在目标而注定失败，让 Electron 每次都在控制台打印一条
    // handler 错误。这里锁住的就是「不删目标、不用 move」这两条。
    expect(backend.calls).not.toContain("remove:.opennote/state.json");
    expect(backend.calls.some((call) => call.startsWith("move:"))).toBe(false);
    expect(JSON.parse(backend.text(".opennote/state.json") ?? "{}").ui.sidebarTab).toBe("search");
    expect(backend.has(".opennote/state.json.tmp")).toBe(false);
    expect(getLibrary().error).toBeNull();
  });

  it("state.json 写不进去时保留旧内容并报错，不静默丢弃也不写坏", async () => {
    const backend = await openSingle((b) => b.seed("a.md", "# a"));
    setSidebarTab("files");
    await flushMeta();
    const before = backend.text(".opennote/state.json");
    expect(before).toBeTruthy();

    backend.failWrites.add(".opennote/state.json");
    setSidebarTab("search");
    await flushMeta();

    expect(backend.text(".opennote/state.json")).toBe(before);
    expect(getLibrary().error).not.toBeNull();
    backend.failWrites.clear();
  });

  it("state.json 损坏先备份再回落默认值", async () => {
    const backend = await openSingle((b) => b.seed(".opennote/state.json", "{ 这不是 JSON"));
    const backups = backend.paths().filter((path) => path.startsWith(".opennote/state.json.corrupt-"));
    expect(backups).toHaveLength(1);
    expect(backend.text(backups[0])).toBe("{ 这不是 JSON");
    expect(getLibrary().error).toContain("状态文件损坏");
    await flushMeta();
    expect(JSON.parse(backend.text(".opennote/state.json") ?? "{}").version).toBe(1);
    expect(backend.text(backups[0])).toBe("{ 这不是 JSON");
  });
});

describe("D11 关窗前按顺序落盘", () => {
  it("先写笔记再写元数据，且不抛出", async () => {
    const backend = await openSingle((b) => b.seed("a.md", "# a"));
    updateNoteContent("a.md", "# 关窗前的输入");
    await flushForClose();
    expect(backend.text("a.md")).toBe("# 关窗前的输入");
    const noteAt = backend.calls.indexOf("write:a.md");
    const metaAt = backend.calls.findIndex((call) => call.includes(".opennote/state.json"));
    expect(noteAt).toBeGreaterThanOrEqual(0);
    expect(metaAt).toBeGreaterThan(noteAt);
    expect(Object.keys(getLibrary().dirty)).toEqual([]);
  });

  it("写入失败时 flushForClose 仍然 resolve，元数据照样落盘", async () => {
    const backend = await openSingle((b) => b.seed("a.md", "# a"));
    backend.failWrites.add("a.md");
    updateNoteContent("a.md", "# 写不进去");
    await expect(flushForClose()).resolves.toBeUndefined();
    expect(backend.has(".opennote/state.json")).toBe(true);
    expect(getLibrary().error).toContain("写入笔记失败");
  });
});

describe("D27 数据侧死代码与持久化", () => {
  it("purgeNote 同时清掉历史快照与笔记同级 assets", async () => {
    const backend = await openSingle((b) => {
      b.seed("资料/笔记.md", "# 要彻底删除");
      b.seed("资料/assets/图.png", "png");
    });
    await trashNote("资料/笔记.md");
    const trashed = ".opennote/trash/资料/笔记.md";
    backend.seed(joinPath(".opennote/history", trashed, "2026-01-01 10-00-auto.md"), "# 旧版本");
    await purgeNote(trashed);
    expect(backend.has(trashed)).toBe(false);
    expect(backend.has(joinPath(".opennote/history", trashed))).toBe(false);
    expect(backend.has("资料/assets")).toBe(false);
    expect(getLibrary().trash[trashed]).toBeUndefined();
  });

  it("共享 assets 目录不会因为彻底删除一篇笔记而丢失", async () => {
    const backend = await openSingle((b) => {
      b.seed("资料/甲.md", "# 甲");
      b.seed("资料/乙.md", "# 乙");
      b.seed("资料/assets/共用.png", "png");
    });
    await trashNote("资料/甲.md");
    await purgeNote(".opennote/trash/资料/甲.md");
    expect(backend.text("资料/assets/共用.png")).toBe("png");
  });

  it("emptyTrash 返回条数并整体清空回收站", async () => {
    const backend = await openSingle((b) => {
      b.seed("资料/甲.md", "# 甲");
      b.seed("资料/乙.md", "# 乙");
      b.seed("资料/assets/图.png", "png");
    });
    await trashNote("资料/甲.md");
    await trashNote("资料/乙.md");
    const trashed = ".opennote/trash/资料/甲.md";
    backend.seed(joinPath(".opennote/history", trashed, "2026-01-01 10-00-auto.md"), "# 旧版本");
    expect(await emptyTrash()).toBe(2);
    expect(backend.has(".opennote/trash")).toBe(false);
    expect(backend.has(joinPath(".opennote/history", trashed))).toBe(false);
    expect(getLibrary().trash).toEqual({});
    expect(await emptyTrash()).toBe(0);
  });

  it("关闭标签释放不再使用的图片 blob URL，关闭笔记本释放全部", async () => {
    const revoked: string[] = [];
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url: string) => { revoked.push(url); });
    const backend = await openSingle((b) => {
      b.seed("甲.md", "# 甲\n![](./assets/图.png)");
      b.seed("乙.md", "# 乙");
    });
    openNote("甲.md");
    openNote("乙.md");
    imageUrlStore.set({ "assets/图.png": "blob:keep", "assets/unused.png": "blob:drop" });
    closeTab("乙.md");
    await sleep();
    expect(revoked).toContain("blob:drop");
    expect(revoked).not.toContain("blob:keep");
    closeTab("甲.md");
    await sleep();
    expect(revoked).toContain("blob:keep");
    imageUrlStore.set({ "甲.md": "blob:workspace" });
    await closeWorkspace();
    expect(revoked).toContain("blob:workspace");
    expect(backend.has("甲.md")).toBe(true);
  });

  it("releaseUnusedImageUrls 只保留仍然可见的路径", async () => {
    const revoked: string[] = [];
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url: string) => { revoked.push(url); });
    await openSingle((b) => b.seed("甲.md", "# 甲\n![](./assets/图.png)"));
    openNote("甲.md");
    imageUrlStore.set({ "assets/图.png": "blob:a", "assets/gone.png": "blob:b" });
    expect(releaseUnusedImageUrls()).toBe(1);
    expect(revoked).toEqual(["blob:b"]);
    expect(imageUrlStore.get()["assets/图.png"]).toBe("blob:a");
    imageUrlStore.set({ "assets/图.png": "blob:a" });
    releaseImageUrls();
    expect(revoked).toEqual(["blob:b", "blob:a"]);
  });

  it("setSidebarTab 同时写 UI 设置与 state.json，重开后恢复", async () => {
    const backend = await openSingle((b) => b.seed("a.md", "# a"));
    setSidebarTab("tags");
    expect(getUi().sidebarTab).toBe("tags");
    await flushMeta();
    expect(JSON.parse(backend.text(".opennote/state.json") ?? "{}").ui.sidebarTab).toBe("tags");
    await closeWorkspace();
    await openRecord("test");
    expect(getUi().sidebarTab).toBe("tags");
  });
});

describe("其它不易察觉的回归", () => {
  it("新建笔记仍然立刻出现在库里并可编辑", async () => {
    const backend = await openSingle((b) => b.seed("a.md", "# a"));
    const note = createNote({ title: "草稿", content: "# 草稿" });
    expect(getLibrary().notes[note.id].content).toBe("# 草稿");
    updateNoteContent(note.id, "# 草稿\n第二行");
    await flushAll();
    expect(backend.text(note.id)).toBe("# 草稿\n第二行");
    expect(Object.keys(getLibrary().dirty)).toEqual([]);
  });
});

/** `readFileAsText` needs a browser FileReader; Node only ships `File`. */
class NodeFileReader {
  result: string | null = null;
  error: unknown = null;
  onload: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;

  readAsText(file: File): void {
    void file.text().then(
      (text) => { this.result = text; this.onload?.(); },
      (error) => { this.error = error; this.onerror?.(); },
    );
  }
}
