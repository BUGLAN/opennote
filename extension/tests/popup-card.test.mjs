/**
 * ⑤ 选中态 + ② 预览卡片（task-3）· **界面上的事实**，逐条可证伪。
 *
 * 为什么单独一个文件：这两项改的是「用户看得见的东西」，而它们的判据既不在信封里、也不在桥上。
 * 判据分三层：
 *   ① `aria-pressed` 是选中态的**唯一状态源**（读屏与视觉用同一个值，不许各写一套）；
 *   ② 着色**只用既有令牌**（新增令牌 0 —— V6 另有机械兜底，这里加一层「不许写死色值」）；
 *   ③ 渲染器产出的每个类名，CSS 里都必须真的有规则（**写了不生效**与「没写」一样是缺陷）。
 *
 * 图片见 `extension/.shots/`（`node tools/popup-shot.mjs`，诊断工具、不是门禁），
 * 真机 action popup 的点击路径归 `T-11`（人工）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const HTML = readFileSync(join(ROOT, "src", "popup", "popup.html"), "utf8");
const BARE = HTML.replace(/<!--[\s\S]*?-->/g, "");
const JS = readFileSync(join(ROOT, "src", "popup", "popup.js"), "utf8");
const CSS = readFileSync(join(ROOT, "src", "popup", "popup.css"), "utf8");
/** 注释里解释「以前这里写死 ex.article.excerpt」会把判据带偏 —— 一律先剥注释。 */
const code = JS.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

/* ── ⑤ 选中态 ─────────────────────────────────────────────────────────── */

test("⑤ 两个按钮都有 aria-pressed（读屏与视觉用同一个状态源）", () => {
  const pick = (BARE.match(/<button[^>]*id="pick"[^>]*>/) || [])[0] || "";
  const extract = (BARE.match(/<button[^>]*id="extractPage"[^>]*>/) || [])[0] || "";
  assert.match(pick, /aria-pressed="false"/, "「选择当前元素」初始未选中");
  assert.match(extract, /aria-pressed="true"/, "「整页提取」是默认来源 ⇒ 初始选中（03 §UI-01）");
});

test("⑤ aria-pressed 由当前来源决定（不是写死的装饰）", () => {
  assert.match(code, /pickButton\.setAttribute\("aria-pressed", mode === "element" \? "true" : "false"\)/);
  assert.match(code, /extractPageButton\.setAttribute\("aria-pressed", mode === "page" \? "true" : "false"\)/);
  // 打开 popup 的默认来源：本页已选过元素 → element；否则 page（与按钮文案同一份判断）
  assert.match(code, /mode = picked && picked\.tagName \? "element" : "page";/);
});

test("⑤ 选中态只用既有令牌着色，且 popup.css 里没有任何写死的颜色", () => {
  const active = (CSS.match(/\.clip__pick \.btn\[aria-pressed="true"\][^}]*\}/g) || []).join("\n");
  assert.ok(active.length > 0, "必须有一条 aria-pressed=true 的样式规则");
  for (const token of ["var(--accent-soft)", "var(--accent-line)", "var(--accent)"]) {
    assert.ok(active.includes(token), `选中态必须用到 ${token}`);
  }
  assert.doesNotMatch(CSS, /#[0-9a-fA-F]{3,8}\b/, "popup.css 不许出现十六进制色值（唯一例外：.seal 的 rgb() 内高光也不是 hex）");
});

/* ── ② 预览卡片：取值逐条对照应用 ───────────────────────────────────────── */

test("② 卡片正文用编辑器同一批令牌（等宽正文 + 文档字号/行高）", () => {
  const doc = (CSS.match(/^\.clip__doc\{[^}]*\}/m) || [])[0] || "";
  assert.ok(doc.length > 0, "缺少 .clip__doc 规则");
  assert.match(doc, /font-family:var\(--font-mono\)/, "正文等宽（应用里 --font-mono 是同一族的来源）");
  assert.match(doc, /font-size:var\(--doc-fs\)/, "字号取 --doc-fs（不凭目测写 20px）");
  assert.match(doc, /line-height:var\(--doc-lh\)/, "行高取 --doc-lh（不凭目测写 1.9）");
  assert.match(doc, /padding-left:var\(--s4\)/, "左侧留白用既有间距令牌");
});

