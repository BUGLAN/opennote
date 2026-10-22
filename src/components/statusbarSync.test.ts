import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 同步指示器的源码契约：**底栏不再有那条横穿的进度线**。
 *
 * 这是交互上的硬约束，不是几何问题：横线贴在屏幕底部、横穿整幅宽度，
 * 写文档时它会一直把余光拉走；横线一出现，人还会不自觉地盯着「到头没有」。
 * 现在同步中只让入口那颗图标转起来 —— 同一个节点、同一份宽度，布局不跳。
 *
 * 口径与 `statusbarLayout.test.ts` 一致：直接读源码文本，且先剥掉注释，
 * 免得注释里的示例样式被当成真规则。
 */

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const statusBar = read("./StatusBar.tsx");
const css = read("../styles/app.css").replace(/\/\*[\s\S]*?\*\//g, "");

describe("同步指示器：只转图标，不画底部横线", () => {
  it("StatusBar 不再渲染那条 2px 进度横线", () => {
    expect(statusBar).not.toContain("statusbar__track");
    // 以前这里有一段 style={{ width: `${…progress…}%` }} —— 横线唯一的数据源。
    expect(statusBar).not.toContain("progress");
  });

  it("样式表里那条横线的规则已经删掉", () => {
    expect(css).not.toMatch(/\.statusbar__track/);
  });

  it("正在同步时用 13px 小环：旋转，但停转后缺口仍在（静态形状）", () => {
    expect(statusBar).toContain('className="statusbar__sync-spinner"');
    const spinner = /\.statusbar__sync-spinner\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(spinner).toMatch(/width:\s*13px/);
    expect(spinner).toMatch(/border-top-color:\s*transparent/);
    expect(spinner).toMatch(/animation:\s*spin/);
  });

  it("安静态的同步图标也是 13px：两个状态占同一个槽位，宽度不变", () => {
    expect(statusBar).toMatch(/<Icon name="rotate" size=\{13\} className="statusbar__sync-icon"/);
  });

  it("同步中的入口仍然可点、有可访问名（aria-label 与 title）", () => {
    expect(statusBar).toMatch(/aria-label=\{props\.sync\.label === null \? props\.sync\.title/);
    expect(statusBar).toMatch(/title=\{props\.sync\.title\}/);
  });
});
