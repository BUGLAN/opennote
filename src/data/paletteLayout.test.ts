import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 命令面板「顶部锚定」的护栏：打字过滤结果时，输入框不许跟着面板跑。
 *
 * 几何没法靠单测算（要真浏览器），但契约是源码里写死的：`.palette` 高度随结果条数
 * 实时变（`max-height` 封顶），如果它挂在居中的 `.overlay-root` 里，结果一变整块面板
 * 连同输入框就重新垂直居中 —— 60 项 → 5 项在 1440×900 下实测下跳 111.03px
 * （2026-10 修复前的真 Chrome 实测）。修法是面板单独走 `.overlay-root--palette`
 * 顶部锚定，变短只朝下收缩。真实几何的验收在浏览器里做（修前/修后三档视口
 * ΔinputTop 111.03/25.23/12.03 → 0/0/0），这里守的是**别把它改回去**。
 *
 * 口径与 `shellLayout.test.ts` 一致：直接读源码文本，且**先剥注释**，免得注释里
 * 的示例 CSS 被当成真规则。
 */

const readCss = (name: string): string =>
  readFileSync(new URL(`../styles/${name}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\r\n/g, "\n");

/**
 * 取一条**顶层**规则的声明块。选择器前面必须是行首 / `}` / `,`：
 * 否则 `.palette__input` 这种后代/组合选择器也会命中 `.palette`。
 */
function block(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
}

const app = readCss("app.css");

describe("命令面板顶部锚定（打字时输入框不许跑）", () => {
  it("面板挂在专属的顶部锚定浮层上：place-items: start center + 固定 padding-top", () => {
    const modifier = block(app, ".overlay-root--palette");
    expect(modifier).toMatch(/place-items:\s*start\s+center/);
    // 17vh = 满高面板（66vh）居中时的上边距，结果最多时观感与居中版一致；不许顺手改动。
    expect(modifier).toMatch(/padding-top:\s*max\(\s*24px\s*,\s*17vh\s*\)/);
  });

  it("对话框所在的 .overlay-root 仍然居中（只有面板特殊）", () => {
    expect(block(app, ".overlay-root")).toMatch(/place-items:\s*center/);
  });

  it(".palette 高度仍由 max-height 封顶（锚定不越界靠 17vh + 66vh = 83vh）", () => {
    expect(block(app, ".palette")).toMatch(/max-height:\s*min\(\s*66vh\s*,\s*640px\s*\)/);
  });

  it("输入框仍是 flex: none（0.5.0「被结果压扁」的缺陷不许回归）", () => {
    expect(block(app, ".palette__input")).toMatch(/flex:\s*none/);
  });

  it("CommandPalette 的根节点确实带 overlay-root--palette", () => {
    const tsx = readFileSync(new URL("../components/CommandPalette.tsx", import.meta.url), "utf8");
    expect(tsx).toContain('className="overlay-root overlay-root--palette"');
  });
});
