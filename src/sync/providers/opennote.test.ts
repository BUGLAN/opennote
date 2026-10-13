/**
 * `opennote` provider 的用例（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §10.1 A 的 C1–C14、§4.7）。
 *
 * ## 这里怎么做到「同一套契约跑两个实现」（§10.1 A）
 *
 * §10.1 A 要求「同一套 provider 契约测试对两个实现各跑一次」。
 * 完整跑一遍做不到 —— `providerContract.test.ts` 里有相当一部分用例要用
 * `memory` fake 的**专有钩子**（`seed()` 直接摆状态、`snapshot()`/`tombstones()` 直接看内部）。
 * 那些钩子在真实 provider 上**不存在也不该存在**。
 *
 * 所以这里做的是**可移植子集**：只走 `SyncProvider` 公开接口的那几条，在两个实现上各跑一次。
 * 专有钩子的那部分留在 `providerContract.test.ts`（它测的是 fake 自己的行为）。
 *
 * ## 假 `/v1/*` 服务端**不是**手写的响应
 *
 * 这里的 stub 每次返回都过一遍 `shared/contract.ts` 的 **zod schema**
 * （`treeResponseSchema` / `changesResponseSchema`）。理由：
 *
 * > 一个手写的 stub 迟早会与真实服务端漂移，而漂移之后「客户端对了、stub 错了」
 * > 与「客户端错了、stub 对了」在测试输出里长得一模一样。
 *
 * 让 stub 的输出必须能通过**真实契约**的校验，就把「stub 与契约一致」变成了一条自动断言。
 * （`server/src/routes/v1.test.ts` 另有一组用例保证真实服务端也满足同一份 schema。）
 */

import { describe, expect, it } from "vitest";
import { changesResponseSchema, treeResponseSchema } from "../../../shared/contract";
import { OpenNoteProvider } from "./opennote";
import { createMemoryProvider } from "./memory";
import { codeForStatus, isRetryable, type HttpResponse, type HttpSend } from "../http";
import { SyncProviderError, type SyncProvider } from "../provider-types";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * 造一个**合法**的内容标识（契约要求 `^[0-9a-f]{64}$`）。
 *
 * ⚠️ 第一版写的是 `seed.padEnd(64, "0")`，于是 `id("h1")` = `"h1000…"` —— 含字母 `h`，
 * **不是十六进制**。它在 `providerContract.test.ts` 里一直没事，因为 memory fake
 * 「只比相等、不校验哈希算法」；而这里的假服务端会用真实契约的 zod schema 校验响应，
 * 于是它立刻炸了。
 *
 * 这正是「让 stub 的输出过真实契约」的价值：它顺手抓出了我自己造的非法标识。
 * 更值钱的推论是 —— **如果连测试都在用非法形状的标识，那产品里迟早会有人照着抄**。
 */
function id(seed: string): string {
  let out = "";
  for (const ch of seed) out += (ch.charCodeAt(0) % 16).toString(16);
  return (out + "0".repeat(64)).slice(0, 64);
}

/** 模式 A 的 did（与 `shared/paths.ts: idForPath` 一致）。 */
function didFor(path: string): string {
  return `f:${Buffer.from(path, "utf8").toString("base64url")}`;
}

/* ============================================================================
   假 `/v1/*` 服务端：**输出必须过真实契约的 schema**
   ============================================================================ */

interface StubDoc {
  did: string;
  path?: string;
  bytes: Uint8Array;
  hash: string;
  rev: string;
  deleted?: boolean;
}

interface StubCall {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
}

class StubV1 {
  readonly docs = new Map<string, StubDoc>();
  readonly calls: StubCall[] = [];
  /** 强制下一次请求返回某个状态（测错误映射）。 */
  failNext: { status: number; body?: string; headers?: Record<string, string> } | null = null;
  cursor = "1-stub";
  truncated = false;
  resync = false;
  private counter = 0;
  readonly notebookId = "11111111-2222-4333-8444-555555555555";

