import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRecord } from "./workspaces";
import { MemoryBackend } from "../lib/clip/testing/memoryBackend";

let testBackend: MemoryBackend;
vi.mock("./workspaces", () => ({
  activeWorkspaceRecord: () => null,
  resolveBackend: async () => testBackend,
  setActiveWorkspace: () => undefined,
}));

import { imageMimeFor, readLocalImageBlob } from "./assets";
import { flushAll, openWorkspace } from "./library";

/**
 * 「复制图片」读的是**原始字节**：这条路与屏幕上显示图片的那条路（`ensureImageUrl`）必须
 * 认同一批路径。分开的两套候选回退里，只要有一套漏了「根目录兜底」，就会变成
 * 「图上看得见、复制说没找到」——用户只能把它当成又一个坏掉的按钮。
 */
const record: WorkspaceRecord = {
  id: "test",
  name: "临时笔记本",
  kind: "node",
  location: "unused",
  addedAt: 1,
  lastOpenedAt: 1,
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8]);

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

describe("imageMimeFor：扩展名 → MIME，认不出来就空串", () => {
  it("认得常见图片扩展名（大小写不敏感）", () => {
    expect(imageMimeFor("归档/图.PNG")).toBe("image/png");
    expect(imageMimeFor("a.jpg")).toBe("image/jpeg");
    expect(imageMimeFor("a.jpeg")).toBe("image/jpeg");
    expect(imageMimeFor("a.webp")).toBe("image/webp");
    expect(imageMimeFor("a.svg")).toBe("image/svg+xml");
  });

  it("认不出来时不猜：没有扩展名、未知扩展名都返回空串", () => {
    expect(imageMimeFor("归档/图")).toBe("");
    expect(imageMimeFor("png")).toBe("");
    expect(imageMimeFor("a.heic")).toBe("");
  });
});

describe("readLocalImageBlob：本地图片的原始字节", () => {
  beforeEach(async () => {
    testBackend = new MemoryBackend();
    await openWorkspace(record, { silent: true });
  });

  afterEach(async () => {
    await flushAll();
    vi.restoreAllMocks();
  });

  it("按笔记所在目录解析，字节逐字节一致，MIME 按扩展名给全", async () => {
    testBackend.seedBytes("归档/备注.assets/图.png", PNG);

    const blob = await readLocalImageBlob("./备注.assets/图.png", "归档");

    expect(blob).not.toBeNull();
    expect(blob!.type).toBe("image/png");
    expect(await bytesOf(blob!)).toEqual(PNG);
  });

  it("JPEG 也读得出，且带的是 image/jpeg（复制时才知道要不要转 PNG）", async () => {
    testBackend.seedBytes("图.jpg", JPEG);

    const blob = await readLocalImageBlob("图.jpg", "");

    expect(blob!.type).toBe("image/jpeg");
    expect(await bytesOf(blob!)).toEqual(JPEG);
  });

  it("笔记目录下找不到时回退到工作区根目录（与屏幕上显示图片的那条路同一套候选）", async () => {
    testBackend.seedBytes("assets/老图.png", PNG);

    const blob = await readLocalImageBlob("./assets/老图.png", "归档");

    expect(await bytesOf(blob!)).toEqual(PNG);
  });

  it("`<…>` 形式的引用（路径带空格）也要认", async () => {
    testBackend.seedBytes("归档/备注 2.assets/截 图.png", PNG);

    const blob = await readLocalImageBlob("<./备注 2.assets/截 图.png>", "归档");

    expect(blob!.type).toBe("image/png");
    expect(await bytesOf(blob!)).toEqual(PNG);
  });

  it("远程 / data: / blob: 没有本地字节：返回 null，一个字节都不去后端读", async () => {
    const before = testBackend.calls.length;
    expect(await readLocalImageBlob("https://img.example/a.png", "归档")).toBeNull();
    expect(await readLocalImageBlob("data:image/png;base64,AAAA", "归档")).toBeNull();
    expect(await readLocalImageBlob("blob:opennote/abc", "归档")).toBeNull();
    expect(testBackend.calls.slice(before).filter((call) => call.startsWith("readBytes:"))).toEqual([]);
  });

  it("文件不在了：如实返回 null（不抛、不编一个空 Blob 出来）", async () => {
    expect(await readLocalImageBlob("./备注.assets/没这张图.png", "归档")).toBeNull();
  });

  it("扩展名认不出来时 MIME 留空，不冒充成 png", async () => {
    testBackend.seedBytes("归档/图.heic", PNG);

    const blob = await readLocalImageBlob("图.heic", "归档");

    expect(blob!.type).toBe("");
  });
});
