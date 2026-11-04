/**
 * 卡片 Markdown 的渲染契约。node 环境下没有 DOM，DOMPurify 不生效（`sanitizeHtml` 原样返回），
 * 所以这里只断言 markdown-it 这一层产出的 HTML 字符串。
 */
import { describe, expect, it } from "vitest";
import { CARD_PREVIEW_LIMIT, notePreviewSource, renderNoteCard, renderTextCard } from "./cardMarkdown";

describe("文本卡 Markdown", () => {
  it("加粗、列表照常渲染；单个回车是换行", () => {
    const html = renderTextCard("**加粗**\n第二行\n\n- 一\n- 二");
    expect(html).toContain("<strong>加粗</strong>");
    expect(html).toContain("<br>");
    expect(html.match(/<li>/g)).toHaveLength(2);
  });

  it("[[双链]]：目标在 data-wiki 上，带 nodrag，别名与 #标题 只影响显示", () => {
    const html = renderTextCard("见 [[读书笔记]]、[[项目/计划|计划]] 和 [[周报#本周]]");
    const links = [...html.matchAll(/<a ([^>]*)>([^<]*)<\/a>/g)];
    expect(links.map((match) => /data-wiki="([^"]*)"/.exec(match[1])?.[1])).toEqual(["读书笔记", "项目/计划", "周报"]);
    expect(links.map((match) => match[2])).toEqual(["读书笔记", "计划", "周报#本周"]);
    for (const match of links) expect(match[1]).toMatch(/class="[^"]*\bnodrag\b/);
  });

  it("代码里的 [[...]] 不当双链", () => {
    const html = renderTextCard("`[[不是链接]]`");
    expect(html).not.toContain("<a");
    expect(html).toContain("<code>[[不是链接]]</code>");
  });

  it("双链里的尖括号被转义（不能借双链塞 HTML）", () => {
    const html = renderTextCard('[[a" onclick="x|<b>粗</b>]]');
    expect(html).not.toContain("<b>");
    expect(html).not.toContain('" onclick="x"');
  });

  it("普通链接与自动识别的网址也带 nodrag", () => {
    const html = renderTextCard("[官网](https://example.com) https://example.org");
    const opens = html.match(/<a [^>]*>/g) ?? [];
    expect(opens).toHaveLength(2);
    for (const open of opens) expect(open).toMatch(/class="[^"]*\bnodrag\b/);
  });
});

describe("文件卡正文", () => {
  const note = "---\ntags: [a]\n---\n# 标题\n\n开头\n\n## 第一节\n\n一的内容\n\n### 小节\n\n小节内容\n\n## 第二节\n\n二的内容\n";

  it("去掉 front matter；单个回车不换行（与导出一致）", () => {
    const { text } = notePreviewSource(note);
    expect(text.startsWith("# 标题")).toBe(true);
    expect(renderNoteCard("一行\n同一段")).not.toContain("<br>");
  });

  it("#标题 只取那一节（含下级标题，到同级标题为止）", () => {
    const { text } = notePreviewSource(note, "#第一节");
    expect(text).toContain("一的内容");
    expect(text).toContain("小节内容");
    expect(text).not.toContain("二的内容");
    expect(text).not.toContain("开头");
  });

  it("嵌套写法取最后一段；找不到标题或是块引用就退回整篇", () => {
    expect(notePreviewSource(note, "#标题#第二节").text).toContain("二的内容");
    expect(notePreviewSource(note, "#第二节").text).not.toContain("一的内容");
    expect(notePreviewSource(note, "#没有这节").text).toContain("开头");
    expect(notePreviewSource(note, "#^abc123").text).toContain("开头");
  });

  it("太长就截断并告诉调用方", () => {
    const long = "字".repeat(CARD_PREVIEW_LIMIT + 10);
    const result = notePreviewSource(long);
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(CARD_PREVIEW_LIMIT);
    expect(notePreviewSource("短").truncated).toBe(false);
  });
});
