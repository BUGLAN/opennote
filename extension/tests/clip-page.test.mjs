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

test("A · 来源标签必须显式传入：clip 页不许再用 activeTab 读自己", () => {
  const BG = readFileSync(join(ROOT, "src", "background.js"), "utf8");
  assert.match(js, /new URLSearchParams\(location\.search\)\.get\("tabId"\)/, "clip 页必须从 URL 取 tabId");
  assert.match(js, /type: "opennote:load", tabId: tabId/, "请求必须把 tabId 传给后台（同一条读取通路）");
  assert.match(js, /请从 Opennote 剪藏面板/, "缺/非法 tabId 要如实提示，不许静默读自己");
  assert.doesNotMatch(js, /chrome\.tabs\.query\(\{ active: true, currentWindow: true \}\)/, "clip 页不许再按 activeTab 取来源");
  assert.match(BG, /options\.tabId === undefined \? await activeTab\(\) : await tabById\(options\.tabId\)/, "后台：显式 tabId 优先，且不退回 activeTab");
  // 判据修正：不要写死变量名 —— 归一之后取标签用的是 get(id)。判据应盯「按归一后的 id 取」这个**意图**。
  assert.match(BG, /async function tabById\(tabId\)[\s\S]{0,400}?const tab = await chrome\.tabs\.get\(id\);/, "后台必须有 tabById（用归一后的 id 取，非法/过期返回 null）");
  // 判据修正：原正则漏了 getURL( 的右括号（真实文本 `getURL("clip/clip.html") + suffix`），
  // 导致**正确树也红** —— 这是我自己制造的假红（与 U-8「范围与标题不符」同族）：
  // **判据的细节必须与被判对象逐字一致**，否则它测的是我脑子里的文本，不是文件里的文本。
  assert.match(POPUP, /getURL\("clip\/clip\.html"\) \+ suffix/, "popup 入口必须把源标签 id 带上");
});


test("A · tabId 类型必须归一：URL 参数是字符串，chrome.tabs 要数字", () => {
  const BG = readFileSync(join(ROOT, "src", "background.js"), "utf8");
  assert.match(BG, /typeof tabId === "string" && \/\^\[0-9\]\+\$\/\.test\(tabId\) \? Number\(tabId\) : tabId/, "必须显式把数字字符串归一为 number");
  assert.match(BG, /const tab = await chrome\.tabs\.get\(id\);/, "取标签必须用归一后的 id");
  assert.match(js, /Number\(raw\)/, "clip 页解析 URL 参数时必须转成 number");
});


test("入口默认隐藏：web 版剪藏页上线前不留点了没用的按钮", () => {
  const start = POPUP.indexOf("function previewNode()");
  const pv = POPUP.slice(start, POPUP.indexOf("\nfunction ", start + 10));
  assert.match(pv, /const CLIP_WEB_READY = false;/, "必须有一个显式开关，默认关闭");
  assert.match(pv, /CLIP_WEB_READY && \(/, "渲染条件必须被该开关短路（默认不渲染）");
  // 旧路（clip/clip.html?tabId=）保留在代码里但不可达；新架构指向 web 版剪藏页后再启用。
  assert.match(pv, /clip\/clip\.html/, "旧实现保留（供新架构接入时参考/替换）");
});
