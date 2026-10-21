/**
 * 同步的传输层（`docs/执行-三端同步…` §5.2 `src/sync/http.ts`、§4.7、§4.10）。
 *
 * ## 为什么把 fetch 单独包一层
 *
 * 三个理由，每一个都对应一个具体的坑：
 *
 * 1. **桌面端的 CSP 不允许直连任何 https**（`connect-src 'self' file:`，§5.3 明确「不放宽 CSP」）。
 *    所以桌面端必须**转发到主进程**去发请求。把「怎么发」收在一个地方，换宿主（网页/桌面/移动）
 *    就只改这一处，provider 完全不用知道。
 * 2. **退避必须统一**：`429` 带 `Retry-After`、5xx、网络错误，三种都要退避；
 *    如果每个 provider 各自写一遍，迟早有一处忘了退避而去撞限流（服务端有 ℹ️ 全局限流）。
 * 3. **`SyncProviderError` 的 code 映射只该有一份**（见 `codeForStatus`）——
 *    文案与 code 分散在多处时，UI 会开始匹配字符串。
 *
 * ## 401 的语义：**「密钥已被轮换」**（这是文档明确拍板的，不是我猜的）
 *
 * §1.5 代价 2 / 第 271 行 / 第 2030 行三处都写了同一件事：
 *
 * > 客户端收到 401 时要给明确文案：「此设备的密钥已被轮换，请导入新密钥」
 *
 * 依据是**概率**：`authToken` 是 256 位随机值的派生，一个「手抖打错」的密钥几乎不可能
 * 恰好命中另一个账号。所以 401 在实践中就是「这台设备的密钥过期了」。
 * 把它当成「密钥输错了」会让用户去反复重输一个其实没问题的密钥。
 *
 * ⚠️ 唯一的例外是**真的换了密钥**（用户在另一台设备上导入了一个不同的账号）——
 * 那时 401 也是对的：新密钥还没生效，应当去导入。所以这个映射没有歧义。
 */

import { SyncProviderError, type SyncProviderError as SyncProviderErrorType } from "./provider-types";

/** 一次 HTTP 请求的描述（宿主无关）。 */
export interface HttpRequest {
  method: "GET" | "PUT" | "POST" | "DELETE";
  url: string;
  headers: Record<string, string>;
  /** 请求体（二进制；`undefined` = 无体）。 */
  body?: Uint8Array | string;
}

/** 宿主的响应（只保留我们需要的那几个字段，免得把 `Response` 泄漏到 provider 里）。 */
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  bytes: Uint8Array;
}

/**
 * 宿主提供的发送函数。
 *
 * - 网页 / 移动端：直接用 `fetch`（`globalThis.fetch`）。
 * - 桌面端：转发到主进程（`electron/main.cjs` 代理），因为 CSP 不放宽。
 *
 * ⚠️ 它**不负责退避** —— 退避在 `HttpTransport` 里做，这样三个宿主行为一致。
 */
export type HttpSend = (request: HttpRequest) => Promise<HttpResponse>;

export interface HttpTransportOptions {
  baseUrl: string;
  /** 每次请求都带 `Authorization: Bearer <authToken>`。 */
  authToken: string;
  notebookId: string;
  send?: HttpSend;
  /** 重试次数（对 429 / 5xx / 网络错误）。默认 3。 */
  maxRetries?: number;
  /** 基础退避毫秒（指数增长）。默认 500。 */
  baseDelayMs?: number;
  /** 睡多久（测试注入；默认 `setTimeout`）。 */
  sleep?: (ms: number) => Promise<void>;
  /** 日志（默认静默 —— 客户端不该在控制台刷屏）。 */
  log?: (line: string) => void;
  /** 现在几点（测试注入）。 */
  now?: () => number;
}

/**
 * 用 `globalThis.fetch` 实现的默认发送函数（网页 / 移动端）。
 *
 * 桌面端**不该**用它 —— 那里的 CSP 不允许直连外部 https（§5.3）。
 */
export function fetchSend(): HttpSend {
  return async (request) => {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body as BodyInit }),
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { status: response.status, headers, bytes: new Uint8Array(await response.arrayBuffer()) };
  };
}

/* ============================================================================
   桌面端的发送函数（转发到主进程，§5.5）
   ============================================================================ */

/** preload 暴露的那一小块代理接口。 */
export interface DesktopSyncBridge {
  /** 设置同步服务地址（换主机时主进程会弹**原生**确认框）。 */
  configure(baseUrl: string): Promise<{ baseUrl: string; changed: boolean }>;
  /** 把派生好的令牌交给主进程（之后逐请求由它贴）。 */
  setAuthToken(token: string): Promise<boolean>;
  /** 发一个**相对**请求。`body` 过 IPC 用普通数组（结构化克隆对 `Uint8Array` 的支持各宿主不一）。 */
  request(input: {
    method: string;
    relPath: string;
    headers: Record<string, string>;
    body?: number[];
  }): Promise<{ status: number; headers: Record<string, string>; body: number[] }>;
}

