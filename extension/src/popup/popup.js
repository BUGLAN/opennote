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
const region = $("region");
const rowsEl = $("rows");
const footActs = $("footActs");
const primary = $("primary");
const more = $("more");
const menu = $("menu");
const folderInput = $("folder");
const tagsInput = $("tags");
const folderOptions = $("folderOptions");

let snapshot = null;
let mode = "selection";
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
  const input = el("input", "clip__title-in");
  input.type = "text";
  input.id = "title";
  input.setAttribute("aria-label", "笔记标题");
  input.autocomplete = "off";
  input.spellcheck = false;
  input.value = titleTouched ? titleValue : defaultTitle();
  titleValue = input.value;
  input.addEventListener("input", () => {
    titleTouched = true;
    titleValue = input.value;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void submit();
    }
  });
  row.appendChild(input);
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

function pairingInput() {
  const input = el("input", "field clip__code");
  input.type = "text";
  input.inputMode = "numeric";
  input.maxLength = 6;
  input.placeholder = "••••••";
  input.setAttribute("aria-label", "6 位配对码");
  input.autocomplete = "one-time-code";
  input.addEventListener("input", () => {
    input.value = input.value.replace(/[^0-9]/g, "").slice(0, 6);
    if (input.value.length === 6) void pair(input.value);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void pair(input.value);
    }
  });
  setTimeout(() => input.focus(), 0);
  return input;
}

function tokenBlock() {
  const box = el("div");
  box.appendChild(el("p", "clip__hint", "在 Opennote 的「设置 · 文件 → 导入与接口」里复制访问令牌，粘贴到这里。"));
  const input = el("input", "field");
  input.type = "text";
  input.id = "token";
  input.placeholder = "粘贴访问令牌";
  input.setAttribute("aria-label", "访问令牌");
  input.autocomplete = "off";
  input.spellcheck = false;
  input.style.marginTop = "8px";
  box.appendChild(input);
  const acts = el("div", "acts");
  const connect = el("button", "btn btn--primary", "连接");
  connect.type = "button";
  connect.addEventListener("click", () => void connectToken(input.value));
  acts.appendChild(connect);
  box.appendChild(acts);
  return box;
}

function blockNode(block, plan) {
  const box = el("div", `clip__alert${block.kind === "queued" ? " is-quiet" : ""}`);
  // 最后一道兜底：任何情况下错误块里都必须有一句给人看的话（绝不静默失败）。
  const message = block.message || (block.code ? userMessage(block.code) : null) || userMessage("IMP-4014");
  box.appendChild(el("p", null, message));
  if (block.next) box.appendChild(el("p", "next", block.next));
  if (block.code) box.appendChild(el("div", "code", block.code));
  if (plan && plan.pairingInput) box.appendChild(pairingInput());
  if (settingsOpen || (plan && plan.settingsOnly)) box.appendChild(tokenBlock());

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
  if (stateId === STATE.CONNECTED && mode === "selection" && !hasSelection()) {
    plan.block = null;
    plan.rows = false;
    plan.empty = {
      title: "没有选中任何文字。",
      text: "在页面上选一段，或者切到「整页正文」。",
    };
    plan.primary = { label: "剪藏到 Opennote", disabled: true, busy: false };
    plan.actions = [];
  }
  return plan;
}

