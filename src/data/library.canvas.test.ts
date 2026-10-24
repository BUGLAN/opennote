/**
 * 画布（`.canvas`）在库层的一等公民行为：扫描收编、创建/复制、搜索与自动改名守卫、
 * 视口读写与损坏恢复、引用跟随改写（改名/移动/目录/恢复）、回收站三件套与快照扩展名。
 *
 * 基建照抄 `library.files.test.ts`：内存后端 + mock `workspaces` + `openWorkspace`，
 * 画布落盘全部走真实链路（`flushAll`/`flushMeta`），不 mock 数据层自身。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STATE_FILE, baseName, joinPath, parentPath } from "../fs/paths";
import type { EntryInfo, FileSystemBackend } from "../fs/types";
import { serializeCanvas } from "../canvas/jsonCanvas";
import type { WorkspaceRecord } from "./workspaces";

let testBackend: MemoryBackend;
vi.mock("./workspaces", () => ({
  activeWorkspaceRecord: () => null,
  resolveBackend: async () => testBackend,
  setActiveWorkspace: () => undefined,
}));

import {
  canvasesReferencing,
  closeWorkspace,
  createCanvas,
  createNote,
  deleteFolder,
  duplicateNote,
  flushAll,
  flushMeta,
  getCanvasViewport,
  getLibrary,
  hasPendingAutoRename,
  listSnapshots,
  moveFolder,
  moveNote,
  openWorkspace,
  purgeNote,
  renameFolder,
  renameNote,
  restoreNote,
  restoreSnapshot,
  searchNotes,
  setCanvasViewport,
  shouldAutoRename,
  takeManualSnapshot,
  trashNote,
  updateNoteContent,
  type AutoRenameContext,
} from "./library";
import { getUi, patchUi } from "./ui";

class MemoryBackend implements FileSystemBackend {
  readonly kind = "node";
  readonly label = "本机磁盘";
  readonly canWrite = true;
  readonly dirs = new Set([""]);
  readonly files = new Map<string, string | Uint8Array>();

  seed(path: string, text: string): void {
    this.mkdirSync(parentPath(path));
    this.files.set(path, text);
  }

  private mkdirSync(path: string): void {
    if (!path || this.dirs.has(path)) return;
    this.mkdirSync(parentPath(path));
    this.dirs.add(path);
  }

  async mkdir(path: string): Promise<void> { this.mkdirSync(path); }
  async list(path: string): Promise<EntryInfo[]> {
    if (!this.dirs.has(path)) throw new Error(`ENOENT ${path}`);
    const dirEntries = [...this.dirs].filter((c) => c && parentPath(c) === path)
      .map((c) => ({ name: baseName(c), kind: "directory" as const, size: 0, mtimeMs: 1 }));
    const fileEntries = [...this.files].filter(([c]) => parentPath(c) === path)
      .map(([c, v]) => ({ name: baseName(c), kind: "file" as const, size: v.length, mtimeMs: 1 }));
    return [...dirEntries, ...fileEntries];
  }
  async readText(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT ${path}`);
    return typeof value === "string" ? value : new TextDecoder().decode(value);
  }
  async readBytes(path: string): Promise<Uint8Array> { return new TextEncoder().encode(await this.readText(path)); }
  async writeText(path: string, text: string): Promise<void> {
    this.mkdirSync(parentPath(path));
    this.files.set(path, text);
  }
  async writeBytes(path: string, bytes: Uint8Array | Blob): Promise<void> {
    this.mkdirSync(parentPath(path));
    this.files.set(path, bytes instanceof Blob ? new Uint8Array(await bytes.arrayBuffer()) : bytes);
  }
  async exists(path: string): Promise<boolean> { return this.dirs.has(path) || this.files.has(path); }
  async stat(path: string): Promise<{ size: number; mtimeMs: number } | null> {
    const value = this.files.get(path);
    return value === undefined ? null : { size: value.length, mtimeMs: 1 };
  }
  async move(from: string, to: string): Promise<void> {
    if (await this.exists(to)) throw new Error(`EEXIST ${to}`);
    this.mkdirSync(parentPath(to));
    if (this.files.has(from)) {
      this.files.set(to, this.files.get(from)!);
      this.files.delete(from);
      return;
    }
    if (!this.dirs.has(from)) throw new Error(`ENOENT ${from}`);
    for (const [path, content] of [...this.files]) {
      if (path.startsWith(`${from}/`)) {
        this.files.delete(path);
        this.files.set(`${to}${path.slice(from.length)}`, content);
      }
    }
    for (const path of [...this.dirs].filter((dir) => dir === from || dir.startsWith(`${from}/`))) {
      this.dirs.delete(path);
      this.dirs.add(`${to}${path.slice(from.length)}`);
    }
  }
  async remove(path: string, options?: {recursive?: boolean}): Promise<void> {
    if (this.files.delete(path)) return;
    if (!this.dirs.has(path)) throw new Error(`ENOENT ${path}`);
    const hasChildren = [...this.files.keys(), ...this.dirs].some((entry) => entry.startsWith(`${path}/`));
    if (hasChildren && !options?.recursive) throw new Error("ENOTEMPTY");
    for (const entry of [...this.files.keys()]) if (entry.startsWith(`${path}/`)) this.files.delete(entry);
    for (const entry of [...this.dirs]) if (entry === path || entry.startsWith(`${path}/`)) this.dirs.delete(entry);
  }
}

const record: WorkspaceRecord = { id: "test", name: "临时笔记本", kind: "node", location: "unused", addedAt: 1, lastOpenedAt: 1 };

/** 一张只含一个文件卡片的画布（引用写法可指定，用于容错口径）。 */
function canvasDoc(file: string): string {
  return serializeCanvas({
    nodes: [{ id: "card1", type: "file", x: 0, y: 0, width: 240, height: 120, file }],
    edges: [],
  });
}

