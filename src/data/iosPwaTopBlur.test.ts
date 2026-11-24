import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * iOS 26/27 主屏 PWA 顶部模糊的护栏。
 *
 * 系统会在 standalone 页面顶部叠一层 Liquid Glass，范围会盖住顶栏；应用侧唯一的办法是让
 * WebKit 在视口顶边取样到一个实色的 fixed 元素。真正的消除效果要在 iOS 主屏 PWA 验收，
 * 这里守的是上一版踩过的坑和取样条件：
 * - 必须是 index.html 里的真实元素，不能是伪元素（WebKit 命中伪元素时记下的是宿主）；
 * - 层级必须高于 `body::before` 的全屏纸纹理（首轮取样忽略 pointer-events，会先命中它）；
 * - 规则只在 iOS 特性查询 + standalone 里生效，Android / 桌面不受影响；
 * - 背景必须是跟随主题的实色，不能用渐变或半透明。
 */

function readCss(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\r\n/g, "\n");
}

const base = readCss("../styles/base.css");
const app = readCss("../styles/app.css");
const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8").replace(
  /<!--[\s\S]*?-->/g,
  "",
);

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

function edgeRule(): string {
  // base.css 里不止一个 iOS @supports 块：从默认隐藏规则之后找属于这条的那个
  const after = base.slice(base.indexOf(".ios-top-edge {"));
  const ios = group(after, "@supports (-webkit-touch-callout: none)");
  return group(group(ios, "@media (display-mode: standalone)"), ".ios-top-edge");
}

describe("iOS 主屏 PWA 顶部不糊住顶栏", () => {
  it("顶边实色条是 body 里的真实元素，不是伪元素", () => {
    expect(html).toMatch(
      /<body>[\s\S]*<div class="ios-top-edge" aria-hidden="true"><\/div>[\s\S]*<\/body>/,
    );
    expect(`${base}\n${app}`).not.toMatch(/\.ios-top-edge::?(?:before|after)/);
    expect(app).not.toMatch(/\.app::before/);
  });

  it("默认隐藏，只在 iOS standalone 的视口顶边铺实色", () => {
    expect(group(base, ".ios-top-edge {")).toMatch(/display:\s*none\s*;/);

    const rule = edgeRule();
    expect(rule).toMatch(/display:\s*block\s*;/);
    expect(rule).toMatch(/position:\s*fixed\s*;/);
    expect(rule).toMatch(/top:\s*0\s*;/);
    expect(rule).toMatch(/left:\s*0\s*;/);
    expect(rule).toMatch(/right:\s*0\s*;/);
    expect(rule).toMatch(/height:\s*var\(--inset-top\)\s*;/);
    expect(rule).toMatch(/background:\s*var\(--paper\)\s*;/);
    expect(rule).not.toMatch(/opacity|(?:linear|radial|conic)-gradient|color-mix|transparent|rgba/);
  });

  it("压在全屏纸纹理之上，顶边取样先命中它", () => {
    expect(zIndex(edgeRule())).toBeGreaterThan(zIndex(group(base, "body::before")));
  });
});
