import { describe, expect, it } from "vitest";
import { renderReadingMarkdown } from "./readingMarkdown";
import { renderMarkdown } from "./markdown";

describe("renderReadingMarkdown", () => {
  it("行内公式渲染成占位，原文留在 data-tex 里", () => {
    const html = renderReadingMarkdown("质能 $E = mc^2$ 方程");
    expect(html).toContain('<span class="md-math" data-tex="E = mc^2">E = mc^2</span>');
  });

  it("与编辑器同一条边界：`$ x$`、`$x $`、货币写法不算公式", () => {
    expect(renderReadingMarkdown("价格 $ 5 和 $10")).not.toContain("md-math");
    expect(renderReadingMarkdown("a $x $ b")).not.toContain("md-math");
    expect(renderReadingMarkdown("转义 \\$x$ 不算")).not.toContain("md-math");
  });

  it("单行与多行块公式", () => {
    expect(renderReadingMarkdown("$$a+b$$")).toContain('<div class="md-math math-block" data-tex="a+b">');
    const multi = renderReadingMarkdown("$$\n\\int_0^1 x\\,dx\n= \\frac12\n$$\n\n后文");
    expect(multi).toContain('data-tex="\\int_0^1 x\\,dx\n= \\frac12"');
    expect(multi).toContain("<p>后文</p>");
  });

  it("没收尾的块公式停在空行，后面的段落不被吞掉", () => {
    const html = renderReadingMarkdown("$$\nx^2\n\n# 标题\n\n正文");
    expect(html).toContain('data-tex="x^2"');
    expect(html).toContain("<h1>标题</h1>");
    expect(html).toContain("<p>正文</p>");
  });

  it("mermaid 围栏渲染成图表占位，其他围栏照旧是代码块", () => {
    const html = renderReadingMarkdown("```mermaid\ngraph TD\n  A-->B\n```\n\n```js\nlet a = 1 < 2;\n```");
    expect(html).toContain('<div class="mermaid-block" data-mermaid="">graph TD\n  A--&gt;B\n</div>');
    expect(html).toContain('<code class="language-js">let a = 1 &lt; 2;\n</code>');
  });

  it("代码里的 $ 不当公式", () => {
    expect(renderReadingMarkdown("`$a$`")).toBe("<p><code>$a$</code></p>\n");
  });

  it("其余与导出管线一致", () => {
    const source = "# 标题\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n![图](a.assets/x.png)";
    expect(renderReadingMarkdown(source)).toBe(renderMarkdown(source));
  });
});
