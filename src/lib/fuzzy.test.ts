import { describe, expect, it } from "vitest";
import { fuzzyMatch, fuzzyRank, highlightRanges, substringRanges } from "./fuzzy";

describe("fuzzyMatch", () => {
  it("matches a subsequence and reports ranges", () => {
    const match = fuzzyMatch("opn", "open note");
    expect(match).not.toBeNull();
    expect(match?.ranges.length).toBeGreaterThan(0);
  });

  it("rejects characters that are missing or out of order", () => {
    expect(fuzzyMatch("zzz", "open note")).toBeNull();
    expect(fuzzyMatch("no", "on")).toBeNull();
  });

  it("scores a prefix match above a scattered match", () => {
    const prefix = fuzzyMatch("note", "note taking")?.score ?? 0;
    const scattered = fuzzyMatch("note", "n-o-t-e scattered")?.score ?? 0;
    expect(prefix).toBeGreaterThan(scattered);
  });

  it("treats an empty query as a match-all", () => {
    expect(fuzzyMatch("  ", "anything")).toEqual({ score: 0, ranges: [] });
  });
});

describe("fuzzyRank", () => {
  const items = ["会议记录", "读书笔记", "note about meetings"];

  it("orders candidates by score", () => {
    const ranked = fuzzyRank("会议", items, (item) => [{ text: item, weight: 1 }]);
    expect(ranked[0].item).toBe("会议记录");
  });

  it("falls back to document order for an empty query", () => {
    const ranked = fuzzyRank("", items, (item) => [{ text: item, weight: 1 }]);
    expect(ranked.map((entry) => entry.item)).toEqual(items);
  });

  it("drops items without a match", () => {
    expect(fuzzyRank("zzz", items, (item) => [{ text: item, weight: 1 }])).toEqual([]);
  });
});

describe("substringRanges", () => {
  it("只认连续的**包含**命中（与 fuzzy 的子序列不是一回事）", () => {
    // 目录选择器与「保存到」的过滤口径是 `includes`，所以高亮也必须按包含来。
    expect(substringRanges("PYTHON WEB FLASK", "op")).toEqual([]);
    expect(substringRanges("gopl-zh", "op")).toEqual([[1, 3]]);
    // 子序列在这里**不算**命中：`glz` 在 `gopl-zh` 里不连续。
    expect(substringRanges("gopl-zh", "glz")).toEqual([]);
  });

  it("大小写不敏感，且所有命中都给出来", () => {
    expect(substringRanges("Chapter1/chapter2", "chapter")).toEqual([
      [0, 7],
      [9, 16],
    ]);
    expect(substringRanges("读书 / 技术", "技术")).toEqual([[5, 7]]);
  });

  it("空关键字（或只有空格）不命中任何地方 —— 全量列表不该整片发亮", () => {
    expect(substringRanges("gopl-zh", "")).toEqual([]);
    expect(substringRanges("gopl-zh", "   ")).toEqual([]);
  });
});

describe("highlightRanges", () => {
  it("splits text around hits", () => {
    const parts = highlightRanges("abcdef", [
      [1, 3],
      [4, 5],
    ]);
    expect(parts).toEqual([
      { text: "a", hit: false },
      { text: "bc", hit: true },
      { text: "d", hit: false },
      { text: "e", hit: true },
      { text: "f", hit: false },
    ]);
  });

  it("returns the whole string when there are no ranges", () => {
    expect(highlightRanges("abc", [])).toEqual([{ text: "abc", hit: false }]);
  });
});
