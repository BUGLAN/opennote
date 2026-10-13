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
