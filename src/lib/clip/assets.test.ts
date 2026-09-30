/**
 * L2 接收端 · 图片随笔记落盘（Lead 裁定：`<目录>/foo.md` → `<目录>/foo.assets/`）
 *
 * 这一组只打**这条需求的成败点**：
 * ① 目录按笔记名派生（不是公共 `assets/`）——「只把一篇笔记挪走」时图片才跟得上；
 * ② 正文里的引用是**相对路径**，且 `join(笔记所在目录, ref)` **恰好等于**磁盘上的资产路径；
 * ③ 资产名**不是**路径逃逸入口（`assertSafeRelative` + 复核最终路径）；
 * ④ 重名**可读化去重**，不静默覆盖；
 * ⑤ 撤销时资产与正文一致（要么一起回退，要么如实说明）。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBackend } from "./testing/memoryBackend";
import type { WorkspaceRecord } from "../../data/workspaces";

let testBackend: MemoryBackend;

vi.mock("../../data/workspaces", () => ({
  activeWorkspaceRecord: () => null,
  resolveBackend: async () => testBackend,
  setActiveWorkspace: () => undefined,
}));

vi.mock("../../data/inbox", () => ({
  enqueueInbox: async () => ({ id: "stub", status: "pending", tags: [] }),
  readInboxDetail: async () => {
    throw Object.assign(new Error("没有找到这条导入记录。"), { code: "IMP-4017", userMessage: "没有找到这条导入记录。" });
  },
}));

import { openWorkspace } from "../../data/library";
import { resetImportIndexCache } from "../../data/importLog";
import { parentPath } from "../../fs/paths";
import { assetsDirFor } from "./index";
import { encodeBase64, ImportRejection } from "./envelope";
import { contentHash8 } from "./hash";
import {
  receiveEnvelope,
  resetImportChannelContext,
  resetImportLandingPreference,
  setImportChannelContext,
  setImportLandingPreference,
  setImportNotifications,
  undoImport,
} from "./receive";

const RECORD: WorkspaceRecord = { id: "test", name: "临时笔记本", kind: "node", location: "unused", addedAt: 1, lastOpenedAt: 1 };
const CAPTURED = "2026-09-29T21:04:11+08:00";
const URL_A = "https://example.com/posts/local-first";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x02]);

/** 每次调用一个**新的** importId：同 id 第二次投递会命中幂等（那是另外的用例）。 */
let seq = 0;
function nextId(): string {
  seq += 1;
  return `0f1d6d9a-6c2f-4a7e-9d31-5b0f2a7c1e${String(seq).padStart(2, "0")}`;
}

function raw(overrides: Record<string, unknown> = {}): string {
  // `source` 按**字段合并**（同 `receive.test.ts`）：只写 `{ selection: true }` 时 URL 仍在，
  // 才会走判定链第 3 步（同 URL + 选区 → appended）。
  const source = {
    url: URL_A,
    site: "example.com",
    title: "来源",
    capturedAt: CAPTURED,
    selection: false,
    ...((overrides.source as Record<string, unknown> | undefined) ?? {}),
  };
  return JSON.stringify({
    spec: "opennote.import/v1",
    importId: nextId(),
    title: "测试标题",
    body: "看图：\n\n![图](./assets/diagram.png)\n",
    target: { folder: null, notePath: null },
    tags: ["剪藏"],
    client: { name: "cli", version: "0.3.0" },
    ...overrides,
    source,
    assets: (overrides.assets as unknown[] | undefined) ?? [],
  });
}

const pngAsset = (name = "diagram.png", bytes = PNG) => ({ name, mime: "image/png", dataBase64: encodeBase64(bytes) });