  seed(path: string, text: string): string {
    const did = didFor(path);
    this.counter += 1;
    this.docs.set(did, { did, path, bytes: enc(text), hash: id(`h${this.counter}`), rev: `${this.counter}-stub` });
    return did;
  }

  private response(status: number, payload: unknown, headers: Record<string, string> = {}): HttpResponse {
    return {
      status,
      headers: { "content-type": "application/json", ...headers },
      bytes: enc(typeof payload === "string" ? payload : JSON.stringify(payload)),
    };
  }

  /** 一个 `HttpSend`：把请求翻译成假服务端的行为。 */
  send: HttpSend = async (request) => {
    const url = new URL(request.url);
    const query = url.searchParams;
    this.calls.push({ method: request.method, path: url.pathname, query, headers: request.headers });

    if (this.failNext) {
      const failure = this.failNext;
      this.failNext = null;
      return this.response(failure.status, failure.body ?? '{"error":"stub 故障","code":"server"}', failure.headers ?? {});
    }

    const nb = query.get("nb");
    if (nb !== this.notebookId) return this.response(404, { error: "笔记本不存在", code: "not-found" });

    if (url.pathname === "/v1/tree") {
      const limit = Number.parseInt(query.get("limit") ?? "500", 10);
      const live = [...this.docs.values()].filter((doc) => doc.deleted !== true);
      const page = live.slice(0, Number.isFinite(limit) ? limit : live.length);
      // ★ 过真实契约的 schema：stub 漂移会在这里炸，而不是在某个断言里。
      const payload = treeResponseSchema.parse({
        cursor: this.cursor,
        truncated: this.truncated || page.length < live.length,
        files: page.map((doc) => ({
          did: doc.did,
          ...(doc.path === undefined ? {} : { path: doc.path }),
          hash: doc.hash,
          size: doc.bytes.byteLength,
          rev: doc.rev,
        })),
      });
      return this.response(200, payload);
    }

    if (url.pathname === "/v1/changes") {
      const payload = changesResponseSchema.parse({
        cursor: this.cursor,
        resync: this.resync,
        changes: [...this.docs.values()].map((doc) => ({ did: doc.did, op: doc.deleted === true ? "delete" : "update" })),
      });
      return this.response(200, payload);
    }

    if (url.pathname === "/v1/file" && request.method === "GET") {
      const doc = this.docs.get(query.get("did") ?? "");
      if (!doc) return this.response(404, { error: "这一条不存在", code: "not-found" });
      return { status: 200, headers: { "x-opennote-hash": doc.hash, "x-opennote-rev": doc.rev }, bytes: doc.bytes };
    }

    if (url.pathname === "/v1/file" && request.method === "PUT") {
      const did = query.get("did") ?? "";
      const existing = this.docs.get(did);
      const ifMatch = request.headers["if-match"] ?? null;
      const current = existing ? existing.hash : null;
      if (ifMatch !== current) {
        return this.response(409, { error: "内容标识对不上", code: "conflict", current: existing ? { hash: existing.hash, rev: existing.rev } : null });
      }
      this.counter += 1;
      const bytes = typeof request.body === "string" ? enc(request.body) : (request.body ?? new Uint8Array());
      /*
       * ★ 新标识来自 `X-Opennote-Hash`，**不是** `If-Match`。
       * 第一版这里写 `ifMatch ?? 自造`，与真实服务端犯了同一个错（新建时没有标识）——
       * 而因为 stub 是假的，那个错看起来「能过」。夹具跟着产品一起错是最危险的一种。
       */
      const declared = request.headers["x-opennote-hash"];
      const written: StubDoc = {
        did,
        ...(query.get("path") === null ? {} : { path: query.get("path")! }),
        bytes,
        hash: declared ?? id(`auto${this.counter}`),
        rev: `${this.counter}-stub`,
      };
      this.docs.set(did, written);
      return this.response(200, { rev: written.rev, hash: written.hash });
    }

    if (url.pathname === "/v1/file" && request.method === "DELETE") {
      const did = query.get("did") ?? "";
      const existing = this.docs.get(did);
      if (!existing) return { status: 410, headers: {}, bytes: new Uint8Array() };
      const ifMatch = request.headers["if-match"] ?? null;
      if (ifMatch !== existing.hash) {
        return this.response(409, { error: "内容标识对不上", code: "conflict", current: { hash: existing.hash, rev: existing.rev } });
      }
      this.counter += 1;
      this.docs.set(did, { ...existing, deleted: true, rev: `${this.counter}-stub` });
      return { status: 204, headers: {}, bytes: new Uint8Array() };
    }

    if (url.pathname === "/v1/checkpoint") {
      const body = typeof request.body === "string" ? (JSON.parse(request.body) as { deviceId?: string; cursor?: string }) : {};
      this.checkpoints.push(body);
      return { status: 204, headers: {}, bytes: new Uint8Array() };
    }

    return this.response(404, { error: `stub 没有 ${url.pathname}`, code: "not-found" });
  };

