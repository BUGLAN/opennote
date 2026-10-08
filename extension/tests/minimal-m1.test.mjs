/**
 * M1 极简（task-24）：`选择当前元素` + `整页提取` 两个按钮、没有死元素、来源信息允许空值。
 *
 * 这一组是**证伪式**断言：每一个都对应一条「如果回退就必须变红」的判据。
 * 尤其最后两条针对 Lead 点名的「看起来能红其实不会红」高发区：
 * - 缺失字段必须是 `null`（不是 `""`），否则「没作者」与「作者是空字符串」无法区分；
 * - 断言必须能区分「省略整行」与「整行是空值」—— 这里用 `!== ""` + `=== null` 双向卡住。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { SOURCE_KEYS, buildEnvelope } from "../src/lib/envelope.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const html = readFileSync(join(ROOT, "src/popup/popup.html"), "utf8");
const bare = html.replace(/<!--[\s\S]*?-->/g, "");
const popupJs = readFileSync(join(ROOT, "src/popup/popup.js"), "utf8");
const background = readFileSync(join(ROOT, "src/background.js"), "utf8");

test("M1：只有两个按钮，文案逐字", () => {
  assert.match(bare, /<button[^>]*type="button"[^>]*id="pick"[^>]*>选择当前元素</);
  assert.match(bare, /<button[^>]*type="button"[^>]*id="extractPage"[^>]*>整页提取</);
});

test("M1：三区 / 模板选择器 / 来源三选一 / 存到 / 标签 的 DOM 全部退场（不留死元素）", () => {
  for (const id of ["seg", "segmented", "regionHighlight", "regionProps", "sourceSwitch", "tmplRow", "template", "notePath", "tags", "folder", "footRow", "hlList"]) {
    assert.ok(!bare.includes(`id="${id}"`), `popup.html 里还留着已退场控件：#${id}`);
  }
  for (const token of ["data-region=", "data-mode=", "已高亮", "清除本页全部高亮"]) {
    assert.ok(!bare.includes(token), `popup.html 里还留着已退场界面的痕迹：${token}`);
  }
});

test("M1：popup 不再发已退场字段（契约只在两个按钮 + 正文这一处）", () => {
  for (const key of ["templateId", "props", "dirty"]) {
    assert.ok(!new RegExp(`\\b${key}:`).test(popupJs), `popup 仍然发送已退场字段 ${key}`);
  }
  assert.ok(popupJs.includes('type: "opennote:preview", mode'), "预览只应带 mode");
  assert.ok(popupJs.includes("opennote:submit") && popupJs.includes("opennote:stage"));
});

test("M2：模板与高亮连模块一起退场 —— 死代码与死存储键不许留在产物里", () => {
  assert.ok(!background.includes("opennote-highlight"), "background 里还留着右键高亮菜单项");
  for (const token of [
    "opennote.templates.v1",
    "opennote.highlights.v1",
    "withHighlightSection",
    "highlightInPage",
    "TEMPLATES_KEY",
    "HIGHLIGHTS_KEY",
  ]) {
    assert.ok(!background.includes(token), `background 里还留着已退场模块的痕迹：${token}`);
  }
  for (const path of ["src/lib/templates.js", "src/lib/highlights.js", "src/content/highlight.js", "src/options"]) {
    assert.ok(!existsSync(join(ROOT, path)), `已退场的文件还在：${path}`);
  }
});

test("M1：来源信息自动填写、允许空值 —— 缺失字段是 null 而不是空串（可证伪）", () => {
  const base = {
    importId: "test-m1",
    title: "示例标题",
    body: "# 正文",
    url: "https://example.com/posts/hello",
    capturedAt: "2026-01-01T00:00:00+08:00",
    selection: false,
  };
  const missing = buildEnvelope({ ...base });
  // ① 缺作者 / 缺发布时间 → 必须是 null（这样应用侧 02 的「null 则省略整行」才会生效）
  assert.equal(missing.source.author, null);
  assert.equal(missing.source.publishedAt, null);
  // ② 绝不能是空串：空串会让「没作者」与「作者是空字符串」变成同一件事
  assert.notEqual(missing.source.author, "");
  assert.notEqual(missing.source.publishedAt, "");
  // ③ 整个 source 里不许出现空串/占位值（不得为凑满 8 键填占位）
  for (const [key, value] of Object.entries(missing.source)) {
    assert.ok(value !== "" && value !== "null" && value !== "undefined", `source.${key} 不得是占位值：${JSON.stringify(value)}`);
  }
  // ④ 有值时如实带上（反向卡住「一律省略」这种假绿）
  const full = buildEnvelope({ ...base, pageTitle: "网页标题", author: "张三", publishedAt: "2026-01-01T08:00:00+08:00" });
  assert.equal(full.source.author, "张三");
  assert.equal(full.source.publishedAt, "2026-01-01T08:00:00+08:00");
});

/*
 * 0.4.x 用户实测（原话：「这两个图片删除…底部恢复常态 [剪藏到 Opennote] 即可」）：
 * 「剪藏成功 / 进收件箱 / 重复剪藏 / 图片降级」这几条**剪藏之后**的路径，底栏都必须是
 * 常态主按钮 —— 不再出现 `打开这篇笔记` / `再剪一段` 那两颗 30px 图标按钮。
 * 判据分两层：`state.js` 的两态不撤主按钮（行为层，见 `state.test.mjs`），
 * 以及 `popup.js` 的两条内联回执分支不给底栏塞动作（这一条）。
 */
