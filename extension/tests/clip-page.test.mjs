/**
 * 新标签可编辑页（task-29）：静态契约断言。
 * 「提交带**编辑后的** body」是**核心** —— 它就是「所见即所剪」在新页面上的同一份契约：
 * **复用同一条 `opennote:submit`，不另造通路**。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const PAGE = join(ROOT, "src", "clip", "clip.html");
const SCRIPT = join(ROOT, "src", "clip", "clip.js");
const html = existsSync(PAGE) ? readFileSync(PAGE, "utf8") : "";
const js = existsSync(SCRIPT) ? readFileSync(SCRIPT, "utf8") : "";
const POPUP = readFileSync(join(ROOT, "src", "popup", "popup.js"), "utf8");

test("可编辑页存在，并复用同一个 tokens.css", () => {
  assert.ok(html.length > 0, "src/clip/clip.html 必须存在");
  assert.match(html, /<link rel="stylesheet" href="\.\.\/styles\/tokens\.css">/, "必须引用与 popup 同一个 tokens.css");
  assert.match(html, /<textarea[^>]*id="body"/, "正文必须是可编辑的原生 textarea");
  assert.match(html, /id="title"/, "标题必须可编辑");
});

test("零第三方依赖（无外链脚本/样式、无 CDN、无 node_modules）", () => {
  for (const [name, text] of [["clip.html", html], ["clip.js", js]]) {
    assert.doesNotMatch(text, /<script[^>]+src="https?:/, `${name} 不许外链脚本`);
    assert.doesNotMatch(text, /<link[^>]+href="https?:/, `${name} 不许外链样式`);
    assert.doesNotMatch(text, /cdn\.|unpkg|jsdelivr|node_modules/, `${name} 不许任何第三方来源`);
    assert.doesNotMatch(text, /^\s*import\s[^\n]*from\s+"(?![./])/m, `${name} 不许裸模块 import`);
  }
});

test("核心契约：提交走同一条 opennote:submit，正文取**用户改过的** body", () => {
  assert.match(js, /type: "opennote:submit"/, "必须复用 popup 同一条提交通路（不是新造一条）");
  assert.doesNotMatch(js, /type: "submit"/, "不许出现那条不存在的消息类型（子串坑）");
  assert.match(js, /const body = \$\("body"\)\.value;/, "正文必须从可编辑区读取");
  assert.match(js, /body: body\.slice\(0, MAX_BODY\)/, "提交的正文必须是用户改过的那份");
  assert.doesNotMatch(js, /article\.markdown\s*,\s*$/m, "不许把原始正文直接当提交内容");
  assert.match(js, /importId: newId\(\)/, "每次剪藏要有新的 importId（幂等靠它）");
});

test("无 URL 时入口不渲染（不画死按钮）", () => {
  assert.match(js, /\$\("save"\)\.hidden = !src\.url;/, "页面侧：没有网址就没有按钮");
  const start = POPUP.indexOf("function previewNode()");
  const pv = POPUP.slice(start, POPUP.indexOf("\nfunction ", start + 10));
  assert.match(pv, /if \(openTarget\)/, "popup 侧：入口必须有条件渲染");
  assert.match(pv, /chrome\.tabs\.create/, "入口动作 = 打开新标签页");
  assert.match(pv, /clip\/clip\.html/, "打开的必须是可编辑页（不是原始网页）");
  assert.match(pv, /aria-label/, "图标按钮必须有等价文字（可读性）");
});
