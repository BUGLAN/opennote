import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteOpfsWorkspace, importFilesIntoOpfs, listOpfsWorkspaces, supportsOpfs } from "./opfs";
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

describe("importFilesIntoOpfs（D12：不覆盖、不误改名）", () => {
  let fs: MemoryFileSystem;

  beforeEach(() => {
    fs = new MemoryFileSystem();
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => fs.root } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("磁盘上已有同名文件时加序号，绝不覆盖既有内容", async () => {
    fs.seedFile(inWorkspace("覆盖.md"), "ORIGINAL-ON-DISK");
    const result = await importFilesIntoOpfs([uploadFile("picked/覆盖.md", "IMPORTED-CONTENT")], WORKSPACE);
    expect(result).toMatchObject({
      files: 1,
      skipped: 0,
      bytes: new TextEncoder().encode("IMPORTED-CONTENT").byteLength,
    });
    expect(fs.readText(inWorkspace("覆盖.md"))).toBe("ORIGINAL-ON-DISK");
    expect(fs.readText(inWorkspace("覆盖 2.md"))).toBe("IMPORTED-CONTENT");
  });

  it("跨目录同名文件各自独立，不再被改成「 2」而破坏相对链接", async () => {
    const result = await importFilesIntoOpfs(
      [uploadFile("picked/b/x.png", "B"), uploadFile("picked/c/x.png", "C")],
      WORKSPACE,
    );
    expect(result.files).toBe(2);
    expect(result.skipped).toBe(0);
    expect(fs.readText(inWorkspace("b/x.png"))).toBe("B");
    expect(fs.readText(inWorkspace("c/x.png"))).toBe("C");
    expect(fs.paths("file").some((path) => path.includes("x 2.png"))).toBe(false);
  });

  it("磁盘既有文件与批内同名文件一起参与加序号", async () => {
    fs.seedFile(inWorkspace("pkg/a.md"), "ON-DISK");
    const result = await importFilesIntoOpfs(
      [uploadFile("picked/pkg/a.md", "1"), uploadFile("picked/pkg/a.md", "2")],
      WORKSPACE,
    );
    expect(result.files).toBe(2);
    expect(fs.readText(inWorkspace("pkg/a.md"))).toBe("ON-DISK");
    expect(fs.readText(inWorkspace("pkg/a 2.md"))).toBe("1");
    expect(fs.readText(inWorkspace("pkg/a 3.md"))).toBe("2");
  });

  it("重复导入同一批文件时每次都往后加序号", async () => {
    await importFilesIntoOpfs([uploadFile("picked/笔记.md", "第一次")], WORKSPACE);
    await importFilesIntoOpfs([uploadFile("picked/笔记.md", "第二次")], WORKSPACE);
    expect(fs.readText(inWorkspace("笔记.md"))).toBe("第一次");
    expect(fs.readText(inWorkspace("笔记 2.md"))).toBe("第二次");
  });

  it("超过体积上限的文件记为 skipped，不落盘", async () => {
    const result = await importFilesIntoOpfs([uploadFile("picked/big.md", "12345")], WORKSPACE, { maxBytes: 4 });
    expect(result).toEqual({ files: 0, bytes: 0, skipped: 1 });
    expect(fs.paths("file")).toEqual([]);
  });

  it("写入失败时 abort() + close() 释放流，并计入 skipped（D37）", async () => {
    fs.failWrites(1);
    const result = await importFilesIntoOpfs([uploadFile("picked/坏.md", "X")], WORKSPACE);
    expect(result).toEqual({ files: 0, bytes: 0, skipped: 1 });
    expect(fs.events.some((event) => event.startsWith("abort:") && event.includes("坏.md"))).toBe(true);
    expect(fs.events.some((event) => event.startsWith("close:") && event.includes("坏.md"))).toBe(true);
    expect(fs.has(inWorkspace("坏.md"))).toBe(false);
  });
});

describe("OPFS 工作区管理（D12 回归）", () => {
  let fs: MemoryFileSystem;

  beforeEach(() => {
    fs = new MemoryFileSystem();
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => fs.root } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("supportsOpfs 依据 navigator.storage.getDirectory 判定", () => {
    expect(supportsOpfs()).toBe(true);
    vi.stubGlobal("navigator", {});
    expect(supportsOpfs()).toBe(false);
  });

  it("列出与删除工作区只影响指定目录", async () => {
    fs.seedFile(inWorkspace("笔记.md"), "X");
    fs.seedFile("opennote/另一个/笔记.md", "Y");
    expect(await listOpfsWorkspaces()).toEqual(["另一个", "我的笔记"]);
    await deleteOpfsWorkspace(WORKSPACE);
    expect(fs.has(`opennote/${WORKSPACE}`)).toBe(false);
    expect(fs.readText("opennote/另一个/笔记.md")).toBe("Y");
  });
});
