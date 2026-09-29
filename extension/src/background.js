/**
 * Opennote 剪藏扩展 · background service worker（MV3）。
 *
 * 职责：三条入口（浮标 / 右键菜单 / 快捷键）与 popup 都汇到同一个 `clipActiveTab()`；
 * 端口探测、令牌、离线暂存队列、配对全部在这里收口，popup 只负责画界面。
 *
 * 安全：**所有桥调用都在 service worker 里发**（host_permissions 只给了 127.0.0.1 的
 * 8787–8796），页面里的脚本拿不到令牌；令牌只落 `chrome.storage.local`，绝不进 URL/日志。
 */

import { extractPage } from "./content/extract-page.js";
import { copyInPage } from "./content/clipboard.js";
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
  postPair,
  getImportStatus,
  getWorkspace,
  endpointOf,
  isValidToken,
} from "./lib/bridge.js";
import { readState, mutate } from "./lib/store.js";
import { makeQueueItem, enqueue, removeItem, markAttempt, takeBatch } from "./lib/queue.js";
import { STATE, decideState, planFor, busyPlan, stateForCode } from "./lib/state.js";
import { userMessage } from "./lib/errors.js";

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

/** 右键菜单两条：选区剪藏 + 整页剪藏（03 §UI-01 的入口清单）。 */
function installMenus() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "opennote-clip-selection",
      title: "剪藏选中片段到 Opennote",
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
  const mode = info.menuItemId === "opennote-clip-page" ? "page" : "selection";
  void clipFromChromeEntry(mode, tab);
});

chrome.commands?.onCommand.addListener((command) => {
  if (command === "clip-selection") void clipFromChromeEntry("selection", null);
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

async function armTab(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content/float.js"] });
    return true;
  } catch {
    return false;
  }
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
async function extractFromTab(tabId) {
  try {
    const injection = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractPage,
      args: [{ includeArticle: true }],
    });
    const result = injection && injection[0] && injection[0].result;
    if (!result || !result.ok) return null;
    return result;
  } catch {
    return null;
  }
}

async function getExtraction(tabId, options = {}) {
  const { force = false } = options;
  const cached = extractionCache.get(tabId);
  if (!force && cached && Date.now() - cached.at < EXTRACTION_TTL_MS) return cached.data;
  const data = await extractFromTab(tabId);
  if (data) extractionCache.set(tabId, { at: Date.now(), data });
  return data;
}

function resolveTitle(extraction, mode, userTitle) {
  if (userTitle && String(userTitle).trim()) return String(userTitle).trim();
  if (mode === "selection") {
    return extraction.selection.ancestorTitle || extraction.pageTitle || "未命名剪藏";
  }
  return (extraction.article && extraction.article.title) || extraction.pageTitle || "未命名剪藏";
}

function resolveBody(extraction, mode) {
  if (mode === "selection") return extraction.selection.present ? extraction.selection.markdown : "";
  return (extraction.article && extraction.article.markdown) || "";
}

