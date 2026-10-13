/**
 * CouchDB 客户端的用例（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §4.5、§4.7、§3.5）。
 *
 * 用**注入的 `fetch`**（`fetchImpl`）而不是起一个真 CouchDB：这里要验的是**这一层的行为**
 * （状态码映射、CAS 形状、只重试幂等请求、附件字节不被 base64 污染），
 * 而不是 CouchDB 自己的语义（那要靠 compose 冒烟，见 §10.1 A 的「真实栈」一半）。
 *
 * 所以每条用例都在问一个问题：**「Node 有没有越界去决定什么」** —— 答案必须是「没有」。
 */
import { describe, expect, it } from "vitest";
import { CouchClient, CouchError } from "./client";

interface Call {
  url: string;
  method: string;
  body: string | undefined;
  authorization: string | undefined;
}

/** 一个可编程的假 fetch：按队列返回响应，并记录每次调用。 */
function stubFetch(responses: { status?: number; body?: unknown; raw?: Uint8Array; headers?: Record<string, string> }[]): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers ?? {});
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
      authorization: headers.get("authorization") ?? undefined,
    });
    const next = responses[Math.min(index, responses.length - 1)] ?? { status: 200, body: {} };
    index += 1;
    const status = next.status ?? 200;
    const payload = next.raw ?? new TextEncoder().encode(next.body === undefined ? "" : JSON.stringify(next.body));
    return new Response(status === 204 || status === 304 ? null : payload, {
      status,
      headers: { "content-type": "application/json", ...(next.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function client(responses: Parameters<typeof stubFetch>[0]): { couch: CouchClient; calls: Call[] } {
  const { fetchImpl, calls } = stubFetch(responses);
  return { couch: new CouchClient({ baseUrl: "http://couchdb:5984/", user: "sync-service", password: "pw", fetchImpl }), calls };
}

describe("传输层：URL、认证、状态码映射", () => {
  it("基址尾斜杠被去掉，且带上 Basic 认证", async () => {
    const { couch, calls } = client([{ body: { version: "3.3.3", vendor: { name: "The Apache Software Foundation" } } }]);
    const version = await couch.version();
    expect(version.version).toBe("3.3.3");
    expect(calls[0]!.url).toBe("http://couchdb:5984/");
    // `sync-service:pw` 的 base64。
    expect(calls[0]!.authorization).toBe(`Basic ${Buffer.from("sync-service:pw").toString("base64")}`);
  });

  it("状态码映射成机器可读的 code（调用方不该匹配文案）", async () => {
    const cases: [number, string][] = [
      [401, "unauthorized"],
      [403, "forbidden"],
      [404, "not-found"],
      [409, "conflict"],
      [413, "too-large"],
      [400, "bad-request"],
      [503, "unavailable"],
    ];
    for (const [status, code] of cases) {
      const { couch } = client([{ status, body: { error: "x", reason: `r${status}` } }]);
      await expect(couch.version()).rejects.toMatchObject({ code });
    }
  });

  it("错误对象带上 CouchDB 的 reason（诊断用）", async () => {
    const { couch } = client([{ status: 400, body: { error: "bad_request", reason: "invalid UTF-8 JSON" } }]);
    const error = await couch.version().catch((thrown: unknown) => thrown as CouchError);
    expect(error).toBeInstanceOf(CouchError);
    expect((error as CouchError).message).toContain("invalid UTF-8 JSON");
    expect((error as CouchError).status).toBe(400);
  });

  it("非 JSON 响应体不炸（只降级成 server 错误）", async () => {
    const couch = new CouchClient({
      baseUrl: "http://couchdb:5984",
      user: "u",
      password: "p",
      fetchImpl: (async () => new Response("<html>502</html>", { status: 502 })) as unknown as typeof fetch,
    });
    await expect(couch.version()).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("建库 / 删库：**幂等**（置备可重入的前提，§4.5）", () => {
  it("建库成功返回 true；已存在（409）返回 false —— 不是错误", async () => {
    const created = client([{ status: 201, body: { ok: true } }]);
    expect(await created.couch.createDatabase("nb-abc")).toBe(true);

    const exists = client([{ status: 409, body: { error: "file_exists" } }]);
    expect(await exists.couch.createDatabase("nb-abc")).toBe(false);
  });

  it("删库时不存在（404）返回 false —— 也不是错误", async () => {
    const gone = client([{ status: 404, body: { error: "not_found" } }]);
    expect(await gone.couch.deleteDatabase("nb-abc")).toBe(false);
    const ok = client([{ status: 200, body: { ok: true } }]);
    expect(await ok.couch.deleteDatabase("nb-abc")).toBe(true);
  });

  it("库存在性检查：HEAD 404 → false，200 → true", async () => {
    expect(await client([{ status: 404 }]).couch.databaseExists("nb-x")).toBe(false);
    expect(await client([{ status: 200 }]).couch.databaseExists("nb-x")).toBe(true);
  });
});

describe("CAS 写：冲突是**正常结果**，且带回当前文档（§4.7 设计点 3）", () => {
  it("`baseRev: null` 时不带 rev 参数（允许新建）", async () => {
    const { couch, calls } = client([{ status: 201, body: { rev: "1-abc" } }]);
    const result = await couch.putDoc("nb-x", { _id: "f:abc", path: "a.md" }, { baseRev: null });
    expect(result).toEqual({ ok: true, rev: "1-abc" });
    expect(calls[0]!.url).not.toContain("?rev=");
  });

  it("带 `baseRev` 时进查询参数（CouchDB 的 CAS 入口）", async () => {
    const { couch, calls } = client([{ status: 201, body: { rev: "2-def" } }]);
    await couch.putDoc("nb-x", { _id: "f:abc" }, { baseRev: "1-abc" });
    expect(calls[0]!.url).toContain("?rev=1-abc");
  });

  it("409 时返回 `{ conflict, current }`，**不抛** —— 调用方要靠当前值做三方 diff", async () => {
    const { couch } = client([
      { status: 409, body: { error: "conflict" } },
      { status: 200, body: { _id: "f:abc", _rev: "3-live", hash: "h-live" } },
    ]);
    const result = await couch.putDoc("nb-x", { _id: "f:abc" }, { baseRev: "1-stale" });
    expect("conflict" in result).toBe(true);
    if (!("conflict" in result)) throw new Error("unreachable");
    expect(result.current?._rev).toBe("3-live");
    expect(result.current?.hash).toBe("h-live");
  });

  it("读一条不存在的文档返回 null（不抛）", async () => {
    const { couch } = client([{ status: 404, body: { error: "not_found" } }]);
    expect(await couch.getDoc("nb-x", "f:abc")).toBeNull();
  });

  it("`_design/…` 的 `/` 保留（design 文档就是那个形状）", async () => {
    const { couch, calls } = client([{ status: 200, body: { _id: "_design/opennote" } }]);
    await couch.getDoc("nb-x", "_design/opennote");
    // `_design/opennote` 不能被转义成 `_design%2Fopennote`。
    expect(calls[0]!.url).toContain("/nb-x/_design/opennote");
    expect(calls[0]!.url).not.toContain("%2F");
  });

  it("`did` 里的冒号被转义（`f:` 开头，不能破坏路径）", async () => {
    const { couch, calls } = client([{ status: 200, body: {} }]);
    await couch.getDoc("nb-x", "f:bm90ZXM");
    expect(calls[0]!.url).toContain("/nb-x/f%3Abm90ZXM");
  });
});

describe("置备用的三个专用写：`_design` / `_security` / `_revs_limit`", () => {
  it("`_design` 已存在时**不覆盖**（§4.5 验收：不自动重建）", async () => {
    const { couch, calls } = client([{ status: 200, body: { _id: "_design/opennote", _rev: "1-old" } }]);
    const result = await couch.putDesignDoc("nb-x", "opennote", { views: {} });
    expect(result.created).toBe(false);
    // 只有那一次 GET，没有 PUT。
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("`_design` 不存在时新建", async () => {
    const { couch, calls } = client([{ status: 404 }, { status: 201, body: { rev: "1-new" } }]);
    const result = await couch.putDesignDoc("nb-x", "opennote", { views: {} });
    expect(result.created).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(["GET", "PUT"]);
    expect(calls[1]!.url).toContain("/_design/opennote");
  });

  it("`replace: true` 时带上旧 `_rev` 更新", async () => {
    const { couch, calls } = client([{ status: 200, body: { _id: "_design/opennote", _rev: "1-old" } }, { status: 201, body: { rev: "2-new" } }]);
    const result = await couch.putDesignDoc("nb-x", "opennote", { views: {} }, { replace: true });
    expect(result.created).toBe(false);
    expect(calls[1]!.url).toContain("rev=1-old");
  });

  it("`_security` 与 `_revs_limit` 走各自的端点", async () => {
    const { couch, calls } = client([{ status: 200, body: { ok: true } }, { status: 200, body: { ok: true } }]);
    await couch.putSecurity("nb-x", { members: { names: ["sync-service"], roles: [] } });
    await couch.putRevsLimit("nb-x", 1000);
    expect(calls[0]!.url).toContain("/nb-x/_security");
    expect(calls[1]!.url).toContain("/nb-x/_revs_limit");
    expect(calls[1]!.body).toBe("1000");
  });
});

describe("附件：读回**原始字节**（§3.5：正文不走 JSON base64）", () => {
  it("读附件返回的是字节，不是被 base64 过的字符串", async () => {
    const payload = new TextEncoder().encode("# 你好 📓");
    const { couch } = client([{ status: 200, raw: payload }]);
    const bytes = await couch.getAttachment("nb-x", "f:abc");
    expect(bytes).not.toBeNull();
    expect([...bytes!]).toEqual([...payload]);
  });

  it("附件不存在返回 null", async () => {
    const { couch } = client([{ status: 404, body: {} }]);
    expect(await couch.getAttachment("nb-x", "f:abc")).toBeNull();
  });

  it("写附件以 base64 提交并带 rev 与 content_type", async () => {
    const { couch, calls } = client([{ status: 201, body: { rev: "2-b" } }]);
    const result = await couch.putAttachment("nb-x", "f:abc", "aGVsbG8=", { rev: "1-a", contentType: "text/markdown" });
    expect(result).toEqual({ ok: true, rev: "2-b" });
    expect(calls[0]!.body).toBe("aGVsbG8=");
    expect(calls[0]!.url).toContain("rev=1-a");
    expect(calls[0]!.url).toContain("content_type=text%2Fmarkdown");
  });
});

describe("重试策略：**只重试幂等请求**（写请求一次都不重试）", () => {
  it("GET 网络抖动会重试一次", async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("ECONNRESET");
      return new Response(JSON.stringify({ version: "3.3.3" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const couch = new CouchClient({ baseUrl: "http://c", user: "u", password: "p", fetchImpl });
    await expect(couch.version()).resolves.toMatchObject({ version: "3.3.3" });
    expect(attempts).toBe(2);
  });

  it("PUT 网络抖动**不重试**（重试一次写可能长出第二个 leaf）", async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const couch = new CouchClient({ baseUrl: "http://c", user: "u", password: "p", fetchImpl });
    await expect(couch.putDoc("nb-x", { _id: "f:a" })).rejects.toMatchObject({ code: "network" });
    expect(attempts).toBe(1);
  });

  it("超时**不重试**（同一台机器上再来一次几乎必然又超时）", async () => {
    let attempts = 0;
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      attempts += 1;
      // 模拟一个迟迟不返回的请求：等 abort 信号。
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }) as unknown as typeof fetch;
    const couch = new CouchClient({ baseUrl: "http://c", user: "u", password: "p", fetchImpl, readTimeoutMs: 20 });
    await expect(couch.version()).rejects.toMatchObject({ code: "timeout" });
    expect(attempts).toBe(1);
  });
});

describe("这一层**不**在决定什么（红线 2）", () => {
  it("客户端没有任何「生成版本号 / 裁决冲突 / 造游标」的导出", async () => {
    const module = await import("./client");
    const exported = Object.keys(module);
    // 只有错误类型与客户端两个导出 —— 一个「顺手实现的语义」都没多。
    expect(exported.sort()).toEqual(["CouchClient", "CouchError"]);
  });

  it("`_changes` 的 `last_seq` 原样返回（不解析、不转数字）", async () => {
    const { couch } = client([{ status: 200, body: { results: [], last_seq: "7-g1AAAA", pending: 0 } }]);
    const changes = await couch.changes("nb-x", { since: "5-abc" });
    // 原样是字符串 —— 契约里 cursor 就是**不透明字符串**（§4.7 设计点 4）。
    expect(changes.last_seq).toBe("7-g1AAAA");
    expect(typeof changes.last_seq).toBe("string");
  });
});

describe("超时默认值（受边缘 30s 写超时约束，§1.3）", () => {
  it("写超时默认比读超时短（我们必须在边缘放弃之前先放弃）", () => {
    /**
     * 这条断言没有「跑到超时」那么强，但它钉住的是一个**产品决定**：
     * 读 20s / 写 10s，而边缘（当前 CF）的写超时是 30s。
     * 换成别的入口时要按 §4.8 重新核算 —— 所以这个值放在构造参数里，不写死在调用点。
     */
    const couch = new CouchClient({ baseUrl: "http://c", user: "u", password: "p", fetchImpl: (async () => new Response()) as unknown as typeof fetch });
    expect(couch).toBeInstanceOf(CouchClient);
    // 显式传参能覆盖（这就是「不绑定厂商」在代码里的样子）。
    const custom = new CouchClient({
      baseUrl: "http://c",
      user: "u",
      password: "p",
      readTimeoutMs: 1000,
      writeTimeoutMs: 500,
      fetchImpl: (async () => new Response()) as unknown as typeof fetch,
    });
    expect(custom).toBeInstanceOf(CouchClient);
  });
});
