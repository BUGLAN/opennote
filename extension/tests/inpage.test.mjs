/**
 * 页面内桥（网页版通道）单测：契约 02 §5.7 / FR-39。
 *
 * 覆盖三件事：
 *   ① 候选判定（哪个标签页算「浏览器里开着的 Opennote 网页版」）；
 *   ② 信封字节数（1 MiB 上限的判据）；
 *   ③ 注入脚本的自包含不变量（`executeScript({func})` 给的是源码副本，引用模块作用域必炸）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  INPAGE_HELLO,
  INPAGE_IMPORT,
  INPAGE_MAX_BYTES,
  INPAGE_PREFIX,
  INPAGE_READY,
  INPAGE_RESULT,
  INPAGE_VERSION,
  inpageBytes,
  isHttpUrl,
  isWebCandidate,
  pickWebCandidate,
  webHostOf,
  webOriginOf,
} from "../src/lib/inpage.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const tab = (over = {}) => ({ id: 1, url: "https://buglan.github.io/opennote/", title: "Opennote · 开源笔记", index: 0, ...over });

test("候选判定：标题或 URL 里带 opennote，且必须是 http(s)", () => {
  assert.equal(isWebCandidate(tab()), true);
  // 标题里有，URL 里没有 —— 部署在自定义域名上的网页版就是这一种
  assert.equal(isWebCandidate(tab({ url: "https://notes.example.com/", title: "Opennote · 开源笔记" })), true);
  // URL 里有，标题被站点改过
  assert.equal(isWebCandidate(tab({ title: "我的笔记" })), true);
  // 普通页面
  assert.equal(isWebCandidate(tab({ url: "https://example.com/a", title: "某篇文章" })), false);
  // 受限 scheme / 没有 url / 没有 id
  assert.equal(isWebCandidate(tab({ url: "chrome://extensions" })), false);
  assert.equal(isWebCandidate(tab({ url: "file:///E:/opennote/index.html" })), false);
  assert.equal(isWebCandidate({ title: "Opennote", url: "https://x.test/" }), false);
  assert.equal(isWebCandidate(null), false);
});

test("候选判定：正在被剪的那个标签页、以及本会话握手失败过的标签页都排除", () => {
  assert.equal(isWebCandidate(tab({ id: 7 }), { excludeTabId: 7 }), false);
  assert.equal(isWebCandidate(tab({ id: 7 }), { excludeTabId: 8 }), true);
  assert.equal(isWebCandidate(tab({ id: 7 }), { blocked: [7] }), false);
  assert.equal(isWebCandidate(tab({ id: 7 }), { blocked: new Set([7]) }), false);
  assert.equal(isWebCandidate(tab({ id: 7 }), { blocked: [8] }), true);
});

test("挑一个候选：URL 里带 opennote 的优先，其次活动标签页，再次标签页顺序", () => {
  const picked = pickWebCandidate([
    tab({ id: 1, url: "https://notes.example.com/", title: "Opennote · 开源笔记", index: 1 }),
    tab({ id: 2, url: "https://buglan.github.io/opennote/", title: "随便什么标题", index: 2 }),
  ]);
  assert.deepEqual(picked, {
    tabId: 2,
    url: "https://buglan.github.io/opennote/",
    title: "随便什么标题",
    origin: "https://buglan.github.io",
    host: "buglan.github.io",
  });

  // 没有候选 → null（popup 上就不出现按钮）
  assert.equal(pickWebCandidate([tab({ url: "https://example.com/", title: "某篇文章" })]), null);
  assert.equal(pickWebCandidate([]), null);
  // 活动标签页优先于顺序
  const active = pickWebCandidate([
    tab({ id: 1, url: "https://a.example.com/opennote/", index: 9, active: true }),
    tab({ id: 2, url: "https://b.example.com/opennote/", index: 1, active: false }),
  ]);
  assert.equal(active.tabId, 1);
});

test("origin / host 解析：本地开发地址（带端口）也照样给出可读的域名", () => {
  assert.equal(webOriginOf("http://127.0.0.1:5173/"), "http://127.0.0.1:5173");
  assert.equal(webHostOf("http://127.0.0.1:5173/"), "127.0.0.1:5173");
  assert.equal(webOriginOf("不是地址"), null);
  assert.equal(webHostOf("不是地址"), null);
  assert.equal(isHttpUrl("https://x.test/a"), true);
  assert.equal(isHttpUrl("data:text/html,<b>x</b>"), false);
});

test("信封字节数按 UTF-8 算；不可序列化时返回 null", () => {
  assert.equal(inpageBytes({ a: "中" }), Buffer.byteLength(JSON.stringify({ a: "中" }), "utf8"));
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(inpageBytes(cyclic), null);
  // 1 MiB 是**渠道上限**：判据必须能在剪藏之前算出来（而不是发出去才发现）
  assert.equal(inpageBytes({ body: "x".repeat(INPAGE_MAX_BYTES) }) > INPAGE_MAX_BYTES, true);
});

test("协议常量：前缀唯一，四条类型都在前缀下，版本是 1", () => {
  assert.equal(INPAGE_PREFIX, "opennote:inpage:");
  assert.equal(INPAGE_VERSION, 1);
  for (const type of [INPAGE_HELLO, INPAGE_READY, INPAGE_IMPORT, INPAGE_RESULT]) {
    assert.equal(type.startsWith(INPAGE_PREFIX), true);
  }
});

test("注入脚本自包含：只有一个顶层声明，且不 import 任何东西", () => {
  const source = readFileSync(join(HERE, "..", "src", "content", "inpage-bridge.js"), "utf8");
  const topLevel = source.match(/^export /gm) || [];
  assert.equal(topLevel.length, 1, "executeScript({func}) 传的是源码副本，顶层只能有一个声明");
  assert.equal(/^import\s/m.test(source), false, "内容脚本不能用 ESM import");
  assert.equal(source.includes("export async function deliverInpage(payload)"), true);
  // 协议字面量必须在这里再写一遍（不能 import），V21 负责比对两处一致
  assert.equal(source.includes('"opennote:inpage:"'), true);
  assert.equal(source.includes("window.postMessage(message, origin)"), true);
  assert.equal(/postMessage\([^)]*,\s*"\*"\s*\)/.test(source), false);
});
