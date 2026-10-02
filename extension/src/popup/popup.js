/**
 * UI-01 · 剪藏弹窗控制器。
 *
 * 文案纪律：本文件里出现的所有中文串都必须在 03 §UI-01 / UI-02 的「中文文案（逐字）」表
 * 或 docs/import/mockups/01-extension-popup.html 里逐字存在；新增的只有「通道级通知」
 * （复制成功 / 需手动复制 / 暂存条目被丢弃），它们都指向明确的降级动作，
 * 清单见 extension/README.md「新增文案清单」。
 */

import { maskTokenTail } from "../lib/bridge.js";
import { userMessage } from "../lib/errors.js";
// task-21：四因文案与后台**同一份来源**（不再各写一套、也不再统一伪装成「页面类型不支持」）
import { PICK_FAIL_COPY } from "../lib/pick.js";
// ③ 图片开关的**默认值**与「暂存请求体」的形状都只有这一个产地（lib/stage.js）
import { IMAGE_DOWNLOAD_DEFAULT } from "../lib/stage.js";
import { STATE, planFor } from "../lib/state.js";

const $ = (id) => document.getElementById(id);
const clip = $("clip");
const chip = $("chip");
const chipText = $("chipText");
const regionBody = $("regionBody");
const region = $("region");
const footActs = $("footActs");
const primary = $("primary");
const more = $("more");
const menu = $("menu");
const deliveryHint = $("deliveryHint");
// 0.3.1（00 §6.15㉝㉞）：L2 元素入口 + 令牌块 + 高亮来源说明 + 清令牌确认
const pickButton = $("pick");
const extractPageButton = $("extractPage");
const pickRow = $("pickRow");
const pickNote = $("pickNote");
const pickDetail = $("pickDetail");
const tokenRow = $("tokenRow");
const tokenSaved = $("tokenSaved");
const tokenCode = $("tokenCode");
const tokenNext = $("tokenNext");
const tokenInputRow = $("tokenInputRow");
const tokenInput = $("tokenInput");
const tokenSave = $("tokenSave");
const tokenError = $("tokenError");
const tokenHint = $("tokenHint");
const tokenMain = $("tokenMain");
const tokenRepaste = $("tokenRepaste");
const tokenConfirm = $("tokenConfirm");
const tokenConfirmYes = $("tokenConfirmYes");
const tokenConfirmNo = $("tokenConfirmNo");

let snapshot = null;
// M1（task-24）：只剩两个按钮 —— `选择当前元素`（element）与 `整页提取`（page）。
// 默认整页提取；页面上已选过元素时（snapshot.pickedElement）切到 element。
let mode = "page";
let regionMode = "body";
let titleValue = "";
let titleTouched = false;
let busy = false;
let busyLabel = "正在剪藏…";
let settingsOpen = false;
let notice = "";
let noticeTimer = null;
let closeTimer = null;
let currentImportId = null;
let lastSignature = null;
let pendingNotePath = null;
/** 暂存成功、但因为图片降级说明要先给用户看，所以**延后**打开的那个 openUrl（接口给的原文，不改写）。 */
let pendingOpenUrl = null;

let previewTimer = null;
/** 预览里读到的「实际会发出去的值」，用于标签自动补全等展示。 */
let lastPreview = null;
/**
 * ③ 图片下载开关（00 §6.8③ / 交接 C-2 ③）：**默认关**。
 * 关闭时：不下发 `assets[]`（空数组）、不多注入一次、不产生任何额外请求；
 * 打开时：把「要保存哪些图」的清单（每项只有 `url` + `alt`）随正文一起交给本地接口。
 * **插件不下载图片字节**：host_permissions 只有 127.0.0.1 这 10 条，跨站 fetch 必然失败；
 * 下载与落盘由 Opennote 侧完成 —— 这是「不新增权限」的唯一诚实做法。
 */
let imageDownload = IMAGE_DOWNLOAD_DEFAULT;

/* ─────────────────────────── 基础设施 ─────────────────────────── */

/**
 * 给后台发一条消息。**必须有超时**：popup 是一次性界面，后台要是永不回（例如注入挂住），
 * 这里不设时限就等于永久白屏 —— 用户实测撞到过（停在「正在读取页面…」）。
 * 超时返回 `{ ok: false, timedOut: true }`，调用方必须给出**用户可见的出口**（不许静默 return）。
 */
const SEND_TIMEOUT_MS = 10000;

function send(message, timeoutMs = SEND_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, timedOut: true });
    }, timeoutMs);
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value == null ? null : value);
    };
    try {
      chrome.runtime.sendMessage(message, (reply) => {
        void chrome.runtime.lastError;
        done(reply);
      });
    } catch {
      done(null);
    }
  });
}

