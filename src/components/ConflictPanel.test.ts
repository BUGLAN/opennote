/**
 * 冲突面板的**渲染**用例（`ConflictPanel.tsx`）。
 *
 * 这个仓库没有 DOM 测试栈（没有 jsdom / testing-library），所以这里用
 * `react-dom/server` 做静态渲染 —— 它不需要 DOM，但能真实走一遍组件的渲染函数，
 * 足以挡住「编译通过、一渲染就炸」这一类错误。
 *
 * 面板的数据来源（`appSync`）在 node 里会连带拉起密钥存储、工作区注册表，
 * 所以整块 mock 掉：这里只关心**给定一份冲突列表，它渲染成什么**。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../sync/appSync", () => ({
  previewConflict: vi.fn(async () => null),
  resolveConflict: vi.fn(async () => ({ ok: true, path: "" })),
  manualSync: vi.fn(async () => null),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConflictPanel } from "./ConflictPanel";

const render = (conflicts: { path: string; kind: string }[]): string =>
  renderToStaticMarkup(createElement(ConflictPanel, { conflicts }));

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe("冲突面板", () => {
  it("★ 列出每一条冲突的路径，并给出「用我的 / 用远端」两个出口", () => {
    const html = render([
      { path: "笔记 49", kind: "both-modified" },
      { path: "bulk/d00/n0012.md", kind: "both-modified" },
    ]);
    expect(html).toContain("笔记 49");
    expect(html).toContain("bulk/d00/n0012.md");
    expect(html).toContain("用我的");
    expect(html).toContain("用远端");
    // ★ 不再有「两个都留」—— 冲突的答案只有两个（见组件头部的说明）。
    expect(html).not.toContain("两个都留");
  });

  it("「对比」只出现在能对比的类型上（删除类冲突没有两份正文）", () => {
    const html = render([
      { path: "a.md", kind: "both-modified" },
      { path: "b.md", kind: "deleted-remotely-modified-locally" },
      { path: "c.md", kind: "both-modified" },
    ]);
    // 两条 both-modified 各一个「对比」，删除类那条没有。
    expect(count(html, ">对比<")).toBe(2);
    expect(html).toContain("远端已删 · 本地改过");
  });

  it("顶部有批量与重新核对（109 条不可能一条条点）", () => {
    const html = render([{ path: "a.md", kind: "both-modified" }]);
    expect(html).toContain("全部用我的");
    expect(html).toContain("全部用远端");
    expect(html).toContain("重新核对");
  });

  it("默认**不**展开对比（一上来就是 109 份全文会把面板撑爆）", () => {
    const html = render([{ path: "a.md", kind: "both-modified" }]);
    expect(html).not.toContain("并排");
    expect(html).not.toContain("本机版本");
  });
});
