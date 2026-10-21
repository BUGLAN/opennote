/**
 * 账号与笔记本管理的 HTTP 客户端（`/v1/account`、`/v1/notebooks`）。
 *
 * ## 为什么不复用 `HttpTransport`
 *
 * `HttpTransport.url()` 会给**每一个**请求拼上 `?nb=` —— 那是「笔记本维度」的
 * 约定，而注册 / 解锁 / 建笔记本都发生在「还没有笔记本」或「与具体笔记本无关」的
 * 时刻。这里用最朴素的一个 `send` + JSON 约定，错误也走 `{error, code}` 形状。
 *
 * ## 桌面端的出网路径与同步一致
 *
 * 发送函数统一走 `resolveSend()`：桌面端经主进程代理（CSP 不放宽），网页端直接
 * `fetch`。注册发生在「还没有令牌」的时刻，`resolveSend` 允许不带令牌 ——
 * 主进程代理对空令牌只是不注入 Authorization 头（`electron/sync.cjs` 的 request）。
 */

import { resolveSend, type HttpSend } from "./http";

export interface NotebookSummary {
  notebookId: string;
  name: string;
  role: string;
  cryptoMode: "none" | "user-key";
  protocolVersion: number;
  createdAt?: string;
}

export interface RegisterResponse {
  accountId: string;
  isAdmin: boolean;
  protocolVersion: number;
}

export interface UnlockResponse {
  accountId: string;
  wrappedEncRoot: string;
  quota: { bytesUsed: number; bytesLimit: number; notebooks: number; notebooksLimit: number };
  protocolVersion: number;
}

/** 服务端把 `{error, code}` 形状的错误翻成带状态的异常（`code` 是机器可读的）。 */
export class AccountApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "AccountApiError";
  }
}

export interface AccountApi {
  register(input: {
    accountId: string;
    authToken: string;
    wrappedEncRoot: string;
    bootstrapCode?: string;
    inviteCode?: string;
    label?: string;
  }): Promise<RegisterResponse>;
  unlock(): Promise<UnlockResponse>;
  listNotebooks(): Promise<{ notebooks: NotebookSummary[] }>;
  createNotebook(input: { name: string; cryptoMode: "none" | "user-key" }): Promise<NotebookSummary>;
}

export async function openAccountApi(
  options: { baseUrl: string; authToken?: string },
  /** 测试注入（默认 `resolveSend`：桌面走主进程代理，网页直接 fetch）。 */
  send?: HttpSend,
): Promise<AccountApi> {
  const base = options.baseUrl.replace(/\/+$/, "");
  const sendFn = send ?? (await resolveSend({ baseUrl: options.baseUrl, authToken: options.authToken ?? "" }));
  const authHeaders: Record<string, string> = options.authToken ? { authorization: `Bearer ${options.authToken}` } : {};

  async function request<T>(method: "GET" | "POST", path: string, jsonBody?: unknown): Promise<T> {
    const response = await sendFn({
      method,
      url: `${base}${path}`,
      headers: {
        ...authHeaders,
        ...(jsonBody === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(jsonBody === undefined ? {} : { body: JSON.stringify(jsonBody) }),
    });
    const text = new TextDecoder().decode(response.bytes);
    if (response.status < 200 || response.status >= 300) {
      let message = `同步服务返回 ${response.status}`;
      let code: string | undefined;
      try {
        const parsed = JSON.parse(text) as { error?: unknown; code?: unknown };
        if (typeof parsed.error === "string") message = parsed.error;
        if (typeof parsed.code === "string") code = parsed.code;
      } catch {
        /* 不是 JSON（反代错误页等）：保留默认文案 */
      }
      throw new AccountApiError(response.status, message, code);
    }
    return (text === "" ? null : JSON.parse(text)) as T;
  }

  return {
    register: (input) => request<RegisterResponse>("POST", "/v1/account", input),
    unlock: () => request<UnlockResponse>("POST", "/v1/account/unlock"),
    listNotebooks: () => request<{ notebooks: NotebookSummary[] }>("GET", "/v1/notebooks"),
    createNotebook: (input) => request<NotebookSummary>("POST", "/v1/notebooks", input),
  };
}
