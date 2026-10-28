/**
 * `inlineHtmlResources()`（HTML 页面资源内联的唯一产地）与它的路径判据。
 *
 * 入库（receive）、导入（import）、渲染（HtmlView）、收件箱预览四处都走它，所以这里钉的是
 * 「哪些引用会被改写、改成什么、哪些必须原样不动」—— 尤其是安全边界那几条。
 */
import { describe, expect, it } from "vitest";
import {
  htmlDocumentTitle,
  htmlPlainText,
  htmlResourceMime,
  inlineHtmlResources,
  normalizeResourcePath,
  resolveLocalRef,
  type HtmlResource,
} from "./bundle";

const encoder = new TextEncoder();

function store(files: Record<string, string>) {
  const reads: string[] = [];
  const resolve = (path: string): HtmlResource | null => {
    reads.push(path);
    const text = files[path];
    return text === undefined ? null : { bytes: encoder.encode(text), mime: "application/octet-stream" };
  };
  return { resolve, reads };
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/** 从 `data:<mime>;base64,<...>` 里解出文本。 */
function decodeDataUrl(url: string): { mime: string; text: string } {
  const match = /^data:([^;]+);base64,(.*)$/.exec(url);
  if (!match) throw new Error(`不是 data URL：${url.slice(0, 40)}`);
  return { mime: match[1], text: Buffer.from(match[2], "base64").toString("utf8") };
}

describe("resolveLocalRef（本地资源引用的唯一判据）", () => {
  it("相对路径按目录归一；./ 与 a/../b 都认", () => {
    expect(resolveLocalRef("", "css/a.css")).toBe("css/a.css");
    expect(resolveLocalRef("", "./css/a.css")).toBe("css/a.css");
    expect(resolveLocalRef("css", "../img/x.png")).toBe("img/x.png");
    expect(resolveLocalRef("", "a/b/../c.png")).toBe("a/c.png");
    expect(resolveLocalRef("css", "/img/x.png")).toBe("img/x.png"); // 根相对 = 资源根
  });

  it("带协议、协议相对、锚点一律不是本地资源", () => {
    for (const ref of ["https://cdn.example/x.js", "http://a/b.css", "data:image/png;base64,AA", "blob:x", "javascript:alert(1)", "//cdn.example/x.js", "#top", "mailto:a@b", "C:/x.png"]) {
      expect(resolveLocalRef("", ref)).toBeNull();
    }
  });

  it("★ 不许 .. 越过资源根、不许点开头的段（页面读不到笔记本别处的东西）", () => {
    expect(resolveLocalRef("", "../secret.md")).toBeNull();
    expect(resolveLocalRef("css", "../../x.png")).toBeNull();
    expect(resolveLocalRef("", ".opennote/state.json")).toBeNull();
    expect(resolveLocalRef("", "a/.git/config")).toBeNull();
    expect(resolveLocalRef("", "a\\b.png")).toBeNull();
  });

  it("去掉 ?query / #hash，解码百分号与实体", () => {
    expect(resolveLocalRef("", "img/x.png?v=3#frag")).toBe("img/x.png");
    expect(resolveLocalRef("", "img/%E5%9B%BE.png")).toBe("img/图.png");
    expect(resolveLocalRef("", "a.png?x=1&amp;y=2")).toBe("a.png");
  });

  it("normalizeResourcePath：文件路径不做百分号解码，越界同样拒绝", () => {
    expect(normalizeResourcePath("./css/a%20b.css")).toBe("css/a%20b.css");
    expect(normalizeResourcePath("css//a.css")).toBe("css/a.css");
    expect(normalizeResourcePath("../a.css")).toBeNull();
    expect(normalizeResourcePath("/abs/a.css")).toBeNull();
    expect(normalizeResourcePath(".hidden/a.css")).toBeNull();
    expect(normalizeResourcePath("C:/a.css")).toBeNull();
  });

  it("MIME 由扩展名决定；笔记类扩展名不在白名单", () => {
    expect(htmlResourceMime("a.CSS")).toBe("text/css");
    expect(htmlResourceMime("x.woff2")).toBe("font/woff2");
    expect(htmlResourceMime("x.md")).toBeNull();
    expect(htmlResourceMime("x.html")).toBeNull();
    expect(htmlResourceMime("x.canvas")).toBeNull();
    expect(htmlResourceMime("noext")).toBeNull();
  });
});

describe("inlineHtmlResources", () => {
  it("<link rel=stylesheet> → <style>（保留 media），CSS 里的 url()/@import 按 CSS 自己的目录解析", async () => {
    const { resolve } = store({
      "css/main.css": '@import "base.css";\nbody{background:url(../img/bg.png)}',
      "css/base.css": "h1{color:red}",
      "img/bg.png": "PNG",
    });
    const html = '<head><link rel="stylesheet" href="css/main.css" media="screen"></head>';
    const result = await inlineHtmlResources(html, { resolve });
    expect(result.html).toMatch(/^<head><style data-opennote-href="css\/main.css" media="screen">/);
    expect(result.html).not.toContain("<link");
    expect(result.html).toContain(`url("data:image/png;base64,${b64("PNG")}")`);
    const imported = /@import url\("([^"]+)"\)/.exec(result.html)?.[1] ?? "";
    expect(decodeDataUrl(imported)).toEqual({ mime: "text/css", text: "h1{color:red}" });
    expect(result.inlined.sort()).toEqual(["css/base.css", "css/main.css", "img/bg.png"]);
    expect(result.missing).toEqual([]);
  });

  it("<script src> 换成 data: URL（defer / type=module 原样保留），内联脚本一字不动", async () => {
    const { resolve } = store({ "js/app.js": 'console.log("</script>")' });
    const html = '<script defer type="module" src="./js/app.js"></script><script>var a = "<img src=x.png>";</script>';
    const result = await inlineHtmlResources(html, { resolve });
    const src = /src="([^"]+)"/.exec(result.html)?.[1] ?? "";
    expect(decodeDataUrl(src)).toEqual({ mime: "text/javascript", text: 'console.log("</script>")' });
    expect(result.html).toContain('defer type="module"');
    expect(result.html).toContain('<script>var a = "<img src=x.png>";</script>');
  });

  it("img / srcset / video poster / style 属性 / SVG <image href> 都改写", async () => {
    const { resolve } = store({ "a.png": "A", "a2.png": "A2", "p.jpg": "P", "bg.webp": "B", "s.svg": "<svg/>" });
    const html = [
      '<img src="a.png" srcset="a.png 1x, a2.png 2x">',
      '<video poster="p.jpg" src="https://cdn/v.mp4"></video>',
      "<div style=\"background:url('bg.webp')\"></div>",
      '<svg><image href="s.svg"/></svg>',
    ].join("");
    const result = await inlineHtmlResources(html, { resolve });
    expect(result.html).not.toMatch(/"a\.png|a2\.png 2x|"p\.jpg"|'bg\.webp'|"s\.svg"/);
    expect(result.html).toContain(`srcset="data:image/png;base64,${b64("A")} 1x, data:image/png;base64,${b64("A2")} 2x"`);
    expect(result.html).toContain('src="https://cdn/v.mp4"'); // 远端不动
    expect(result.html).toContain(`style="background:url(&quot;data:image/webp;base64,${b64("B")}&quot;)"`);
    expect(result.inlined.sort()).toEqual(["a.png", "a2.png", "bg.webp", "p.jpg", "s.svg"]);
  });

  it("取不到的记 missing、越界与非白名单的不读盘、原引用一律保留", async () => {
    const { resolve, reads } = store({});
    const html = '<img src="nope.png"><img src="../escape.png"><a href="other.html">x</a><img src="note.md">';
    const result = await inlineHtmlResources(html, { resolve });
    expect(result.html).toBe(html);
    expect(result.missing).toEqual(["nope.png"]);
    expect(result.skipped).toEqual(["note.md"]);
    expect(reads).toEqual(["nope.png"]); // ../escape.png 与 note.md 根本不会去读
  });

  it("注释、<textarea>、<title> 里的「标签」不改；<a href> 不改", async () => {
    const { resolve } = store({ "a.png": "A" });
    const html = '<!-- <img src="a.png"> --><textarea><img src="a.png"></textarea><title>a.png</title><a href="a.png">a</a>';
    const result = await inlineHtmlResources(html, { resolve });
    expect(result.html).toBe(html);
    expect(result.inlined).toEqual([]);
  });

  it("超过合计上限的资源保留原引用并记 skipped；同一资源只读一次", async () => {
    const { resolve, reads } = store({ "big.png": "x".repeat(20), "small.png": "s" });
    const html = '<img src="big.png"><img src="small.png"><img src="small.png">';
    const result = await inlineHtmlResources(html, { resolve, maxBytes: 10 });
    expect(result.html).toContain('src="big.png"');
    expect(result.html).not.toContain('src="small.png"');
    expect(result.skipped).toEqual(["big.png"]);
    expect(result.missing).toEqual([]);
    expect(reads.filter((path) => path === "small.png")).toHaveLength(1);
  });

  it("CSS @import 循环不会死循环；内联 CSS 里的 </style> 被转义", async () => {
    const { resolve } = store({ "a.css": '@import "b.css"; .x::after{content:"</style>"}', "b.css": '@import "a.css";' });
    const result = await inlineHtmlResources('<link rel="stylesheet" href="a.css">', { resolve });
    expect(result.html).toContain("<\\/style>");
    expect(result.html.match(/<\/style>/g)).toHaveLength(1);
  });

  it("幂等：对已经内联过的页面再跑一遍，一个字节都不变", async () => {
    const { resolve } = store({ "a.png": "A", "a.css": "b{c:url(a.png)}" });
    const first = await inlineHtmlResources('<link rel="stylesheet" href="a.css"><img src="a.png">', { resolve });
    const second = await inlineHtmlResources(first.html, { resolve });
    expect(second.html).toBe(first.html);
    expect(second.inlined).toEqual([]);
  });

  it("引号里的 > 不截断标签；大小写混写的标签与属性照认", async () => {
    const { resolve } = store({ "a.png": "A" });
    const result = await inlineHtmlResources('<IMG ALT="a > b" SRC=a.png>', { resolve });
    expect(result.html).toBe(`<IMG ALT="a > b" src="data:image/png;base64,${b64("A")}">`);
  });
});

describe("页面元信息", () => {
  it("htmlDocumentTitle：取 <title> 文本，实体解码、空白折叠", () => {
    expect(htmlDocumentTitle("<title>\n 季度 &amp; 报告 </title>")).toBe("季度 & 报告");
    expect(htmlDocumentTitle("<h1>x</h1>")).toBeNull();
  });

  it("htmlPlainText：脚本 / 样式 / 注释 / data: 都不进搜索文本", () => {
    const text = htmlPlainText(
      '<style>.a{}</style><script>var secret=1</script><!-- c --><h1>标题</h1><p>正文&nbsp;一</p><img src="data:image/png;base64,QUFB">',
    );
    expect(text).toBe("标题 正文 一"); // &nbsp; 也是空白，一并折叠
  });
});