function newId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function signature(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return `${text.length}:${hash}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function extraction() {
  return snapshot ? snapshot.extraction : null;
}

function hasSelection() {
  const ex = extraction();
  return Boolean(ex && ex.selection && ex.selection.present);
}

function formatDate(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
}

function folderLabel() {
  // M1：`存到` 输入已退场；落点由 Opennote 侧设置决定（默认收件箱），这里只用于回执里的展示名。
  const value = String((snapshot && snapshot.settings && snapshot.settings.folder) || "").trim();
  return value || "根目录";
}

function pendingCount() {
  return (snapshot && snapshot.settings && snapshot.settings.pendingCount) || 0;
}

/* ─────────────────────────── 视图片段 ─────────────────────────── */

function skeletonNode() {
  const box = el("div", "clip__skeleton");
  for (const width of ["72%", "100%", "88%", "54%"]) {
    const bar = el("div", "clip__bar");
    if (width !== "100%") bar.style.width = width;
    box.appendChild(bar);
  }
  return box;
}

function emptyNode(spec) {
  const box = el("div", "clip__empty");
  const seal = el("span", "empty__seal", "記");
  seal.setAttribute("aria-hidden", "true");
  box.appendChild(seal);
  box.appendChild(el("h3", null, spec.title));
  box.appendChild(el("p", null, spec.text));
  return box;
}

function okNode(spec) {
  const box = el("div", "clip__ok");
  const dot = el("span", "dot");
  dot.setAttribute("aria-hidden", "true");
  box.appendChild(dot);
  const text = el("div");
  text.appendChild(el("p", "msg", spec.message));
  if (spec.detail) text.appendChild(el("p", "detail", spec.detail));
  box.appendChild(text);
  return box;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** 右上箭头 + 方框 = 「在独立页面里打开」。卡片图标与底栏图标共用这一份路径。 */
const PATH_EXTERNAL = "M6 3h7v7M13 3 6.5 9.5M11 11v2H3V5h2";

/**
 * 内联 SVG 图标（非 emoji）。一律 `createElementNS` 拼，**不用 innerHTML** ——
 * 那是 ② 的硬约束，`self-contained.test.mjs` 与 `verify.mjs` 都在查这个字符串。
 *
 * `round = false` 保留原始描边端点：`iconExternal()` 是已冻结的视觉，不能因为这次
 * 抽出公共函数就顺手把它的端点从 butt 改成 round。
 */
function svgIcon(paths, { size = 14, round = true } = {}) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.4");
    if (round) {
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
    }
    svg.appendChild(path);
  }
  return svg;
}

/** 图标（内联 SVG，非 emoji）：右上箭头 + 方框 = 「在独立页面里打开」。 */
function iconExternal() {
  return svgIcon([PATH_EXTERNAL], { round: false });
}

/**
 * 底栏动作按钮的图标（0.3.4 用户：「图3这个文字出界，换成图标」）。
 *
 * 只有**底栏**那颗按钮用它。错误块里的动作（`重试` / `打开 Opennote 设置`）不动：
 * 那是一块够宽的容器，文字按钮更好读，而且它是错误态唯一的出口，不该只留一个图标。
 * 认不出的 id 退到「在独立页面里打开」那一款 —— 宁可图标不够贴切，
 * 也不能让一颗按钮变成没有形状的空白。
 */
function actionIcon(id) {
  if (id === "again") {
    // 剪刀 = 「再剪一段」。
    return svgIcon([
      "M1.6 4.5a1.9 1.9 0 1 0 3.8 0 1.9 1.9 0 1 0-3.8 0",
      "M1.6 11.5a1.9 1.9 0 1 0 3.8 0 1.9 1.9 0 1 0-3.8 0",
      "M5 5.7 13.5 12.5",
      "M5 10.3 13.5 3.5",
    ]);
  }
  if (id === "retry") {
    // 回转箭头 = 「重试」。
    return svgIcon(["M13 8a5 5 0 1 1-1.5-3.6", "M13.2 2.4v3.4h-3.4"]);
  }
  return svgIcon([PATH_EXTERNAL]);
}

/* ─────────────── 预览卡的只读排版（② 「像 Opennote」） ───────────────

   判据来自用户给的编辑器截图，取值**逐条对照** src/styles/tokens.css + editor.css 的真实值，
   不凭感觉配色、不手抄色值；新增令牌 0（全部走 var(--…)）：
     - 深色纸（近黑）：`--paper` / `--paper-2`（夜读主题下就是 #14120f / #1c1915）
     - 正文等宽、行高：`--font-mono` + `--doc-fs` + `--doc-lh`（应用里正文的**同一批令牌**）
     - H1 衬线粗体大字 + 下方通栏细线：`--font-serif` + 1.85em/600/-.014em + 2px `--rule`
     - `#` 暗灰色：`--ink-3`（与 editor.css 的 md-src 同色）
     - H2 衬线粗体 + 1px `--rule` 下边线：1.45em/600
     - 表格通栏 1px `--rule` 边框、表头 `--paper-3` 底、单元格等宽
     - 左侧留白：卡片 `var(--s3)` + 文档层 `var(--s4)`（360px 宽度下的等比取舍，见 03 §UI-01）
     - 没有默认聚焦环：文档层不可聚焦（不是输入控件）；控件自身的 `:focus-visible` **照 S-C3 保留**
   这是**预览**不是编辑器：只认标题 / 表格 / 代码块 / 引用 / 列表 / 分隔线 / 段落七种块，
   行内只认粗体 / 斜体 / 行内代码三种；图片渲染成文字占位 —— popup **不加载任何远程图片**。
   全部用 createElement + textContent 拼装，不用 innerHTML。 */

const DOC_MAX_BLOCKS = 40;
const DOC_MAX_CHARS = 4000;

function inlineNodes(text) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let last = 0;
  let match = re.exec(text);
  while (match) {
    if (match.index > last) out.push(document.createTextNode(text.slice(last, match.index)));
    const token = match[0];
    if (token.startsWith("**")) out.push(el("strong", null, token.slice(2, -2)));
    else if (token.startsWith("`")) out.push(el("code", "doc-inline", token.slice(1, -1)));
    else out.push(el("em", null, token.slice(1, -1)));
    last = match.index + token.length;
    match = re.exec(text);
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

function paragraph(tag, text) {
  const node = el(tag);
  for (const child of inlineNodes(text)) node.appendChild(child);
  return node;
}

function tableCells(line) {
  let text = String(line).trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  return text.split("|").map((cell) => cell.trim());
}

function isTableDelimiter(line) {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell));
}

function codeBlock(lines) {
  const pre = el("pre", "doc-code");
  const code = el("code");
  code.textContent = lines.join("\n");
  pre.appendChild(code);
  return pre;
}