test("M1：剪藏之后底栏恢复常态主按钮 —— 四态都不留图标动作", () => {
  /* 注释里解释了「这里不再置 plan.primary = null」，直接匹配源码会把注释本身当成违规 ——
     与 `popup-card.test.mjs` 同一条做法：先剥注释，再判。 */
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  /*
   * 抓「一个分支」：起点标记 + 直到同级收尾的 `}`。**抓到的片段必须够短**（下面那条断言在管）：
   * 第一版把「图片降级」的标记写成 `if (warnings.length) {` —— 文件名里有两处同名的判断，
   * 正则从**第一处**（`openClipWeb()` 里那个）起吞了 130 行半张文件，于是那条判据在旧代码上
   * 也是绿的（假绿）。判据自己也要能被证伪：抓错片段就必须红。
   */
  const branchOf = (src, marker, indent) => {
    const re = new RegExp(`${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?\\n${indent}\\}`);
    return (src.match(re) || [])[0] || "";
  };
  const state = strip(readFileSync(join(ROOT, "src/lib/state.js"), "utf8"));
  const popup = strip(popupJs);
  for (const [id, label] of [["SUCCESS", "S8"], ["INBOX_PENDING", "S23"]]) {
    const branch = branchOf(state, `if (state === STATE.${id}) {`, "  ");
    assert.ok(branch, `state.js 里找不到 ${label} 分支`);
    assert.ok(branch.split("\n").length < 20, `${label} 分支抓取过宽（抓到的是半张文件，判据会变假绿）`);
    assert.ok(!branch.includes("plan.primary = null"), `${label} 不许把底栏主按钮撤掉`);
    assert.ok(!/plan\.actions = \[/.test(branch), `${label} 不许再挂底栏动作`);
  }
  /* 「图片降级」的标记必须带上它前面那行 `const warnings = …`：
     文件名里 `if (warnings.length) {` 有两处（`openClipWeb()` 里还有一处），只写它就会抓错分支。 */
  for (const [name, marker] of [
    ["重复剪藏", 'if (reply.serverStatus === "duplicate") {'],
    ["图片降级", 'const warnings = Array.isArray(reply.warnings) ? reply.warnings.filter((item) => item) : [];\n    if (warnings.length) {'],
  ]) {
    const branch = branchOf(popup, marker, "    ");
    assert.ok(branch, `popup.js 里找不到${name}分支`);
    assert.ok(branch.split("\n").length < 20, `${name} 分支抓取过宽（抓到的是半张文件，判据会变假绿）`);
    assert.ok(!branch.includes("plan.primary = null"), `${name}：不许把底栏主按钮撤掉（那会把动作挤成图标）`);
    assert.ok(!branch.includes('id: "again"'), `${name}：不许再挂「再剪一段」图标动作`);
    assert.ok(!/label: "打开这篇笔记"/.test(branch), `${name}：不许再挂「打开这篇笔记」图标动作`);
  }
  // 「再剪一段」整条路径退场：图标、动作、处理器一起删（不留死代码）
  assert.ok(!popup.includes('"again"'), "popup.js 里还留着已退场的「再剪一段」");
  // 全文件只允许**插件设置**视图撤掉主按钮（那是一个没有剪藏动作的视图，`settingsPlan()`）
  assert.equal((popup.match(/plan\.primary = null/g) || []).length, 1, "除插件设置外，任何视图都不许撤掉底栏主按钮");
});

test("M1：来源字段的键集合不变（不增不减，避免为凑键位塞占位）", () => {
  const envelope = buildEnvelope({
    importId: "test-m1-2",
    title: "T",
    body: "B",
    url: "https://example.com/a",
    capturedAt: "2026-01-01T00:00:00+08:00",
  });
  // 用契约里导出的 SOURCE_KEYS 比对（不手抄一份，避免两处真源）\n  assert.deepEqual(Object.keys(envelope.source), [...SOURCE_KEYS]);
});

test("M1：来源字段透传 null —— 调用点不得用 `|| \"\"` / String() 兜底（可证伪）", () => {
  // 这条必须卡在 background.js 的**真实调用点**：只测 lib/envelope.js 测不到这个回归
  // （把 author 写成 `props.author || extraction.author || ""` 后，直接调 buildEnvelope 仍然是对的）。
  const call = (background.match(/return buildEnvelope\(\{[\s\S]*?\n  \}\);/m) || [])[0] || "";
  assert.ok(call, "background 里必须能找到 buildEnvelope 的调用点");
  for (const key of ["url:", "pageTitle:", "site:", "author:", "publishedAt:"]) {
    const line = call.split("\n").find((item) => item.trim().startsWith(key));
    assert.ok(line, `buildEnvelope 调用里缺少来源字段 ${key}`);
    assert.ok(!/\|\|\s*""/.test(line), `${key} 不得用空串兜底：${line.trim()}`);
    assert.ok(!/String\(/.test(line), `${key} 不得强转成字符串：${line.trim()}`);
  }
});