/** 取 `window.opennote.syncProxy`（非桌面端或旧版 preload 时为 null）。 */
export function desktopSyncBridge(): DesktopSyncBridge | null {
  const scope = globalThis as { window?: { opennote?: { isElectron?: boolean; syncProxy?: DesktopSyncBridge } } };
  const bridge = scope.window?.opennote;
  if (!bridge?.isElectron || !bridge.syncProxy) return null;
  return bridge.syncProxy;
}

/**
 * 用主进程代理实现的发送函数（桌面端）。
 *
 * ## ★ 这里要把「绝对 URL」翻成「相对路径」，而这一步是**安全相关**的
 *
 * 主进程的代理**只接受相对路径**（`electron/sync.cjs`：那是防止一次 XSS
 * 借主进程把笔记外发的核心）。所以这里必须：
 *
 * 1. 断言请求 URL 的 **origin** 与配置的 base 相同；
 * 2. 断言路径落在 base 的子路径之下；
 * 3. 只把**路径 + 查询串**送过去。
 *
 * 第 1、2 条是**冗余**（主进程还会再判一次）—— 但冗余在这里是刻意的：
 * 主进程那道是最后一道，而这里的错误信息能直接指出「provider 拼出了一个越界的 URL」，
 * 比主进程抛的「跑出了 base」更接近根因。
 */
export function desktopSend(bridge: DesktopSyncBridge, baseUrl: string): HttpSend {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");

  return async (request) => {
    const url = new URL(request.url);
    if (url.origin !== base.origin) {
      throw new Error(`同步请求跑出了配置的服务地址（${url.origin} ≠ ${base.origin}）`);
    }
    if (basePath !== "" && !url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
      throw new Error(`同步请求跑出了配置的子路径（${url.pathname}）`);
    }
    const result = await bridge.request({
      method: request.method,
      relPath: url.pathname + url.search,
      // ★ 剥掉渲染层自己带的 authorization —— 主进程代理**拒绝**渲染层传它
      //   （electron/sync.cjs 的 sanitizeHeaders：「凭证由主进程贴」）。
      //   令牌在 resolveSend 里已经一次性交给了主进程（setAuthToken），
      //   之后逐请求由主进程注入。HttpTransport 无条件带的那个头在这里消失，
      //   桌面端安全模型才成立（真机实测：不剥则每个请求都被拒）。
      headers: stripAuthorization(request.headers),
      ...(request.body === undefined ? {} : { body: toByteArray(request.body) }),
    });
    return { status: result.status, headers: result.headers, bytes: Uint8Array.from(result.body) };
  };
}

/** 凭证只由主进程注入 —— 渲染层带来的任何形态的 authorization 一律剥离。 */
function stripAuthorization(headers: Record<string, string>): Record<string, string> {
  const rest = { ...headers };
  delete rest.authorization;
  delete rest.Authorization;
  return rest;
}

/** 把 `Uint8Array | string` 统一成普通数组（过 IPC）。 */
function toByteArray(body: Uint8Array | string): number[] {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return Array.from(bytes);
}

/**
 * 按宿主挑发送函数。
 *
 * - 桌面端（有 `window.opennote.syncProxy`）⇒ 走主进程代理，并**先把 base 与令牌登记过去**；
 * - 其它宿主 ⇒ 直接 `fetch`（移动端 Capacitor WebView 不受桌面 CSP 约束）。
 */
export async function resolveSend(options: { baseUrl: string; authToken: string }): Promise<HttpSend> {
  const bridge = desktopSyncBridge();
  if (!bridge) return fetchSend();
  // 换主机时主进程会弹原生确认框 —— 用户拒绝的话这里会抛，同步就不会开始（正确行为）。
  await bridge.configure(options.baseUrl);
  await bridge.setAuthToken(options.authToken);
  return desktopSend(bridge, options.baseUrl);
}

const textDecoder = new TextDecoder();

/**
 * HTTP 状态 → `SyncProviderError.code`。
 *
 * 放在这里（而不是各 provider 里）是为了**只有一份映射**：UI 依赖 code 而不是文案。
 */
export function codeForStatus(status: number, serverCode?: string): SyncProviderError["code"] {
  if (status === 401) return "rotated"; // 见模块头：文档拍板「401 = 密钥已被轮换」
  if (status === 403) return serverCode === "disabled" ? "rotated" : "forbidden";
  if (status === 404) return "not-found";
  if (status === 409) return "conflict";
  if (status === 413) return "quota";
  if (status === 429) return "network"; // 限流：可重试，归到「暂时不行」
  if (status >= 500) return "server";
  return "server";
}