function tableBlock(header, rows) {
  const wrap = el("div", "doc-table-wrap");
  const table = el("table", "doc-table");
  const thead = el("thead");
  const headRow = el("tr");
  for (const cell of header) headRow.appendChild(paragraph("th", cell));
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = el("tbody");
  for (const row of rows) {
    const tr = el("tr");
    for (let index = 0; index < header.length; index += 1) tr.appendChild(paragraph("td", row[index] || ""));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function renderDoc(markdown) {
  const box = el("div", "clip__doc");
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  let blocks = 0;
  let used = 0;
  let truncated = false;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (blocks >= DOC_MAX_BLOCKS || used >= DOC_MAX_CHARS) {
      truncated = true;
      break;
    }
    if (/^\s*$/.test(line)) {
      index += 1;
      continue;
    }
    used += line.length;
    const fence = line.match(/^\s*```/);
    if (fence) {
      const body = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      box.appendChild(codeBlock(body));
      blocks += 1;
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length, 4);
      const node = paragraph(`h${level}`, heading[2].trim());
      // 判据里的「`#` 号暗灰色」在编辑器里是**源码标记**；预览保留它，让卡片与编辑器同一副面孔。
      if (level <= 2) node.insertBefore(el("span", "doc-hash", "#".repeat(level)), node.firstChild);
      box.appendChild(node);
      blocks += 1;
      index += 1;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      box.appendChild(el("hr", "doc-hr"));
      blocks += 1;
      index += 1;
      continue;
    }
    if (line.includes("|") && index + 1 < lines.length && isTableDelimiter(lines[index + 1])) {
      const header = tableCells(line);
      const rows = [];
      let cursor = index + 2;
      while (cursor < lines.length && lines[cursor].trim() && lines[cursor].includes("|")) {
        rows.push(tableCells(lines[cursor]));
        cursor += 1;
      }
      box.appendChild(tableBlock(header, rows));
      blocks += 1;
      index = cursor;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quoted = [line.replace(/^\s*>\s?/, "")];
      index += 1;
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quoted.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      const quote = el("blockquote", "doc-quote");
      quote.appendChild(paragraph("p", quoted.join(" ")));
      box.appendChild(quote);
      blocks += 1;
      continue;
    }
    const bullet = line.match(/^\s*([-*+]|\d+\.)\s+(.*)$/);
    if (bullet) {
      const list = el(/^\d/.test(bullet[1]) ? "ol" : "ul", "doc-list");
      let cursor = index;
      while (cursor < lines.length) {
        const item = lines[cursor].match(/^\s*([-*+]|\d+\.)\s+(.*)$/);
        if (!item) break;
        list.appendChild(paragraph("li", item[2]));
        cursor += 1;
      }
      box.appendChild(list);
      blocks += 1;
      index = cursor;
      continue;
    }
    const para = [];
    while (index < lines.length && lines[index].trim() && !/^\s*(#{1,6}\s|>|```|[-*+]\s|\d+\.\s)/.test(lines[index]) && !isTableDelimiter(lines[index])) {
      para.push(lines[index].trim());
      index += 1;
      if (para.length >= 3) break;
    }
    box.appendChild(paragraph("p", para.join(" ")));
    blocks += 1;
  }
  if (truncated) box.appendChild(el("p", "doc-note", "预览只显示开头，剪藏后是完整正文。"));
  return box;
}

/**
 * ③ 图片开关（默认关）：**与「选择当前元素 / 整页提取」始终同一行**（用户明确要求）。
 *
 * 位置这件事踩过**两次**：
 * ① 它原来在卡片里（`previewNode()` 的尾部），理由是「工具条恰好两个按钮」（M1 冻结，`00` §6.14 ㊶）。
 *    用户看过真机截图后要求把它挪到工具条那一行（0.3.3）。
 * ② 挪进工具条之后它排在 `#pickNote` **后面**，而 `#pickNote` 是 `flex-basis:100%` 的整行子项 ——
 *    于是**只要那一行有话说**（点选失败 / 选择模式进行中），开关就被挤到第三行（用户 0.3.3 的第二张
 *    真机截图就是这个现场）。修法见 `mountImageSwitch()`：把它插在**两个按钮之后、`#pickNote` 之前**。
 *    位置从此不取决于「那一行有没有说明句」——「始终」两个字必须落到兄弟顺序上，不能靠碰运气。
 *
 * **这没有破 ㊶**：㊶ 冻结的是「工具条**不许加第三个按钮**」（工具条上的**动作**只有两个），
 * 而这是一个**复选框**（一个选项），不是动作按钮；㊶ 要防的是「又来一个能点出结果的入口」。
 * 判据（`tests/popup-card.test.mjs`）盯**位置与兄弟顺序本身**，并保留「它必须是 JS 渲染的、
 * 不许写死在 popup.html 里」那一条。
 *
 * **开关下面那三条状态说明句已按用户要求整段删除**（0.3.3 红框内的说明文字）：界面上不再有第二行，
 * 它说的那件事（图片没下下来时正文里保留原始网址）在真的发生时由 `warnings[]` 逐条说出来
 * （主按钮变「打开编辑页」，先说明再打开）——**删的是说明句，不是「不静默」那条纪律**。
 */
function imageSwitch() {
  const label = el("label", "clip__assets-sw");
  label.setAttribute("for", "imgDownload");
  const input = el("input");
  input.type = "checkbox";
  input.id = "imgDownload";
  input.checked = imageDownload;
  input.addEventListener("change", () => {
    imageDownload = input.checked;
    render();
    schedulePreview();
  });
  label.appendChild(input);
  label.appendChild(el("span", null, "图片一起保存"));
  return label;
}

/**
 * 把开关挂进工具条那一行；每次 `render()` 重建（开关状态以 `imageDownload` 为唯一真源）。
 *
 * **必须 `insertBefore(…, pickNote)`，不许 `appendChild`**：`#pickNote` 是整行子项，
 * 排在它后面的兄弟**一定**被挤到下一行（用户截图里的第三行就是这么来的）。
 * 插在它前面，开关就永远和两个按钮同排，无论那一行有没有话说。
 *
 * `visible=false` 时**一个节点都不挂**（并把上一轮挂的摘掉）：受限页面（`chrome://` 等）
 * 连正文都读不到，那里放一个改不了任何结果的复选框就是**死元素** ——
 * `popup.html` 顶部写着「界面上不留任何死元素」，这条对它同样成立。
 */
function mountImageSwitch(visible) {
  for (const node of pickRow.querySelectorAll(".clip__assets-sw")) node.remove();
  if (!visible) return;
  pickRow.insertBefore(imageSwitch(), pickNote);
}

function previewNode() {
  const ex = extraction();
  const box = el("div", "clip__preview");
  // L3 首行（--fs-xs --ink-3）：**正文来源**，与两个按钮的选中态说的是同一件事。
  const picked = snapshot && snapshot.pickedElement;
  box.appendChild(
    el("p", "clip__origin", mode === "element" && picked && picked.tagName ? `已选择 ${picked.tagName}` : "整页正文"),
  );
  const row = el("div", "clip__title-row");
  const title = el("p", "clip__title-in");
  title.id = "inlineTitle";
  title.textContent = titleValue || defaultTitle();
  row.appendChild(title);
  // task-29 ②：卡片标题行上的图标按钮 → **Opennote 自己服务的网页版剪藏页**
  // （扩展侧只做两件事：POST /v1/clip/stage、chrome.tabs.create({url: openUrl})）。
  // A 已上线，所以 `CLIP_WEB_READY` 现在是 true；**没有网址时不渲染**（不画死按钮）。
  const CLIP_WEB_READY = true;
  const openTarget = CLIP_WEB_READY && ((ex && ex.url) || (snapshot && snapshot.tab && snapshot.tab.url) || "");
  if (openTarget) {
    const open = el("button", "clip__open");
    open.type = "button";
    open.id = "openEditable";
    open.title = "在新标签页里编辑后保存";
    open.setAttribute("aria-label", "在新标签页里编辑后保存");
    open.appendChild(iconExternal());
    open.addEventListener("click", () => void openClipWeb(open));
    row.appendChild(open);
  }
  if (mode === "page") {
    const chars = (ex && ex.article && ex.article.chars) || 0;
    row.appendChild(el("span", "clip__count", `约 ${chars.toLocaleString("en-US")} 字 · 预计 1 篇笔记`));
  }
  box.appendChild(row);

  // 预览正文的**唯一**来源：`currentMarkdown()`（它内部再按 mode 分流：元素选择 → 被点中的那块）。
  // 任何兜底都不得用另一份正文顶替「被选中的那一块」——冒充比空白更糟：用户无从发现。
  box.appendChild(renderDoc(currentMarkdown()));

  const src = el("p", "clip__src");
  if (mode === "selection") {
    const chars = (ex && ex.selection && ex.selection.chars) || 0;
    src.appendChild(document.createTextNode(`已选中 ${chars} 字 · `));
    src.appendChild(el("em", null, (ex && ex.site) || "网页"));
    const published = formatDate(ex && ex.publishedAt);
    if (published) src.appendChild(document.createTextNode(` · ${published}`));
  } else {
    src.appendChild(el("em", null, (ex && ex.site) || "网页"));
    if (ex && ex.author) src.appendChild(document.createTextNode(` · ${ex.author}`));
    const published = formatDate(ex && ex.publishedAt);
    if (published) src.appendChild(document.createTextNode(` · 发布于 ${published}`));
    src.appendChild(document.createTextNode(` · 剪藏于 ${formatDate(new Date().toISOString())}`));
  }
  box.appendChild(src);
  // 选中的是 iframe：如实说明只剪到外框，不假装读到了里面的内容
  if (mode === "element" && picked && picked.isIframe) {
    box.appendChild(el("p", "clip__hint", "这块是嵌入的内容，只能剪到它的外框，里面的内容读不到。"));
  }
  return box;
}

/**
 * 打开网页版剪藏页（A）：**先暂存、再打开**，两件事都是扩展的全部职责。
 * - 请求体由 background 按冻结形状组装；`openUrl` 由接口返回 —— 扩展**绝不自己拼**；
 * - 失败（桥不在 / 令牌失效 / 接口没给 openUrl）→ **不打开页面**，把原因如实写在 popup 里；
 * - 成功但有 `warnings[]`（③ 的图片降级：没权限 / 跨站 / 超时 / 太大）→ **不静默打开**：
 *   先把这几句摆在用户眼前，再给一个「打开编辑页」按钮（少一次点击不值得藏掉一个事实）。
 */
async function openClipWeb(button) {
  if (button && button.disabled) return;
  if (button) button.disabled = true;
  const payload = collectPayload();
  const response = await send({
    type: "opennote:clip-stage",
    mode: payload.mode,
    body: payload.body,
    imageDownload,
  });
  if (button) button.disabled = false;
  const reply = response && response.reply;
  if (!reply || !reply.ok || !reply.openUrl) {
    const code = (reply && reply.code) || "IMP-4014";
    renderBlockReply({
      status: "error",
      code,
      label: (reply && reply.label) || userMessage(code),
      state: (reply && reply.state) || STATE.CONNECTED,
    });
    return;
  }
  const warnings = Array.isArray(reply.warnings) ? reply.warnings.filter((item) => item) : [];
  if (warnings.length) {
    pendingOpenUrl = reply.openUrl;
    const plan = planForState(STATE.CONNECTED);
    plan.block = { kind: "error", message: warnings.join(" "), next: null, code: null };
    plan.actions = [];
    plan.rows = false;
    plan.preview = false;
    plan.primary = { label: "打开编辑页", disabled: false, busy: false, intent: "open-clip-web" };
    render(plan);
    return;
  }
  // ②：`openUrl` 的唯一产地是接口返回值（这里不许拼端口、不许拼 stageId）。
  await chrome.tabs.create({ url: reply.openUrl });
}

/**
 * 动作按钮。
 *
 * `iconOnly`：**底栏**那一排用定宽图标按钮（0.3.4 用户：「图3这个文字出界，换成图标」）。
 * 文案一个字都没少 —— `title` 给鼠标悬浮、`aria-label` 给读屏，取的都是计划里那份
 * **逐字冻结**的 `action.label`（产地是 `state.js`，所以冻结文案表照旧命中）。
 * 宽度由 CSS 钉死在 30px，与文案长短无关，因此不会再被挤到竖排、溢出外框。
 */
function actionButton(action, { iconOnly = false } = {}) {
  if (iconOnly) {
    const icon = el("button", "clip__act");
    icon.type = "button";
    icon.title = action.label;
    icon.setAttribute("aria-label", action.label);
    icon.dataset.action = action.id;
    if (action.path) icon.dataset.path = action.path;
    icon.appendChild(actionIcon(action.id));
    icon.addEventListener("click", () => void runAction(action.id, action));
    return icon;
  }
  const button = el("button", action.primary ? "btn btn--primary" : "btn", action.label);
  button.type = "button";
  button.dataset.action = action.id;
  if (action.path) button.dataset.path = action.path;
  button.addEventListener("click", () => void runAction(action.id, action));
  return button;
}

/**
 * 令牌块（00 §6.15㉞ / 03 §UI-01 S30–S32）。
 * 0.3.1 起**没有配对码**：这里只有「粘贴 47 字符长期令牌」这一条路，且常显代价披露句（C72）。
 *
 * `force = true`：**这次错误就是「令牌不对」**（`plan.tokenInput`）⇒ 即使本地还存着旧令牌，
 * 也必须把输入框露出来让用户重粘。
 *
 * 为什么需要这个参数：原来只看 `state.hasToken` 决定显示只读的「已保存」还是输入框，
 * 于是「令牌不对」时用户**卡在只读视图上没法重粘** —— 后台为了绕开它，只好在 `IMP-2002`
 * 时把用户存的令牌**删掉**。那不是修复，那是用一个副作用（毁掉用户配置，与 ㊴「长期有效、
 * 随时可复制」的承诺冲突）去换一个本该由渲染层解决的显示问题。
 */
function tokenInputBlock(force = false) {
  tokenRow.hidden = false;
  const state = snapshot && snapshot.settings ? snapshot.settings : {};
  const hasToken = Boolean(state.hasToken);
  const needInput = force || !hasToken;
  tokenSaved.hidden = needInput;
  tokenInputRow.hidden = !needInput;
  tokenHint.hidden = !needInput;
  tokenMain.hidden = !needInput;
  tokenError.hidden = true;
  if (!needInput) {
    // C58 / UI-04 S6 的只读写法：`opn_••••••••••••1234`（明文不留在界面上）。
    // M2：尾 4 位由后台从**已保存的令牌**推导（settings.tokenTail），这里不再有 `????` 假尾号。
    tokenCode.textContent = maskTokenTail(state.tokenTail);
    tokenNext.textContent = "换一个令牌：在 Opennote 里重新生成，然后回来粘贴。";
    return el("div");
  }
  const box = el("div");
  tokenRow.appendChild(box);
  setTimeout(() => tokenInput.focus(), 0);
  return box;
}

function blockNode(block, plan) {
  const box = el("div", `clip__alert${block.kind === "queued" ? " is-quiet" : ""}`);
  // 最后一道兜底：任何情况下错误块里都必须有一句给人看的话（绝不静默失败）。
  const message = block.message || (block.code ? userMessage(block.code) : null) || userMessage("IMP-4014");
  box.appendChild(el("p", null, message));
  if (block.next) box.appendChild(el("p", "next", block.next));
  if (block.code) box.appendChild(el("div", "code", block.code));
  // `kind: "token"`（㉞）：这个错误块的下一步动作只有一个 —— 粘贴长期令牌。
  // `true` = 这次错误就是「令牌不对」，**即使本地还存着旧令牌也要露出输入框**（否则用户没法重粘）。
  if (plan && plan.tokenInput) box.appendChild(tokenInputBlock(true));
  if (settingsOpen || (plan && plan.settingsOnly)) box.appendChild(tokenInputBlock());

  const acts = el("div", "acts");
  for (const action of (plan && plan.actions) || []) acts.appendChild(actionButton(action));
  if (acts.childNodes.length) box.appendChild(acts);
  return box;
}

function noticeNode() {
  const box = el("div", "clip__block");
  box.appendChild(el("p", null, notice));
  return box;
}

/* ─────────────────────────── 主渲染 ─────────────────────────── */

function defaultTitle() {
  const ex = extraction();
  if (!ex) return "";
  if (mode === "element") return ex.pageTitle || "";
  if (mode === "selection") return (ex.selection && ex.selection.ancestorTitle) || ex.pageTitle || "";
  return (ex.article && ex.article.title) || ex.pageTitle || "";
}

function planForState(stateId, extra = {}) {
  return planFor(stateId, {
    pendingCount: pendingCount(),
    folderLabel: folderLabel(),
    noteTitle: titleValue,
    ...extra,
  });
}

/** 当前应显示的状态（S4 空态、S5 受限页面都在这里收敛）。 */
function currentPlan() {
  if (!snapshot) return planForState(STATE.CHECKING);
  // task-21：抽取失败**不是**页面类型不支持 —— 单独一句真话 + 可执行的下一步
  if (snapshot.extractionFailed && !snapshot.restricted) {
    const failed = planForState(snapshot.stateId || STATE.CHECKING);
    failed.block = null;
    failed.rows = false;
    // 注入失败（超时）与抽取失败各有各的真话：用后台给的原因，取不到才退到通用那句
    failed.empty = {
      title: "没能读到正文。",
      text: PICK_FAIL_COPY[snapshot.pickFailReason] || PICK_FAIL_COPY.extraction_failed,
    };
    failed.primary = { label: "剪藏到 Opennote", disabled: true, busy: false };
    // 出口：用户必须能重试一次（此前这里是空数组 = 死路）
    failed.actions = [{ id: "retry", label: "重试", primary: true }];
    return failed;
  }
  if (snapshot.restricted) return planForState(STATE.RESTRICTED_PAGE);
  const stateId = snapshot.stateId || STATE.CHECKING;
  const plan = planForState(stateId);
  const picked = snapshot.pickedElement;
  if (stateId === STATE.CONNECTED && mode === "element" && !(picked && picked.tagName)) {
    // S27 / C67：来源 = 元素选择但这次还没选过 → 空态 + 主按钮禁用（不发请求）
    plan.block = null;
    plan.rows = false;
    plan.empty = {
      title: "还没选元素。",
      text: "点上面的「选择当前元素」，在页面上点一下要剪的那块。",
    };
    plan.primary = { label: "剪藏到 Opennote", disabled: true, busy: false };
    plan.actions = [];
    return plan;
  }
  if (stateId === STATE.CONNECTED && mode === "selection" && !hasSelection()) {
    plan.block = null;
    plan.rows = false;
    plan.empty = {
      title: "没有选中任何文字。",
      // C16 的完整句（㉗ 冻结文案）
      text: "在页面上选一段，或把来源切到「整页正文」。",
    };
    plan.primary = { label: "剪藏到 Opennote", disabled: true, busy: false };
    plan.actions = [];
  }
  return plan;
}

function settingsPlan() {
  const plan = planForState(STATE.CONNECTED);
  plan.block = { kind: "token", message: null, next: null, code: null };
  plan.settingsOnly = true;
  plan.tokenInput = false;
  plan.actions = [];
  plan.primary = null;
  plan.preview = false;
  return plan;
}

/**
 * L2 那一行（M1 / task-24）：只有两个按钮 ——
 * - 没选过元素 → `选择当前元素`；已选过 → `重新选择`（C66）
 *
 * 「选择模式进行中」的那两句说明（`03` `UI-01/C68`+`C69`）**已按用户要求删除**（0.3.3 红框内的说明文字）：
 * 这一行不再为「等待点选」说话。`snapshot.pickArmed` 因此不再参与渲染 —— 但它仍在快照里
 * （后台是唯一真源，popup 不读不等于要删字段）。
 *
 * **`#pickNote` 保留**：它还是**点选失败的出口**（`startPick()` 里按四因分离的 `reason` 写文案，
 * 并把后台的真实原文写进 `#pickDetail`）。删掉它就是让「点了一下没进选择模式」变成静默失败。
 */
function syncPickRow() {
  const picked = snapshot && snapshot.pickedElement;
  pickButton.textContent = picked && picked.tagName ? "重新选择" : "选择当前元素";
  // ⑤ 两个按钮的选中态（用户报过「看不出选的是元素还是整页」）：
  // **视觉与读屏一次解决** —— `aria-pressed` 既是可访问性状态，也是 CSS 的选中态选择器
  // （`.btn[aria-pressed="true"]`，着色只用既有令牌 `--accent-soft` / `--accent` / `--accent-line`）。
  // 「谁后点谁生效」：默认整页提取选中（03 §UI-01「两个按钮」表）。
  pickButton.setAttribute("aria-pressed", mode === "element" ? "true" : "false");
  extractPageButton.setAttribute("aria-pressed", mode === "page" ? "true" : "false");
  // 说明句退场后这一行只剩失败出口：每次 render 先收起（失败时 `startPick()` 再打开）。
  // 原先那个 `pickNote.dataset.keep !== "1"` 的例外是**死条件** —— 全仓没有任何地方写过 `keep`。
  pickNote.hidden = true;
}

function render(planInput) {
  const plan = planInput || currentPlan();
  clip.dataset.state = plan.state;
  // 当前来源（element / page）：写在 data-mode 上，便于人眼与真机检查「现在是哪一种来源」
  clip.dataset.mode = mode;
  clip.dataset.busy = busy ? "true" : "false";

  chip.className = `status-chip${plan.chip.cls ? ` ${plan.chip.cls}` : ""}`;
  chipText.textContent = plan.chip.text;
  chip.tabIndex = -1;

  // M1（task-24）：没有三区分段了 —— 正文/预览是一条链，状态流（加载/空态/成功/报错）始终占正文区。
  updateDeliveryHint();
  syncPickRow();
  // ③ 图片开关挂在工具条那一行（用户要求），与 `syncPickRow()` 同一批「每次 render 都要刷新」的东西。
  // 它插在 `#pickNote` 之前 ⇒ **始终**与两个按钮同排（那一行有没有说明句都掉不下去）。
  // 受限页面不挂：那里连正文都读不到，放一个改不了结果的复选框就是死元素。
  mountImageSwitch(plan.state !== STATE.RESTRICTED_PAGE);
  const flowLike = Boolean(notice || plan.skeleton || plan.empty || plan.ok || plan.block);
  regionBody.hidden = false;

  region.replaceChildren();
  if (notice) region.appendChild(noticeNode());
  if (plan.skeleton) region.appendChild(skeletonNode());
  else if (plan.empty) region.appendChild(emptyNode(plan.empty));
  else if (plan.ok) region.appendChild(okNode(plan.ok));
  else if (plan.block) region.appendChild(blockNode(plan.block, plan));
  else region.appendChild(previewNode());


  const actionsInFoot = Boolean(plan.empty || plan.ok || !plan.primary);
  footActs.replaceChildren();
  if (actionsInFoot) for (const action of plan.actions || []) footActs.appendChild(actionButton(action, { iconOnly: true }));

  if (plan.primary) {
    const loading = busy || plan.primary.busy;
    primary.hidden = false;
    primary.replaceChildren();
    // S-C5：加载态左侧放 12px 旋转环，文案改进行时，宽度靠 min-width 吸收不跳变。
    if (loading) primary.appendChild(el("span", "spinner"));
    primary.appendChild(document.createTextNode(loading ? busyLabel : plan.primary.label));
    primary.disabled = Boolean(plan.primary.disabled) || busy;
    primary.setAttribute("aria-busy", loading ? "true" : "false");
    // `intent` 由 plan 显式给（阶段结果里的「打开编辑页」就是一个意图，不能靠 label 反推）
    primary.dataset.intent = plan.primary.intent || (plan.primary.label === "暂存在插件里" ? "stage" : "submit");
  } else {
    primary.hidden = true;
    // 顺手把肚里那份内容清空。真正让它消失的是 CSS 的 `#primary[hidden]{display:none}`
    // （`.btn{display:inline-flex}` 会盖掉 UA 的 `[hidden]`，见 popup.css 那段注释）；
    // 这里再清一次，是为了**任何情况下**都不会有一颗隐藏按钮还揣着「正在剪藏…」+ 旋转环，
    // 被读屏、被快照、被下一次调试当成「还在加载」。
    primary.replaceChildren();
    primary.setAttribute("aria-busy", "false");
  }
  more.hidden = Boolean(plan.ok) || plan.state === STATE.RESTRICTED_PAGE;
}

/** 预览：与真正提交共用 background 的同一条合成路径（来源 = 页面自动提取）。 */
function schedulePreview() {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => void refreshPreview(), 140);
}

async function refreshPreview() {
  if (!snapshot || snapshot.restricted) return;
  // M1：popup 不再发 templateId / props / dirty（模板与属性区已退场）；
  // 来源信息（标题/网址/站点/作者/发布时间）由页面自动提取，后台按「null 则省略整行」生成 front-matter。
  // ③：只有开关打开时才多要一份图片清单（默认关 = 连这次注入都不做）。
  const response = await send({ type: "opennote:preview", mode, images: imageDownload });
  if (!response || !response.ok || !response.preview) {
    // 出口（不许静默 return）：预览拿不到 = 用户看不到正文，必须**看得见**并能重试。
    renderUnreadableBody(snapshot && snapshot.pickFailReason);
    return;
  }
  const preview = response.preview;
  lastPreview = preview;
  // 根因四：回包到了**必须重绘**。`load()` 是「先 render() 再 refreshPreview()」，回包只赋值不重绘
  // → 正文区永远停在渲染那一刻的空摘要（真机 15s 六次采样全为空，特征串从未出现）。
  // 标题也按回包的**真实形状**读：后台发的是 `preview.title`（没有 `preview.props`）。
  titleValue = preview.title || titleValue || "";
  render();
  // 正文区里的标题行是只读视图（唯一输入源是属性区，03 §UI-01 ②）
  const inlineTitle = document.getElementById("inlineTitle");
  if (inlineTitle) inlineTitle.textContent = titleValue || "未命名笔记";
}

/** 顶部提示条：显示一句话后自动消失（不做「按模板更新」「标题计数」那些已退场的属性区行为）。 */
function notify(text) {
  notice = text;
  if (noticeTimer) clearTimeout(noticeTimer);
  render();
  noticeTimer = setTimeout(() => {
    notice = "";
    render();
  }, 3000);
}

/* ─────────────────────────── 动作 ─────────────────────────── */

function currentMarkdown() {
  const ex = extraction();
  if (!ex) return "";
  // ㉝ 元素选择：**预览与提交都必须是被点中的那块**。
  // 这里原来只认 `ex.article.markdown` —— 元素模式于是退化成整页正文，预览和整页提取一模一样
  // （用户实测：「重新选择的预览和整页提取的预览是一样的」）。数据早就在预览回包里
  // （后台 `opennote:preview` 的 `pickedElement.markdown`），是**这一端没读**，不是选择没落盘。
  if (mode === "element") {
    const picked = (lastPreview && lastPreview.pickedElement) || (snapshot && snapshot.pickedElement) || null;
    return (picked && picked.markdown) || "";
  }
  if (mode === "selection") return (ex.selection && ex.selection.markdown) || "";
  return (ex.article && ex.article.markdown) || "";
}

async function copyMarkdown() {
  const text = currentMarkdown();
  if (!text) {
    notify("没有可复制的内容。");
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    notify("正文已复制到剪贴板。");
    return true;
  } catch {
    /* 退到页面侧 execCommand */
  }
  const result = await send({ type: "opennote:copy-in-page", text });
  if (result && result.copied) {
    notify("正文已复制到剪贴板。");
    return true;
  }
  showManualCopy(text);
  return false;
}

/**
 * 三级降级复制（不申请 `clipboardWrite`）：
 * ① `navigator.clipboard.writeText` ②注入页面脚本走 `execCommand` ③可见 textarea 手动复制。
 */
async function copyText(text, okText) {
  try {
    await navigator.clipboard.writeText(text);
    notify(okText);
    return true;
  } catch {
    /* 下一级 */
  }
  const result = await send({ type: "opennote:copy-in-page", text });
  if (result && result.copied) {
    notify(okText);
    return true;
  }
  showManualCopy(text, okText);
  return false;
}

function showManualCopy(text, okText) {
  notice = "";
  regionMode = "body";
  render();
  const box = el("div", "clip__block");
  box.appendChild(el("p", null, "没能自动复制到剪贴板。请手动复制下面的内容。"));
  if (okText) box.appendChild(el("p", "next", okText));
  const area = el("textarea", "clip__manual");
  area.value = text;
  area.setAttribute("aria-label", "剪藏正文");
  box.appendChild(area);
  const acts = el("div", "acts");
  const retry = el("button", "btn", "重试");
  retry.type = "button";
  retry.addEventListener("click", () => void copyMarkdown());
  acts.appendChild(retry);
  box.appendChild(acts);
  region.replaceChildren(box);
  setTimeout(() => {
    area.focus();
    area.select();
  }, 0);
}

/**
 * 本地预检（03 §UI-01 S21 / C39–C43）：不通过就**停在这里、不发请求**。
 * 文案逐字用 03 的清单；服务端仍会独立校验（同一句 `IMP-4008` 的 userMessage）。
 */
const PUBLISHED_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?)?$/;
const NOTE_PATH_RE_LOCAL = /^(?![/\\])(?!.*(?:^|[/\\])\.\.(?:[/\\]|$))(?!.*:)[^\\]+\.md$/;

