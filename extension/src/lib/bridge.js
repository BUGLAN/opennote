/**
 * 本地桥（L1 传输通道 · HTTP 127.0.0.1）客户端。
 *
 * 严格照 docs/import/02-接口契约-导入信封与通道.md §5.2：
 *  - 端口按 8787→8796 **顺序**逐个 `GET /v1/health` 探测，**每次超时 300 ms**，命中即停；
 *  - `Authorization: Bearer <47 字符 opn_ 令牌>`（同时带 `X-Opennote-Token`，契约允许两者之一）；
 *  - 客户端侧 5 s 未响应 → `IMP-1004`；
 *  - 令牌只存在 `chrome.storage.local`，**绝不进 URL query**、绝不进日志。
 *
 * 本模块不引用任何 chrome API（fetch 由参数注入），因此可以在 node 里用
 * `tools/mock-bridge.mjs` 起一个真的回环服务端跑集成测试。
 */

import { SPEC, CLIENT_NAME, CLIENT_VERSION, errorCodeOf, isRetryable } from "./errors.js";

/** 02 §5.2.1：端口范围 8787–8796（共 10 个），默认从 8787 起顺序尝试。 */
export const BRIDGE_PORTS = Object.freeze([
  8787, 8788, 8789, 8790, 8791, 8792, 8793, 8794, 8795, 8796,
]);
export const HEALTH_TIMEOUT_MS = 300; // 02 §5.2.1 定死，不得放大
export const REQUEST_TIMEOUT_MS = 5000; // 02 §6.2 IMP-1004
export const TOKEN_RE = /^opn_[A-Za-z0-9_-]{43}$/; // 02 §5.2.3：43 + 前缀 = 47 字符

/** 02 §5.2.3 令牌形态校验（在落盘前挡住粘贴错的字符串）。 */
export function isValidToken(token) {
  return typeof token === "string" && TOKEN_RE.test(token) && token.length === 47;
}

export function endpointOf(port, path) {
  return `http://127.0.0.1:${port}${path}`;
}

function describeNetworkError(err) {
  if (!err) return "unreachable";
  if (err.name === "AbortError" || err.name === "TimeoutError") return "timeout";
  const code = (err.cause && err.cause.code) || err.code;
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH") return "unreachable";
  if (code === "EACCES" || code === "EPERM") return "blocked";
  return "unreachable";
}