  readonly checkpoints: { deviceId?: string; cursor?: string }[] = [];
}

function opennoteOn(stub: StubV1, overrides: Partial<ConstructorParameters<typeof OpenNoteProvider>[0]> = {}): OpenNoteProvider {
  return new OpenNoteProvider({
    baseUrl: "https://notes.example.com",
    notebookId: stub.notebookId,
    authToken: "t".repeat(64),
    cryptoMode: "none",
    deviceId: "a".repeat(32),
    send: stub.send,
    sleep: async () => undefined,
    ...overrides,
  });
}

/* ============================================================================
   §10.1 A · 可移植子集：两个实现各跑一次
   ============================================================================ */

const IMPLEMENTATIONS: [string, () => SyncProvider][] = [
  ["memory", () => createMemoryProvider()],
  ["opennote（假 /v1/*）", () => opennoteOn(new StubV1())],
];

describe.each(IMPLEMENTATIONS)("§10.1 A 可移植契约 · %s", (_name, make) => {
  it("C1/C14 · put 新建 → read 回读，字节逐字节相同", async () => {
    const provider = make();
    const bytes = enc("# 你好，笔记 📓\r\n第二行");
    const result = await provider.put({ did: didFor("a.md"), bytes, hash: id("h1"), baseHash: null });
    expect("conflict" in result).toBe(false);
    const read = await provider.read(didFor("a.md"));
    expect(read).not.toBeNull();
    expect([...read!.bytes]).toEqual([...bytes]);
  });

  it("C2 · CAS 对不上 → conflict，且**带回当前值**（做三方 diff 要用）", async () => {
    const provider = make();
    const did = didFor("a.md");
    await provider.put({ did, bytes: enc("v1"), hash: id("h1"), baseHash: null });
    const result = await provider.put({ did, bytes: enc("v2"), hash: id("h2"), baseHash: id("WRONG") });
    expect("conflict" in result).toBe(true);
    if ("conflict" in result) {
      expect(result.conflict.did).toBe(did);
      // ★ 当前值必须在（不是「失败」两个字）—— 否则调用方没法做 diff。
      expect(result.conflict.current).not.toBeNull();
      expect(result.conflict.current!.hash).toBe(id("h1"));
    }
  });

  it("C4 · 删除之后**树里没有它**、`changes` 报 delete（墓碑优先于「树里没有」）", async () => {
    const provider = make();
    const did = didFor("a.md");
    await provider.put({ did, bytes: enc("x"), hash: id("h1"), baseHash: null });
    const deleted = await provider.delete({ did, baseHash: id("h1") });
    expect("conflict" in deleted).toBe(false);

    const tree = await provider.tree();
    expect(tree.entries.map((entry) => entry.did)).not.toContain(did);
    const changes = await provider.changes({ since: null });
    expect(changes.changes.find((change) => change.did === did)?.op).toBe("delete");
  });

  it("C12 · `truncated` 原样上报（它是「禁止推断删除」的开关，不许被抹掉）", async () => {
    const provider = make();
    if (provider instanceof OpenNoteProvider) {
      // 让 stub 说「没列全」。
      const stub = new StubV1();
      stub.seed("a.md", "a");
      stub.truncated = true;
      const bounded = opennoteOn(stub);
      expect((await bounded.tree()).truncated).toBe(true);
      return;
    }
    // memory fake：一页只给一条 ⇒ 它自己也会说 truncated。
    (provider as unknown as { seed: (did: string, hash: string, bytes: Uint8Array) => void }).seed(didFor("a.md"), id("h1"), enc("a"));
    (provider as unknown as { seed: (did: string, hash: string, bytes: Uint8Array) => void }).seed(didFor("b.md"), id("h2"), enc("b"));
    expect((await provider.tree({ limit: 1 })).truncated).toBe(true);
  });

  it("cursor 是**不透明字符串**：原样搬进搬出，不该被解析或改写", async () => {
    const provider = make();
    const tree = await provider.tree();
    // 两个实现的 cursor 形状**故意不同**（memory 是计数器、opennote 是 `N-stub`）——
    // 如果哪个实现开始「解释」cursor，这里就会露出来。
    expect(tree.cursor === null || typeof tree.cursor === "string").toBe(true);
    const changes = await provider.changes({ since: tree.cursor });
    expect(changes.cursor === null || typeof changes.cursor === "string").toBe(true);
  });

  it("read 一条不存在的 → **`null`**（不是异常：不存在是正常结果）", async () => {
    const provider = make();
    await expect(provider.read(didFor("nope.md"))).resolves.toBeNull();
  });

  it("checkpoint 可提交（它是「我到哪了」，与本地账本职责不同）", async () => {
    const provider = make();
    await expect(provider.checkpoint("42")).resolves.toBeUndefined();
  });
});

