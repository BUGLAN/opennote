import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../lib/markdown";
import { opennoteParser } from "./mdExtensions";

/**
 * 编辑器（lezer）与渲染管线（markdown-it）对同一段文字的判断必须一致 ——
 * 否则编辑器里是公式 / 高亮 / 元数据，阅读视图与导出里却是别的（审查报告 B8、B5）。
 */
function lezerHas(doc: string, node: string): boolean {
  let found = false;
  opennoteParser.parse(doc).iterate({
    enter: (ref) => {
      if (ref.name === node) found = true;
    },
  });
  return found;
}

const CASES: { doc: string; node: string; html: RegExp; expected: boolean; note: string }[] = [
  { doc: "$$\nx = 1\n$$", node: "MathBlock", html: /math-block/, expected: true, note: "闭合的公式块" },
  { doc: "$$\nx = 1\n\nafter", node: "MathBlock", html: /math-block/, expected: true, note: "没闭合：到空行为止" },
  { doc: "text\n$$\nx\n\nmore", node: "MathBlock", html: /math-block/, expected: true, note: "打断段落" },
  { doc: "$$a$$ tail", node: "MathBlock", html: /math-block/, expected: false, note: "单行但后面还有字" },
  { doc: "$$a$$", node: "MathBlock", html: /math-block/, expected: true, note: "单行公式块" },
  { doc: "一段 ==重点== 文字", node: "Highlight", html: /<mark>/, expected: true, note: "普通高亮" },
  { doc: "a == b == c", node: "Highlight", html: /<mark>/, expected: false, note: "两侧空格不是高亮" },
  { doc: "`==代码==`", node: "Highlight", html: /<mark>/, expected: false, note: "代码里不是高亮" },
  { doc: "---\ntitle: x\n---\n\n正文", node: "FrontMatter", html: /title: x/, expected: true, note: "front matter（渲染里不出现）" },
  { doc: "---\n\n## A\ntext\n\n---\n\n## B", node: "FrontMatter", html: /<h2>A<\/h2>/, expected: false, note: "开头分隔线 + 后面分隔线：不是元数据" },
];

describe("编辑器与渲染管线同一套判断", () => {
  for (const c of CASES) {
    it(c.note, () => {
      expect(lezerHas(c.doc, c.node)).toBe(c.expected);
      const html = renderMarkdown(c.doc);
      // front matter 的特殊之处：是元数据时渲染里**不应**出现那段；不是时正文 A 要在
      if (c.node === "FrontMatter") expect(c.html.test(html)).toBe(!c.expected);
      else expect(c.html.test(html)).toBe(c.expected);
    });
  }

  it("高亮里面照常解析粗体与链接（两边都是）", () => {
    let strong = false;
    opennoteParser.parse("==**粗** [a](http://b)==").iterate({
      enter: (ref) => {
        if (ref.name === "StrongEmphasis") strong = true;
      },
    });
    expect(strong).toBe(true);
    expect(renderMarkdown("==**粗** [a](http://b)==")).toContain("<mark><strong>粗</strong>");
  });

  it("阅读视图不再把 front matter 剥两次（正文开头的分隔线段保留）", () => {
    const html = renderMarkdown("---\ntitle: x\n---\n---\n\n## A\ntext\n\n---\n\n## B");
    expect(html).toContain("<h2>A</h2>");
  });
});