/** 单次请求：统一超时、统一 JSON 解析、绝不回显令牌。 */
export async function requestJson(url, options = {}) {
  const {
    method = "GET",
    headers = {},
    body = undefined,
    timeoutMs = REQUEST_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
  } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      headers,
      body,
      signal: controller.signal,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { http: response.status, ok: response.ok, json, text, retryAfter: response.headers.get("Retry-After") };
  } catch (err) {
    return { networkError: describeNetworkError(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** `GET /v1/health`（API-01，无需令牌）。 */
export async function probeHealth(port, options = {}) {
  const { timeoutMs = HEALTH_TIMEOUT_MS, fetchImpl } = options;
  const raw = await requestJson(endpointOf(port, "/v1/health"), { timeoutMs, fetchImpl });
  if (raw.networkError) {
    return { port, kind: raw.networkError === "timeout" ? "timeout" : raw.networkError };
  }
  if (raw.json && raw.json.ok === true && raw.json.result && typeof raw.json.result === "object") {
    const health = raw.json.result;
    if (health.spec === SPEC || health.bridge === "running") {
      return { port, kind: "ok", http: raw.http, health };
    }
    return { port, kind: "foreign", http: raw.http };
  }
  if (raw.json && raw.json.ok === false && raw.json.error) {
    return {
      port,
      kind: "error",
      http: raw.http,
      code: errorCodeOf(raw.json),
      serverMessage: raw.json.error.userMessage || null,
      retryable: Boolean(raw.json.error.retryable),
    };
  }
  return { port, kind: "foreign", http: raw.http };
}

/**
 * 顺序探测 8787–8796，命中即停。
 * 返回的 `probes` 保留全部观察结果——状态机需要区分「没人监听」与「有人监听但不是我们」。
 */
export async function discover(options = {}) {
  const {
    ports = BRIDGE_PORTS,
    timeoutMs = HEALTH_TIMEOUT_MS,
    fetchImpl,
    preferredPort = null,
  } = options;
  const order = preferredPort && ports.includes(preferredPort)
    ? [preferredPort, ...ports.filter((p) => p !== preferredPort)]
    : [...ports];
  const probes = [];
  let hit = null;
  for (const port of order) {
    const probe = await probeHealth(port, { timeoutMs, fetchImpl });
    probes.push(probe);
    if (probe.kind === "ok") {
      hit = probe;
      break;
    }
  }
  const listeners = probes.filter((p) => p.kind !== "unreachable" && p.kind !== "timeout");
  return {
    hit,
    probes,
    listeners,
    /** 有端口在监听（哪怕不是我们的桥）。用于区分「未开启接口」与「端口被别人占了」。 */
    sawListener: listeners.length > 0,
    /** 桥在运行但窗口不在场：02 §6.2 IMP-4006。 */
    noWindow: listeners.some((p) => p.code === "IMP-4006"),
    /** 有端口在监听但来源不在信任列表（尚未配对）：02 §5.2.4 第 2 道。 */
    originRejected: probes.some((p) => p.code === "IMP-3001"),
    /** 桥自己报告端口全被占用：IMP-1003。 */
    portBusy: probes.some((p) => p.code === "IMP-1003"),
    scanned: probes.length,
  };
}

/** HTTP 状态码兜底映射：服务端没给 `code` 时，也**绝不允许**出现「未知错误」。 */
export function codeFromHttp(http) {
  if (http === 400) return "IMP-3002";
  if (http === 401) return "IMP-2002";
  if (http === 403) return "IMP-3001";
  if (http === 404) return "IMP-3005";
  if (http === 409) return "IMP-4020";
  if (http === 413) return "IMP-4005";
  if (http === 415) return "IMP-3004";
  if (http === 422) return "IMP-4003";
  if (http === 429) return "IMP-4015";
  if (http >= 500) return "IMP-5001";
  return "IMP-4014";
}

/** 归一化一次桥调用的结果（供状态机与 UI 使用）。 */
function normalizeCall(raw, fallbackCode) {
  if (raw.networkError) {
    return {
      kind: raw.networkError === "timeout" ? "timeout" : "unreachable",
      code: raw.networkError === "timeout" ? "IMP-1004" : "IMP-1001",
      http: null,
      result: null,
      serverMessage: null,
      retryable: raw.networkError === "timeout",
      retryAfter: null,
    };
  }
  if (raw.json && raw.json.ok === true && raw.json.result) {
    return {
      kind: "ok",
      code: null,
      http: raw.http,
      result: raw.json.result,
      serverMessage: null,
      retryable: false,
      retryAfter: null,
    };
  }
  const code = (raw.json && errorCodeOf(raw.json)) || fallbackCode(raw.http) || null;
  return {
    kind: "error",
    code,
    http: raw.http,
    result: null,
    serverMessage: (raw.json && raw.json.error && raw.json.error.userMessage) || null,
    retryable: raw.json && raw.json.error ? Boolean(raw.json.error.retryable) : isRetryable(code),
    retryAfter: raw.retryAfter ? Number(raw.retryAfter) : null,
  };
}

function authHeaders(token) {
  const headers = { "Content-Type": "application/json; charset=utf-8" };
  if (token) {
    // 02 §5.2.3：Authorization: Bearer 优先；X-Opennote-Token 为兼容保留。绝不放进 query。
    headers.Authorization = `Bearer ${token}`;
    headers["X-Opennote-Token"] = token;
  }
  return headers;
}

/** `POST /v1/import`（API-02）。 */
export async function postImport(port, token, envelope, options = {}) {
  const { timeoutMs = REQUEST_TIMEOUT_MS, fetchImpl } = options;
  const raw = await requestJson(endpointOf(port, "/v1/import"), {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(envelope),
    timeoutMs,
    fetchImpl,
  });
  return normalizeCall(raw, codeFromHttp);
}

/**
 * `POST /v1/pair` 的客户端封装在 0.3.1 **整体删除**（00 §6.15㉞：配对功能删除，改为粘贴长期令牌）。
 * 令牌不再由客户端向服务端索取，用户从 Opennote 的「导入与接口」复制后粘进来（走 `setManualToken` 路径）。
 * 保留一条显式记录，防止有人再从「少个函数」的角度把它加回来。
 */
export const PAIRING_REMOVED = Object.freeze({ removedIn: "0.3.1", reason: "00 §6.15㉞：配对整体删除，改为粘贴长期令牌" });

/**
 * 只读回显的写法（03 §UI-01 C58 / UI-04 S6）：`opn_` + 12 个掩码点 + **真实尾 4 位**。
 * **单一来源**：popup 不再自己拼模板，也不许用 `????` 之类的占位值顶替 —— 那是用户可见的错值
 * （「界面说的不是真的」那一族）。尾号缺失时只是不显示尾号，**绝不显示假尾号**。
 */
export function maskTokenTail(tail) {
  return `opn_${"•".repeat(12)}${String(tail || "")}`;
}

/** `GET /v1/imports/{importId}`（API-03）：收件箱模式下的轮询。 */
export async function getImportStatus(port, token, importId, options = {}) {
  const { timeoutMs = REQUEST_TIMEOUT_MS, fetchImpl } = options;
  const raw = await requestJson(endpointOf(port, `/v1/imports/${encodeURIComponent(importId)}`), {
    headers: authHeaders(token),
    timeoutMs,
    fetchImpl,
  });
  return normalizeCall(raw, codeFromHttp);
}

/** `GET /v1/workspace`（API-07，P1）：只用来读 `open` / `name` / `defaultFolder`，桥可能没实现。 */
export async function getWorkspace(port, token, options = {}) {
  const { timeoutMs = REQUEST_TIMEOUT_MS, fetchImpl } = options;
  const raw = await requestJson(endpointOf(port, "/v1/workspace"), {
    headers: authHeaders(token),
    timeoutMs,
    fetchImpl,
  });
  const call = normalizeCall(raw, codeFromHttp);
  return call.kind === "ok" ? call.result : null;
}

/** `GET /v1/tags`（API-08，P1）：标签自动补全用，取不到就静默降级。 */
export async function getTags(port, token, options = {}) {
  const { timeoutMs = REQUEST_TIMEOUT_MS, fetchImpl } = options;
  const raw = await requestJson(endpointOf(port, "/v1/tags"), {
    headers: authHeaders(token),
    timeoutMs,
    fetchImpl,
  });
  const call = normalizeCall(raw, codeFromHttp);
  return call.kind === "ok" && Array.isArray(call.result && call.result.tags) ? call.result.tags : [];
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 提交信封；**只对 `retryable: true` 的码**重试一次（02 §6.2 的「客户端应如何反应」列）。
 * 401/403/422 这类重试只是浪费，一律不重试（不许空转）。
 */
export async function submitEnvelope(port, token, envelope, options = {}) {
  const { attempts = 2, fetchImpl, timeoutMs = REQUEST_TIMEOUT_MS } = options;
  let last = await postImport(port, token, envelope, { fetchImpl, timeoutMs });
  let tried = 1;
  while (last.kind !== "ok" && last.retryable && tried < attempts) {
    const waitMs = last.retryAfter ? Math.min(last.retryAfter * 1000, 5000) : 300 * tried;
    await delay(waitMs);
    last = await postImport(port, token, envelope, { fetchImpl, timeoutMs });
    tried += 1;
  }
  return { ...last, attempts: tried };
}
