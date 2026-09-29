/**
 * UI-01 · 剪藏弹窗控制器。
 *
 * 文案纪律：本文件里出现的所有中文串都必须在 03 §UI-01 / UI-02 的「中文文案（逐字）」表
 * 或 docs/import/mockups/01-extension-popup.html 里逐字存在；新增的只有「通道级通知」
 * （复制成功 / 需手动复制 / 暂存条目被丢弃），它们都指向明确的降级动作，
 * 清单见 extension/README.md「新增文案清单」。
 */

import { filterTags } from "../lib/envelope.js";
import { userMessage } from "../lib/errors.js";
import { STATE, planFor } from "../lib/state.js";

const $ = (id) => document.getElementById(id);
const clip = $("clip");
const chip = $("chip");
const chipText = $("chipText");
const segWrap = $("seg");
const segmented = $("segmented");
const regionBody = $("regionBody");
const region = $("region");
const regionHighlight = $("regionHighlight");
const regionProps = $("regionProps");
const sourceSwitch = $("sourceSwitch");
const tmplRow = $("tmplRow");
const templateSelect = $("template");
const tmplNote = $("tmplNote");
const hlList = $("hlList");
const hlCount = $("hlCount");
const hlClear = $("hlClear");
const hlConfirm = $("hlConfirm");
const hlConfirmBody = $("hlConfirmBody");
const hlConfirmYes = $("hlConfirmYes");
const hlConfirmNo = $("hlConfirmNo");
const hlStoreError = $("hlStoreError");
const footActs = $("footActs");
const primary = $("primary");
const more = $("more");
const menu = $("menu");
const propTitle = $("propTitle");
const propTitleCount = $("propTitleCount");
const propUrl = $("propUrl");
const propSourceTitle = $("propSourceTitle");
const propSite = $("propSite");
const propAuthor = $("propAuthor");
const propPublished = $("propPublished");
const folderInput = $("folder");
const tagsInput = $("tags");
const notePathInput = $("notePath");
const folderOptions = $("folderOptions");
const noteOptions = $("noteOptions");
const propsError = $("propsError");
const footFolder = $("footFolder");
const footTags = $("footTags");
const deliveryHint = $("deliveryHint");
// 0.3.1（00 §6.15㉝㉞）：L2 元素入口 + 令牌块 + 高亮来源说明 + 清令牌确认
const pickButton = $("pick");
const pickNote = $("pickNote");
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
const hlScopeNote = $("hlScopeNote");
const tokenConfirm = $("tokenConfirm");
const tokenConfirmYes = $("tokenConfirmYes");
const tokenConfirmNo = $("tokenConfirmNo");

let snapshot = null;
let mode = "selection";
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
/** 模板（㉙）：null = 按 URL 自动匹配；模板 id = 用户显式选择；"none" = 不使用模板。 */
let templateId = null;
/** 高亮（㉚）：当前页已记录的高亮。 */
let highlights = [];
/** 属性面板里被用户手改过的字段（手改优先于模板与抽取结果）。 */
const dirtyProps = new Set();
let dirtyNotePath = false;
let previewTimer = null;
/** 预览里读到的「实际会发出去的值」，用于标签自动补全等展示。 */
let lastPreview = null;
/** 高亮存储写入失败（UI-14/S8）：在 popup 顶部如实说出来，不假装成功。 */
let highlightStoreFailed = false;

/* ─────────────────────────── 基础设施 ─────────────────────────── */

