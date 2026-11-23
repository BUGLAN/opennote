import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * iOS 26/27 主屏 PWA 顶部模糊的护栏。
 *
 * 系统会在 standalone 页面顶部叠一层 Liquid Glass，范围会盖住顶栏；应用侧只能在
 * 视口顶边铺一条实色 fixed 背景。真正的消除效果要在 iOS 主屏 PWA 验收，这里守的是：
 * - 规则只在 iOS 特性查询 + standalone 里生效，Android / 桌面不受影响；
 * - 背景必须是跟随主题的实色，不能用渐变或半透明；
 * - 高度至少 6px，并与安全区一起增长。
 */

const css = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\r\n/g, "\n");

function group(cssText: string, marker: string): string {
  const start = cssText.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = cssText.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < cssText.length; i += 1) {
    if (cssText[i] === "{") depth += 1;
    if (cssText[i] !== "}") continue;
    depth -= 1;
    if (depth === 0) return cssText.slice(open + 1, i);
  }
  throw new Error(`unclosed group: ${marker}`);
}

describe("iOS 主屏 PWA 顶部不糊住顶栏", () => {
  it("只在 iOS standalone 的视口顶边铺实色背景", () => {
    const ios = group(css, "@supports (-webkit-touch-callout: none)");
    const standalone = group(ios, "@media (display-mode: standalone)");
    const rule = group(standalone, ".app::before");

    expect(rule).toMatch(/content:\s*""\s*;/);
    expect(rule).toMatch(/position:\s*fixed\s*;/);
    expect(rule).toMatch(/inset:\s*0 0 auto 0\s*;/);
    expect(rule).toMatch(/height:\s*max\(6px,\s*var\(--inset-top\)\)\s*;/);
    expect(rule).toMatch(/background:\s*var\(--paper\)\s*;/);
    expect(rule).toMatch(/pointer-events:\s*none\s*;/);
    expect(rule).not.toMatch(/(?:linear|radial|conic)-gradient|color-mix|transparent/);
  });
});