/**
 * M1（task-24）：`标题 / 网址 / 站点 / 作者 / 发布时间` 全部由页面自动填写，用户无可填字段，
 * 所以本地预检退化为空 —— 但**服务端仍独立校验**（同一句 IMP-4008 的 userMessage）。
 * 留下这个函数是为了让调用点与「不通过就不发请求」的纪律保持原样。
 */
function precheck() {
  return [];
}

/**
 * L6（C47/C48）：交付方式**如实显示**，不替用户承诺，也不做假开关。
 *
 * ④ 用户明确要求**删掉**「先进收件箱」那一句（原话是「这次会先进收件箱、要在收件箱里确认」
 * 那个意思的那一行）。所以 `inbox === true` 时**不显示任何交付提示行** ——
 * 这是**有意的空分支**，不是漏写；理由写在这里，免得下一个人以为是 bug 又把它加回来：
 *   - 这句在「默认先进收件箱」的场景下**每次打开 popup 都在说同一件事**，用户已经知道；
 *   - 入库结果并不会因此变得不可知：回执里仍会如实写「已进入收件箱等待确认：{标题}。」
 *     （`lib/state.js` 的冻结文案，`S23`），那才是「这次到底去哪了」的最终事实。
 *   - **被删掉的那句原文不再出现在代码或注释里**（注释也是标签：留一个「已删除」的句子，
 *     会让「这句不许再出现」的判据变成一句空话）。要查原句请看 `03` §UI-01 的 `C46` 作废行。
 * 另外两支**保留**，它们说的是不同的事：`direct` = 这次会直接写成笔记（可撤销）；
 * `unknown` = 旧版桥没给这个字段，判断不出来（如实说「判断不出来」，不猜）。
 *
 * 固定高度（③）之后这个空分支还要**把这一行藏起来**（`hidden`）：否则一个空的 `<p>`
 * 仍会占着它自己的 `margin-bottom`，在 600px 的窗口里留一条没意义的缝。
 */
