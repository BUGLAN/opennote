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
  filesBatchRequestSchema,
  filesBatchResponseSchema,
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
  /*
   * CouchDB 的删除标记是 `_deleted`（带下划线）；`deleted` 是**我们自己的**字段形状
   * （§3.4 的文档形状里有它）。两个都认，否则一个带 hash 的墓碑会被当成活文档列进树里
   * （当前被 `validTreeEntry` 的「必须有 hash」兜住，但那是巧合，不该依赖）。
   */
  if (doc._deleted === true || doc.deleted === true) entry.deleted = true;
  /*
   * ★ `path` **只在明文模式下**带回去。
   * 模式 B 的文档里根本没有 `path` 字段（只有 `epath` 密文），所以这一条也是
   * 「E2EE 下服务端看不到路径」在代码里的样子 —— 不是靠自觉不读，是**没有可读的**。
   */
  if (cryptoMode === "none" && typeof doc.path === "string") entry.path = doc.path;
  return entry;
}

/**
 * 服务端记账用的「天」（`YYYY-MM-DD`，**UTC**）。
 *
 * 为什么是 UTC 而不是服务器本地时区：控制台的按天聚合要把多个来源的同一 `day`
 * 合进一行，而服务器可能被部署在任何时区（compose 里默认就是 UTC）。
 * 用本地时区会让同一份数据在换机器后前后错开一天。
 *
 * 这里只影响**服务端实测**的 `sync_activity`；`client_stats` 的 `day` 是客户端
 * 自己给的（它按设备本地时区算）。两套不混表，所以这个差异不会串味。
 */
function utcDayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
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

  /**
   * 记一次**服务端实测**的同步活动。
   *
   * ## 为什么要在这里记账（而不是等客户端上报）
   *
   * 控制台的流量图与冲突热点读的是 `client_stats`，而那个上报（`POST /v1/stats`）
   * **当前客户端根本没有调用** —— 于是页面永远显示「没有同步计数」，
   * 而同步其实一直在跑。服务端有全部证据（请求是它接的、409 是它回的），
   * 所以它在**自己**这条路径上记一份（`sync_activity`，与客户端那份分表存）。
   *
   * 记账失败**绝不**影响请求本身：这是可观测性，不是正确性。所以整段吞掉异常
   * 只留日志 —— 一个「因为统计写不进去所以笔记同步失败」的实现是不可接受的。
   */
  const record = (
    accountId: string,
    notebookId: string,
    kind: "pull" | "push" | "delete" | "conflict" | "error",
    amount = 1,
  ): void => {
    try {
      deps.notebooks.recordActivity({ accountId, notebookId, day: utcDayOf(Date.now()), kind, amount });
    } catch (error) {
      console.warn("[opennote-server] 同步活动记账失败（不影响请求）", error);
    }
  };

  /** CouchDB 错误 → HTTP。**冲突与不存在要分开**，否则客户端没法做三方 diff。 */
  const couchError = (error: unknown, context?: { accountId: string; notebookId: string }): Response => {
    if (error instanceof CouchError) {
      // CouchDB 那一侧出错了 —— 这是控制台「冲突与异常」页要看到的**错误**计数。
      if (context) record(context.accountId, context.notebookId, "error");
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
    const { notebook, account } = resolved;
    /*
     * 列树 = 一次**拉取**（客户端问「远端现在有什么」）。
     * 记在**解析成功之后、真正去读 CouchDB 之前**：越权的请求根本到不了这里，
     * 而 CouchDB 坏掉的那一次仍算「客户端拉了一次」（它确实试过了）。
     */
    record(account.id, notebook.id, "pull");
    const cryptoMode = cryptoModeOf(notebook);
    /*
     * 页大小与 `maxFileBytes` **无关**（以前这里写的是 `maxFileBytes > 0 ? 500 : 500`，
     * 两个分支一模一样 —— 死代码，且误导读者以为它们有关系）。
     * 客户端会自己带 `limit`（引擎默认 1000），这里只是"没带时的默认值"。
     */
    const limit = clampLimit(c.req.query("limit"), DEFAULT_TREE_PAGE_SIZE);
    const startKey = c.req.query("startkey") ?? undefined;

    try {
      /*
       * ★ `cursor` 以前**恒为 null** —— 于是客户端 `syncOnce()` 的检查点永远写不进去，
       * 增量同步也就无从谈起（`changes({since: null})` 每次都从头列全部变更）。
       * 现在把它填成 CouchDB 自己的 `update_seq`：这是「列树这一刻」的游标，
       * 由 CouchDB 生成、Node 只搬运（红线 2）。
       */
      const cursor = await currentCursor(deps, notebook.db_name);
      if (cryptoMode === "none") {
        /*
         * 模式 A：view 查询。key 是**明文 path**，所以列树本来就能给可读路径
         * （§3.3 表：base64url 的「人类可读性差」由 view 的 key 补回来）。
         *
         * 这里仍然只按 `_all_docs` 取（不依赖用户有没有建索引），因为 view 需要
         * `_design` 就位；如果 `_design` 被手工删了，走 view 会直接 500，
         * 而 `_all_docs` 仍能工作 —— 那样控制台能看到「置备不一致」而不是「同步全挂」。
         */
        // `skip: 1` 把上一页最后那一条排掉 —— CouchDB 的 `startkey` 是闭区间，不排就会页页重叠。
        const page = await deps.couch.allDocs(notebook.db_name, {
          limit,
          ...(startKey === undefined ? {} : { startKey, skip: 1 }),
          includeDocs: true,
        });
        const files = page.rows
          .filter((row) => !row.id.startsWith("_design/") && !row.id.startsWith("_local/") && row.id !== "syncinfo")
          .map((row) => treeEntryFromDoc(row.doc ?? { _id: row.id, _rev: row.value.rev }, cryptoMode))
          .filter((entry) => entry.deleted !== true)
          .filter((entry) => validTreeEntry(entry));
        const truncated = page.rows.length >= limit;
        /*
         * ★ 翻页锚点取**原始行**的最后一条（`page.rows` 是过滤之前的）。
         * 用可见条目的最后一条会在「整页都被过滤掉」时无锚可走（M2）。
         */
        const nextStartKey = truncated ? page.rows.at(-1)?.id : undefined;
        return json(
          parseContract(
            treeResponseSchema,
            { cursor, truncated, ...(nextStartKey === undefined ? {} : { nextStartKey }), files },
            "GET /v1/tree",
          ),
          200,
        );
      }

      // 模式 B：`_all_docs?include_docs=true`（加密路径 ⇒ view 的 key 用不上，§3.3）。
      // `skip: 1` 把上一页最后那一条排掉 —— CouchDB 的 `startkey` 是闭区间，不排就会页页重叠。
        const page = await deps.couch.allDocs(notebook.db_name, {
          limit,
          ...(startKey === undefined ? {} : { startKey, skip: 1 }),
          includeDocs: true,
        });
      const files = page.rows
        .filter((row) => !row.id.startsWith("_design/") && !row.id.startsWith("_local/") && row.id !== "syncinfo")
        .map((row) => treeEntryFromDoc(row.doc ?? { _id: row.id, _rev: row.value.rev }, cryptoMode))
        .filter((entry) => entry.deleted !== true)
        .filter((entry) => validTreeEntry(entry));
      const truncated = page.rows.length >= limit;
      const nextStartKey = truncated ? page.rows.at(-1)?.id : undefined;
      return json(
        parseContract(
          treeResponseSchema,
          { cursor, truncated, ...(nextStartKey === undefined ? {} : { nextStartKey }), files },
          "GET /v1/tree",
        ),
        200,
      );
    } catch (error) {
      return couchError(error, { accountId: account.id, notebookId: notebook.id });
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
    const { notebook, account } = resolved;
    record(account.id, notebook.id, "pull");
    const since = c.req.query("since") ?? null;

    try {
      const cryptoMode = cryptoModeOf(notebook);
      /*
       * ★ `include_docs=true`：同一趟把**内容标识**带回来。
       *
       * 客户端要拿它判断「这条变更是真的改了内容，还是只是换了个 rev」。
       * 没有它，每条变更都得再补一次 `GET /v1/file` —— 那正是「变更驱动」想省掉的东西。
       * 附件**不会**被带进来（我们从来不读 `attachments=true`），所以这里拿到的
       * 只是几百字节的元数据，不是正文。
       */
      const page = await deps.couch.changes(notebook.db_name, { since, limit: 500, includeDocs: true });
      const changes = page.results
        // `_design` / `_local` / `syncinfo` 不参与同步（它们不是笔记）。
        .filter((row) => !row.id.startsWith("_design/") && !row.id.startsWith("_local/") && row.id !== "syncinfo")
        .map((row) => {
          const op = row.deleted === true ? ("delete" as const) : ("update" as const);
          const entry: {
            did: string;
            op: "delete" | "update";
            path?: string;
            hash?: string;
            ehash?: string;
          } = { did: row.id, op };
          if (op === "update" && row.doc) {
            // 明文模式下 `path` 是可以带回去的（服务端本来就看得见，见 `treeEntryFromDoc`）。
            if (cryptoMode === "none" && typeof row.doc.path === "string") entry.path = row.doc.path;
            const contentId = contentIdOf(row.doc);
            if (contentId) {
              if (cryptoMode === "none") entry.hash = contentId;
              else entry.ehash = contentId;
            }
          }
          return entry;
        });
      return json(
        parseContract(
          changesResponseSchema,
          {
            cursor: String(page.last_seq ?? ""),
            resync: false,
            // `pending > 0` ⇒ 这一页没装下。客户端必须退回整树，不能只按这一页办事。
            truncated: (page.pending ?? 0) > 0,
            changes,
          },
          "GET /v1/changes",
        ),
        200,
      );
    } catch (error) {
      /*
       * ★ 游标过期（流水被裁剪 / 换了库）⇒ **明确回 resync**，让客户端退化成全树比对。
       *
       * 以前这里一律 `resync: false`，而客户端拿到 400 只会把整轮同步判失败。
       * 现在只要带着 `since` 来问却问不出来，就按 Joplin 的 `resyncRequired` 语义办事
       * （§6.4 规则 2）—— 这是唯一一处允许「降级」的地方。
       */
      if (since !== null && error instanceof CouchError && error.code === "bad-request") {
        return json(parseContract(changesResponseSchema, { cursor: "", resync: true, changes: [] }, "GET /v1/changes"), 200);
      }
      return couchError(error, { accountId: account.id, notebookId: notebook.id });
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
    const { notebook, account } = resolved;
    const did = c.req.query("did");
    if (!did) return json({ error: "缺少 did 参数", code: "bad-request" }, 400);
    record(account.id, notebook.id, "pull");

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
      return couchError(error, { accountId: account.id, notebookId: notebook.id });
    }
  });

  /* --------------------------------------------------------------- 批量取 */

  /**
   * `POST /v1/files` —— **一次取多条正文**（`dids` 数组）。
   *
   * 存在的唯一理由：**把请求数从「等于文件数」压到「文件数 / 批量」**。
   * 只按 `/v1/file` 一条一条取时，500 篇笔记就是 500 次往返，吞吐被往返延迟钉死
   * （实测串行 5 篇/秒），限流也得跟着文件数涨。批量之后 500 篇 = 5 个请求。
   *
   * 三条纪律：
   * 1. **只读**（用 `POST` 只是因为 did 太多放不进 URL），不产生任何版本语义；
   * 2. 找不到 / 没有内容标识的条目**直接跳过**，不编造 —— 客户端按「跳过 = 远端没有这一条」处理；
   * 3. 单条超限时整批 413，让客户端退回单条路径拿到准确的错误，而不是静默截断。
   */
  routes.post("/files", async (c) => {
    const resolved = resolveNotebook(c, "read");
    if (resolved instanceof Response) return resolved;
    const { notebook, account } = resolved;
    // 一批 = 一次拉取（不是「每篇一次」）：记账要跟着**请求**走，不是跟着文件数走。
    record(account.id, notebook.id, "pull");

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return json({ error: "请求体不是合法 JSON", code: "bad-request" }, 400);
    }
    /*
     * 请求体用 `safeParse` 而不是 `parseContract`：后者是给**响应**用的（失败 = 服务端 bug ⇒ 500）。
     * 这里是**线上来的输入**，不合法就是客户端的错 ⇒ 400，而且要带上人能看懂的原因。
     */
    const checked = filesBatchRequestSchema.safeParse(payload);
    if (!checked.success) {
      return json({ error: `dids 必须是 1..200 个合法标识：${checked.error.issues[0]?.message ?? "形状不对"}`, code: "bad-request" }, 400);
    }
    const parsed = checked.data;

    const files: { did: string; hash: string; rev: string; data: string }[] = [];
    try {
      for (const did of parsed.dids) {
        const doc = await deps.couch.getDoc(notebook.db_name, did);
        if (!doc) continue;
        const hash = contentIdOf(doc);
        if (!hash) continue;
        const bytes = await deps.couch.getAttachment(notebook.db_name, did);
        if (bytes === null) continue;
        if (bytes.byteLength > deps.config.maxFileBytes) {
          return json({ error: `文件超过上限（${deps.config.maxFileBytes} 字节）`, code: "too-large" }, 413);
        }
        files.push({ did, hash, rev: String(doc._rev ?? ""), data: Buffer.from(bytes).toString("base64") });
      }
      return json(parseContract(filesBatchResponseSchema, { files }, "POST /v1/files"), 200);
    } catch (error) {
      return couchError(error, { accountId: account.id, notebookId: notebook.id });
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
    const { notebook, account } = resolved;
    const did = c.req.query("did");
    if (!did) return json({ error: "缺少 did 参数", code: "bad-request" }, 400);
    // 一次写 = 一次**推送**（哪怕随后冲突，客户端也确实推了）。
    record(account.id, notebook.id, "push");

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
        // 冲突也是一条**事实**（控制台要能看到「哪一端在持续制造冲突」）。
        record(account.id, notebook.id, "conflict");
        return json({ error: "内容标识对不上（远端已变）", code: "conflict", current: { hash: currentId, rev: existing?._rev ?? null } }, 409);
      }
      if (ifMatch === null && existing) {
        // 缺省 = 允许**新建**；但远端已有这一条 ⇒ 对不上。
        record(account.id, notebook.id, "conflict");
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
          /*
           * ★★ **正文与元数据必须在同一次写入里**（M1）。
           *
           * 以前是两步：`putDoc`（写 hash/size）→ `putAttachment`（写正文）。
           * 中间这个窗口里，文档已经**声明了新 hash**，而正文要么还是旧的、要么（因为新
           * revision 只带请求体里给出的 `_attachments`）干脆**没有**。任何一方在窗口里
           * 崩溃或撞 409，库里就留下一条「声明与字节不符」的文档：CAS 基于声明 hash、
           * 读正文 404/`vanished` —— 而两边**都不会报错**，只是那一条永远同步不动。
           *
           * 现在把正文作为**内联附件**（`data` = base64）跟元数据一起提交：
           * CouchDB 在**同一个 revision** 里落盘解码后的二进制（存储不膨胀），
           * 冲突只有一个来源，读回来的 rev/hash/字节永远自洽。
           *
           * ⚠️ 体积：内联 base64 会计入 CouchDB 的 `max_document_size`
           * （本仓 `etc/couchdb/local.ini` 设成 48 MB，够放 32 MB 的文件 ×4/3）。
           * 换了部署而没跟着调的话，CouchDB 会回 413 —— 这里如实转成 413，不静默截断。
           */
          _attachments: {
            blob: {
              content_type: "application/octet-stream",
              data: Buffer.from(bytes).toString("base64"),
            },
          },
        },
        { baseRev: existing?._rev ?? null },
      );
      if ("conflict" in written) {
        record(account.id, notebook.id, "conflict");
        return json({ error: "写入冲突（远端在我们读取之后又变了）", code: "conflict", current: written.current ? { hash: contentIdOf(written.current), rev: written.current._rev ?? null } : null }, 409);
      }
      /*
       * **用量记账**（控制台的「占用 / 配额」靠它，而不是靠一个永远是 0 的缓存列）。
       *
       * 增量 = 这一版的字节数 − 上一版的字节数（覆盖写会让它变负，删除是 −旧大小）。
       * 上一版的大小从文档的 `size` 字段读 —— 那是我们自己写的，形状可信。
       * 读不到就按 0 算（宁可少记，不可凭空多记一个账号的用量）。
       */
      const previousSize = typeof existing?.size === "number" ? existing.size : 0;
      deps.notebooks.addNotebookBytes(notebook.id, bytes.byteLength - previousSize);
      // 响应里回**这一版**的标识与 rev（客户端据此更新基线，§4.7: `-> 200/201 { hash?, ehash?, rev }`）。
      return json(
        { rev: written.rev, ...(cryptoMode === "none" ? { hash: newHash } : { ehash: newHash }) },
        existing ? 200 : 201,
      );
    } catch (error) {
      return couchError(error, { accountId: account.id, notebookId: notebook.id });
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
    const { notebook, account } = resolved;
    const did = c.req.query("did");
    if (!did) return json({ error: "缺少 did 参数", code: "bad-request" }, 400);
    record(account.id, notebook.id, "delete");

    try {
      const existing = await deps.couch.getDoc(notebook.db_name, did);
      if (!existing) return new Response(null, { status: 410 });
      const ifMatch = c.req.header("if-match") ?? null;
      const currentId = contentIdOf(existing);
      if (ifMatch !== null && currentId !== null && ifMatch !== currentId) {
        record(account.id, notebook.id, "conflict");
        return json({ error: "内容标识对不上", code: "conflict", current: { hash: currentId, rev: existing._rev ?? null } }, 409);
      }
      const result = await deps.couch.putDoc(notebook.db_name, { _id: did, _deleted: true }, { baseRev: existing._rev ?? null });
      if ("conflict" in result) {
        record(account.id, notebook.id, "conflict");
        return json({ error: "删除冲突", code: "conflict", current: null }, 409);
      }
      /*
       * 墓碑不再占「内容」的字节（附件在删除后确实不在了），所以把这一条
       * 记过的大小减回去。读不到 `size` 的（历史数据 / 手写文档）按 0 处理。
       */
      const previousSize = typeof existing.size === "number" ? existing.size : 0;
      if (previousSize > 0) deps.notebooks.addNotebookBytes(notebook.id, -previousSize);
      return new Response(null, { status: 204 });
    } catch (error) {
      return couchError(error, { accountId: account.id, notebookId: notebook.id });
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
    const { notebook, account } = resolved;
    const body = (await c.req.json().catch(() => null)) as { cursor?: unknown; deviceId?: unknown; name?: unknown; platform?: unknown } | null;
    const deviceId = typeof body?.deviceId === "string" ? body.deviceId : null;
    const cursor = typeof body?.cursor === "string" ? body.cursor : null;
    if (!deviceId || !/^[0-9a-f]{32}$/.test(deviceId)) return json({ error: "deviceId 形状不对", code: "bad-request" }, 400);

    /*
     * ★ **检查点顺带登记设备**（`devices` 是只读账本，但不是「只能手工填」的账本）。
     *
     * 设备清单原先只由 `POST /v1/devices` 写入，而当前产品客户端**没有**调它 ——
     * 于是控制台的设备页永远是空的，哪怕三台设备正在同步。检查点是客户端**每次同步
     * 都会打**的请求，而且它本来就带着稳定的 `deviceId`（`src/sync/device.ts`），
     * 所以这里顺手登记一次：不改协议、不要求客户端配合，也让设备账本有了真实来源。
     *
     * `name` / `platform` 客户端**现在不传**（不能为了这个改客户端协议），所以留空 ——
     * 界面上显示「未命名设备」，比编一个名字诚实。将来客户端愿意带，这里已经收着了。
     */
    deps.notebooks.upsertDevice({
      deviceId,
      accountId: account.id,
      name: typeof body?.name === "string" ? body.name.slice(0, 120) : null,
      platform: body?.platform === "desktop" || body?.platform === "android" || body?.platform === "web" ? body.platform : null,
    });

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
      return couchError(error, { accountId: account.id, notebookId: notebook.id });
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
    /** 客户端的期望起点（可作为「服务端当前游标取不到」时的退路）。 */
    const since = c.req.query("since") ?? null;
    let cursor: string | null = since;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        /*
         * ★★ **收尾只有这一个入口**（M4）。
         *
         * 以前 `send` 失败时只把 `closed` 置真，而 `cleanup` 第一行就是
         * `if (closed) return` —— 于是 abort 到达时**直接返回、计数永不递减**。
         * 泄漏几次之后，这个账号的所有实时连接都会被判成「太多了」并 429
         * （直到进程重启）。计数、定时器、关流现在都收敛在 `release()` 里，且只做一次。
         */
        let released = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const release = (): void => {
          if (released) return;
          released = true;
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          const left = (sseConnections.get(account.id) ?? 1) - 1;
          if (left <= 0) sseConnections.delete(account.id);
          else sseConnections.set(account.id, left);
          try {
            controller.close();
          } catch {
            /* 已经关了 */
          }
        };
        const send = (chunk: string): void => {
          if (released) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            release();
          }
        };
        /*
         * ★★ `ready` 必须带**服务端当前**游标（M3）。
         *
         * 以前这里回显客户端传来的 `since`（而客户端根本不传）⇒ 恒为 null ⇒
         * 客户端既不会「核对为最新」，也没有任何信号去补一轮 —— 启动同步被整段跳过
         * （空笔记本 + 本地有待推文件时，首轮同步永远不会发生）。
         */
        const readyCursor = await currentCursor(deps, notebook.db_name);
        send(`event: ready
data: ${JSON.stringify({ cursor: readyCursor, heartbeatMs })}

`);
        /*
         * 轮询起点 = **连接那一刻的服务端游标**（不是客户端的 `since`、更不是 0）。
         * 用 0 起步会让每条连接都把整个变更日志扫一遍（M3 里说的「退化为全量轮询」）。
         */
        cursor = readyCursor ?? since;

        let lastBeat = Date.now();

        const tick = async (): Promise<void> => {
          if (released) return;
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
          /*
           * 心跳：以前是一条**注释行**（`": ping"`）—— 它只能把连接撑活，
           * 客户端**看不到**它（`EventSource` 对注释不触发任何事件）。
           *
           * 后果是客户端的「静默死亡看门狗」会误判：它靠「多久没收到任何事件」判连接死了，
           * 而一个安静的笔记本（25 秒没变更是常态）在 55 秒后就会被自己掐掉重连一次。
           *
           * 所以改成一个**真的事件**：连接照旧撑活，同时客户端能拿到「我还活着」的信号。
           */
          if (Date.now() - lastBeat >= heartbeatMs) {
            send(`event: heartbeat
data: ${JSON.stringify({ at: Date.now() })}

`);
            lastBeat = Date.now();
          }
          if (released) return;
          timer = setTimeout(() => void tick(), 2000);
        };
        void tick();

        // 客户端断开 ⇒ 收尾（**一定要减计数**，否则连接数会只增不减）。
        c.req.raw.signal.addEventListener("abort", release);
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

/**
 * 当前游标（= CouchDB 的 `update_seq`）。
 *
 * 拿不到就返回 `null` —— 客户端会把「没有游标」当成「每次都全树比对」，
 * 那是**正确但更慢**的退化，不会错。反过来（猜一个游标）才会漏同步。
 */
async function currentCursor(deps: V1RoutesDeps, dbName: string): Promise<string | null> {
  try {
    return (await deps.couch.databaseInfo(dbName)).updateSeq;
  } catch {
    return null;
  }
}

/** `/v1/tree` 在没有 `limit` 时的默认页大小（与 `maxFileBytes` 无关）。 */
const DEFAULT_TREE_PAGE_SIZE = 500;

/** 把 `limit` 夹到合理区间（默认 500，最大 2000）。 */
function clampLimit(raw: string | undefined, fallback: number): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 2000);
}

/** 设计文档 id 重导出（诊断用；避免路由层直接 import `couch/design`）。 */
export { DESIGN_DOC_ID };