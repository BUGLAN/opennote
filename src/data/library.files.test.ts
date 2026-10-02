import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseName, joinPath, parentPath } from "../fs/paths";
import type { EntryInfo, FileSystemBackend } from "../fs/types";
import type { WorkspaceRecord } from "./workspaces";

let testBackend: MemoryBackend;
vi.mock("./workspaces", () => ({
  activeWorkspaceRecord: () => null,
  resolveBackend: async () => testBackend,
  setActiveWorkspace: () => undefined,
}));

import {
  childFolders,
  deleteFolder,
  flushAll,
  flushMeta,
  folderChoiceList,
  folderChoiceTrail,
  folderChoiceTree,
  getLibrary,
  moveNote,
  openWorkspace,
  purgeNote,
  renameNote,
  rescanWorkspace,
  restoreNote,
  trashNote,
  updateNoteContent,
} from "./library";

class MemoryBackend implements FileSystemBackend {
  readonly kind = "node";
  readonly label = "本机磁盘";
  readonly canWrite = true;
  readonly dirs = new Set([""]);
  readonly files = new Map<string, string | Uint8Array>();
  readonly calls: string[] = [];

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
    this.calls.push(`list:${path}`);
    if (!this.dirs.has(path)) throw new Error(`ENOENT ${path}`);
    const dirEntries = [...this.dirs].filter((candidate) => candidate && parentPath(candidate) === path)
      .map((candidate) => ({ name: baseName(candidate), kind: "directory" as const, size: 0, mtimeMs: 1 }));
    const fileEntries = [...this.files].filter(([candidate]) => parentPath(candidate) === path)
      .map(([candidate, value]) => ({ name: baseName(candidate), kind: "file" as const, size: typeof value === "string" ? value.length : value.length, mtimeMs: 1 }));
    return [...dirEntries, ...fileEntries];
  }
  async readText(path: string): Promise<string> {
    this.calls.push(`read:${path}`);
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT ${path}`);
    return typeof value === "string" ? value : new TextDecoder().decode(value);
  }
  async readBytes(path: string): Promise<Uint8Array> { return new TextEncoder().encode(await this.readText(path)); }
  async writeText(path: string, text: string): Promise<void> {
    this.calls.push(`write:${path}`);
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
    this.calls.push(`move:${from}->${to}`);
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
  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    this.calls.push(`remove:${path}`);
    if (this.files.delete(path)) return;
    if (!this.dirs.has(path)) throw new Error(`ENOENT ${path}`);
    const hasChildren = [...this.files.keys(), ...this.dirs].some((entry) => entry.startsWith(`${path}/`));
    if (hasChildren && !options?.recursive) throw new Error(`ENOTEMPTY ${path}`);
    for (const entry of [...this.files.keys()]) if (entry.startsWith(`${path}/`)) this.files.delete(entry);
    for (const entry of [...this.dirs]) if (entry === path || entry.startsWith(`${path}/`)) this.dirs.delete(entry);
  }
}

const record: WorkspaceRecord = { id: "test", name: "临时笔记本", kind: "node", location: "unused", addedAt: 1, lastOpenedAt: 1 };

beforeEach(async () => {
  testBackend = new MemoryBackend();
  testBackend.seed("故事/第一章.md", "# 第一章\n初稿");
  testBackend.seed("故事/子目录/第二章.md", "# 第二章\n草稿");
  testBackend.seed("故事/assets/封面.png", "pixels");
  await openWorkspace(record, { silent: true });
});

afterEach(async () => { await flushAll(); await flushMeta(); vi.restoreAllMocks(); });

describe("filesystem-backed workspace operations", () => {
  it("trashes the directory atomically, retains nested notes/assets and reloads the trash", async () => {
    await deleteFolder("故事", "trash");
    expect(testBackend.files.get(".opennote/trash/故事/第一章.md")).toBe("# 第一章\n初稿");
    expect(testBackend.files.get(".opennote/trash/故事/子目录/第二章.md")).toBe("# 第二章\n草稿");
    expect(testBackend.files.get(".opennote/trash/故事/assets/封面.png")).toBe("pixels");
    expect(getLibrary().notes["故事/第一章.md"]).toBeUndefined();
    await rescanWorkspace();
    expect(Object.keys(getLibrary().trash)).toContain(".opennote/trash/故事/第一章.md");
    expect(testBackend.calls).not.toContain("remove:.opennote/trash/故事");
  });

  it("restores a trashed note with its adjacent assets", async () => {
    await deleteFolder("故事", "trash");
    await restoreNote(".opennote/trash/故事/第一章.md");
    expect(testBackend.files.get("故事/第一章.md")).toBe("# 第一章\n初稿");
    expect(testBackend.files.get("故事/assets/封面.png")).toBe("pixels");
  });

  it("promotes children without flattening nested folders", async () => {
    await deleteFolder("故事", "promote");
    expect(testBackend.files.get("第一章.md")).toBe("# 第一章\n初稿");
    expect(testBackend.files.get("子目录/第二章.md")).toBe("# 第二章\n草稿");
    expect(testBackend.files.get("assets/封面.png")).toBe("pixels");
    expect(testBackend.dirs.has("故事")).toBe(false);
  });

  it("leaves the directory intact when promotion would overwrite an existing asset folder", async () => {
    testBackend.seed("assets/existing.png", "existing");
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await deleteFolder("故事", "promote");
    expect(testBackend.files.get("故事/第一章.md")).toBe("# 第一章\n初稿");
    expect(testBackend.files.get("assets/existing.png")).toBe("existing");
    expect(testBackend.calls.some((call) => call.startsWith("move:故事/"))).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("flushes pending edits before renaming so the new file keeps the latest text", async () => {
    updateNoteContent("故事/第一章.md", "# 改过\n未落盘");
    await renameNote("故事/第一章.md", "改名");
    expect(testBackend.files.get(joinPath("故事", "改名.md"))).toBe("# 改过\n未落盘");
    expect(testBackend.files.has("故事/第一章.md")).toBe(false);
  });
});

/**
 * 图片跟笔记走（用户原话「从收件箱移动到其他位置时，图片位置也应改变」）。
 *
 * 判据盯的是**用户看得见的那条路径**：正文里写着 `./第一章.assets/图.png`，
 * 那么这条引用在删除/恢复/移动之后必须仍然指得到文件。
 *
 * 两个方向**一起**咬：「删了再恢复，图丢了」和「恢复到了一个名字被占用的路径，
 * 图留在旧名字的目录里」是同一类缺陷（一个方向修了、另一个方向没修 = 没修）。
 */
describe("图片跟笔记走：<笔记名>.assets/ 的删除 / 恢复 / 移动", () => {
  const DERIVED = "故事/第一章.assets/图.png";
  const TRASHED_DERIVED = ".opennote/trash/故事/第一章.assets/图.png";
  const LEGACY = "故事/assets/封面.png";

  beforeEach(() => {
    testBackend.seed(DERIVED, "derived-pixels");
  });

  it("删除 → 恢复：附件目录跟着进回收站、再回到原路径，字节相同；公共 assets/ 一个字节没动", async () => {
    await trashNote("故事/第一章.md");
    expect(testBackend.files.get(TRASHED_DERIVED)).toBe("derived-pixels");
    expect(testBackend.files.has(DERIVED)).toBe(false);
    expect(testBackend.files.get(LEGACY)).toBe("pixels");

    await restoreNote(".opennote/trash/故事/第一章.md");
    expect(testBackend.files.get("故事/第一章.md")).toBe("# 第一章\n初稿");
    expect(testBackend.files.get(DERIVED)).toBe("derived-pixels");
    expect(testBackend.files.has(TRASHED_DERIVED)).toBe(false);
    // 旧数据的图仍留在公共 assets/ 里，**一个字节都不许动**（也不许被顺手删掉）。
    expect(testBackend.files.get(LEGACY)).toBe("pixels");
  });

  it("恢复到一个被占用的名字：附件目录按**恢复后的最终路径**派生（第一章 2.assets），不是拿回收站里的旧名字凑", async () => {
    await trashNote("故事/第一章.md");
    // 原来的名字被别人占了：恢复只能落到 `第一章 2.md`。
    testBackend.seed("故事/第一章.md", "# 后来者");
    await rescanWorkspace();

    await restoreNote(".opennote/trash/故事/第一章.md");
    expect(testBackend.files.get("故事/第一章 2.md")).toBe("# 第一章\n初稿");
    expect(testBackend.files.get("故事/第一章 2.assets/图.png")).toBe("derived-pixels");
    // 两个「方向反了」的写法都会在这里露出来：
    // 用回收站里的 id 派生 → 图仍躺在 .opennote/trash/... 里；
    // 用旧名字派生 → 图落在 `第一章.assets`（而笔记已经叫 `第一章 2.md`），引用指空。
    expect(testBackend.files.has(TRASHED_DERIVED)).toBe(false);
    expect(testBackend.files.has("故事/第一章.assets/图.png")).toBe(false);
    expect(testBackend.files.get(LEGACY)).toBe("pixels");
  });

  it("移动到别的目录：附件目录跟着换目录（不是留在原地）", async () => {
    testBackend.seed("资料/别的.md", "# 别的");
    await rescanWorkspace();
    await moveNote("故事/第一章.md", "资料");
    expect(testBackend.files.get("资料/第一章.md")).toBe("# 第一章\n初稿");
    expect(testBackend.files.get("资料/第一章.assets/图.png")).toBe("derived-pixels");
    expect(testBackend.files.has(DERIVED)).toBe(false);
  });

  /**
   * 「移动到…」这条 UI 路径**必须能如实报告两件事各自成败**。
   *
   * 图片目录搬不动时笔记已经在新位置了 —— 只说「移动失败」会让用户以为笔记没动，
   * 只说「移动成功」则会把「图丢了」这件事整个藏起来（而正文里的引用已经指空，
   * 且**不报错**）。所以 `moveNote()` 返回 `{ path, assetsWarning }`。
   */
  it("移动到别的目录：成功时返回新路径，且没有图片告警", async () => {
    testBackend.seed("资料/别的.md", "# 别的");
    await rescanWorkspace();
    const result = await moveNote("故事/第一章.md", "资料");
    expect(result.path).toBe("资料/第一章.md");
    expect(result.assetsWarning).toBeNull();
  });

  it("目标目录已有同名 .assets：笔记照样搬、图片**不覆盖**，并把这件事如实报出来", async () => {
    testBackend.seed("资料/别的.md", "# 别的");
    // 目标位置已经有一个同名附件目录：内容不是我们的，绝不能静默覆盖。
    testBackend.seed("资料/第一章.assets/别人的图.png", "someone-elses-pixels");
    await rescanWorkspace();
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await moveNote("故事/第一章.md", "资料");

    // 笔记到位（用户看得见的那一步成功）。
    expect(result.path).toBe("资料/第一章.md");
    expect(testBackend.files.get("资料/第一章.md")).toBe("# 第一章\n初稿");
    // 告警里带着目标路径，用户才知道该去哪手工处理。
    expect(result.assetsWarning).toContain("资料/第一章.assets");
    expect(warn).toHaveBeenCalled();
    // 两边的图都还在：既没覆盖别人的，也没把原来的删掉。
    expect(testBackend.files.get("资料/第一章.assets/别人的图.png")).toBe("someone-elses-pixels");
    expect(testBackend.files.get(DERIVED)).toBe("derived-pixels");
  });

  it("笔记没有派生附件目录时：移动成功且不报图片告警（不误报）", async () => {
    testBackend.seed("资料/别的.md", "# 别的");
    await rescanWorkspace();
    // `故事/子目录/第二章.md` 没有对应的 `.assets/`：没有图可搬 ≠ 搬图失败。
    const result = await moveNote("故事/子目录/第二章.md", "资料");
    expect(result.path).toBe("资料/第二章.md");
    expect(result.assetsWarning).toBeNull();
  });

  it("移到当前已在的目录：空操作，返回 path 为 null（界面据此不发提示）", async () => {
    const result = await moveNote("故事/第一章.md", "故事");
    expect(result.path).toBeNull();
    expect(result.assetsWarning).toBeNull();
    // 文件一个字节都没动。
    expect(testBackend.files.get("故事/第一章.md")).toBe("# 第一章\n初稿");
  });

  it("彻底删除：附件目录一起消失，回收站里不留孤儿图片", async () => {
    await trashNote("故事/第一章.md");
    await purgeNote(".opennote/trash/故事/第一章.md");
    expect(testBackend.files.has(TRASHED_DERIVED)).toBe(false);
    expect(testBackend.files.has(".opennote/trash/故事/第一章.md")).toBe(false);
  });
});

/**
 * 「移动到…」选择器的候选项（`folderChoiceList()`）。
 *
 * 判据盯的是**顺序与身份**，不是长相：选择器里第 n 项必须和左栏文件树里第 n 行指向
 * 同一个目录。两份各自排序的实现迟早漂移，用户看到的就是「树里在上、选择器里在下」。
 */
describe("folderChoiceList：选择器候选项与文件树同序、同身份", () => {
  beforeEach(async () => {
    // 造一棵有同层多目录、多层嵌套的树，才能咬住「顺序」和「缩进」。
    testBackend.seed("归档/笔记.md", "# 归档\n");
    testBackend.seed("归档/2024/笔记.md", "# 2024\n");
    testBackend.seed("归档/2024/12/笔记.md", "# 12 月\n");
    await rescanWorkspace();
  });

  it("根目录恒为第一项、id 为 null、path 为空串", () => {
    const list = folderChoiceList(null);
    expect(list[0]).toEqual({ id: null, label: "笔记本根目录", path: "", depth: 0, disabled: true });
  });

  it("深度优先拍平：父目录紧跟其后的是它的子目录（不是先列完所有同层）", () => {
    const list = folderChoiceList(null);
    const paths = list.map((choice) => choice.path);
    const parent = paths.indexOf("归档");
    const child = paths.indexOf("归档/2024");
    const grandchild = paths.indexOf("归档/2024/12");
    expect(parent).toBeGreaterThan(-1);
    // 父 → 子 → 孙 是连续递进的，中间不夹别的目录。
    expect(child).toBe(parent + 1);
    expect(grandchild).toBe(child + 1);
  });

  it("缩进按层级给：根 0、顶层目录 0、子目录 1、孙目录 2", () => {
    const list = folderChoiceList(null);
    const depth = (path: string) => list.find((choice) => choice.path === path)?.depth;
    expect(depth("")).toBe(0);
    expect(depth("归档")).toBe(0);
    expect(depth("归档/2024")).toBe(1);
    expect(depth("归档/2024/12")).toBe(2);
  });

  it("笔记当前所在目录被置灰（选中它是空操作），其余项可选", () => {
    const list = folderChoiceList("归档/2024");
    const current = list.find((choice) => choice.path === "归档/2024");
    expect(current?.disabled).toBe(true);
    // 别的项一个都不许被连坐置灰。
    expect(list.filter((choice) => choice.disabled)).toHaveLength(1);
  });

  it("笔记在根目录时：根项置灰，所有文件夹可选", () => {
    const list = folderChoiceList(null);
    expect(list[0].disabled).toBe(true);
    expect(list.slice(1).every((choice) => !choice.disabled)).toBe(true);
  });

  it("顺序与文件树的 childFolders 逐项一致（同一份排序，不各排一次）", () => {
    const list = folderChoiceList(null).slice(1);
    const state = getLibrary();
    const tree: string[] = [];
    const walk = (parentId: string | null) => {
      for (const folder of childFolders(state, parentId)) {
        tree.push(folder.id);
        walk(folder.id);
      }
    };
    walk(null);
    expect(list.map((choice) => choice.path)).toEqual(tree);
  });

  it("笔记在根目录、而笔记本里一个文件夹都没有：所有候选都不可选（界面据此禁用「移动」）", () => {
    // 直接喂一个「没有任何文件夹」的状态：`folderChoiceList` 的第二参就是为此留的，
    // 不用去删真实后端里的目录再重扫（那测的是扫描，不是选择器）。
    const empty = { ...getLibrary(), folders: {} };
    const list = folderChoiceList(null, empty);
    // 只剩根项，且它就是当前所在目录 → 置灰。界面据此禁用「移动」按钮。
    expect(list).toHaveLength(1);
    expect(list.every((choice) => choice.disabled)).toBe(true);
  });
});

/**
 * 选择器的**树形视图**（`folderChoiceTree()`）与**祖先链**（`folderChoiceTrail()`）。
 *
 * 0.3.4 用户要「文件夹能折叠」「样式和首页一样」，选择器因此从拍平列表改成了树。
 * 判据盯的是：拍平序挂回树后**父子与顺序都不变**（树只是同一份候选的另一种摆法），
 * 以及祖先链确实能用来「打开时把选中项沿途展开」。
 *
 * 一个关键事实：候选列表里「笔记本根目录」（id 为 null）与顶层目录**同为 depth 0** ——
 * 它是「移到根目录」这个**目标**，不是顶层目录的**父容器**。所以树形视图有多个根：
 * 根项是其中一个、且没有孩子（界面据此把它画成不可折叠的一行）。
 */
describe("folderChoiceTree / folderChoiceTrail：拍平候选 ↔ 树形互转", () => {
  /** 在树里按 path 找节点（顶层目录与它们的子孙都算）。 */
  function findNode(nodes: ReturnType<typeof folderChoiceTree>, path: string): ReturnType<typeof folderChoiceTree>[number] | null {
    for (const node of nodes) {
      if (node.choice.path === path) return node;
      const hit = findNode(node.children, path);
      if (hit) return hit;
    }
    return null;
  }

  beforeEach(async () => {
    testBackend.seed("归档/笔记.md", "# 归档\n");
    testBackend.seed("归档/2024/笔记.md", "# 2024\n");
    testBackend.seed("归档/2024/12/笔记.md", "# 12 月\n");
    testBackend.seed("速记/笔记.md", "# 速记\n");
    await rescanWorkspace();
  });

  it("多个根：根项是「移到根目录」这个目标（没有孩子），其余根就是左栏的顶层目录", () => {
    const roots = folderChoiceTree(folderChoiceList(null));
    // 根项排第一、id 为 null、没有孩子 —— 顶层目录**不是**它的孩子。
    expect(roots[0].choice.id).toBeNull();
    expect(roots[0].children).toHaveLength(0);
    // 其余的根与左栏顶层目录逐项一致（同一份排序，不各排一次）。
    expect(roots.slice(1).map((node) => node.choice.path)).toEqual(
      childFolders(getLibrary(), null).map((folder) => folder.id),
    );
    // 嵌套关系逐层挂对：父 → 子 → 孙。
    const archive = roots.slice(1).find((node) => node.choice.path === "归档");
    expect(archive?.children.map((node) => node.choice.path)).toEqual(["归档/2024"]);
    expect(archive?.children[0].children.map((node) => node.choice.path)).toEqual(["归档/2024/12"]);
  });

  it("树里的候选与拍平列表是**同一批**（不是复制品）：置灰语义原样带过去", () => {
    const choices = folderChoiceList("归档/2024");
    const roots = folderChoiceTree(choices);
    const fromTree: string[] = [];
    const walk = (nodes: ReturnType<typeof folderChoiceTree>) => {
      for (const node of nodes) {
        if (node.choice.id !== null) fromTree.push(node.choice.path);
        walk(node.children);
      }
    };
    walk(roots);
    expect(fromTree).toEqual(choices.filter((choice) => choice.id !== null).map((choice) => choice.path));
    // 置灰的是当前目录那一项，树里那一份也是同一份置灰。
    const dimmed = choices.find((choice) => choice.disabled);
    expect(dimmed?.path).toBe("归档/2024");
    expect(findNode(roots, "归档/2024")?.choice.disabled).toBe(true);
    // 别的项不许被连坐置灰。
    expect(findNode(roots, "归档/2024/12")?.choice.disabled).toBe(false);
  });

  it("没有任何文件夹：只剩根项这一个根、没有孩子（界面据此显示「没有别的文件夹」）", () => {
    const empty = { ...getLibrary(), folders: {} };
    const roots = folderChoiceTree(folderChoiceList(null, empty));
    expect(roots).toHaveLength(1);
    expect(roots[0].choice.id).toBeNull();
    expect(roots[0].children).toHaveLength(0);
  });

  it("祖先链：从顶层到目标逐层给全，正好用来「打开时展开沿途」", () => {
    const trail = folderChoiceTrail(folderChoiceList(null), "归档/2024/12");
    expect(trail.map((choice) => choice.path)).toEqual(["归档", "归档/2024", "归档/2024/12"]);
    // 最后一项就是目标本身（界面据此把它作为初始高亮）。
    expect(trail[trail.length - 1].id).toBe("归档/2024/12");
  });

  it("祖先链：目标是顶层目录时只有它自己；目标不在候选里时给空数组", () => {
    const choices = folderChoiceList(null);
    expect(folderChoiceTrail(choices, "速记").map((choice) => choice.path)).toEqual(["速记"]);
    expect(folderChoiceTrail(choices, "不存在的目录")).toEqual([]);
  });
});
