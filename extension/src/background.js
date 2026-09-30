/**
 * Opennote 剪藏扩展 · background service worker（MV3）。
 *
 * 职责：三条入口（浮标 / 右键菜单 / 快捷键）与 popup 都汇到同一个 `clipActiveTab()`；
 * 端口探测、令牌（㉞：长期令牌，不配对）、离线暂存队列、元素选择全部在这里收口，popup 只负责画界面。
 *
 * 安全：**所有桥调用都在 service worker 里发**（host_permissions 只给了 127.0.0.1 的
 * 8787–8796），页面里的脚本拿不到令牌；令牌只落 `chrome.storage.local`，绝不进 URL/日志。
 */

import { extractPage } from "./content/extract-page.js";
import { copyInPage } from "./content/clipboard.js";
import { highlightInPage } from "./content/highlight.js";
import {
  buildEnvelope,
  envelopeProblems,
  bodyByteLength,
  filterTags,
  newImportId,
  toLocalIso,
  MAX_BODY_BYTES,
} from "./lib/envelope.js";
import {
  BRIDGE_PORTS,
  discover,
  submitEnvelope,
  getImportStatus,
  getWorkspace,
  endpointOf,
  isValidToken,
} from "./lib/bridge.js";
import { readState, mutate } from "./lib/store.js";
// 元素选择失败原因（四因分离）的**单一文案来源**，popup 也从这里取（task-21）
import { pickFailCopy } from "./lib/pick.js";
import { makeQueueItem, enqueue, removeItem, markAttempt, takeBatch } from "./lib/queue.js";
import { STATE, decideState, planFor, busyPlan, stateForCode } from "./lib/state.js";
import { userMessage } from "./lib/errors.js";
import {
  applyTemplate,
  exportTemplates,
  importTemplates,
  matchTemplate,
  normalizeTemplate,
  PROPERTY_KEYS,
  renderTemplate,
  templateContext,
  templateOption,
  validateTemplate,
  withBuiltins,
} from "./lib/templates.js";
import {
  addHighlight,
  clearHighlights,
  countHighlights,
  defaultHighlights,
  highlightSection,
  HIGHLIGHTS_KEY,
  HIGHLIGHT_NOTE_MAX,
  listHighlights,
  normalizeUrl,
  removeHighlight,
  withHighlightSection,
} from "./lib/highlights.js";
import { TEMPLATES_KEY } from "./lib/templates.js";

/** API-03 只读探测：有效令牌 → 404 IMP-4017（令牌被接受），无效 → 401 IMP-2002。 */
const AUTH_PROBE_ID = "auth-probe-0000";
/** 浏览器内部页面：activeTab 也读不到（03 §UI-01/S5、FR-54）。 */
const RESTRICTED_RE =
  /^(chrome|edge|about|devtools|view-source|chrome-extension|edge-extension|moz-extension|opera|brave|vivaldi|chrome-untrusted|edge-untrusted|data|blob|filesystem):/i;

const EXTRACTION_TTL_MS = 30000;
const extractionCache = new Map(); // tabId → { at, data }

chrome.runtime.onInstalled.addListener(() => {
  installMenus();
  void flushQueue();
});

chrome.runtime.onStartup?.addListener(() => {
  void flushQueue();
});

chrome.tabs.onActivated.addListener(() => {
  void flushQueue();
});

/**
 * 右键菜单的最终形态（0.3.1，03 §UI-03 逐字冻结）：**只剩两项**。
 * - `高亮这段文字`：把选区记进本页高亮列表 —— 0.3.1 里浮标已删，高亮的入口改到右键菜单（UI-14「换入口」）；
 * - `剪藏整页正文到 Opennote`：整页剪藏保留。
 * **已删除**：`剪藏选中片段`（㉝：主路径改为元素选择）、浮标 UI-02 及其 `selectionchange`。
 */
function installMenus() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "opennote-highlight",
      title: "高亮这段文字",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: "opennote-clip-page",
      title: "剪藏整页正文到 Opennote",
      contexts: ["page"],
    });
  });
}

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "opennote-highlight") {
    void captureHighlight();
    return;
  }
  void clipFromChromeEntry("page", tab);
});

chrome.commands?.onCommand.addListener((command) => {
  // `Alt+Shift+S` 的语义由「剪藏选区」改为「进入元素选择模式」（00 §6.15㉝）
  if (command === "pick-element") void startPick();
  if (command === "clip-page") void clipFromChromeEntry("page", null);
});

/* ─────────────────────────── 基础工具 ─────────────────────────── */

export function isRestrictedUrl(url) {
  if (!url) return true;
  return RESTRICTED_RE.test(url);
}

export function folderLabelOf(folder) {
  return folder && String(folder).trim() ? String(folder).trim() : "根目录";
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}


/** 把注入错误整理成能给人看的原文（`name: message`，并保留 stack 供 console 自查）。 */
function describeError(error) {
  if (!error) return "Error: (没有错误对象)";
  const name = error.name || "Error";
  const message = error.message || String(error);
  return `${name}: ${message}`;
}

/**
 * 进入页面内元素选择模式（00 §6.15㉝；03 §UI-16；task-21 四因分离）。
 * - **`executeScript` 失败才是「不能选」的唯一证据**；URL 检查只是快速路径；
 * - URL **读不到**时不拒绝，照样尝试注入（`no_url` 只用于「连标签页都拿不到」）；
 * - 注入失败必须把 `chrome.scripting` 的真实原文回传并 `console.warn`，不得伪装成「页面类型不支持」。
 */
async function startPick() {
  const tab = await activeTab();
  if (!tab || !tab.id) {
    const detail = "chrome.tabs.query({active:true,currentWindow:true}) 没有返回可用标签页";
    console.warn(`[opennote] 元素选择：${detail}`);
    await mutate(() => ({ pickFailReason: "no_url", pickFailDetail: detail }));
    return { ok: false, code: "IMP-1006", reason: "no_url", detail, copy: pickFailCopy("no_url") };
  }
  const url = tab.url || "";
  if (url && isRestrictedUrl(url)) {
    // 快速路径：受限 scheme（chrome:// / 扩展商店 / file: / PDF 阅读器…）**不注入**
    await mutate(() => ({ pickFailReason: "restricted_scheme", pickFailDetail: `restricted url: ${url}` }));
    return { ok: false, code: "IMP-1006", reason: "restricted_scheme", detail: `restricted url: ${url}`, copy: pickFailCopy("restricted_scheme") };
  }
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/picker.js"] });
    if (!Array.isArray(results) || results.length === 0) throw new Error("executeScript 返回了空结果（脚本没有真正跑起来）");
  } catch (error) {
    const detail = describeError(error);
    console.warn(`[opennote] 元素选择注入失败：${detail}`, error);
    await mutate(() => ({ pickFailReason: "injection_failed", pickFailDetail: detail }));
    return { ok: false, code: "IMP-1006", reason: "injection_failed", detail, copy: pickFailCopy("injection_failed") };
  }
  await mutate(() => ({ pickUnsupported: false, pickFailReason: null, pickFailDetail: null, pickArmedAt: new Date().toISOString() }));
  return { ok: true };
}

