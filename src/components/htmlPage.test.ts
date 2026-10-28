/**
 * HTML 页面视图的**渲染契约**（`HtmlPageView.tsx`）。
 *
 * 这个仓库没有 DOM 测试栈（没有 jsdom / testing-library），所以用 `react-dom/server`
 * 做静态渲染：effect 不跑、点击模拟不了，但能真实走一遍渲染函数 ——
 * 足以挡住「编译通过、一渲染就炸」以及**属性写错**（sandbox 少一个词就是安全缺陷）。
 *
 * 隔离属性是这里最要紧的断言：`allow-scripts` 必须有，`allow-same-origin` 必须没有。
 * 两者同时给 = 没有沙箱（页面能直接摸父文档与 localStorage），而这条**不会**被类型系统拦住。
 */
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

/*
 * 组件在渲染期会读桌面桥；node 环境里没有 `window` / `ipcRenderer`，
 * 所以把它 mock 成「没有桌面桥」—— 渲染分支就会走网页那条（stage 在 effect 里，
 * 静态渲染不会真的触发，页面停在 loading 态）。
 */
vi.mock("../desktop/bridge", () => ({
  desktopBridge: () => null,
}));

import { renderToStaticMarkup } from "react-dom/server";
import { HTML_PAGE_SANDBOX, HtmlPageView } from "./HtmlPageView";
import type { Note } from "../data/types";

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: "原型/登录页.html",
    folderId: "原型",
    kind: "html",
    title: "原型 · 登录页",
    titleOverride: null,
    content: "<!doctype html><html><head><title>原型 · 登录页</title></head><body><h1>欢迎</h1></body></html>",
    createdAt: 1,
    updatedAt: 1,
    openedAt: 1,
    starred: false,
    tags: [],
    chars: 0,
    words: 0,
    trashed: false,
    trashedAt: null,
    ...overrides,
  };
}

const render = (overrides: Partial<Note> = {}): string => renderToStaticMarkup(createElement(HtmlPageView, { note: note(overrides) }));

describe("HtmlPageView", () => {
  it("空页面给出「没有内容」的说明，而不是一张空白", () => {
    const html = render({ content: "<!doctype html><html><head></head><body></body></html>" });
    expect(html).toContain("这个页面没有内容");
  });

  it("有内容时先进入加载态并带上可读摘要（不做无提示的白屏）", () => {
    const html = render();
    expect(html).toContain("正在打开页面");
    // 摘要来自正文（静态渲染时 stage 还没跑，只有这一句能证明「内容被读到过」）
    expect(html).toContain("欢迎");
  });

  it("★ 全屏按钮存在且带无障碍名称（静态渲染下状态是「未全屏」）", () => {
    const html = render();
    expect(html).toContain("全屏查看页面");
    expect(html).toContain("html-page__fullscreen-btn");
  });

  it("路径提示带 title（长路径可省略但悬停可见）", () => {
    const html = render();
    expect(html).toContain("原型/登录页.html");
  });

  it("★ sandbox 只给 allow-scripts：不能有 allow-same-origin（有它就等于没有沙箱）", () => {
    expect(HTML_PAGE_SANDBOX).toBe("allow-scripts");
    for (const forbidden of ["allow-same-origin", "allow-top-navigation", "allow-popups", "allow-forms", "allow-modals"]) {
      expect(HTML_PAGE_SANDBOX, forbidden).not.toContain(forbidden);
    }
  });

  it("HTML 里的标签不会跑进宿主 DOM（摘要走纯文本，不是 innerHTML）", () => {
    const html = render({
      title: "<img src=x onerror=alert(1)>",
      content: "<title><script>alert(1)</script>真标题</title><p>正文</p><img src=x onerror=alert(1)>",
    });
    /*
     * 断言的是**宿主文档**里没有这些东西：
     *   - 页面里的 <img onerror> 没有变成宿主的 img（它只在 iframe 里渲染，静态渲染时连 iframe 都还没出现）；
     *   - 页面里的 <script> 没有变成宿主的 script；
     *   - 摘要文本被转义成纯文本（出现的是「正文」，不是一段标签）。
     *
     * 注意**不能**期望标题的原始字符串出现在输出里：加载态只渲染摘要与路径，
     * 标题要等 iframe 挂上才会作为 attribute 出现。断言「不出现危险形态」才是这条用例的意图。
     */
    expect(html).not.toContain("<img src=x onerror");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("正文");
  });
});