function send(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (reply) => {
        void chrome.runtime.lastError;
        resolve(reply == null ? null : reply);
      });
    } catch {
      resolve(null);
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
  const value = folderInput.value.trim();
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

function previewNode() {
  const ex = extraction();
  const box = el("div", "clip__preview");
  const row = el("div", "clip__title-row");
  // 03 §UI-01 ②：标题的**唯一输入源**在属性区；正文卡上的标题行是只读的，
  // 右侧给一个「改标题」按钮跳到属性区并聚焦标题输入框（不做第二个输入框，避免两个真源）。
  const title = el("p", "clip__title-in");
  title.id = "inlineTitle";
  title.textContent = titleValue || defaultTitle();
  row.appendChild(title);
  const edit = el("button", "clip__title-edit", "改标题");
  edit.type = "button";
  edit.addEventListener("click", () => {
    setRegion("property");
    propTitle.focus();
    propTitle.select();
  });
  row.appendChild(edit);
  if (mode === "page") {
    const chars = (ex && ex.article && ex.article.chars) || 0;
    row.appendChild(el("span", "clip__count", `约 ${chars.toLocaleString("en-US")} 字 · 预计 1 篇笔记`));
  }
  box.appendChild(row);

  const excerpt =
    mode === "selection"
      ? (ex && ex.selection && ex.selection.markdown) || ""
      : (ex && ex.article && ex.article.excerpt) || "";
  box.appendChild(el("p", "clip__excerpt", String(excerpt).slice(0, 600)));

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
  // C65：来源 = 元素选择且已选过时，标题行右侧一行 `已选择 {标签名}`
  if (pickSummary()) box.appendChild(el("p", "clip__count", pickSummary()));
  // 选中的是 iframe：如实说明只剪到外框，不假装读到了里面的内容
  if (mode === "element" && snapshot && snapshot.pickedElement && snapshot.pickedElement.isIframe) {
    box.appendChild(el("p", "clip__hint", "这块是嵌入的内容，只能剪到它的外框，里面的内容读不到。"));
  }
  // C23 / S13：本页有高亮时，正文区给一行说明（高亮是 body 的一部分，不改 source.selection）
  if ((highlights || []).length) {
    box.appendChild(el("p", "clip__merged", "高亮会一起写进正文，出处在「高亮」区里可以再看。"));
  }
  return box;
}

function actionButton(action) {
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
 */
function tokenInputBlock() {
  tokenRow.hidden = false;
  const state = snapshot && snapshot.settings ? snapshot.settings : {};
  const hasToken = Boolean(state.hasToken);
  tokenSaved.hidden = !hasToken;
  tokenInputRow.hidden = hasToken;
  tokenHint.hidden = hasToken;
  tokenMain.hidden = hasToken;
  tokenError.hidden = true;
  if (hasToken) {
    // C58 / UI-04 S6 的只读写法：`opn_••••••••••••1234`（明文不留在界面上）
    tokenCode.textContent = `opn_${"•".repeat(12)}${String(state.tokenTail || "????")}`;
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
  // `kind: "token"`（㉞）：这个错误块的下一步动作只有一个 —— 粘贴长期令牌
  if (plan && plan.tokenInput) box.appendChild(tokenInputBlock());
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
      text: "点上面的「选择页面元素」，在页面上点一下要剪的那块。",
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

function render(planInput) {
  const plan = planInput || currentPlan();
  clip.dataset.state = plan.state;
  clip.dataset.busy = busy ? "true" : "false";

  chip.className = `status-chip${plan.chip.cls ? ` ${plan.chip.cls}` : ""}`;
  chipText.textContent = plan.chip.text;
  chip.tabIndex = -1;

  segWrap.hidden = !plan.segments;
  syncSegmented();
  syncSourceSwitch();
  syncPickRow();
  updateDeliveryHint();
  if (hlScopeNote) hlScopeNote.hidden = mode !== "selection";

  // 三区（00 §6.14 ㉘）：状态流（加载 / 空态 / 成功 / 报错块）始终占用正文区，
  // 这样「进收件箱」「配对」这类一次性回执不会跑到高亮或属性区里去。
  const flowLike = Boolean(notice || plan.skeleton || plan.empty || plan.ok || plan.block);
  const showBody = !plan.segments || flowLike || regionMode === "body";
  const showHighlight = !flowLike && Boolean(plan.segments && plan.highlightsAvailable) && regionMode === "highlight";
  const showProps = !flowLike && Boolean(plan.segments && plan.propertyPanel) && regionMode === "property";
  regionBody.hidden = !showBody;
  regionHighlight.hidden = !showHighlight;
  regionProps.hidden = !showProps;

  region.replaceChildren();
  if (notice) region.appendChild(noticeNode());
  if (plan.skeleton) region.appendChild(skeletonNode());
  else if (plan.empty) region.appendChild(emptyNode(plan.empty));
  else if (plan.ok) region.appendChild(okNode(plan.ok));
  else if (plan.block) region.appendChild(blockNode(plan.block, plan));
  else region.appendChild(previewNode());

  sourceSwitch.hidden = flowLike || !plan.segments || plan.sourceSwitch === false;
  tmplRow.hidden = flowLike || !plan.templatePicker;
  if (!tmplRow.hidden) syncTemplateSelect();

  const propsAvailable = showProps || (!flowLike && Boolean(plan.segments && plan.propertyPanel));
  for (const input of [propTitle, propUrl, propSourceTitle, propSite, propAuthor, propPublished, folderInput, tagsInput, notePathInput]) {
    input.disabled = !propsAvailable;
  }

  const actionsInFoot = Boolean(plan.empty || plan.ok || !plan.primary);
  footActs.replaceChildren();
  if (actionsInFoot) for (const action of plan.actions || []) footActs.appendChild(actionButton(action));

  if (plan.primary) {
    const loading = busy || plan.primary.busy;
    primary.hidden = false;
    primary.replaceChildren();
    // S-C5：加载态左侧放 12px 旋转环，文案改进行时，宽度靠 min-width 吸收不跳变。
    if (loading) primary.appendChild(el("span", "spinner"));
    primary.appendChild(document.createTextNode(loading ? busyLabel : plan.primary.label));
    primary.disabled = Boolean(plan.primary.disabled) || busy;
    primary.setAttribute("aria-busy", loading ? "true" : "false");
    primary.dataset.intent = plan.primary.label === "暂存在插件里" ? "stage" : "submit";
  } else {
    primary.hidden = true;
  }
  more.hidden = Boolean(plan.ok) || plan.state === STATE.RESTRICTED_PAGE;
}

/** 三区切换（保留用户在各区里已经填/选的内容，切区不丢数据）。 */
function syncSegmented() {
  clip.dataset.region = regionMode;
  for (const button of segmented.querySelectorAll("button")) {
    const active = button.dataset.region === regionMode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-checked", active ? "true" : "false");
    button.tabIndex = active ? 0 : -1;
  }
}

/** 正文区的来源开关（原来的分段控件降级而来）。 */
/**
 * 来源三选一（00 §6.15㉝；03 §UI-01 C64）：
 * - `元素选择`：仅 http(s)；已选过元素时才是默认项（S26），没选过则空态（S27，C67）
 * - `整页正文`：http(s) 可用
 * - `当前选区`：**只有页面上真有非空选区时**才可用，否则禁用 + C75 的 title（便捷项，不再是主路径）
 */
function syncSourceSwitch() {
  const restricted = Boolean(snapshot && snapshot.restricted);
  const selectionAvailable = !restricted && hasSelection();
  for (const button of sourceSwitch.querySelectorAll("button")) {
    const value = button.dataset.mode;
    const unavailable = restricted ? true : value === "selection" ? !selectionAvailable : false;
    button.disabled = unavailable;
    if (value === "selection") {
      button.title = unavailable && !restricted ? "现在页面上没有选中的文字。先在页面上选一段再来。" : "";
    }
    const active = value === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-checked", active ? "true" : "false");
    button.tabIndex = active ? 0 : -1;
  }
}

/** L2 元素入口的四种文案（03 §UI-01 C66/C68/C71、UI-16 C02–C05）。 */
function syncPickRow() {
  if (!pickButton) return;
  const restricted = Boolean(snapshot && snapshot.restricted);
  const armed = Boolean(snapshot && snapshot.pickArmed);
  const picked = Boolean(snapshot && snapshot.pickedElement);
  pickButton.disabled = restricted || armed;
  pickButton.textContent = armed ? "正在页面上等待你点选…" : picked ? "重新选择" : "选择页面元素";
  pickButton.title = restricted ? "这个页面不能选择元素：只有普通网页（http 或 https）支持。换个普通网页再试。" : "";
  pickNote.hidden = !armed;
  pickNote.textContent = armed ? "在页面上点一下要剪的部分；按 Esc 取消。" : "";
}

/** 已选元素后的次行（C65）；来源不是元素选择时隐藏。 */
function pickSummary() {
  if (mode !== "element") return "";
  const picked = snapshot && snapshot.pickedElement;
  if (!picked || !picked.tagName) return "";
  return `已选择 ${picked.tagName}`;
}

/** 模板选择器（㉘㉙）：自动匹配 + 手动切换 + 「不使用模板」。 */
function syncTemplateSelect() {
  const list = (snapshot && snapshot.templates) || [];
  const wanted = templateId === null ? (snapshot && snapshot.templateMatchedId) || "" : templateId;
  // C04：自动命中的那一项在列表里叫「按网址自动匹配」；C05：手动选择后说明行写「已手动选择」
  const options = [{ id: "", name: "按网址自动匹配", hint: snapshot && snapshot.templateMatchedBy ? `命中 ${snapshot.templateMatchedBy}` : "无命中，用默认模板" }];
  for (const template of list) {
    options.push({ id: template.id, name: template.builtin ? `${template.name}（内置）` : template.name, hint: template.summary });
  }
  options.push({ id: "none", name: "不使用模板", hint: "正文与属性全部用页面抽取结果" });
  // C06：模板列表最后一行是「管理模板…」，打开选项页（不在 ⋯ 菜单里）
  options.push({ id: "__manage", name: "管理模板…", hint: "打开插件选项页管理模板" });
  const signature = options.map((option) => option.id).join("|");
  if (templateSelect.dataset.signature !== signature) {
    templateSelect.dataset.signature = signature;
    templateSelect.replaceChildren();
    for (const option of options) {
      const node = el("option");
      node.value = option.id;
      node.textContent = option.name;
      node.title = option.hint || "";
      templateSelect.appendChild(node);
    }
  }
  templateSelect.value = options.some((option) => option.id === wanted) ? wanted : "";
  const current = options.find((option) => option.id === templateSelect.value);
  const chosen = list.find((template) => template.id === templateSelect.value);
  tmplNote.textContent =
    templateId === null ? `按网址自动匹配${current && current.hint ? `（${current.hint}）` : ""}` : "已手动选择";
  tmplNote.title = chosen ? chosen.summary : (current ? current.hint : "");
}

function renderFolderOptions() {
  folderOptions.replaceChildren();
  const values = ["", folderInput.value.trim()];
  if (snapshot && snapshot.settings && snapshot.settings.folder) values.push(snapshot.settings.folder);
  if (snapshot && snapshot.defaultFolder) values.push(snapshot.defaultFolder);
  values.push("剪藏");
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    const option = el("option");
    option.value = value;
    option.label = value || "根目录";
    folderOptions.appendChild(option);
  }
}

function renderNoteOptions() {
  noteOptions.replaceChildren();
  const values = [notePathInput.value.trim()];
  const history = (snapshot && snapshot.settings && snapshot.settings.notePaths) || [];
  for (const value of history) values.push(value);
  const seen = new Set();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const option = el("option");
    option.value = value;
    noteOptions.appendChild(option);
  }
}

/**
 * 高亮区（00 §6.14 ㉚；文案逐字 03 §UI-01 C24–C30 / §UI-14 S14–S17）。
 * 每条：`> 摘录`（2 行截断）+ 批注（`— ` 前缀）+ 时间 + `清除`；
 * 批注编辑态：`.field`（占位 `写一句批注（可不填）`）+ 两个底色 swatch + `保存`/`取消`。
 */
function renderHighlightList() {
  const items = highlights || [];
  hlCount.textContent = `已高亮 ${items.length} 处`;
  hlClear.hidden = !items.length;
  if (hlStoreError) hlStoreError.hidden = !highlightStoreFailed;
  hlList.replaceChildren();
  if (!items.length) {
    hlList.appendChild(el("li", "clip__hl-empty", "这个页面上还没有高亮。在页面上选中文字，点右键菜单里的「高亮这段文字」。"));
    return;
  }
  for (const item of items) {
    hlList.appendChild(highlightItemNode(item));
  }
}

function highlightItemNode(item) {
  const li = el("li", "clip__hl-item");
  li.dataset.tier = item.tier || "yellow";
  li.dataset.id = item.id;
  const body = el("div", "clip__hl-body");
  body.appendChild(el("p", "clip__hl-text", item.text));
  if (item.note) body.appendChild(el("p", "clip__hl-note", `— ${item.note}`));
  const time = item.createdAt ? String(item.createdAt).slice(0, 16).replace("T", " ") : "";
  body.appendChild(el("p", "clip__hl-meta", time));
  li.appendChild(body);

  const acts = el("div", "clip__hl-acts");
  const annotate = el("button", "clip__hl-act", item.note ? "编辑批注" : "加批注");
  annotate.type = "button";
  annotate.addEventListener("click", () => openAnnotation(li, item));
  acts.appendChild(annotate);
  const del = el("button", "clip__hl-del", "清除");
  del.type = "button";
  del.setAttribute("aria-label", "清除这条高亮");
  del.title = "清除这条高亮";
  del.addEventListener("click", () => void removeHighlightItem(item.id));
  acts.appendChild(del);
  li.appendChild(acts);
  return li;
}

/** 批注编辑态（S16）：真控件、Tab 可达；保存后写回 `note`/`color`。 */
function openAnnotation(li, item) {
  const box = el("div", "clip__hl-edit");
  const input = el("input", "field");
  input.type = "text";
  input.maxLength = 500;
  input.placeholder = "写一句批注（可不填）";
  input.value = item.note || "";
  input.setAttribute("aria-label", "批注");
  box.appendChild(input);

  let tier = item.tier || "yellow";
  const swatches = el("div", "clip__hl-swatches");
  for (const swatch of [
    { value: "yellow", label: "默认底色" },
    { value: "accent", label: "强调底色" },
  ]) {
    const button = el("button", `swatch swatch--${swatch.value}`, swatch.label);
    button.type = "button";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(tier === swatch.value));
    if (tier === swatch.value) button.classList.add("is-active");
    button.addEventListener("click", () => {
      tier = swatch.value;
      for (const node of swatches.children) {
        const active = node.dataset.value === tier;
        node.classList.toggle("is-active", active);
        node.setAttribute("aria-checked", String(active));
      }
    });
    button.dataset.value = swatch.value;
    swatches.appendChild(button);
  }
  box.appendChild(swatches);

  const acts = el("div", "clip__hl-edit-acts");
  const save = el("button", "btn btn--primary", "保存");
  save.type = "button";
  save.addEventListener("click", () => void saveAnnotation(item, input.value, tier));
  acts.appendChild(save);
  const cancel = el("button", "btn", "取消");
  cancel.type = "button";
  cancel.addEventListener("click", () => render());
  acts.appendChild(cancel);
  if (item.note) {
    const drop = el("button", "btn", "删除批注");
    drop.type = "button";
    drop.addEventListener("click", () => void saveAnnotation(item, "", tier));
    acts.appendChild(drop);
  }
  box.appendChild(acts);
  li.appendChild(box);
  setTimeout(() => input.focus(), 0);
}

async function saveAnnotation(item, note, color) {
  const response = await send({ type: "opennote:highlight-update", id: item.id, note: String(note || "").trim(), color });
  if (response && response.ok) {
    highlights = response.items || [];
    render();
    schedulePreview();
    notify("批注已保存。");
    return;
  }
  notify((response && response.label) || "批注保存失败。");
}

async function removeHighlightItem(id) {
  const response = await send({ type: "opennote:highlight-remove", id });
  if (response && response.ok) {
    highlights = response.items || [];
    if (snapshot) snapshot.highlightCount = highlights.length;
    render();
    schedulePreview();
    notify("已清除这条高亮。");
  } else {
    notify("清除高亮失败。");
  }
}

/** 批量清除（03 §UI-01 C30 / S17）：先确认，确认后才真的清。 */
function askClearHighlights() {
  if (!highlights.length) return;
  hlConfirmBody.textContent = `这一页有 ${highlights.length} 处高亮，清除后不会写进正文，也不会再出现在高亮列表里。`;
  hlConfirm.hidden = false;
  hlConfirmYes.focus();
}

async function clearHighlightItems() {
  hlConfirm.hidden = true;
  if (!highlights.length) return;
  const response = await send({ type: "opennote:highlight-clear" });
  if (response && response.ok) {
    highlights = [];
    if (snapshot) snapshot.highlightCount = 0;
    render();
    schedulePreview();
    notify(`已清除本页 ${response.cleared || 0} 处高亮。`);
  } else {
    notify("清除高亮失败。");
  }
}

/** 预览（模板 + 手改 + 高亮）——与真正提交共用 background 的同一条合成路径。 */
function schedulePreview() {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => void refreshPreview(), 140);
}