/** 元素选择的结果落盘（`opennote.pendingSelection.v1`，03 §UI-16/S4 的回退路径也读它）。 */
async function rememberPicked(payload) {
  const tab = await activeTab();
  const entry = {
    ...payload,
    url: normalizeUrl((tab && tab.url) || ""),
    at: new Date().toISOString(),
  };
  await mutate(() => ({ picked: entry, pickArmedAt: null }));
  return entry;
}

/** 只看当前页的选择结果：URL 不同（换页了）就当没选过。 */
async function currentPicked(url) {
  const state = await readState();
  const entry = state.picked;
  if (!entry || !entry.picked) return null;
  if (normalizeUrl(url || "") !== entry.url) return null;
  return entry;
}

/** 三种正文来源（00 §6.15㉝ / 03 §UI-01 C64）：元素选择 / 整页正文 / 当前选区。 */
function normalizeMode(mode) {
  if (mode === "element" || mode === "page" || mode === "selection") return mode;
  return "selection";
}

/** 令牌本地格式（02 §5.2）：`opn_` + 43 位 base64url = 47 字符。 */
export const TOKEN_RE = /^opn_[A-Za-z0-9_-]{43}$/;

/** 保存令牌（㉞：长期有效，除用户在 Opennote 里重新生成外不失效）。 */
async function saveToken(token) {
  const value = String(token || "").trim();
  if (!TOKEN_RE.test(value)) return { ok: false, code: "IMP-2001", local: true };
  await mutate(() => ({ token: value, tokenSavedAt: new Date().toISOString() }));
  return { ok: true, tail: value.slice(-4) };
}

async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch {
    return false;
  }
}

/** 注入抽取脚本（自包含函数，见 content/extract-page.js 顶部注释）。 */
async function extractFromTab(tabId, rootSelector) {
  try {
    const injection = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractPage,
      args: [{ includeArticle: true, rootSelector: rootSelector || null }],
    });
    const result = injection && injection[0] && injection[0].result;
    if (!result || !result.ok) return null;
    return result;
  } catch {
    return null;
  }
}

/**
 * 从页面里按选择器抽「用户点中的那个元素及其子树」（00 §6.15㉝ / 03 §UI-16/S4）。
 * 抽不到就返回 null —— 调用方必须如实告知，不许静默成功。
 */
async function extractPickedElement(tabId, selector) {
  if (!selector) return null;
  const data = await extractFromTab(tabId, selector);
  if (!data || !data.article || !String(data.article.markdown || "").trim()) return null;
  return data.article;
}

async function getExtraction(tabId, options = {}) {
  const { force = false } = options;
  const cached = extractionCache.get(tabId);
  if (!force && cached && Date.now() - cached.at < EXTRACTION_TTL_MS) return cached.data;
  const data = await extractFromTab(tabId);
  if (data) extractionCache.set(tabId, { at: Date.now(), data });
  return data;
}

function resolveTitle(extraction, mode, userTitle, picked) {
  if (userTitle && String(userTitle).trim()) return String(userTitle).trim();
  if (mode === "element") {
    // 元素选择没有「文章标题」这个概念：用页面标题，用户在属性区可以改（C38）
    return extraction.pageTitle || "未命名剪藏";
  }
  if (mode === "selection") {
    return extraction.selection.ancestorTitle || extraction.pageTitle || "未命名剪藏";
  }
  return (extraction.article && extraction.article.title) || extraction.pageTitle || "未命名剪藏";
}

function resolveBody(extraction, mode, picked) {
  if (mode === "element") return (picked && picked.markdown) || "";
  if (mode === "selection") return extraction.selection.present ? extraction.selection.markdown : "";
  return (extraction.article && extraction.article.markdown) || "";
}

/* ───────────────── 模板 / 高亮（00 §6.14 ㉙㉚）：各占 chrome.storage.local 一个键 ───────────────── */

async function readTemplates() {
  try {
    const bag = await chrome.storage.local.get(TEMPLATES_KEY);
    const stored = bag && bag[TEMPLATES_KEY];
    const list = Array.isArray(stored) ? stored : [];
    return withBuiltins(list.map(normalizeTemplate));
  } catch {
    return withBuiltins([]);
  }
}

async function writeTemplates(templates) {
  const list = (Array.isArray(templates) ? templates : [])
    .filter((template) => !template.builtin && !String(template.id).startsWith("builtin-"))
    .map(normalizeTemplate);
  await chrome.storage.local.set({ [TEMPLATES_KEY]: list });
  return withBuiltins(list);
}

async function readHighlightStore() {
  try {
    const bag = await chrome.storage.local.get(HIGHLIGHTS_KEY);
    return (bag && bag[HIGHLIGHTS_KEY]) || defaultHighlights();
  } catch {
    return defaultHighlights();
  }
}

async function writeHighlightStore(store) {
  await chrome.storage.local.set({ [HIGHLIGHTS_KEY]: store });
  return store;
}

/** 模板变量上下文：只看抽取结果 + 高亮 + 元素选择结果，不发请求。 */
function templateCtxOf({ extraction, mode, items, picked }) {
  const selectionText = extraction.selection && extraction.selection.present ? extraction.selection.markdown : "";
  const articleText = (extraction.article && extraction.article.markdown) || "";
  const pickedText = (picked && picked.markdown) || "";
  return templateContext({
    title: resolveTitle(extraction, mode, "", picked),
    url: extraction.url,
    site: extraction.site,
    author: extraction.author,
    publishedAt: extraction.publishedAt,
    capturedAt: toLocalIso(new Date()),
    selection: selectionText,
    highlights: highlightSection(items),
    content:
      mode === "element" ? pickedText || articleText : mode === "page" ? articleText || selectionText : selectionText || articleText,
  });
}