function updateDeliveryHint() {
  if (!deliveryHint) return;
  const inbox = snapshot && snapshot.inbox;
  if (inbox === true) {
    deliveryHint.textContent = "";
    deliveryHint.hidden = true;
    return;
  }
  deliveryHint.hidden = false;
  if (inbox === false) deliveryHint.textContent = "这次会直接写成笔记，可以在 Opennote 里撤销。";
  else deliveryHint.textContent = "交付方式由 Opennote 的设置决定，剪藏完成后会如实显示结果。";
}

function collectPayload() {
  const body = currentMarkdown();
  const title = titleValue.trim() || defaultTitle();
  const sig = signature(`${mode}|${title}|${body.length}`);
  const importId = sig === lastSignature && currentImportId ? currentImportId : newId();
  currentImportId = importId;
  lastSignature = sig;
  return { mode, title, body, importId };
}

async function submit() {
  if (busy || !snapshot || snapshot.restricted) return;
  const stateId = snapshot.stateId;
  if (stateId !== STATE.CONNECTED && stateId !== STATE.NO_WORKSPACE) return;
  const problems = precheck();
  if (problems.length) return; // S21：本地预检不通过就不发请求
  const payload = collectPayload();
  busy = true;
  busyLabel = "正在剪藏…";
  render(currentPlan());
  const response = await send({
    type: "opennote:submit",
    mode: payload.mode,
    title: payload.title,
    importId: payload.importId,
    // task-29 ②「所见即所剪」：把**界面上那一份**正文一起发出去 —— 用户在预览里改过的正文
    // 必须原样进信封，而不是剪藏时又用回原始抽取结果（改了不生效是最糟的一种假开关）。
    // 没改过时它就是抽取结果本身，行为与 M2 一致。
    body: payload.body,
  });
  busy = false;
  if (!response || !response.reply) {
    renderBlockReply({ status: "error", code: "IMP-4014", label: userMessage("IMP-4014") });
    return;
  }
  applyReply(response.reply);
}

