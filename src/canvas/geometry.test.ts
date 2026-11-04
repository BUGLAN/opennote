/**
 * 画布几何纯函数测试：分组子节点判定、打包包围盒、拖线建卡落点、粘贴文本分类。
 */
import { describe, expect, it } from "vitest";
import { GROUP_PADDING, classifyPastedText, groupBoundsAround, groupChildren, placeForConnectionDrop } from "./geometry";

describe("groupChildren", () => {
  const rects = [
    { id: "g", x: 0, y: 0, width: 400, height: 300 },
    { id: "inner", x: 20, y: 40, width: 100, height: 80 },
    { id: "edge", x: 300, y: 220, width: 100, height: 80 },
    { id: "half", x: 350, y: 0, width: 100, height: 80 },
    { id: "out", x: 500, y: 0, width: 100, height: 80 },
    { id: "g2", x: 10, y: 150, width: 200, height: 140 },
    { id: "nested", x: 20, y: 180, width: 80, height: 60 },
  ];

  it("完整框在里面的才算子节点（贴边算，压线不算），嵌套分组连同孙节点一起收", () => {
    expect([...groupChildren(rects, new Set(["g"]), new Set(["g"]))].sort()).toEqual(["edge", "g2", "inner", "nested"]);
  });

  it("本来就在被拖的选区里的节点不重复收（React Flow 自己会移它们）", () => {
    expect([...groupChildren(rects, new Set(["g"]), new Set(["g", "inner"]))].sort()).toEqual(["edge", "g2", "nested"]);
  });

  it("多个分组同时拖：取并集，被拖的分组自己不当子节点", () => {
    expect([...groupChildren(rects, new Set(["g", "g2"]), new Set(["g", "g2"]))].sort()).toEqual(["edge", "inner", "nested"]);
  });
});

describe("groupBoundsAround", () => {
  it("包围盒外扩留白，上边多留给分组名", () => {
    const bounds = groupBoundsAround([
      { id: "a", x: 100, y: 100, width: 200, height: 100 },
      { id: "b", x: 400, y: 250, width: 100, height: 50 },
    ]);
    expect(bounds).toEqual({
      x: 100 - GROUP_PADDING.side,
      y: 100 - GROUP_PADDING.top,
      width: 400 + GROUP_PADDING.side * 2,
      height: 200 + GROUP_PADDING.top + GROUP_PADDING.bottom,
    });
  });

  it("空输入返回 null", () => {
    expect(groupBoundsAround([])).toBeNull();
  });
});

describe("placeForConnectionDrop", () => {
  const size = { width: 260, height: 160 };
  const point = { x: 1000, y: 500 };

  it("从右桩拖出：新卡左边中点落在松手点，吸附左侧", () => {
    expect(placeForConnectionDrop("right", point, size)).toEqual({ x: 1000, y: 420, toSide: "left" });
  });

  it("其余三个方向同理", () => {
    expect(placeForConnectionDrop("left", point, size)).toEqual({ x: 740, y: 420, toSide: "right" });
    expect(placeForConnectionDrop("bottom", point, size)).toEqual({ x: 870, y: 500, toSide: "top" });
    expect(placeForConnectionDrop("top", point, size)).toEqual({ x: 870, y: 340, toSide: "bottom" });
  });
});

describe("classifyPastedText", () => {
  it("单独一个 http(s) 网址 → 网页卡", () => {
    expect(classifyPastedText("  https://example.com/a?b=1 \n")).toEqual({ kind: "link", url: "https://example.com/a?b=1" });
  });

  it("网址夹在文字里、或别的协议 → 文本卡；换行统一成 \\n，首尾空行去掉", () => {
    expect(classifyPastedText("看这个 https://example.com")).toEqual({ kind: "text", text: "看这个 https://example.com" });
    expect(classifyPastedText("ftp://example.com")).toEqual({ kind: "text", text: "ftp://example.com" });
    expect(classifyPastedText("\r\n  第一行\r\n第二行\r\n\r\n")).toEqual({ kind: "text", text: "  第一行\n第二行" });
  });

  it("空白 → null", () => {
    expect(classifyPastedText(" \n\t")).toBeNull();
  });
});
