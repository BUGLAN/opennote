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

let previewTimer = null;
/** 预览里读到的「实际会发出去的值」，用于标签自动补全等展示。 */
let lastPreview = null;

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
  // M1：只有两个按钮，这里如实显示当前来源（元素选择 / 整页提取）
  // 选中的是 iframe：如实说明只剪到外框，不假装读到了里面的内容
  if (mode === "element" && snapshot && snapshot.pickedElement && snapshot.pickedElement.isIframe) {
    box.appendChild(el("p", "clip__hint", "这块是嵌入的内容，只能剪到它的外框，里面的内容读不到。"));
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
 * L2 那一行（M1 / task-24）：只有两个按钮，但原来说的话一句不少 ——
 * - 没选过元素 → `选择当前元素`；已选过 → `重新选择`（C66）
 * - 选择模式正在页面上等待点选（`snapshot.pickArmed`）→ `正在页面上等待你点选…` + `在页面上点一下要剪的部分；按 Esc 取消。`（C68/C69）
 */
function syncPickRow() {
  const picked = snapshot && snapshot.pickedElement;
  const armed = Boolean(snapshot && snapshot.pickArmed);
  pickButton.textContent = picked && picked.tagName ? "重新选择" : "选择当前元素";
  if (armed) {
    pickNote.textContent = "正在页面上等待你点选…在页面上点一下要剪的部分；按 Esc 取消。";
    pickNote.hidden = false;
  } else if (pickNote.dataset.keep !== "1") {
    pickNote.hidden = true;
  }
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

/** 预览：与真正提交共用 background 的同一条合成路径（来源 = 页面自动提取）。 */
function schedulePreview() {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => void refreshPreview(), 140);
}

async function refreshPreview() {
  if (!snapshot || snapshot.restricted) return;
  // M1：popup 不再发 templateId / props / dirty（模板与属性区已退场）；
  // 来源信息（标题/网址/站点/作者/发布时间）由页面自动提取，后台按「null 则省略整行」生成 front-matter。
  const response = await send({ type: "opennote:preview", mode });
  if (!response || !response.ok || !response.preview) {
    // 出口（不许静默 return）：预览拿不到 = 用户看不到正文，必须**看得见**并能重试。
    renderUnreadableBody(snapshot && snapshot.pickFailReason);
    return;
  }
  const preview = response.preview;
  lastPreview = preview;
  const props = preview.props || {};
  titleValue = props.title || titleValue || "";
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

/** L6（C46/C47/C48）：交付方式**如实显示**，不替用户承诺，也不做假开关。 */
function updateDeliveryHint() {
  if (!deliveryHint) return;
  const inbox = snapshot && snapshot.inbox;
  if (inbox === true) deliveryHint.textContent = "这次会先进入 Opennote 的收件箱，在收件箱里确认后才会写成笔记。";
  else if (inbox === false) deliveryHint.textContent = "这次会直接写成笔记，可以在 Opennote 里撤销。";
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