/**
 * 挑选模板：显式 `templateId` 优先（`"none"` = 用户显式不使用模板）；
 * 否则按当前 URL 自动匹配（priority 降序，无命中用内置默认模板）。
 */
function pickTemplate(templates, url, templateId) {
  if (templateId === "none") return { template: null, matchedBy: null, tried: [], fallback: false };
  if (templateId) {
    const found = templates.find((template) => template.id === templateId);
    if (found) return { template: found, matchedBy: `explicit:${templateId}`, tried: [], fallback: false };
  }
  return matchTemplate(templates, url);
}

/** 属性面板 8 个字段的「没有模板、没有手改」时的兜底值（来自抽取结果）。 */
function basePropValue(key, extraction) {
  switch (key) {
    case "source.url":
      return extraction.url || "";
    case "source.title":
      return extraction.pageTitle || "";
    case "source.site":
      return extraction.site || "";
    case "author":
      return extraction.author || "";
    case "publishedAt":
      return extraction.publishedAt || "";
    default:
      return "";
  }
}

function emptyApplied(extraction, mode) {
  return {
    templateId: null,
    templateName: null,
    behavior: "new",
    title: "",
    folder: "",
    tags: [],
    notePath: "",
    conflict: null,
    properties: {},
    bodyFormat: "",
    notes: [],
  };
}

/**
 * 把「模板 + 用户手改 + 高亮」合成一次交付意图。popup 的预览与真正提交**共用**这一条路径，
 * 所以界面上看到的就是会发出去的（不会出现「显示一套、发另一套」）。
 * `overrides.props` / `overrides.dirty.props` = 属性面板的 8 个字段（㉘）。
 */
function composeDelivery({ extraction, mode, items, templates, overrides = {}, pickedElement = null }) {
  const picked = pickTemplate(templates, extraction.url, overrides.templateId);
  const ctx = templateCtxOf({ extraction, mode, items, picked: pickedElement });
  const dirty = overrides.dirty || {};
  const propDirty = dirty.props && typeof dirty.props === "object" ? dirty.props : {};
  const propInput = overrides.props && typeof overrides.props === "object" ? overrides.props : {};
  const applied = picked.template ? applyTemplate(picked.template, ctx) : emptyApplied(extraction, mode);

  const props = {};
  for (const key of PROPERTY_KEYS) {
    if (propDirty[key]) {
      props[key] = key === "tags" ? String(propInput[key] || "") : String(propInput[key] === undefined || propInput[key] === null ? "" : propInput[key]);
      continue;
    }
    if (applied.properties && applied.properties[key] !== undefined) {
      props[key] = applied.properties[key];
      continue;
    }
    if (key === "title") props[key] = applied.title || resolveTitle(extraction, mode, "", pickedElement);
    else if (key === "tags") props[key] = (applied.tags || []).join(", ");
    else if (key === "target.folder") props[key] = applied.folder || "";
    else props[key] = basePropValue(key, extraction);
  }

  const title = String(props.title || "").trim() || resolveTitle(extraction, mode, "", pickedElement);
  const folder = String(props["target.folder"] || "");
  const tags = filterTags(props.tags);
  const notePath = (dirty.notePath ? overrides.notePath : applied.notePath) || "";
  // `notePath` 只在 `conflict: "append"` 时有效（02 §2.4）；空 → 不下发 conflict（交给判定链／应用侧收件箱设置）。
  const conflict = notePath ? "append" : applied.conflict || null;

  return { picked, ctx, applied, props, title, folder, tags, notePath, conflict };
}

function buildClipEnvelope({ extraction, mode, title, props = {}, folder, tags, importId, version, notePath, conflict, items, bodyFormat, pickedElement = null }) {
  const base = resolveBody(extraction, mode, pickedElement);
  const ctx = templateCtxOf({ extraction, mode, items: items || [], picked: pickedElement });
  // 模板 `bodyFormat` 是可选附加字段（㉙ 的模型里没有它，见 lib/templates.js 顶部说明）：
  // 给了就由模板组装正文骨架，没给就沿用抽取结果本身。
  const body = bodyFormat ? renderTemplate(bodyFormat, { ...ctx, content: ctx.content || base }) || base : base;
  return buildEnvelope({
    importId: importId || newImportId(),
    title,
    // 高亮作为 body 的一部分一起提交（㉚）；没有高亮时不生成小节。
    body: withHighlightSection(body, items || []),
    url: props["source.url"] || extraction.url,
    pageTitle: props["source.title"] || extraction.pageTitle,
    site: props["source.site"] || extraction.site,
    author: props.author || extraction.author,
    publishedAt: props.publishedAt || extraction.publishedAt,
    capturedAt: toLocalIso(new Date()),
    // `source.selection` 是判定输入（02 §4.1 第 3/4 步），必须如实反映剪藏范围。
    // 高亮**不**参与这里：它只是正文的一部分（00 §6.14 ㉚）。
    selection: mode === "selection",
    folder,
    tags,
    notePath: notePath || null,
    conflict: conflict || null,
    version,
  });
}

/* ─────────────────────── 探测 → 状态 → 视图 ─────────────────────── */