async function stage() {
  if (busy || !snapshot || snapshot.restricted) return;
  const payload = collectPayload();
  busy = true;
  busyLabel = "正在剪藏…";
  render(currentPlan());
  const response = await send({
    type: "opennote:stage",
    mode: payload.mode,
    title: payload.title,
    importId: payload.importId,
  });
  busy = false;
  if (!response || !response.reply) {
    renderBlockReply({ status: "error", code: "IMP-4014", label: userMessage("IMP-4014") });
    return;
  }
  applyReply(response.reply);
}

function applyReply(reply) {
  if (!reply) {
    renderBlockReply({ status: "error", code: "IMP-4014", label: userMessage("IMP-4014") });
    return;
  }
  if (reply.status === "created") {
    // `status: "duplicate"`（同 url 同内容）按 00 §6.12① 在**客户端内联**提示，不用成功态。
    if (reply.serverStatus === "duplicate") {
      pendingNotePath = reply.path || null;
      const plan = planForState(STATE.CONNECTED);
      plan.block = { kind: "error", message: "已在笔记中（未重复入库）。", next: null, code: null };
      plan.actions = [
        { id: "open-note", label: "打开那条笔记", primary: true, path: reply.path || null },
        { id: "again", label: "再剪一段", primary: false },
      ];
      plan.primary = null;
      plan.rows = false;
      plan.preview = false;
      render(plan);
      return;
    }
    if (typeof reply.pendingCount === "number" && snapshot && snapshot.settings) {
      snapshot.settings.pendingCount = reply.pendingCount;
    }
    if (reply.path && snapshot && snapshot.settings) {
      const list = Array.isArray(snapshot.settings.notePaths) ? snapshot.settings.notePaths : [];
      snapshot.settings.notePaths = [reply.path, ...list.filter((item) => item !== reply.path)].slice(0, 20);
    }
    const plan = planForState(STATE.SUCCESS, {
      folderLabel: reply.folderLabel || folderLabel(),
      noteTitle: reply.noteTitle || titleValue,
    });
    render(plan);
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => window.close(), 2000);
    return;
  }
  if (reply.status === "pending") {
    // 00 §6.14 ㉘ / 03 §UI-01 C60、S23：`receipt.status === "pending"` → 冻结文案
    // `已进入收件箱等待确认：{标题}。` + 次行 `在 Opennote 的「导入收件箱」里确认。`
    // 这不是失败，也不是「已经写进笔记」，所以既不显示成功态的「已剪藏到…」，也不显示错误块。
    // 也不提供「打开收件箱」按钮：本轮没有指向收件箱的深链，画一个点不动的按钮就是死按钮。
    const plan = planForState(STATE.INBOX_PENDING, { noteTitle: reply.noteTitle || titleValue });
    render(plan);
    return;
  }
  if (reply.status === "queued") {
    if (typeof reply.pendingCount === "number" && snapshot && snapshot.settings) {
      snapshot.settings.pendingCount = reply.pendingCount;
    }
    const plan = planForState(STATE.QUEUED_OFFLINE, { pendingCount: reply.pendingCount || 0 });
    if (reply.evicted) plan.block.next = `插件里放不下更早的 ${reply.evicted} 条暂存，已丢弃。`;
    render(plan);
    return;
  }
  renderBlockReply(reply);
}

