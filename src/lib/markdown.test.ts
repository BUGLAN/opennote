/**
 * `renderMarkdown()` 的**目标编码**契约（0.4.0 用户实测缺陷的护栏）。
 *
 * markdown-it 的 `normalizeLink` 会把非 ASCII 目标百分号编码：
 * `![x](assets/计算机启动过程/a.png)` → `src="assets/%E8%AE%A1.../a.png"`。
 * 谁拿渲染后的 `<img src>` 去读磁盘，谁就必须先 `decodeMarkdownHref()` ——
 * 否则「编辑器里能显示的图，换成渲染视图就是裂图」。
 */
import { describe, expect, it } from "vitest";
import { resolveWorkspacePath } from "../data/assets";
import { decodeMarkdownHref, renderMarkdown } from "./markdown";

describe("markdown 渲染后的目标编码", () => {
  it("渲染会把中文路径百分号编码（这就是必须解码的原因）", () => {
    const html = renderMarkdown("![x](assets/计算机启动过程/image-1.png)");
    expect(html).toContain("assets/%E8%AE%A1%E7%AE%97%E6%9C%BA");
    expect(html).not.toContain("assets/计算机启动过程/image-1.png");
  });

  it("decodeMarkdownHref 能把编码还原成磁盘上的真实相对路径", () => {
    const html = renderMarkdown("![x](assets/计算机启动过程/image-1.png)");
    const src = /src="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(decodeMarkdownHref(src)).toBe("assets/计算机启动过程/image-1.png");
  });

  it("没有 % 的原样返回；解不动的也原样返回（不许抛）", () => {
    expect(decodeMarkdownHref("assets/plain/a.png")).toBe("assets/plain/a.png");
    expect(decodeMarkdownHref("assets/100%/a.png")).toBe("assets/100%/a.png");
    expect(decodeMarkdownHref("")).toBe("");
  });

  it("ReadingView 的读图链：编码的 src 直接拿去读盘必然读不到（缺陷现场），解码后才对", () => {
    const html = renderMarkdown("![x](assets/计算机启动过程/image-1.png)");
    const src = /src="([^"]+)"/.exec(html)?.[1] ?? "";
    // 缺陷现场：拿渲染出来的 src 当磁盘路径 → 读不到那个文件（磁盘上是中文目录名）
    expect(resolveWorkspacePath(src, "操作系统")).toBe(
      "操作系统/assets/%E8%AE%A1%E7%AE%97%E6%9C%BA%E5%90%AF%E5%8A%A8%E8%BF%87%E7%A8%8B/image-1.png",
    );
    // 修好之后：解码 → 命中磁盘上的真实路径
    expect(resolveWorkspacePath(decodeMarkdownHref(src), "操作系统")).toBe(
      "操作系统/assets/计算机启动过程/image-1.png",
    );
  });
});

describe("换行语义：单个换行就是换行（与编辑器所见一致）", () => {
  it("段落里的单个 `\\n` 渲染成 <br>，而不是被合成一段", () => {
    expect(renderMarkdown("第一行\n第二行")).toContain("第一行<br>");
  });

  it("空行仍然分段", () => {
    expect(renderMarkdown("一段\n\n二段").match(/<p>/g)).toHaveLength(2);
  });
});

describe("扩展语法：与编辑器同一套（高亮 / wiki 链接 / 公式）", () => {
  it("==高亮== → <mark>", () => {
    expect(renderMarkdown("一段 ==重要== 文字")).toContain("<mark>重要</mark>");
  });

  it("[[笔记]] → wikilink span，不是网址", () => {
    expect(renderMarkdown("见 [[笔记]]")).toContain('<span class="wikilink" data-wiki="笔记">笔记</span>');
  });

  it("行内公式与公式块 → 带 data-tex、里面留着原文", () => {
    expect(renderMarkdown("行内 $x^2$ 公式")).toContain('<span class="math" data-tex="x^2">$x^2$</span>');
    expect(renderMarkdown("$$\na+b\n$$")).toContain('<div class="math math-block" data-tex="a+b">');
  });

  it("边界规则与编辑器一致：`$5 和 $` 不是公式；没闭合的公式块不吞后文", () => {
    expect(renderMarkdown("价格 $5 和 $10")).not.toContain("data-tex");
    expect(renderMarkdown("$$\na\n\n## 标题")).toContain("<h2>标题</h2>");
  });

  it("表格单元格里的扩展语法也生效", () => {
    const html = renderMarkdown("| a | b |\n| - | - |\n| ==亮== | $x$ |");
    expect(html).toContain("<mark>亮</mark>");
    expect(html).toContain('data-tex="x"');
  });
});

describe("front matter 不进正文", () => {
  it("文件头的 YAML 不渲染成分隔线 + 二级标题", () => {
    const html = renderMarkdown("---\ntitle: x\n---\n\n# 标题\n");
    expect(html).not.toContain("<hr>");
    expect(html).not.toContain("title: x");
    expect(html).toContain("<h1>标题</h1>");
  });
});
