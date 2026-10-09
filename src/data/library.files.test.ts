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
  autoRenameFromPlaceholder,
  autoRenameOutcomeLog,
  childFolders,
  closeWorkspace,
  createNote,
  deleteFolder,
  flushAll,
  flushMeta,
  folderChoiceList,
  folderChoiceTrail,
  folderChoiceTree,
  getLibrary,
  hasPendingAutoRename,
  moveNote,
  openWorkspace,
  purgeNote,
  renameNote,
  resetAutoRenameHistoryForTests,
  rescanWorkspace,
  restoreNote,
  saveImage,
  setAutoRenameDelayForTests,
  setEditorComposing,
  shouldAutoRename,
  trashNote,
  updateNoteContent,
  type AutoRenameContext,
} from "./library";
import { assetFinalName } from "./assetPaths";
import { DEFAULT_UI } from "./types";
import { patchUi } from "./ui";
import { attachCompositionReporter } from "../components/EditorPane";

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
 * 用户实测（0.5.0）：「重命名完成后，再点击其他地方，文件名又会恢复，或者直接就不修改」。
 *
 * 根因：`title` 是**派生字段** —— `makeNote()` / `refresh()` 都拿
 * `deriveTitle(正文, 文件名)` 现算（`src/lib/utils.ts:61`：正文里第一个标题赢，文件名只是兜底），
 * 而 `renameNote()` 只把新名字写进内存里的 `title`。于是
 *   ① 在编辑器里打字 → `refresh()` → 正文的 H1 把新名字顶回去；
 *   ② 任何一次重扫（桌面端的文件监听、Ctrl+S 手动同步、外部改动）→ `makeNote()` → 同样顶回去。
 * 重扫还会重建整个 `notes`，所以只改内存的写法连「撑到下次重扫」都做不到。
 *
 * 「重命名只改显示名；正文里的一级标题不会被改写」（对话框原话）要成立，新名字就得落成
 * `Note.titleOverride`（`types.ts` 里本来就有这个字段，但从来没人写过它），并且像 `starred`
 * 一样进 `.opennote/state.json`、跟着重命名/移动一起改键，重扫时再挂回去。
 */
describe("重命名改的是显示名，不是「派生标题的一次性覆盖」", () => {
  it("重扫之后不许被正文里的 H1 顶回去（桌面端文件监听 / Ctrl+S 同步都会触发这条）", async () => {
    await renameNote("故事/第一章.md", "改名");
    expect(getLibrary().notes["故事/改名.md"]?.title).toBe("改名");

    await flushMeta();
    await rescanWorkspace();

    expect(getLibrary().notes["故事/改名.md"]?.title).toBe("改名");
  });

  it("在编辑器里打字（refresh）之后也不许被顶回去（「直接就不修改」的那条现场）", async () => {
    await renameNote("故事/第一章.md", "改名");
    updateNoteContent("故事/改名.md", "# 第一章\n又改了一段");
    expect(getLibrary().notes["故事/改名.md"]?.title).toBe("改名");
  });

  it("重开笔记本（state.json）之后仍然是新名字 —— 否则重启一次改名就白做了", async () => {
    await renameNote("故事/第一章.md", "改名");
    await flushMeta();

    await closeWorkspace();
    await openWorkspace(record, { silent: true });

    expect(getLibrary().notes["故事/改名.md"]?.title).toBe("改名");
  });

  it("进回收站再恢复：显示名跟着键走（回收站里那一行也不许变回正文 H1）", async () => {
    await renameNote("故事/第一章.md", "改名");
    await flushMeta();

    await trashNote("故事/改名.md");
    await flushMeta();
    await rescanWorkspace();
    expect(getLibrary().trash[".opennote/trash/故事/改名.md"]?.title).toBe("改名");

    await restoreNote(".opennote/trash/故事/改名.md");
    await flushMeta();
    await rescanWorkspace();
    expect(getLibrary().notes["故事/改名.md"]?.title).toBe("改名");
  });
});

/**
 * 图片**不再跟着笔记搬**（0.4.0 用户裁定：整库共用一个 `.assets/`，git 里只有一个附件目录）。
 *
 * 判据盯的是**用户看得见的那条路径**：正文里那条引用在删除 / 恢复 / 移动之后必须仍然指得到文件。
 * 机制从「搬目录」换成了「按新层数重写前缀」（`rebaseSharedAssetRefs`），
 * 两个方向（进回收站 / 恢复）一起咬：一个方向修了、另一个方向没修 = 没修。
 */
