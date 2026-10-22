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

  /**
   * 库信息。
   *
   * `updateSeq` 是**列树的游标来源**：客户端靠它记「我列到哪了」，下次拿它问
   * `_changes?since=`，从而在远端没变时**完全不列树**（增量同步的第一步）。
   *
   * 它来自 CouchDB 自己（红线 2：Node 不生成游标，只搬运）。
   */
  async databaseInfo(db: string): Promise<{ docCount: number; sizeBytes: number; updateSeq: string | null }> {
    const body = await this.request<{
      doc_count?: number;
      sizes?: { active?: number; file?: number };
      update_seq?: string | number;
    }>("GET", `/${encodeURIComponent(db)}`, { idempotent: true });
    return {
      docCount: body.doc_count ?? 0,
      sizeBytes: body.sizes?.file ?? body.sizes?.active ?? 0,
      updateSeq: body.update_seq === undefined || body.update_seq === null ? null : String(body.update_seq),
    };
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

  /**
   * 建/更新 `_users` 里的一个用户（幂等）。
   *
   * ## 为什么需要它（真机跑出来的缺口）
   *
   * 置备时我们写 `_security.members.names = [COUCH_USER]`（§7.3 第 2 条：运行时用**专用账号**、
   * 不是 admin）。但「专用账号」在 CouchDB 里**不是一条配置**，而是 `_users` 库里的一条文档。
   * 没有它的话，每一个笔记本请求都会 401 —— 而症状看起来像「服务端配置错了」。
   *
   * 这一条是在真 CouchDB 3.3.3 上验证过才发现的：单独验 `_security` 时我用 admin 打，
   * 一切正常；换成 `sync-service` 就 401，因为它根本不存在。
   *
   * 必须用 **admin** 客户端调（`_users` 只有 admin 能写）。
   */
  async ensureUser(name: string, password: string): Promise<{ created: boolean }> {
    const id = `org.couchdb.user:${name}`;
    const existing = await this.getDoc("_users", id).catch(() => null);
    const body = {
      _id: id,
      name,
      type: "user",
      // ★ 不给任何 `roles`：它**不是** admin，只有各笔记本 `_security.members` 给它的权限。
      roles: [] as string[],
      password,
    };
    await this.request("PUT", `/_users/${encodeURIComponent(id)}`, {
      body: JSON.stringify(existing?._rev === undefined ? body : { ...body, _rev: existing._rev }),
    });
    return { created: existing === null };
  }

  /** 读一个 `_users` 用户是否存在（**不返回任何口令材料**）。 */
  async userExists(name: string): Promise<boolean> {
    const doc = await this.getDoc("_users", `org.couchdb.user:${name}`).catch(() => null);
    return doc !== null;
  }

  /**
   * `_all_docs?include_docs=true`（模式 B 的列树，§3.3）。
   *
   * ⚠️ CouchDB 的 `startkey` 是**闭区间**（包含这一行本身）。分页时如果只传 `startkey = 上一页最后一条`，
   * 下一页会把同一条再取一次 —— 页与页重叠一行。客户端按 `did` 去重能挡住重复，
   * 但会白花一次取数，更重要的是让「有没有翻完」变得不精确。
   * 所以翻页时**同时传 `skip=1`**，把边界那一行排除掉。
   */
  async allDocs(
    db: string,
    options: { limit?: number; startKey?: string; skip?: number; includeDocs?: boolean } = {},
  ): Promise<{ rows: { id: string; key: string; value: { rev: string }; doc?: CouchDocument }[]; totalRows: number }> {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.startKey !== undefined) query.set("startkey", JSON.stringify(options.startKey));
    if (options.skip !== undefined && options.skip > 0) query.set("skip", String(options.skip));
    if (options.includeDocs) query.set("include_docs", "true");
    return this.request("GET", `/${encodeURIComponent(db)}/_all_docs?${query}`, { idempotent: true });
  }

  /**
   * `_changes`（`feed=normal`；SSE 中继用 `feed=continuous`，P3）。
   *
   * `includeDocs` 会带上每条变更的**文档正文**（不含附件）。我们用它不是为了正文，
   * 而是为了**同一趟拿回内容标识**：客户端要判断「这条变更是真的改了内容，
   * 还是只是换了个 rev」，有了 `hash`/`ehash` 就不必再为每条变更补一次 `GET /v1/file`
   * ——那是「变更驱动」比「整树比对」省下来的关键一步。
   */
  async changes(
    db: string,
    options: { since?: string | null; limit?: number; timeoutMs?: number; includeDocs?: boolean } = {},
  ): Promise<{
    results: { seq: unknown; id: string; deleted?: boolean; doc?: CouchDocument }[];
    last_seq: unknown;
    pending: number;
  }> {
    const query = new URLSearchParams();
    if (options.since) query.set("since", options.since);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.includeDocs) query.set("include_docs", "true");
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
  /**
   * 写附件（正文以**原始二进制**提交）。
   *
   * ## ⚠️ 这里曾经有一个「存进去的是 base64 文本」的 bug
   *
   * 第一版的签名是 `putAttachment(db, id, base64: string, …)`，实现是
   * `request("PUT", …, { body: base64, contentType: "application/json" })`。
   * 看起来像是「CouchDB 的 base64 附件上传」——**但它不是**。
   *
   * CouchDB 的 base64 上传要求 body 是一个 **JSON 字符串**（带引号的 `"<base64>"`）。
   * 传裸 base64 时，CouchDB 会把它当成**字面内容**存下来，并用请求的
   * `Content-Type` 作为附件的类型。真机上的证据：
   *
   *     "_attachments": { "blob": { "content_type": "application/json",
   *                                 "length": 28, "stub": true } }
   *
   * 明文是 20 字节，存进去 28 字节 —— 正是那串 base64 的长度。
   * 后果是**每一条笔记读回来都是 base64 文本**（客户端会写出一堆乱码），
   * 而单测发现不了：假 CouchDB 忠实复现了我的错误调用方式。
   *
   * ## 修法：直接传原始字节，连 base64 都不需要
   *
   * `fetch` 的 body 本来就支持 `Uint8Array`，所以 Node↔CouchDB 这一段
   * **完全没有 33% 膨胀**（§3.5 说「base64 是 JSON 传输的固有开销」——
   * 那是针对**客户端↔Node**那一跳的；内网这一跳可以传二进制）。
   * 顺带把「编/解码 base64」这个 bug 面整个删掉了。
   */
  async putAttachment(
    db: string,
    id: string,
    bytes: Uint8Array,
    options: { rev: string; contentType?: string; name?: string },
  ): Promise<{ ok: true; rev: string } | { conflict: true }> {
    const query = new URLSearchParams({ rev: options.rev });
    try {
      const body = await this.request<{ rev: string }>(
        "PUT",
        `/${encodeURIComponent(db)}/${encodeDocId(id)}/${encodeURIComponent(options.name ?? "blob")}?${query}`,
        { body: bytes, contentType: options.contentType ?? "application/octet-stream" },
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
    options: { body?: string | Uint8Array; idempotent?: boolean; contentType?: string; timeoutMs?: number },
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
    options: { body?: string | Uint8Array; idempotent?: boolean; contentType?: string; timeoutMs?: number },
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
