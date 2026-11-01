import { describe, expect, it } from "vitest";
import { extractHeadings, findCurrentHeading, findHeadingAtLine, sameOutline } from "./outline";

describe("extractHeadings", () => {
  it("collects atx headings with levels and offsets", () => {
    const md = "# 一\n\n正文\n\n## 二\n### 三\n";
    const headings = extractHeadings(md);
    expect(headings.map((heading) => [heading.level, heading.text])).toEqual([
      [1, "一"],
      [2, "二"],
      [3, "三"],
    ]);
    expect(headings[0].pos).toBe(0);
    expect(headings[2].line).toBe(6);
  });

  it("ignores headings inside fenced code", () => {
    const md = "# 真的\n\n```md\n# 假的\n```\n\n## 也是真的\n";
    expect(extractHeadings(md).map((heading) => heading.text)).toEqual(["真的", "也是真的"]);
  });

  it("strips inline markdown from heading text", () => {
    const md = "## **重点** 与 `code` 和 [链接](https://example.com)\n";
    expect(extractHeadings(md)[0].text).toBe("重点 与 code 和 链接");
  });

  it("handles setext-free documents and empty headings", () => {
    expect(extractHeadings("#\n# \n")).toEqual([]);
  });
});

describe("findCurrentHeading", () => {
  it("returns the heading above the cursor", () => {
    const headings = extractHeadings("# a\n\ntext\n\n## b\n\nmore\n");
    expect(findCurrentHeading(headings, 0)).toBe(0);
    expect(findCurrentHeading(headings, 6)).toBe(0);
    expect(findCurrentHeading(headings, 14)).toBe(1);
  });

  it("returns -1 before the first heading", () => {
    const headings = extractHeadings("intro\n\n# a\n");
    expect(findCurrentHeading(headings, 0)).toBe(-1);
  });
});

describe("findHeadingAtLine", () => {
  it("returns the nearest heading at or above the line", () => {
    const headings = extractHeadings("intro\n\n# a\n\ntext\n\n## b\n");
    expect(findHeadingAtLine(headings, 1)).toBe(-1);
    expect(findHeadingAtLine(headings, 3)).toBe(0);
    expect(findHeadingAtLine(headings, 6)).toBe(0);
    expect(findHeadingAtLine(headings, 7)).toBe(1);
    expect(findHeadingAtLine(headings, 99)).toBe(1);
  });
});

describe("sameOutline", () => {
  const base = "# a\n\n正文\n\n## b\n";

  it("ignores offset shifts from typing above a heading", () => {
    // 同一行里多打了字：下面标题的 pos 变了，行号 / 文字 / 级别都没变 —— 大纲不用重画。
    const before = extractHeadings(base);
    const after = extractHeadings("# a\n\n正文多打了几个字\n\n## b\n");
    expect(after[1].pos).not.toBe(before[1].pos);
    expect(sameOutline(before, after)).toBe(true);
  });

  it("detects changed text, level, line and count", () => {
    const before = extractHeadings(base);
    expect(sameOutline(before, extractHeadings("# a\n\n正文\n\n## c\n"))).toBe(false);
    expect(sameOutline(before, extractHeadings("# a\n\n正文\n\n### b\n"))).toBe(false);
    expect(sameOutline(before, extractHeadings("# a\n\n正文\n\n\n## b\n"))).toBe(false);
    expect(sameOutline(before, extractHeadings("# a\n"))).toBe(false);
  });
});
