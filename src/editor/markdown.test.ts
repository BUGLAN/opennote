import { describe, expect, it } from "vitest";
import { markdownSupport } from "./markdown";
import { opennoteParser } from "./mdExtensions";

/** Collect the names of every node in the syntax tree. */
function nodeNames(source: string): string[] {
  const names: string[] = [];
  opennoteParser.parse(source).iterate({
    enter: (node) => {
      names.push(node.name);
    },
  });
  return names;
}

/** Same, but through the CodeMirror language the editor actually uses. */
function cmNodeNames(source: string): string[] {
  const names: string[] = [];
  markdownSupport.language.parser.parse(source).iterate({
    enter: (node) => {
      names.push(node.name);
    },
  });
  return names;
}

function sliceFor(source: string, name: string): string | null {
  let found: string | null = null;
  opennoteParser.parse(source).iterate({
    enter: (node) => {
      if (found === null && node.name === name) found = source.slice(node.from, node.to);
    },
  });
  return found;
}

describe("inline math", () => {
  it("parses $…$ inside a paragraph", () => {
    expect(nodeNames("行内公式 $E = mc^2$ 结束")).toContain("InlineMath");
    expect(sliceFor("行内公式 $E = mc^2$ 结束", "InlineMath")).toBe("$E = mc^2$");
  });

  it("handles latex with braces, backslashes and underscores", () => {
    const source = "值 $\\frac{a_i}{b^2}$ 而已";
    expect(sliceFor(source, "InlineMath")).toBe("$\\frac{a_i}{b^2}$");
  });

  it("does not treat currency or lone dollars as math", () => {
    expect(nodeNames("价格 100$ 和 5 $ 单独出现")).not.toContain("InlineMath");
    expect(nodeNames("$ 空格开头$")).not.toContain("InlineMath");
    expect(nodeNames("结尾是空格 $x $")).not.toContain("InlineMath");
  });

  it("leaves inline code alone", () => {
    expect(nodeNames("用 `$x$` 表示")).not.toContain("InlineMath");
  });

  it("works inside a heading", () => {
    expect(nodeNames("# 标题 $a+b$")).toContain("InlineMath");
  });
});

describe("block math", () => {
  it("parses a single-line $$…$$", () => {
    expect(sliceFor("$$\nE = mc^2\n$$", "MathBlock")).toBe("$$\nE = mc^2\n$$");
  });

  it("parses an inline pair on one line", () => {
    expect(sliceFor("$$E=mc^2$$", "MathBlock")).toBe("$$E=mc^2$$");
  });

  it("stops at the closing fence and leaves the rest of the document alone", () => {
    const source = "引入\n\n$$\na = b\n$$\n\n## 后面的标题\n\n正文段落\n";
    const names = nodeNames(source);
    expect(sliceFor(source, "MathBlock")).toBe("$$\na = b\n$$");
    expect(names).toContain("ATXHeading2");
    expect(names).toContain("Paragraph");
  });

  it("does not swallow a following fence", () => {
    const source = "$$\nx\n$$\n\n```ts\nconst a = 1\n```\n";
    expect(sliceFor(source, "MathBlock")).toBe("$$\nx\n$$");
    expect(nodeNames(source)).toContain("FencedCode");
  });

  it("runs to the end when the fence is never closed", () => {
    const source = "$$\n未闭合\n更多\n";
    expect(sliceFor(source, "MathBlock")?.trimEnd()).toBe(source.trimEnd());
  });

  it("stops an unclosed block at the first blank line (D13)", () => {
    const source = "$$\n\\frac{1}{2}\n\n## 标题\n\n正文段落\n";
    expect(sliceFor(source, "MathBlock")).toBe("$$\n\\frac{1}{2}");
    const names = nodeNames(source);
    expect(names).toContain("ATXHeading2");
    expect(names).toContain("Paragraph");
    // the CodeMirror parser the editor actually uses must agree
    expect(cmNodeNames(source)).toContain("ATXHeading2");
  });

  it("keeps the text after an unclosed block reachable as ordinary blocks (D13)", () => {
    const source = "$$\na = b\n\n- 列表项\n\n```ts\nconst a = 1\n```\n";
    const names = nodeNames(source);
    expect(sliceFor(source, "MathBlock")).toBe("$$\na = b");
    expect(names).toContain("BulletList");
    expect(names).toContain("FencedCode");
  });

  it("an empty line also ends a block whose first line carries the formula (D13)", () => {
    const source = "$$a = b\n\n## 标题\n";
    expect(sliceFor(source, "MathBlock")).toBe("$$a = b");
    expect(nodeNames(source)).toContain("ATXHeading2");
  });

  it("a blank line inside a later-closed block ends it (documented rule)", () => {
    // Keep this documented: an unclosed `$$` stops at the blank line, so a fence
    // that only shows up after a blank line opens a second block. Display math
    // with a blank line inside is a TeX paragraph break, which KaTeX rejects.
    const source = "$$\na\n\nb\n$$\n";
    expect(sliceFor(source, "MathBlock")).toBe("$$\na");
    expect(nodeNames(source)).toContain("Paragraph");
  });
});

