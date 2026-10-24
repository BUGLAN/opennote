/**
 * `parseCanvas` / `serializeCanvas` 的契约测试：合法往返、容错（任何输入不抛）、
 * 未知类型与未知字段的保留、字段序稳定（往返幂等的根基）。
 */
import { describe, expect, it } from "vitest";
import { parseCanvas, serializeCanvas } from "./jsonCanvas";
import type { CanvasDocument, CanvasFileNode, CanvasGroupNode, CanvasLinkNode, CanvasTextNode } from "./types";
import { isCanvasFileNode, isCanvasGroupNode, isCanvasLinkNode, isCanvasTextNode, isCanvasUnknownNode } from "./types";

function textNode(over: Partial<CanvasTextNode> = {}): CanvasTextNode {
  return { id: "n1", type: "text", x: 0, y: 0, width: 120, height: 60, text: "你好", ...over };
}

function fileNode(over: Partial<CanvasFileNode> = {}): CanvasFileNode {
  return { id: "n2", type: "file", x: 200, y: 0, width: 240, height: 120, file: "笔记/a.md", ...over };
}

function linkNode(over: Partial<CanvasLinkNode> = {}): CanvasLinkNode {
  return { id: "n4", type: "link", x: 0, y: 300, width: 260, height: 120, url: "https://example.com", ...over };
}

function groupNode(over: Partial<CanvasGroupNode> = {}): CanvasGroupNode {
  return { id: "n5", type: "group", x: -20, y: -40, width: 400, height: 300, ...over };
}

const sample: CanvasDocument = {
  nodes: [
    textNode(),
    fileNode({ color: "6", subpath: "#第二节" }),
    linkNode({ color: "2" }),
    groupNode({ label: "评审" }),
    // 未知类型 + 乱序字段：必须原样保留（含缺失的几何字段不补不删）。
    { id: "n3", type: "video", url: "https://example.com", y: 5 },
  ],
  edges: [
    {
      id: "e1",
      fromNode: "n1",
      fromSide: "right",
      toNode: "n2",
      toSide: "left",
      label: "连",
      color: "3",
      // 偏离缺省（fromEnd 缺省 none / toEnd 缺省 arrow）才落盘的字段。
      toEnd: "none",
    },
    // 已知可选字段的越界值（fromSide 不是四个方向之一；toEnd 不是 none/arrow）
    // 也要保留 —— 走 cast 进样本，「类型不洗值」正是本用例要验证的运行时行为。
    {
      id: "e2",
      fromNode: "n1",
      toNode: "n3",
      fromSide: 42,
      fromEnd: "arrow",
      toEnd: "wibble",
      custom: true,
    } as unknown as CanvasDocument["edges"][number],
  ],
};