function settingsPlan() {
  const plan = planForState(STATE.CONNECTED);
  plan.block = { kind: "pair", message: null, next: null, code: null };
  plan.settingsOnly = true;
  plan.pairingInput = false;
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

  region.replaceChildren();
  if (notice) region.appendChild(noticeNode());
  if (plan.skeleton) region.appendChild(skeletonNode());
  else if (plan.empty) region.appendChild(emptyNode(plan.empty));
  else if (plan.ok) region.appendChild(okNode(plan.ok));
  else if (plan.block) region.appendChild(blockNode(plan.block, plan));
  else region.appendChild(previewNode());

  const blockKind = plan.block ? plan.block.kind : null;
  const showRows =
    blockKind === "queued" ||
    (!plan.block && !plan.ok && !plan.empty && !plan.skeleton && plan.preview !== false);
  rowsEl.hidden = !showRows;

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

function syncSegmented() {
  for (const button of segmented.querySelectorAll("button")) {
    const active = button.dataset.mode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-checked", active ? "true" : "false");
    button.tabIndex = active ? 0 : -1;
  }
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

function showManualCopy(text) {
  notice = "";
  const box = el("div", "clip__block");
  box.appendChild(el("p", null, "没能自动复制到剪贴板。请手动复制下面的正文。"));
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

function collectPayload() {
  const body = currentMarkdown();
  const title = (titleTouched ? titleValue : defaultTitle()).trim();
  const folder = folderInput.value.trim();
  const tags = filterTags(tagsInput.value);
  const sig = signature(`${mode}|${title}|${folder}|${tags.join(",")}|${body.length}`);
  const importId = sig === lastSignature && currentImportId ? currentImportId : newId();
  currentImportId = importId;
  lastSignature = sig;
  return { mode, title, folder, tags, body, importId };
}

async function submit() {
  if (busy || !snapshot || snapshot.restricted) return;
  const stateId = snapshot.stateId;
  if (stateId !== STATE.CONNECTED && stateId !== STATE.NO_WORKSPACE) return;
  const payload = collectPayload();
  busy = true;
  busyLabel = "正在剪藏…";
  render(currentPlan());
  const response = await send({
    type: "opennote:submit",
    mode: payload.mode,
    title: payload.title,
    folder: payload.folder,
    tags: payload.tags,
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
    folder: payload.folder,
    tags: payload.tags,
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
    const plan = planForState(STATE.SUCCESS, {
      folderLabel: reply.folderLabel || folderLabel(),
      noteTitle: reply.noteTitle || titleValue,
    });
    render(plan);
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => window.close(), 2000);
    return;
  }
  if (reply.status === "inbox") {
    const plan = planForState(STATE.CONNECTED);
    plan.block = { kind: "queued", message: reply.label, next: null, code: null };
    plan.actions = [{ id: "open-settings", label: "打开 Opennote", primary: true }];
    plan.primary = null;
    plan.preview = false;
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

async function pair(code) {
  const digits = String(code || "").replace(/[^0-9]/g, "");
  if (digits.length !== 6 || busy) return;
  busy = true;
  busyLabel = "正在连接…";
  render(planForState(STATE.NEEDS_PAIRING, { code: "IMP-2001" }));
  const response = await send({ type: "opennote:pair", code: digits });
  busy = false;
  const reply = response && response.reply;
  if (reply && reply.ok) {
    await load(true);
    return;
  }
  const code2 = (reply && reply.code) || "IMP-2004";
  const plan = planForState(code2 === "IMP-2004" ? STATE.NEEDS_PAIRING : (reply && reply.state) || STATE.NEEDS_PAIRING, {
    code: code2,
  });
  if (plan.block && reply && reply.label) plan.block.message = reply.label;
  render(plan);
}

async function connectToken(token) {
  const response = await send({ type: "opennote:set-token", token });
  const reply = response && response.reply;
  if (reply && reply.ok) {
    settingsOpen = false;
    await load(true);
    return;
  }
  render(planForState(STATE.TOKEN_INVALID, { code: "IMP-2002" }));
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
    case "pair":
      await pair("");
      break;
    case "open-settings":
    case "open-opennote":
      await send({ type: "opennote:open-settings" });
      window.close();
      break;
    case "open-options":
      settingsOpen = true;
      render(settingsPlan());
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
        notify("没有选中任何文字。在页面上选一段，或者切到「整页正文」。");
        break;
      }
      const existing = filterTags(tagsInput.value);
      if (!existing.includes(tag)) tagsInput.value = [...existing, tag].join(", ");
      tagsInput.dataset.touched = "1";
      render();
      break;
    }
    case "copy":
      await copyMarkdown();
      break;
    case "forget":
      await send({ type: "opennote:forget-token" });
      await load(true);
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
  if (next !== "selection" && next !== "page") return;
  mode = next;
  if (snapshot && snapshot.settings) snapshot.settings.mode = next;
  render();
}

function bindEvents() {
  segmented.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-mode]");
    if (button) setMode(button.dataset.mode);
  });
  segmented.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setMode(mode === "selection" ? "page" : "selection");
    const active = segmented.querySelector("button.is-active");
    if (active) active.focus();
  });

  primary.addEventListener("click", (event) => {
    if (event.target.closest(".spinner")) return;
    if (primary.dataset.intent === "stage") {
      void stage();
      return;
    }
    void submit();
  });

  for (const input of [folderInput, tagsInput]) {
    input.addEventListener("input", () => {
      input.dataset.touched = "1";
      if (input === folderInput) renderFolderOptions();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void submit();
      }
    });
  }

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
  if (response.settings && response.settings.mode) mode = response.settings.mode;
  if (!titleTouched) titleValue = "";
  if (response.settings) {
    if (!folderInput.dataset.touched) folderInput.value = response.settings.folder || "";
    if (!tagsInput.dataset.touched) tagsInput.value = (response.settings.tags || []).join(", ");
  }
  renderFolderOptions();
  render(currentPlan());
}

document.documentElement.setAttribute(
  "data-theme",
  window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "night" : "paper",
);
bindEvents();
void load();