async function refreshPreview() {
  if (!snapshot || snapshot.restricted) return;
  const response = await send({
    type: "opennote:preview",
    mode,
    templateId: templateId === null ? undefined : templateId,
    props: collectProps(),
    dirty: dirtyMap(),
  });
  if (!response || !response.ok || !response.preview) return;
  const preview = response.preview;
  lastPreview = preview;
  const props = preview.props || {};

  // 没被手改过的字段跟随模板/抽取结果；手改过的字段保持用户输入（显式意愿优先）。
  const assign = (input, key, value) => {
    if (!input || dirtyProps.has(key)) return;
    const next = value === undefined || value === null ? "" : String(value);
    if (input.value !== next) input.value = next;
  };
  assign(propTitle, "title", props.title);
  assign(propUrl, "source.url", props["source.url"]);
  assign(propSourceTitle, "source.title", props["source.title"]);
  assign(propSite, "source.site", props["source.site"]);
  assign(propAuthor, "author", props.author);
  assign(propPublished, "publishedAt", props.publishedAt);
  assign(tagsInput, "tags", props.tags);
  assign(folderInput, "target.folder", props["target.folder"]);
  if (!dirtyNotePath && notePathInput.value !== (preview.notePath || "")) notePathInput.value = preview.notePath || "";

  if (!dirtyProps.has("title")) titleValue = props.title || "";
  if (snapshot) {
    snapshot.templateMatchedBy = preview.templateMatchedBy || null;
    snapshot.templateMatchedId = preview.templateId || null;
    snapshot.templateFallback = Boolean(preview.templateFallback);
    snapshot.templateNotes = preview.notes || [];
  }
  syncTwins();
  updateTitleCount();
  updateTouchedButtons();
  renderNoteOptions();
  renderFolderOptions();
  syncTemplateSelect();
  // 正文区里的标题行是只读视图（唯一输入源是属性区，03 §UI-01 ②）
  const inlineTitle = document.getElementById("inlineTitle");
  if (inlineTitle) inlineTitle.textContent = titleValue || "未命名笔记";
}

