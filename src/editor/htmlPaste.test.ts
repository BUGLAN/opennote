import { describe, expect, it } from "vitest";
import { htmlToMarkdown, worthConverting, type HtmlNode } from "./htmlPaste";

/** 手搭一棵假的 DOM 树（node 环境里没有 DOMParser）。 */
function h(tag: string, attrs: Record<string, string> | null, ...kids: (HtmlNode | string)[]): HtmlNode {
  const childNodes = kids.map((kid) => (typeof kid === "string" ? text(kid) : kid));
  return {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    childNodes,
    get textContent() {
      return childNodes.map((child) => child.textContent ?? "").join("");
    },
    getAttribute: (name: string) => (attrs && name in attrs ? attrs[name] : null),
  };
}

function text(value: string): HtmlNode {
  return { nodeType: 3, nodeName: "#text", textContent: value, childNodes: [] };
}

const body = (...kids: (HtmlNode | string)[]) => h("body", null, ...kids);

describe("HTML → Markdown（粘贴富文本）", () => {
  it("标题、段落、行内格式、链接", () => {
    const md = htmlToMarkdown(
      body(
        h("h2", null, "小节"),
        h("p", null, "这是 ", h("strong", null, "重点"), " 与 ", h("em", null, " 斜体 "), "，见 ", h("a", { href: "https://a.com" }, "文档"), "。"),
      ),
    );
    expect(md).toBe("## 小节\n\n这是 **重点** 与 *斜体* ，见 [文档](https://a.com)。");
  });

  it("列表（含嵌套、有序起始号、任务项）", () => {
    const md = htmlToMarkdown(
      body(
        h("ul", null, h("li", null, "一", h("ul", null, h("li", null, "一点一"))), h("li", null, h("input", { type: "checkbox", checked: "" }), "完成")),
        h("ol", { start: "3" }, h("li", null, "三"), h("li", null, "四")),
      ),
    );
    expect(md).toBe("- 一\n\n  - 一点一\n- [x] 完成\n\n3. 三\n4. 四");
  });

  it("代码块带语言、行内代码、引用、分隔线", () => {
    const md = htmlToMarkdown(
      body(
        h("pre", null, h("code", { class: "language-js" }, "const a = 1;\n")),
        h("p", null, "用 ", h("code", null, "npm i"), " 安装"),
        h("blockquote", null, h("p", null, "引一句")),
        h("hr", null),
      ),
    );
    expect(md).toBe("```js\nconst a = 1;\n```\n\n用 `npm i` 安装\n\n> 引一句\n\n---");
  });

  it("表格", () => {
    const md = htmlToMarkdown(
      body(h("table", null, h("thead", null, h("tr", null, h("th", null, "名"), h("th", null, "值"))), h("tbody", null, h("tr", null, h("td", null, "a|b"), h("td", null, "1"))))),
    );
    expect(md).toBe("| 名 | 值 |\n| --- | --- |\n| a\\|b | 1 |");
  });

  it("正文里的 Markdown 符号被转义；脚本与样式丢掉；javascript: 链接只留文字", () => {
    const md = htmlToMarkdown(body(h("style", null, "p{}"), h("p", null, "2 * 3 = 6，", h("a", { href: "javascript:alert(1)" }, "点我"))));
    expect(md).toBe("2 \\* 3 = 6，点我");
  });
});

describe("什么时候转", () => {
  it("只有带样式的 div/span（VS Code 之类）不转：转了会丢缩进", () => {
    expect(worthConverting('<div style="color:red"><span>const a = 1;</span></div>')).toBe(false);
  });

  it("我们自己复制出去的 HTML 不转（纯文本那份就是 Markdown 源码）", () => {
    expect(worthConverting('<div data-opennote-md=""><p><strong>x</strong></p></div>')).toBe(false);
  });

  it("有结构的网页内容才转", () => {
    expect(worthConverting("<h2>标题</h2><p>正文</p>")).toBe(true);
  });
});