/**
 * 「读不到页面」的统一出口：**看得见的说明 + 重试**。
 * 用在两处：`opennote:load` 失败/超时、`opennote:preview` 拿不到预览。
 * 芯片保持 CHECKING 的原文（我们不谎报连接状态：此刻并不知道桥是好是坏）；
 * 契约里没有「读取超时」这个状态，加新状态要走 03 —— 所以这里只把**正文区**变成可执行的出口。
 */
function renderUnreadableBody(reason) {
  const plan = planForState(STATE.CHECKING);
  plan.skeleton = false;
  plan.preview = false;
  plan.rows = false;
  plan.empty = {
    title: "没能读到页面。",
    text: PICK_FAIL_COPY[reason] || PICK_FAIL_COPY.extraction_failed,
  };
  plan.actions = [{ id: "retry", label: "重试", primary: true }];
  plan.primary = { label: "剪藏到 Opennote", disabled: true, busy: false };
  render(plan);
}

function renderBlockReply(reply) {
  const code = reply.code || null;
  const stateId = reply.state || STATE.CONNECTED;
  // 只有拿到「真的有一句话」时才覆盖状态自带的逐字文案；
  // 契约明令不可见的码（IMP-1005 / IMP-3001 / IMP-3004 / IMP-3005）文案为 null，
  // 此时必须落回该状态的逐字文案，而不是兜一句自造文案。
  const explicit = reply.label || (code ? userMessage(code) : null);

  if (stateId === STATE.FOLDER_DENIED || stateId === STATE.NO_WORKSPACE) {
    const plan = planForState(stateId, { code });
    if (plan.block && explicit) plan.block.message = explicit;
    render(plan);
    return;
  }
  if (stateId === STATE.CONNECTED) {
    // 已连接但本次失败（限流 / 落点被拒 …）：芯片保持真实连接态，错误用独立块。
    const plan = planForState(STATE.CONNECTED);
    plan.block = {
      kind: "error",
      message: explicit || userMessage("IMP-4014"),
      next: reply.detail || null,
      code,
    };
    plan.actions = [
      { id: "retry", label: "重试", primary: true },
      { id: "open-settings", label: "打开 Opennote 设置", primary: false },
    ];
    plan.primary = { label: "剪藏到 Opennote", disabled: true, busy: false };
    plan.preview = false;
    plan.rows = false;
    render(plan);
    return;
  }
  const plan = planForState(stateId, { code });
  if (plan.block && explicit) plan.block.message = explicit;
  render(plan);
}

/**
 * 本地校验四句（03 §UI-01 C70 / S31）：**不保存、不发请求**，逐字用清单里的那四句。
 * 格式来自 02 §5.2：`opn_` + 43 位 base64url = 总长 47。
 */
function tokenProblem(raw) {
  const value = String(raw || "").trim();
  if (!value) return "先粘贴访问令牌。";
  if (!value.startsWith("opn_")) return "令牌要以 opn_ 开头。";
  if (value.length !== 47) return "令牌要是 47 个字符：opn_ 加 43 位。";
  if (!/^opn_[A-Za-z0-9_-]{43}$/.test(value)) return "令牌里有不认识的字符，请重新复制一次。";
  return null;
}

