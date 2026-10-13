/*
 * 控制台前端（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §4.6）。
 *
 * ## 无构建步骤
 *
 * 原生 ES module，浏览器直接跑。它**不是产品的一部分** —— 所以刻意不引框架、
 * 不做打包。代价是没有类型检查，收益是「改一行刷新就生效」。
 *
 * ## 这个文件里最要紧的两件事
 *
 * ### ① 密钥只在这里派生令牌，且**绝不发给服务端**
 *
 * 账号密钥 → `HKDF(accountKey, "auth")` → `authToken` → `POST /panel/api/session`
 * → 服务端把它写进 `HttpOnly` cookie。之后这个页面**再也不碰令牌**
 * （`HttpOnly` 意味着 JS 甚至读不到它）。
 *
 * 密钥本身**只留在内存与 localStorage 的「显示用」副本里**，从不 POST 出去。
 *
 * ★ 但必须承认边界：网页端终究信任「服务端当天发给它的这份 JS」（§5.6⑤）。
 *   页面底部有指向 `/v1/health` 的构建哈希核对入口 —— 那是这条信任链上唯一
 *   用户能自己验证的一环。
 *
 * ### ② 管理员区块是**被创建出来的**，不是被显示出来的
 *
 * `/panel/api/me` 回 `isAdmin: true` 时才 `document.createElement`。
 * 普通账号的 DOM 里**根本没有**这些区块（§10.1 M8）。就算有人在控制台里手动改 JS
 * 变量把区块画出来，**API 也会 403** —— 两道独立的闸门。
 */

const API = "/panel/api";

/* ============================================================================
   §1.5 / §3.9 的密钥派生：必须与 `src/sync/accountKey.ts` **逐参数一致**

   ⚠️ 这段是「四端同一条代码路径」的**例外**：控制台是「无构建步骤」的静态页，
   没法 import `@noble/hashes`，只能用 WebCrypto。HKDF-SHA256 的实现在两者之间是等价的，
   但 **salt / info / 长度差一个字就是完全不同的密钥** ——
   而症状会是「密钥输错了」，一个会把人引到错方向（去怀疑用户）的报错。

   所以 `src/sync/accountKey.test.ts` 里有一条用例**把两种实现算出来的字节直接比对**。
   改动这里之前先去看那条用例。
   ============================================================================ */

/** HKDF `info`（§3.9：`"opennote/v1/…"`）。 */
const HKDF_INFO_AUTH = "opennote/v1/auth";
/** 导出文本的前缀。 */
const KEY_PREFIX = "opennote-key-v1.";
/** 二进制 blob 的版本号。 */
const BLOB_VERSION = 1;
const ACCOUNT_ID_BYTES = 16;
const ACCOUNT_KEY_BYTES = 32;

const encoder = new TextEncoder();

/** base64url → Uint8Array（没有填充、用 `-`/`_`）。 */
function fromBase64Url(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 小写十六进制 → Uint8Array（`accountId` 的传输编码是十六进制）。 */
function fromHex(text) {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Uint8Array → 小写十六进制（服务端的 `authToken` 就是 hex 形状）。 */
function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 解析用户粘进来的密钥文本 → `{ accountId, accountKey }`。
 *
 * 格式（与 `accountKey.ts` 的 `decodeAccountKey` 一致）：
 *   `opennote-key-v1.` + base64url( version(1B) || accountId(16B) || accountKey(32B) )
 *
 * ★ **`accountId` 必须在这里解出来**：它是 `authToken` 的派生 salt（§3.9）。
 *   少了它就算拿到 `accountKey` 也派不出令牌 —— 而它本来是公开值，放进去不泄露任何东西。
 */
function parseAccountKey(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) throw new Error("密钥是空的");
  const body = trimmed.startsWith(KEY_PREFIX) ? trimmed.slice(KEY_PREFIX.length) : trimmed;
  let blob;
  try {
    blob = fromBase64Url(body);
  } catch {
    throw new Error("密钥不是合法的 base64url");
  }
  const expected = 1 + ACCOUNT_ID_BYTES + ACCOUNT_KEY_BYTES;
  if (blob.length !== expected) {
    throw new Error(`密钥长度不对：期待 ${expected} 字节，实际 ${blob.length} 字节`);
  }
  if (blob[0] !== BLOB_VERSION) {
    throw new Error(`不认识的密钥版本：${blob[0]}（本版只认 ${BLOB_VERSION}）`);
  }
  return {
    accountId: toHex(blob.slice(1, 1 + ACCOUNT_ID_BYTES)),
    accountKey: blob.slice(1 + ACCOUNT_ID_BYTES),
  };
}

/**
 * `authToken = HKDF-SHA256(accountKey, salt = accountId 的**16 个字节**, info = "opennote/v1/auth")`。
 *
 * ⚠️ salt 是 `accountId` **十六进制解码后的字节**，不是那串十六进制文本的 ASCII ——
 * 后者会算出一个完全不同的令牌（`accountKey.test.ts` 里有一条反证用例专门画这个坑）。
 */
async function deriveAuthToken(accountKey, accountId) {
  const base = await crypto.subtle.importKey("raw", accountKey, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: fromHex(accountId), info: encoder.encode(HKDF_INFO_AUTH) },
    base,
    256,
  );
  return toHex(new Uint8Array(bits));
}