describe("parseCanvas / serializeCanvas", () => {
  it("合法文档：parse 全部字段，serialize 字段序固定（黄金字符串）", () => {
    const text = serializeCanvas(sample);
    expect(text).toBe(
      [
        "{",
        '  "nodes": [',
        "    {",
        '      "id": "n1",',
        '      "type": "text",',
        '      "x": 0,',
        '      "y": 0,',
        '      "width": 120,',
        '      "height": 60,',
        '      "text": "你好"',
        "    },",
        "    {",
        '      "id": "n2",',
        '      "type": "file",',
        '      "x": 200,',
        '      "y": 0,',
        '      "width": 240,',
        '      "height": 120,',
        '      "file": "笔记/a.md",',
        '      "color": "6",',
        '      "subpath": "#第二节"',
        "    },",
        "    {",
        '      "id": "n4",',
        '      "type": "link",',
        '      "x": 0,',
        '      "y": 300,',
        '      "width": 260,',
        '      "height": 120,',
        '      "url": "https://example.com",',
        '      "color": "2"',
        "    },",
        "    {",
        '      "id": "n5",',
        '      "type": "group",',
        '      "x": -20,',
        '      "y": -40,',
        '      "width": 400,',
        '      "height": 300,',
        '      "label": "评审"',
        "    },",
        "    {",
        '      "id": "n3",',
        '      "type": "video",',
        '      "url": "https://example.com",',
        '      "y": 5',
        "    }",
        "  ],",
        '  "edges": [',
        "    {",
        '      "id": "e1",',
        '      "fromNode": "n1",',
        '      "fromSide": "right",',
        '      "toNode": "n2",',
        '      "toSide": "left",',
        '      "label": "连",',
        '      "color": "3",',
        '      "toEnd": "none"',
        "    },",
        "    {",
        '      "id": "e2",',
        '      "fromNode": "n1",',
        '      "toNode": "n3",',
        '      "fromEnd": "arrow",',
        '      "fromSide": 42,',
        '      "toEnd": "wibble",',
        '      "custom": true',
        "    }",
        "  ]",
        "}",
        "",
      ].join("\n"),
    );
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });

  it("往返幂等：serialize(parse(serialize(x))) === serialize(x)", () => {
    const once = serializeCanvas(sample);
    const twice = serializeCanvas(parseCanvas(once).doc);
    expect(twice).toBe(once);
    // 反方向也稳：parse(serialize(parse(text))) 与 parse(text) 语义等价（再序列化后逐字节相同）。
    const raw = JSON.stringify({
      nodes: [{ id: "a", type: "text", x: 1, y: 2, width: 3, height: 4, text: "t", z: 1 }],
      edges: [],
    });
    const first = parseCanvas(raw);
    const second = parseCanvas(serializeCanvas(first.doc));
    expect(serializeCanvas(second.doc)).toBe(serializeCanvas(first.doc));
  });

  it("非法 JSON：空文档 + 带 line 的整篇级 error（ref 缺省），不抛异常", () => {
    const bad = '{\n  "nodes": [\n    {"id": }\n  ]\n}';
    const result = parseCanvas(bad);
    expect(result.doc).toEqual({ nodes: [], edges: [] });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.line).toBe(3);
    expect(result.errors[0]?.ref).toBeUndefined();
  });

  it("对任何输入都不抛异常（根不是对象 / 空串 / 数组 / null）", () => {
    for (const input of ["", "42", "null", "[]", '"x"', "{oops", "\x00\x01"]) {
      const result = parseCanvas(input);
      expect(result.doc).toEqual({ nodes: [], edges: [] });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.every((error) => error.ref === undefined)).toBe(true);
    }
  });

  it("单个节点/边缺必填字段：跳过该项并记 ref，不毁整篇", () => {
    const result = parseCanvas(
      JSON.stringify({
        nodes: [
          { type: "text", x: 1, y: 1, width: 1, height: 1, text: "缺 id" },
          { id: "t", type: "text", x: "a", y: 1, width: 1, height: 1, text: "x 不是数字" },
          { id: "f", type: "file", x: 1, y: 1, width: 1, height: 1 },
          { id: "l", type: "link", x: 1, y: 1, width: 1, height: 1 },
          { id: "g", type: "group", x: 1, width: 1, height: 1 },
          { id: "ok", type: "text", x: 1, y: 1, width: 1, height: 1, text: "" },
          "不是对象",
        ],
        edges: [{ id: "e", fromNode: "ok" }, { id: "e2", fromNode: "ok", toNode: "nope" }],
      }),
    );
    expect(result.doc.nodes.map((node) => node.id)).toEqual(["ok"]);
    expect(result.doc.edges.map((edge) => edge.id)).toEqual(["e2"]);
    expect(result.errors.map((error) => error.ref)).toEqual([
      "nodes[0]",
      "nodes[1]",
      "nodes[2]",
      "nodes[3]",
      "nodes[4]",
      "nodes[6]",
      "edges[0]",
    ]);
  });

  it("link 缺 url（或 url 非字符串）整节点跳过；group 无额外必填字段、label 可缺", () => {
    const result = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: "bad1", type: "link", x: 0, y: 0, width: 10, height: 10 },
          { id: "bad2", type: "link", x: 0, y: 0, width: 10, height: 10, url: "" },
          { id: "bad3", type: "link", x: 0, y: 0, width: 10, height: 10, url: 42 },
          { id: "ok-link", type: "link", x: 0, y: 0, width: 10, height: 10, url: "https://a.dev" },
          { id: "ok-group", type: "group", x: 1, y: 2, width: 30, height: 40 },
          { id: "grp-label", type: "group", x: 1, y: 2, width: 30, height: 40, label: "容器" },
        ],
        edges: [],
      }),
    );
    expect(result.doc.nodes.map((node) => node.id)).toEqual(["ok-link", "ok-group", "grp-label"]);
    expect(result.errors.map((error) => error.ref)).toEqual(["nodes[0]", "nodes[1]", "nodes[2]"]);
    const group = result.doc.nodes[1]!;
    expect(isCanvasGroupNode(group)).toBe(true);
    expect("label" in group).toBe(false);
  });

  it("nodes/edges 顶层缺失视为空数组；类型不对记整篇级 ref", () => {
    const empty = parseCanvas("{}");
    expect(empty.doc).toEqual({ nodes: [], edges: [] });
    expect(empty.errors).toEqual([]);

    const badShape = parseCanvas('{"nodes": 3, "edges": {}}');
    expect(badShape.doc).toEqual({ nodes: [], edges: [] });
    expect(badShape.errors.map((error) => error.ref)).toEqual(["nodes", "edges"]);
  });

  it("未知节点 type 与未知字段原样保留（type 原文 + 全部字段 + 键序）", () => {
    const raw = '{"nodes":[{"z":1,"type":"embed","id":"g","label":"组","x":8}],"edges":[]}';
    const { doc, errors } = parseCanvas(raw);
    expect(errors).toEqual([]);
    expect(doc.nodes).toHaveLength(1);
    const unknown = doc.nodes[0]!;
    expect(isCanvasUnknownNode(unknown)).toBe(true);
    expect(unknown.type).toBe("embed");
    // 序列化保持源文档键序（z 在 type 前）、一个字段不丢；美化格式不影响键序。
    const once = serializeCanvas(doc);
    expect(Object.keys(JSON.parse(once).nodes[0])).toEqual(["z", "type", "id", "label", "x"]);
    // 幂等：再走 parse→serialize 一轮，逐字节相同。
    const twice = serializeCanvas(parseCanvas(once).doc);
    expect(twice).toBe(once);
  });

  it("已知节点也保留未知字段（排在类型字段之后、按原插入序）", () => {
    const raw =
      '{"nodes":[{"id":"a","type":"file","x":0,"y":0,"width":1,"height":1,"file":"a.md","color":"5","subpath":"#x","style":{"b":2}}],"edges":[]}';
    const { doc, errors } = parseCanvas(raw);
    expect(errors).toEqual([]);
    const node = doc.nodes[0]!;
    expect(isCanvasFileNode(node)).toBe(true);
    if (isCanvasFileNode(node)) {
      expect(node.file).toBe("a.md");
      expect(node.subpath).toBe("#x");
    }
    const once = serializeCanvas(doc);
    expect(Object.keys(JSON.parse(once).nodes[0])).toEqual([
      "id",
      "type",
      "x",
      "y",
      "width",
      "height",
      "file",
      "color",
      "subpath",
      "style",
    ]);
    expect(JSON.parse(once).nodes[0].style).toEqual({ b: 2 });
    expect(serializeCanvas(parseCanvas(once).doc)).toBe(once);
  });

  it("旧文件里的 link/group（乱序字段）：升级为已知类型后按范式序重排，字段不丢", () => {
    // 这是预期行为变化：MVP 期它们是「未知类型、原样保留」，现在是已知类型，
    // 序列化按 id,type,x,y,width,height,类型字段 的范式序输出。
    const raw = JSON.stringify({
      nodes: [
        { url: "https://x.dev", id: "l1", type: "link", width: 10, height: 20, y: 2, x: 1 },
        { label: "G", height: 30, id: "g1", type: "group", width: 40, y: 3, x: 2 },
      ],
      edges: [],
    });
    const { doc, errors } = parseCanvas(raw);
    expect(errors).toEqual([]);
    const once = serializeCanvas(doc);
    const parsed = JSON.parse(once);
    expect(Object.keys(parsed.nodes[0])).toEqual(["id", "type", "x", "y", "width", "height", "url"]);
    expect(Object.keys(parsed.nodes[1])).toEqual(["id", "type", "x", "y", "width", "height", "label"]);
    expect(serializeCanvas(parseCanvas(once).doc)).toBe(once);
  });

  it("边的 color/fromEnd/toEnd：合法值占槽位，越界值退到未知字段区原样保留", () => {
    const raw = JSON.stringify({
      nodes: [textNode()],
      edges: [
        { id: "a", fromNode: "n1", toNode: "n1", color: "#ff8800", fromEnd: "arrow", toEnd: "none" },
        { id: "b", fromNode: "n1", toNode: "n1", color: 7, fromEnd: "both", toEnd: [] },
      ],
    });
    const { doc, errors } = parseCanvas(raw);
    expect(errors).toEqual([]);
    const once = serializeCanvas(doc);
    const edges = JSON.parse(once).edges as Record<string, unknown>[];
    expect(Object.keys(edges[0]!)).toEqual(["id", "fromNode", "toNode", "color", "fromEnd", "toEnd"]);
    // 越界值不丢：跟着边走，排在已知字段之后（源插入序）。
    expect(Object.keys(edges[1]!)).toEqual(["id", "fromNode", "toNode", "color", "fromEnd", "toEnd"]);
    expect(edges[1]!.color).toBe(7);
    expect(edges[1]!.fromEnd).toBe("both");
    expect(serializeCanvas(parseCanvas(once).doc)).toBe(once);
  });

  it("类型守卫：五种节点各归各位", () => {
    const { doc } = parseCanvas(serializeCanvas(sample));
    expect(doc.nodes.filter(isCanvasTextNode).map((n) => n.id)).toEqual(["n1"]);
    expect(doc.nodes.filter(isCanvasFileNode).map((n) => n.id)).toEqual(["n2"]);
    expect(doc.nodes.filter(isCanvasLinkNode).map((n) => n.id)).toEqual(["n4"]);
    expect(doc.nodes.filter(isCanvasGroupNode).map((n) => n.id)).toEqual(["n5"]);
    expect(doc.nodes.filter(isCanvasUnknownNode).map((n) => n.id)).toEqual(["n3"]);
    expect(doc.edges[0]?.label).toBe("连");
    expect(doc.edges[0]?.color).toBe("3");
  });

  it("空文档的序列化形态固定（createCanvas 的初始内容）", () => {
    expect(serializeCanvas({ nodes: [], edges: [] })).toBe('{\n  "nodes": [],\n  "edges": []\n}\n');
  });
});
