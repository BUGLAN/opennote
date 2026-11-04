/* eslint-disable */
"use strict";

/**
 * 桌面端的主进程同步代理（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §5.5）。
 *
 * ## 为什么远端请求**必须**走主进程
 *
 * `cspPolicy()`（`electron/main.cjs`）**不放任何 https**，所以渲染层根本发不出去。
 * 这不是麻烦，而是一道**有意保留的墙**：渲染层是 XSS 的战场，让它拿不到外发能力，
 * XSS 的收益就被压到最低。
 *
 * ## ★ 这个模块唯一要守住的东西：**它不能变成一个通用 `fetch(url)`**
 *
 * §5.5 原文：「**只允许『配置好的 base URL + 相对路径』**——不能做成通用 `fetch(url)`，
 * 否则**一次 XSS 就能借它把笔记外发**」。
 *
 * 一个「帮我请求这个地址」的 IPC，等于把主进程变成了一个**带你的凭证的出网代理**：
 * 攻击者不需要偷走 `authToken`，只需要让主进程把笔记 POST 到自己的服务器。
 * 所以这里有三道**独立的**闸门，任何一道单独成立都不足以放行：
 *
 * 1. **方法白名单**：只有 GET / PUT / DELETE / POST（没有 HEAD/OPTIONS/TRACE 之类）；
 * 2. **`relPath` 必须是安全的相对路径**：拒 `..`、拒绝对路径、拒反斜杠、拒协议相对（`//evil`）；
 * 3. **拼出来的 URL 的 origin 必须与 base URL 相同**，且路径在 base 路径之下。
 *
 * 第 3 条是**关键的冗余**：即使第 2 条哪天被绕过（比如 `relPath` 里塞了编码过的 `%2e%2e`），
 * origin 比对仍然兜得住。§5.5 说「断言 `startsWith(syncBaseUrl)`」——
 * 我在这里用 `URL` 解析后比 **origin**，因为裸 `startsWith` 有一个经典漏洞：
 * base 是 `https://a.com` 时，`https://a.com.evil.com/` 也 `startsWith("https://a.com")`。
 *
 * ## `authToken` / `encRoot` 由主进程持有
 *
 * §5.5：「**`authToken` 与 `encRoot` 都由主进程持有**（渲染层拿不到）」。
 * 所以这个代理**自己**往请求上贴 `Authorization`，渲染层传进来的 headers 里
 * 不允许出现 `authorization`（否则渲染层就能借它用别的凭证发请求）。
 */

/** 允许的方法（白名单，不是黑名单）。 */
const ALLOWED_METHODS = new Set(["GET", "PUT", "DELETE", "POST"]);

/** 渲染层**不许**自己设置的请求头（凭证由主进程贴）。 */
const FORBIDDEN_HEADERS = new Set(["authorization", "cookie", "host", "origin", "referer"]);

class SyncProxyError extends Error {
  constructor(message) {
    super(message);
    this.name = "SyncProxyError";
  }
}

/**
 * 工作区/请求相对路径的合法性。
 *
 * ⚠️ 规则与 `shared/paths.ts` 的 `assertSafeRelative` **一致**，但这里是 CommonJS，
 * 没法 import TS（`electron/deeplink.cjs` 出于同样的原因也复制了一份，并同样注明了出处）。
 * **两处必须一起改** —— 所以这个函数的注释里写清了它是谁的镜像。
 */
