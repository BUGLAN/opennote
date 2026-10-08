/**
 * 导入路径的附件落点（Lead 本轮裁定，三条一起看才没有歧义）：
 *
 * 1. **zip 导入 = 旧数据不动**：zip 里的正文是外部给的，写的就是旧写法 `./assets/x.png`，
 *    那些图按公共 `<目录>/assets/` 原样落地，正文**不改写**成共享 `.assets/`
 *    （「不迁移旧数据」的直接推论；半改会比不改更坏 —— 正文与磁盘会各说一套）。
 * 2. **独立导入一张图片 = 裸附件**：没有笔记就没有「笔记名」这个事实，不许凭空造一个
 *    `<图片名>.assets/`（那会造出「暗示存在同名笔记」的目录）。这是公共 `assets/` 的
 *    **唯一例外** —— 所以同一条用例必须同时证明「编辑器粘贴的图不走这条路」。
 * 3. **`asset://` 老数据迁移 = 我们自己生成的引用**：图是我们写的、正文引用是我们改的，
 *    必须跟新约定（共享 `.assets/` + 内容派生 uuid）；同一个 assetId 在两篇笔记里各写一份
 *    （附件目录按笔记名派生，跨笔记共用一份缓存会让第二篇的引用指到第一篇的目录里）。
 *
 * 判据盯用户看得见的路径：磁盘上哪个文件在哪、正文里的相对引用能不能解析回它。
 */

import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LegacyFolder, LegacyNote } from "../data/legacy";
import type { WorkspaceRecord } from "../data/workspaces";
import { MemoryBackend } from "../lib/clip/testing/memoryBackend";
import { assetFinalName } from "../lib/clip/landing";

let testBackend: MemoryBackend;
let legacyNotes: LegacyNote[] = [];
let legacyFolders: LegacyFolder[] = [];
let legacyAssets = new Map<string, Blob>();

vi.mock("../data/workspaces", () => ({
  activeWorkspaceRecord: () => null,
  resolveBackend: async () => testBackend,
  setActiveWorkspace: () => undefined,
}));

vi.mock("../data/legacy", () => ({
  hasLegacyData: async () => legacyNotes.length > 0,
  readLegacyNotes: async () => ({ notes: legacyNotes, folders: legacyFolders }),
  getLegacyAsset: async (id: string) => legacyAssets.get(id) ?? null,
}));

import { openWorkspace, flushAll, flushMeta } from "../data/library";
import { insertFileSnippets } from "../editor/media";
import { importIntoWorkspace, migrateLegacyData } from "./import";

const record: WorkspaceRecord = {
  id: "test",
  name: "临时笔记本",
  kind: "node",
  location: "unused",
  addedAt: 1,
  lastOpenedAt: 1,
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const OTHER_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]);

function imageFile(name: string, bytes = PNG): File {
  return new File([bytes as unknown as BlobPart], name, { type: "image/png" });
}

/** 内存里现造一个 zip（用真实的 JSZip，不用假对象）。 */
async function zipFile(name: string, entries: Record<string, string | Uint8Array>): Promise<File> {
  const zip = new JSZip();
  for (const [path, value] of Object.entries(entries)) zip.file(path, value);
  const bytes = await zip.generateAsync({ type: "uint8array" });
  return new File([bytes as unknown as BlobPart], name, { type: "application/zip" });
}

/** 工作区里所有「不是笔记/不是附件」的路径（`.opennote/` 之外的全部文件）。 */
function workspacePaths(): string[] {
  return testBackend.paths().filter((path) => !path.startsWith(".opennote/"));
}

function assetsPaths(): string[] {
  return workspacePaths().filter((path) => path === "assets" || path.startsWith("assets/") || path.includes("/assets/"));
}

beforeEach(async () => {
  testBackend = new MemoryBackend();
  legacyNotes = [];
  legacyFolders = [];
  legacyAssets = new Map();
  await openWorkspace(record, { silent: true });
});

afterEach(async () => {
  await flushAll();
  await flushMeta();
  vi.restoreAllMocks();
});

describe("zip 导入：旧布局原样落地（正文写着 ./assets/，就不改写成 .assets/）", () => {
  it("图进公共 <目录>/assets/，旧图一个字节不动，同名的新图被改名且正文引用跟着改", async () => {
    // 夹具：公共 `assets/` 里先有一张「旧世界」的图 —— 它必须一个字节都不动。
    testBackend.seedBytes("assets/图片.png", OTHER_PNG);
    const zip = await zipFile("导出.zip", {
      "备注.md": "# 备注\n\n![图](./assets/图片.png)\n",
      "assets/图片.png": PNG,
    });

    const result = await importIntoWorkspace([zip], null);

    expect(result.notes).toBe(1);
    expect(result.attachments).toBe(1);
    // ① 旧数据不动（同名，但字节不同 ⇒ 绝不静默覆盖）。
    expect(testBackend.bytes("assets/图片.png")).toEqual(OTHER_PNG);
    // ② 新图落**同一个公共目录**，同名去重成 `图片 2.png`。
    expect(testBackend.files.has("assets/图片 2.png")).toBe(true);
    expect(testBackend.bytes("assets/图片 2.png")).toEqual(PNG);
    // ③ 正文引用被改写到实际落点（`handleZip` 的改写循环没动过）。
    const text = testBackend.text("备注.md");
    expect(text).toContain("![图](./assets/图片 2.png)");
    // ④ 这条路径**不产生**共享 `.assets/`：zip 是旧数据，不迁移。
    expect(workspacePaths().some((path) => path.includes(".assets/"))).toBe(false);
  });

  it("导入到别的目录也一样：图与正文都落到**目标**目录，源目录的写法不留在正文里", async () => {
    const zip = await zipFile("导出.zip", {
      "归档/备注.md": "# 备注\n\n![图](./assets/图片.png)\n",
      "归档/assets/图片.png": PNG,
    });

    // 根目录下的 `收件` 不存在也不要紧：它是 Id，落盘时按路径创建（mkdircSync）。
    const result = await importIntoWorkspace([zip], "收件");

    expect(result.notes).toBe(1);
    const notePath = workspacePaths().find((path) => path.endsWith("备注.md"));
    expect(notePath, `没找到导入的笔记：${workspacePaths().join(", ")}`).toBe("收件/归档/备注.md");
    // 图跟着笔记落到**目标**目录的公共 assets/，不是留在源目录结构里。
    expect(testBackend.files.has("收件/归档/assets/图片.png")).toBe(true);
    const text = testBackend.text(notePath!);
    expect(text).toContain("![图](./assets/图片.png)");
    expect(text).not.toContain("归档/assets/图片.png");
  });
});

