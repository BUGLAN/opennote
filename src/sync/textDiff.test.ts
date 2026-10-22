/**
 * 行级 diff 与「仅格式不同」的用例（`textDiff.ts`）。
 *
 * 这些用例守的是**判定边界**：什么算「其实一样」，什么**不**算。
 * 判宽了会静默吞掉用户真实的改动，判窄了会让「只差换行符」永远挂在冲突列表里。
 */
import { describe, expect, it } from "vitest";
import { diffLines, diffStats, isSameUpToFormatting, normalizeFormatting, stripBom } from "./textDiff";

describe("仅格式不同", () => {
  it("完全一样 ⇒ 相同", () => {
    expect(isSameUpToFormatting("# 标题\n正文", "# 标题\n正文")).toBe(true);
  });

  it("只差换行符（CRLF / LF）⇒ 相同", () => {
    expect(isSameUpToFormatting("# 标题\r\n正文\r\n", "# 标题\n正文\n")).toBe(true);
  });

  it("只差 BOM ⇒ 相同", () => {
    expect(isSameUpToFormatting("\uFEFF# 标题", "# 标题")).toBe(true);
  });

  it("只差文件末尾的空行 ⇒ 相同", () => {
    expect(isSameUpToFormatting("# 标题\n\n", "# 标题")).toBe(true);
  });

  it("★ 行尾两个空格**有语义**（Markdown 硬换行）⇒ 不算相同", () => {
    expect(isSameUpToFormatting("第一行  \n第二行", "第一行\n第二行")).toBe(false);
  });

  it("★ 缩进不同 ⇒ 不算相同", () => {
    expect(isSameUpToFormatting("  - 条目", "- 条目")).toBe(false);
  });

  it("★ 多一个字 ⇒ 不算相同", () => {
    expect(isSameUpToFormatting("# 标题", "# 标题！")).toBe(false);
  });
});

describe("normalizeFormatting / stripBom", () => {
  it("归一之后不再有 BOM 与 CR", () => {
    expect(normalizeFormatting("\uFEFFa\r\nb\r\n")).toBe("a\nb");
  });

  it("stripBom 只删开头那一个", () => {
    expect(stripBom("\uFEFFa\uFEFF")).toBe("a\uFEFF");
    expect(stripBom("a")).toBe("a");
  });
});

describe("diffLines", () => {
  it("行级对齐：改一行只报一行增 + 一行删", () => {
    const rows = diffLines("a\nb\nc", "a\nB\nc");
    expect(diffStats(rows)).toEqual({ added: 1, removed: 1 });
    expect(rows.filter((row) => row.kind === "same").map((row) => row.text)).toEqual(["a", "c"]);
  });

  it("del = 本机有、远端没有；add = 远端有、本机没有", () => {
    const rows = diffLines("共同\n只有本机", "共同\n只有远端");
    expect(rows.find((row) => row.text === "只有本机")?.kind).toBe("del");
    expect(rows.find((row) => row.text === "只有远端")?.kind).toBe("add");
  });

  it("完全一样 ⇒ 全是 same，改动数为 0", () => {
    const rows = diffLines("x\ny", "x\ny");
    expect(diffStats(rows)).toEqual({ added: 0, removed: 0 });
  });

  it("纯追加 / 纯删除", () => {
    expect(diffStats(diffLines("a", "a\nb"))).toEqual({ added: 1, removed: 0 });
    expect(diffStats(diffLines("a\nb", "a"))).toEqual({ added: 0, removed: 1 });
  });

  it("CRLF 与 LF 混着也能对齐（否则「只差换行符」会显示成整篇重写）", () => {
    const rows = diffLines("a\r\nb", "a\nb");
    expect(diffStats(rows)).toEqual({ added: 0, removed: 0 });
  });
});
