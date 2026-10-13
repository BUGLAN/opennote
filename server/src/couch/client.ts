/**
 * CouchDB HTTP 客户端（**手写 `fetch`，约 200 行**，§4.1 选型）。
 *
 * ## 这一层只做四件事（红线 2：Node 不重造 CouchDB 的语义）
 *
 * | 做 | 不做 |
 * | --- | --- |
 * | 拼 URL、带 Basic 认证、解 JSON | ❌ 生成版本号 —— `_rev` 是 CouchDB 给的 |
 * | 把 HTTP 状态映射成**机器可读的 code** | ❌ 冲突裁决 —— 由用户裁决（§6.1） |
 * | 超时与重试（只重试**幂等**请求） | ❌ 检查点存储 —— 那是 `_local` 的职责 |
 * | 附件以 base64 提交、以原始字节读回 | ❌ 变更游标生成 —— 那是 `_changes` 的 `last_seq` |
 *
 * **"Node 只做鉴权 + 翻译 + 控制台"** 这句话在这一层的体现就是：这个文件里
 * 没有任何一个函数在**决定**什么，它只是在**搬运**。
 *
 * ## 三处刻意的实现选择
 *
 * ### ① 冲突是**正常结果**，不是异常
 *
 * `PUT` 拿 409 时要带回**当前文档**（`_rev` + 内容标识），否则调用方没法做三方 diff。
 * 所以 `putDoc()` 返回 `{ conflict: {...} }` 而不是抛 —— 与 `SyncProvider.put` 同一形状
 * （§4.7 设计点 3：`If-Match` 用内容哈希，对不上返回 409 + 当前值）。
 *
 * ### ② 只重试幂等请求
 *
 * `GET`/`HEAD` 遇到网络抖动可以重试；`PUT`/`POST`/`DELETE` **不重试** ——
 * 重试一次写请求可能产生第二个 leaf（在 CouchDB 里不算丢数据，但会让 revision tree
 * 长出一根用户看不懂的分支）。
 *
 * ### ③ 超时是**显式**的，且有默认值
 *
 * 边缘有 30 秒写超时（§1.3）。所以客户端这边必须**更早**放弃，否则我们会在边缘已经
 * 断掉之后还挂着一个连接。默认 20 秒读、10 秒写。
 */

import type { ServerConfig } from "../config";

/** CouchDB 交互失败：`code` 是机器可读的，调用方不必匹配文案。 */
export type CouchErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "conflict"
  | "bad-request"
  | "too-large"
  | "unavailable"
  | "timeout"
  | "network"
  | "server";

export class CouchError extends Error {
  constructor(
    readonly code: CouchErrorCode,
    message: string,
    readonly status: number | null = null,
    /** CouchDB 的响应体（诊断用；**绝不含密钥材料**）。 */
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = "CouchError";
  }
}

export interface CouchDocument {
  _id: string;
  _rev?: string;
  [key: string]: unknown;
}

export interface CouchClientOptions {
  /** 基址（不含尾斜杠），如 `http://couchdb:5984`。 */
  baseUrl: string;
  user: string;
  password: string;
  /** 单次请求超时（毫秒）。读操作与写操作分开 —— 写受边缘 30s 限制（§1.3）。 */
  readTimeoutMs?: number;
  writeTimeoutMs?: number;
  /** 注入用（测试）。默认真实 `fetch`。 */
  fetchImpl?: typeof fetch;
}

/** Basic 认证头。**唯一产地** —— 别处不许再拼一遍。 */
function basicAuth(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}

/** 把 HTTP 状态映射成机器可读的 code。 */
function codeForStatus(status: number): CouchErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 409) return "conflict";
  if (status === 413) return "too-large";
  if (status === 400) return "bad-request";
  if (status >= 500) return "unavailable";
  return "server";
}

