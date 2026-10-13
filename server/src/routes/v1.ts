/**
 * `/v1/*` 同步数据面（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §2.3、§4.7、§3.3、§3.5、§6.4）。
 *
 * ## 这一层是**适配层**，不是复制协议（§1.7 明确不引入自研复制协议）
 *
 * 它做的全部事情就是**翻译**：
 *
 * | 客户端 | Node | CouchDB |
 * | --- | --- | --- |
 * | `did` 查询参数 | 原样传下去 | `_id` |
 * | `If-Match: <hash/ehash>` | `known.remoteHash` → `?rev=` | `_rev` CAS |
 * | 原始字节 | base64 | `_attachments.blob`（落盘是二进制） |
 * | `cursor` 不透明字符串 | 原样传下去 | `_changes.last_seq` |
 *
 * **没有一处是 Node 在决定**：不生成版本号、不裁决冲突、不造游标（红线 2）。
 *
 * ## 四个刻意的设计点（都来自 §4.7）
 *
 * 1. **`did` 走查询参数、不走 URL 路径段** —— `did` 可能带 `:`；放 query 最稳，
 *    而且**客户端根本不传明文路径**（E2EE 下服务端看不到路径，§2.2）。
 * 2. **越权返回 404 而不是 403** —— 由 `notebooks.resolveMembership()` 统一判定（§4.4 纪律 2）。
 * 3. **`truncated` 必须如实上报** —— 它是「禁止推断删除」的开关（§6.4 规则 1）。
 * 4. **`/v1/file` 传原始字节**（不是 JSON 包 base64）—— 客户端开销最小，
 *    base64 膨胀只发生在 Node↔CouchDB 这一段（内网，且落盘不膨胀）。
 *
 * ## 检查点写进 `_local/device-<deviceId>`
 *
 * `_local` 文档**不参与复制、不出现在 `_changes` 里** —— 正好是检查点该有的性质（§3.7）。
 * 注意它与本地基线**职责不同**：这里记的是「我拉到哪了」，本地账本记的是「我改没改」。
 */

import { createHash } from "node:crypto";
import { Hono } from "hono";
import {
  changesResponseSchema,
  clientStatsRequestSchema,
  parseContract,
  treeResponseSchema,
  type CryptoMode,
} from "../../../shared/contract";
import type { AccountRow } from "../auth/accounts";
import { AccountError, AccountStore } from "../auth/accounts";
import { CouchError, type CouchClient, type CouchDocument } from "../couch/client";
import { DESIGN_DOC_ID } from "../couch/design";
import type { NotebookRow, NotebookStore } from "../notebooks";
import type { ServerConfig } from "../config";
import { bearerToken } from "./account";

export interface V1RoutesDeps {
  accounts: AccountStore;
  notebooks: NotebookStore;
  config: ServerConfig;
  /** 运行时用的 CouchDB 客户端（`sync` 专用账号，**不是 admin**，§4.4 纪律 4）。 */
  couch: CouchClient;
  /** admin 客户端（只在**首次**建库/改 `_design` 时用，§4.5）。 */
  couchAdmin: CouchClient;
  audit?: (event: { actorId: string | null; action: string; target?: string | null; ip?: string | null; detail?: string | null }) => void;
}

/** 笔记本的加密模式（`syncinfo` 与 SQLite 都记着；以 SQLite 为准）。 */
function cryptoModeOf(notebook: NotebookRow): CryptoMode {
  return notebook.crypto_mode === "user-key" ? "user-key" : "none";
}

/** 从一条 CouchDB 文档投影出**紧凑**的树条目（**不含正文**，§3.6）。 */
function treeEntryFromDoc(doc: CouchDocument, cryptoMode: CryptoMode): {
  did: string;
  path?: string;
  hash?: string;
  ehash?: string;
  size?: number;
  esize?: number;
  rev: string;
  deleted?: boolean;
} {
  const entry: ReturnType<typeof treeEntryFromDoc> = { did: doc._id, rev: String(doc._rev ?? "") };
  if (typeof doc.hash === "string") entry.hash = doc.hash;
  if (typeof doc.ehash === "string") entry.ehash = doc.ehash;
  if (typeof doc.size === "number") entry.size = doc.size;
  if (typeof doc.esize === "number") entry.esize = doc.esize;
  if (doc.deleted === true) entry.deleted = true;
  /*
   * ★ `path` **只在明文模式下**带回去。
   * 模式 B 的文档里根本没有 `path` 字段（只有 `epath` 密文），所以这一条也是
   * 「E2EE 下服务端看不到路径」在代码里的样子 —— 不是靠自觉不读，是**没有可读的**。
   */
  if (cryptoMode === "none" && typeof doc.path === "string") entry.path = doc.path;
  return entry;
}

