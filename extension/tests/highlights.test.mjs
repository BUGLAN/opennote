/**
 * 高亮单测（00 §6.14 ㉚）。
 *
 * 覆盖 task-13 验收：
 *   ③ 高亮写入「## 高亮」小节，**空高亮不生成该小节**
 *   ④ 追加到指定笔记 → `target.notePath`（并强制 `conflict: "append"`）
 *   ⑤ 信封仍然**不含** `conflict` 键（§6.13⑳ 红线）
 * 另加：按 URL 分组、上限淘汰、`source.selection` 不被高亮影响。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  HIGHLIGHTS_KEY,
  HIGHLIGHT_COLORS,
  HIGHLIGHT_LEGACY_COLORS,
  HIGHLIGHT_SECTION_TITLE,
  HIGHLIGHT_SWATCHES,
  MAX_HIGHLIGHTS_PER_URL,
  addHighlight,
  clearHighlights,
  countHighlights,
  defaultHighlights,
  highlightLine,
  highlightOption,
  highlightSection,
  highlightTier,
  listHighlights,
  normalizeHighlight,
  normalizeUrl,
  removeHighlight,
  withHighlightSection,
} from "../src/lib/highlights.js";
import { buildEnvelope, envelopeProblems, ENVELOPE_KEYS, NOTE_PATH_RE } from "../src/lib/envelope.js";

/* ─────────────────── 键名与形态（㉚ 逐字） ─────────────────── */

test("存储键与正文小节标题逐字照 ㉚", () => {
  assert.equal(HIGHLIGHTS_KEY, "opennote.highlights.v1");
  assert.equal(HIGHLIGHT_SECTION_TITLE, "## 高亮");
});

test("③ 有高亮时写成「## 高亮」小节：> 摘录 + 空行 + — 批注", () => {
  // 形态逐字节对齐 03 §UI-14「写入正文的形态」：摘录内部换行折叠成单个空格，批注前空一行
  const section = highlightSection([
    { text: "第一条摘录", note: "我的批注" },
    { text: "第二条摘录" },
  ]);
  assert.equal(section, "## 高亮\n\n> 第一条摘录\n\n— 我的批注\n\n> 第二条摘录");
  assert.equal(highlightLine({ text: "只有摘录" }), "> 只有摘录");
  assert.equal(highlightLine({ text: "摘录", note: "批注" }), "> 摘录\n\n— 批注");
  // 反向：旧形态（逐行加 `> `）必须不再出现 —— 这条断言能独立红
  assert.ok(!highlightLine({ text: "多行\n摘录" }).includes("> 多行\n> "), "多行摘录不得逐行加引用符号");
  assert.equal(highlightLine({ text: "多行\n摘录" }), "> 多行 摘录");
});

test("㉚/㉜ 两档底色：yellow → --mark；accent → --accent-soft；历史四色保留原值但按 yellow 渲染", () => {
  assert.deepEqual(HIGHLIGHT_COLORS, ["yellow", "accent"]);
  assert.deepEqual(HIGHLIGHT_LEGACY_COLORS, ["red", "green", "blue", "purple"]);
  assert.equal(highlightTier("yellow"), "yellow");
  assert.equal(highlightTier("accent"), "accent");
  // 历史数据**不删不改**（存储里原样），只是渲染降级成 yellow
  for (const legacy of HIGHLIGHT_LEGACY_COLORS) {
    assert.equal(highlightTier(legacy), "yellow", `${legacy} 必须按 yellow 渲染`);
    assert.equal(normalizeHighlight({ text: "x", color: legacy }).color, legacy, `${legacy} 的存储值必须原样保留`);
  }
  // 认不出来的颜色不落存储（null），渲染时同样按 yellow
  assert.equal(normalizeHighlight({ text: "x", color: "彩色" }).color, null, "不认识的颜色的存储值是 null");
  assert.equal(highlightTier(null), "yellow", "null 也必须按 yellow 渲染");
  assert.equal(highlightTier(undefined), "yellow", "缺省也必须按 yellow 渲染");
  assert.deepEqual(HIGHLIGHT_SWATCHES.map((swatch) => swatch.label), ["默认底色", "强调底色"]);
  assert.ok(HIGHLIGHT_SWATCHES.every((swatch) => HIGHLIGHT_COLORS.includes(swatch.value)), "swatch 只能是两档");
});