export async function probeAndPlan() {
  const state = await readState();
  const probe = await discover({ preferredPort: state.port, ports: BRIDGE_PORTS });
  let authCode = null;
  let workspace = null;
  let defaultFolder = null;
  // 交付方式（API-01 的 `inbox` 布尔；02 §5.2）：true = 先进收件箱，false = 直接入库，
  // 字段缺失或不是布尔（旧版桥）= 判断不出来。popup 只**如实显示**，不做假开关（03 §UI-01 S25）。
  let inbox = undefined;

  if (probe.hit) {
    workspace = (probe.hit.health && probe.hit.health.workspace) || null;
    if (probe.hit.health && typeof probe.hit.health.inbox === "boolean") inbox = probe.hit.health.inbox;
    if (state.token) {
      const call = await getImportStatus(probe.hit.port, state.token, AUTH_PROBE_ID);
      if (call.kind === "ok" || call.code === "IMP-4017" || call.code === "IMP-3005") {
        authCode = null;
      } else if (call.kind === "error" || call.kind === "timeout") {
        authCode = call.code;
      }
      const ws = await getWorkspace(probe.hit.port, state.token);
      if (ws && typeof ws.defaultFolder === "string" && ws.defaultFolder) defaultFolder = ws.defaultFolder;
    }
  }

  const stateId = decideState({
    probe,
    online: navigator.onLine,
    token: state.token,
    pendingCount: state.pending.length,
    authCode,
  });

  // 桥通了但没打开笔记本：芯片必须仍是「本地接口已开启」，用独立错误块显示 IMP-4007。
  let planState = stateId;
  if (stateId === STATE.CONNECTED && workspace && workspace.open === false) {
    planState = STATE.NO_WORKSPACE;
  }
  const plan = planFor(planState, {
    pendingCount: state.pending.length,
    folderLabel: folderLabelOf(state.folder),
  });

  if (probe.hit && state.port !== probe.hit.port) {
    await mutate(() => ({
      port: probe.hit.port,
      endpoint: endpointOf(probe.hit.port, ""),
      lastOkAt: new Date().toISOString(),
    }));
  } else if (probe.hit) {
    await mutate(() => ({ lastOkAt: new Date().toISOString() }));
  }

  return {
    stateId,
    planState,
    plan,
    probe,
    workspace,
    defaultFolder,
    inbox,
    stored: state,
    pendingCount: state.pending.length,
  };
}

/* ─────────────────────── 离线暂存与补投 ─────────────────────── */

async function stageOffline({ envelope, folderLabel, noteTitle, mode, code, port, token }) {
  const state = await readState();
  const item = makeQueueItem({
    envelope,
    endpoint: port ? endpointOf(port, "") : null,
    token: token || state.token,
    port: port || null,
    folderLabel,
    noteTitle,
    mode,
    // 入队原因如实记下契约 code（IMP-1001 / IMP-4006 / IMP-5001 …），排障时能看到。
    reason: code || "IMP-1001",
  });
  const result = enqueue(state.pending, item);
  if (!result.ok) {
    // 队列放不下（chrome.storage 配额）——**不许静默丢弃**，让 popup 走「复制到剪贴板」降级。
    return {
      status: "error",
      code: "IMP-5001",
      label: "内容没能暂存到插件里。请用「复制 Markdown」把正文带走，或打开 Opennote 后重新剪藏。",
      state: STATE.CONNECTED,
      needManualCopy: true,
      folderLabel,
      noteTitle,
    };
  }
  await mutate(() => ({ pending: result.queue }));
  return {
    status: "queued",
    code: code || "IMP-1001",
    label: "已暂存",
    state: STATE.QUEUED_OFFLINE,
    pendingCount: result.queue.length,
    evicted: result.evicted.length,
    folderLabel,
    noteTitle,
  };
}

export async function flushQueue(options = {}) {
  const { limit = 3 } = options;
  const state = await readState();
  if (!state.pending.length) return { flushed: 0, remaining: 0 };
  if (!state.token) return { flushed: 0, remaining: state.pending.length, reason: "IMP-2001" };
  const probe = await discover({ preferredPort: state.port, ports: BRIDGE_PORTS });
  if (!probe.hit) return { flushed: 0, remaining: state.pending.length, reason: probe.noWindow ? "IMP-4006" : "IMP-1001" };

  let queue = state.pending;
  let flushed = 0;
  for (const item of takeBatch(queue, limit)) {
    const call = await submitEnvelope(probe.hit.port, state.token, item.envelope, { attempts: 1 });
    if (call.kind === "ok") {
      queue = removeItem(queue, item.importId);
      flushed += 1;
    } else {
      queue = markAttempt(queue, item.importId, call.code);
      break; // 失败即停：不空转重试
    }
  }
  if (flushed > 0) {
    await mutate(() => ({
      pending: queue,
      port: probe.hit.port,
      endpoint: endpointOf(probe.hit.port, ""),
      lastOkAt: new Date().toISOString(),
    }));
  } else {
    await mutate(() => ({ pending: queue }));
  }
  return { flushed, remaining: queue.length };
}

/* ─────────────────────────── 提交 ─────────────────────────── */

/** 追加落点历史（API-07 不返回笔记清单，只能靠成功回执的 path 攒）。 */
function rememberNotePath(list, path) {
  const clean = String(path || "").trim();
  const current = (Array.isArray(list) ? list : []).filter((item) => typeof item === "string" && item);
  if (!clean) return current.slice(0, 20);
  return [clean, ...current.filter((item) => item !== clean)].slice(0, 20);
}

async function deliver({ envelope, folderLabel, noteTitle, mode, templateName = null, templateNotes = [], conflict = null, notePath = "", highlightCount = 0 }) {
  const state = await readState();
  const probe = await discover({ preferredPort: state.port, ports: BRIDGE_PORTS });

  if (!probe.hit) {
    const code = probe.noWindow
      ? "IMP-4006"
      : probe.portBusy || probe.sawListener
        ? "IMP-1003"
        : "IMP-1001";
    return stageOffline({ envelope, folderLabel, noteTitle, mode, code, port: null, token: state.token });
  }
  if (!state.token) {
    return {
      status: "error",
      code: "IMP-2001",
      label: userMessage("IMP-2001"),
      state: STATE.NEEDS_PAIRING,
      folderLabel,
      noteTitle,
    };
  }

  const call = await submitEnvelope(probe.hit.port, state.token, envelope);
  if (call.kind === "ok") {
    const result = call.result || {};
    await mutate((prev) => ({
      port: probe.hit.port,
      endpoint: endpointOf(probe.hit.port, ""),
      lastOkAt: new Date().toISOString(),
      notePaths: rememberNotePath(prev.notePaths, result.path),
    }));
    const status = result.status || "created";
    if (status === "pending") {
      // 进收件箱：应用侧「先进入收件箱」命中（00 §6.14 ㉕），或判定链第 4 步。
      // 这不是失败，也不是「已经写进笔记」——按回执如实显示 pending（popup 用冻结文案）。
      return {
        status: "pending",
        code: null,
        label: "已进入收件箱等待确认",
        state: STATE.INBOX_PENDING,
        inboxId: result.inboxId || null,
        serverStatus: status,
        folderLabel,
        noteTitle,
        templateName,
        templateNotes,
        conflict,
        notePath: notePath || null,
        highlightCount,
      };
    }
    return {
      status: "created",
      code: null,
      label: "已剪藏",
      state: STATE.CONNECTED,
      path: result.path || null,
      serverStatus: status,
      deduped: Boolean(result.deduped),
      tags: Array.isArray(result.tags) ? result.tags : envelope.tags,
      warnings: Array.isArray(result.warnings) ? result.warnings : [],
      folderLabel,
      noteTitle,
      templateName,
      templateNotes,
      conflict,
      notePath: notePath || null,
      highlightCount,
    };
  }

  const code = call.code;
  const message = userMessage(code, call.serverMessage);

  if (code === "IMP-2001" || code === "IMP-2002" || code === "IMP-3001") {
    // 401/403：令牌无效，或来源不是扩展/本机程序（㉞：来源判据按类型，不再有配对）。清掉令牌，回令牌输入块。
    if (code !== "IMP-3001") await mutate(() => ({ token: null }));
    return {
      status: "error",
      code,
      label: message,
      state: stateForCode(code),
      folderLabel,
      noteTitle,
    };
  }

  if (["IMP-1001", "IMP-1004", "IMP-4006", "IMP-5001"].includes(code)) {
    return stageOffline({ envelope, folderLabel, noteTitle, mode, code, port: probe.hit.port, token: state.token });
  }

  return {
    status: "error",
    code,
    label: message,
    state: stateForCode(code),
    folderLabel,
    noteTitle,
  };
}

