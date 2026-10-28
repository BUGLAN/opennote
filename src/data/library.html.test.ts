/**
 * HTML 页面（`.html` / `.htm`）在库层的一等公民行为：扫描收编为 kind=html、标题取文件名、
 * 正文原样（不归一行尾）、外部改动照常读进来、应用内写入拒收、不参与自动改名、大纲 / 搜索口径。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBackend } from "../lib/clip/testing/memoryBackend";
import type { WorkspaceRecord } from "./workspaces";

let testBackend: MemoryBackend;
vi.mock("./workspaces", () => ({
  activeWorkspaceRecord: () => null,
  resolveBackend: async () => testBackend,
  setActiveWorkspace: () => undefined,
}));

import { flushAll, getLibrary, openWorkspace, renameNote, rescanWorkspace, searchNotes, shouldAutoRename, updateNoteContent } from "./library";
import { isReadOnlyKind, noteKind } from "./types";

const RECORD: WorkspaceRecord = { id: "t", name: "临时笔记本", kind: "node", location: "unused", addedAt: 1, lastOpenedAt: 1 };
const PAGE = "<!doctype html>\r\n<title>别的标题</title>\r\n<h1>标题</h1><p>正文 关键词</p>";

beforeEach(() => {
  testBackend = new MemoryBackend();
});

describe("扫描与种类", () => {
  it(".html / .htm 收编为 kind=html：标题 = 文件名 stem，正文是磁盘原文（CRLF 不归一）", async () => {
    testBackend.seed("报告/季度.html", PAGE);
    testBackend.seed("旧页.HTM", "<p>x</p>");
    testBackend.seed("a.md", "# A");
    await openWorkspace(RECORD, { silent: true });
    const notes = getLibrary().notes;
    expect(noteKind(notes["报告/季度.html"])).toBe("html");
    expect(noteKind(notes["旧页.HTM"])).toBe("html");
    expect(noteKind(notes["a.md"])).toBe("note");
    expect(notes["报告/季度.html"].title).toBe("季度");
    expect(notes["报告/季度.html"].content).toBe(PAGE);
    expect(notes["报告/季度.html"].tags).toEqual([]);
    expect(isReadOnlyKind(notes["报告/季度.html"])).toBe(true);
    expect(isReadOnlyKind(notes["a.md"])).toBe(false);
  });

  it("磁盘上的外部改动照常读进来（只读的是「应用内」）", async () => {
    testBackend.seed("p.html", "<p>一</p>");
    await openWorkspace(RECORD, { silent: true });
    testBackend.seed("p.html", "<p>二</p>");
    await rescanWorkspace();
    expect(getLibrary().notes["p.html"].content).toBe("<p>二</p>");
  });

  it("★ 应用内写入拒收：不进内存、不标脏、不落盘", async () => {
    testBackend.seed("p.html", "<p>一</p>");
    await openWorkspace(RECORD, { silent: true });
    updateNoteContent("p.html", "<p>改</p>", { immediate: true });
    await flushAll();
    expect(getLibrary().notes["p.html"].content).toBe("<p>一</p>");
    expect(getLibrary().dirty["p.html"]).toBeUndefined();
    expect(testBackend.text("p.html")).toBe("<p>一</p>");
  });

  it("改名保留扩展名；不参与占位名自动改名", async () => {
    testBackend.seed("无标题.html", "<p>x</p>");
    await openWorkspace(RECORD, { silent: true });
    expect(
      shouldAutoRename({
        id: "无标题.html",
        stem: "无标题",
        placeholderOrigin: true,
        kind: "html",
        content: "<h1>新</h1>",
        titleOverride: null,
        trashed: false,
        createdAt: 0,
        now: 10_000,
        composing: false,
        creating: false,
        locked: false,
        lastAutoRenameAt: null,
        explicitRenamedAt: null,
        pinnedAt: null,
        inFlight: false,
        autoTitleFromPlaceholder: true,
      }),
    ).toBe("HTML 页面不参与自动改名");
    await renameNote("无标题.html", "页面");
    expect(Object.keys(getLibrary().notes)).toContain("页面.html");
    expect(testBackend.text("页面.html")).toBe("<p>x</p>");
  });

  it("搜索：认页面文字与标题，不认标签名与属性", async () => {
    testBackend.seed("p.html", PAGE);
    await openWorkspace(RECORD, { silent: true });
    expect(searchNotes("关键词").map((hit) => hit.note.id)).toEqual(["p.html"]);
    expect(searchNotes("doctype")).toEqual([]);
  });
});