/** 与 Markdown 查看器同构的解析（测试自己写，不借生产代码，免得两处同时错）。 */
function resolveRef(notePath: string, ref: string): string {
  const segments = notePath.split("/").slice(0, -1);
  for (const segment of ref.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

/**
 * 正文里的图片引用（取 `](…)` 里的目标，**剥掉 CommonMark 的角度括号**）。
 *
 * 目标里**允许空格**（笔记名带空格时 `备注 2.assets/x.png` 是合法引用），而带空格的目标
 * 必须写成 `<…>` 形式（`markdownRef` 唯一产地），否则空格会截断链接目标、图片不渲染。
 * 这里剥掉尖括号，让用例继续断言**路径**；「尖括号形式真的能渲染」由
 * `src/editor/media.test.ts` 的 `rendersAsImage()` 用应用自己的渲染器咬。
 */
function imageRefs(markdown: string): string[] {
  return [...markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1].trim().replace(/^<|>$/g, ""));
}

/** 工作区里所有非笔记、非 `.opennote/` 的文件（= 资产）。 */
function assetPaths(): string[] {
  return testBackend.paths().filter((path) => !path.endsWith(".md") && !path.startsWith(".opennote/"));
}

function noteFiles(): string[] {
  return testBackend.paths().filter((path) => path.endsWith(".md") && !path.startsWith(".opennote/"));
}

beforeEach(async () => {
  testBackend = new MemoryBackend();
  seq = 0;
  resetImportIndexCache();
  resetImportChannelContext();
  resetImportLandingPreference();
  setImportNotifications(false);
  await openWorkspace(RECORD, { silent: true });
});

describe("L2 接收端 · 附件目录按笔记名派生（foo.md → foo.assets/）", () => {
  it("落盘在笔记同级、`<笔记名>.assets/` 下，正文引用是相对路径且能解析回该文件", async () => {
    const receipt = await receiveEnvelope(raw({ assets: [pngAsset()] }));
    expect(receipt.status).toBe("created");
    expect(receipt.path).toBe("测试标题.md");
    expect(receipt.assets).toHaveLength(1);
    expect(receipt.assets[0]).toMatch(/^测试标题\.assets\/[0-9a-f]{8}-diagram\.png$/);

    const text = testBackend.text(receipt.path!)!;
    const refs = imageRefs(text);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatch(/^测试标题\.assets\/[0-9a-f]{8}-diagram\.png$/);
    // 「图片跟笔记走」的不变量：按查看器的方式解析相对引用，必须**恰好**是那个文件。
    expect(resolveRef(receipt.path!, refs[0])).toBe(receipt.assets[0]);
  });

  it("同一目录里两篇笔记各自一个附件目录（不是公共 assets/）", async () => {
    const a = await receiveEnvelope(raw({ title: "甲", body: "![图](./assets/a.png)\n", assets: [pngAsset("a.png")] }));
    const b = await receiveEnvelope(
      raw({ title: "乙", body: "![图](./assets/b.png)\n", source: { url: "https://other.test/y", capturedAt: CAPTURED }, assets: [pngAsset("b.png", GIF)] }),
    );
    expect(a.assets[0].startsWith("甲.assets/")).toBe(true);
    expect(b.assets[0].startsWith("乙.assets/")).toBe(true);
    expect(testBackend.paths().some((path) => path.startsWith("assets/"))).toBe(false);
    // 各自解析回各自的文件，互不串台。
    for (const receipt of [a, b]) {
      const refs = imageRefs(testBackend.text(receipt.path!)!);
      expect(resolveRef(receipt.path!, refs[0])).toBe(receipt.assets[0]);
    }
  });

  it("笔记改名（撞名 → ` 2`）后附件目录跟着笔记名走", async () => {
    testBackend.seed("测试标题.md", "# 外部先建的\n");
    const receipt = await receiveEnvelope(raw({ assets: [pngAsset()] }));
    expect(receipt.status).toBe("created");
    expect(receipt.path).toBe("测试标题 2.md");
    expect(receipt.assets[0].startsWith("测试标题 2.assets/")).toBe(true);
    const text = testBackend.text(receipt.path!)!;
    expect(resolveRef(receipt.path!, imageRefs(text)[0])).toBe(receipt.assets[0]);
    // 目标里带空格（`测试标题 2.assets/…`）⇒ 必须写成 `<…>`，否则空格截断目标、图片不渲染。
    // 判据盯**用户看得见的那条路径**：正文里那一行到底能不能被渲染器认出来。
    expect(text.includes(`](<测试标题 2.assets/`), `引用没有走 <…> 形式：${text}`).toBe(true);
  });

  it("落点在子目录：附件目录跟着笔记进同一个子目录（相对引用不带目录前缀也能解析）", async () => {
    const receipt = await receiveEnvelope(raw({ target: { folder: "剪藏/技术", notePath: null }, assets: [pngAsset()] }));
    expect(receipt.path).toBe("剪藏/技术/测试标题.md");
    expect(receipt.assets[0].startsWith("剪藏/技术/测试标题.assets/")).toBe(true);
    const refs = imageRefs(testBackend.text(receipt.path!)!);
    expect(refs[0].startsWith("测试标题.assets/")).toBe(true);
    expect(resolveRef(receipt.path!, refs[0])).toBe(receipt.assets[0]);
  });

  it("追加时新图进**同一篇**笔记的附件目录，两次引用都指得对", async () => {
    const first = await receiveEnvelope(raw({ body: "第一段\n\n![图](./assets/a.png)\n", assets: [pngAsset("a.png")] }));
    const second = await receiveEnvelope(
      raw({ body: "第二段\n\n![图](./assets/b.png)\n", source: { selection: true, capturedAt: CAPTURED }, assets: [pngAsset("b.png", GIF)] }),
    );
    expect(second.status).toBe("appended");
    expect(second.path).toBe(first.path);
    const refs = imageRefs(testBackend.text(first.path!)!);
    expect(refs).toHaveLength(2);
    // 正文里的两个引用分别解析回**第一次**与**第二次**写的图（都在同一篇笔记的附件目录里）。
    expect(refs.map((ref) => resolveRef(first.path!, ref)).sort()).toEqual([...first.assets, ...second.assets].sort());
  });
});

describe("L2 接收端 · 资产名不是路径逃逸入口（D-④）", () => {
  const escapes = [
    "../../escape.png",
    "../../../escape.png",
    "..\\..\\escape.png",
    "..\\..\\..\\escape.png",
    "/etc/passwd.png",
    "C:/Windows/evil.png",
    "a:b.png",
    "..",
  ];

  for (const name of escapes) {
    it(`资产名 ${JSON.stringify(name)} 落在附件目录里，不产生任何越界文件`, async () => {
      const receipt = await receiveEnvelope(raw({ body: `看图：\n\n![图](./assets/${name})\n`, assets: [pngAsset(name)] }));
      expect(receipt.assets).toHaveLength(1);
      const file = receipt.assets[0];
      expect(file.startsWith("测试标题.assets/")).toBe(true);
      expect(file.split("/")).toHaveLength(2); // 只有一层目录
      // 磁盘上除了笔记 + 这个附件，什么都没有（没有 `escape.png`、没有 `passwd.png`、没有裸的 `assets/`）。
      expect(noteFiles()).toEqual(["测试标题.md"]);
      expect(assetPaths()).toEqual([file]);
      // 正文引用也被改写到安全路径上，且解析回来还是这个文件。
      const refs = imageRefs(testBackend.text(receipt.path!)!);
      expect(refs).toHaveLength(1);
      expect(resolveRef(receipt.path!, refs[0])).toBe(file);
    });
  }

  it("资产名的分隔符被清洗掉（`剪藏/深/图.png` 不产生第二层目录）", async () => {
    const receipt = await receiveEnvelope(raw({ assets: [pngAsset("剪藏/深/图.png")] }));
    expect(receipt.assets[0].split("/")).toHaveLength(2);
  });

  it("接收端自己拒绝越界的 `assets[].file`（不依赖上游先拒）：IMP-4012", async () => {
    await expect(receiveEnvelope(raw({ assets: [{ name: "a.png", mime: "image/png", file: "../outside.png" }] }))).rejects.toMatchObject({
      code: "IMP-4012",
    });
    expect(noteFiles()).toEqual([]);
    expect(assetPaths()).toEqual([]);
  });

  it("`assets[].file` 指向工作区内一个不存在的文件 → IMP-4012，不写笔记", async () => {
    await expect(receiveEnvelope(raw({ assets: [{ name: "a.png", mime: "image/png", file: "missing/outside.png" }] }))).rejects.toBeInstanceOf(
      ImportRejection,
    );
    expect(noteFiles()).toEqual([]);
  });
});

describe("L2 接收端 · 重名可读化去重（不静默覆盖）", () => {
  it("同路径已被**内容不同**的文件占住时，退让成 ` 2`，原文件一个字节没动", async () => {
    const occupied = `测试标题.assets/${await contentHash8(PNG)}-diagram.png`;
    const other = new TextEncoder().encode("用户手放的同名文件，绝不是这张图");
    testBackend.seedBytes(occupied, other);

    const receipt = await receiveEnvelope(raw({ assets: [pngAsset()] }));
    expect(receipt.assets[0]).not.toBe(occupied);
    expect(receipt.assets[0]).toMatch(/^测试标题\.assets\/[0-9a-f]{8}-diagram-2\.png$/);
    expect(testBackend.bytes(receipt.assets[0])).toEqual(PNG);
    // 用户那份文件仍在，且**逐字节没变**。
    expect(testBackend.bytes(occupied)).toEqual(other);
    expect(resolveRef(receipt.path!, imageRefs(testBackend.text(receipt.path!)!)[0])).toBe(receipt.assets[0]);
  });

  it("同路径已是**相同内容**时直接复用（重试幂等，不产生 ` 2`）", async () => {
    const existing = `测试标题.assets/${await contentHash8(PNG)}-diagram.png`;
    testBackend.seedBytes(existing, PNG);
    const receipt = await receiveEnvelope(raw({ assets: [pngAsset()] }));
    expect(receipt.assets[0]).toBe(existing);
    expect(testBackend.paths().some((path) => path.includes(" 2.png"))).toBe(false);
  });
});

describe("L2 接收端 · 撤销时资产与正文一致", () => {
  it("撤销「新建」：笔记与附件目录**一起**进回收站，工作区不留孤儿", async () => {
    const receipt = await receiveEnvelope(raw({ assets: [pngAsset()] }));
    const dir = "测试标题.assets";
    expect(testBackend.files.has(receipt.assets[0])).toBe(true);

    const result = await undoImport(receipt);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("trash");
    expect(noteFiles()).toEqual([]);
    // `foo.assets/` 不能留在原地（否则下一篇同名笔记会撞上它）。
    expect(testBackend.paths().some((path) => path.startsWith(dir))).toBe(false);
    expect(testBackend.paths().some((path) => path.startsWith(".opennote/trash/") && path.includes(".assets/"))).toBe(true);
    /*
     * 撤销的**那句话**也必须是真的。
     *
     * 这里咬的是一个「结论一样、过程是假的」的洞：附件目录在两个地方各搬了一次
     * （`receive.ts` 自己的 `trashAssetsDir` + `library.ts` 的 `trashNote`）。
     * 目标路径恰好相同，所以**功能上看不出区别**，但第二处必然失败（源目录已经被搬走）
     * ⇒ 用户会收到一句假告警「图片目录 x.assets 没能一起移入回收站，请手动处理」。
     * 判据盯的是**用户看得见的那句话**，不是「文件最后在哪」。
     */
    expect(result.message).not.toContain("没能一起移入回收站");
    expect(result.message).toBe("已把《测试标题》移入回收站，可以再找回来。");
  });

  it("撤销「追加」：前像还回来，这次新增的图跟着删掉，复用的旧图**不删**", async () => {
    const reused = pngAsset("旧图.png");
    const first = await receiveEnvelope(raw({ body: "第一段\n\n![旧](./assets/旧图.png)\n", assets: [reused] }));
    const second = await receiveEnvelope(
      raw({
        body: "第二段\n\n![旧](./assets/旧图.png)\n\n![新](./assets/新图.png)\n",
        source: { selection: true, capturedAt: CAPTURED },
        assets: [reused, pngAsset("新图.png", GIF)],
      }),
    );
    expect(second.status).toBe("appended");
    const oldAsset = first.assets[0];
    const newAsset = second.assets.find((path) => path !== oldAsset)!;
    expect(testBackend.files.has(newAsset)).toBe(true);

    const result = await undoImport(second);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("preimage");
    expect(result.message).toBe("已还原《测试标题》到导入前的版本。");
    // 正文回到第一段，新图没了，复用的旧图还在（它被还原后的正文引用着）。
    const text = testBackend.text(second.path!)!;
    expect(text).toContain("第一段");
    expect(text).not.toContain("第二段");
    expect(testBackend.files.has(newAsset)).toBe(false);
    expect(testBackend.files.has(oldAsset)).toBe(true);
    expect(resolveRef(second.path!, imageRefs(text)[0])).toBe(oldAsset);
  });

  it("清理失败时**如实说明**（不假装成功）：附件删不掉就报出目录让用户手删", async () => {
    await receiveEnvelope(raw({ body: "第一段\n", assets: [] }));
    const second = await receiveEnvelope(
      raw({
        body: "第二段\n\n![新](./assets/新图.png)\n",
        source: { selection: true, capturedAt: CAPTURED },
        assets: [pngAsset("新图.png", GIF)],
      }),
    );
    expect(second.status).toBe("appended");
    const newAsset = second.assets[0];
    const remove = vi.spyOn(testBackend, "remove").mockRejectedValue(new Error("EACCES 只读"));
    try {
      const result = await undoImport(second);
      expect(result.ok).toBe(true);
      expect(result.mode).toBe("preimage");
      expect(result.message).toContain("没能清理");
      expect(result.message).toContain("测试标题.assets");
      expect(testBackend.files.has(newAsset)).toBe(true);
    } finally {
      remove.mockRestore();
    }
  });

  it("撤销「覆盖」：正文回到覆盖前，覆盖时新写的图也一起回退", async () => {
    const first = await receiveEnvelope(raw({ body: "第一段\n" }));
    const before = testBackend.bytes(first.path!)!;
    setImportLandingPreference("new");
    setImportChannelContext({ channel: "local-bridge", overwriteEnabled: true });

    const receipt = await receiveEnvelope(
      raw({ body: "第二段\n\n![新](./assets/新图.png)\n", conflict: "overwrite", assets: [pngAsset("新图.png", GIF)] }),
    );
    expect(receipt.status).toBe("created");
    expect(receipt.path).toBe(first.path);
    expect(receipt.revertible).toBe(true);
    const asset = receipt.assets[0];
    expect(testBackend.files.has(asset)).toBe(true);

    const result = await undoImport(receipt);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("preimage");
    expect(testBackend.bytes(receipt.path!)).toEqual(before);
    expect(testBackend.files.has(asset)).toBe(false);
    // 附件目录空了就一起收掉，不留空壳。
    expect(testBackend.dirs.has("测试标题.assets")).toBe(false);
  });

  it("撤销「追加」**不碰公共 `assets/` 里的旧图**（旧数据不迁移，也绝不能误删）", async () => {
    // 夹具：公共 `归档/assets/` 里先有一张「编辑器早年贴的」图（老约定，不迁移）。
    const legacyBytes = new TextEncoder().encode("编辑器早年贴的图，逐字节不许动");
    testBackend.seedBytes("归档/assets/old.png", legacyBytes);
    // 正文由**第一次导入**写出（不是手改磁盘：手改会被 `IMP-W004`「外部改动」保护挡成另存 ` 2.md`）。
    const first = await receiveEnvelope(
      raw({ target: { folder: "归档", notePath: null }, body: "第一段\n\n![老图](./assets/old.png)\n" }),
    );
    expect(first.path).toBe("归档/测试标题.md");
    expect(first.warnings.some((warning) => warning.includes("IMP-W002"))).toBe(true); // 未声明的引用原样保留 = 不迁移
    const legacyBody = testBackend.text(first.path!)!;

    const second = await receiveEnvelope(
      raw({
        target: { folder: "归档", notePath: null },
        body: "第二段\n\n![新](./assets/新图.png)\n",
        source: { selection: true, capturedAt: CAPTURED },
        assets: [pngAsset("新图.png", GIF)],
      }),
    );
    expect(second.status).toBe("appended");
    expect(second.path).toBe(first.path);
    const newAsset = second.assets[0];
    expect(newAsset.startsWith("归档/测试标题.assets/")).toBe(true);

    const result = await undoImport(second);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("preimage");
    // 正文回到追加前（老引用原样），新图删掉，**公共 `assets/` 里的旧图一个字节没动**。
    expect(testBackend.text(second.path!)).toBe(legacyBody);
    expect(testBackend.files.has(newAsset)).toBe(false);
    expect(testBackend.bytes("归档/assets/old.png")).toEqual(legacyBytes);
    // 公共目录里没有多出、也没有少掉任何东西。
    expect(testBackend.paths().filter((path) => path.startsWith("归档/assets/"))).toEqual(["归档/assets/old.png"]);
    // 还原后的正文仍然指得到那张旧图。
    expect(testBackend.files.has(resolveRef(second.path!, imageRefs(testBackend.text(second.path!)!)[0]))).toBe(true);
  });
});

/**
 * 「三条路统一到同一个派生函数」的前提：**派生语义必须钉死**。
 * 编辑器粘贴/拖拽、本地文件夹导入、剪藏三处都要用 `assetsDirFor(notePath)`，
 * 否则同一篇笔记会出现三种目录名。
 */
describe("L2 接收端 · 附件目录派生的边界（三路统一的前提）", () => {
  const cases: [string, string][] = [
    ["foo.md", "foo.assets"],
    ["a.b.md", "a.b.assets"],
    ["FOO.MD", "FOO.assets"],
    ["foo.txt", "foo.assets"],
    ["foo", "foo.assets"],
    ["foo 2.md", "foo 2.assets"],
    ["归档/foo.md", "归档/foo.assets"],
    ["剪藏/技术/foo.md", "剪藏/技术/foo.assets"],
    ["foo bar.md", "foo bar.assets"],
    [".opennote/trash/归档/foo.md", ".opennote/trash/归档/foo.assets"],
    ["...md", "未命名.assets"], // 退化成「只有扩展名」时兜底，绝不产出空目录名
  ];

  for (const [input, expected] of cases) {
    it(`assetsDirFor(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`, () => {
      expect(assetsDirFor(input)).toBe(expected);
    });
  }

  it("**永远与笔记同目录**：不越级、不跳回工作区根、也不变成公共 `assets/`", () => {
    for (const [input] of cases) {
      expect(parentPath(assetsDirFor(input)), input).toBe(parentPath(input));
    }
    expect(assetsDirFor("归档/foo.md")).not.toBe("归档/assets");
    expect(assetsDirFor("foo.md")).not.toBe("assets");
  });

  it("同一篇笔记反复派生稳定（三条路各算一次也不会算出不同结果）", () => {
    const once = assetsDirFor("归档/测试标题 2.md");
    expect(assetsDirFor("归档/测试标题 2.md")).toBe(once);
    expect(once).toBe("归档/测试标题 2.assets");
  });

  it("接收端落盘的目录与 `assetsDirFor(最终笔记路径)` 逐字一致（撞名去重后用**最终**路径）", async () => {
    testBackend.seed("测试标题.md", "# 外部先建的\n");
    const receipt = await receiveEnvelope(raw({ assets: [pngAsset()] }));
    expect(receipt.path).toBe("测试标题 2.md");
    expect(receipt.assets[0].startsWith(`${assetsDirFor(receipt.path!)}/`)).toBe(true);
  });
});