/**
 * 右键菜单 / 快捷键入口（0.3.1 只剩「整页剪藏」）。
 * 页面内的药丸反馈随浮标一起删除（00 §6.15㉝）：入口不再注入任何东西到页面里，
 * 结果如实落在 `chrome.action` 的徽标上（成功/暂存/失败各一个数字），失败时打开 popup 说明原因。
 */
async function clipFromChromeEntry(mode, tab) {
  const target = tab && tab.id !== undefined ? tab : await activeTab();
  if (!target || target.id === undefined) return { status: "restricted", code: "IMP-1006" };
  if (isRestrictedUrl(target.url)) {
    return { status: "restricted", code: "IMP-1006", label: "这个页面不允许插件读取内容。" };
  }
  const reply = await clipActiveTab({ mode, tabId: target.id, arm: false });
  const badge = reply.status === "pending" ? "1" : reply.status === "queued" ? String(reply.pendingCount || 1) : "";
  try {
    await chrome.action.setBadgeText({ tabId: target.id, text: badge });
    if (badge) await chrome.action.setBadgeBackgroundColor({ color: "#8c2f24" });
  } catch {
    /* 徽标不是关键路径 */
  }
  if (reply.status === "error" && reply.code) void openPopup();
  return reply;
}

async function openPopup() {
  try {
    if (chrome.action && typeof chrome.action.openPopup === "function") {
      await chrome.action.openPopup();
      return true;
    }
  } catch {
    // 打开失败不是错误：页面里的提示条会如实告诉用户点扩展图标（C07）
  }
  return false;
}

/**
 * 主流程：抽取 → 建信封 → 投递（或暂存）。
 * @param {{mode:"selection"|"page", overrides?:object, tabId?:number}} input
 */
export async function clipActiveTab(input) {
  const { mode = "selection", overrides = {}, tabId = null } = input || {};
  const tab = tabId !== null && tabId !== undefined ? await chrome.tabs.get(tabId).catch(() => null) : await activeTab();
  if (!tab || tab.id === undefined || isRestrictedUrl(tab.url)) {
    return { status: "restricted", code: "IMP-1006", label: "这个页面不允许插件读取内容。", state: STATE.RESTRICTED_PAGE };
  }
  const extraction = await getExtraction(tab.id, { force: Boolean(overrides.force) });
  if (!extraction) {
    return { status: "restricted", code: "IMP-1006", label: "这个页面不允许插件读取内容。", state: STATE.RESTRICTED_PAGE };
  }

  const state = await readState();
  const templates = await readTemplates();
  const items = listHighlights(await readHighlightStore(), extraction.url);
  const composed = composeDelivery({ extraction, mode, items, templates, overrides });

  // 属性面板里手改的「网址」必须是真的 http(s)：@link buildEnvelope 会把非法 URL 静默归一成 null，
  // 这里提前拦住并如实报 IMP-4003，不让它变成「看起来剪藏成功、实际没有来源」。
  const typedUrl = composed.props ? String(composed.props["source.url"] || "").trim() : "";
  if (overrides.dirty && overrides.dirty.props && overrides.dirty.props["source.url"] && typedUrl && !/^https?:\/\//i.test(typedUrl)) {
    return {
      status: "error",
      code: "IMP-4003",
      label: userMessage("IMP-4003"),
      detail: "属性面板里的「网址」必须是 http(s):// 开头",
      state: STATE.CONNECTED,
    };
  }

  const envelope = buildClipEnvelope({
    extraction,
    mode,
    title: composed.title || resolveTitle(extraction, mode, ""),
    props: composed.props,
    folder: composed.folder,
    tags: composed.tags,
    notePath: composed.notePath,
    conflict: composed.conflict,
    items,
    bodyFormat: composed.applied.bodyFormat,
    importId: overrides.importId,
    version: chrome.runtime.getManifest().version,
  });

  const problems = envelopeProblems(envelope);
  if (problems.length) {
    return {
      status: "error",
      code: "IMP-4003",
      label: userMessage("IMP-4003"),
      detail: problems.join("；"),
      state: STATE.CONNECTED,
    };
  }
  if (bodyByteLength(envelope.body) > MAX_BODY_BYTES) {
    // 不截断用户原文（02 §2.6）——如实拒绝并给复制降级。
    return {
      status: "error",
      code: "IMP-4004",
      label: userMessage("IMP-4004"),
      state: STATE.CONNECTED,
      needManualCopy: true,
    };
  }

  await mutate(() => ({ folder: composed.folder || "", tags: composed.tags, mode }));
  return deliver({
    envelope,
    folderLabel: folderLabelOf(composed.folder),
    noteTitle: envelope.title,
    mode,
    templateName: composed.applied.templateName,
    templateNotes: composed.applied.notes || [],
    conflict: composed.conflict,
    notePath: composed.notePath,
    highlightCount: items.length,
  });
}

/* ─────────────────────────── 令牌（㉞：配对整体删除） ─────────────────────────── */

/**
 * `POST /v1/pair` 与 6 位配对码在 0.3.1 全部删除（00 §6.15㉞）。
 * 客户端只做一件事：**粘贴长期令牌**（`opn_` + 43 位 base64url = 47 字符），存 `chrome.storage.local`。
 * `IMP-2004`（配对码错误）保留码号但**不再产出**。
 */