/** C38：被改动过的字段右侧出现「按模板更新」；点了就交回模板（清掉 touched）。 */
function updateTouchedButtons() {
  for (const row of regionProps.querySelectorAll(".clip__row")) {
    const input = row.querySelector("input");
    if (!input) continue;
    const key = input.dataset.prop || (input === notePathInput ? "notePath" : "");
    const touched = key === "notePath" ? dirtyNotePath : dirtyProps.has(key);
    let button = row.querySelector(".clip__reset");
    if (!touched) {
      if (button) button.remove();
      continue;
    }
    if (!button) {
      button = el("button", "clip__reset", "按模板更新");
      button.type = "button";
      button.dataset.prop = key;
      button.addEventListener("click", () => {
        if (key === "notePath") {
          dirtyNotePath = false;
          notePathInput.value = "";
        } else {
          dirtyProps.delete(key);
          input.value = "";
        }
        updateTouchedButtons();
        void refreshPreview();
      });
      row.appendChild(button);
    }
  }
}

/** C37：标题计数 `{n}/200`。 */
function updateTitleCount() {
  if (propTitleCount) propTitleCount.textContent = `${propTitle.value.length}/200`;
}

/** L5 与属性区是**同一个 state 的两个视图**：任一处输入立即同步另一处，touched 一起置 1。 */
function syncTwins(from) {
  const pairs = [
    [folderInput, footFolder, "target.folder"],
    [tagsInput, footTags, "tags"],
  ];
  for (const [a, b, key] of pairs) {
    if (!dirtyProps.has(key)) {
      b.value = a.value; // 未改动：两处都显示模板/抽取结果
      continue;
    }
    // 已改动：以用户最后输入的那一处为准同步另一处（同一 state，不是两份草稿）
    const source = from === "foot" ? b : a;
    const target = from === "foot" ? a : b;
    target.value = source.value;
  }
  updateTitleCount();
}

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