describe("独立导入一张图片：公共 assets/ 的唯一例外，且只此一处", () => {
  it("没有笔记的裸附件落公共 <目标目录>/assets/；编辑器粘贴的图同一时刻进共享 `.assets/`", async () => {
    const result = await importIntoWorkspace([imageFile("散图.png")], null);

    expect(result.attachments).toBe(1);
    expect(testBackend.files.has("assets/散图.png")).toBe(true);
    // 裸附件没有笔记可依附 ⇒ 不进共享附件目录（那是**笔记的**图片的家）。
    expect(workspacePaths().some((path) => path.startsWith(".assets/"))).toBe(false);

    // 同一条用例的另一半：有笔记的图**不走**这条路径 ——
    // 否则这就不是「唯一例外」，而是「半个例外」。
    const snippets = await insertFileSnippets([imageFile("笔记图.png", OTHER_PNG)], {
      notePath: "归档/备注.md",
      imageMode: "asset",
      notify: () => undefined,
    });
    const asset = await assetFinalName(OTHER_PNG, "笔记图.png");
    // 笔记在 `归档/` 下一层 ⇒ 一条 `../`；共享目录与 uuid 名都不含空格。
    expect(snippets).toEqual([`![笔记图.png](../.assets/${asset})`]);
    expect(testBackend.files.has(`.assets/${asset}`)).toBe(true);
    // 公共 assets/ 里仍然**只有**裸附件那一个文件（编辑器一个字节都没往公共目录写）。
    expect(assetsPaths()).toEqual(["assets/散图.png"]);
  });
});

describe("asset:// 老数据迁移：我们自己生成的引用跟新约定走", () => {
  it("图落共享 `.assets/`、正文引用指得对；同一个 id 被两篇笔记引用时**各写一份**", async () => {
    legacyAssets = new Map([["AAAA", new Blob([PNG as unknown as BlobPart])]]);
    legacyFolders = [{ id: "f1", name: "子", parentId: null }];
    legacyNotes = [
      // 同一篇里引用两次：只写一份，两处引用都要被改写。
      { id: "n1", title: "甲", content: "# 甲\n\n![图](asset://AAAA)\n\n再来一次 asset://AAAA\n", folderId: null },
      // 第二篇引用**同一个** assetId：附件目录按笔记名派生 ⇒ 必须各自一份。
      { id: "n2", title: "乙", content: "# 乙\n\n![图](asset://AAAA)\n", folderId: "f1" },
    ];

    const result = await migrateLegacyData();

    expect(result.notes).toBe(2);
    expect(result.attachments).toBe(2);
    // ① 甲（根目录）：同一篇里重复引用只写一份图，两处引用都指到它；根笔记前缀为空。
    expect(testBackend.text("甲.md")).toContain("![图](.assets/legacy-AAAA.png)");
    expect(testBackend.text("甲.md")).not.toContain("asset://");
    expect(testBackend.files.has(".assets/legacy-AAAA.png")).toBe(true);
    // ② 乙（在子目录里，用的是**另一个**落盘名）：前缀是一条 `../`，指回同一个共享目录。
    expect(testBackend.text("子/乙.md")).toContain("![图](../.assets/legacy-AAAA 2.png)");
    expect(testBackend.files.has(".assets/legacy-AAAA 2.png")).toBe(true);
    expect(testBackend.bytes(".assets/legacy-AAAA 2.png")).toEqual(PNG);
    // ③ 这条路径不是「裸附件」，所以公共 assets/ 里一个字节都不许出现。
    expect(assetsPaths()).toEqual([]);
  });

  it("引用解析回该文件：正文里的相对引用 + 笔记所在目录 = 实际落盘路径", async () => {
    legacyAssets = new Map([["BBBB", new Blob([OTHER_PNG as unknown as BlobPart])]]);
    legacyNotes = [{ id: "n1", title: "备注 2", content: "![图](asset://BBBB)\n", folderId: null }];

    await migrateLegacyData();

    const text = testBackend.text("备注 2.md");
    expect(text).toContain("![图](.assets/legacy-BBBB.png)");
    expect(testBackend.files.has(".assets/legacy-BBBB.png")).toBe(true);
  });
});
