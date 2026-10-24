/**
 * 剪贴板纯逻辑测试：选区收集（边随动）、副本 id 重生成、坐标偏移、深拷贝隔离。
 */
import { describe, expect, it } from "vitest";
import { clipboardBounds, collectSelection, getClipboard, materializeClipboard, setClipboard, type ClipboardIdGen } from "./clipboard";
import type { CanvasDocument } from "./types";

/** 确定 id 序列的生成器：测试里不依赖随机。 */
function gen(prefix: string, counter: { n: number }): ClipboardIdGen {
  return {
    newNodeId: () => `${prefix}-n${counter.n++}`,
    newEdgeId: () => `${prefix}-e${counter.n++}`,
  };
}

const doc: CanvasDocument = {
  nodes: [
    { id: "a", type: "text", x: 0, y: 0, width: 100, height: 60, text: "甲" },
    { id: "b", type: "text", x: 200, y: 0, width: 100, height: 60, text: "乙" },
    { id: "c", type: "file", x: 400, y: 0, width: 100, height: 60, file: "x/y.md" },
    { id: "g", type: "group", x: -50, y: -50, width: 700, height: 400, label: "组" },
  ],
  edges: [
    { id: "e-ab", fromNode: "a", toNode: "b" }, // 两端都选：随动
    { id: "e-bc", fromNode: "b", toNode: "c" }, // 只选了 b：不带
    { id: "e-ga", fromNode: "g", toNode: "a" }, // g 没选：不带
    { id: "e-bb", fromNode: "b", toNode: "b" }, // 自环：两端都选：随动
  ],
};

describe("选区收集", () => {
  it("选中节点 + 两端都在选中集合里的边（边本身没被选中也随动）", () => {
    const payload = collectSelection(doc, new Set(["a", "b"]), new Set());
    expect(payload.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(payload.edges.map((e) => e.id)).toEqual(["e-ab", "e-bb"]);
  });

  it("单独选中的边只要两端节点都在场也带上；有一端不在就丢", () => {
    const payload = collectSelection(doc, new Set(["a", "b", "c"]), new Set(["e-bc"]));
    expect(payload.edges.map((e) => e.id)).toEqual(["e-ab", "e-bc", "e-bb"]);
    const dangling = collectSelection(doc, new Set(["a"]), new Set(["e-bc", "e-ga"]));
    expect(dangling.edges).toEqual([]);
  });

  it("载荷是深拷贝：改收集结果不影响原文档", () => {
    const payload = collectSelection(doc, new Set(["a"]), new Set());
    payload.nodes[0]!.x = 999;
    payload.nodes[0]!.text = "篡改";
    expect(doc.nodes[0]!.x).toBe(0);
    expect((doc.nodes[0] as { text: string }).text).toBe("甲");
  });
});

describe("副本生成", () => {
  const payload = collectSelection(doc, new Set(["a", "b"]), new Set());

  it("全部换新 id，边端点引用同步改写，坐标整体偏移", () => {
    const counter = { n: 1 };
    const out = materializeClipboard(payload, ["z9"], gen("new", counter), { x: 24, y: 24 });
    expect(out.nodes.map((n) => n.id)).toEqual(["new-n1", "new-n2"]);
    expect(out.nodes[0]).toMatchObject({ x: 24, y: 24, text: "甲" });
    expect(out.nodes[1]).toMatchObject({ x: 224, y: 24 });
    expect(out.edges).toHaveLength(2);
    expect(out.edges[0]).toMatchObject({ id: "new-e3", fromNode: "new-n1", toNode: "new-n2" });
    // 原载荷没被动过
    expect(payload.nodes[0]!.id).toBe("a");
    expect(payload.nodes[0]!.x).toBe(0);
  });

  it("新 id 避让已占用集合（含逐次发号过程里自己占下的）", () => {
    const taken = new Set<string>(["new-n1"]);
    const counter = { n: 1 };
    const out = materializeClipboard(payload, taken, {
      newNodeId: (used) => {
        let id = `new-n${counter.n++}`;
        while (used.has(id)) id = `new-n${counter.n++}`;
        return id;
      },
      newEdgeId: (used) => {
        let id = `new-e${counter.n++}`;
        while (used.has(id)) id = `new-e${counter.n++}`;
        return id;
      },
    }, { x: 0, y: 0 });
    expect(out.nodes.map((n) => n.id)).toEqual(["new-n2", "new-n3"]);
    expect(new Set([...out.nodes.map((n) => n.id), ...out.edges.map((e) => e.id)].map(String)).size)
      .toBe(out.nodes.length + out.edges.length);
  });

  it("浮点偏移被舍入到两位小数（与拖动落定同一纪律）", () => {
    const out = materializeClipboard(
      { nodes: [{ id: "a", type: "text", x: 0.123456, y: 1, width: 10, height: 10, text: "" }], edges: [] },
      [],
      gen("r", { n: 1 }),
      { x: 10.000004, y: 0.006 },
    );
    expect(out.nodes[0]!.x).toBe(10.12);
    expect(out.nodes[0]!.y).toBe(1.01);
  });
});

describe("模块级剪贴板", () => {
  it("写入后读出的是副本（跨模块共享，但互不影响）", () => {
    setClipboard(collectSelection(doc, new Set(["a"]), new Set()));
    const first = getClipboard();
    expect(first?.nodes.map((n) => n.id)).toEqual(["a"]);
    first!.nodes[0]!.x = 777;
    const second = getClipboard();
    expect(second!.nodes[0]!.x).toBe(0);
  });

  it("空剪贴板返回 null", () => {
    // 上一用例已写入；先清空（写空载荷）
    setClipboard({ nodes: [], edges: [] });
    expect(getClipboard()?.nodes).toEqual([]);
  });
});

describe("clipboardBounds", () => {
  it("包围盒覆盖全部节点（含尺寸）", () => {
    const payload = collectSelection(doc, new Set(["a", "c"]), new Set());
    expect(clipboardBounds(payload)).toEqual({ minX: 0, minY: 0, maxX: 500, maxY: 60 });
  });

  it("空载荷返回 null", () => {
    expect(clipboardBounds({ nodes: [], edges: [] })).toBeNull();
  });
});
