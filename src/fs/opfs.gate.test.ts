/**
 * A 线门禁 · D12 补强：浏览器「导入文件夹」不覆盖同名、不误改名、不越界。
 *
 * `src/fs/opfs.test.ts` 已覆盖原始复现（磁盘既有同名文件被覆盖、跨目录同名被改名）。
 * 本文件补的是同一缺陷上更容易漏的边角：同名条目是**目录**、多级嵌套、
 * `webkitRelativePath` 里带 `..`、以及没有相对路径时的兜底落点。
 *
 * D12 只约束 OPFS 页面内桥，是 **P1 硬门禁**，不阻塞 P0 线。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importFilesIntoOpfs } from "./opfs";
import { MemoryFileSystem } from "./testing/memoryHandles";

/** 造一个带 `webkitRelativePath` 的 File，模拟 input[webkitdirectory] 的上传。 */
function uploadFile(relativePath: string, content: string): File {
  const name = relativePath.split("/").filter(Boolean).pop() ?? relativePath;
  const file = new File([content], name, { type: "text/plain" });
  Object.defineProperty(file, "webkitRelativePath", { value: relativePath });
  return file;
}

const WORKSPACE = "我的笔记";
const inWorkspace = (path: string) => `opennote/${WORKSPACE}/${path}`;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

describe("D12 导入边角：同名目录、嵌套目录、越界相对路径", () => {
  let fs: MemoryFileSystem;

  beforeEach(() => {
    fs = new MemoryFileSystem();
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => fs.root } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("磁盘上的同名条目是目录：不覆盖、不抛错，导入改名落地，目录内容原样保留", async () => {
    fs.seedDirectory(inWorkspace("图片.png"));
    fs.seedFile(inWorkspace("图片.png/内部.txt"), "ON-DISK");
    const result = await importFilesIntoOpfs([uploadFile("picked/图片.png", "NEW")], WORKSPACE);
    expect(result).toEqual({ files: 1, bytes: bytes("NEW"), skipped: 0 });
    expect(fs.readText(inWorkspace("图片.png/内部.txt"))).toBe("ON-DISK");
    expect(fs.resolve(inWorkspace("图片.png"))).toBe(inWorkspace("图片.png"));
    expect(fs.readText(inWorkspace("图片 2.png"))).toBe("NEW");
  });

  it("多级嵌套目录被完整重建，深层同名文件照样加序号", async () => {
    fs.seedFile(inWorkspace("素材/图标/x.png"), "OLD");
    const result = await importFilesIntoOpfs([uploadFile("picked/素材/图标/x.png", "NEW")], WORKSPACE);
    expect(result).toEqual({ files: 1, bytes: bytes("NEW"), skipped: 0 });
    expect(fs.readText(inWorkspace("素材/图标/x.png"))).toBe("OLD");
    expect(fs.readText(inWorkspace("素材/图标/x 2.png"))).toBe("NEW");
  });

  it("webkitRelativePath 里的 '..' 段被 sanitizeName 中和，落点仍在工作区内", async () => {
    const result = await importFilesIntoOpfs([uploadFile("picked/../../evil.md", "X")], WORKSPACE);
    expect(result).toEqual({ files: 1, bytes: bytes("X"), skipped: 0 });
    expect(fs.paths("file")).toEqual([inWorkspace("file/file/evil.md")]);
    // 整个存储里除工作区本身之外没有任何条目被创建
    const outside = fs.paths().filter((path) => !path.startsWith(`opennote/${WORKSPACE}`));
    expect(outside).toEqual(["opennote"]);
  });

  it("没有 webkitRelativePath（或只有裸文件名）时落到目标目录根，不建多余层级", async () => {
    const bare = new File(["B"], "裸名.md", { type: "text/markdown" });
    Object.defineProperty(bare, "webkitRelativePath", { value: "" });
    const result = await importFilesIntoOpfs([bare], WORKSPACE);
    expect(result).toEqual({ files: 1, bytes: bytes("B"), skipped: 0 });
    expect(fs.readText(inWorkspace("裸名.md"))).toBe("B");
    expect(fs.paths("file")).toEqual([inWorkspace("裸名.md")]);
  });

  it("同一批里「同名文件」与「同名目录」互不干扰，各自保留", async () => {
    fs.seedFile(inWorkspace("b/x.png"), "FILE-ON-DISK");
    fs.seedDirectory(inWorkspace("c"));
    fs.seedFile(inWorkspace("c/x.png"), "OTHER-DIR");
    const result = await importFilesIntoOpfs(
      [uploadFile("picked/b/x.png", "1"), uploadFile("picked/c/x.png", "2")],
      WORKSPACE,
    );
    expect(result.files).toBe(2);
    expect(result.skipped).toBe(0);
    expect(fs.readText(inWorkspace("b/x.png"))).toBe("FILE-ON-DISK");
    expect(fs.readText(inWorkspace("b/x 2.png"))).toBe("1");
    expect(fs.readText(inWorkspace("c/x.png"))).toBe("OTHER-DIR");
    expect(fs.readText(inWorkspace("c/x 2.png"))).toBe("2");
  });
});