/** 这条错误值不值得重试（429 / 5xx / 网络都值得；401/403/404/409/413 都不值得）。 */
export function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * 一次请求 + 退避重试 + 错误映射。
 *
 * 退避用**指数 + 抖动**：多个客户端同时被限流时，固定退避会让它们同步重试、再一起撞上来。
 * 抖动让它们错开（这是限流场景下唯一有效的做法）。
 */
export class HttpTransport {
  private readonly options: Required<Pick<HttpTransportOptions, "maxRetries" | "baseDelayMs">> & HttpTransportOptions;

  constructor(options: HttpTransportOptions) {
    this.options = { maxRetries: 3, baseDelayMs: 500, ...options };
  }

  /** 笔记本相关的 URL 前缀（`?nb=` 是笔记本维度，§4.7）。 */
  private url(path: string, query: Record<string, string | number | undefined> = {}): string {
    const base = this.options.baseUrl.replace(/\/+$/, "");
    const params = new URLSearchParams();
    params.set("nb", this.options.notebookId);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      params.set(key, String(value));
    }
    return `${base}${path}?${params.toString()}`;
  }

  /** 发一次请求（**含**重试）。返回原始响应；非 2xx 由调用方决定是「业务结果」还是错误。 */
  async send(
    request: Omit<HttpRequest, "url" | "headers"> & { path: string; query?: Record<string, string | number | undefined>; headers?: Record<string, string> },
  ): Promise<HttpResponse> {
    const send = this.options.send ?? fetchSend();
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const url = this.url(request.path, request.query);
    let attempt = 0;
    let lastError: unknown = null;

    for (;;) {
      attempt += 1;
      try {
        const response = await send({
          method: request.method,
          url,
          headers: {
            authorization: `Bearer ${this.options.authToken}`,
            ...(request.body === undefined ? {} : { "content-type": "application/octet-stream" }),
            ...request.headers,
          },
          ...(request.body === undefined ? {} : { body: request.body }),
        });
        if (!isRetryable(response.status) || attempt > this.options.maxRetries) return response;
        // 服务端给了 `Retry-After` 就听它的（秒）。
        const retryAfter = Number.parseInt(response.headers["retry-after"] ?? "", 10);
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.backoff(attempt);
        this.options.log?.(`[sync] 远端 ${response.status}，${delay}ms 后重试（第 ${attempt} 次）`);
        await sleep(delay);
      } catch (error) {
        lastError = error;
        if (attempt > this.options.maxRetries) {
          throw new SyncProviderError("network", `连不上同步服务：${error instanceof Error ? error.message : String(error)}`, null);
        }
        await sleep(this.backoff(attempt));
      }
    }
    // 不可达（上面的 for(;;) 只通过 return / throw 退出）——留着是为了让类型收敛。
    throw new SyncProviderError("network", `请求失败：${String(lastError)}`, null);
  }

  /** 指数退避 + 抖动（±25%）。 */
  private backoff(attempt: number): number {
    const base = this.options.baseDelayMs * 2 ** (attempt - 1);
    const jitter = base * 0.25 * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(base + jitter));
  }

  /** 发一次请求，并把**非 2xx 转成 `SyncProviderError`**（用于那些「失败就是失败」的端点）。 */
  async request<T>(
    input: Omit<HttpRequest, "url" | "headers"> & { path: string; query?: Record<string, string | number | undefined>; headers?: Record<string, string> },
    parse: (response: HttpResponse) => T,
  ): Promise<T> {
    const response = await this.send(input);
    if (response.status < 200 || response.status >= 300) {
      throw this.errorFrom(response);
    }
    return parse(response);
  }

  /** 把响应转成 `SyncProviderError`（含服务端的 `{error, code}` 文案）。 */
  errorFrom(response: HttpResponse): SyncProviderErrorType {
    let message = `同步服务返回 ${response.status}`;
    let serverCode: string | undefined;
    try {
      const parsed = JSON.parse(textDecoder.decode(response.bytes)) as { error?: string; code?: string };
      if (typeof parsed?.error === "string") message = parsed.error;
      if (typeof parsed?.code === "string") serverCode = parsed.code;
    } catch {
      // 不是 JSON（例如反代返回的 HTML 错误页）：保留默认文案。
    }
    return new SyncProviderError(codeForStatus(response.status, serverCode), message, response.status);
  }

  /** 解析 JSON 响应体。 */
  static json<T>(response: HttpResponse): T {
    return JSON.parse(textDecoder.decode(response.bytes)) as T;
  }
}
