/*
 * 控制台的**取数层**：凭据派生 + 会话 + 资源请求（`docs/执行-三端同步…` §4.6）。
 *
 * ## 为什么单独一个文件
 *
 * 这一层里有两段「差一个字就坏、而且坏了很难查」的东西：
 *   ① 密钥派生（HKDF 的 salt / info / 长度必须与客户端逐参数一致）
 *   ② 请求的 CSRF 头与 credentials 语义
 * 它们和「这一页长什么样」没有关系，混在一起时每次改界面都要重读一遍密码学注释。
 *
 * ## 这个文件不做的事
 *
 * - **不把密钥发给服务端**。派生在本地完成，POST 出去的只有 authToken。
 * - **不缓存令牌**。authToken 进 HttpOnly cookie 之后，这个文件再也不碰它。
 * - **不自己判断是不是管理员**。`isAdmin` 来自 `GET /panel/api/me`，
 *   而且它只决定「画不画」，真正的闸门是服务端的 403。
 */

export const API_BASE = "/panel/api";

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

/* ============================================================================
   会话
   ============================================================================ */

/** 所有变更类请求都要带这个头（§4.6 的 CSRF 方案：跨源发不出自定义头）。 */
const CSRF_HEADERS = { "X-Requested-With": "opennote-panel" };

/**
 * 一个请求的失败，带着服务端给的 `code`。
 *
 * `code` 是这个界面的行为依据，不只是给人看的文案：
 *   - `step-up-required` → 弹「重新粘贴密钥」，而不是显示「无权限」
 *   - `unauthorized`     → 回登录页（cookie 可能刚被轮换作废）
 *   - `forbidden`        → 说明这个账号没有管理员权限，且**不该**重试
 * 把它们混成一个「请求失败」会让这三种情况的界面变得一样，而它们的下一步完全不同。
 */
export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request(path, options = {}) {
  const method = options.method ?? "GET";
  const response = await fetch(API_BASE + path, {
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
    throw new ApiError(
      (payload && payload.error) || "HTTP " + response.status,
      response.status,
      payload && payload.code,
    );
  }
  return payload;
}

/** `GET /panel/api/me`：我是谁 + 能不能看管理区块。401 表示未登录。 */
export async function fetchMe() {
  return request("/me");
}

/**
 * 用账号密钥进入控制台。
 *
 * ★ 密钥在这里解析、派生，然后**只把派生出来的 authToken** 发出去。
 *   返回时把密钥文本留在内存里（`keyText`）—— 它用于「重新显示密钥」和
 *   **二次验证**（危险动作前不必让用户去翻密码管理器以外的地方）。
 */
export async function signIn(keyText) {
  const material = parseAccountKey(keyText);
  const authToken = await deriveAuthToken(material.accountKey, material.accountId);
  const me = await request("/session", { method: "POST", body: { authToken } });
  return { ...me, keyText: keyText.trim() };
}

export async function signOut() {
  await request("/session", { method: "DELETE" }).catch(() => undefined);
}

/**
 * **二次验证**：把密钥重新派生一次，交给服务端确认「还是这个人」。
 *
 * 服务端会核两件事：这个令牌对应**当前会话的账号**，且账号仍然 active。
 * 通过后它签发一个 5 分钟有效的 step-up cookie，之后那一次危险动作才允许执行。
 */
export async function verifyForKey(keyText) {
  const material = parseAccountKey(keyText);
  const authToken = await deriveAuthToken(material.accountKey, material.accountId);
  return request("/session/verify", { method: "POST", body: { authToken } });
}

/* ============================================================================
   读取（管理端）
   ============================================================================ */

export const getAdminAccounts = () => request("/admin/accounts");
export const getOverview = () => request("/admin/overview");
export const getNotebooks = () => request("/admin/notebooks");
export const getDevices = () => request("/admin/devices");
export const getInvites = () => request("/admin/invites");
export const getConfig = () => request("/admin/config");
export const getAudit = (limit = 100) => request("/admin/audit?limit=" + limit);
export const inspectNotebook = (id) => request("/admin/notebooks/" + encodeURIComponent(id) + "/inspection");

/* ============================================================================
   读取（个人）
   ============================================================================ */

export const getAccount = () => request("/account");
export const getMyDevices = () => request("/devices");
export const getMyNotebooks = () => request("/notebooks");
export const getUsage = () => request("/usage");
export const getStats = (limitDays) => request("/stats?limit=" + limitDays);

/* ============================================================================
   写入（全部是管理动作）
   ============================================================================ */

export const createInvite = (body) => request("/admin/invites", { method: "POST", body });
export const setAccountStatus = (id, status) =>
  request("/admin/accounts/" + encodeURIComponent(id) + "/status", { method: "POST", body: { status } });
export const deleteAccount = (id) => request("/admin/accounts/" + encodeURIComponent(id), { method: "DELETE" });
export const revokeInviteByHash = (codeHash) =>
  request("/admin/invites/" + encodeURIComponent(codeHash), { method: "DELETE" });

export { request, parseAccountKey, deriveAuthToken };