async function connectToken(token, fromStart) {
  const value = String(token || "").trim();
  const problem = tokenProblem(value);
  if (problem) {
    // S31：输入框边框变强调色 + 下方一行错误句；不保存、不发请求
    tokenError.textContent = problem;
    tokenError.hidden = false;
    tokenInput.setAttribute("aria-invalid", "true");
    tokenInput.focus();
    return;
  }
  tokenInput.removeAttribute("aria-invalid");
  tokenError.hidden = true;
  const response = await send({ type: "opennote:set-token", token: value });
  const reply = response && response.reply;
  if (reply && reply.ok) {
    settingsOpen = false;
    tokenInput.value = "";
    await load(true);
    // 探测本身失败（超时/抛错）不影响「令牌已保存」，但必须如实说出来：否则用户以为连上了。
    if (reply.probeFailed === "timeout") notify("令牌已保存。本地接口这次没在时限内回话，稍后会自动重试。");
    else if (reply.probeFailed) notify("令牌已保存。本地接口这次没能探测成功，稍后会自动重试。");
    else notify("令牌已保存。"); // C74（2.4 秒后消失由 notify 的计时器负责）
    return;
  }
  if (fromStart) render(planForState(STATE.TOKEN_INVALID, { code: "IMP-2002" }));
  else {
    // 可读原因：后台说得出原因就用它的原话；说不出来（超时/没回）也必须给一句人话 —— 绝不静默。
    tokenError.textContent =
      (reply && reply.label) ||
      (response && response.timedOut
        ? "本地接口没有在规定时间内回话。请再点一次「连接」。"
        : userMessage("IMP-2002"));
    tokenError.hidden = false;
  }
}

/** L2 元素入口（㉝）：点一下 → 关闭 popup → 页面进入选择模式（覆盖层由 content/picker.js 画）。 */
async function startPick() {
  pickNote.hidden = true;
  pickDetail.hidden = true;
  pickDetail.textContent = "";
  const response = await send({ type: "opennote:pick" });
  const reply = response && response.reply;
  if (reply && reply.ok) {
    window.close(); // popup 随即关闭（UI-16 进入选择模式）
    return;
  }
  // task-21：四因分离 —— 后台说什么原因就说什么原因，**不再统一伪装成「页面类型不支持」**
  const reason = (reply && reply.reason) || "";
  pickNote.textContent =
    (reply && reply.copy) || PICK_FAIL_COPY[reason] || "没能进入元素选择模式。";
  pickNote.hidden = false;
  // 注入失败/读不到地址：把 `chrome.scripting` 的原文照贴出来（可选中复制），便于用户回报
  if (reply && reply.detail) {
    pickDetail.textContent = `${reason || "unknown"} · ${reply.detail}`;
    pickDetail.hidden = false;
  }
}

async function runAction(id, action) {
  switch (id) {
    case "retry":
      await load(true);
      break;
    case "queue":
    case "stage":
      await stage();
      break;
    case "open-settings":
    case "open-opennote":
      await send({ type: "opennote:open-settings" });
      window.close();
      break;
    case "settings":
      settingsOpen = !settingsOpen;
      render(settingsOpen ? settingsPlan() : currentPlan());
      break;
    case "open-note":
      await send({ type: "opennote:open-note", path: (action && action.path) || pendingNotePath });
      break;

    case "copy":
      await copyMarkdown();
      break;
    case "forget":
      // C77：危险操作先确认（清掉之后这个客户端就不能再导入了）
      tokenConfirm.hidden = false;
      tokenConfirmYes.focus();
      break;
    case "again":
      if (closeTimer) clearTimeout(closeTimer);
      titleTouched = false;
      currentImportId = null;
      lastSignature = null;
      await load(true);
      break;
    default:
      break;
  }
}

/* ─────────────────────────── 事件 ─────────────────────────── */

function setMode(next) {
  // M1：只有两个按钮 —— element（选择当前元素）/ page（整页提取）
  if (next !== "element" && next !== "page") return;
  // 03 §UI-16「与其它界面的关系」：手动切走再切回来**不重放**上一次的选择（要重新点入口）。
  if (next === "element" && !(snapshot && snapshot.pickedElement && snapshot.pickedElement.tagName)) {
    notify("还没选元素。点上面的「选择当前元素」，在页面上点一下要剪的那块。");
  }
  mode = next;
  if (snapshot && snapshot.settings) snapshot.settings.mode = next;
  render();
  schedulePreview();
}


function bindEvents() {

  // L2 两个按钮（M1 / task-24）：`选择当前元素` 走 ㉝ 那套（一字未改），`整页提取` 切回整页正文
  pickButton.addEventListener("click", () => void startPick());
  extractPageButton.addEventListener("click", () => setMode("page"));
  // 令牌块（㉞）：粘贴 → 本地校验 → 保存；清除前先确认（C77）
  tokenSave.addEventListener("click", () => void connectToken(tokenInput.value, false));
  // C58：已保存状态下给「重新粘贴令牌」，点了就把输入框放回来（旧令牌在新令牌写入前保持有效）
  tokenRepaste.addEventListener("click", () => {
    if (snapshot && snapshot.settings) snapshot.settings.hasToken = false;
    tokenInputBlock();
    tokenInput.focus();
  });
  tokenInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void connectToken(tokenInput.value, false);
    }
  });
  tokenConfirmYes.addEventListener("click", async () => {
    tokenConfirm.hidden = true;
    await send({ type: "opennote:forget-token" });
    await load(true);
  });
  tokenConfirmNo.addEventListener("click", () => {
    tokenConfirm.hidden = true;
  });

  primary.addEventListener("click", (event) => {
    if (event.target.closest(".spinner")) return;
    if (primary.dataset.intent === "stage") {
      void stage();
      return;
    }
    // 暂存成功但有图片降级说明时：先看说明，再点这里打开网页版剪藏页（URL 仍是接口给的那个）
    if (primary.dataset.intent === "open-clip-web") {
      if (pendingOpenUrl) void chrome.tabs.create({ url: pendingOpenUrl });
      return;
    }
    void submit();
  });


  more.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    more.setAttribute("aria-expanded", open ? "true" : "false");
  });
  menu.addEventListener("click", (event) => {
    const item = event.target.closest("button[role='menuitem']");
    if (!item || item.disabled) return;
    menu.hidden = true;
    more.setAttribute("aria-expanded", "false");
    void runAction(item.dataset.action);
  });
  document.addEventListener("click", (event) => {
    if (menu.hidden) return;
    if (event.target.closest("#menu") || event.target.closest("#more")) return;
    menu.hidden = true;
    more.setAttribute("aria-expanded", "false");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      menu.hidden = true;
      more.setAttribute("aria-expanded", "false");
    }
  });
}

/* ─────────────────────────── 启动 ─────────────────────────── */

async function load(force = false) {
  render(planForState(STATE.CHECKING));
  const response = await send({ type: force ? "opennote:retry" : "opennote:load" });
  if (!response || !response.ok) {
    // 出口：后台没回、回了失败、或**超时**（`timedOut`）—— 都进同一个可重试的错误态，
    // 绝不留在「正在读取页面…」（用户实测的卡死）。
    renderBlockReply({ status: "error", code: "IMP-4014", label: userMessage("IMP-4014") });
    renderUnreadableBody(null);
    return;
  }
  snapshot = response;
  // M1 默认来源（只有两个按钮）：本页已经选过元素 → `选择当前元素`；否则 → `整页提取`。
  const picked = response.pickedElement;
  mode = picked && picked.tagName ? "element" : "page";
  if (!titleTouched) titleValue = "";
  if (response.stateId === STATE.NEEDS_PAIRING || response.stateId === STATE.TOKEN_INVALID || !(response.settings && response.settings.hasToken)) {
    tokenRow.hidden = false;
  }
  render(currentPlan());
  void refreshPreview();
}

document.documentElement.setAttribute(
  "data-theme",
  window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "night" : "paper",
);
bindEvents();
void load();




