/**
 * 画布搜索纯逻辑测试：匹配面（文本/文件标题/路径/链接/分组/边标签）、大小写、空查询。
 */
import { describe, expect, it } from "vitest";
import { searchCanvas } from "./search";
import type { CanvasDocument } from "./types";

const doc: CanvasDocument = {
  nodes: [
    { id: "t1", type: "text", x: 0, y: 0, width: 10, height: 10, text: "先把问题列出来" },
    { id: "f1", type: "file", x: 0, y: 0, width: 10, height: 10, file: "读书/系统设计.md" },
    { id: "l1", type: "link", x: 0, y: 0, width: 10, height: 10, url: "https://example.com/PR" },
    { id: "g1", type: "group", x: 0, y: 0, width: 10, height: 10, label: "评审组" },
    { id: "u1", type: "embed", src: "embed 不参与搜索" },
  ],
  edges: [{ id: "e1", fromNode: "t1", toNode: "f1", label: "展开评审" }],
};

describe("searchCanvas", () => {
  const titles: Record<string, string> = { "读书/系统设计.md": "系统设计入门" };
  const search = (q: string) => searchCanvas(doc, q, (id) => titles[id] ?? null);

  it("匹配文本卡文字与链接 url（大小写不敏感）", () => {
    expect(search("问题").map((m) => m.id)).toEqual(["t1"]);
    expect(search("pr").map((m) => m.id)).toEqual(["l1"]);
  });

  it("匹配文件卡标题（经 noteTitle）与路径", () => {
    expect(search("系统设计").map((m) => m.id)).toEqual(["f1"]);
    expect(search("读书/").map((m) => m.id)).toEqual(["f1"]);
  });

  it("匹配分组 label、边标签；未知类型节点不参与", () => {
    expect(search("example.com").map((m) => m.id)).toEqual(["l1"]);
    expect(search("评审").map((m) => m.id)).toEqual(["g1", "e1"]);
    expect(search("embed")).toEqual([]);
  });

  it("空查询与纯空白返回空", () => {
    expect(search("")).toEqual([]);
    expect(search("   ")).toEqual([]);
  });

  it("命中按文档序（节点在前、边在后），kind 标注正确", () => {
    const matches = search("评");
    expect(matches.map((m) => `${m.kind}:${m.id}`)).toEqual(["node:g1", "edge:e1"]);
    expect(search("e").map((m) => m.id)).toEqual(["l1"]);
  });
});
