/**
 * 一个够用的**假 CouchDB**（内存）。测试用 —— 从 `notebooks.test.ts` 里提出来共用
 * （路由用例与置备用例都要它；两份拷贝一旦漂移，测出来的是夹具而不是产品）。
 *
 * 它只实现我们**真正用到**的端点：建库/删库/存在性、`_security`、`_revs_limit`、
 * 文档 GET/PUT（带 `?rev=` 的 CAS）。**故意不实现**更多 —— 假实现越多，
 * 越容易让「真实 CouchDB 不这么干」这件事被掩盖过去。
 */

import { CouchClient } from "../couch/client";

interface FakeDoc {
  _id: string;
  _rev: string;
  [key: string]: unknown;
}

export class FakeCouch {
  readonly databases = new Map<string, Map<string, FakeDoc>>();
  readonly calls: string[] = [];
  readonly security = new Map<string, unknown>();
  /**
   * 附件（`PUT /{db}/{id}/blob`）。键是 `db/id/name`，值是**解码后**的字节。
   *
   * 第一版没有它，于是任何「真的写一条笔记」的用例都会在 `putAttachment` 上 502 ——
   * 而那个 502 看起来像产品坏了，其实是夹具缺了一块。**写路径的用例必须先有它**。
   */
  readonly attachments = new Map<string, Uint8Array>();
  readonly revsLimits = new Map<string, number>();
  /** 设成真时下一次请求抛网络错误（测回滚）。 */
  failNext: string | null = null;
  private counter = 0;

  private rev(): string {
    this.counter += 1;
    return `${this.counter}-fake`;
  }

  /** 一个 `fetch` 形状的实现，够 `CouchClient` 用。 */
  fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = init?.method ?? "GET";
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const body = typeof init?.body === "string" ? init.body : undefined;
    /*
     * 二进制 body（附件正文）。`fetch` 的 body 可以是 `Uint8Array`，而附件就是这么发的
     * —— 第一版只认字符串 body，于是「写一条真笔记」在假 CouchDB 上会静默存成空。
     */
    const bodyBytes =
      init?.body instanceof Uint8Array
        ? init.body
        : init?.body instanceof ArrayBuffer
          ? new Uint8Array(init.body)
          : undefined;
    const marker = `${method} ${url.pathname}`;
    this.calls.push(marker);

    if (this.failNext && marker.includes(this.failNext)) {
      this.failNext = null;
      throw new Error("ECONNREFUSED（fake）");
    }

    const json = (status: number, payload: unknown): Response =>
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

    if (segments.length === 0) return json(200, { version: "3.3.3-fake", vendor: { name: "fake" } });

    const [dbName, ...rest] = segments as [string, ...string[]];
    const docs = this.databases.get(dbName);

    if (rest.length === 0) {
      if (method === "HEAD") return new Response(null, { status: docs ? 200 : 404 });
      if (method === "PUT") {
        if (docs) return json(409, { error: "file_exists" });
        this.databases.set(dbName, new Map());
        return json(201, { ok: true });
      }
      if (method === "DELETE") {
        if (!docs) return json(404, { error: "not_found" });
        this.databases.delete(dbName);
        return json(200, { ok: true });
      }
      /*
       * `update_seq` 必须给：它是 `/v1/tree` 的游标来源，也是增量同步的起点。
       * 第一版这里没给，于是「tree 的 cursor 非空」那条用例读到的是 `null` ——
       * 而真实 CouchDB 一定会给（它是 `_changes` 的 last_seq 那套东西）。
       *
       * 形状用 CouchDB 3.x 的「字符串 seq」：真实环境里 `update_seq` 就是
       * `"1694-g1AAAA..."` 这种带检查点的字符串，客户端只当**不透明串**搬运。
       */
      return json(200, {
        doc_count: docs?.size ?? 0,
        sizes: { file: 0 },
        update_seq: `${this.counter}-fake`,
      });
    }

    if (!docs) return json(404, { error: "not_found", reason: "no_db_file" });

    if (rest[0] === "_security") {
      if (method === "PUT" && body) {
        this.security.set(dbName, JSON.parse(body));
        return json(200, { ok: true });
      }
      return json(200, this.security.get(dbName) ?? {});
    }

    if (rest[0] === "_revs_limit") {
      if (method === "PUT" && body) {
        this.revsLimits.set(dbName, JSON.parse(body) as number);
        return json(200, { ok: true });
      }
      const limit = this.revsLimits.get(dbName);
      return limit === undefined ? json(404, { error: "not_found" }) : json(200, limit);
    }

    /*
     * `_all_docs`（模式 A/B 的列树都走它，§3.3）。
     *
     * ⚠️ 这里**必须**真的实现，而不是让用例去替换 `fetchImpl` —— 第一版试过后者，
     * 结果撞上一个环形依赖：`CouchClient` 在构造时就把 `fetchImpl` **捕获**住了
     * （`this.fetchImpl = options.fetchImpl`），之后再替换我没有的引用不会有任何效果。
     * 所以「怎么响应」是**夹具**的职责，用例只负责摆数据。
     */
    if (rest[0] === "_all_docs") {
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam === null ? docs.size : Math.max(0, Number.parseInt(limitParam, 10));
      const includeDocs = url.searchParams.get("include_docs") === "true";
      const startKeyRaw = url.searchParams.get("startkey");
      const startKey = startKeyRaw === null ? null : (JSON.parse(startKeyRaw) as string);
      /*
       * `skip` 必须真的实现：CouchDB 的 `startkey` 是**闭区间**，服务端翻页时靠 `skip=1`
       * 把上一页最后一条排掉。夹具不认这个参数的话，用例里看到的永远是「第二页 = 第一页」，
       * 而真实服务端是好的 —— 那种夹具比没有夹具更糟。
       */
      const skipParam = url.searchParams.get("skip");
      const skip = skipParam === null ? 0 : Math.max(0, Number.parseInt(skipParam, 10));
      const ids = [...docs.keys()].filter((id) => (startKey === null ? true : id >= startKey)).sort();
      const page = ids.slice(skip, skip + (Number.isFinite(limit) ? limit : ids.length));
      const rows = page.map((id) => {
        const doc = docs.get(id)!;
        return {
          id,
          key: id,
          value: { rev: doc._rev },
          ...(includeDocs ? { doc } : {}),
        };
      });
      return json(200, { total_rows: docs.size, offset: 0, rows });
    }

