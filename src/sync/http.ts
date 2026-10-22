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
  /**
   * **客户端限速**：每秒最多发多少个请求。默认 12（0 或负数 = 不限速）。
   *
   * ## 为什么客户端必须自己限速（而不是「撞了 429 再说」）
   *
   * 服务端的桶是按**分钟**给的，而这个协议是「**一篇笔记 = 一个请求**」。
   * 客户端只要有 8 个请求在飞（RTT≈190ms 时就是 28~43 请求/秒），就会在十几秒内
   * 把服务端的桶打空 —— 然后**所有** worker 一起被 429，一起按 `Retry-After`
   * 干等 30+ 秒。用户看到的是「同步卡死」，而带宽一点没用上。
   *
   * 12/秒 是实测的折中：500 篇 ≈ 40 秒（比 2 篇/秒的旧限流快 20 倍），
   * 而它低于服务端账号桶（默认 1200/分钟 = 20/秒），所以正常同步**不会**撞 429。
   */
  requestsPerSecond?: number;
  /** 允许的突发（初始令牌数）。默认 = 2 秒的量（至少 4）。 */
  burst?: number;
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
export interface FetchSendOptions {
  /**
   * 单次请求的超时（毫秒）。默认 30000，**与桌面代理对齐**（`electron/sync.cjs` 的默认值）。
   *
   * 没有它的时候：一条挂起却不失败的连接（中间设备静默丢包）会让这个 worker **永远等下去** ——
   * 同步状态停在「同步中」，不进重试、也不报离线（L6）。
   */
  timeoutMs?: number;
  /** 测试注入（默认 `globalThis.fetch`）。 */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

/**
 * 造一个「到点必失败」的 signal。
 *
 * 优先用 `AbortSignal.timeout`（现代浏览器 / Node 18+）；没有它就退回
 * `AbortController` + `setTimeout`，并在 `finally` 里清掉定时器
 * （否则 Node 侧的测试进程会被一个挂着的定时器拖住）。
 */
function timeoutSignal(ms: number): { signal: AbortSignal; cancel: () => void } {
  const anyAbort = AbortSignal as unknown as { timeout?: (value: number) => AbortSignal };
  if (typeof anyAbort.timeout === "function") {
    return { signal: anyAbort.timeout(ms), cancel: () => undefined };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

export function fetchSend(options: FetchSendOptions = {}): HttpSend {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const call: (url: string, init: RequestInit) => Promise<Response> =
    options.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  return async (request) => {
    const { signal, cancel } = timeoutSignal(timeoutMs);
    try {
      const response = await call(request.url, {
        method: request.method,
        headers: request.headers,
        signal,
        ...(request.body === undefined ? {} : { body: request.body as BodyInit }),
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return { status: response.status, headers, bytes: new Uint8Array(await response.arrayBuffer()) };
    } finally {
      cancel();
    }
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

  /*
   * ---- 实时推送（SSE 中继）----
   *
   * 三个都是**可选**的：旧版 preload 没有它们，那时桌面端只是没有实时（启动/保存/
   * 回前台/手动四个触发源照常工作），不会报错。
   *
   * 为什么必须走主进程：桌面 CSP 的 `connect-src` 不放 https，
   * 渲染层里 `new EventSource(远端)` 会被静默拦掉（见 `desktopStream.ts` 模块头）。
   */
  /** 开一条流（**相对** base 的路径）。主进程会把其中的 `authToken` 换成自己保管的那份。 */
  openStream?(relPath: string): Promise<unknown>;
  /** 关掉当前这条。 */
  closeStream?(): Promise<unknown>;
  /** 订阅主进程推来的事件（`open` / `ready` / `change` / `heartbeat` / `error`）。 */
  onStreamEvent?(listener: (message: { type: string; data?: string }) => void): () => void;
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
 * **客户端限速器 + 429 全局冷却**（令牌桶）。
 *
 * ## 它解决的两个具体问题
 *
 * ### ① 不要在「没撞之前」把桶打空
 *
 * 没有它的时候，8 个 worker 会在十几秒内把服务端的分钟桶吃光；有了它，
 * 请求是被**平滑**放出去的（默认 12/秒），服务端那边永远有余额。
 *
 * ### ② 429 是**全局**事件，不是「这一个请求难受」
 *
 * 以前的退避是「谁被 429 谁自己 `sleep(Retry-After)`」：8 个 worker 各睡一份，
 * 醒来又同时冲（没有协调、没有降速），下个窗口继续撞 —— 这就是「429 很频繁」的来源。
 * 现在 429 把**整个 pacer** 打进冷却：所有 worker 一起停到 `Retry-After` 结束，
 * 恢复时速率**减半**（说明我们比服务端的桶快），之后每成功一次慢慢加回去。
 */
export class Pacer {
  private tokens: number;
  /** 上次补充令牌的时刻（pacer 自己的时钟，见 `currentTime()`）。 */
  private updatedAt: number;
  private cooldownUntil = 0;
  /** 当前速率（429 之后会被减半，成功后慢慢回到配置值）。 */
  private rate: number;
  /**
   * 注入的 `sleep` 没睡够时补上的时间（测试里 `sleep: async () => {}` 很常见）。
   *
   * 不补的话，冷却循环会因为「睡完了时钟没动」而**永远转下去**（一个真实的踩坑）。
   */
  private virtualElapsed = 0;

  constructor(
    private readonly configuredRate: number,
    private readonly capacity: number,
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {
    this.rate = configuredRate;
    this.tokens = capacity;
    this.updatedAt = now();
  }

  /** 此刻（真实时钟 + 补偿量）。 */
  private currentTime(): number {
    return this.now() + this.virtualElapsed;
  }

  /** 睡到 `currentTime()` 至少前进 `ms` —— 注入的 sleep 偷懒时由虚拟时间补齐。 */
  private async waitAtLeast(ms: number): Promise<void> {
    const before = this.now();
    await this.sleep(ms);
    const slept = this.now() - before;
    if (slept < ms) this.virtualElapsed += ms - slept;
  }

  /** 取一个令牌（必要时等）。`configuredRate <= 0` 时不限速。 */
  async acquire(): Promise<void> {
    if (this.configuredRate <= 0) return;
    for (;;) {
      const at = this.currentTime();
      if (at < this.cooldownUntil) {
        await this.waitAtLeast(this.cooldownUntil - at);
        continue;
      }
      const elapsed = Math.max(0, at - this.updatedAt);
      this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.rate);
      this.updatedAt = at;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.waitAtLeast(Math.max(5, Math.ceil(((1 - this.tokens) / this.rate) * 1000)));
    }
  }

  /**
   * 被 429 打回：全局冷却 `delayMs`，并把速率减半（不低于 2/秒）。
   *
   * 冷却结束时**发一个令牌**：`Retry-After` 的语义就是「到那时候可以重试」，
   * 让重试再多等一个令牌间隔是没必要的（那会白等 100~500ms）。
   * 冷却期间**不攒令牌**（`updatedAt` 推到冷却结束）—— 否则冷却一过就是满桶齐发，
   * 下一个窗口再撞一次。
   */
  penalize(delayMs: number): void {
    const at = this.currentTime();
    this.cooldownUntil = Math.max(this.cooldownUntil, at + Math.max(1000, delayMs));
    this.updatedAt = Math.max(this.updatedAt, this.cooldownUntil);
    this.tokens = 1;
    this.rate = Math.max(2, this.rate / 2);
  }

  /** 成功一次就慢慢把速率加回去（每 50 次回到配置值的等量）。 */
  reward(): void {
    if (this.rate < this.configuredRate) {
      this.rate = Math.min(this.configuredRate, this.rate + this.configuredRate / 50);
    }
  }
}

/**
 * 一次请求 + 限速 + 退避重试 + 错误映射。
 *
 * 退避用**指数 + 抖动**：多个客户端同时被限流时，固定退避会让它们同步重试、再一起撞上来。
 * 抖动让它们错开（这是限流场景下唯一有效的做法）。
 */
/* ============================================================================
   ★ 账号级的共享令牌桶（L9）
   ============================================================================ */

/**
 * 进程内的「服务地址 + 账号」→ 令牌桶表。
 *
 * ## 为什么必须共享
 *
 * 服务端的限流键是 **账号**（`server/src/ratelimit.ts` 用 `sha256(authToken)` 分桶），
 * 而客户端以前每个 `HttpTransport` 各建一个 Pacer —— 同一账号挂两个工作区，
 * 合计就是 2×12 req/s，集中撞 429；撞了之后两个桶还各自冷却、各自减半，互相不知道。
 *
 * ## 为什么键里不带明文令牌
 *
 * 与 `ratelimit.ts` 同一手法：只存一个**短哈希**（FNV-1a）。它不是凭据，也不进日志。
 *
 * ## 为什么注入了时钟就不共享
 *
 * 单测给每个 transport 各注入一套虚拟时钟（`now` / `sleep`）；共享会让它们互相干扰，
 * 测出来的就不是自己的行为了。生产环境永远用默认时钟 ⇒ 永远共享。
 */
const sharedPacers = new Map<string, Pacer>();

/** FNV-1a（32 位）—— 只用来做**桶键**，不做任何安全判断。 */
function bucketHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** 诊断/测试用：当前共享了几个桶。 */
export function sharedPacerCount(): number {
  return sharedPacers.size;
}

/** 测试用：清空共享表（避免用例互相污染）。 */
export function resetSharedPacersForTests(): void {
  sharedPacers.clear();
}

export class HttpTransport {
  private readonly options: Required<Pick<HttpTransportOptions, "maxRetries" | "baseDelayMs" | "requestsPerSecond" | "burst">> &
    HttpTransportOptions;
  private readonly pacer: Pacer;

  constructor(options: HttpTransportOptions) {
    this.options = { maxRetries: 3, baseDelayMs: 500, requestsPerSecond: 12, burst: 24, ...options };
    const rate = this.options.requestsPerSecond;
    const capacity = Math.max(1, this.options.burst);
    const clock = options.now ?? (() => Date.now());
    // 与 `send()` 用同一个 sleep（测试注入的那一个），否则冷却在测试里不生效。
    const sleeper = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const shareable = options.now === undefined && options.sleep === undefined;
    const key = shareable ? `${this.options.baseUrl}|${bucketHash(this.options.authToken)}` : null;
    if (key === null) {
      this.pacer = new Pacer(rate, capacity, clock, sleeper);
    } else {
      const existing = sharedPacers.get(key);
      if (existing !== undefined) {
        this.pacer = existing;
      } else {
        const created = new Pacer(rate, capacity, clock, sleeper);
        sharedPacers.set(key, created);
        this.pacer = created;
      }
    }
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

  /** 发一次请求（**含**限速与重试）。返回原始响应；非 2xx 由调用方决定是「业务结果」还是错误。 */
  async send(
    request: Omit<HttpRequest, "url" | "headers"> & { path: string; query?: Record<string, string | number | undefined>; headers?: Record<string, string> },
  ): Promise<HttpResponse> {
    const send = this.options.send ?? fetchSend();
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const url = this.url(request.path, request.query);
    const label = `${request.method} ${request.path}`;
    let attempt = 0;
    let lastError: unknown = null;

    for (;;) {
      attempt += 1;
      /*
       * ★ 先过限速器：正常同步在这里被**平滑**放出去；
       *   上一次 429 留下的冷却也在这里生效（所有 worker 一起等）。
       */
      await this.pacer.acquire();
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

        if (response.status === 429) {
          /*
           * ★ 限流要**全局**处理：把 pacer 打进冷却（不是自己睡一觉），
           *   冷却结束前所有 worker 都不再发请求。
           */
          const retryAfter = Number.parseInt(response.headers["retry-after"] ?? "", 10);
          const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.backoff(attempt);
          this.pacer.penalize(delay);
          // 把服务端的「哪一档」带进日志：撞的是账号桶还是全局桶，一眼能分。
          const limit = response.headers["x-ratelimit-limit"];
          this.options.log?.(
            `[sync] 远端 429${limit === undefined ? "" : `（限额 ${limit}/分钟）`}，${delay}ms 后重试（第 ${attempt} 次）：${label}`,
          );
          if (attempt > this.options.maxRetries) return response;
          continue;
        }

        if (!isRetryable(response.status) || attempt > this.options.maxRetries) {
          // 服务端有正常应答 ⇒ 速率可以慢慢回到配置值。
          this.pacer.reward();
          return response;
        }
        // 服务端给了 `Retry-After` 就听它的（秒）；5xx 用指数退避。
        const retryAfter = Number.parseInt(response.headers["retry-after"] ?? "", 10);
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.backoff(attempt);
        this.options.log?.(`[sync] 远端 ${response.status}，${delay}ms 后重试（第 ${attempt} 次）：${label}`);
        await sleep(delay);
      } catch (error) {
        lastError = error;
        if (attempt > this.options.maxRetries) {
          throw new SyncProviderError("network", `连不上同步服务：${error instanceof Error ? error.message : String(error)}`, null);
        }
        const delay = this.backoff(attempt);
        this.options.log?.(`[sync] 请求失败（${error instanceof Error ? error.message : String(error)}），${delay}ms 后重试（第 ${attempt} 次）：${label}`);
        await sleep(delay);
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