/* ============================================================================ */

/** 所有变更类请求都要带这个头（§4.6 的 CSRF 方案）。 */
const CSRF_HEADERS = { "X-Requested-With": "opennote-panel" };

async function request(path, options = {}) {
  const method = options.method ?? "GET";
  const response = await fetch(`${API}${path}`, {
    method,
    // cookie 是 HttpOnly，但**必须显式带** `same-origin`（否则跨源时行为不一致）。
    credentials: "same-origin",
    headers: {
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(method === "GET" || method === "HEAD" ? {} : CSRF_HEADERS),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error((payload && payload.error) || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = payload && payload.code;
    throw error;
  }
  return payload;
}

const $ = (selector) => document.querySelector(selector);

function show(element, visible) {
  if (element) element.hidden = !visible;
}

function text(element, value) {
  if (element) element.textContent = value;
}

/** 造一个元素（属性名以 `on` 开头的当事件处理）。 */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/** 渲染一张表（`rows` 是数组的数组；第一行是表头）。 */
function renderTable(table, rows) {
  if (!table) return;
  table.replaceChildren();
  if (rows.length === 0) return;
  const [head, ...body] = rows;
  table.append(el("thead", {}, [el("tr", {}, head.map((cell) => el("th", {}, [String(cell)])))]));
  table.append(el("tbody", {}, body.map((row) => el("tr", {}, row.map((cell) => el("td", {}, [String(cell)]))))));
}

function renderList(container, entries) {
  if (!container) return;
  container.replaceChildren();
  for (const [label, value] of entries) {
    container.append(el("dt", {}, [label]));
    container.append(el("dd", {}, [String(value)]));
  }
}

function bytes(n) {
  if (!Number.isFinite(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function dateTime(ms) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("zh-CN");
}

/* ============================================================================
   会话
   ============================================================================ */

let session = null;

async function enter() {
  const errorBox = $("#unlock-error");
  show(errorBox, false);
  try {
    const material = parseAccountKey($("#key").value);
    const authToken = await deriveAuthToken(material.accountKey, material.accountId);
    const me = await request("/session", { method: "POST", body: { authToken } });
    /*
     * ★ 密钥**只在这里留一份**（用于「导出密钥」重新显示）。
     * 它从不 POST 出去；服务端拿到的是派生出来的令牌。
     */
    session = { ...me, keyText: $("#key").value.trim() };
    $("#key").value = "";
    await render();
  } catch (error) {
    text(errorBox, error.message || String(error));
    show(errorBox, true);
  }
}

async function logout() {
  await request("/session", { method: "DELETE" }).catch(() => undefined);
  session = null;
  $("#app").hidden = true;
  show($("#unlock"), true);
  $("#logout").hidden = true;
  text($("#who"), "");
}

/* ============================================================================
   管理员区块：**创建**，不是显示
   ============================================================================ */

/**
 * 只有在 `isAdmin` 时才被调用 —— 这个函数体是管理员界面存在的**唯一**来源。
 *
 * 里面的每一条数据都还要过一次 `/panel/api/admin/*`，而那些端点自己会 403。
 * 所以「改 JS 变量把界面画出来」也拿不到任何数据（§10.1 M8 两道闸门）。
 */
function createAdminPanels(nav) {
  const accounts = el("section", { "data-panel": "admin-accounts", hidden: "" }, [
    el("h2", {}, ["账号管理"]),
    el("div", { class: "row" }, [
      el("input", { id: "invite-uses", type: "number", min: "1", max: "1000", value: "1", title: "可用次数" }),
      el("input", { id: "invite-days", type: "number", min: "1", max: "365", value: "7", title: "有效天数" }),
      el("button", { id: "invite-create", type: "button", onclick: () => createInvite() }, ["生成注册邀请码"]),
    ]),
    el("p", { class: "code", id: "invite-code", hidden: "" }),
    el("p", { class: "muted small" }, [
      "明文只显示这一次 —— 库里只存哈希，事后连服务端也拿不回它。",
    ]),
    el("table", { id: "admin-accounts" }),
  ]);

  const server = el("section", { "data-panel": "admin-server", hidden: "" }, [
    el("h2", {}, ["服务器"]),
    el("dl", { id: "server-info" }),
  ]);

  $("#app").append(accounts, server);
  nav.append(
    el("button", { type: "button", "data-goto": "admin-accounts" }, ["账号管理"]),
    el("button", { type: "button", "data-goto": "admin-server" }, ["服务器"]),
  );
  return { accounts, server };
}

let adminPanels = null;

async function createInvite() {
  const box = $("#invite-code");
  try {
    const result = await request("/admin/invites", {
      method: "POST",
      body: { maxUses: Number($("#invite-uses").value) || 1, days: Number($("#invite-days").value) || 7 },
    });
    // 明文码只在这里出现一次。
    text(box, result.code);
    show(box, true);
  } catch (error) {
    text(box, error.message || String(error));
    show(box, true);
  }
}

/* ============================================================================
   渲染
   ============================================================================ */

const USER_TABS = [
  ["account", "我的账号"],
  ["devices", "我的设备"],
  ["notebooks", "我的笔记本"],
  ["usage", "用量"],
  ["stats", "冲突与错误"],
];

async function render() {
  show($("#unlock"), false);
  $("#app").hidden = false;
  show($("#logout"), true);
  text($("#who"), `${session.accountId}${session.isAdmin ? "（管理员）" : ""}`);

  const nav = $("#tabs");
  nav.replaceChildren();
  for (const [id, label] of USER_TABS) {
    nav.append(el("button", { type: "button", "data-goto": id }, [label]));
  }
  if (session.isAdmin && !adminPanels) {
    adminPanels = createAdminPanels(nav);
    adminPanels.accounts.hidden = true;
    adminPanels.server.hidden = true;
  }

  nav.addEventListener("click", (event) => {
    const target = event.target.closest("[data-goto]");
    if (!target) return;
    for (const section of document.querySelectorAll("[data-panel]")) {
      section.hidden = section.dataset.panel !== target.dataset.goto;
    }
  });
  for (const section of document.querySelectorAll("[data-panel]")) section.hidden = true;
  const first = document.querySelector('[data-panel="account"]');
  if (first) first.hidden = false;

  await Promise.all([loadAccount(), loadDevices(), loadNotebooks(), loadUsage(), loadStats()]);
  if (session.isAdmin) await Promise.all([loadAdminAccounts(), loadServer()]);
}

async function loadAccount() {
  const data = await request("/account");
  renderList($("#account-info"), [
    ["账号 ID", data.accountId],
    ["标签", data.label ?? "—"],
    ["管理员", data.isAdmin ? "是" : "否"],
    ["状态", data.status],
    ["创建于", dateTime(data.createdAt)],
    ["最近活动", dateTime(data.lastSeenAt)],
  ]);
  // ★ 三条能力边界说明由 API 下发 —— 界面说了什么也被用例断言。
  const notes = $("#account-notes");
  notes.replaceChildren();
  for (const note of data.capabilityNotes ?? []) notes.append(el("p", { class: "muted small" }, [note]));
}

async function loadDevices() {
  const data = await request("/devices");
  text($("#devices-note"), data.note ?? "");
  renderTable($("#devices"), [
    ["名称", "平台", "创建于", "上次活动"],
    ...data.devices.map((device) => [device.name ?? "—", device.platform ?? "—", dateTime(device.createdAt), dateTime(device.lastSeenAt)]),
  ]);
}

async function loadNotebooks() {
  const data = await request("/notebooks");
  renderTable($("#notebooks"), [
    ["名称", "角色", "加密", "创建于"],
    ...data.notebooks.map((nb) => [
      nb.name,
      nb.role,
      nb.cryptoMode === "user-key" ? "user-key（不可共享）" : "明文",
      dateTime(nb.createdAt),
    ]),
  ]);
}

async function loadUsage() {
  const { quota } = await request("/usage");
  renderList($("#usage-info"), [
    ["已用空间", `${bytes(quota.bytesUsed)} / ${bytes(quota.bytesLimit)}`],
    ["笔记本数", `${quota.notebooks} / ${quota.notebooksLimit}`],
  ]);
}

async function loadStats() {
  const data = await request("/stats");
  text($("#stats-note"), data.note ?? "");
  renderTable($("#stats"), [
    ["日期", "笔记本", "冲突", "错误", "推送", "拉取", "删除"],
    ...data.stats.map((row) => [row.day, row.notebookId, row.conflicts, row.errors, row.pushes, row.pulls, row.deletes]),
  ]);
}

async function loadAdminAccounts() {
  const data = await request("/admin/accounts");
  renderTable($("#admin-accounts"), [
    ["账号 ID", "标签", "状态", "管理员", "笔记本", "创建于"],
    ...data.accounts.map((row) => [
      row.accountId,
      row.label ?? "—",
      row.status,
      row.isAdmin ? "是" : "否",
      row.quota.notebooks,
      dateTime(row.createdAt),
    ]),
  ]);
}

async function loadServer() {
  const data = await request("/admin/server");
  renderList($("#server-info"), [
    ["协议版本", data.protocolVersion],
    ["CouchDB", data.couchVersion ?? "连不上"],
    ["笔记本库数", data.dbCount],
    ["账号数", data.accountCount],
    ["运行时长", `${Math.round(data.uptimeSeconds / 60)} 分钟`],
  ]);
}

/* ============================================================================
   启动
   ============================================================================ */

$("#enter").addEventListener("click", () => void enter());
$("#logout").addEventListener("click", () => void logout());
$("#keyfile").addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  if (file) $("#key").value = await file.text();
});

// 已经有 cookie（刷新页面）：直接进，不用再粘一次密钥。
void (async () => {
  try {
    const me = await request("/me");
    session = { ...me };
    await render();
  } catch {
    show($("#unlock"), true);
  }
})();
