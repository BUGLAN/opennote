import { describe, expect, it, vi } from "vitest";
import type { WorkspaceRecord } from "../data/workspaces";
import { absolutePathOf, copyPathToClipboard, noteAbsolutePath } from "./notePath";

const node = (location: string): WorkspaceRecord => ({
  id: "w1",
  name: "notes",
  kind: "node",
  location,
  addedAt: 0,
  lastOpenedAt: 0,
});

const browser = (kind: "fsa" | "opfs"): WorkspaceRecord => ({
  id: "w2",
  name: "notes（浏览器）",
  kind,
  location: kind === "fsa" ? "0f8c-uid" : "opennote-notes",
  addedAt: 0,
  lastOpenedAt: 0,
});

describe("absolutePathOf", () => {
  it("沿用根目录自己的分隔符，并去掉尾部分隔符", () => {
    expect(absolutePathOf("E:\\repo\\notes", "项目实战/system_panel/修改提示词.md")).toBe(
      "E:\\repo\\notes\\项目实战\\system_panel\\修改提示词.md",
    );
    expect(absolutePathOf("/home/me/notes/", "a/b.md")).toBe("/home/me/notes/a/b.md");
  });

  it("根目录是盘符根时不会拼出双斜杠", () => {
    expect(absolutePathOf("E:\\", "a.md")).toBe("E:\\a.md");
  });
});

describe("noteAbsolutePath", () => {
  it("本机磁盘笔记本给出绝对路径（笔记与文件夹同一份推导）", () => {
    expect(noteAbsolutePath(node("E:\\repo\\notes"), "项目实战/system_panel/修改提示词.md")).toBe(
      "E:\\repo\\notes\\项目实战\\system_panel\\修改提示词.md",
    );
    // 回收站里的笔记 id 是 `.opennote/trash/<原路径>`，文件真实存在，照拼
    expect(noteAbsolutePath(node("E:\\repo\\notes"), ".opennote/trash/a.md")).toBe(
      "E:\\repo\\notes\\.opennote\\trash\\a.md",
    );
  });

  it("浏览器 / OPFS 笔记本没有本机路径，返回 null（调用方据此禁用菜单项）", () => {
    expect(noteAbsolutePath(browser("fsa"), "a.md")).toBeNull();
    expect(noteAbsolutePath(browser("opfs"), "a.md")).toBeNull();
    expect(noteAbsolutePath(null, "a.md")).toBeNull();
  });

  it("location 为空的记录也按不可用处理", () => {
    expect(noteAbsolutePath(node(""), "a.md")).toBeNull();
  });
});

describe("copyPathToClipboard", () => {
  it("写入的是绝对路径", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await copyPathToClipboard(node("E:\\repo\\notes"), "a/b.md");
    expect(writeText).toHaveBeenCalledWith("E:\\repo\\notes\\a\\b.md");
    vi.unstubAllGlobals();
  });

  it("浏览器笔记本不写剪贴板，也不假装成功", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await copyPathToClipboard(browser("opfs"), "a.md");
    expect(writeText).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
