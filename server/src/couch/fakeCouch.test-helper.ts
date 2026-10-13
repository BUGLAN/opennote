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
      return json(200, { doc_count: docs?.size ?? 0, sizes: { file: 0 } });
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
      const ids = [...docs.keys()].filter((id) => (startKey === null ? true : id >= startKey)).sort();
      const page = ids.slice(0, Number.isFinite(limit) ? limit : ids.length);
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
      docs.set(docId, written);
      return json(201, { ok: true, rev: written._rev });
    }
    return json(400, { error: "bad_request", reason: `fake 不支持 ${method}` });
  }) as unknown as typeof fetch;
}

export function couchClient(fake: FakeCouch): CouchClient {
  return new CouchClient({ baseUrl: "http://couchdb:5984", user: "sync-service", password: "pw", fetchImpl: fake.fetchImpl });
}