function assertSafeRelPath(input) {
  if (typeof input !== "string" || input === "") throw new SyncProxyError("relPath 必须是非空字符串");
  if (input.includes("\\")) throw new SyncProxyError("relPath 不能含反斜杠");
  if (input.includes("\0")) throw new SyncProxyError("relPath 不能含空字节");
  // 协议相对（`//evil.com/x`）会被 `new URL` 当成**换主机**，必须先拒。
  if (input.startsWith("//")) throw new SyncProxyError("relPath 不能以 // 开头");
  // 绝对路径：`/v1/file` 是我们**允许**的写法（base 就是服务根），
  // 但绝不允许出现盘符或 `file:` 之类。
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)) throw new SyncProxyError("relPath 不能带协议");
  for (const segment of input.split("/")) {
    if (segment === "..") throw new SyncProxyError("relPath 不能含 ..");
    // 编码过的 `..`（`%2e%2e`）也要拒 —— 它是绕过朴素检查的经典手法。
    const lowered = segment.toLowerCase();
    if (lowered === "%2e%2e" || lowered === "%2e." || lowered === ".%2e") {
      throw new SyncProxyError("relPath 不能含编码过的 ..");
    }
  }
  return input;
}

/** 校验 base URL：必须是 http/https，且不带查询/哈希。 */
function normalizeBaseUrl(baseUrl) {
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") throw new SyncProxyError("baseUrl 不能是空的");
  let parsed;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    throw new SyncProxyError(`baseUrl 不是合法 URL：${baseUrl}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new SyncProxyError(`baseUrl 必须是 http/https，实得 ${parsed.protocol}`);
  }
  if (parsed.search !== "" || parsed.hash !== "") throw new SyncProxyError("baseUrl 不能带查询串或片段");
  // 末尾统一去掉斜杠，拼接才可预测。
  const path = parsed.pathname.replace(/\/+$/, "");
  return { origin: parsed.origin, path, base: `${parsed.origin}${path}` };
}

/**
 * 拼出最终 URL，并**再次**断言它没有跑出 base。
 *
 * 这是第三道闸门（见模块头）。即使 `assertSafeRelPath` 被绕过，
 * 这里比的是**解析之后的 origin**，`https://a.com.evil.com` 那种前缀伪装过不去。
 */
function composeUrl(base, relPath) {
  /*
   * ★ 去掉开头的斜杠再拼接 —— `relPath` 是**相对 base** 的，不是「相对站点根」的。
   *
   * 这个区别在 base 带子路径时才显形：base = `https://a.com/opennote` 时，
   * `new URL("/v1/tree", …)` 会把整个路径**替换**掉，得到 `https://a.com/v1/tree` ——
   * 跑出了 base 的子路径（我的第三道闸门会拒它，所以症状是「正常请求被拒」）。
   *
   * §5.5 的原话是「配置好的 base URL **+ 相对路径**」，所以正确的语义是
   * 「拼在 base 之后」。有一条用例专门跑 base 带子路径的情形。
   */
  const url = new URL(relPath.replace(/^\/+/, ""), `${base.base}/`);
  if (url.origin !== base.origin) {
    throw new SyncProxyError(`拼出的 URL 跑出了 base（origin 变成 ${url.origin}）`);
  }
  if (!url.pathname.startsWith(`${base.path}/`) && url.pathname !== base.path) {
    throw new SyncProxyError(`拼出的 URL 跑出了 base 的路径（${url.pathname}）`);
  }
  return url;
}

/** 只留下允许的请求头；渲染层不许自己带凭证。 */
function sanitizeHeaders(raw) {
  const out = {};
  if (raw === null || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw)) {
    const lowered = String(key).toLowerCase();
    if (FORBIDDEN_HEADERS.has(lowered)) {
      throw new SyncProxyError(`不许自己设置 ${key}（凭证由主进程贴）`);
    }
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/**
 * 发一个请求并读完正文：**无进展**超过 `idleMs`、或总时长超过 `maxMs` 才中止。
 *
 * 以前用的是 `AbortSignal.timeout(30000)` —— 那是**整个请求**的总时限：慢线路上一篇 1.4 MB 的
 * 笔记还在稳定地传，30 秒一到照样被掐断，整轮同步失败重来（真机：2~3 分钟停在「正在同步」）。
 * 现在只要数据还在来就继续；挂死的连接（一个字节都不来）仍然 `idleMs` 后失败。
 * 与渲染层 `src/sync/http.ts` 的 `fetchWithIdleTimeout` 是同一个规则（两个运行时各写一份）。
 */
function spanText(ms) {
  return ms >= 1000 ? `${Math.round(ms / 1000)} 秒` : `${ms} 毫秒`;
}

async function fetchWithIdleTimeout(fetchFn, url, init, limits) {
  const idleMs = limits && typeof limits.idleMs === "number" ? limits.idleMs : 30000;
  const maxMs = limits && typeof limits.maxMs === "number" ? limits.maxMs : 10 * 60 * 1000;
  const controller = new AbortController();
  const timeoutError = (message) => Object.assign(new Error(message), { name: "TimeoutError" });
  let idleTimer;
  const armIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(timeoutError(`${spanText(idleMs)}没有收到任何数据`)), idleMs);
  };
  const maxTimer = setTimeout(() => controller.abort(timeoutError(`请求超过 ${spanText(maxMs)}`)), maxMs);
  // 中止时直接让正在等的那一步失败（理由见 src/sync/http.ts 的同名函数）。
  const aborted = new Promise((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  aborted.catch(() => undefined);
  armIdle();
  try {
    const response = await Promise.race([fetchFn(url, { ...init, signal: controller.signal }), aborted]);
    armIdle();
    const body = response.body;
    if (!body || typeof body.getReader !== "function") {
      return { response, bytes: new Uint8Array(await Promise.race([response.arrayBuffer(), aborted])) };
    }
    const reader = body.getReader();
    controller.signal.addEventListener("abort", () => void reader.cancel(controller.signal.reason).catch(() => undefined), { once: true });
    const parts = [];
    let total = 0;
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      parts.push(value);
      total += value.byteLength;
      armIdle();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return { response, bytes };
  } finally {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    clearTimeout(maxTimer);
  }
}

/**
 * 建一个**绑定到某个 base URL** 的代理。
 *
 * 注意签名：`createSyncProxy({ baseUrl })` 而不是 `createSyncProxy()` 后再传 url ——
 * base URL 是**建的时候定死**的，请求时只能给相对路径。
 * 这样「通用 fetch」在类型上就写不出来。
 */
function createSyncProxy(options) {
  const base = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl;
  const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 30000;
  const transport = options.transport;

  /**
   * 发一个请求。
   *
   * `authToken` 从**主进程**的取值函数拿（渲染层传不进来）。
   */
  async function request(input) {
    const method = String(input && input.method ? input.method : "GET").toUpperCase();
    if (!ALLOWED_METHODS.has(method)) throw new SyncProxyError(`不允许的方法：${method}`);
    const relPath = assertSafeRelPath(input && input.relPath);
    const url = composeUrl(base, relPath);
    const headers = sanitizeHeaders(input && input.headers);

    const token = typeof options.authToken === "function" ? options.authToken() : options.authToken;
    if (typeof token === "string" && token !== "") headers.Authorization = `Bearer ${token}`;

    const body = input && input.body !== undefined && input.body !== null ? input.body : undefined;

    if (typeof fetchImpl === "function") {
      const { response, bytes } = await fetchWithIdleTimeout(fetchImpl, url.toString(), { method, headers, body }, { idleMs: timeoutMs });
      return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: bytes };
    }
    if (typeof transport === "function") return transport({ method, url: url.toString(), headers, body, timeoutMs });
    throw new SyncProxyError("没有可用的传输实现（缺 fetchImpl / transport）");
  }

  return { request, baseUrl: base.base, origin: base.origin };
}

module.exports = {
  ALLOWED_METHODS,
  FORBIDDEN_HEADERS,
  SyncProxyError,
  assertSafeRelPath,
  composeUrl,
  createSyncProxy,
  fetchWithIdleTimeout,
  normalizeBaseUrl,
  sanitizeHeaders,
};