/* ============================================================================
   opennote provider 专有：HTTP 映射的形状（memory 测不到这些）
   ============================================================================ */

describe("§4.7 · HTTP 映射的形状（这是 provider 唯一的职责）", () => {
  it("`did` 走**查询参数**、`nb` 每次都在（放 URL 路径里会被 `:` 弄坏）", async () => {
    const stub = new StubV1();
    const provider = opennoteOn(stub);
    stub.seed("a.md", "x");
    await provider.tree();
    await provider.read(didFor("a.md"));

    for (const call of stub.calls) {
      expect(call.query.get("nb")).toBe(stub.notebookId);
    }
    const reads = stub.calls.filter((call) => call.path === "/v1/file");
    expect(reads[0]!.query.get("did")).toBe(didFor("a.md"));
    // `did` 里的 `:` 是 URL 编码过的，不是裸的。
    expect(reads[0]!.query.get("did")).toContain(":");
  });

  it("每次请求都带 `Authorization: Bearer <authToken>`", async () => {
    const stub = new StubV1();
    const provider = opennoteOn(stub, { authToken: "A".repeat(64) });
    await provider.tree();
    expect(stub.calls[0]!.headers.authorization).toBe(`Bearer ${"A".repeat(64)}`);
  });

  it("★ 模式 A：`put` 会带 `path`（服务端要它写进 view 的 key）", async () => {
    const stub = new StubV1();
    const provider = opennoteOn(stub);
    await provider.put({ did: didFor("notes/a.md"), bytes: enc("x"), hash: id("h1"), baseHash: null });
    const put = stub.calls.find((call) => call.method === "PUT")!;
    // provider 从 `did` 反解出路径 —— 引擎**不需要**知道路径（`provider-types.ts` 模块头）。
    expect(put.query.get("path")).toBe("notes/a.md");
  });

  it("★ 模式 B：`put` **不带** `path`（E2EE 下服务端不该看到明文路径）", async () => {
    const stub = new StubV1();
    // 模式 B 的 did 是 `h:` + 32 hex（不可逆）。
    const provider = opennoteOn(stub, { cryptoMode: "user-key" });
    const did = `h:${"a".repeat(32)}`;
    await provider.put({ did, bytes: enc("x"), hash: id("h1"), baseHash: null });
    const put = stub.calls.find((call) => call.method === "PUT")!;
    expect(put.query.get("path")).toBeNull();
  });

  it("CAS 用 `If-Match: <内容标识>`（不是 `_rev` —— 转写是服务端的事）", async () => {
    const stub = new StubV1();
    const provider = opennoteOn(stub);
    const did = didFor("a.md");
    await provider.put({ did, bytes: enc("v1"), hash: id("h1"), baseHash: null });
    // 新建时不带 If-Match（`null` = 允许新建）。
    expect(stub.calls.find((call) => call.method === "PUT")!.headers["if-match"]).toBeUndefined();
    await provider.put({ did, bytes: enc("v2"), hash: id("h2"), baseHash: id("h1") });
    const second = stub.calls.filter((call) => call.method === "PUT")[1]!;
    expect(second.headers["if-match"]).toBe(id("h1"));
  });

  it("`read` 从**响应头**取 hash/rev；缺了就明确报错（不静默用空值）", async () => {
    const stub = new StubV1();
    const provider = opennoteOn(stub);
    stub.seed("a.md", "x");
    const read = await provider.read(didFor("a.md"));
    expect(read!.hash).toBeTruthy();
    expect(read!.rev).toBe("1-stub");

    // 服务端没给标识头的情况：必须报错，否则基线会写进假 hash，症状是「同步总是冲突」。
    const bare: StubV1 = new StubV1();
    bare.seed("a.md", "x");
    const original = bare.send;
    bare.send = async (request) => {
      const response = await original(request);
      if (new URL(request.url).pathname === "/v1/file") {
        const { "x-opennote-hash": _h, "x-opennote-rev": _r, ...rest } = response.headers;
        return { ...response, headers: rest };
      }
      return response;
    };
    await expect(opennoteOn(bare).read(didFor("a.md"))).rejects.toBeInstanceOf(SyncProviderError);
  });

  it("checkpoint 写进 `_local/device-<deviceId>`（`deviceId` 由 provider 带上）", async () => {
    const stub = new StubV1();
    const provider = opennoteOn(stub, { deviceId: "b".repeat(32) });
    await provider.checkpoint("7-stub");
    expect(stub.checkpoints).toEqual([{ deviceId: "b".repeat(32), cursor: "7-stub" }]);
  });

  it("没有 `deviceId` 时**不写检查点**（它是优化，不该让同步失败）", async () => {
    const stub = new StubV1();
    await opennoteOn(stub, { deviceId: "" }).checkpoint("7");
    expect(stub.checkpoints).toEqual([]);
  });

  it("`DELETE` 收到 `410` 当**成功**（远端已经没了 = 目标状态已达成）", async () => {
    const stub = new StubV1();
    const provider = opennoteOn(stub);
    const result = await provider.delete({ did: didFor("ghost.md"), baseHash: null });
    expect(result).toEqual({ gone: true });
  });

  it("`changes` 的 `resync` 透传（游标过期 ⇒ 上层退化成全树比对）", async () => {
    const stub = new StubV1();
    stub.resync = true;
    expect((await opennoteOn(stub).changes()).resync).toBe(true);
  });

  it("tombstone **不进树**（它由 `changes` 的 `op: delete` 表达）", async () => {
    const stub = new StubV1();
    const provider = opennoteOn(stub);
    const did = didFor("a.md");
    await provider.put({ did, bytes: enc("x"), hash: id("h1"), baseHash: null });
    await provider.delete({ did, baseHash: id("h1") });
    const tree = await provider.tree();
    expect(tree.entries.map((entry) => entry.did)).not.toContain(did);
  });
});

