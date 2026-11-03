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

export const get = (path) => request("GET", path);
export const post = (path, body) => request("POST", path, body === undefined ? {} : body);
export const patch = (path, body) => request("PATCH", path, body);
export const del = (path) => request("DELETE", path);
