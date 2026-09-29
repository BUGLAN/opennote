import { describe, expect, it } from "vitest";
import { fuzzyMatch, fuzzyRank, highlightRanges } from "./fuzzy";

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