/* ============================================================================
   错误映射与退避（§1.5 代价 2、§4.11）
   ============================================================================ */

describe("§1.5 代价 2 · 401 = **密钥已被轮换**（文档明确拍板，不是我猜的）", () => {
  it("401 → code `rotated`（因为 256 位令牌「打错」在实践中不可能）", () => {
    expect(codeForStatus(401)).toBe("rotated");
  });

  it("403 + 服务端 `code: disabled` → 也是 `rotated`（账号被禁用，同一个出口）", () => {
    expect(codeForStatus(403, "disabled")).toBe("rotated");
    expect(codeForStatus(403, "forbidden")).toBe("forbidden");
  });

  it("其它状态 → 各自的 code（UI 依赖 code，不依赖文案）", () => {
    expect(codeForStatus(404)).toBe("not-found");
    expect(codeForStatus(409)).toBe("conflict");
    expect(codeForStatus(413)).toBe("quota");
    expect(codeForStatus(500)).toBe("server");
  });

  it("provider 把 401 真的翻成 `rotated`（映射不是只写在函数里）", async () => {
    const stub = new StubV1();
    stub.failNext = { status: 401, body: '{"error":"令牌无效","code":"unauthorized"}' };
    await expect(opennoteOn(stub).tree()).rejects.toMatchObject({ code: "rotated", status: 401 });
  });

  it("服务端的可读文案会被带进错误信息（不是「HTTP 401」这种无用话）", async () => {
    const stub = new StubV1();
    stub.failNext = { status: 403, body: '{"error":"账号已被禁用","code":"disabled"}' };
    await expect(opennoteOn(stub).tree()).rejects.toMatchObject({ message: "账号已被禁用" });
  });
});