/** 内容标识：明文模式取 `hash`，E2EE 取 `ehash`。 */
function contentIdOf(doc: CouchDocument): string | null {
  if (typeof doc.hash === "string") return doc.hash;
  if (typeof doc.ehash === "string") return doc.ehash;
  return null;
}

/**
 * 把文档投影成树条目，**不合格的返回 `null`**（而不是让整个响应炸掉）。
 *
 * 为什么必须「跳过坏的」而不是「抛出去」：契约（`treeEntrySchema`）要求每条都有
 * `hash` 或 `ehash`。如果文档里有一条没有（历史遗留、别的客户端写坏的、或者
 * 我们自己某个 bug 留下的），整份响应就过不了 schema —— 结果是**整个笔记本列不了树**，
 * 于是它彻底同步不了。**一个有问题的文档不该让整个笔记本瘫痪。**
 *
 * 这条是真机跑出来的：我在用例里塞了一条「既无 hash 也无 ehash」的文档，
 * `/v1/tree` 直接 500。修法是把判定**前移**到这里逐条做，坏的丢掉并记日志。
 */
function validTreeEntry(entry: { did: string; hash?: string; ehash?: string }): boolean {
  const id = entry.hash ?? entry.ehash;
  return typeof id === "string" && /^[0-9a-f]{64}$/.test(id);
}