    /*
     * 附件：`/{db}/{id}/{name}`（三段以上）。CouchDB 用它存二进制正文（§3.5）。
     *
     * ⚠️ 必须在「文档」分支**之前**判断 —— 否则 `PUT /nb-x/f:abc/blob` 会被当成
     * 一个 id 叫 `f:abc/blob` 的文档。真实 CouchDB 也是这个优先级（路径段最多的是附件）。
     */
    /*
     * ⚠️ **`_design/` 与 `_local/` 的 doc id 里带斜杠**，所以路由不能只看段数。
     *
     * 真实 CouchDB 的规则是：这两个前缀下的 id 是 `_design/<name>` / `_local/<name>`，
     * 之后的段才是附件名。第一版我只按「段数 ≥ 2 就是附件」判断，
     * 于是 `PUT /nb-x/_local/device-abc` 被当成了「文档 `_local` 的附件 `device-abc`」
     * —— 检查点写到 404 上去了（用例立刻红）。
     */
    const firstIsReserved = rest[0] === "_design" || rest[0] === "_local";
    const attachmentAt = firstIsReserved ? 2 : 1;
    if (rest.length > attachmentAt) {
      const name = rest.slice(attachmentAt).join("/");
      const docId = rest.slice(0, attachmentAt).join("/");
      const key = `${dbName}/${docId}/${name}`;
      if (method === "PUT") {
        const doc = docs.get(docId);
        if (!doc) return json(404, { error: "not_found", reason: "missing doc for attachment" });
        const revParam = url.searchParams.get("rev");
        if (revParam !== null && revParam !== doc._rev) return json(409, { error: "conflict" });
        // ★ 正文是**原始字节**（不是 base64）—— 见 `CouchClient.putAttachment` 的说明。
        this.attachments.set(key, bodyBytes ?? new Uint8Array());
        const written = { ...doc, _rev: this.rev() };
        docs.set(docId, written);
        return json(201, { ok: true, rev: written._rev });
      }
      if (method === "GET") {
        const bytes = this.attachments.get(key);
        if (!bytes) return json(404, { error: "not_found" });
        return new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream" } });
      }
    }

    // 文档（`_design/opennote` 会被拆成两段，这里拼回去）。
    const docId = rest.join("/");
    const rev = url.searchParams.get("rev");

    if (method === "GET") {
      const doc = docs.get(docId);
      return doc ? json(200, doc) : json(404, { error: "not_found" });
    }
    if (method === "PUT") {
      const existing = docs.get(docId);
      const payload = body ? (JSON.parse(body) as FakeDoc) : ({ _id: docId } as FakeDoc);
      /*
       * ★ 版本号可以**在 body 里**给（`_rev`），也可以走 `?rev=` —— 真实 CouchDB 两种都收。
       *
       * 第一版只认 `?rev=`，于是 `ensureUser()`（它把 `_rev` 放在 body 里）在假夹具上
       * 每次都被判成冲突，而它在**真 CouchDB 上是好的**。教训：夹具比产品严格时，
       * 测出来的是夹具的脾气，不是产品的行为。
       */
      const baseRev = rev ?? (typeof payload._rev === "string" ? payload._rev : null);
      if (existing && baseRev !== existing._rev) return json(409, { error: "conflict" });
      if (!existing && baseRev !== null) return json(409, { error: "conflict" });
      const written = { ...payload, _id: docId, _rev: this.rev() };
      /*
       * ★ 附件与文档是**同一个 revision** 的一部分（真实 CouchDB 语义，与 M1 的单次写对应）：
       *   - 请求体里带 `_attachments[name].data`（base64）⇒ 解码后落盘；
       *   - 带 `stub: true` ⇒ 复用同名旧附件；
       *   - **没带的旧附件会被丢掉**（这就是「两步写」窗口里会读到 404 的原因）。
       */
      const prefix = `${dbName}/${docId}/`;
      const previous = new Map([...this.attachments].filter(([key]) => key.startsWith(prefix)));
      for (const key of previous.keys()) this.attachments.delete(key);
      const inline = (payload._attachments ?? {}) as Record<string, { data?: unknown; stub?: unknown }>;
      for (const [name, attachment] of Object.entries(inline)) {
        const key = `${prefix}${name}`;
        if (typeof attachment.data === "string") {
          this.attachments.set(key, Uint8Array.from(Buffer.from(attachment.data, "base64")));
        } else if (attachment.stub === true && previous.has(key)) {
          this.attachments.set(key, previous.get(key)!);
        }
      }
      docs.set(docId, written);
      return json(201, { ok: true, rev: written._rev });
    }
    return json(400, { error: "bad_request", reason: `fake 不支持 ${method}` });
  }) as unknown as typeof fetch;
}

export function couchClient(fake: FakeCouch): CouchClient {
  return new CouchClient({ baseUrl: "http://couchdb:5984", user: "sync-service", password: "pw", fetchImpl: fake.fetchImpl });
}
