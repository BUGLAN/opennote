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

test("② 卡片正文用编辑器同一批令牌（等宽正文 + 行高；**字号在 popup 里收小**）", () => {
  const doc = (CSS.match(/^\.clip__doc\{[^}]*\}/m) || [])[0] || "";
  assert.ok(doc.length > 0, "缺少 .clip__doc 规则");
  assert.match(doc, /font-family:var\(--font-mono\)/, "正文等宽（应用里 --font-mono 是同一族的来源）");
  assert.match(doc, /line-height:var\(--doc-lh\)/, "行高取 --doc-lh（不凭目测写 1.9）");
  assert.match(doc, /padding-left:var\(--s4\)/, "左侧留白用既有间距令牌");
  /*
   * 字号：**0.3.3 起不再是 `--doc-fs`**（用户原话「选择的字体太大了」）。
   * 应用侧的 `--doc-fs:16.5px` 是给整窗编辑器用的；360px 宽的 popup 里它太大。
   * 这条判据原来断言的是 `var(--doc-fs)` —— 那是**旧要求**，改规则就要连着改判据，
   * 并在原地写清为什么（否则下一个人会以为实现漂移了又改回去）。
   * 新要求：用 popup 自己的层级字号 `--fs-md`（13.5px），**不新增令牌、也不动 tokens.css**。
   */
  assert.match(doc, /font-size:var\(--fs-md\)/, "popup 里的正文字号用 --fs-md（用户要求收小）");
  assert.doesNotMatch(doc, /--doc-fs/, "不许再用应用侧的大字号令牌");
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

test("③ 图片开关是工具条上的复选框、默认关；开关下面那三条说明句已按用户要求删除", () => {
  assert.match(code, /let imageDownload = IMAGE_DOWNLOAD_DEFAULT;/, "默认值只有一个产地");
  assert.match(code, /input\.type = "checkbox";/);
  assert.match(code, /input\.id = "imgDownload";/);
  assert.match(code, /"图片一起保存"/, "开关的文字标签");
  /*
   * 0.3.3（用户真机截图的两个红框之一）：开关下面那三条状态说明（关 / 开 / 这一页没图）**整段删除**。
   * 判据盯**删除本身**，而且扫**原文**（不剥注释）—— 注释也是标签，留一句「已删除」的原句
   * 会让这条判据变成空话（同 ④ 的做法）：
   * 实现里只要还有人写回这句话（哪怕是帮助文案、哪怕是注释里的引用），这条就红。
   * 删的是说明句，**不是「不许静默」**：图片真的没下下来时，`warnings[]` 照样逐条说出来。
   */
  for (const gone of ["imageNote", "imgDownloadNote", "正文里保留图片的原始网址"]) {
    assert.ok(!JS.includes(gone), `已删除的说明句/接线不许留在 popup.js 里：${gone}`);
  }
  // 工具条仍是两个按钮：开关不在工具条里（M1 冻结决定不破）
  assert.doesNotMatch(BARE, /id="imgDownload"/, "开关是渲染出来的，不写死在 popup.html 的工具条里");
});

test("③ 图片开关与两个按钮**始终**同一行：插在 #pickNote 之前（用户 0.3.3 真机截图）", () => {
  /*
   * 位置这件事踩过两次，判据必须把两次都钉住：
   * ① 它原来在卡片里（`previewNode()` 尾部），理由是「工具条恰好两个按钮」。用户看过真机截图后
   *    要求挪到工具条那一行 —— **这没破 ㊶**：㊶ 冻结的是「工具条上的**动作**只有两个」
   *    （不许再加一个能点出结果的按钮），而这是一个复选框（一个选项）。
   * ② 挪进来之后它排在 `#pickNote` **后面**，而 `#pickNote` 是 `flex-basis:100%` 的整行子项 ——
   *    于是只要那一行有话说（点选失败 / 等待点选），开关就被挤到**第三行**（用户 0.3.3 的第二张截图
   *    就是这个：按钮一行、说明句一行、开关单独一行）。用户要的是「**始终**和两个按钮同一行」，
   *    所以判据不能只盯「元素还在」或「挂在 #pickRow 里」，必须盯**兄弟顺序**：
   *    写在整行子项之后的位置一律不算同一行，无论它当时看起来在不在那一行上。
   */
  assert.match(code, /const pickRow = \$\("pickRow"\);/, "必须真的拿到工具条那一行");
  assert.match(
    code,
    /pickRow\.insertBefore\(imageSwitch\(\), pickNote\);/,
    "开关必须插在两个按钮之后、#pickNote 之前（appendChild 会被整行子项挤到下一行）",
  );
  assert.doesNotMatch(code, /pickRow\.appendChild\(imageSwitch\(\)\)/, "排在整行子项后面的位置不算「同一行」");
  // 说明句整段退场：连带它的 CSS 规则一起删（写了不生效 = 缺陷）。
  // 查的是**规则**（`.clip__assets-note{`）而不是「某个注释里提过这个类名」——
  // 注释里的墓碑不算规则，但留在 CSS 里的规则一定算。
  assert.doesNotMatch(CSS, /\.clip__assets-note\s*\{/, "已删除的说明句规则必须从 popup.css 删掉");
  assert.match(CSS, /\.clip__assets-sw\{margin-left:auto;/, "开关靠右，与按钮同一行");
  /*
   * **必须断言调用点，不能只断言函数体。**
   *
   * 第一版只断言了 `pickRow.appendChild(imageSwitch())` 存在 —— 那条断言在**函数体**里就满足了，
   * 于是把 `render()` 里的 `mountImageSwitch();` 换成「挂回卡片」时，断言照样全绿（变异 Q1 抓到的）。
   * 「函数写好了但没人调用」和「挂错地方」是同一种缺陷，判据必须盯**谁在什么时机调用它**。
   */
  const renderBody = code.slice(code.indexOf("function render("), code.indexOf("function schedulePreview("));
  assert.ok(renderBody.length > 0, "找不到 render() 函数体 —— 判据的被判对象消失了，必须红");
  assert.match(renderBody, /mountImageSwitch\(/, "render() 必须真的调用 mountImageSwitch()（否则开关根本不出现）");
  // 「界面上不留任何死元素」：受限页面（chrome:// 等）连正文都读不到，开关在那儿改不了任何结果。
  assert.match(
    renderBody,
    /mountImageSwitch\([^;]*RESTRICTED_PAGE[^;]*\)/,
    "受限页面必须把开关摘掉（否则就是一个死元素）",
  );
  assert.doesNotMatch(code, /imageRow\(/, "旧的「卡片里的开关行」必须退场");
  assert.doesNotMatch(code, /box\.appendChild\(imageSwitch\(\)\)/, "不许同时留在卡片里（两处渲染 = 两个产地）");
  assert.ok(!CSS.includes(".clip__assets{"), "旧的 .clip__assets wrapper 规则必须删掉（写了不生效 = 缺陷）");
  // 工具条仍是「两个按钮」：开关不是按钮（㊶ 冻结的是动作数量，不是选项数量）
  assert.equal((BARE.match(/<button[^>]*id="(pick|extractPage)"/g) || []).length, 2, "工具条恰好两个按钮");
});

/* ── ④ popup 外壳三项（task-7，用户真机截图提的） ─────────────────────── */

/** `.clip{…}` 这条外壳规则（`\.clip\{` 不会误匹配 `.clip__head{`）。 */
function shellRule() {
  const found = (CSS.match(/\.clip\{[^}]*\}/) || [])[0] || "";
  assert.ok(found, "找不到 .clip 外壳规则 —— 判据的被判对象消失了，必须红（不是跳过）");
  return found;
}

test("① 外框不做圆角：popup 窗口不可能透明，圆角只会露出窗口自身的底色", () => {
  const shell = shellRule();
  assert.doesNotMatch(shell, /border-radius/, "最外层不许有圆角（四个角会露出窗口底色，比不做圆角更难看）");
  assert.doesNotMatch(shell, /box-shadow/, "元素填满窗口 ⇒ 阴影全在窗口外被裁掉，是写了不生效的死样式");
  // 反面：不是把圆角一刀切掉 —— 内部卡片仍保留圆角（否则这条判据可以靠「全删圆角」蒙过去）
  assert.match(CSS, /\.clip__preview\{[^}]*border-radius/, "内部卡片必须保留圆角");
});

test("③ 高度固定：不许再随内容跳（min-height / max-height 都去掉）", () => {
  const shell = shellRule();
  assert.match(shell, /height:600px/, "固定 600px（Chrome popup 的上限）");
  assert.doesNotMatch(shell, /min-height|max-height/, "不许再有随内容变化的上下限");
});

test("② 预览正文字号改用既有令牌 --fs-md；tokens.css 一个字节都不动", () => {
  const doc = (CSS.match(/\.clip__doc\{[^}]*\}/) || [])[0] || "";
  assert.ok(doc, "找不到 .clip__doc 规则");
  assert.match(doc, /font-size:var\(--fs-md\)/, "360px 宽的 popup 里 16.5px 太大");
  assert.doesNotMatch(doc, /--doc-fs/, "不许再用应用侧的大字号令牌");
  // 只改局部规则、不动令牌表：`--doc-fs` 的值必须原样（另有 55 令牌 sha256 门禁兜底，这里加一层）
  const tokens = readFileSync(join(ROOT, "src", "styles", "tokens.css"), "utf8");
  assert.match(tokens, /--doc-fs:\s*16\.5px/, "tokens.css 的 --doc-fs 必须原样不动");
});

test("④ 交付提示：inbox 那一支不再渲染，被删的那句不许再出现在 popup.js（含注释）", () => {
  assert.match(code, /if \(inbox === true\) \{/, "必须有 inbox 分支（有意的空分支，理由写在注释里）");
  assert.match(code, /deliveryHint\.hidden = true;/, "inbox 时要把整行藏起来（空 <p> 仍会占着自己的 margin）");
  // 扫**原文**（不剥注释）：注释也是标签，留一句「已删除」的原句会让这条判据变成空话。
  assert.doesNotMatch(JS, /在收件箱里确认后才会写成笔记/, "用户要求删掉的那句不许留在 popup.js 里");
  assert.match(code, /这次会直接写成笔记，可以在 Opennote 里撤销。/, "C47 保留（说的是另一件事）");
  assert.match(code, /交付方式由 Opennote 的设置决定，剪藏完成后会如实显示结果。/, "C48 保留");
});
