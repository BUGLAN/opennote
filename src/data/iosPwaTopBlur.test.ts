import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * iOS 26/27 主屏 PWA 顶部模糊的护栏。
 *
 * 系统会在 standalone 页面顶部叠一层 Liquid Glass，范围会盖住顶栏；应用侧唯一的办法是让
 * WebKit 在视口顶边取样到一个实色的 fixed 元素。真正的消除效果要在 iOS 主屏 PWA 验收，
 * 这里守的是前两版踩过的坑和取样条件：
 * - 必须是 index.html 里 body 的真实元素，不能是伪元素（WebKit 命中伪元素时记下的是宿主）；
 * - 样式内联在 index.html，首帧就在，不等样式包；
 * - 层级必须高于 `body::before` 的全屏纸纹理（首轮取样忽略 pointer-events，会先命中它）；
 * - 规则只在 iOS 特性查询 + standalone 里生效，Android / 桌面不受影响；
 * - 背景必须是跟随主题的实色，不能用渐变或半透明。
 * 启动时再让它动一下的逻辑见 `src/lib/iosTopBar.ts`。
 */

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8")
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/\r\n/g, "\n");
const inlineStyle = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));

function readCss(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\r\n/g, "\n");
}

const base = readCss("../styles/base.css");
const app = readCss("../styles/app.css");

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

function zIndex(rule: string): number {
  const match = /z-index:\s*(\d+)\s*;/.exec(rule);
  expect(match).not.toBeNull();
  return Number(match![1]);
}

function iosBlock(): string {
  return group(group(inlineStyle, "@media (display-mode: standalone)"), "@supports (-webkit-touch-callout: none)");
}

function edgeRule(): string {
  const block = iosBlock();
  return group(block, ".ios-top-edge {");
}

describe("iOS 主屏 PWA 顶部不糊住顶栏", () => {
  it("顶边实色条是 body 的第一个真实元素，样式内联在 index.html", () => {
    expect(html).toMatch(/<body>\s*<div class="ios-top-edge" aria-hidden="true"><\/div>\s*<div id="root"><\/div>/);
    expect(inlineStyle).toContain(".ios-top-edge");
    // 样式包里不再写它，也不回到伪元素
    for (const css of [base, app]) {
      expect(css).not.toContain("ios-top-edge");
      expect(css).not.toMatch(/\.app::before/);
    }
  });

  it("默认隐藏，只在 iOS standalone 的视口顶边铺实色", () => {
    expect(inlineStyle).toMatch(/\.ios-top-edge \{ display: none; \}/);
    // display: block 只出现在 iOS standalone 里
    expect(inlineStyle.split("display: block").length).toBe(2);

    const rule = edgeRule();
    expect(rule).toMatch(/display: block;/);
    expect(rule).toMatch(/position: fixed;/);
    expect(rule).toMatch(/top: 0; left: 0; right: 0;/);
    expect(rule).toMatch(/height: max\(6px, env\(safe-area-inset-top, 0px\)\);/);
    expect(rule).toMatch(/background: var\(--paper, #fbf8f3\);/);
    expect(rule).toMatch(/pointer-events: none;/);
    expect(rule).not.toMatch(/opacity|(?:linear|radial|conic)-gradient|color-mix|transparent|rgba/);
  });

  it("深色主题在样式包到之前也是深色底；动一下时高 1px", () => {
    const block = iosBlock();
    expect(block).toMatch(/html\[data-appearance="dark"\] \.ios-top-edge \{ background: var\(--paper, #14120f\); \}/);
    expect(block).toMatch(
      /\.ios-top-edge\.is-nudge \{ height: calc\(max\(6px, env\(safe-area-inset-top, 0px\)\) \+ 1px\); \}/,
    );
  });

  it("压在全屏纸纹理之上，顶边取样先命中它", () => {
    expect(zIndex(edgeRule())).toBeGreaterThan(zIndex(group(base, "body::before")));
  });

  it("启动时调用 installIosTopBar", () => {
    const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
    expect(main).toMatch(/installIosTopBar\(window\);/);
  });
});