async function storeManualToken(token) {
  const value = String(token || "").trim();
  if (!isValidToken(value)) {
    return { ok: false, code: "IMP-2002", label: userMessage("IMP-2002"), state: STATE.TOKEN_INVALID };
  }
  const state = await readState();
  const probe = await discover({ preferredPort: state.port, ports: BRIDGE_PORTS });
  const port = probe.hit ? probe.hit.port : state.port;
  await mutate(() => ({
    token: value,
    port,
    endpoint: port ? endpointOf(port, "") : null,
    lastOkAt: new Date().toISOString(),
  }));
  return { ok: true, code: null, port };
}

/* ─────────────────────── popup / 页面消息路由 ─────────────────────── */

async function loadSnapshot() {
  await flushQueue({ limit: 2 });
  const tab = await activeTab();
  // task-21 四因分离：`restricted`（受限 scheme）与 `extractionFailed`（抽取失败）**是两件事**，
  // 不再把它们合并成同一句「只有普通网页支持」。
  const snapshot = { ok: true, tab: null, extraction: null, restricted: false, extractionFailed: false, pickFailReason: null };
  if (!tab || tab.id === undefined) {
    snapshot.restricted = true;
    snapshot.pickFailReason = "no_url";
  } else {
    snapshot.tab = { id: tab.id, url: tab.url || null, title: tab.title || null };
    // URL 读不到（没有 tabs 权限且 activeTab 未授予）**不等于**受限页面：如实记成 no_url
    if (!tab.url) snapshot.pickFailReason = "no_url";
    snapshot.restricted = Boolean(tab.url) && isRestrictedUrl(tab.url);
    if (snapshot.restricted) snapshot.pickFailReason = "restricted_scheme";
    if (!snapshot.restricted) {
      const extraction = await getExtraction(tab.id, { force: true });
      if (extraction) {
        snapshot.extraction = extraction;
        // 0.3.1：popup 打开**不再**往页面里注入任何东西（浮标已删除，㉝）。
        // 元素选择只在用户真的点了「选择页面元素」时才注入覆盖层。
      } else {
        // 抽取失败 ≠ 页面类型不支持（task-21）：如实标成 extraction_failed，
        // 面板走「没能从这个页面读到正文…」而不是「只有普通网页支持」。
        snapshot.extractionFailed = true;
        snapshot.pickFailReason = snapshot.pickFailReason || "extraction_failed";
      }
    }
  }

  const probed = await probeAndPlan();
  let plan = probed.plan;
  let stateId = probed.planState;
  if (snapshot.restricted) {
    stateId = STATE.RESTRICTED_PAGE;
    plan = planFor(STATE.RESTRICTED_PAGE, { pendingCount: probed.pendingCount });
  }

  // 三区需要的数据：模板清单 + 当前页高亮 + 追加落点历史（都是扩展侧本地数据）
  const templates = await readTemplates();
  const matched = matchTemplate(templates, snapshot.tab ? snapshot.tab.url : "");
  const highlightStore = await readHighlightStore();
  const highlightItems = listHighlights(highlightStore, snapshot.tab ? snapshot.tab.url : "");
  const pickedForTab = await currentPicked(snapshot.tab ? snapshot.tab.url : "");

  return {
    ...snapshot,
    stateId,
    plan,
    workspace: probed.workspace,
    defaultFolder: probed.defaultFolder,
    // 交付方式（API-01 的 `inbox`）：true / false / undefined（判断不出来）——popup 如实显示
    inbox: probed.inbox,
    templates: templates.map((template) => templateOption(template, { builtin: Boolean(template.builtin) })),
    templateMatchedId: matched.template ? matched.template.id : null,
    templateMatchedBy: matched.matchedBy,
    templateFallback: Boolean(matched.fallback),
    // 元素选择（㉝）：本页是否已选过、以及选择模式是否正在页面上等待点选（S26/S29）
    pickedElement: pickedForTab
      ? {
          tagName: pickedForTab.tagName || "",
          selector: pickedForTab.selector || "",
          chars: pickedForTab.chars || 0,
          isIframe: Boolean(pickedForTab.isIframe),
        }
      : null,
    pickArmed: Boolean(probed.stored.pickArmedAt),
    pickUnsupported: Boolean(probed.stored.pickUnsupported),
    highlights: highlightItems,
    highlightCount: highlightItems.length,
    highlightTotal: countHighlights(highlightStore),
    settings: {
      folder: probed.stored.folder || "",
      tags: probed.stored.tags || [],
      mode: probed.stored.mode || "selection",
      hasToken: Boolean(probed.stored.token),
      port: probed.stored.port || null,
      endpoint: probed.stored.endpoint || null,
      pendingCount: probed.pendingCount,
      notePaths: Array.isArray(probed.stored.notePaths) ? probed.stored.notePaths : [],
    },
  };
}

/**
 * 浮标「高亮」路径（00 §6.14 ㉚）：注入 `content/highlight.js` 采集选区 →
 * 按 URL 分组存 `chrome.storage.local`。不改变任何既有笔记，也不影响 `source.selection`。
 */
async function captureHighlight() {
  const tab = await activeTab();
  if (!tab || tab.id === undefined || isRestrictedUrl(tab.url)) {
    return { ok: false, label: "这个页面不允许插件读取内容。", code: "IMP-1006", state: STATE.RESTRICTED_PAGE };
  }
  let result = null;
  try {
    const injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: highlightInPage,
      args: [{ color: "" }],
    });
    result = injection && injection[0] && injection[0].result;
  } catch {
    result = null;
  }
  if (!result || !result.ok) {
    const label = !result
      ? "这个页面不允许插件读取内容。"
      : result.reason === "empty-text"
        ? "选中的内容为空，没有可高亮的文字。"
        : "没有选中任何文字。在页面上选一段，再点「高亮」。";
    return { ok: false, label, code: result ? null : "IMP-1006" };
  }
  const url = result.url || tab.url;
  const added = addHighlight(await readHighlightStore(), {
    url,
    title: result.title || tab.title,
    text: result.text,
    selector: result.selector,
    color: result.color,
    createdAt: result.capturedAt,
  });
  await writeHighlightStore(added.store);
  return {
    ok: true,
    added: added.added,
    reason: added.reason,
    item: added.item,
    count: listHighlights(added.store, url).length,
    total: countHighlights(added.store),
  };
}

