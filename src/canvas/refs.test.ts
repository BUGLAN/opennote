/**
 * 引用解析与反向定位的纯函数测试：`normalizeFileRef` 的容错口径、
 * `canvasesReferencing` 的命中规则、`rewriteFileRefs` 的精确/前缀匹配边界。
 */
import { describe, expect, it } from "vitest";
import { serializeCanvas } from "./jsonCanvas";
import { canvasesReferencing, fileNodesIn, normalizeFileRef, rewriteFileRefs } from "./refs";
import { parseCanvas } from "./jsonCanvas";
import type { CanvasDocument } from "./types";

function canvasWithFile(file: string, nodeId = "n1"): string {
  return serializeCanvas({
    nodes: [{ id: nodeId, type: "file", x: 0, y: 0, width: 240, height: 120, file }],
    edges: [],
  });
}

describe("normalizeFileRef", () => {
  it("反斜杠 / ./ 前缀 / 前导斜杠 / .. 都规范成根相对 POSIX", () => {
    expect(normalizeFileRef("a\\b\\c.md")).toBe("a/b/c.md");
    expect(normalizeFileRef("./a.md")).toBe("a.md");
    expect(normalizeFileRef(".\\./笔记/a.md")).toBe("笔记/a.md");
    expect(normalizeFileRef("/a.md")).toBe("a.md");
    expect(normalizeFileRef("a/./b/../b/c.md")).toBe("a/b/c.md");
    expect(normalizeFileRef("")).toBe("");
  });
});

describe("canvasesReferencing", () => {
  it("找出引用目标笔记的画布与节点；文本节点与其它画布不算", () => {
    const canvases = [
      { id: "看板.canvas", content: canvasWithFile("a.md") },
      {
        id: "其它.canvas",
        content: serializeCanvas({
          nodes: [
            { id: "t", type: "text", x: 0, y: 0, width: 10, height: 10, text: "a.md" },
            { id: "f", type: "file", x: 0, y: 0, width: 10, height: 10, file: "b.md" },
          ],
          edges: [],
        }),
      },
    ];
    expect(canvasesReferencing("a.md", canvases)).toEqual([{ canvasId: "看板.canvas", nodeId: "n1" }]);
    expect(canvasesReferencing("b.md", canvases)).toEqual([{ canvasId: "其它.canvas", nodeId: "f" }]);
    expect(canvasesReferencing("c.md", canvases)).toEqual([]);
  });

  it("引用写法容错：反斜杠与 ./ 前缀同样命中", () => {
    const canvases = [
      { id: "x.canvas", content: canvasWithFile(".\\a.md") },
      { id: "y.canvas", content: canvasWithFile("./a.md", "n2") },
      { id: "w.canvas", content: canvasWithFile("别处\\a.md", "n3") },
    ];
    expect(canvasesReferencing("a.md", canvases)).toEqual([
      { canvasId: "x.canvas", nodeId: "n1" },
      { canvasId: "y.canvas", nodeId: "n2" },
    ]);
  });

  it("致命解析失败的画布自然不命中（空文档），不需要特判", () => {
    const canvases = [
      { id: "坏.canvas", content: "{不是 JSON" },
      { id: "好.canvas", content: canvasWithFile("a.md") },
    ];
    expect(canvasesReferencing("a.md", canvases)).toEqual([{ canvasId: "好.canvas", nodeId: "n1" }]);
  });
});

describe("rewriteFileRefs", () => {
  it("默认精确匹配：file===from 改写，相似前缀不误伤", () => {
    const doc: CanvasDocument = parseCanvas(
      serializeCanvas({
        nodes: [
          { id: "a", type: "file", x: 0, y: 0, width: 1, height: 1, file: "a.md" },
          { id: "b", type: "file", x: 0, y: 0, width: 1, height: 1, file: "a.md/x.md" },
          { id: "c", type: "file", x: 0, y: 0, width: 1, height: 1, file: "ga.md" },
        ],
        edges: [],
      }),
    ).doc;
    const { doc: next, changed } = rewriteFileRefs(doc, "a.md", "新名.md");
    expect(changed).toBe(true);
    const files = next.nodes.filter((node) => node.type === "file").map((node) => (node as { file: string }).file);
    expect(files).toEqual(["新名.md", "a.md/x.md", "ga.md"]);
    // 原文档不动（纯函数）。
    expect(fileNodesIn(doc)[0]!.file).toBe("a.md");
  });

  it("prefix:true 只在移动目录时用：目录前缀整体换，文件级不误伤", () => {
    const doc = parseCanvas(
      serializeCanvas({
        nodes: [
          { id: "a", type: "file", x: 0, y: 0, width: 1, height: 1, file: "旧夹/x.md" },
          { id: "b", type: "file", x: 0, y: 0, width: 1, height: 1, file: "旧夹深一层不是前缀.md" },
        ],
        edges: [],
      }),
    ).doc;
    const { doc: next } = rewriteFileRefs(doc, "旧夹", "新家/夹", { prefix: true });
    const files = next.nodes.filter((node) => node.type === "file").map((node) => (node as { file: string }).file);
    expect(files).toEqual(["新家/夹/x.md", "旧夹深一层不是前缀.md"]);
  });

  it("无命中返回原对象且 changed=false；from===to 直接空操作", () => {
    const doc = parseCanvas(canvasWithFile("a.md")).doc;
    const miss = rewriteFileRefs(doc, "b.md", "c.md");
    expect(miss.changed).toBe(false);
    expect(miss.doc).toBe(doc);
    expect(rewriteFileRefs(doc, "a.md", "a.md").changed).toBe(false);
  });

  it("改写产物仍可通过 serializeCanvas 幂等落盘（走完整链路）", () => {
    const doc = parseCanvas(canvasWithFile(".\\a.md")).doc;
    const { doc: next } = rewriteFileRefs(doc, "a.md", "新名.md");
    const text = serializeCanvas(next);
    expect(parseCanvas(text).doc.nodes[0]).toMatchObject({ type: "file", file: "新名.md" });
  });
});