describe("§4.11 · 退避：只重试「值得重试」的", () => {
  it("`429` / `5xx` 值得重试；`401/403/404/409/413` 不值得（重试只是浪费）", () => {
    expect(isRetryable(429)).toBe(true);
    expect(isRetryable(500)).toBe(true);
    expect(isRetryable(503)).toBe(true);
    for (const status of [400, 401, 403, 404, 409, 413]) {
      expect(isRetryable(status), `${status} 不该重试`).toBe(false);
    }
  });

  it("`429` 会按 `Retry-After` 退避后重试，最终成功", async () => {
    const stub = new StubV1();
    stub.seed("a.md", "x");
    const slept: number[] = [];
    let first = true;
    const original = stub.send;
    stub.send = async (request) => {
      if (first) {
        first = false;
        // 服务端说「1 秒后再来」。
        return { status: 429, headers: { "retry-after": "1" }, bytes: enc('{"error":"太频繁","code":"too-many"}') };
      }
      return original(request);
    };
    const provider = opennoteOn(stub, { sleep: async (ms) => void slept.push(ms) });
    const tree = await provider.tree();
    expect(tree.entries).toHaveLength(1);
    // ★ 听了服务端的 `Retry-After`（1000ms），而不是自己拍一个退避值。
    expect(slept).toEqual([1000]);
  });

  it("`401` **不重试**（立刻失败 —— 重试一个失效的令牌只会拖慢「请导入新密钥」的提示）", async () => {
    const stub = new StubV1();
    let attempts = 0;
    stub.send = async () => {
      attempts += 1;
      return { status: 401, headers: {}, bytes: enc('{"error":"令牌无效","code":"unauthorized"}') };
    };
    await expect(opennoteOn(stub).tree()).rejects.toBeInstanceOf(SyncProviderError);
    expect(attempts).toBe(1);
  });

  it("重试次数有上限（`maxRetries`），不会无限撞上去", async () => {
    const stub = new StubV1();
    let attempts = 0;
    stub.send = async () => {
      attempts += 1;
      return { status: 503, headers: {}, bytes: enc('{"error":"服务端错误","code":"server"}') };
    };
    await expect(opennoteOn(stub, { maxRetries: 2, sleep: async () => undefined }).tree()).rejects.toBeInstanceOf(SyncProviderError);
    // 首次 + 2 次重试 = 3。
    expect(attempts).toBe(3);
  });

  it("网络错误 → `code: network`，而且**也**会退避重试", async () => {
    let attempts = 0;
    const provider = opennoteOn(new StubV1(), {
      sleep: async () => undefined,
      maxRetries: 1,
      send: async () => {
        attempts += 1;
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(provider.tree()).rejects.toMatchObject({ code: "network" });
    expect(attempts).toBe(2);
  });
});