test("③ 空高亮不生成小节（正文一字不改，连空行都不多加）", () => {
  assert.equal(highlightSection([]), "");
  assert.equal(highlightSection([{ text: "   " }]), "");
  assert.equal(withHighlightSection("正文内容", []), "正文内容");
  assert.equal(withHighlightSection("正文内容\n\n", []), "正文内容\n\n");
  assert.equal(withHighlightSection("", []), "");
  assert.equal(withHighlightSection("正文内容", [{ text: "摘录" }]), "正文内容\n\n## 高亮\n\n> 摘录\n");
  // 空正文 + 有高亮：只有小节，不出现前导空行
  assert.equal(withHighlightSection("", [{ text: "摘录" }]), "## 高亮\n\n> 摘录\n");
});

/* ─────────────────── 数据模型与分组 ─────────────────── */

test("记录形态 { text, note?, color?, createdAt, selector } + 内部 id", () => {
  const item = normalizeHighlight({ text: " 摘录 ", note: " 批注 ", color: "yellow", selector: "p:nth-of-type(2)" });
  assert.equal(item.text, "摘录");
  assert.equal(item.note, "批注");
  assert.equal(item.color, "yellow");
  assert.equal(item.selector, "p:nth-of-type(2)");
  assert.ok(typeof item.id === "string" && item.id.length > 0);
  assert.match(item.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  // 空白不算高亮；非法 color 归一成 null
  assert.equal(normalizeHighlight({ text: "   " }), null);
  assert.equal(normalizeHighlight({ text: "x", color: "#ff0" }).color, null);
  // 超长截断（不静默丢内容，只截到上限）
  assert.equal(normalizeHighlight({ text: "a".repeat(5000) }).text.length, 2000);
});

test("按 URL 分组（忽略 hash），不同页面互不串组", () => {
  assert.equal(normalizeUrl("https://a.test/x#frag"), "https://a.test/x#frag".replace("#frag", ""));
  let store = defaultHighlights();
  store = addHighlight(store, { url: "https://a.test/x#one", text: "第一条" }).store;
  store = addHighlight(store, { url: "https://a.test/x#two", text: "第二条" }).store;
  store = addHighlight(store, { url: "https://b.test/y", text: "别页" }).store;
  assert.equal(listHighlights(store, "https://a.test/x").length, 2);
  assert.equal(listHighlights(store, "https://b.test/y").length, 1);
  assert.equal(countHighlights(store), 3);
  assert.deepEqual(Object.keys(store.groups).sort(), ["https://a.test/x", "https://b.test/y"]);
});

test("重复摘录不重复记；删除与清空都生效", () => {
  let store = defaultHighlights();
  const first = addHighlight(store, { url: "https://a.test/x", text: "同一条" });
  assert.equal(first.added, true);
  const again = addHighlight(first.store, { url: "https://a.test/x", text: "同一条" });
  assert.equal(again.added, false);
  assert.equal(again.reason, "duplicate");
  assert.equal(listHighlights(again.store, "https://a.test/x").length, 1);

  const removed = removeHighlight(again.store, "https://a.test/x", listHighlights(again.store, "https://a.test/x")[0].id);
  assert.equal(removed.removed, true);
  assert.equal(listHighlights(removed.store, "https://a.test/x").length, 0);
  assert.equal(removeHighlight(removed.store, "https://a.test/x", "nope").removed, false);

  const many = addHighlight(first.store, { url: "https://a.test/x", text: "第二条" });
  const cleared = clearHighlights(many.store, "https://a.test/x");
  assert.equal(cleared.cleared, 2);
  assert.equal(countHighlights(cleared.store), 0);
});

test("单页上限：超出后淘汰最早的一条（不静默涨到无限）", () => {
  let store = defaultHighlights();
  for (let index = 0; index < MAX_HIGHLIGHTS_PER_URL + 3; index += 1) {
    store = addHighlight(store, { url: "https://a.test/x", text: `摘录 ${index}` }).store;
  }
  const items = listHighlights(store, "https://a.test/x");
  assert.equal(items.length, MAX_HIGHLIGHTS_PER_URL);
  assert.equal(items[0].text, "摘录 3", "最早的 3 条被淘汰");
});

test("popup 一行摘要（高亮区的列表项）", () => {
  const option = highlightOption({ text: "很长的摘录".repeat(40), note: "批注", color: "blue" }, 2);
  assert.equal(option.index, 3);
  assert.equal(option.note, "批注");
  assert.ok(option.excerpt.length <= 121);
  assert.equal(highlightOption({ text: "  " }), null);
});

/* ─────────────────── ④⑤ 信封：notePath 与 conflict ─────────────────── */

test("④ 追加到指定笔记写进 target.notePath，并强制 conflict: \"append\"", () => {
  const envelope = buildEnvelope({
    importId: "3f9a1c02-7e41-4b90-8a35-1d2c4f6a8b90",
    title: "追加测试",
    body: "正文",
    url: "https://example.com/post",
    folder: "剪藏",
    tags: ["排版"],
    notePath: "笔记/读书.md",
    conflict: "append",
  });
  assert.equal(envelope.target.notePath, "笔记/读书.md");
  assert.equal(envelope.target.folder, "剪藏");
  assert.equal(envelope.conflict, "append");
  assert.deepEqual(envelopeProblems(envelope), []);
});

test("④ notePath 只在 conflict=append 时有效：否则 envelopeProblems 直接报错", () => {
  const base = {
    importId: "3f9a1c02-7e41-4b90-8a35-1d2c4f6a8b90",
    title: "追加测试",
    body: "正文",
    url: "https://example.com/post",
    folder: null,
    tags: [],
  };
  const withoutAppend = buildEnvelope({ ...base, notePath: "笔记/读书.md" });
  assert.equal(withoutAppend.target.notePath, "笔记/读书.md");
  assert.equal("conflict" in withoutAppend, false);
  assert.ok(
    envelopeProblems(withoutAppend).some((problem) => problem.includes("只在 conflict")),
    "没有 conflict=append 时 notePath 必须被拦下（02 §2.4）",
  );

  // 绝对路径 / .. / 反斜杠 / 非 .md 一律拒绝
  for (const bad of ["/abs/x.md", "C:/x.md", "../x.md", "a/../x.md", "a\\b.md", "没有后缀"]) {
    assert.equal(NOTE_PATH_RE.test(bad), false, `${bad} 不该通过`);
  }
  for (const good of ["x.md", "笔记/读书.md", "a/b/c/长 文件名.md"]) {
    assert.equal(NOTE_PATH_RE.test(good), true, `${good} 应该通过`);
  }
  const illegal = buildEnvelope({ ...base, notePath: "../越界.md", conflict: "append" });
  assert.ok(envelopeProblems(illegal).some((problem) => problem.includes("工作区相对")));
});

test("⑤ 信封仍然不含 conflict 键（默认交付 = 交给应用侧收件箱设置与判定链）", () => {
  const envelope = buildEnvelope({
    importId: "3f9a1c02-7e41-4b90-8a35-1d2c4f6a8b90",
    title: "默认交付",
    body: "正文\n\n## 高亮\n\n> 摘录\n",
    url: "https://example.com/post",
    folder: "剪藏",
    tags: ["排版"],
  });
  assert.equal("conflict" in envelope, false, "缺省 = 没有显式策略，判定链第 3/4 步才可能生效");
  assert.deepEqual(Object.keys(envelope).filter((key) => !ENVELOPE_KEYS.includes(key)), []);
  assert.equal(envelope.target.notePath, null);
  assert.deepEqual(envelopeProblems(envelope), []);
  // 高亮只进 body，不动 source.selection
  assert.ok(envelope.body.includes("## 高亮"));
  assert.equal(envelope.source.selection, false);
});

test("高亮不改 source.selection：同一页面同一模式，有无高亮都得到同一个判定输入", () => {
  const base = {
    importId: "3f9a1c02-7e41-4b90-8a35-1d2c4f6a8b90",
    title: "选区剪藏",
    url: "https://example.com/post",
    folder: null,
    tags: [],
    selection: true,
  };
  const withoutHighlights = buildEnvelope({ ...base, body: "选中的一句话。" });
  const withHighlights = buildEnvelope({ ...base, body: withHighlightSection("选中的一句话。", [{ text: "另外高亮的一句" }]) });
  assert.equal(withoutHighlights.source.selection, true);
  assert.equal(withHighlights.source.selection, true);
  assert.equal(withoutHighlights.source.selection, withHighlights.source.selection);
  assert.ok(withHighlights.body.includes("## 高亮"));
});