/** 模板的导入/导出搬到插件选项页（03 §UI-01 C06「管理模板…」），popup 里不再重复一份。 */

/** 属性面板的 8 个字段（㉘）+ 追加落点，一起发给 background 合成。 */
function collectProps() {
  return {
    title: propTitle.value,
    "source.url": propUrl.value,
    "source.title": propSourceTitle.value,
    "source.site": propSite.value,
    author: propAuthor.value,
    publishedAt: propPublished.value,
    tags: tagsInput.value,
    "target.folder": folderInput.value,
  };
}

/**
 * 本地预检（03 §UI-01 S21 / C39–C43）：不通过就**停在这里、不发请求**。
 * 文案逐字用 03 的清单；服务端仍会独立校验（同一句 `IMP-4008` 的 userMessage）。
 */
const PUBLISHED_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?)?$/;
const NOTE_PATH_RE_LOCAL = /^(?![/\\])(?!.*(?:^|[/\\])\.\.(?:[/\\]|$))(?!.*:)[^\\]+\.md$/;

function precheck() {
  const problems = [];
  const focus = (input, message) => {
    problems.push({ input, message });
    input.setAttribute("aria-invalid", "true");
  };
  for (const input of [propTitle, propUrl, propSourceTitle, propSite, propAuthor, propPublished, folderInput, notePathInput]) {
    input.removeAttribute("aria-invalid");
  }
  if (!propTitle.value.trim()) focus(propTitle, "标题不能为空。");
  const url = propUrl.value.trim();
  if (url && !/^https?:\/\//i.test(url)) focus(propUrl, "网址要以 http:// 或 https:// 开头。");
  const published = propPublished.value.trim();
  if (published && !PUBLISHED_RE.test(published)) focus(propPublished, "发布时间要写成 2026-09-21 或 2026-09-21T15:04:05+08:00 这样的格式。");
  const folder = folderInput.value.trim();
  if (folder && (/^[/\\]/.test(folder) || /^[A-Za-z]:/.test(folder) || folder.includes("\\") || /(^|\/)\.\.(\/|$)/.test(folder) || folder.includes(":") || folder.split("/").length > 10 || folder.split("/").some((segment) => segment.length > 80))) {
    focus(folderInput, "目标目录不合法：不能使用 ..、绝对路径或系统保留字符。");
  }
  const notePath = notePathInput.value.trim();
  if (notePath && !NOTE_PATH_RE_LOCAL.test(notePath)) {
    focus(notePathInput, "追加目标要写成工作区里的相对路径，并以 .md 结尾。");
  }
  return problems;
}

/** C44：标签被本地过滤时如实提示（不静默丢）。 */
function tagFilterNotice() {
  const raw = String(tagsInput.value || "");
  const kept = filterTags(raw);
  const asked = raw.split(/[,，\n]/).map((part) => part.trim()).filter(Boolean);
  return asked.length > kept.length ? "部分标签不符合规则，已忽略。" : "";
}

/** L6（C46/C47/C48）：交付方式**如实显示**，不替用户承诺，也不做假开关。 */
function updateDeliveryHint() {
  if (!deliveryHint) return;
  const inbox = snapshot && snapshot.inbox;
  if (inbox === true) deliveryHint.textContent = "这次会先进入 Opennote 的收件箱，在收件箱里确认后才会写成笔记。";
  else if (inbox === false) deliveryHint.textContent = "这次会直接写成笔记，可以在 Opennote 里撤销。";
  else deliveryHint.textContent = "交付方式由 Opennote 的设置决定，剪藏完成后会如实显示结果。";
}

function dirtyMap() {
  const props = {};
  for (const key of dirtyProps) props[key] = true;
  return { props, notePath: dirtyNotePath };
}

function collectPayload() {
  const body = currentMarkdown();
  const props = collectProps();
  const title = String(props.title || "").trim() || defaultTitle();
  const folder = String(props["target.folder"] || "").trim();
  const tags = filterTags(props.tags);
  const notePath = notePathInput.value.trim();
  const sig = signature(`${mode}|${title}|${folder}|${tags.join(",")}|${notePath}|${templateId || "auto"}|${body.length}`);
  const importId = sig === lastSignature && currentImportId ? currentImportId : newId();
  currentImportId = importId;
  lastSignature = sig;
  return { mode, title, folder, tags, notePath, props, body, importId };
}

async function submit() {
  if (busy || !snapshot || snapshot.restricted) return;
  const stateId = snapshot.stateId;
  if (stateId !== STATE.CONNECTED && stateId !== STATE.NO_WORKSPACE) return;
  const problems = precheck();
  if (problems.length) {
    setRegion("property");
    if (propsError) {
      propsError.textContent = problems[0].message;
      propsError.hidden = false;
    }
    problems[0].input.focus();
    return; // S21：不发请求
  }
  if (propsError) propsError.hidden = true;
  const payload = collectPayload();
  busy = true;
  busyLabel = "正在剪藏…";
  render(currentPlan());
  const response = await send({
    type: "opennote:submit",
    mode: payload.mode,
    title: payload.title,
    props: payload.props,
    templateId: templateId === null ? undefined : templateId,
    dirty: dirtyMap(),
    importId: payload.importId,
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
    props: payload.props,
    templateId: templateId === null ? undefined : templateId,
    dirty: dirtyMap(),
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
    notify("令牌已保存。"); // C74（2.4 秒后消失由 notify 的计时器负责）
    return;
  }
  if (fromStart) render(planForState(STATE.TOKEN_INVALID, { code: "IMP-2002" }));
  else {
    tokenError.textContent = (reply && reply.label) || userMessage("IMP-2002");
    tokenError.hidden = false;
  }
}

/** L2 元素入口（㉝）：点一下 → 关闭 popup → 页面进入选择模式（覆盖层由 content/picker.js 画）。 */
async function startPick() {
  const response = await send({ type: "opennote:pick" });
  const reply = response && response.reply;
  if (reply && reply.ok) {
    window.close(); // popup 随即关闭（UI-16 进入选择模式）
    return;
  }
  // S28：受限页面**不注入任何东西**，如实说明原因（口径沿用 IMP-1006）
  pickNote.textContent = "这个页面不能选择元素：只有普通网页（http 或 https）支持。换个普通网页再试。";
  pickNote.hidden = false;
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
    case "open-options":
      // C06 的落点在模板选择器里；这里保留同一动作，供 ⋯ 菜单的「插件设置」之后的扩展入口
      await send({ type: "opennote:open-options" });
      window.close();
      break;
    case "settings":
      settingsOpen = !settingsOpen;
      render(settingsOpen ? settingsPlan() : currentPlan());
      break;
    case "open-note":
      await send({ type: "opennote:open-note", path: (action && action.path) || pendingNotePath });
      break;
    case "tag-from-selection": {
      const ex = extraction();
      const raw = (ex && ex.selection && ex.selection.text) || "";
      const tag = filterTags(raw).slice(0, 1)[0];
      if (!tag) {
        notify("没有选中任何文字。在页面上选一段，或把来源切到「整页正文」。");
        break;
      }
      const existing = filterTags(tagsInput.value);
      if (!existing.includes(tag)) tagsInput.value = [...existing, tag].join(", ");
      tagsInput.dataset.touched = "1";
      dirtyProps.add("tags");
      render();
      schedulePreview();
      break;
    }
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
  if (next !== "element" && next !== "selection" && next !== "page") return;
  // 03 §UI-16「与其它界面的关系」：手动切走再切回来**不重放**上一次的选择（要重新点入口）。
  if (next === "element" && !(snapshot && snapshot.pickedElement && snapshot.pickedElement.tagName)) {
    notify("还没选元素。点上面的「选择页面元素」，在页面上点一下要剪的那块。");
  }
  mode = next;
  if (snapshot && snapshot.settings) snapshot.settings.mode = next;
  render();
  schedulePreview();
}

function setRegion(next) {
  if (next !== "body" && next !== "highlight" && next !== "property") return;
  regionMode = next;
  render();
  if (next === "highlight") void refreshHighlights();
}

async function refreshHighlights() {
  const response = await send({ type: "opennote:highlights" });
  if (response && response.ok) {
    highlights = response.items || [];
    if (snapshot) snapshot.highlightCount = highlights.length;
    renderHighlightList();
  }
}

function bindEvents() {
  segmented.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-region]");
    if (button) setRegion(button.dataset.region);
  });
  segmented.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const order = ["body", "highlight", "property"];
    const index = order.indexOf(regionMode);
    const next = order[(index + (event.key === "ArrowRight" ? 1 : order.length - 1)) % order.length];
    setRegion(next);
    const active = segmented.querySelector("button.is-active");
    if (active) active.focus();
  });

  sourceSwitch.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-mode]");
    if (button) setMode(button.dataset.mode);
  });
  sourceSwitch.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setMode(mode === "selection" ? "page" : "selection");
    const active = sourceSwitch.querySelector("button.is-active");
    if (active) active.focus();
  });

  templateSelect.addEventListener("change", () => {
    // 03 §UI-01 S20/C38：切模板**只重填没被改过的字段**（touched = 0）；
    // 用户手改过的字段一律不动（不得用「值等于模板值」反推，那是另一个真源）。
    templateId = templateSelect.value === "" ? null : templateSelect.value;
    render();
    void refreshPreview();
  });

  const propInputs = [
    [propTitle, "title"],
    [propUrl, "source.url"],
    [propSourceTitle, "source.title"],
    [propSite, "source.site"],
    [propAuthor, "author"],
    [propPublished, "publishedAt"],
    [tagsInput, "tags"],
    [folderInput, "target.folder"],
  ];
  for (const [input, key] of propInputs) {
    input.dataset.prop = key;
    input.addEventListener("input", () => {
      dirtyProps.add(key);
      if (key === "target.folder") renderFolderOptions();
      if (key === "title") {
        titleTouched = true;
        titleValue = input.value;
        const inlineTitle = document.getElementById("inlineTitle");
        if (inlineTitle) inlineTitle.textContent = input.value || "未命名笔记";
      }
      if (key === "tags" || key === "target.folder") syncTwins("props");
      updateTitleCount();
      updateTouchedButtons();
      schedulePreview();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void submit();
      }
    });
  }
  notePathInput.dataset.prop = "notePath";
  notePathInput.addEventListener("input", () => {
    dirtyNotePath = true;
    updateTouchedButtons();
    renderNoteOptions();
    schedulePreview();
  });
  notePathInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void submit();
    }
  });
  hlClear.addEventListener("click", () => askClearHighlights());
  hlConfirmYes.addEventListener("click", () => void clearHighlightItems());
  hlConfirmNo.addEventListener("click", () => {
    hlConfirm.hidden = true;
  });
  // L2 元素入口（㉝）
  pickButton.addEventListener("click", () => void startPick());
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
    void submit();
  });

  for (const input of [folderInput, tagsInput, footFolder, footTags]) {
    input.addEventListener("input", () => {
      input.dataset.touched = "1";
      const key = input === folderInput || input === footFolder ? "target.folder" : "tags";
      dirtyProps.add(key);
      const from = input === footFolder || input === footTags ? "foot" : "props";
      if (input === folderInput || input === footFolder) renderFolderOptions();
      syncTwins(from);
      updateTouchedButtons();
      schedulePreview();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void submit();
      }
    });
  }

  // 模板选择器最后一行「管理模板…」→ 选项页（C06；⋯ 菜单里不再有模板项）
  templateSelect.addEventListener("change", () => {
    if (templateSelect.value === "__manage") {
      templateSelect.value = templateId === null ? (snapshot && snapshot.templateMatchedId) || "" : templateId || "";
      void send({ type: "opennote:open-options" });
      return;
    }
    templateId = templateSelect.value === "" ? null : templateSelect.value;
    // 切模板只重填**没被改过**的字段（touched = 0 的那些），手改过的一律不动（C38/S20）
    render();
    void refreshPreview();
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
    renderBlockReply({ status: "error", code: "IMP-4014", label: userMessage("IMP-4014") });
    return;
  }
  snapshot = response;
  highlights = Array.isArray(response.highlights) ? response.highlights : [];
  templateId = null; // 每次打开都从「自动匹配」开始（㉘：按当前 URL 自动匹配、可手动切换）
  // 来源默认项（03 §UI-01 C64 的「默认选中条件」）：
  //   ① 本次已经选过元素 → `元素选择`；② 页面上已有文字选区 → `当前选区`（便捷项）；③ 否则 → `整页正文`（兜底）
  const picked = response.pickedElement;
  if (picked && picked.tagName) mode = "element";
  else if (hasSelection()) mode = "selection";
  else mode = "page";
  if (!titleTouched) titleValue = "";
  if (response.settings) {
    if (!folderInput.dataset.touched) folderInput.value = response.settings.folder || "";
    if (!tagsInput.dataset.touched) tagsInput.value = (response.settings.tags || []).join(", ");
  }
  renderFolderOptions();
  renderNoteOptions();
  renderHighlightList();
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