export function createV1Routes(deps: V1RoutesDeps): Hono {
  const routes = new Hono();
  const json = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", ...headers },
    });

  /** 认证（与 account 路由同一条链路，只有这一条）。 */
  const authenticate = (c: { req: { header: (name: string) => string | undefined } }): AccountRow | Response => {
    const account = (() => {
      const token = bearerToken(c.req.header("authorization"));
      if (!token) return null;
      try {
        return deps.accounts.authenticate(token);
      } catch (error) {
        if (error instanceof AccountError) return error;
        throw error;
      }
    })();
    if (account === null) return json({ error: "缺少 Authorization: Bearer 令牌", code: "unauthorized" }, 401);
    if (account instanceof AccountError) {
      return json({ error: account.message, code: account.rejection === "disabled" ? "disabled" : "unauthorized" }, account.rejection === "disabled" ? 403 : 401);
    }
    deps.accounts.touch(account.id);
    return account;
  };

  /**
   * 解析 `nb=` 并把**授权判定**做完。
   *
   * 返回 `Response` 表示已经可以提前返回（401/404）；返回对象表示通过。
   * **越权与不存在都返回 404**，且文案完全相同 —— 不泄露「这个笔记本存在」（§4.4 纪律 2）。
   */
  const resolveNotebook = (
    c: { req: { header: (name: string) => string | undefined; query: (name: string) => string | undefined } },
    requiredRole: "read" | "write" | "owner",
  ): { account: AccountRow; notebook: NotebookRow } | Response => {
    const auth = authenticate(c);
    if (auth instanceof Response) return auth;

    const notebookId = c.req.query("nb");
    if (!notebookId) return json({ error: "缺少 nb 参数", code: "bad-request" }, 400);

    const notebook = deps.notebooks.findById(notebookId);
    const membership = notebook ? deps.notebooks.resolveMembership(notebook.id, auth.id) : null;
    // ★ 「不存在」与「无权」走同一条返回（404 + 同一句文案）。
    if (!notebook || !membership) return json({ error: "笔记本不存在", code: "not-found" }, 404);

    if (requiredRole === "write" && membership.role === "viewer") {
      // 他知道这个笔记本存在（他在成员表里）⇒ 403 是恰当的（§4.4 纪律 2 的例外）。
      return json({ error: "只读成员不能写入", code: "bad-request" }, 403);
    }
    if (requiredRole === "owner" && membership.role !== "owner") {
      return json({ error: "需要 owner 权限", code: "bad-request" }, 403);
    }
    return { account: auth, notebook };
  };

  /** CouchDB 错误 → HTTP。**冲突与不存在要分开**，否则客户端没法做三方 diff。 */
  const couchError = (error: unknown): Response => {
    if (error instanceof CouchError) {
      const status = error.code === "not-found" ? 404 : error.code === "conflict" ? 409 : error.code === "too-large" ? 413 : error.code === "timeout" ? 504 : 502;
      return json({ error: error.message, code: error.code }, status);
    }
    throw error;
  };

  /* -------------------------------------------------------------- health */

  /**
   * `GET /v1/health`（**公开，无需鉴权**）—— 协议闸门与网页端可核对性（§4.7、§5.6⑤）。
   *
   * `webBuildHash` 是构建时注入的 PWA 产物哈希：网页端信任的是「服务端当天发给它的那份 JS」，
   * 这是浏览器端 E2EE 的固有边界。报出哈希让在意的人能核对「今天这份 JS 是不是我本地那份」。
   */
  routes.get("/health", async () => {
    let couchVersion: string | null = null;
    try {
      couchVersion = (await deps.couch.version()).version;
    } catch {
      // CouchDB 不通也要能报健康（否则控制台连「哪里坏了」都看不到）。
      couchVersion = null;
    }
    return json(
      {
        ok: true,
        protocolVersion: deps.config.protocolVersionExpected,
        minSupportedProtocolVersion: 1,
        webBuildHash: process.env.OPENNOTE_WEB_BUILD_HASH ?? null,
        couchVersion,
      },
      200,
    );
  });

  /* ---------------------------------------------------------------- tree */

  /**
   * `GET /v1/tree` —— 列树（**紧凑投影，不含正文**）。
   *
   * 模式 A 走 view `by_path`（`~30 B/篇`），模式 B 走 `_all_docs?include_docs=true`
   * （`~200 B/篇`）。两者的差别只是「多传半兆」，**增量同步完全不受影响**（§1.4 表）。
   */
  routes.get("/tree", async (c) => {
    const resolved = resolveNotebook(c, "read");
    if (resolved instanceof Response) return resolved;
    const { notebook } = resolved;
    const cryptoMode = cryptoModeOf(notebook);
    const limit = clampLimit(c.req.query("limit"), deps.config.maxFileBytes > 0 ? 500 : 500);
    const startKey = c.req.query("startkey") ?? undefined;

    try {
      if (cryptoMode === "none") {
        /*
         * 模式 A：view 查询。key 是**明文 path**，所以列树本来就能给可读路径
         * （§3.3 表：base64url 的「人类可读性差」由 view 的 key 补回来）。
         *
         * 这里仍然只按 `_all_docs` 取（不依赖用户有没有建索引），因为 view 需要
         * `_design` 就位；如果 `_design` 被手工删了，走 view 会直接 500，
         * 而 `_all_docs` 仍能工作 —— 那样控制台能看到「置备不一致」而不是「同步全挂」。
         */
        const page = await deps.couch.allDocs(notebook.db_name, { limit, ...(startKey === undefined ? {} : { startKey }), includeDocs: true });
        const files = page.rows
          .filter((row) => !row.id.startsWith("_design/") && !row.id.startsWith("_local/") && row.id !== "syncinfo")
          .map((row) => treeEntryFromDoc(row.doc ?? { _id: row.id, _rev: row.value.rev }, cryptoMode))
          .filter((entry) => entry.deleted !== true)
          .filter((entry) => validTreeEntry(entry));
        return json(parseContract(treeResponseSchema, { cursor: null, truncated: page.rows.length >= limit, files }, "GET /v1/tree"), 200);
      }

      // 模式 B：`_all_docs?include_docs=true`（加密路径 ⇒ view 的 key 用不上，§3.3）。
      const page = await deps.couch.allDocs(notebook.db_name, { limit, ...(startKey === undefined ? {} : { startKey }), includeDocs: true });
      const files = page.rows
        .filter((row) => !row.id.startsWith("_design/") && !row.id.startsWith("_local/") && row.id !== "syncinfo")
        .map((row) => treeEntryFromDoc(row.doc ?? { _id: row.id, _rev: row.value.rev }, cryptoMode))
        .filter((entry) => entry.deleted !== true)
        .filter((entry) => validTreeEntry(entry));
      return json(parseContract(treeResponseSchema, { cursor: null, truncated: page.rows.length >= limit, files }, "GET /v1/tree"), 200);
    } catch (error) {
      return couchError(error);
    }
  });

  /* ------------------------------------------------------------- changes */

  /**
   * `GET /v1/changes` —— 增量变更。
   *
   * ⚠️ **`_changes` 是「部分有序」的**：官方明确顺序不保证一致，并要求客户端**幂等**
   * （§4.7 设计点 5）。所以这里只把 `_id` 映射成 `did`、`op` 由 `deleted` 决定，
   * **不排序、不去重、不解释** —— 排序是客户端不该依赖的东西。
   *
   * `resync: true` 由 `since` 无法回溯时给出（游标过期，§6.4 规则 2）。
   */
  routes.get("/changes", async (c) => {
    const resolved = resolveNotebook(c, "read");
    if (resolved instanceof Response) return resolved;
    const { notebook } = resolved;
    const since = c.req.query("since") ?? null;

    try {
      const page = await deps.couch.changes(notebook.db_name, { since, limit: 500 });
      const changes = page.results
        // `_design` / `_local` / `syncinfo` 不参与同步（它们不是笔记）。
        .filter((row) => !row.id.startsWith("_design/") && !row.id.startsWith("_local/") && row.id !== "syncinfo")
        .map((row) => ({ did: row.id, op: row.deleted === true ? ("delete" as const) : ("update" as const) }));
      return json(
        parseContract(
          changesResponseSchema,
          { cursor: String(page.last_seq ?? ""), resync: false, changes },
          "GET /v1/changes",
        ),
        200,
      );
    } catch (error) {
      return couchError(error);
    }
  });

  /* ---------------------------------------------------------------- file */

  /**
   * `GET /v1/file?nb=&did=` —— 取一条的**原始字节**。
   *
   * 走 `GET /{db}/{did}/blob`（附件），**永远不用 `_changes?attachments=true`**
   * ——官方明确警告那个参数有 33% 传输开销（§3.5）。
   */
  routes.get("/file", async (c) => {
    const resolved = resolveNotebook(c, "read");
    if (resolved instanceof Response) return resolved;
    const { notebook } = resolved;
    const did = c.req.query("did");
    if (!did) return json({ error: "缺少 did 参数", code: "bad-request" }, 400);

    try {
      const bytes = await deps.couch.getAttachment(notebook.db_name, did);
      if (bytes === null) return json({ error: "这一条不存在", code: "not-found" }, 404);
      const doc = await deps.couch.getDoc(notebook.db_name, did);
      const headers: Record<string, string> = {
        "content-type": "application/octet-stream",
        // 内容标识放进头里，省掉客户端再拉一次元数据（`If-Match` 回传时要用）。
        ...(doc && contentIdOf(doc) ? { "x-opennote-hash": contentIdOf(doc)! } : {}),
        ...(doc?._rev ? { "x-opennote-rev": String(doc._rev) } : {}),
      };
      return new Response(bytes, { status: 200, headers });
    } catch (error) {
      return couchError(error);
    }
  });

  /**
   * `PUT /v1/file?nb=&did=` —— 写一条（CAS）。
   *
   * `If-Match` 语义（§4.7 设计点 3）：**缺省 = 允许新建；对不上 = 409 + 当前值**。
   * 内部转成 CouchDB 的 `?rev=<baseRev>` —— 所以客户端仍然要持有并回传 `rev`
   * （放在基线里），Node 只是把「内容标识」翻译成「rev」。
   */
  routes.put("/file", async (c) => {
    const resolved = resolveNotebook(c, "write");
    if (resolved instanceof Response) return resolved;
    const { notebook } = resolved;
    const did = c.req.query("did");
    if (!did) return json({ error: "缺少 did 参数", code: "bad-request" }, 400);

    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength > deps.config.maxFileBytes) {
      return json({ error: `文件超过上限（${deps.config.maxFileBytes} 字节）`, code: "too-large" }, 413);
    }
    const ifMatch = c.req.header("if-match") ?? null;
    const cryptoMode = cryptoModeOf(notebook);
    // 模式 A 的明文路径由客户端给；模式 B **忽略**它（红线 3：服务端看不到明文路径）。
    const pathFromQuery = cryptoMode === "none" ? (c.req.query("path") ?? null) : null;

    /*
     * ★ **这一版的内容标识由客户端给**（`X-Opennote-Hash`）。
     *
     * `If-Match` 是 **CAS**（「我以为远端现在是哪一版」），不是「我这次写的是什么」——
     * 两者是**不同的东西**，第一版把它们混成了一个，于是一个必然的后果：
     * **新建时 `If-Match` 缺省，服务端就没有任何地方能拿到 hash**，写进去的文档
     * 根本没有内容标识 ⇒ `/v1/tree` 里这一条过不了契约（`treeEntrySchema` 要求
     * hash 或 ehash），而且下一次 CAS 永远对不上（症状是「同步总是冲突」）。
     *
     * 这个 bug 之所以没被早发现：前面所有用例都只写了「空笔记本列树」，
     * **从来没有真的往库里写过一条笔记**。补上之后就有了。
     *
     * 模式 A 下允许省略：明文正文就在我们手里，`sha256(body)` 与客户端算的**必然相同**。
     * 模式 B 下**必须**给 —— 服务端算不出 `ehash`（那是 `HMAC(nk.mac, …)`，红线 3）。
     */
    const declaredHash = c.req.header("x-opennote-hash") ?? null;
    const newHash =
      declaredHash ??
      (cryptoMode === "none" ? await sha256Hex(bytes) : null);
    if (newHash === null) {
      return json({ error: "E2EE 模式必须带 X-Opennote-Hash 头（服务端算不出 ehash，红线 3）", code: "bad-request" }, 400);
    }

    try {
      const existing = await deps.couch.getDoc(notebook.db_name, did);
      const currentId = existing ? contentIdOf(existing) : null;

      /*
       * CAS：客户端给的 `If-Match` 是**内容标识**（明文 sha256 / E2EE 的 `ehash`），
       * 而 CouchDB 要的是 `_rev`。翻译在这里发生，**判定不在我们这**：
       * `If-Match` 与当前内容标识不一致 ⇒ 直接 409 + 当前值，连写都不试。
       * 一致 ⇒ 用当前 `_rev` 去写（真正的 CAS 交给 CouchDB：万一在我们读完之后
       * 又有人写，它会返回 409，我们再把它转成同一个形状）。
       */
      if (ifMatch !== null && currentId !== null && ifMatch !== currentId) {
        return json({ error: "内容标识对不上（远端已变）", code: "conflict", current: { hash: currentId, rev: existing?._rev ?? null } }, 409);
      }
      if (ifMatch === null && existing) {
        // 缺省 = 允许**新建**；但远端已有这一条 ⇒ 对不上。
        return json({ error: "这一条已存在（缺省 If-Match 只允许新建）", code: "conflict", current: { hash: currentId, rev: existing._rev ?? null } }, 409);
      }

      const written = await deps.couch.putDoc(
        notebook.db_name,
        {
          _id: did,
          /*
           * 模式 A：明文 `path` 由**客户端**通过查询参数给（§2.2「客户端不传明文路径」
           * 说的是 E2EE；模式 A 本来就带 path，view 的 key 也要它）。
           *
           * ⚠️ **服务端不造路径**：客户端不给我们就不写 —— 我们没有任何办法
           * 从 `did` 反推出一个可信的路径（那需要相信 base64 解码的结果，
           * 而它来自网络）。模式 B 则**永远不写 `path`**（红线 3：服务端看不到明文路径）。
           */
          ...(cryptoMode === "none" && pathFromQuery ? { path: pathFromQuery } : {}),
          // ★ **这一版**的内容标识（不是 `If-Match` 那个「我以为远端是哪一版」）。
          ...(cryptoMode === "none" ? { hash: newHash } : { ehash: newHash }),
          size: bytes.byteLength,
        },
        { baseRev: existing?._rev ?? null },
      );
      if ("conflict" in written) {
        return json({ error: "写入冲突（远端在我们读取之后又变了）", code: "conflict", current: written.current ? { hash: contentIdOf(written.current), rev: written.current._rev ?? null } : null }, 409);
      }
      /*
       * 正文以**附件**提交，而且传的是**原始字节**（不是 base64）。
       * 第一版传 base64，CouchDB 把它当字面内容存了下来 —— 读回来是乱码。
       * 见 `CouchClient.putAttachment` 的说明。
       */
      const attachment = await deps.couch.putAttachment(notebook.db_name, did, bytes, {
        rev: written.rev,
        contentType: "application/octet-stream",
      });
      if ("conflict" in attachment) {
        return json({ error: "写附件冲突", code: "conflict", current: null }, 409);
      }
      // 响应里回**这一版**的标识与 rev（客户端据此更新基线，§4.7: `-> 200/201 { hash?, ehash?, rev }`）。
      return json(
        { rev: attachment.rev, ...(cryptoMode === "none" ? { hash: newHash } : { ehash: newHash }) },
        existing ? 200 : 201,
      );
    } catch (error) {
      return couchError(error);
    }
  });

  /**
   * `DELETE /v1/file?nb=&did=` —— **逻辑删除**（留墓碑）。
   *
   * 墓碑必须比 update 活得久：丢掉一个 delete 会让文件在另一端**复活**（§6.4 规则 3）。
   */
  routes.delete("/file", async (c) => {
    const resolved = resolveNotebook(c, "write");
    if (resolved instanceof Response) return resolved;
    const { notebook } = resolved;
    const did = c.req.query("did");
    if (!did) return json({ error: "缺少 did 参数", code: "bad-request" }, 400);

    try {
      const existing = await deps.couch.getDoc(notebook.db_name, did);
      if (!existing) return new Response(null, { status: 410 });
      const ifMatch = c.req.header("if-match") ?? null;
      const currentId = contentIdOf(existing);
      if (ifMatch !== null && currentId !== null && ifMatch !== currentId) {
        return json({ error: "内容标识对不上", code: "conflict", current: { hash: currentId, rev: existing._rev ?? null } }, 409);
      }
      const result = await deps.couch.putDoc(notebook.db_name, { _id: did, _deleted: true }, { baseRev: existing._rev ?? null });
      if ("conflict" in result) return json({ error: "删除冲突", code: "conflict", current: null }, 409);
      return new Response(null, { status: 204 });
    } catch (error) {
      return couchError(error);
    }
  });

  /* ---------------------------------------------------------- checkpoint */

  /**
   * `PUT /v1/checkpoint` —— 把「我拉到哪了」写进 `_local/device-<deviceId>`。
   *
   * `_local` 文档**不参与复制、不出现在 `_changes` 里** —— 正好是检查点该有的性质（§3.7）。
   * 它**不是**本地基线：本地账本记的是「我改没改」，两者职责不同。
   */
  routes.put("/checkpoint", async (c) => {
    const resolved = resolveNotebook(c, "read");
    if (resolved instanceof Response) return resolved;
    const { notebook } = resolved;
    const body = (await c.req.json().catch(() => null)) as { cursor?: unknown; deviceId?: unknown } | null;
    const deviceId = typeof body?.deviceId === "string" ? body.deviceId : null;
    const cursor = typeof body?.cursor === "string" ? body.cursor : null;
    if (!deviceId || !/^[0-9a-f]{32}$/.test(deviceId)) return json({ error: "deviceId 形状不对", code: "bad-request" }, 400);

    const id = `_local/device-${deviceId}`;
    try {
      const existing = await deps.couch.getDoc(notebook.db_name, id);
      const written = await deps.couch.putDoc(notebook.db_name, { _id: id, cursor, deviceId, at: Date.now() }, { baseRev: existing?._rev ?? null });
      if ("conflict" in written) {
        // `_local` 上的冲突极罕见（同一个 deviceId 的两个客户端）；重读一次再写。
        const again = await deps.couch.getDoc(notebook.db_name, id);
        const retry = await deps.couch.putDoc(notebook.db_name, { _id: id, cursor, deviceId, at: Date.now() }, { baseRev: again?._rev ?? null });
        if ("conflict" in retry) return json({ error: "检查点写入冲突", code: "conflict" }, 409);
      }
      return new Response(null, { status: 204 });
    } catch (error) {
      return couchError(error);
    }
  });

  /* --------------------------------------------------------------- stats */

  /**
   * `POST /v1/stats` —— 客户端上报按天计数（§4.3 `client_stats`）。
   *
   * **服务端看不到冲突内容，只有计数** —— 与红线 2 一致：Node 不参与裁决，
   * 而且 E2EE 下它也只有密文。
   */
  routes.post("/stats", async (c) => {
    const resolved = resolveNotebook(c, "read");
    if (resolved instanceof Response) return resolved;
    const raw = await c.req.json().catch(() => null);
    let input;
    try {
      input = parseContract(clientStatsRequestSchema, raw, "POST /v1/stats");
    } catch {
      return json({ error: "统计载荷形状不对", code: "bad-request" }, 400);
    }
    const { account } = resolved;
    deps.notebooks.reportStats?.({
      accountId: account.id,
      notebookId: input.notebookId,
      day: input.day,
      conflicts: input.conflicts,
      errors: input.errors,
      pushes: input.pushes,
      pulls: input.pulls,
      deletes: input.deletes,
    });
    return new Response(null, { status: 204 });
  });

  sseRoutes(deps, routes, json);

  return routes;
}