async function copyViaPage(text) {
  const tab = await activeTab();
  if (!tab || tab.id === undefined || isRestrictedUrl(tab.url)) return false;
  try {
    const injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: copyInPage,
      args: [String(text || "")],
    });
    return Boolean(injection && injection[0] && injection[0].result);
  } catch {
    return false;
  }
}

async function handle(message) {
  switch (message && message.type) {
    case "opennote:load":
      return loadSnapshot();
    case "opennote:retry":
      return { ok: true, ...(await loadSnapshot()) };
    case "opennote:submit": {
      const reply = await clipActiveTab({
        mode: message.mode,
        overrides: {
          title: message.title,
          folder: message.folder,
          tags: message.tags,
          notePath: message.notePath,
          templateId: message.templateId,
          dirty: message.dirty,
          props: message.props,
          importId: message.importId,
        },
      });
      return { ok: true, reply };
    }
    case "opennote:preview": {
      // 「界面上看到的就是会发出去的」：预览与提交共用 composeDelivery（不各自算一套）。
      const tab = await activeTab();
      if (!tab || tab.id === undefined || isRestrictedUrl(tab.url)) {
        return { ok: true, preview: null, restricted: true };
      }
      const extraction = await getExtraction(tab.id, { force: Boolean(message.force) });
      if (!extraction) return { ok: true, preview: null, restricted: true };
      const mode = normalizeMode(message.mode);
      const templates = await readTemplates();
      const store = await readHighlightStore();
      const items = listHighlights(store, extraction.url);
      const pickedElement = await currentPicked(extraction.url);
      const composed = composeDelivery({
        extraction,
        mode,
        items,
        templates,
        pickedElement,
        overrides: {
          title: message.title,
          folder: message.folder,
          tags: message.tags,
          notePath: message.notePath,
          templateId: message.templateId,
          dirty: message.dirty,
          props: message.props,
        },
      });
      return {
        ok: true,
        preview: {
          mode,
          title: composed.title,
          folder: composed.folder,
          tags: composed.tags,
          notePath: composed.notePath,
          conflict: composed.conflict,
          props: composed.props,
          templateId: composed.applied.templateId,
          templateName: composed.applied.templateName,
          templateMatchedBy: composed.picked.matchedBy,
          templateFallback: Boolean(composed.picked.fallback),
          properties: composed.applied.properties,
          notes: composed.applied.notes,
          highlightCount: items.length,
          body: highlightSection(items),
          source: {
            url: extraction.url,
            pageTitle: extraction.pageTitle,
            site: extraction.site,
            author: extraction.author,
            publishedAt: extraction.publishedAt,
            title: resolveTitle(extraction, mode, "", pickedElement),
            selectionPresent: Boolean(extraction.selection && extraction.selection.present),
          },
          // 元素选择（㉝）：popup 用 tagName 显示 `已选择 {标签名}`（C65）
          pickedElement: pickedElement
            ? {
                tagName: pickedElement.tagName || "",
                selector: pickedElement.selector || "",
                width: pickedElement.rect ? pickedElement.rect.width : null,
                height: pickedElement.rect ? pickedElement.rect.height : null,
                isIframe: Boolean(pickedElement.isIframe),
                markdown: pickedElement.markdown || "",
              }
            : null,
        },
      };
    }
    case "opennote:highlight-now": {
      return { ok: true, reply: await captureHighlight() };
    }
    case "opennote:highlights": {
      const tab = await activeTab();
      const url = message.url || (tab && tab.url) || "";
      const store = await readHighlightStore();
      return {
        ok: true,
        url: normalizeUrl(url),
        items: listHighlights(store, url),
        total: countHighlights(store),
      };
    }
    case "opennote:highlight-update": {
      // 批注 / 底色两档（03 §UI-14 S10/S16）：只改这一条的 note/color，其余字段不动。
      const tab = await activeTab();
      const url = message.url || (tab && tab.url) || "";
      const store = await readHighlightStore();
      const key = normalizeUrl(url);
      const group = store.groups[key];
      if (!group) return { ok: false, code: "IMP-4003", label: "找不到这条高亮。" };
      const items = group.items.map((item) => {
        if (item.id !== message.id) return item;
        const next = { ...item, note: String(message.note || "").slice(0, HIGHLIGHT_NOTE_MAX) };
        // 历史值（red/green/blue/purple）原样保留；只有明确点两档时才改写
        if (message.color === "yellow" || message.color === "accent") next.color = message.color;
        return next;
      });
      const nextStore = { spec: store.spec, groups: { ...store.groups, [key]: { ...group, items, updatedAt: new Date().toISOString() } } };
      await writeHighlightStore(nextStore);
      return { ok: true, items: listHighlights(nextStore, url) };
    }
    case "opennote:highlight-remove": {
      const tab = await activeTab();
      const url = message.url || (tab && tab.url) || "";
      const result = removeHighlight(await readHighlightStore(), url, message.id);
      await writeHighlightStore(result.store);
      return { ok: true, removed: result.removed, items: listHighlights(result.store, url) };
    }
    case "opennote:highlight-clear": {
      const tab = await activeTab();
      const url = message.url || (tab && tab.url) || "";
      const result = clearHighlights(await readHighlightStore(), url);
      await writeHighlightStore(result.store);
      return { ok: true, cleared: result.cleared, items: [] };
    }
    case "opennote:templates": {
      const templates = await readTemplates();
      const url = message.url || (await activeTab())?.url || "";
      const picked = matchTemplate(templates, url);
      return {
        ok: true,
        templates: templates.map((template) => templateOption(template, { builtin: Boolean(template.builtin) })),
        matchedId: picked.template ? picked.template.id : null,
        matchedBy: picked.matchedBy,
        fallback: Boolean(picked.fallback),
        tried: picked.tried,
      };
    }
    case "opennote:template-save": {
      const problems = validateTemplate(message.template);
      if (problems.length) return { ok: false, code: "IMP-4003", detail: problems, label: problems[0] };
      const templates = await readTemplates();
      const next = templates
        .filter((template) => !template.builtin)
        .filter((template) => template.id !== message.template.id)
        .concat([normalizeTemplate(message.template)]);
      await writeTemplates(next);
      return { ok: true, templates: (await readTemplates()).map((template) => templateOption(template, { builtin: Boolean(template.builtin) })) };
    }
    case "opennote:template-delete": {
      const templates = await readTemplates();
      await writeTemplates(templates.filter((template) => template.id !== message.id && !template.builtin));
      return { ok: true, templates: (await readTemplates()).map((template) => templateOption(template, { builtin: Boolean(template.builtin) })) };
    }
    case "opennote:template-export": {
      const templates = await readTemplates();
      return { ok: true, json: exportTemplates(templates.filter((template) => !template.builtin), { includeBuiltins: false }) };
    }
    case "opennote:template-import": {
      const result = importTemplates(message.json);
      if (!result.templates.length) {
        return { ok: false, code: "IMP-4003", detail: result.problems, label: result.problems[0] || "导入内容里没有可用模板" };
      }
      const templates = await readTemplates();
      const merged = templates
        .filter((template) => !template.builtin && !result.templates.some((item) => item.id === template.id))
        .concat(result.templates);
      await writeTemplates(merged);
      return {
        ok: true,
        imported: result.templates.length,
        problems: result.problems,
        templates: (await readTemplates()).map((template) => templateOption(template, { builtin: Boolean(template.builtin) })),
      };
    }
    case "opennote:stage": {
      const reply = await clipActiveTab({
        mode: message.mode,
        overrides: {
          title: message.title,
          folder: message.folder,
          tags: message.tags,
          notePath: message.notePath,
          templateId: message.templateId,
          dirty: message.dirty,
          props: message.props,
          importId: message.importId,
        },
      });
      if (reply.status === "queued") return { ok: true, reply };
      // 已经在线：显式暂存也要落到队列里（用户点的是「暂存在插件里」）。
      const tab = await activeTab();
      const extraction = tab && tab.id !== undefined ? await getExtraction(tab.id) : null;
      if (!extraction) return { ok: true, reply };
      const templates = await readTemplates();
      const items = listHighlights(await readHighlightStore(), extraction.url);
      const composed = composeDelivery({
        extraction,
        mode: message.mode,
        items,
        templates,
        overrides: {
          title: message.title,
          folder: message.folder,
          tags: message.tags,
          notePath: message.notePath,
          templateId: message.templateId,
          dirty: message.dirty,
          props: message.props,
        },
      });
      const envelope = buildClipEnvelope({
        extraction,
        mode: message.mode,
        title: composed.title || resolveTitle(extraction, message.mode, ""),
        props: composed.props,
        folder: composed.folder,
        tags: composed.tags,
        notePath: composed.notePath,
        conflict: composed.conflict,
        items,
        bodyFormat: composed.applied.bodyFormat,
        importId: message.importId,
        version: chrome.runtime.getManifest().version,
      });
      return {
        ok: true,
        reply: await stageOffline({
          envelope,
          folderLabel: folderLabelOf(composed.folder),
          noteTitle: envelope.title,
          mode: message.mode,
          code: "IMP-1001",
        }),
      };
    }
    case "opennote:pick":
      return { ok: true, reply: await startPick() };
    case "opennote:pick-cancelled":
      await mutate(() => ({ pickArmedAt: null }));
      return { ok: true };
    case "opennote:element-picked": {
      // 内容脚本（content/picker.js）在用户点选后回报：这里把「元素及子树」抽成 Markdown 落盘。
      if (!message.picked) {
        await mutate(() => ({ pickArmedAt: null, picked: null }));
        return { ok: true, reply: { picked: false, reason: message.reason || "html-or-empty" } };
      }
      const tab = await activeTab();
      if (!tab || !tab.id) return { ok: false, code: "IMP-1006" };
      const article = await extractPickedElement(tab.id, message.selector);
      if (!article) {
        // 如实失败：不写一条空的选择结果假装成功（03 §UI-16 的「不许静默失败」）
        return { ok: true, reply: { picked: false, reason: "extract-empty" } };
      }
      const entry = await rememberPicked({
        picked: true,
        tagName: message.tagName || "",
        selector: message.selector || "",
        rect: message.rect || null,
        isIframe: Boolean(message.isIframe),
        markdown: article.markdown,
        chars: article.chars,
      });
      // UI-16/S4：先试 `chrome.action.openPopup()`；打不开就让页面里的影子根显示一次性提示条（C07），
      // **不得**假装 popup 已经打开（那是死按钮的翻版）。
      const opened = await openPopup();
      return { ok: true, reply: { picked: true, tagName: entry.tagName, chars: entry.chars, needToast: !opened } };
    }
    case "opennote:set-token":
      return { ok: true, reply: await storeManualToken(message.token) };
    case "opennote:forget-token":
      await mutate(() => ({ token: null }));
      return { ok: true, reply: { ok: true } };
    case "opennote:flush":
      return { ok: true, reply: await flushQueue({ limit: 5 }) };
    case "opennote:copy-in-page":
      return { ok: true, copied: await copyViaPage(message.text) };
    case "opennote:open-settings":
      // API-11：`opennote://settings/import`（P0，插件引导用）
      await chrome.tabs.create({ url: "opennote://settings/import" });
      return { ok: true };
    case "opennote:open-note": {
      const path = message.path ? `?path=${encodeURIComponent(message.path)}` : "";
      await chrome.tabs.create({ url: `opennote://open${path}` }); // API-12（P1）
      return { ok: true };
    }
    case "opennote:open-popup":
      await openPopup();
      return { ok: true };
    case "opennote:clip-now": {
      const reply = await clipActiveTab({ mode: message.mode || "selection", overrides: {} });
      return {
        status: reply.status,
        code: reply.code || null,
        label: reply.label || null,
        state: reply.state || null,
      };
    }
    case "opennote:options":
      // 「插件设置」打开 popup 内既有的设置视图（令牌块 / 端口）；模板管理走 options 页（C06）。
      return { ok: true, inline: true };
    case "opennote:open-options":
      // 03 §UI-01 C06：模板选择器列表底部的「管理模板…」打开插件选项页（模板管理）。
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    default:
      return { ok: false, code: "IMP-3005" };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handle(message)
    .then((reply) => sendResponse(reply))
    .catch((error) => sendResponse({ ok: false, code: "IMP-4014", detail: String(error && error.message) }));
  return true; // 异步响应
});

// service worker 每次启动都尝试补投一次（02 §5.7.7 queued_offline 的「上线后自动补投」）。
void flushQueue({ limit: 3 });
