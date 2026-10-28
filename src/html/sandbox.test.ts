/**
 * 沙箱协议：注入位置、令牌、以及 CSP 的三份副本逐字一致。
 *
 * CSP 的唯一产地是 `sandbox.ts` 的 `HTML_SANDBOX_CSP`；`public/html-sandbox.html` 的 meta
 * 与 `electron/main.cjs` 的同名常量是副本（宿主页是静态文件、主进程是 CommonJS，都 import
 * 不了 TS）。三份里任何一份被单独改动，这里就红。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HTML_SANDBOX_CSP, HTML_SANDBOX_FLAGS, MSG_OPEN, MSG_READY, MSG_RENDER, isOpenableUrl, prepareSandboxDocument } from "./sandbox";

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("沙箱令牌与策略", () => {
  it("★ 不透明源：没有 allow-same-origin，也不能导航顶层 / 弹窗 / 提交表单", () => {
    const flags = HTML_SANDBOX_FLAGS.split(/\s+/);
    expect(flags).toContain("allow-scripts");
    for (const forbidden of ["allow-same-origin", "allow-top-navigation", "allow-popups", "allow-forms"]) {
      expect(flags).not.toContain(forbidden);
    }
  });

  it("CSP：不放行任何远端 connect、子框架、插件与表单提交", () => {
    expect(HTML_SANDBOX_CSP).toContain("connect-src data: blob:");
    expect(HTML_SANDBOX_CSP).not.toMatch(/connect-src[^;]*https/);
    expect(HTML_SANDBOX_CSP).toContain("frame-src 'none'");
    expect(HTML_SANDBOX_CSP).toContain("object-src 'none'");
    expect(HTML_SANDBOX_CSP).toContain("form-action 'none'");
  });

  it("宿主页的 meta CSP 与 HTML_SANDBOX_CSP 逐字一致，且宿主脚本认的消息类型就是这两个", () => {
    const page = read("../../public/html-sandbox.html");
    const meta = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(page)?.[1];
    expect(meta).toBe(HTML_SANDBOX_CSP);
    expect(page).toContain(`'${MSG_RENDER}'`);
    expect(page).toContain(`'${MSG_READY}'`);
    expect(page).toContain("event.source !== window.parent");
  });

  it("桌面主进程的 HTML_SANDBOX_CSP 与这里逐字一致；应用本体策略放行了 file: 子框架", () => {
    const main = read("../../electron/main.cjs");
    const copy = /const HTML_SANDBOX_CSP =\s*"([^"]+)"/.exec(main)?.[1];
    expect(copy).toBe(HTML_SANDBOX_CSP);
    expect(main).toContain("'frame-src file:'");
    expect(main).toContain("will-frame-navigate");
  });

  it("网页版 CSP 显式放行同源子框架（宿主页）", () => {
    expect(read("../../vite.config.ts")).toContain(`"frame-src 'self'"`);
  });
});

describe("prepareSandboxDocument", () => {
  const injected = (html: string) => prepareSandboxDocument(html);

  it("有 <head>：注入在 <head> 的第一个位置", () => {
    const out = injected('<!doctype html><html><head><meta charset="utf-8"><title>x</title></head><body></body></html>');
    expect(out.startsWith('<!doctype html><html><head><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(out).toContain(`content="${HTML_SANDBOX_CSP}"`);
    expect(out).toContain(MSG_OPEN);
  });

  it("没有 <head> 但有 <html>：补一个 <head>", () => {
    expect(injected("<html><body>x</body></html>")).toMatch(/^<html><head><meta http-equiv=/);
  });

  it("只有 doctype：放在 doctype 之后（不把页面推进怪异模式）", () => {
    expect(injected("<!DOCTYPE html>\n<p>x</p>")).toMatch(/^<!DOCTYPE html><meta http-equiv=/);
  });

  it("片段：前置", () => {
    expect(injected("<p>x</p>")).toMatch(/^<meta http-equiv=.*<p>x<\/p>$/s);
  });

  it("外链放行只认 http(s) / mailto", () => {
    expect(isOpenableUrl("https://example.com")).toBe(true);
    expect(isOpenableUrl("mailto:a@b.c")).toBe(true);
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "opennote://x", 42, null]) {
      expect(isOpenableUrl(bad)).toBe(false);
    }
  });
});