test("② H1/H2 与应用取值一致（衬线粗体 + 通栏细线 + 暗灰 # 标记）", () => {
  // 字重/字体在**共用**的标题规则里（`h1,h2,h3,h4{font-family:var(--font-serif);font-weight:600}`），
  // 不是在 h1 单独那条里 —— 判据得看真的那一行，不然会在产品正确时报假红。
  const shared = (CSS.match(/\.clip__doc h1,\.clip__doc h2,\.clip__doc h3,\.clip__doc h4\{[^}]*\}/) || [])[0] || "";
  const h1 = (CSS.match(/^\.clip__doc h1\{[^}]*\}/m) || [])[0] || "";
  const h2 = (CSS.match(/^\.clip__doc h2\{[^}]*\}/m) || [])[0] || "";
  assert.match(shared, /font-family:var\(--font-serif\)/, "标题族必须用 --font-serif");
  assert.match(shared, /font-weight:600/, "标题字重 600");
  assert.match(h1, /font-size:1\.85em/, "H1 字号必须与 editor.css 的 1.85em 一致");
  assert.match(h1, /border-bottom:2px solid var\(--rule\)/, "H1 下方 2px 通栏细线");
  assert.match(h2, /font-size:1\.45em/, "H2 字号必须与 editor.css 的 1.45em 一致");
  assert.match(h2, /border-bottom:1px solid var\(--rule\)/, "H2 下方 1px 细线");
  const hash = (CSS.match(/\.clip__doc \.doc-hash\{[^}]*\}/) || [])[0] || "";
  assert.match(hash, /color:var\(--ink-3\)/, "`#` 标记用 --ink-3（与 editor.css 的 .md-src 同色）");
  assert.match(hash, /font-weight:400/, "`#` 不吃标题的粗体");
});

test("② 表格通栏、1px 边框、表头背景略不同、单元格等宽", () => {
  const table = (CSS.match(/^\.clip__doc \.doc-table\{[^}]*\}/m) || [])[0] || "";
  const cells = (CSS.match(/\.clip__doc \.doc-table th,\.clip__doc \.doc-table td\{[^}]*\}/) || [])[0] || "";
  const head = (CSS.match(/^\.clip__doc \.doc-table th\{[^}]*\}/m) || [])[0] || "";
  assert.match(table, /width:100%/, "表格通栏");
  assert.match(table, /font-family:var\(--font-mono\)/, "单元格等宽");
  assert.match(cells, /border:1px solid var\(--rule\)/, "1px 边框");
  assert.match(head, /background:var\(--paper-3\)/, "表头背景略不同（既有令牌）");
});

test("② 预览是只读文档层：不加载远程图片、不用 innerHTML", () => {
  assert.doesNotMatch(code, /innerHTML/, "渲染器不许用 innerHTML（一律 createElement + textContent）");
  assert.doesNotMatch(code, /createElement\("img"\)|createElement\('img'\)/, "预览不加载远程图片（图片按文字占位）");
  assert.match(code, /const DOC_MAX_BLOCKS = \d+;/, "必须有块数上限（预览不是全文渲染）");
  assert.match(code, /预览只显示开头，剪藏后是完整正文。/, "截断了就要说出来（不许静默截断）");
});

test("② 渲染器认识的块级语法，CSS 里都有对应规则（写了不生效 = 缺陷）", () => {
  // 判据逐条点名胜出「渲染器处理了哪种块」+「这类块用的类名真的有 CSS 规则」。
  // 第一版想自动扫 `el("tag","class")`，结果漏了三元表达式那种写法（`el(cond ? "ol" : "ul", "doc-list")`）
  // —— 判据自己写窄了会假红，写宽了会恒绿，所以这里改成**逐条点名的白名单**。
  const blocks = [
    ["doc-hash", /span", "doc-hash"/, "标题的 `#` 标记"],
    ["doc-table-wrap", /"doc-table-wrap"/, "表格的横向滚动容器"],
    ["doc-table", /"doc-table"/, "表格本体"],
    ["doc-table", /tableBlock\(/, "表格解析"],
    ["doc-code", /codeBlock\(/, "代码块"],
    ["doc-inline", /"doc-inline"/, "行内代码"],
    ["doc-quote", /"doc-quote"/, "引用"],
    ["doc-list", /"doc-list"/, "列表"],
    ["doc-hr", /"doc-hr"/, "分隔线"],
    ["doc-note", /"doc-note"/, "截断提示"],
  ];
  for (const [className, emission, label] of blocks) {
    assert.match(code, emission, `渲染器必须处理${label}（找的是 ${emission}）`);
    assert.ok(CSS.includes(`.${className}`), `.${className} 在 popup.css 里没有规则 —— 写了不生效`);
  }
});

/* ── ③ 图片开关（DOM 那一半） ─────────────────────────────────────────── */

test("③ 图片开关是卡片上的复选框、默认关、且说明随状态改口", () => {
  assert.match(code, /let imageDownload = IMAGE_DOWNLOAD_DEFAULT;/, "默认值只有一个产地");
  assert.match(code, /input\.type = "checkbox";/);
  assert.match(code, /input\.id = "imgDownload";/);
  assert.match(code, /"图片一起保存"/, "开关的文字标签");
  assert.match(code, /关：正文里保留图片的原始网址。/, "关着时说明后果");
  assert.match(code, /会尝试下载这 \$\{count\} 张图片随笔记一起保存；下载失败的，正文里保留原始网址。/, "开着时说明会尝试下载（不是承诺成功）");
  assert.match(code, /这一页没找到可以下载的图片，正文里保留原始网址。/, "0 张图时也要说清楚");
  // 工具条仍是两个按钮：开关不在工具条里（M1 冻结决定不破）
  assert.doesNotMatch(BARE, /id="imgDownload"/, "开关是渲染出来的，不写死在 popup.html 的工具条里");
});