function buildClipEnvelope({ extraction, mode, title, folder, tags, importId, version }) {
  return buildEnvelope({
    importId: importId || newImportId(),
    title: resolveTitle(extraction, mode, title),
    body: resolveBody(extraction, mode),
    url: extraction.url,
    pageTitle: extraction.pageTitle,
    site: extraction.site,
    author: extraction.author,
    publishedAt: extraction.publishedAt,
    capturedAt: toLocalIso(new Date()),
    // `source.selection` 是判定输入（02 §4.1 第 3/4 步），必须如实反映剪藏范围。
    selection: mode === "selection",
    folder,
    tags,
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

  if (probe.hit) {
    workspace = (probe.hit.health && probe.hit.health.workspace) || null;
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

async function deliver({ envelope, folderLabel, noteTitle, mode }) {
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
    await mutate(() => ({
      port: probe.hit.port,
      endpoint: endpointOf(probe.hit.port, ""),
      lastOkAt: new Date().toISOString(),
    }));
    const status = result.status || "created";
    if (status === "pending") {
      // 整页二次剪藏进了收件箱（02 §4.1 第 4 步）——按「已暂存、等确认」对待，不当失败。
      return {
        status: "inbox",
        code: null,
        label: "已暂存，等 Opennote 打开后自动入库。",
        state: STATE.CONNECTED,
        inboxId: result.inboxId || null,
        folderLabel,
        noteTitle,
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
    };
  }

  const code = call.code;
  const message = userMessage(code, call.serverMessage);

  if (code === "IMP-2001" || code === "IMP-2002" || code === "IMP-3001") {
    // 401/403：令牌无效或来源还没进信任列表。清掉令牌，回配对流程。
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

/** 三条 Chrome 入口（右键菜单 / 快捷键）共用：先注入浮标，再把结果画成药丸文案。 */
async function clipFromChromeEntry(mode, tab) {
  const target = tab && tab.id !== undefined ? tab : await activeTab();
  if (!target || target.id === undefined) return { status: "restricted", code: "IMP-1006" };
  if (isRestrictedUrl(target.url)) {
    await sendToTab(target.id, { type: "opennote:flash", text: "这个页面不允许插件读取内容", danger: true });
    return { status: "restricted", code: "IMP-1006", label: "这个页面不允许插件读取内容。" };
  }
  await armTab(target.id);
  await sendToTab(target.id, { type: "opennote:busy" });
  const reply = await clipActiveTab({ mode, tabId: target.id, arm: false });
  const text =
    reply.status === "created"
      ? "已剪藏"
      : reply.status === "queued" || reply.status === "inbox"
        ? "已暂存"
        : reply.label || "本地接口未开启";
  await sendToTab(target.id, {
    type: "opennote:flash",
    text,
    danger: reply.status === "error" || reply.status === "restricted",
  });
  if (reply.status === "error" && reply.code) void openPopup();
  return reply;
}

async function openPopup() {
  try {
    if (chrome.action && typeof chrome.action.openPopup === "function") await chrome.action.openPopup();
  } catch {
    // 打开失败不是错误：气泡里已经如实显示过失败原因。
  }
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
  const folder = overrides.folder !== undefined ? overrides.folder : state.folder;
  const tags = overrides.tags !== undefined ? filterTags(overrides.tags) : state.tags;
  const envelope = buildClipEnvelope({
    extraction,
    mode,
    title: overrides.title,
    folder,
    tags,
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

  await mutate(() => ({ folder: folder || "", tags, mode }));
  return deliver({
    envelope,
    folderLabel: folderLabelOf(folder),
    noteTitle: envelope.title,
    mode,
  });
}

/* ─────────────────────────── 配对 / 令牌 ─────────────────────────── */

async function pairWithCode(code) {
  const state = await readState();
  const probe = await discover({ preferredPort: state.port, ports: BRIDGE_PORTS });
  const port = probe.hit ? probe.hit.port : state.port;
  if (!port) {
    const codeOnly = probe.noWindow ? "IMP-4006" : probe.portBusy || probe.sawListener ? "IMP-1003" : "IMP-1001";
    return { ok: false, code: codeOnly, label: userMessage(codeOnly), state: decideState({ probe, online: navigator.onLine, token: null, pendingCount: state.pending.length }) };
  }
  const call = await postPair(port, code);
  if (call.kind === "ok") {
    await mutate(() => ({
      token: call.token,
      port,
      endpoint: call.endpoint || endpointOf(port, ""),
      lastOkAt: new Date().toISOString(),
    }));
    return { ok: true, code: null, port, label: null };
  }
  const mapped = call.code === "IMP-2004" ? "IMP-2004" : call.code || "IMP-1001";
  return {
    ok: false,
    code: mapped,
    label: userMessage(mapped, call.serverMessage),
    state: stateForCode(mapped),
  };
}

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
  const snapshot = { ok: true, tab: null, extraction: null, restricted: false };
  if (!tab || tab.id === undefined) {
    snapshot.restricted = true;
  } else {
    snapshot.tab = { id: tab.id, url: tab.url || null, title: tab.title || null };
    snapshot.restricted = isRestrictedUrl(tab.url);
    if (!snapshot.restricted) {
      const extraction = await getExtraction(tab.id, { force: true });
      if (extraction) {
        snapshot.extraction = extraction;
        void armTab(tab.id); // popup 打开即授予 activeTab：顺手把浮标装上（UI-02）
      } else {
        snapshot.restricted = true;
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
  return {
    ...snapshot,
    stateId,
    plan,
    workspace: probed.workspace,
    defaultFolder: probed.defaultFolder,
    settings: {
      folder: probed.stored.folder || "",
      tags: probed.stored.tags || [],
      mode: probed.stored.mode || "selection",
      hasToken: Boolean(probed.stored.token),
      port: probed.stored.port || null,
      endpoint: probed.stored.endpoint || null,
      pendingCount: probed.pendingCount,
    },
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
          importId: message.importId,
        },
      });
      return { ok: true, reply };
    }
    case "opennote:stage": {
      const reply = await clipActiveTab({
        mode: message.mode,
        overrides: { title: message.title, folder: message.folder, tags: message.tags, importId: message.importId },
      });
      if (reply.status === "queued") return { ok: true, reply };
      // 已经在线：显式暂存也要落到队列里（用户点的是「暂存在插件里」）。
      const tab = await activeTab();
      const extraction = tab && tab.id !== undefined ? await getExtraction(tab.id) : null;
      if (!extraction) return { ok: true, reply };
      const state = await readState();
      const folder = message.folder !== undefined ? message.folder : state.folder;
      const tags = message.tags !== undefined ? filterTags(message.tags) : state.tags;
      const envelope = buildClipEnvelope({
        extraction,
        mode: message.mode,
        title: message.title,
        folder,
        tags,
        importId: message.importId,
        version: chrome.runtime.getManifest().version,
      });
      return {
        ok: true,
        reply: await stageOffline({
          envelope,
          folderLabel: folderLabelOf(folder),
          noteTitle: envelope.title,
          mode: message.mode,
          code: "IMP-1001",
        }),
      };
    }
    case "opennote:pair":
      return { ok: true, reply: await pairWithCode(message.code) };
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
      // 本轮不单独开 options 页：popup 自己切到「插件设置」（配对 / 令牌）区域。
      return { ok: true, inline: true };
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
