/**
 * `src/lib/htmlPage.ts` 的用例。
 *
 * 这里钉的都是**显示层的一次性判定**：标题取谁、空页面怎么认、摘要怎么截。
 * 渲染正确性不在这里测（渲染走 iframe / Shadow DOM，见 `components/HtmlPageView.tsx`）。
 */
import { describe, expect, it } from "vitest";
import { hasHtmlExtension, htmlExcerpt, htmlFallbackTitle, htmlTitle, htmlToText, isHtmlEmpty, isHtmlPage, pageKindOf } from "./htmlPage";

describe("isHtmlPage / pageKindOf", () => {
  it("认 .html 与 .htm，大小写不敏感", () => {
    expect(isHtmlPage("原型/登录页.html")).toBe(true);
    expect(isHtmlPage("a.htm")).toBe(true);
    expect(isHtmlPage("A.HTML")).toBe(true);
    expect(pageKindOf("a.HTM")).toBe("html");
  });

  it("不认 Markdown、图片、以及看起来像但不是的扩展名", () => {
    for (const path of ["a.md", "a.txt", "a.png", "a.html.bak", "a.htmlx", "html", "a/js"]) {
      expect(isHtmlPage(path), path).toBe(false);
      expect(pageKindOf(path), path).toBe("md");
    }
  });

  it("hasHtmlExtension 与 isHtmlPagePath 同源（导入分流用）", () => {
    expect(hasHtmlExtension("x.html")).toBe(true);
    expect(hasHtmlExtension("x.htm")).toBe(true);
    expect(hasHtmlExtension("x.md")).toBe(false);
    expect(hasHtmlExtension("html")).toBe(false);
  });
});

describe("htmlTitle", () => {
  it("<title> 优先于 <h1>", () => {
    expect(htmlTitle("<html><head><title>登录</title></head><body><h1>欢迎</h1></body></html>")).toBe("登录");
  });

  it("没有 <title> 时用第一个 <h1>", () => {
    expect(htmlTitle("<body><h1>周报</h1><h1>第二节</h1></body>")).toBe("周报");
  });

  it("都没有时回退到调用方给的文件名", () => {
    expect(htmlTitle("<div>正文</div>", "原型页")).toBe("原型页");
  });

  it("实体解码 + 标签剥离 + 空白折叠", () => {
    expect(htmlTitle("<title> A &amp; B\n  <b>粗</b> </title>")).toBe("A & B 粗");
    expect(htmlTitle("<title>&#39;引号&#x27;</title>")).toBe("'引号'");
  });

  it("注释里的 <title> 不算数（否则生成器模板会污染标题）", () => {
    expect(htmlTitle("<!-- <title>模板占位</title> --><title>真的</title>")).toBe("真的");
  });

  it("script 字符串里的 <title> 不算数", () => {
    expect(htmlTitle("<script>const t = '<title>假</title>';</script><title>真</title>")).toBe("真");
  });

  it("超长标题截到 90 字符", () => {
    expect(htmlTitle(`<title>${"长".repeat(200)}</title>`).length).toBe(90);
  });

  it("空白标题（<title></title>）继续往下找 h1", () => {
    expect(htmlTitle("<title>   </title><h1>真标题</h1>")).toBe("真标题");
  });
});

describe("htmlFallbackTitle", () => {
  it("去扩展名、保留目录名之外的部分", () => {
    expect(htmlFallbackTitle("原型/登录页.html")).toBe("登录页");
    expect(htmlFallbackTitle("a.htm")).toBe("a");
  });

  it("空文件名退回「无标题」", () => {
    expect(htmlFallbackTitle(".html")).toBe("无标题");
  });
});

describe("isHtmlEmpty", () => {
  it("空串是空的", () => {
    expect(isHtmlEmpty("")).toBe(true);
    expect(isHtmlEmpty("   \n\t ")).toBe(true);
  });

  it("只有结构壳（含 title 与 head）算空 —— 生成器产出的空壳就是这一种", () => {
    expect(isHtmlEmpty('<!doctype html><html><head><meta charset="utf-8"><title>x</title></head><body></body></html>')).toBe(true);
  });

  it("只有注释 / 只有脚本算空", () => {
    expect(isHtmlEmpty("<!-- 待填 --><div></div>")).toBe(true);
    expect(isHtmlEmpty("<script>console.log('hi')</script>")).toBe(true);
  });

  it("有文字就不空", () => {
    expect(isHtmlEmpty("<p>一点点内容</p>")).toBe(false);
  });

  it("没有文字但有图片 / canvas / video 也不空（全屏海报就是这种页面）", () => {
    for (const tag of ["<img src=x.png>", "<canvas></canvas>", "<svg><rect/></svg>", "<video src=a.mp4></video>", "<iframe src=a.html></iframe>"]) {
      expect(isHtmlEmpty(`<body>${tag}</body>`), tag).toBe(false);
    }
  });

  it("head 里的 style 不会被当成内容", () => {
    expect(isHtmlEmpty("<head><style>body{color:red}</style></head><body></body>")).toBe(true);
  });
});

describe("htmlToText / htmlExcerpt", () => {
  it("块级标签之间留空格，不把相邻段落粘成一个词", () => {
    expect(htmlToText("<p>甲</p><p>乙</p>")).toBe("甲 乙");
    expect(htmlToText("a<br>b")).toBe("a b");
  });

  it("去掉 script / style 的正文", () => {
    expect(htmlToText("<style>.a{}</style><script>var x=1</script><p>真内容</p>")).toBe("真内容");
  });

  it("摘要按码点截断，不把 emoji 劈成孤立代理项", () => {
    const text = htmlExcerpt("<p>😀😀😀😀</p>", 2);
    expect(text).toBe("😀😀…");
    // 截出来的字符串里不该有孤立代理项（能原样往返）
    expect(Array.from(text).length).toBe(3);
  });

  it("短文本不加省略号", () => {
    expect(htmlExcerpt("<p>短</p>", 10)).toBe("短");
  });

  it("空页面给出空串（调用方据此显示「空页面」而不是一串空白）", () => {
    expect(htmlExcerpt("<!doctype html><html><body></body></html>")).toBe("");
  });
});