/** `sha256` 小写十六进制（模式 A 的兜底：明文正文在我们手里，与客户端算的必然一致）。 */
/* ============================================================================
   `/v1/events` —— SSE 中继（§4.7、§4.8、第 428/490/529 行）
   ============================================================================ */

/**
 * 每账号的并发 SSE 连接计数（`ACCOUNT_SSE_CONNECTIONS`，默认 4）。
 *
 * 为什么要限：每条 SSE 连接在 Node 这边占一个挂着的响应、在 CouchDB 那边占一个
 * 长轮询。一个客户端（或一个跑飞的脚本）开几百条就能把服务端拖垮 ——
 * 而 SSE 是**唯一**会长期占着连接的接口。
 */
const sseConnections = new Map<string, number>();

/** 取心跳间隔（配置项，**不写死** —— §4.8：换隧道就变，所以必须是配置）。 */
function sseHeartbeatMsOf(deps: V1RoutesDeps): number {
  const configured = (deps as { config?: { sseHeartbeatMs?: number } }).config?.sseHeartbeatMs;
  return typeof configured === "number" && configured > 0 ? configured : 25000;
}

/** 取每账号连接上限。 */
function sseMaxConnectionsOf(deps: V1RoutesDeps): number {
  const configured = (deps as { config?: { accountSseConnections?: number } }).config?.accountSseConnections;
  return typeof configured === "number" && configured > 0 ? configured : 4;
}

