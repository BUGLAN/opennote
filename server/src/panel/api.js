/*
 * 取数层：同源 fetch + cookie 会话 + CSRF 头。
 *
 * - 会话令牌在 HttpOnly cookie 里，这个文件**碰不到它**：只管让浏览器带上（`credentials: same-origin`）。
 * - 每个请求都带 `X-Requested-With: opennote-panel`。服务端对带 cookie 的变更请求要求这个头
 *   （跨源页面发不出自定义头，见 server/src/panelSecurity.ts）；GET 带着也无妨。
 * - 「是不是管理员」不在这里判断：页面只按 /v1/panel/session 决定画什么，真正的闸门是服务端的 401/403。
 */

export class ApiError extends Error {
  constructor(status, code, message, body) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

let onUnauthorized = null;

/** 控制台注册：任何接口回 401 时回到登录页（会话过期 / 在别处被吊销）。 */
export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

export async function request(method, path, body) {
  const headers = { "x-requested-with": "opennote-panel", accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new ApiError(0, "network", "连不上服务器，检查一下网络再试", null);
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new ApiError(response.status, (data && data.code) || "http", (data && data.error) || "请求失败（" + response.status + "）", data);
    if (response.status === 401 && onUnauthorized && path.startsWith("/v1/admin/")) onUnauthorized(error);
    throw error;
  }
  return data;
}

/*
 * ## 读的短缓存
 *
 * 控制台切页时每一页都要整页重新取数（经 Cloudflare 一次往返约 0.5 秒），来回点几下就是
 * 一次次「转圈 → 出内容」，看上去像整页刷新。这里给 GET 一个很短的缓存：
 * - 15 秒内再取同一个地址，直接给上一次的结果（并发的同一请求也只发一次）；
 * - **任何写操作**（POST / PATCH / DELETE）都清空整个缓存 —— 写完之后的重画一定是新数据；
 * - 取失败的不留（下次照常重试）。
 * 点当前所在那一项导航会先 `invalidate()`，等于「刷新这一页」。
 */
const CACHE_TTL_MS = 15_000;
const cache = new Map();

export function invalidate() {
  cache.clear();
}

export function get(path) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = request("GET", path);
  cache.set(path, { at: Date.now(), promise });
  promise.catch(() => {
    if (cache.get(path)?.promise === promise) cache.delete(path);
  });
  return promise;
}

async function write(method, path, body) {
  invalidate();
  try {
    return await request(method, path, body);
  } finally {
    // 请求在飞的时候别的页面可能又取过一次旧数据，写完再清一次。
    invalidate();
  }
}

export const post = (path, body) => write("POST", path, body === undefined ? {} : body);
export const patch = (path, body) => write("PATCH", path, body);
export const del = (path) => write("DELETE", path);
