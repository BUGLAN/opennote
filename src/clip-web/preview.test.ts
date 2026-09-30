import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { renderMarkdown } from "../lib/markdown";
import { renderPreview } from "./preview";

/**
 * "渲染一致"的判据：预览的输出必须与应用里 `src/lib/markdown.ts` 的输出**逐字相同**。
 * 换一份渲染配置（哪怕只是开了 typographer）就会在这里变红。
 */
describe("renderPreview：和应用同一个渲染器", () => {
  const samples: Record<string, string> = {
    标题: "# 一级标题\n\n## 二级标题\n",
    强调: "正文里有 **粗体**、*斜体* 和 ~~删除线~~。\n",
    表格: "| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n",
    代码: "行内 `code` 与块：\n\n```js\nconst a = 1;\n```\n",
    列表: "- 一\n- 二\n\n1. 甲\n2. 乙\n\n- [x] 做完了\n",
    引用与链接: "> 引用一句\n\n[链接](https://example.com)\n",
  };

  it("每一份样例的输出都与 renderMarkdown 逐字一致", () => {
    for (const [name, source] of Object.entries(samples)) {
      expect(renderPreview(source).html, `样例「${name}」的渲染结果与应用不一致`).toBe(renderMarkdown(source));
    }
  });

  it("真的渲染出了结构，不是把源码原样吐回来", () => {
    const html = renderPreview(samples.标题).html;
    expect(html).toContain("<h1>");
    expect(html).toContain("<h2>");
    expect(renderPreview(samples.表格).html).toContain("<table>");
    expect(renderPreview(samples.强调).html).toContain("<strong>");
    expect(renderPreview(samples.代码).html).toContain("<pre>");
  });

  it("空正文与只有空白的正文都算空（界面显示占位，不渲染空块）", () => {
    expect(renderPreview("")).toEqual({ html: "", empty: true });
    expect(renderPreview("   \n\n  ")).toEqual({ html: "", empty: true });
    expect(renderPreview("# 有内容").empty).toBe(false);
  });
});

/**
 * 一个事实一个产地：页面不许自己 new 一个 MarkdownIt，也不许绕过 DOMPurify。
 * 没有 jsdom（vitest 是 node 环境）时这条只能盯源码，但盯的正是"第二条渲染管线"这个意图。
 */
describe("预览只有一个渲染来源", () => {
  it("preview.ts 从应用的 ../lib/markdown 取渲染器", () => {
    const source = readFileSync(new URL("./preview.ts", import.meta.url), "utf8");
    expect(source).toContain('from "../lib/markdown"');
    expect(source).not.toMatch(/from\s+"(markdown-it|dompurify)"/);
  });
});
