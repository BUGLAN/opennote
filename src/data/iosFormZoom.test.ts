import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * iOS 表单聚焦放大的护栏。
 *
 * iOS Safari / WKWebView 在文本控件**计算字号 < 16px** 时，聚焦会把整个视口放大。
 * 契约写死在这里：
 * - 只在 `-webkit-touch-callout` 特性查询里提字号（Chrome / Firefox / macOS 桌面不命中）；
 * - 覆盖 input / textarea / select，排除 checkbox / radio / range；
 * - 不用 `maximum-scale` / `user-scalable=no` 去禁用缩放。
 *
 * 真机验收在 iOS 上做（设置页、侧栏搜索、命令面板各点一次输入框）；这里守的是别把
 * 规则改回去或改成 viewport 方案。
 */

const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const base = read("../styles/base.css");
const index = read("../../index.html");

describe("iOS 表单聚焦不放大", () => {
  it("在 iOS 特性查询里把文本控件字号提到 16px", () => {
    const support = /@supports\s*\(\s*-webkit-touch-callout:\s*none\s*\)\s*\{([\s\S]*?)\n\}/.exec(base);
    expect(support).not.toBeNull();
    const rule = support?.[1] ?? "";
    expect(rule).toMatch(/:is\(/);
    expect(rule).toContain('input:not([type="checkbox"]):not([type="radio"]):not([type="range"])');
    expect(rule).toMatch(/(?:^|[\s,(])textarea(?:[\s,)])/m);
    expect(rule).toMatch(/(?:^|[\s,(])select(?:[\s,)])/m);
    expect(rule).toMatch(/font-size:\s*16px\s*;/);
  });

  it("没有用 viewport 禁用用户缩放", () => {
    expect(index).not.toMatch(/maximum-scale/i);
    expect(index).not.toMatch(/user-scalable\s*=\s*["']?no/i);
  });
});