export class CouchClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly readTimeoutMs: number;
  private readonly writeTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CouchClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.authHeader = basicAuth(options.user, options.password);
    this.readTimeoutMs = options.readTimeoutMs ?? 20_000;
    this.writeTimeoutMs = options.writeTimeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** 由配置造一个（运行时用 `sync` 专用账号，**不是 admin**，§4.4 纪律 4）。 */
  static fromConfig(config: ServerConfig, options: Omit<CouchClientOptions, "baseUrl" | "user" | "password"> = {}): CouchClient {
    return new CouchClient({ baseUrl: config.couchUrl, user: config.couchUser, password: config.couchPassword, ...options });
  }

  /** 建库/改 `_design` 用的 admin 客户端。**只在置备时用**（§4.5）。 */
  static adminFromConfig(config: ServerConfig, options: Omit<CouchClientOptions, "baseUrl" | "user" | "password"> = {}): CouchClient {
    return new CouchClient({
      baseUrl: config.couchUrl,
      user: config.couchAdminUser,
      password: config.couchAdminPassword,
      ...options,
    });
  }

  /** 服务端版本（`GET /`）。控制台与 `/v1/health` 都要它。 */
  async version(): Promise<{ version: string; vendor: string | null }> {
    const body = await this.request<{ couchdb?: string; version?: string; vendor?: { name?: string } }>("GET", "/", { idempotent: true });
    return { version: body.version ?? body.couchdb ?? "unknown", vendor: body.vendor?.name ?? null };
  }

  /** 库是否存在（`HEAD /{db}`）。 */
  async databaseExists(db: string): Promise<boolean> {
    try {
      await this.request("HEAD", `/${encodeURIComponent(db)}`, { idempotent: true });
      return true;
    } catch (error) {
      if (error instanceof CouchError && error.code === "not-found") return false;
      throw error;
    }
  }

  /**
   * 建库。**幂等**：已存在时返回 `false`（不是错误）—— 置备的重入要靠这一条（§4.5）。
   */
  async createDatabase(db: string): Promise<boolean> {
    try {
      await this.request("PUT", `/${encodeURIComponent(db)}`, {});
      return true;
    } catch (error) {
      if (error instanceof CouchError && error.code === "conflict") return false;
      throw error;
    }
  }

  /** 删库（账号删除时级联，§7.1）。已不存在时返回 `false`。 */
  async deleteDatabase(db: string): Promise<boolean> {
    try {
      await this.request("DELETE", `/${encodeURIComponent(db)}`, {});
      return true;
    } catch (error) {
      if (error instanceof CouchError && error.code === "not-found") return false;
      throw error;
    }
  }

  async databaseInfo(db: string): Promise<{ docCount: number; sizeBytes: number }> {
    const body = await this.request<{ doc_count?: number; sizes?: { active?: number; file?: number } }>(
      "GET",
      `/${encodeURIComponent(db)}`,
      { idempotent: true },
    );
    return { docCount: body.doc_count ?? 0, sizeBytes: body.sizes?.file ?? body.sizes?.active ?? 0 };
  }

  /** 读文档；不存在返回 `null`。 */
  async getDoc(db: string, id: string, options: { rev?: string; attachments?: boolean } = {}): Promise<CouchDocument | null> {
    const query = new URLSearchParams();
    if (options.rev) query.set("rev", options.rev);
    if (options.attachments) query.set("attachments", "true");
    const suffix = query.toString() ? `?${query}` : "";
    try {
      return await this.request<CouchDocument>("GET", `/${encodeURIComponent(db)}/${encodeDocId(id)}${suffix}`, { idempotent: true });
    } catch (error) {
      if (error instanceof CouchError && error.code === "not-found") return null;
      throw error;
    }
  }

  /**
   * 写文档（CAS）。
   *
   * `baseRev` 为 `null` 表示「允许新建」。**对不上时返回当前文档**而不是抛 ——
   * 冲突是正常业务结果，抛异常只会诱使调用方写一个宽泛的 catch 把它吞掉。
   */
  async putDoc(
    db: string,
    doc: CouchDocument,
    options: { baseRev?: string | null } = {},
  ): Promise<{ ok: true; rev: string } | { conflict: true; current: CouchDocument | null }> {
    const rev = options.baseRev ?? doc._rev ?? null;
    const query = rev ? `?rev=${encodeURIComponent(rev)}` : "";
    try {
      const body = await this.request<{ rev: string }>("PUT", `/${encodeURIComponent(db)}/${encodeDocId(doc._id)}${query}`, {
        body: JSON.stringify(doc),
      });
      return { ok: true, rev: body.rev };
    } catch (error) {
      if (error instanceof CouchError && error.code === "conflict") {
        return { conflict: true, current: await this.getDoc(db, doc._id) };
      }
      throw error;
    }
  }

  /**
   * 写 `_design/*` 文档（置备用，走 admin）。
   *
   * 与 `putDoc` 分开是因为它要**先读旧的 `_rev`** 才能更新 —— 而置备是幂等的：
   * 已经有 `_design` 时不覆盖（§4.5 验收要求「不自动重建」）。
   */
  async putDesignDoc(db: string, name: string, doc: Record<string, unknown>, options: { replace?: boolean } = {}): Promise<{ created: boolean }> {
    const id = `_design/${name}`;
    const existing = await this.getDoc(db, id);
    if (existing && !options.replace) return { created: false };
    if (existing && !existing._rev) throw new CouchError("server", `_design/${name} 存在但没有 _rev，无法更新`);
    const result = await this.putDoc(db, { ...doc, _id: id, ...(existing?._rev ? { _rev: existing._rev } : {}) }, { baseRev: existing?._rev ?? null });
    if ("conflict" in result) throw new CouchError("conflict", `更新 _design/${name} 时冲突（有人同时在改）`);
    return { created: existing === null };
  }

  /** 设置 `_security`（只留 `sync` 服务账号，§3.2）。 */
  async putSecurity(db: string, security: Record<string, unknown>): Promise<void> {
    await this.request("PUT", `/${encodeURIComponent(db)}/_security`, { body: JSON.stringify(security) });
  }

  /** 设置 `_revs_limit`（默认保留 1000，§3.10：调小会让三方合并失去共同祖先）。 */
  async putRevsLimit(db: string, limit: number): Promise<void> {
    await this.request("PUT", `/${encodeURIComponent(db)}/_revs_limit`, { body: JSON.stringify(limit) });
  }

  async getRevsLimit(db: string): Promise<number | null> {
    try {
      return await this.request<number>("GET", `/${encodeURIComponent(db)}/_revs_limit`, { idempotent: true });
    } catch (error) {
      if (error instanceof CouchError && error.code === "not-found") return null;
      throw error;
    }
  }

  /** `_all_docs?include_docs=true`（模式 B 的列树，§3.3）。 */
  async allDocs(
    db: string,
    options: { limit?: number; startKey?: string; includeDocs?: boolean } = {},
  ): Promise<{ rows: { id: string; key: string; value: { rev: string }; doc?: CouchDocument }[]; totalRows: number }> {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.startKey !== undefined) query.set("startkey", JSON.stringify(options.startKey));
    if (options.includeDocs) query.set("include_docs", "true");
    return this.request("GET", `/${encodeURIComponent(db)}/_all_docs?${query}`, { idempotent: true });
  }

  /** `_changes`（`feed=normal` 由调用方分页；SSE 中继用 `feed=continuous`，P3）。 */
  async changes(
    db: string,
    options: { since?: string | null; limit?: number; timeoutMs?: number } = {},
  ): Promise<{ results: { seq: unknown; id: string; deleted?: boolean }[]; last_seq: unknown; pending: number }> {
    const query = new URLSearchParams();
    if (options.since) query.set("since", options.since);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    return this.request("GET", `/${encodeURIComponent(db)}/_changes?${query}`, { idempotent: true, timeoutMs: options.timeoutMs });
  }

  /* ---------------------------------------------------------------- 附件 */

  /**
   * 读附件的**原始字节**（`GET /{db}/{docid}/blob`）。
   *
   * 为什么不用 `?attachments=true`：那会让 JSON 里带 base64，官方明确警告有 33%
   * 传输开销（§3.5）。所以我们**永远不用那个参数**，正文一律走这条路。
   */
  async getAttachment(db: string, id: string, name = "blob"): Promise<Uint8Array | null> {
    const response = await this.rawRequest(
      "GET",
      `/${encodeURIComponent(db)}/${encodeDocId(id)}/${encodeURIComponent(name)}`,
      { idempotent: true },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw await this.toError(response);
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * 写附件（**以 base64 提交** —— 这是 JSON 传输的固有开销，无法避免，§3.5）。
   * CouchDB 会**落盘存解码后的二进制**，所以存储不膨胀。
   */
  async putAttachment(
    db: string,
    id: string,
    base64: string,
    options: { rev: string; contentType?: string; name?: string },
  ): Promise<{ ok: true; rev: string } | { conflict: true }> {
    const query = new URLSearchParams({ rev: options.rev });
    if (options.contentType) query.set("content_type", options.contentType);
    try {
      const body = await this.request<{ rev: string }>(
        "PUT",
        `/${encodeURIComponent(db)}/${encodeDocId(id)}/${encodeURIComponent(options.name ?? "blob")}?${query}`,
        { body: base64, contentType: "application/json" },
      );
      return { ok: true, rev: body.rev };
    } catch (error) {
      if (error instanceof CouchError && error.code === "conflict") return { conflict: true };
      throw error;
    }
  }

  /* ------------------------------------------------------------- 传输层 */

  private async request<T>(
    method: string,
    path: string,
    options: { body?: string; idempotent?: boolean; contentType?: string; timeoutMs?: number },
  ): Promise<T> {
    const response = await this.rawRequest(method, path, options);
    if (!response.ok) throw await this.toError(response);
    // `HEAD` 没有响应体。
    if (method === "HEAD" || response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CouchError("server", `CouchDB 返回了非 JSON 响应（${path}）`, response.status, text.slice(0, 200));
    }
  }

  private async rawRequest(
    method: string,
    path: string,
    options: { body?: string; idempotent?: boolean; contentType?: string; timeoutMs?: number },
  ): Promise<Response> {
    const timeoutMs = options.timeoutMs ?? (options.body === undefined ? this.readTimeoutMs : this.writeTimeoutMs);
    // 只重试**幂等**请求（见模块头 ②）。写请求一次都不重试。
    const attempts = options.idempotent === true ? 2 : 1;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            authorization: this.authHeader,
            accept: "application/json",
            ...(options.body === undefined ? {} : { "content-type": options.contentType ?? "application/json" }),
          },
          ...(options.body === undefined ? {} : { body: options.body }),
          signal: controller.signal,
        });
        return response;
      } catch (error) {
        lastError = error;
        const aborted = error instanceof Error && error.name === "AbortError";
        if (aborted) {
          // 超时：**不重试**（同一台机器上再来一次几乎必然又超时，只是把延迟翻倍）。
          throw new CouchError("timeout", `CouchDB 请求超时（${timeoutMs}ms）：${method} ${path}`);
        }
        if (attempt >= attempts) break;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new CouchError("network", `连不上 CouchDB：${method} ${path}（${String(lastError)}）`);
  }

  private async toError(response: Response): Promise<CouchError> {
    const code = codeForStatus(response.status);
    let body: unknown = null;
    let detail = "";
    try {
      const text = await response.text();
      body = text ? JSON.parse(text) : null;
      detail = typeof (body as { reason?: string })?.reason === "string" ? (body as { reason: string }).reason : "";
    } catch {
      /* 非 JSON 错误体：忽略，只用状态码。 */
    }
    return new CouchError(code, `CouchDB ${response.status}${detail ? `：${detail}` : ""}`, response.status, body);
  }
}

/**
 * 文档 id 编码。
 *
 * `_design/opennote` 里的 `/` **必须保留**（CouchDB 的 design 文档就是那个形状），
 * 而我们的 `did` 形如 `f:bm90ZXM`（base64url，不含 `/`）或 `h:abcd…`（十六进制）。
 * 所以这里只对**非 design** 的 id 做转义，且只转义真正需要转义的字符。
 */
function encodeDocId(id: string): string {
  if (id.startsWith("_design/") || id.startsWith("_local/")) {
    const [prefix, ...rest] = id.split("/");
    return `${prefix}/${encodeURIComponent(rest.join("/"))}`;
  }
  return encodeURIComponent(id);
}