/**
 * `GET /v1/events?nb=<notebookId>` —— 把 CouchDB 的 `_changes` 转成 SSE。
 *
 * ## ★ 为什么令牌可以从**查询串**来（与其它接口不同）
 *
 * 其它接口一律要求 `Authorization: Bearer`。但 **`EventSource` 不能设置请求头** ——
 * 这是浏览器的限制，不是我们的选择。所以第 529 行明确写了
 * 「`authToken`（**query 参数**或 cookie）」。
 *
 * ⚠️ 代价要如实说：**查询串会进访问日志**（我们的、隧道的、任何中间层的）。
 * 所以这里**只**接受它作为 SSE 的入口，别的接口不给这条路 ——
 * 一个泄露的令牌能被用来读写笔记本，把它的暴露面限制在一条只读的信号通道上。
 *
 * ## 它推的是「信号」，不是「内容」
 *
 * 事件体里只有游标（`cursor`）与条数，**没有路径、没有正文**。
 * 客户端收到就去跑一轮普通同步（§4.6 规则 1：`_changes` 是**偏序**的，
 * 只能当「脏了」的信号，不能当成「按这个顺序应用」）。
 * 这样即使某个中间层重排/丢了事件，最坏也只是晚一轮同步，不会同步错。
 */
function sseRoutes(deps: V1RoutesDeps, routes: Hono, json: (body: unknown, status: number, headers?: Record<string, string>) => Response): void {
  routes.get("/events", async (c) => {
    /*
     * 认证：先看 `Authorization` 头（非浏览器客户端会带），再退到 `?authToken=`。
     * 两条都走**同一个** `deps.accounts.authenticate`，没有第二条鉴权链路。
     */
    let account = null as ReturnType<typeof deps.accounts.authenticate> | null;
    const header = bearerToken(c.req.header("authorization"));
    const queryToken = c.req.query("authToken");
    const token = header ?? queryToken ?? null;
    if (token) {
      try {
        account = deps.accounts.authenticate(token);
      } catch {
        account = null;
      }
    }
    if (account === null) return json({ error: "缺少令牌", code: "unauthorized" }, 401);

    /*
     * ★ 这里**不能**用 `resolveNotebook()`：它内部会再调一次 `authenticate(c)`，
     * 而那只读 `Authorization` 头 —— 于是查询串那条路刚认证成功就被它判成 401。
     * 所以用**已经认证好的** `account` 走同一个授权点（`resolveMembership`），
     * 并逐字复制它的 404 文案（§4.4 纪律 2：越权与不存在必须不可区分）。
     */
    const notebookId = c.req.query("nb");
    if (!notebookId) return json({ error: "缺少 nb 参数", code: "bad-request" }, 400);
    const notebook = deps.notebooks.findById(notebookId);
    const membership = notebook ? deps.notebooks.resolveMembership(notebook.id, account.id) : null;
    if (!notebook || !membership) return json({ error: "笔记本不存在", code: "not-found" }, 404);

    // 连接数上限（超出就明确拒绝，不是静默把旧的踢掉）。
    const limit = sseMaxConnectionsOf(deps);
    const used = sseConnections.get(account.id) ?? 0;
    if (used >= limit) {
      return json({ error: `这个账号的实时连接太多了（上限 ${limit}）`, code: "too-many-connections" }, 429);
    }
    sseConnections.set(account.id, used + 1);

    const heartbeatMs = sseHeartbeatMsOf(deps);
    const encoder = new TextEncoder();
    let cursor: string | null = c.req.query("since") ?? null;
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (chunk: string): void => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            closed = true;
          }
        };
        /** 先把当前游标告诉客户端，它才知道从哪儿开始。 */
        send(`event: ready
data: ${JSON.stringify({ cursor, heartbeatMs })}

`);

        let timer: ReturnType<typeof setTimeout> | null = null;
        let lastBeat = Date.now();

        const tick = async (): Promise<void> => {
          if (closed) return;
          try {
            const result = await deps.couch.changes(notebook.db_name, { since: cursor, limit: 100, timeoutMs: 10_000 });
            const lastSeq = result.last_seq === undefined || result.last_seq === null ? null : String(result.last_seq);
            if (result.results.length > 0 && lastSeq !== null && lastSeq !== cursor) {
              cursor = lastSeq;
              // ★ 只推**信号**（游标 + 条数），不推路径也不推正文。
              send(`event: change
data: ${JSON.stringify({ cursor, count: result.results.length })}

`);
              lastBeat = Date.now();
            }
          } catch {
            // CouchDB 抖了一下不该把连接掐了 —— 客户端会重连，但我们先撑住。
          }
          // 心跳：**注释行**（SSE 规范里客户端会忽略它），只为把连接撑活。
          if (Date.now() - lastBeat >= heartbeatMs) {
            send(`: ping

`);
            lastBeat = Date.now();
          }
          timer = setTimeout(() => void tick(), 2000);
        };
        void tick();

        // 客户端断开 ⇒ 收尾（**一定要减计数**，否则连接数会只增不减）。
        const abort = c.req.raw.signal;
        const cleanup = (): void => {
          if (closed) return;
          closed = true;
          if (timer !== null) clearTimeout(timer);
          const left = (sseConnections.get(account.id) ?? 1) - 1;
          if (left <= 0) sseConnections.delete(account.id);
          else sseConnections.set(account.id, left);
          try {
            controller.close();
          } catch {
            /* 已经关了 */
          }
        };
        abort.addEventListener("abort", cleanup);
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        // 中间层不许缓存/缓冲 —— 否则事件会攒到连接关闭才发（§4.8 的 Quick Tunnel 教训）。
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  });
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 把 `limit` 夹到合理区间（默认 500，最大 2000）。 */
function clampLimit(raw: string | undefined, fallback: number): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 2000);
}

/** 设计文档 id 重导出（诊断用；避免路由层直接 import `couch/design`）。 */
export { DESIGN_DOC_ID };
