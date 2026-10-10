import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 外壳「顶行 / 底行各自连成一条线」的护栏。
 *
 * 这不是可以靠单测算出来的东西（几何要真浏览器），但**两条线靠同一个高度令牌**这件事
 * 是源码里写死的契约，而且它已经坏过一次：`.sidebar__foot` 当初没有高度，被内容撑成
 * 36.39px，而 `.statusbar` 是 30px —— 侧栏列表的下沿比右侧内容区高 6.39px，两条底边线
 * 错开半个行高（用户截图 @2x 实测差 13 图像 px）。真实几何的验收在浏览器里做（见
 * 提交说明），这里守的是**别把它改回去**。
 *
 * 口径与 `clip-web/wiring.test.ts` 一致：直接读源码文本，且**先剥注释**，免得注释里
 * 的示例 CSS 被当成真规则。
 */

const readCss = (name: string): string =>
  readFileSync(new URL(`../styles/${name}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\r\n/g, "\n");

/**
 * 取一条**顶层**规则的声明块。选择器前面必须是行首 / `}` / `,`：
 * 否则 `.app--desktop .tabbar` 这种后代选择器也会命中 `.tabbar`。
 */
function block(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
}

const tokens = readCss("tokens.css");
const app = readCss("app.css");

describe("外壳的顶行 / 底行各自连成一条线", () => {
  it("顶行：侧栏头部与标签栏同为 --tabbar-h", () => {
    expect(block(app, ".sidebar__head")).toMatch(/height:\s*var\(--tabbar-h\)/);
    expect(block(app, ".tabbar")).toMatch(/height:\s*var\(--tabbar-h\)/);
  });

  it("底行：侧栏脚注与状态栏同为 --statusbar-h（高度写死，不许靠内容撑）", () => {
    expect(block(app, ".statusbar")).toMatch(/height:\s*var\(--statusbar-h\)/);
    // 这一条就是那次缺陷：没有 height 时，脚注被内容撑成 36.39px（状态栏 30px）。
    expect(block(app, ".sidebar__foot")).toMatch(/height:\s*var\(--statusbar-h\)/);
  });
  // 脚注的动作位测试已随元素退场（2026-10-10：设置入口去重，脚注不再放按钮）。
  // 当年的缺陷（行内 span 包 inline-flex 按钮撑出 23.39px 行盒、把 30px 底栏顶高）
  // 在 `app.css` 的 `.sidebar__foot` 注释里留了档，将来加动作时别踩回去。

  it("两个高度令牌的值与 DESIGN.md 的尺寸常量一致（40px / 30px）", () => {
    expect(tokens).toMatch(/--tabbar-h:\s*40px/);
    expect(tokens).toMatch(/--statusbar-h:\s*30px/);
  });
});