describe("highlight", () => {
  it("parses ==text==", () => {
    expect(sliceFor("这是 ==重点== 内容", "Highlight")).toBe("==重点==");
    expect(nodeNames("这是 ==重点== 内容")).toContain("HighlightMark");
  });

  it("ignores a single =", () => {
    expect(nodeNames("这是 =重点= 内容")).not.toContain("Highlight");
  });
});

describe("wiki links", () => {
  it("parses [[标题]]", () => {
    expect(sliceFor("参考 [[会议记录]] 里的结论", "WikiLink")).toBe("[[会议记录]]");
  });

  it("does not swallow ordinary links", () => {
    const names = nodeNames("看 [这个](https://example.com)");
    expect(names).toContain("Link");
    expect(names).not.toContain("WikiLink");
  });

  it("ignores an unclosed bracket pair", () => {
    expect(nodeNames("输入 [[ 触发补全")).not.toContain("WikiLink");
  });
});

describe("gfm extensions are still enabled", () => {
  it("keeps tables, tasks and strikethrough", () => {
    const table = nodeNames("| a | b |\n| - | - |\n| 1 | 2 |\n");
    expect(table).toContain("Table");
    expect(table).toContain("TableHeader");
    expect(nodeNames("- [x] 完成\n")).toContain("TaskMarker");
    expect(nodeNames("~~删掉~~")).toContain("Strikethrough");
  });

  it("keeps fenced code and headings", () => {
    const names = nodeNames("# 标题\n\n```mermaid\ngraph TD\n```\n");
    expect(names).toContain("ATXHeading1");
    expect(names).toContain("FencedCode");
    expect(names).toContain("CodeInfo");
  });
});

describe("inline extensions survive block context", () => {
  it("parses inline math inside a task list item", () => {
    expect(nodeNames("- [ ] 值 $a+b$ 结束\n")).toContain("InlineMath");
  });

  it("parses highlight inside a task list item", () => {
    expect(nodeNames("- [ ] 试试 **加粗**、~~删除线~~ ==高亮== 和 `码`\n")).toContain("Highlight");
  });

  it("parses inline math inside a blockquote", () => {
    expect(nodeNames("> 值 $a+b$ 结束\n")).toContain("InlineMath");
  });

  it("parses wiki links inside a list", () => {
    expect(nodeNames("- 参考 [[笔记]]\n")).toContain("WikiLink");
  });

  it("parses inline math inside a table cell", () => {
    // @lezer/markdown does not run inline parsers inside table cells, so this
    // documents the known limitation rather than a guarantee.
    const names = nodeNames("| a | b |\n| - | - |\n| $x$ | ==y== |\n");
    expect(names).toContain("Table");
    expect(names).toContain("TableCell");
  });
});

describe("the CodeMirror language carries the same extensions", () => {
  it("parses inline math, highlight and wiki links", () => {
    expect(cmNodeNames("公式 $a+b$ 与 ==重点== 和 [[笔记]]")).toEqual(
      expect.arrayContaining(["InlineMath", "Highlight", "WikiLink"]),
    );
  });

  it("parses block math without eating the next block", () => {
    const names = cmNodeNames("$$\nx\n$$\n\n## 标题\n");
    expect(names).toContain("MathBlock");
    expect(names).toContain("ATXHeading2");
  });

  it("keeps GFM behaviour", () => {
    expect(cmNodeNames("- [x] 完成")).toContain("TaskMarker");
    expect(cmNodeNames("| a | b |\n| - | - |\n| 1 | 2 |")).toContain("Table");
  });
});
