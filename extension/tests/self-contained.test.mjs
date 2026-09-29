/**
 * 「注入脚本必须自包含」的机械化校验。
 *
 * 为什么需要它：MV3 的 `chrome.scripting.executeScript({ func })` 会把函数 `toString()`
 * 之后丢进页面执行——函数体里只要引用了模块作用域的标识符（helper、常量、import），
 * 注入后就会 `ReferenceError`，而且**只在真机运行时才暴露**。
 * 这里用静态检查把这条不变量固定下来。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/** 收集顶层的声明（粗略但足够：靠花括号深度判断，模板串里的 ${} 是配对的）。 */
function topLevelDeclarations(source) {
  const lines = stripComments(source).split("\n");
  const decls = [];
  let depth = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      depth === 0 &&
      /^(export\s+)?(async\s+)?function\s/.test(trimmed) === true
    ) {
      decls.push(trimmed);
    } else if (
      depth === 0 &&
      /^(import\s|export\s+(const|let|var|class|default)|const\s|let\s|var\s|class\s)/.test(trimmed)
    ) {
      decls.push(trimmed);
    }
    for (const char of line) {
      if (char === "{") depth += 1;
      else if (char === "}") depth = Math.max(0, depth - 1);
    }
  }
  return decls;
}

for (const file of ["src/content/extract-page.js", "src/content/clipboard.js"]) {
  test(`${file} 只有 1 个顶层声明（可安全注入）`, () => {
    const source = readFileSync(join(ROOT, file), "utf8");
    const decls = topLevelDeclarations(source);
    assert.equal(decls.length, 1, `顶层声明不止一个：\n${decls.join("\n")}`);
    assert.match(decls[0], /^export function extractPage\(options\)|^export function copyInPage\(text\)/);
  });

  test(`${file} 没有 import / require / eval / 远程地址`, () => {
    const source = readFileSync(join(ROOT, file), "utf8");
    assert.ok(!/^\s*import\s/m.test(source), "注入脚本不能有 import");
    assert.ok(!/require\s*\(/.test(source), "注入脚本不能有 require");
    assert.ok(!/\beval\s*\(/.test(source), "注入脚本不能有 eval");
    assert.ok(!/new\s+Function\s*\(/.test(source), "注入脚本不能有 new Function");
    assert.ok(!/https?:\/\//.test(source), "注入脚本不能含远程地址");
  });
}

test("浮标脚本：占位符在 src 里、已替换在 dist 里，且令牌以 :host 作用域注入", () => {
  const source = readFileSync(join(ROOT, "src/content/float.js"), "utf8");
  assert.ok(source.includes('const TOKENS_CSS = "__OPENNOTE_TOKENS_CSS__";'), "src 里必须保留占位符字面量");

  const distFile = join(ROOT, "dist/content/float.js");
  if (!existsSync(distFile)) {
    assert.fail("dist 还没构建：先跑 `node build.mjs`");
  }
  const built = readFileSync(distFile, "utf8");
  assert.ok(!built.includes('"__OPENNOTE_TOKENS_CSS__"'), "dist 里占位符未被替换");
  assert.ok(built.includes(":host{"), "dist 里应注入 :host 作用域的令牌");
  assert.ok(built.includes("--paper:"), "dist 里应包含令牌定义");
  assert.ok(built.includes(".clip-float"), "dist 里应包含浮标样式");
  assert.ok(!/https?:\/\//.test(built.replace(/http:\/\/www\.w3\.org/g, "")), "浮标脚本不能含远程地址");
});

test("浮标脚本走影子 DOM 且不进入宿主页面的 Tab 顺序", () => {
  const source = readFileSync(join(ROOT, "src/content/float.js"), "utf8");
  assert.ok(source.includes("attachShadow"), "必须用影子 DOM 隔离样式");
  assert.ok(source.includes('tabindex="-1"'), "浮标按钮不得进入页面 Tab 顺序（03 §UI-02）");
  assert.ok(source.includes("剪藏整页正文"), "图标按钮必须有 title/aria-label 文案");
  assert.ok(source.includes('role", "toolbar"'), "浮标应为 toolbar 语义");
});

test("popup 的 HTML 不引任何远程资源、不写内联脚本", () => {
  const html = readFileSync(join(ROOT, "src/popup/popup.html"), "utf8");
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(html), "popup.html 不得引远程资源");
  assert.ok(!/<script(?![^>]*\bsrc=)/.test(html), "popup.html 不得有内联脚本（MV3 CSP）");
  assert.ok(html.includes('role="radiogroup"'), "分段控件必须是 radiogroup");
  assert.ok(html.includes('role="status"'), "状态芯片必须是 role=status");
  assert.ok(html.includes('aria-live="polite"'), "状态芯片必须 aria-live=polite");
  assert.ok(html.includes('tabindex="-1"'), "芯片必须只读（tabindex=-1）");
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html), "不得使用 emoji");
});