describe("共享 .assets/ 的引用：删除 / 恢复 / 移动时按新层数重写", () => {
  const IMAGE = ".assets/图.png";
  const NOTE = "故事/第一章.md";
  const BODY = "# 第一章\n初稿\n\n![图](../.assets/图.png)\n";
  const LEGACY = "故事/assets/封面.png";

  beforeEach(async () => {
    testBackend.seed(IMAGE, "derived-pixels");
    testBackend.seed(NOTE, BODY);
    await rescanWorkspace();
  });

  it("删除 → 恢复：图留在共享目录、引用加前缀再还原；公共 assets/ 一个字节没动", async () => {
    await trashNote(NOTE);
    const trashed = ".opennote/trash/故事/第一章.md";
    // 图**留在共享目录里**（撤销/删除时删掉它才是真丢，恢复就再也找不回来了）。
    expect(testBackend.files.get(IMAGE)).toBe("derived-pixels");
    // 引用按回收站的层数重算：`.opennote/trash/故事/` 是三层 ⇒ 三条 `../`。
    expect(testBackend.files.get(trashed)).toContain("![图](../../../.assets/图.png)");

    await restoreNote(trashed);
    expect(testBackend.files.get(NOTE)).toBe(BODY);
    expect(testBackend.files.get(IMAGE)).toBe("derived-pixels");
    // 旧数据的图仍留在公共 assets/ 里，**一个字节都不许动**。
    expect(testBackend.files.get(LEGACY)).toBe("pixels");
  });

  it("恢复到一个被占用的名字：引用按**恢复后的最终路径**重算，仍指得到图", async () => {
    await trashNote(NOTE);
    // 原来的名字被别人占了：恢复只能落到 `第一章 2.md`。
    testBackend.seed(NOTE, "# 后来者");
    await rescanWorkspace();

    await restoreNote(".opennote/trash/故事/第一章.md");
    const restored = "故事/第一章 2.md";
    expect(testBackend.files.get(restored)).toBe(BODY);
    expect(testBackend.files.get(IMAGE)).toBe("derived-pixels");
    // 用回收站里的 id 算前缀 → 会留下三条 `../`（指到工作区外，图变裂图）。
    expect(testBackend.files.get(restored)).not.toContain("../../../.assets");
  });

  it("移动到别的目录：引用前缀按新层数重算（跨层才变），图一个字节不动", async () => {
    testBackend.seed("资料/别的.md", "# 别的");
    await rescanWorkspace();
    // 同层移动（故事 → 资料）：前缀不变。
    await moveNote(NOTE, "资料");
    expect(testBackend.files.get("资料/第一章.md")).toContain("![图](../.assets/图.png)");
    expect(testBackend.files.get(IMAGE)).toBe("derived-pixels");

    // 跨层移动（资料/ → 工作区根）：前缀清空。
    await moveNote("资料/第一章.md", null);
    expect(testBackend.files.get("第一章.md")).toContain("![图](.assets/图.png)");
    expect(testBackend.files.get(IMAGE)).toBe("derived-pixels");
  });

  it("移动成功时不报图片告警；重写引用写不进去时**如实报**（不假装成功）", async () => {
    testBackend.seed("资料/别的.md", "# 别的");
    await rescanWorkspace();
    const ok = await moveNote(NOTE, "资料");
    expect(ok.path).toBe("资料/第一章.md");
    expect(ok.assetsWarning).toBeNull();

    // 让「重写引用」这一步写不进去：笔记照样搬到位，但必须有一句如实报告 ——
    // 只说「移动成功」会把「引用还指着旧层数」这件事整个藏起来（而图就是裂的，且不报错）。
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // 让「重写引用」这一步读不到正文（`readOptionalText` → `readText`）：笔记照样搬到位，
    // 但必须有一句如实报告 —— 只说「移动成功」会把「引用还指着旧层数」整个藏起来。
    const read = vi.spyOn(testBackend, "readText").mockRejectedValueOnce(new Error("EIO"));
    const failed = await moveNote("资料/第一章.md", null);
    expect(failed.path).toBe("第一章.md");
    expect(failed.assetsWarning).toContain("第一章.md");
    read.mockRestore();
    warn.mockRestore();
  });

  it("共享目录里别人的图：移动笔记时一个字节都不动", async () => {
    testBackend.seed(".assets/别人的图.png", "someone-elses-pixels");
    testBackend.seed("资料/别的.md", "# 别的");
    await rescanWorkspace();

    const result = await moveNote(NOTE, "资料");
    expect(result.path).toBe("资料/第一章.md");
    expect(testBackend.files.get(".assets/别人的图.png")).toBe("someone-elses-pixels");
    expect(testBackend.files.get(IMAGE)).toBe("derived-pixels");
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
    expect(testBackend.files.get("故事/第一章.md")).toBe(BODY);
  });

  it("彻底删除：只删这篇引用的图，`.assets/` 空了才收目录，回收站不留孤儿", async () => {
    // 别人的图也在同一个共享目录里 —— 永久删除**绝不能**把它一起带走。
    testBackend.seed(".assets/别人的图.png", "someone-elses-pixels");
    await rescanWorkspace();

    await trashNote("故事/第一章.md");
    await purgeNote(".opennote/trash/故事/第一章.md");

    expect(testBackend.files.has(IMAGE)).toBe(false);
    expect(testBackend.files.has(".opennote/trash/故事/第一章.md")).toBe(false);
    // 共享目录还在（里面有别人的图），别人的图逐字节没动。
    expect(testBackend.files.get(".assets/别人的图.png")).toBe("someone-elses-pixels");
  });

  it("彻底删除：`.assets/` 里没有别的文件时，空目录一起收掉（不留空壳）", async () => {
    await trashNote("故事/第一章.md");
    await purgeNote(".opennote/trash/故事/第一章.md");

    expect(testBackend.files.has(IMAGE)).toBe(false);
    // 目录本身也收掉了：不留空壳 `.assets/`（下一次写入会重新建）。
    expect(testBackend.dirs.has(".assets")).toBe(false);
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

/**
 * 编辑器粘贴路径的**字节级复用**（`saveImage`）——语义必须与剪藏落点
 * `allocateAssetPath`（`src/lib/clip/landing.ts`）逐条一致：
 *   1. 目标不存在 → 写它；
 *   2. 目标存在 + 字节相同 → **复用**（不写、不改 mtime）；
 *   3. 目标存在 + 字节不同 → `-2` 让位（**绝不静默覆盖**）。
 *
 * 为什么盯这一条：`saveImage` 原来只认**文件名清单**（`uniquePath`），第二次粘贴同一张图时
 * `assetFinalName` 明明算出了同一个 uuid，却被推成 `X 2.png` —— 与用户「uuid 命名 = 复用」
 * 的裁定直接冲突（调研报告 §1.4）。
 *
 * 这里刻意用**单字节 ASCII** 当附件内容：本文件的 `MemoryBackend` 是文本后端
 * （`readBytes` 经 UTF-8 往返），非 ASCII 字节会被解码成 U+FFFD 而**改变长度**，那是后端
 * 的局限、不是 `saveImage` 的行为。逐字节保真由 `src/editor/media.test.ts` 的二进制
 * `MemoryBackend` 覆盖（同一批用例，两边一起看）。
 */
describe("saveImage：同一内容复用同一个文件，不同内容绝不互相覆盖", () => {
  const IMAGE = new Uint8Array([65, 66, 67, 68, 69, 70, 71, 72]);

  function pngFile(bytes: Uint8Array, name = "截图.png"): File {
    return new File([bytes as unknown as BlobPart], name, { type: "image/png" });
  }

  beforeEach(async () => {
    testBackend = new MemoryBackend();
    await openWorkspace(record, { silent: true });
  });

  afterEach(async () => {
    await flushAll();
    await flushMeta();
    vi.restoreAllMocks();
  });

  it("同一内容连粘两次 → 只留一个文件，第二次复用同一个路径（不重写）", async () => {
    const first = await saveImage(pngFile(IMAGE), "截图.png", "归档/备注.md");
    const second = await saveImage(pngFile(IMAGE), "截图.png", "归档/备注.md");

    expect(second.path).toBe(first.path);
    expect(second.markdown).toBe(first.markdown);
    const shared = [...testBackend.files.keys()].filter((path) => path.startsWith(".assets/"));
    expect(shared).toEqual([`.assets/${await assetFinalName(IMAGE, "截图.png")}`]);
  });

  it("不同内容同名 → 按 `-2` 让位，两份字节都在（先到的那份一个字节没动）", async () => {
    const candidate = `.assets/${await assetFinalName(IMAGE, "图.png")}`;
    testBackend.seed(candidate, "先到的那份（内容不同）");

    const saved = await saveImage(pngFile(IMAGE, "图.png"), "图.png", "归档/备注.md");

    expect(saved.path).toBe(candidate.replace(/\.png$/, "-2.png"));
    expect(testBackend.files.get(candidate)).toBe("先到的那份（内容不同）");
    expect([...(testBackend.files.get(saved.path) as Uint8Array)]).toEqual([...IMAGE]);
  });
});

/* ===== 占位名笔记的「正文标题停笔 5 秒落盘」 ===== */
/** 停笔窗口：25ms 足够区分「同一拍里重排」与「两次独立触发」，又不拖慢测试。 */
const DELAY = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 磁盘上的**笔记**文件名（`.opennote/` 里的状态、历史快照不算「文件名」）。
 *
 * 排除 `故事/`：本文件顶层的 `beforeEach` 会种下 `故事/第一章.md`、`故事/子目录/第二章.md`
 * 与 `故事/assets/封面.png`（那是共享 `.assets/` 那组用例的夹具）。这里只关心本段自己
 * 种下去的那些占位名笔记，不然每一条断言都要跟着别人的夹具改。
 */
function placeholderFileNames(): string[] {
  return [...testBackend.files.keys()]
    .filter((path) => !path.startsWith(".opennote/") && !path.startsWith("故事/"))
    .sort();
}

/** 轮询到 `check()` 为真（或超时）—— 定时器 + 异步 `move` 的落地时刻不由测试决定。 */
async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error(`等待超时；磁盘上是 ${JSON.stringify(placeholderFileNames())}`);
}

/** 等「自动改名真的落过一次盘」：拿自动改名读数当证据，不用猜文件名。 */
async function renamedCount(): Promise<number> {
  return autoRenameOutcomeLog().filter((entry) => entry.status === "renamed").length;
}

/**
 * `shouldAutoRename` 的基线上下文：**其余条件全部满足**，逐条用例只改一个字段。
 *
 * 为什么要有它：判定有十几条，散落的字面量一旦漏字段就会在 `tsc` 里红一片、
 * 或者更糟 —— 悄悄测成了别的分支。基线只描述「一篇正常的占位名笔记、刚写完标题」。
 */
function autoRenameCtx(overrides: Partial<AutoRenameContext> = {}): AutoRenameContext {
  const now = Date.now();
  return {
    id: "无标题.md",
    stem: "无标题",
    placeholderOrigin: true,
    content: "## 修改提示词\n",
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
    ...overrides,
  };
}

async function renameCount(from: string): Promise<number> {
  return testBackend.calls.filter((call) => call.startsWith(`move:${from}->`)).length;
}

/**
 * 本段复用文件顶部的 `beforeEach`（新建 MemoryBackend + `openWorkspace`）与
 * `afterEach`（`flushAll` / `flushMeta`），只额外把「停笔窗口」缩短 —— 真实 5 秒
 * 不可能塞进单测，而窗口的语义（窗口内再敲字 = 取消 + 重排）由 `scheduleAutoRename`
 * 的 `clearTimeout` 保证。`closeWorkspace()` 在 `resetWorkspaceTransients()` 里
 * 复位成默认值，所以不担心污染别的用例。
 */
beforeEach(() => {
  setAutoRenameDelayForTests(DELAY);
});

describe("占位名笔记停笔 5 秒自动改名：入口条件只有占位名", () => {
  it("★ 非占位名笔记写标题：文件名一格不动、零 move（真实笔记本 476 篇走的都是这条）", async () => {
    testBackend.seed("系统设计.md", "# 旧标题\n");
    await rescanWorkspace();
    updateNoteContent("系统设计.md", "# 全新标题\n");
    await sleep(DELAY * 4);
    await flushAll();

    expect(placeholderFileNames()).toEqual(["系统设计.md"]);
    expect(await renameCount("系统设计.md")).toBe(0);
    expect(hasPendingAutoRename("系统设计.md")).toBe(false);
  });

  it("占位名笔记写 H1：停笔后磁盘文件名跟着标题走", async () => {
    testBackend.seed("无标题.md", "");
    await rescanWorkspace();
    updateNoteContent("无标题.md", "# 修改提示词\n\n正文");
    await waitFor(() => testBackend.files.has("修改提示词.md"));

    expect(testBackend.files.get("修改提示词.md")).toBe("# 修改提示词\n\n正文");
    expect(testBackend.files.has("无标题.md")).toBe(false);
  });

  it("带序号变体（`无标题 2.md` / `未命名.md`）同样触发", async () => {
    testBackend.seed("无标题 2.md", "");
    testBackend.seed("未命名.md", "");
    await rescanWorkspace();
    updateNoteContent("无标题 2.md", "## 恋爱模拟器综合设计\n");
    updateNoteContent("未命名.md", "## 恋爱模拟器设计提示词\n");
    await waitFor(() => testBackend.files.has("恋爱模拟器综合设计.md") && testBackend.files.has("恋爱模拟器设计提示词.md"));
  });

  it("`无标题 副本.md` 不是占位名（正则要求 `\\s\\d+`）—— 创建副本的产物不许被改名", async () => {
    testBackend.seed("无标题 副本.md", "# 原笔记标题\n");
    await rescanWorkspace();
    updateNoteContent("无标题 副本.md", "# 原笔记标题\n\n加一段");
    await sleep(DELAY * 4);
    await flushAll();

    expect(testBackend.files.has("无标题 副本.md")).toBe(true);
    expect(await renameCount("无标题 副本.md")).toBe(0);
  });

  it("只保留扩展名：`.txt` 笔记改名后仍是 `.txt`", async () => {
    testBackend.seed("未命名.txt", "");
    await rescanWorkspace();
    updateNoteContent("未命名.txt", "# 会议记录\n");
    await waitFor(() => testBackend.files.has("会议记录.txt"));
    expect(testBackend.files.has("未命名.txt")).toBe(false);
  });
});

describe("derivePlaceholderTitle 的落地语义（认 H1–H6，扫不到就什么都不做）", () => {
  it("H1–H6 每一级都能落地（用户 5 篇占位笔记里 H1 为 0，只认 H1 等于功能没做）", async () => {
    for (const level of [1, 2, 3, 4, 5, 6]) {
      testBackend.seed("无标题.md", "");
      await rescanWorkspace();
      updateNoteContent("无标题.md", `${"#".repeat(level)} 第${level}级标题\n`);
      await waitFor(() => testBackend.files.has(`第${level}级标题.md`));
      expect(testBackend.files.has("无标题.md")).toBe(false);
      testBackend.files.delete(`第${level}级标题.md`);
    }
  });

  it("★ 全文只有一行图片 → 空操作（绝不产出 `3f1c9589….png.md` 这种垃圾名）", async () => {
    testBackend.seed("无标题.md", "![3f1c9589f284944860bef0e22aecc5b0_720.png](.assets/ac44629b-1.png)\n");
    await rescanWorkspace();
    updateNoteContent("无标题.md", "![3f1c9589f284944860bef0e22aecc5b0_720.png](.assets/ac44629b-1.png)\n\n");
    await sleep(DELAY * 4);
    await flushAll();

    expect(placeholderFileNames()).toEqual(["无标题.md"]);
    expect(await renameCount("无标题.md")).toBe(0);
  });

  it("空文件（0 字节）→ 空操作", async () => {
    testBackend.seed("无标题.md", "");
    await rescanWorkspace();
    updateNoteContent("无标题.md", "\n");
    await sleep(DELAY * 4);
    await flushAll();

    expect(placeholderFileNames()).toEqual(["无标题.md"]);
  });

  it("标题洗成 fallback（`# ///`）→ 空操作（不改成 `无标题.md`，更不改成 `未命名.md`）", async () => {
    testBackend.seed("无标题.md", "");
    await rescanWorkspace();
    updateNoteContent("无标题.md", "# ///\n正文\n");
    await sleep(DELAY * 4);
    await flushAll();

    expect(placeholderFileNames()).toEqual(["无标题.md"]);
  });

  it("正文首行是普通段落、后面才有真标题 → 用真标题（不是首行）", async () => {
    testBackend.seed("无标题.md", "");
    await rescanWorkspace();
    updateNoteContent("无标题.md", "随便写一句\n\n## 真标题在下面\n");
    await waitFor(() => testBackend.files.has("真标题在下面.md"));
  });
});

describe("改名走独立路径：不写 titleOverride，通道不会被永久锁死", () => {
  it("★ 第一次自动改名后 `titleOverride` 仍为 null，第二次改标题文件名还会跟随", async () => {
    testBackend.seed("无标题.md", "");
    await rescanWorkspace();

    updateNoteContent("无标题.md", "## 会议记录\n");
    await waitFor(() => testBackend.files.has("会议记录.md"));
    // 不写 override：否则 `refresh()` 的 `titleOverride ?? deriveTitle(...)` 会把通道锁死。
    expect(getLibrary().notes["会议记录.md"]?.titleOverride).toBeNull();
    expect(getLibrary().notes["会议记录.md"]?.title).toBe("会议记录");

    // 第二次改标题：文件名必须**再跟一次**（复用 `renameNote()` 的实现会在这里失败）。
    // 30 秒节流由下一条用例单独咬（真实语义就是「同篇 30 秒内不再改」）。
    resetAutoRenameHistoryForTests();
    updateNoteContent("会议记录.md", "## 会议记录 2026\n");
    await waitFor(() => testBackend.files.has("会议记录 2026.md"));
    expect(getLibrary().notes["会议记录 2026.md"]?.titleOverride).toBeNull();
    expect(testBackend.files.has("会议记录.md")).toBe(false);
  });

  it("自动改名不写 `titlePinnedAt`（state.json 里只有用户手定的名字才进这张表）", async () => {
    testBackend.seed("无标题.md", "");
    await rescanWorkspace();
    updateNoteContent("无标题.md", "## 会议记录\n");
    await waitFor(() => testBackend.files.has("会议记录.md"));

    await flushMeta();
    const state = JSON.parse(testBackend.files.get(".opennote/state.json") as string) as Record<string, unknown>;
    expect(state.titlePinnedAt).toBeUndefined();
    expect(state.titleOverrides).toBeUndefined();
  });

  it("改名后计时器按**新路径**重挂：改名落定之后再打字，第二次改名仍然发生", async () => {
    testBackend.seed("无标题.md", "");
    await rescanWorkspace();

    updateNoteContent("无标题.md", "## 第一版\n");
    await waitFor(() => testBackend.files.has("第一版.md"));
    // 第一次改名落定 ⇒ 30 秒节流开始计时（真实语义见下一条用例）。这里显式声明
    // 「这 30 秒已经过去」，才能验证「改名之后计时器挂在新路径上」这一条。
    resetAutoRenameHistoryForTests();

    // 对新路径再打一次字 = 对新路径重排一次；第二次改名必须发生。
    updateNoteContent("第一版.md", "## 第二版\n");
    await waitFor(() => testBackend.files.has("第二版.md"));

    expect(placeholderFileNames()).toEqual(["第二版.md"]);
  });
});

describe("用户显式命名过的笔记绝不被顶掉", () => {
  it("★ A7b 场景：`renameNote` 之后改正文标题，文件名与显示名都不动", async () => {
    testBackend.seed("无标题.md", "## 系统设计\n");
    await rescanWorkspace();
    await renameNote("无标题.md", "系统设计ABC");
    expect(getLibrary().notes["系统设计ABC.md"]?.title).toBe("系统设计ABC");

    // 改正文标题（`titleOverride` 存在 ⇒ 永久停用自动改名）。
    updateNoteContent("系统设计ABC.md", "## 完全不同的标题\n");
    await sleep(DELAY * 4);
    await flushAll();

    expect(placeholderFileNames()).toEqual(["系统设计ABC.md"]);
    expect(getLibrary().notes["系统设计ABC.md"]?.title).toBe("系统设计ABC");
    expect(getLibrary().notes["系统设计ABC.md"]?.titleOverride).toBe("系统设计ABC");
  });

  it("刚显式重命名过：30 秒静默期由 `shouldAutoRename` 逐条判（纯函数，能精确咬住时间边界）", () => {
    const base = autoRenameCtx({ content: "## 系统设计\n" });
    // 没有任何静默期 → 允许改（其余条件都满足）。
    expect(shouldAutoRename(base)).toBeNull();
    // 刚显式重命名过（本会话时间戳）：静默期内拦掉。
    expect(shouldAutoRename({ ...base, explicitRenamedAt: base.now - 1_000 })).toContain("刚显式重命名过");
    expect(shouldAutoRename({ ...base, explicitRenamedAt: base.now - 29_999 })).toContain("刚显式重命名过");
    expect(shouldAutoRename({ ...base, explicitRenamedAt: base.now - 30_000 })).toBeNull();
    // `state.json` 里持久化的 pin 同样算静默期（重开笔记本之后也拦得住）。
    expect(shouldAutoRename({ ...base, pinnedAt: base.now - 1_000 })).toContain("刚显式重命名过");
    expect(shouldAutoRename({ ...base, pinnedAt: base.now - 30_000 })).toBeNull();
    // 两张表取**更晚**的那个。
    expect(shouldAutoRename({ ...base, explicitRenamedAt: base.now - 40_000, pinnedAt: base.now - 5_000 })).toContain(
      "刚显式重命名过",
    );
  });

  it("待执行的自动改名被显式重命名取消：不会在用户点完重命名后又搬一次文件", async () => {
    testBackend.seed("无标题.md", "");
    await rescanWorkspace();
    updateNoteContent("无标题.md", "## 自动算出来的名字\n");
    // 定时器还没到点，用户先自己改了名。
    await renameNote("无标题.md", "我自己起的名字");
    await sleep(DELAY * 4);
    await flushAll();

    expect(placeholderFileNames()).toEqual(["我自己起的名字.md"]);
    expect(await renameCount("无标题.md")).toBe(1);
  });
});

describe("5 秒防抖 = 取消 + 重排（不是并发两个改名）", () => {
  it("窗口内再敲字：计时器重排、文件名只在最后一次内容上落定", async () => {
    testBackend.seed("无标题.md", "");
    await rescanWorkspace();

    updateNoteContent("无标题.md", "# 一");
    await sleep(DELAY / 2);
    expect(testBackend.files.has("一.md")).toBe(false);

    updateNoteContent("无标题.md", "# 一二");
    await sleep(DELAY / 2);
    expect(testBackend.files.has("一二.md")).toBe(false);

    updateNoteContent("无标题.md", "# 一二三");
    await waitFor(() => testBackend.files.has("一二三.md"));

    // 全程只搬了一次，中间那两个名字一次都没落盘。
    expect(placeholderFileNames()).toEqual(["一二三.md"]);
    expect(await renameCount("无标题.md")).toBe(1);
  });

  it("改名途中再敲字：不产生第二个并发 `move`，正文一个字不丢", async () => {
    testBackend.seed("无标题.md", "");
    await rescanWorkspace();
    updateNoteContent("无标题.md", "## 第一版\n");
    await waitFor(() => testBackend.files.has("第一版.md"));
    // 放开 30 秒节流：本用例咬的是「并发」，不是节流。
    resetAutoRenameHistoryForTests();

    // 改名落定后立刻打字：定时器挂在新路径上，窗口内再敲字只会重排。
    updateNoteContent("第一版.md", "## 第二版\n");
    await sleep(DELAY / 2);
    updateNoteContent("第一版.md", "## 第二版\n\n又加了一段\n");
    await waitFor(() => testBackend.files.has("第二版.md"));

    expect(await renameCount("第一版.md")).toBe(1);
    expect(testBackend.files.get("第二版.md")).toBe("## 第二版\n\n又加了一段\n");
    expect(getLibrary().dirty["第一版.md"]).toBeUndefined();
  });
});

describe("抑制条件", () => {
  it("光标停在标题那一行**不再拦截**（真机教训 2026-10-09）：停笔后照常改名，无需任何光标配合", async () => {
    // 自然流程 = 新建 → 打标题 → 停笔，此时光标**必然**还在标题行。曾经有一条
    // 「光标在标题行就不改名」，叠加排定时器时的预检，让功能在主场景里一次都不触发。
    // 判据删除后：没有光标概念，停笔窗口一到就改。
    testBackend.seed("无标题.md", "");
    await rescanWorkspace();

    updateNoteContent("无标题.md", "## 修改提示词\n");
    await waitFor(() => testBackend.files.has("修改提示词.md"));
    expect(testBackend.files.has("无标题.md")).toBe(false);
  });

  it("输入法合成中 → 到点不改名并转入短重试；合成一结束**无需再改内容** → 正常改名", async () => {
    testBackend.seed("无标题.md", "");
    await rescanWorkspace();

    setEditorComposing("无标题.md", true);
    updateNoteContent("无标题.md", "## 修改提示词\n");
    await sleep(DELAY * 4);
    await flushAll();
    expect(placeholderFileNames()).toEqual(["无标题.md"]);

    // 合成结束（compositionend）本身就是停笔的自然终点：数据层会主动重排一次，
    // 不再要求用户「再改一次内容」才触发改名。
    setEditorComposing("无标题.md", false);
    await waitFor(() => testBackend.files.has("修改提示词.md"));
  });

  it("旧布局 `<旧文件名>.assets/` 引用（本机第 3 篇的真实形态）→ 跳过，不裂图", async () => {
    // `项目实战/system_panel/无标题.md` 的正文里有 5 处 `./无标题.assets/image.png`。
    const legacy = "## 修改提示词\n\n![image.png](./无标题.assets/image.png)\n";
    testBackend.seed("无标题.md", legacy);
    await rescanWorkspace();
    updateNoteContent("无标题.md", `${legacy}\n![image 2.png](./无标题.assets/image 2.png)\n`);
    await sleep(DELAY * 4);
    await flushAll();

    expect(placeholderFileNames()).toEqual(["无标题.md"]);
    expect(await renameCount("无标题.md")).toBe(0);
  });

  it("目标名已被占用 → 让位成 `X 2.md`，且 override 仍为 null", async () => {
    testBackend.seed("无标题.md", "");
    testBackend.seed("修改提示词.md", "# 别人的笔记\n");
    await rescanWorkspace();

    updateNoteContent("无标题.md", "## 修改提示词\n");
    await waitFor(() => testBackend.files.has("修改提示词 2.md"));

    expect(testBackend.files.get("修改提示词.md")).toBe("# 别人的笔记\n");
    expect(getLibrary().notes["修改提示词 2.md"]?.titleOverride).toBeNull();
  });

  it("幂等：文件名已经等于标题时，再触发一次不产生 `X 2.md`", async () => {
    testBackend.seed("无标题.md", "");
    await rescanWorkspace();
    updateNoteContent("无标题.md", "## 修改提示词\n");
    await waitFor(() => testBackend.files.has("修改提示词.md"));
    const movesAfterFirst = await renameCount("修改提示词.md");
    const renamesBefore = await renamedCount();

    // 再跑一次执行体：应当被「与当前文件名相同」拦掉，既不搬也不产生 `X 2.md`。
    // （30 秒节流先放开：本用例咬的是「同名空操作」，不是节流。）
    resetAutoRenameHistoryForTests();
    const outcome = await autoRenameFromPlaceholder("修改提示词.md");
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toContain("与当前文件名相同");
    expect(await renameCount("修改提示词.md")).toBe(movesAfterFirst);
    expect(await renamedCount()).toBe(renamesBefore);
    expect(placeholderFileNames()).toEqual(["修改提示词.md"]);
  });

  it("只差大小写 → 走 `moveCaseOnly`，不产生 ` 2.md`", async () => {
    testBackend.seed("无标题.md", "");
    await rescanWorkspace();
    updateNoteContent("无标题.md", "## ABC\n");
    await waitFor(() => testBackend.files.has("ABC.md"));
    // 再改成小写：路径只差大小写，必须原地换名（`uniquePath` 会误判成被自己占用）。
    resetAutoRenameHistoryForTests();
    updateNoteContent("ABC.md", "## abc\n");
    await waitFor(() => testBackend.files.has("abc.md"));

    expect(placeholderFileNames()).toEqual(["abc.md"]);
  });

  it("同一篇笔记两次自动改名之间至少隔 30 秒（文件监听 500ms 抖动防抖）", async () => {
    testBackend.seed("无标题.md", "");
    await rescanWorkspace();
    updateNoteContent("无标题.md", "## 第一版\n");
    await waitFor(() => testBackend.files.has("第一版.md"));

    updateNoteContent("第一版.md", "## 第二版\n");
    await sleep(DELAY * 4);
    await flushAll();
    // 30 秒最小间隔：这一拍不许改（文件名停在第一版，`title` 已经是第二版）。
    expect(placeholderFileNames()).toEqual(["第一版.md"]);
    expect(getLibrary().notes["第一版.md"]?.title).toBe("第二版");
  });
});

describe("真实笔记本 §3 的 5 篇占位文件逐篇形态", () => {
  it("第 1 篇：`AI智能时代/无标题.md` 是 0 字节空文件 → 保持不动", async () => {
    testBackend.seed("AI智能时代/无标题.md", "");
    await rescanWorkspace();
    updateNoteContent("AI智能时代/无标题.md", "");
    await sleep(DELAY * 4);
    await flushAll();
    expect(placeholderFileNames()).toEqual(["AI智能时代/无标题.md"]);
  });

  it("第 2 篇：根目录 `无标题.md` 全文只有一行图片 → 保持不动", async () => {
    const only = "![3f1c9589f284944860bef0e22aecc5b0_720.png](.assets/ac44629b-1.png)";
    testBackend.seed("无标题.md", only);
    await rescanWorkspace();
    updateNoteContent("无标题.md", `${only}\n`);
    await sleep(DELAY * 4);
    await flushAll();
    expect(placeholderFileNames()).toEqual(["无标题.md"]);
  });

  it("第 3 篇：`项目实战/system_panel/无标题.md` 含旧布局引用 → 本次跳过（等附件迁移后才会改）", async () => {
    const body = "## 修改提示词\n\n![image.png](./无标题.assets/image.png)\n";
    testBackend.seed("项目实战/system_panel/无标题.md", body);
    await rescanWorkspace();
    updateNoteContent("项目实战/system_panel/无标题.md", `${body}\n![image 2.png](./无标题.assets/image 2.png)\n`);
    await sleep(DELAY * 4);
    await flushAll();
    expect(placeholderFileNames()).toEqual(["项目实战/system_panel/无标题.md"]);
  });

  it("第 4/5 篇：`项目实战/恋爱模拟器/无标题 2.md` 与 `无标题 3.md`（h2）→ 各自改名", async () => {
    testBackend.seed("项目实战/恋爱模拟器/无标题 2.md", "## 恋爱模拟器综合设计\n");
    testBackend.seed("项目实战/恋爱模拟器/无标题 3.md", "## 恋爱模拟器设计提示词\n");
    await rescanWorkspace();
    updateNoteContent("项目实战/恋爱模拟器/无标题 2.md", "## 恋爱模拟器综合设计\n\n正文\n");
    updateNoteContent("项目实战/恋爱模拟器/无标题 3.md", "## 恋爱模拟器设计提示词\n\n正文\n");
    await waitFor(
      () =>
        testBackend.files.has("项目实战/恋爱模拟器/恋爱模拟器综合设计.md") &&
        testBackend.files.has("项目实战/恋爱模拟器/恋爱模拟器设计提示词.md"),
    );
    expect(testBackend.files.has("项目实战/恋爱模拟器/无标题 2.md")).toBe(false);
    expect(testBackend.files.has("项目实战/恋爱模拟器/无标题 3.md")).toBe(false);
  });

  it("第 6/7 篇（方案定稿之后才出现）：`system_panel/无标题 2.md` 会改、`恋爱模拟器/无标题.md` 不会", async () => {
    // 第 6 篇：`项目实战/system_panel/无标题 2.md`，正文 `## 当前存在问题` → 会改名。
    testBackend.seed("项目实战/system_panel/无标题 2.md", "## 当前存在问题\n");
    // 第 7 篇：`项目实战/恋爱模拟器/无标题.md`，首行是普通段落、正文里没有真标题行 → 不改名。
    testBackend.seed("项目实战/恋爱模拟器/无标题.md", "这一段只是说明，不是标题。\n\n更多说明。\n");
    await rescanWorkspace();

    updateNoteContent("项目实战/system_panel/无标题 2.md", "## 当前存在问题\n\n正文\n");
    updateNoteContent("项目实战/恋爱模拟器/无标题.md", "这一段只是说明，不是标题。\n\n更多说明。\n");
    await waitFor(() => testBackend.files.has("项目实战/system_panel/当前存在问题.md"));
    await sleep(DELAY * 4);
    await flushAll();

    // 第 7 篇一动不动（首行不当标题 —— 这正是「垃圾名」那条护栏）。
    expect(testBackend.files.has("项目实战/恋爱模拟器/无标题.md")).toBe(true);
    expect(testBackend.files.has("项目实战/恋爱模拟器/这一段只是说明，不是标题。.md")).toBe(false);
  });
});

/* ===== 复核 R1：重命名撞名时写进 titleOverride 的必须是**落盘名** ===== */

describe("重命名撞名：写进 titleOverride 的是落盘名（方案 §7.1 指定断言）", () => {
  it("同目录已有「系统设计.md」时，重命名后 title 与 titleOverride 都等于「系统设计 2」", async () => {
    testBackend.seed("系统设计.md", "# 别人的笔记\n");
    testBackend.seed("无标题.md", "## 系统设计\n");
    await rescanWorkspace();

    await renameNote("无标题.md", "系统设计");

    // 落盘名让位成 `系统设计 2.md`：显示名必须跟着**落盘名**，不能停在请求名上。
    expect(testBackend.files.has("系统设计 2.md")).toBe(true);
    expect(getLibrary().notes["系统设计 2.md"]?.title).toBe("系统设计 2");
    expect(getLibrary().notes["系统设计 2.md"]?.titleOverride).toBe("系统设计 2");
    // 别人的笔记一个字节没动。
    expect(testBackend.files.get("系统设计.md")).toBe("# 别人的笔记\n");

    // 落盘：`state.json` 里那条 override 也是落盘名 —— 否则重扫之后显示名会变回「系统设计」，
    // 与磁盘上的 `系统设计 2.md` 永久分叉（这正是 R1 描述的静默分叉）。
    await flushMeta();
    const state = JSON.parse(testBackend.files.get(".opennote/state.json") as string) as Record<string, unknown>;
    expect((state.titleOverrides as Record<string, string>)["系统设计 2.md"]).toBe("系统设计 2");

    await rescanWorkspace();
    expect(getLibrary().notes["系统设计 2.md"]?.title).toBe("系统设计 2");
  });
});

/* ===== 复核 R2：`autoTitleFromPlaceholder` 开关（默认开、可关） ===== */

describe("设置开关 autoTitleFromPlaceholder：默认开、可关", () => {
  it("默认值是 true（旧 localStorage 缺这个键时 `{ ...DEFAULT_UI, ...parsed }` 也落到 true）", () => {
    expect(DEFAULT_UI.autoTitleFromPlaceholder).toBe(true);
  });

  it("关掉之后 `shouldAutoRename` 直接返回「设置里已关闭自动改名」（其余条件全部满足也不改）", () => {
    expect(shouldAutoRename(autoRenameCtx())).toBeNull();
    expect(shouldAutoRename(autoRenameCtx({ autoTitleFromPlaceholder: false }))).toBe("设置里已关闭自动改名");
  });

  it("关掉之后占位名笔记不再自动改名；重新打开后同一个内容再触发一次就跟随", async () => {
    testBackend.seed("无标题.md", "");
    await rescanWorkspace();

    patchUi({ autoTitleFromPlaceholder: false });
    try {
      updateNoteContent("无标题.md", "## 修改提示词\n");
      await sleep(DELAY * 4);
      await flushAll();
      expect(placeholderFileNames()).toEqual(["无标题.md"]);
      expect(hasPendingAutoRename("无标题.md")).toBe(false);

      patchUi({ autoTitleFromPlaceholder: true });
      updateNoteContent("无标题.md", "## 修改提示词\n\n正文\n");
      await waitFor(() => testBackend.files.has("修改提示词.md"));
    } finally {
      // 开关是模块级 uiStore，不能漏回默认值去污染同文件里的其他用例。
      patchUi({ autoTitleFromPlaceholder: true });
    }
  });
});

/* ===== 复核 R5：回收站往返不丢「占位名出身」 ===== */

describe("回收站往返不丢「占位名出身」（R5）", () => {
  it("createNote → trashNote → restoreNote → 写标题 → 停笔后改名", async () => {
    const created = createNote({ title: "无标题", content: "" });
    await flushAll();
    expect(testBackend.files.has(created.id)).toBe(true);

    await trashNote(created.id);
    // 真实桌面端在回收站里必然至少重扫一次（文件监听 500ms）—— 显式走一遍，
    // 因为「重扫会不会把出身标记丢掉」正是这条缺陷的关键。
    await rescanWorkspace();
    const trashed = Object.keys(getLibrary().trash)[0];
    expect(trashed).toContain(".opennote/trash/");

    await restoreNote(trashed);
    await rescanWorkspace();
    expect(Object.keys(getLibrary().notes)).toContain(created.id);

    // 重扫把 `createdAt` 换成磁盘 mtime（MemoryBackend 恒为 1）⇒ 绕开「新建 10 秒静默期」，
    // 本用例咬的是「回收站往返之后还能不能自动改名」。
    updateNoteContent(created.id, "## 还原之后写的标题\n");
    await waitFor(() => testBackend.files.has("还原之后写的标题.md"));
    expect(testBackend.files.has(created.id)).toBe(false);
  });

  it("已经被自动改名过的笔记：进回收站再还原后仍然跟随正文标题（出身标记不丢）", async () => {
    testBackend.seed("无标题.md", "");
    await rescanWorkspace();

    updateNoteContent("无标题.md", "## 修改提示词\n");
    await waitFor(() => testBackend.files.has("修改提示词.md"));
    // 名字已经不是占位名了：这时「出身」只存在于内存的那张表里，最容易在搬键时丢掉。
    expect(getLibrary().notes["修改提示词.md"]?.titleOverride).toBeNull();

    await trashNote("修改提示词.md");
    await rescanWorkspace();
    const trashed = Object.keys(getLibrary().trash)[0];
    await restoreNote(trashed);
    await rescanWorkspace();
    expect(Object.keys(getLibrary().notes)).toContain("修改提示词.md");

    // 30 秒节流与显式重命名静默期不是本用例要咬的东西（它们各有自己的用例）。
    resetAutoRenameHistoryForTests();
    updateNoteContent("修改提示词.md", "## 修改提示词 2026\n");
    await waitFor(() => testBackend.files.has("修改提示词 2026.md"));
  });
});

/* ===== 复核 R6：导入 / 剪藏的静默期口径 = 「复用新建 10 秒」 ===== */

describe("导入 / 剪藏的静默期：复用「新建 10 秒」（方案 §2.5 口径）", () => {
  it("刚落盘的笔记（`createdAt` 就是刚刚）在窗口内不动；窗口过去后同一篇会跟随", async () => {
    // 导入 / 剪藏落盘后的现场：文件名是 fallback（`未命名.md`），正文里已经有标题。
    const imported = createNote({ title: "未命名", content: "" });
    await flushAll();

    updateNoteContent(imported.id, "# 导入带来的正文标题\n");
    await sleep(DELAY * 4);
    await flushAll();
    expect(testBackend.files.has("导入带来的正文标题.md")).toBe(false);
    expect(testBackend.files.has(imported.id)).toBe(true);

    // 时间过去（重扫把 `createdAt` 换成磁盘 mtime）：同一个内容再触发一次就改名。
    await rescanWorkspace();
    updateNoteContent(imported.id, "# 导入带来的正文标题\n\n正文\n");
    await waitFor(() => testBackend.files.has("导入带来的正文标题.md"));
  });

  it("纯函数：`createdAt` 就是此刻 ⇒ 被「新建笔记静默期（10 秒）」拦下；过了 10 秒放行", () => {
    const now = Date.now();
    expect(shouldAutoRename(autoRenameCtx({ createdAt: now, now }))).toBe("新建笔记静默期（10 秒）");
    expect(shouldAutoRename(autoRenameCtx({ createdAt: now - 10_000, now }))).toBe("新建笔记静默期（10 秒）");
    expect(shouldAutoRename(autoRenameCtx({ createdAt: now - 10_001, now }))).toBeNull();
  });
});

/* ===== 复核 R10：目标路径上残留 titlePinnedAt 的防御分支 ===== */

describe("防御分支：目标路径上残留的 titlePinnedAt 会被清掉（R10）", () => {
  it("手工塞一个 pin 在目标路径上 → 自动改名之后 meta.titlePinnedAt 被清掉", async () => {
    testBackend.seed("无标题.md", "## 修改提示词\n");
    // 造一个「pin 存在、但没有 override」的坏状态（手改过 state.json 的现场）——
    // 正常路径到不了这里，所以只能这样把那条防御分支逼出来。
    await closeWorkspace();
    testBackend.seed(
      ".opennote/state.json",
      `${JSON.stringify(
        {
          version: 1,
          starred: [],
          expanded: [],
          lastOpened: null,
          titlePinnedAt: { "修改提示词.md": Date.now() - 5 * 60_000 },
        },
        null,
        2,
      )}\n`,
    );
    await openWorkspace(record, { silent: true });
    setAutoRenameDelayForTests(DELAY);

    updateNoteContent("无标题.md", "## 修改提示词\n\n正文\n");
    await waitFor(() => testBackend.files.has("修改提示词.md"));

    await flushMeta();
    const state = JSON.parse(testBackend.files.get(".opennote/state.json") as string) as Record<string, unknown>;
    // 残留的 pin 被清掉：否则它会把这篇笔记之后的自动改名按 30 秒静默期一直拦住。
    expect(state.titlePinnedAt).toBeUndefined();
    // 自动改名仍然不写 override（这是 t7 的阻断级约束，这里顺手再咬一次）。
    expect(state.titleOverrides).toBeUndefined();
  });
});

/* ===== 复核 R7：编辑器宿主的 IME composition 接线（DOM 层） ===== */

/**
 * 为什么这条 DOM 层用例放在这个文件里：本轮 in-scope 的文件清单里没有给
 * `src/components/EditorPane.test.ts` 留位置（只有 `EditorPane.tsx` 本身），
 * 所以它寄居在库侧测试文件里，用一个只属于它的 describe 段隔开。
 * 用的是 Node 自带的 `EventTarget` / `Event`，不引第三方 DOM 实现。
 */
describe("编辑器宿主的 IME composition 接线（DOM 层，R7）", () => {
  it("compositionstart / compositionend → onComposing(true/false)，只在变化时上报，退订补报 false", () => {
    const host = new EventTarget();
    const seen: boolean[] = [];
    const detach = attachCompositionReporter(host, (composing) => seen.push(composing));

    host.dispatchEvent(new Event("compositionstart"));
    host.dispatchEvent(new Event("compositionstart")); // 重复的开始事件不该重复上报
    host.dispatchEvent(new Event("compositionend"));
    host.dispatchEvent(new Event("compositionend"));
    expect(seen).toEqual([true, false]);

    // 合成中卸载（换笔记 / 编辑器销毁）：必须补报一次 false，
    // 否则那篇笔记会被一条永远为真的合成状态卡住自动改名。
    host.dispatchEvent(new Event("compositionstart"));
    detach();
    expect(seen).toEqual([true, false, true, false]);

    // 退订之后事件不再上报。
    host.dispatchEvent(new Event("compositionend"));
    expect(seen).toEqual([true, false, true, false]);
  });

  it("合成状态真的会传到数据层：`setEditorComposing(true)` 期间不改名（端到端咬一口）", async () => {
    testBackend.seed("无标题.md", "");
    await rescanWorkspace();

    const host = new EventTarget();
    const detach = attachCompositionReporter(host, (composing) => setEditorComposing("无标题.md", composing));
    host.dispatchEvent(new Event("compositionstart"));
    updateNoteContent("无标题.md", "## 修改提示词\n");
    await sleep(DELAY * 4);
    await flushAll();
    expect(placeholderFileNames()).toEqual(["无标题.md"]);

    host.dispatchEvent(new Event("compositionend"));
    detach();
    updateNoteContent("无标题.md", "## 修改提示词\n\n正文\n");
    await waitFor(() => testBackend.files.has("修改提示词.md"));
  });
});