/** 等 createNote/createCanvas 的 preflight（内存占名 → 磁盘复核）落地。 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function open(): Promise<void> {
  await openWorkspace(record, { silent: true });
}

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  testBackend = new MemoryBackend();
  patchUi({ snapshots: true });
});

afterEach(async () => {
  await closeWorkspace().catch(() => undefined);
  vi.restoreAllMocks();
});

describe("扫描与身份", () => {
  beforeEach(async () => {
    testBackend.seed("a.md", "# 内容\n正文");
    testBackend.seed("看板.canvas", '{\r\n  "nodes": [],\r\n  "edges": []\r\n}\r\n');
    await open();
  });

  it(".canvas 收进 notes：kind=canvas、title=stem、tags 空、words 0、chars=全文长度、content 是磁盘原文镜像", () => {
    const note = getLibrary().notes["看板.canvas"];
    expect(note).toBeDefined();
    expect(note?.kind).toBe("canvas");
    expect(note?.title).toBe("看板");
    expect(note?.tags).toEqual([]);
    expect(note?.words).toBe(0);
    expect(note?.chars).toBe('{\r\n  "nodes": [],\r\n  "edges": []\r\n}\r\n'.length);
    // CRLF 不被归一化 —— 磁盘原文镜像。
    expect(note?.content).toBe('{\r\n  "nodes": [],\r\n  "edges": []\r\n}\r\n');
    // 对照组：.md 仍是 note。
    expect(getLibrary().notes["a.md"]?.kind).toBe("note");
  });

  it("回收站里的 .canvas 同样被扫描（trash 桶、kind=canvas）", async () => {
    await closeWorkspace();
    testBackend.seed(".opennote/trash/废画布.canvas", canvasDoc("a.md"));
    await open();
    const trashed = getLibrary().trash[".opennote/trash/废画布.canvas"];
    expect(trashed?.kind).toBe("canvas");
    expect(getLibrary().notes["废画布.canvas"]).toBeUndefined();
  });

  it("createCanvas：未命名画布.canvas 防重名、空文档内容、默认打开并激活标签", async () => {
    const first = createCanvas();
    expect(first.id).toBe("未命名画布.canvas");
    expect(first.kind).toBe("canvas");
    expect(first.content).toBe('{\n  "nodes": [],\n  "edges": []\n}\n');
    expect(getUi().activeId).toBe(first.id);
    const second = createCanvas();
    expect(second.id).toBe("未命名画布 2.canvas");
    await settle();
    await flushAll();
    expect(testBackend.files.get("未命名画布.canvas")).toBe(first.content);
    expect(testBackend.files.get("未命名画布 2.canvas")).toBe(second.content);
  });

  it("duplicateNote 对画布：扩展名 .canvas、内容原样拷贝、不抛异常", async () => {
    const copy = duplicateNote("看板.canvas");
    expect(copy?.id).toBe("看板 副本.canvas");
    expect(copy?.kind).toBe("canvas");
    expect(copy?.content).toBe(getLibrary().notes["看板.canvas"]?.content);
    await settle();
    await flushAll();
    expect(testBackend.files.get("看板 副本.canvas")).toBe(copy?.content);
  });

  it("searchNotes 对画布整体跳过（标题也不参与搜索）", () => {
    const canvas = getLibrary().notes["看板.canvas"];
    updateNoteContent(canvas!.id, canvasDoc("zzz独特needle.md"), { immediate: true });
    expect(searchNotes("看板")).toEqual([]);
    expect(searchNotes("zzz独特needle")).toEqual([]);
    // 对照：普通笔记仍可搜到（证明不是搜索坏了）。
    expect(searchNotes("内容").map((hit) => hit.note.id)).toEqual(["a.md"]);
  });

  it("shouldAutoRename 拦画布；编辑画布不会排自动改名定时器", () => {
    const now = Date.now();
    const ctx: AutoRenameContext = {
      id: "未命名画布.canvas",
      stem: "未命名画布",
      placeholderOrigin: true,
      kind: "canvas",
      content: "## 标题\n",
      titleOverride: null,
      trashed: false,
      createdAt: now - 60_000,
      now,
      composing: false,
      creating: false,
      locked: false,
      lastAutoRenameAt: null,
      explicitRenamedAt: null,
      pinnedAt: null,
      inFlight: false,
      autoTitleFromPlaceholder: true,
    };
    expect(shouldAutoRename(ctx)).toBe("画布不参与自动改名");
    const canvas = getLibrary().notes["看板.canvas"]!;
    updateNoteContent(canvas.id, canvasDoc("a.md"), { immediate: true });
    expect(hasPendingAutoRename(canvas.id)).toBe(false);
  });
});

describe("画布视口", () => {
  beforeEach(async () => {
    testBackend.seed("看板.canvas", canvasDoc("a.md"));
    await open();
  });

  it("setCanvasViewport / getCanvasViewport 读写并随 state.json 持久化，重开笔记本仍在", async () => {
    expect(getCanvasViewport("看板.canvas")).toBeNull();
    setCanvasViewport("看板.canvas", { x: 10, y: -5, zoom: 1.25 });
    expect(getCanvasViewport("看板.canvas")).toEqual({ x: 10, y: -5, zoom: 1.25 });
    // 非法输入被忽略：视口是缓存性质的状态，不值得弹错误。
    setCanvasViewport("看板.canvas", { x: Number.NaN, y: 0, zoom: 1 });
    setCanvasViewport("看板.canvas", { x: 0, y: 0, zoom: 0 });
    expect(getCanvasViewport("看板.canvas")).toEqual({ x: 10, y: -5, zoom: 1.25 });
    await flushMeta();
    const raw = String(testBackend.files.get(STATE_FILE));
    expect(JSON.parse(raw).canvasViewport["看板.canvas"]).toEqual({ x: 10, y: -5, zoom: 1.25 });
    await closeWorkspace();
    await open();
    expect(getCanvasViewport("看板.canvas")).toEqual({ x: 10, y: -5, zoom: 1.25 });
  });

  it("state.json 里的 canvasViewport 坏条目被丢弃，好条目保留", async () => {
    await closeWorkspace();
    testBackend.writeText(
      STATE_FILE,
      JSON.stringify({
        canvasViewport: {
          "": { x: 1, y: 1, zoom: 1 },
          "坏.canvas": "garbage",
          "零.canvas": { x: 1, y: 1, zoom: 0 },
          "非数字.canvas": { x: "a", y: 1, zoom: 1 },
          "好.canvas": { x: 1, y: 2, zoom: 3 },
        },
      }),
    );
    await open();
    expect(getCanvasViewport("好.canvas")).toEqual({ x: 1, y: 2, zoom: 3 });
    expect(getCanvasViewport("坏.canvas")).toBeNull();
    expect(getCanvasViewport("零.canvas")).toBeNull();
    expect(getCanvasViewport("非数字.canvas")).toBeNull();
  });

  it("整份 state.json 损坏：走 corrupt-* 备份恢复，视口读取不炸、返回 null", async () => {
    await closeWorkspace();
    testBackend.writeText(STATE_FILE, "{oops 不是 JSON");
    await open();
    expect(getCanvasViewport("看板.canvas")).toBeNull();
    const backups = [...testBackend.files.keys()].filter((path) => path.startsWith(`${STATE_FILE}.corrupt-`));
    expect(backups.length).toBe(1);
  });

  it("视口键跟着画布改名走（remapIds 搬键）", async () => {
    setCanvasViewport("看板.canvas", { x: 1, y: 2, zoom: 0.5 });
    await renameNote("看板.canvas", "新看板");
    await settle();
    await flushAll();
    expect(getCanvasViewport("新看板.canvas")).toEqual({ x: 1, y: 2, zoom: 0.5 });
    expect(getCanvasViewport("看板.canvas")).toBeNull();
  });
});

describe("引用跟随改写", () => {
  beforeEach(async () => {
    testBackend.seed("a.md", "# 内容\n");
    testBackend.seed("故事/占位.md", "# 占位\n");
    testBackend.seed("看板.canvas", canvasDoc("./a.md"));
    await open();
  });

  it("renameNote：file===旧路径（含 ./ 前缀写法）的卡片改写为新路径，反查同步换位", async () => {
    await renameNote("a.md", "新名");
    await flushAll();
    expect(testBackend.files.get("看板.canvas")).toBe(canvasDoc("新名.md"));
    expect(canvasesReferencing("新名.md")).toEqual([{ canvasId: "看板.canvas", nodeId: "card1" }]);
    expect(canvasesReferencing("a.md")).toEqual([]);
  });

  it("moveNote：换目录后引用落到新位置", async () => {
    await moveNote("a.md", "故事");
    await flushAll();
    expect(testBackend.files.get("看板.canvas")).toBe(canvasDoc("故事/a.md"));
  });

  it("renameFolder：改文件夹名，指向 夹/子/x.md 的卡片变为 新名/子/x.md（前缀+后缀保留）", async () => {
    await closeWorkspace();
    testBackend.seed("夹/子/x.md", "# x\n");
    testBackend.seed("看板.canvas", canvasDoc("夹/子/x.md"));
    await open();
    await renameFolder("夹", "新名");
    await flushAll();
    expect(testBackend.files.get("看板.canvas")).toBe(canvasDoc("新名/子/x.md"));
    expect(canvasesReferencing("新名/子/x.md")).toEqual([{ canvasId: "看板.canvas", nodeId: "card1" }]);
  });

  it("moveFolder：目录整体搬家，目录下笔记的引用按前缀跟随", async () => {
    await closeWorkspace();
    testBackend.seed("旧夹/x.md", "# x\n");
    testBackend.seed("新家/keep.md", "# keep\n");
    testBackend.seed("看板.canvas", canvasDoc("旧夹/x.md"));
    await open();
    await moveFolder("旧夹", "新家");
    await flushAll();
    expect(testBackend.files.get("看板.canvas")).toBe(canvasDoc("新家/旧夹/x.md"));
  });

  it("deleteFolder(promote)：提升到上级目录，目录条目按前缀、文件条目按精确匹配跟随", async () => {
    await closeWorkspace();
    testBackend.seed("夹/x.md", "# x\n");
    testBackend.seed("夹/子/y.md", "# y\n");
    testBackend.seed("看板.canvas", serializeCanvas({
      nodes: [
        { id: "c1", type: "file", x: 0, y: 0, width: 1, height: 1, file: "夹/x.md" },
        { id: "c2", type: "file", x: 0, y: 0, width: 1, height: 1, file: "夹/子/y.md" },
      ],
      edges: [],
    }));
    await open();
    await deleteFolder("夹", "promote");
    await flushAll();
    const text = testBackend.files.get("看板.canvas")!;
    expect(text).toContain('"file": "x.md"');
    expect(text).toContain('"file": "子/y.md"');
  });

  it("trashNote 不跟随：卡片引用保持原路径（失效态由视图层判断）", async () => {
    await trashNote("a.md");
    await flushAll();
    expect(testBackend.files.get("看板.canvas")).toBe(canvasDoc("./a.md"));
    expect(canvasesReferencing("a.md")).toEqual([{ canvasId: "看板.canvas", nodeId: "card1" }]);
  });

  it("restoreNote 跟随（含带序号的新路径）：引用落到恢复后的最终路径", async () => {
    await trashNote("a.md");
    const squatter = createNote({ title: "a" });
    await settle();
    await flushAll();
    expect(squatter.id).toBe("a.md");
    await restoreNote(".opennote/trash/a.md");
    await flushAll();
    expect(testBackend.files.get("看板.canvas")).toBe(canvasDoc("a 2.md"));
    expect(canvasesReferencing("a 2.md")).toEqual([{ canvasId: "看板.canvas", nodeId: "card1" }]);
  });

  it("解析失败的画布跳过不动并 console.warn，好画布照常改写", async () => {
    await closeWorkspace();
    testBackend.seed("好.canvas", canvasDoc("a.md"));
    testBackend.seed("坏.canvas", "{不是 JSON");
    testBackend.seed("看板.canvas", canvasDoc("a.md"));
    await open();
    await renameNote("a.md", "新名");
    await flushAll();
    expect(testBackend.files.get("好.canvas")).toBe(canvasDoc("新名.md"));
    expect(testBackend.files.get("看板.canvas")).toBe(canvasDoc("新名.md"));
    expect(testBackend.files.get("坏.canvas")).toBe("{不是 JSON");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("画布解析失败"), "坏.canvas");
  });

  it("正文中引用画布的 file 卡片：画布自身改名也跟随（引用目标可以是 .canvas）", async () => {
    await closeWorkspace();
    testBackend.seed("目标画布.canvas", canvasDoc("a.md"));
    testBackend.seed("看板.canvas", canvasDoc("目标画布.canvas"));
    await open();
    await renameNote("目标画布.canvas", "改名画布");
    await flushAll();
    expect(testBackend.files.get("看板.canvas")).toBe(canvasDoc("改名画布.canvas"));
  });
});

describe("回收站与快照", () => {
  beforeEach(async () => {
    testBackend.seed("史.canvas", canvasDoc("a.md"));
    await open();
  });

  it("画布进回收站：路径驱动、进 trash 桶、视口键跟随", async () => {
    setCanvasViewport("史.canvas", { x: 3, y: 4, zoom: 2 });
    await trashNote("史.canvas");
    const trashId = ".opennote/trash/史.canvas";
    expect(testBackend.files.get(trashId)).toBe(canvasDoc("a.md"));
    expect(getLibrary().trash[trashId]?.kind).toBe("canvas");
    expect(getLibrary().notes["史.canvas"]).toBeUndefined();
    expect(getCanvasViewport(trashId)).toEqual({ x: 3, y: 4, zoom: 2 });
  });

  it("恢复画布回到原位", async () => {
    await trashNote("史.canvas");
    await restoreNote(".opennote/trash/史.canvas");
    expect(testBackend.files.get("史.canvas")).toBe(canvasDoc("a.md"));
    expect(getLibrary().notes["史.canvas"]?.kind).toBe("canvas");
    expect(getLibrary().trash[".opennote/trash/史.canvas"]).toBeUndefined();
  });

  it("彻底删除：文件与历史快照一起清，视口清账", async () => {
    updateNoteContent("史.canvas", canvasDoc("b.md"), { immediate: true });
    await flushAll();
    await takeManualSnapshot("史.canvas");
    const historyDir = joinPath(".opennote/history", "史.canvas");
    expect([...testBackend.files.keys()].some((p) => p.startsWith(historyDir))).toBe(true);
    await trashNote("史.canvas");
    await purgeNote(".opennote/trash/史.canvas");
    expect(testBackend.files.get(".opennote/trash/史.canvas")).toBeUndefined();
    expect([...testBackend.files.keys()].some((p) => p.startsWith(historyDir))).toBe(false);
    expect(getCanvasViewport(".opennote/trash/史.canvas")).toBeNull();
  });

  it("快照扩展名跟随源文件（.canvas），内容是磁盘原文；恢复快照写回原文", async () => {
    const v1 = canvasDoc("a.md");
    const v2 = canvasDoc("b.md");
    updateNoteContent("史.canvas", v2, { immediate: true });
    await flushAll();
    await takeManualSnapshot("史.canvas");
    const snapshots = await listSnapshots("史.canvas");
    expect(snapshots.length).toBe(2);
    expect(snapshots.every((s) => s.id.endsWith(".canvas"))).toBe(true);
    const manual = snapshots.find((s) => s.reason === "manual");
    expect(manual?.content).toBe(v2);
    // 后端 mtimeMs 全是 1，列表顺序不可依赖 —— 按 reason 找自动快照（v1）来恢复。
    const auto = snapshots.find((s) => s.reason === "auto");
    expect(auto?.content).toBe(v1);
    await restoreSnapshot(auto!);
    await flushAll();
    expect(testBackend.files.get("史.canvas")).toBe(v1);
    expect(getLibrary().notes["史.canvas"]?.content).toBe(v1);
  });
});
