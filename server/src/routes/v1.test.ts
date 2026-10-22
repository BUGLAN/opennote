/**
 * `/v1/*` 的用例（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §4.7、§10.1 A/M、§3.4、§6.4）。
 *
 * ## 这里钉住的是「适配层」的对外承诺
 *
 * - **越权一律 404，且与「不存在」不可区分**（M1–M3）—— 多账号的核心断言；
 * - **`path` 只在明文模式出现**（E2EE 下服务端看不到路径，§3.4）；
 * - **`If-Match` 对不上 → 409 + 当前值**（客户端要靠它做三方 diff，§4.7 设计点 3）；
 * - **正文走原始字节**，不包 JSON/base64（§4.7 设计点 7）；
 * - **`truncated` 如实上报**（§6.4 规则 1）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { PROTOCOL_VERSION } from "../../../shared/contract";
import { FakeCouch, couchClient } from "../couch/fakeCouch.test-helper";
import { AccountStore, newAccountId, newAuthTokenForTests } from "../auth/accounts";
import { NotebookStore } from "../notebooks";
import { createAccountRoutes } from "./account";
import { createV1Routes } from "./v1";
import { loadConfig, type ServerConfig } from "../config";

vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    openDatabase: (options: { path: string }) => (actual as { openDatabase: (o: unknown) => DatabaseSync }).openDatabase({ ...options, path: ":memory:" }),
  };
});

import { openDatabase } from "../db";

const ENV: Record<string, string> = {
  EXTERNAL_BASE_URL: "https://notes.example.com",
  COUCH_URL: "http://couchdb:5984",
  COUCH_USER: "sync-service",
  COUCH_PASSWORD: "pw",
  COUCH_ADMIN_USER: "admin",
  COUCH_ADMIN_PASSWORD: "apw",
};

interface World {
  fake: FakeCouch;
  accounts: AccountStore;
  notebooks: NotebookStore;
  config: ServerConfig;
  app: Hono;
  couch: ReturnType<typeof couchClient>;
  /** 造一个账号并返回它的令牌。 */
  account(): { id: string; token: string };
  /** 造一个笔记本（直接建行，跳过置备 —— 置备另有用例）。 */
  notebook(ownerId: string, name?: string, cryptoMode?: "none" | "user-key"): { id: string; dbName: string };
}

function makeWorld(): World {
  const db = openDatabase({ path: ":memory:" });
  const fake = new FakeCouch();
  const accounts = new AccountStore(db);
  const notebooks = new NotebookStore(db);
  const config = loadConfig(ENV);
  const couch = couchClient(fake);
  // 测试里 admin 与运行时用同一个假客户端（真实部署里是两套凭据）。
  const deps = { accounts, notebooks, config, couch, couchAdmin: couch, audit: (event: Parameters<NotebookStore["audit"]>[0]) => notebooks.audit(event) };
  const app = new Hono();
  app.route("/v1", createAccountRoutes(deps));
  app.route("/v1", createV1Routes(deps));
  return {
    fake,
    accounts,
    notebooks,
    config,
    app,
    couch,
    account() {
      const token = newAuthTokenForTests();
      const row = accounts.create({
        accountId: newAccountId(),
        authToken: token,
        wrappedEncRoot: "wrapped-fake",
        bootstrapCode: accounts.createBootstrapCode().code,
      });
      return { id: row.id, token };
    },
    notebook(ownerId, name = "笔记本", cryptoMode = "none") {
      const row = notebooks.create({ ownerId, name, cryptoMode });
      // 模拟置备已经把库建出来了。
      fake.databases.set(row.db_name, new Map());
      return { id: row.id, dbName: row.db_name };
    },
  };
}

/** 发一个请求（Hono 的 `app.request` 直接吃 `Request`）。 */
function call(world: World, path: string, init: RequestInit = {}): Promise<Response> {
  return Promise.resolve(world.app.request(`http://localhost${path}`, init));
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("§4.7 · `/v1/health`：公开、且是协议闸门", () => {
  it("无需鉴权就能拿到协议版本与 CouchDB 版本", async () => {
    const world = makeWorld();
    const response = await call(world, "/v1/health");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(body.minSupportedProtocolVersion).toBe(1);
    expect(body.couchVersion).toBe("3.3.3-fake");
  });

  it("CouchDB 不通时**也要能报健康**（否则控制台连「哪里坏了」都看不到）", async () => {
    const world = makeWorld();
    /*
     * ⚠️ 用**新的客户端**来模拟故障，而不是替换 `world.fake.fetchImpl`：
     * `CouchClient` 在构造时就把 `fetchImpl` 捕获住了（`this.fetchImpl = options.fetchImpl`），
     * 事后替换那个字段对已经建好的实例没有任何效果 —— 第一版就是这么写的，
     * 于是这条用例读到的是**正常**的 3.3.3-fake，看起来像「回到健康」。
     */
    const broken = new Hono();
    broken.route(
      "/v1",
      createV1Routes({
        accounts: world.accounts,
        notebooks: world.notebooks,
        config: world.config,
        couch: new (await import("../couch/client")).CouchClient({
          baseUrl: "http://couchdb:5984",
          user: "u",
          password: "p",
          fetchImpl: (async () => {
            throw new Error("ECONNREFUSED");
          }) as unknown as typeof fetch,
        }),
        couchAdmin: world.couch,
      }),
    );
    const response = await broken.request("http://localhost/v1/health");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.couchVersion).toBeNull();
    expect(body.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it("`webBuildHash` 默认 null，设了环境变量就报出来（§5.6⑤ 的可核对性）", async () => {
    const world = makeWorld();
    expect(((await (await call(world, "/v1/health")).json()) as Record<string, unknown>).webBuildHash).toBeNull();
    process.env.OPENNOTE_WEB_BUILD_HASH = "sha256-abc";
    try {
      expect(((await (await call(world, "/v1/health")).json()) as Record<string, unknown>).webBuildHash).toBe("sha256-abc");
    } finally {
      delete process.env.OPENNOTE_WEB_BUILD_HASH;
    }
  });
});

describe("§10.1 M1–M3 · 越权是 404，且与「不存在」不可区分", () => {
  it("M1/M2 · 非成员请求别人的笔记本 → 404", async () => {
    const world = makeWorld();
    const alice = world.account();
    const bob = world.account();
    const notebook = world.notebook(alice.id);

    for (const path of [`/v1/tree?nb=${notebook.id}`, `/v1/changes?nb=${notebook.id}`, `/v1/file?nb=${notebook.id}&did=f:abc`]) {
      const response = await call(world, path, { headers: auth(bob.token) });
      expect(response.status, `${path} 应当 404`).toBe(404);
    }
    // 也不接受写入。
    const write = await call(world, `/v1/file?nb=${notebook.id}&did=f:abc`, { method: "PUT", headers: auth(bob.token), body: "x" });
    expect(write.status).toBe(404);
  });

  it("M3 · 猜一个不存在的 notebookId 与「存在但无权」**返回完全一样**", async () => {
    const world = makeWorld();
    const alice = world.account();
    const bob = world.account();
    const notebook = world.notebook(alice.id);

    const unauthorized = await call(world, `/v1/tree?nb=${notebook.id}`, { headers: auth(bob.token) });
    const nonexistent = await call(world, `/v1/tree?nb=11111111-2222-4333-8444-555555555555`, { headers: auth(bob.token) });
    expect(unauthorized.status).toBe(404);
    expect(nonexistent.status).toBe(404);
    // ★ 文案也必须一样 —— 否则「换一句话」就是一次信息泄露。
    expect(await unauthorized.text()).toBe(await nonexistent.text());
  });

  it("M4 · viewer 尝试写 → **403**（他知道这个笔记本存在）", async () => {
    const world = makeWorld();
    const alice = world.account();
    const bob = world.account();
    const notebook = world.notebook(alice.id);
    world.notebooks.createInvite({ codeHash: "h1", notebookId: notebook.id, role: "viewer", createdBy: alice.id });
    world.notebooks.joinByInvite("h1", bob.id);

    // 读得到。
    expect((await call(world, `/v1/tree?nb=${notebook.id}`, { headers: auth(bob.token) })).status).toBe(200);
    // 写不了，且是 403（不是 404）。
    const write = await call(world, `/v1/file?nb=${notebook.id}&did=f:a`, { method: "PUT", headers: auth(bob.token), body: "x" });
    expect(write.status).toBe(403);
  });

  it("没有令牌 / 令牌无效 → 401", async () => {
    const world = makeWorld();
    const alice = world.account();
    const notebook = world.notebook(alice.id);
    expect((await call(world, `/v1/tree?nb=${notebook.id}`)).status).toBe(401);
    expect((await call(world, `/v1/tree?nb=${notebook.id}`, { headers: auth("bad-token-but-long-enough-xxxxxxxx") })).status).toBe(401);
  });

  it("禁用账号 → 403（与「令牌无效」区分开，§4.4 纪律 5）", async () => {
    const world = makeWorld();
    const alice = world.account();
    const notebook = world.notebook(alice.id);
    world.accounts.setStatus(alice.id, "disabled");
    const response = await call(world, `/v1/tree?nb=${notebook.id}`, { headers: auth(alice.token) });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("disabled");
  });

  it("缺少 `nb` 参数 → 400", async () => {
    const world = makeWorld();
    const alice = world.account();
    expect((await call(world, "/v1/tree", { headers: auth(alice.token) })).status).toBe(400);
  });
});

describe("§3.4 / §4.7 设计点 2 · `path` 只在明文模式出现", () => {
  it("模式 A：树条目带 `path`（新设备靠它反查出本地路径）", async () => {
    const world = makeWorld();
    const alice = world.account();
    const notebook = world.notebook(alice.id, "明文", "none");
    world.fake.databases.get(notebook.dbName)!.set("f:abc", { _id: "f:abc", _rev: "1-a", path: "notes/a.md", hash: "a".repeat(64), size: 3 });

    const body = (await (await call(world, `/v1/tree?nb=${notebook.id}`, { headers: auth(alice.token) })).json()) as {
      files: { did: string; path?: string; hash?: string }[];
    };
    expect(body.files).toHaveLength(1);
    expect(body.files[0]!.path).toBe("notes/a.md");
    expect(body.files[0]!.hash).toBe("a".repeat(64));
  });

  it("模式 B：树条目**没有** `path`，只有 `ehash`（服务端看不到明文路径）", async () => {
    const world = makeWorld();
    const alice = world.account();
    const notebook = world.notebook(alice.id, "加密", "user-key");
    world.fake.databases.get(notebook.dbName)!.set(`h:${"a".repeat(32)}`, {
      _id: `h:${"a".repeat(32)}`,
      _rev: "1-b",
      epath: "base64(iv||ct)",
      ehash: "b".repeat(64),
      esize: 3,
      // 故意塞一个 path：模式 B 下**必须**被丢掉（服务端不该有这个字段）。
      path: "不该出现的明文路径.md",
    });

    const body = (await (await call(world, `/v1/tree?nb=${notebook.id}`, { headers: auth(alice.token) })).json()) as {
      files: { did: string; path?: string; ehash?: string }[];
    };
    expect(body.files[0]!.path).toBeUndefined();
    expect(body.files[0]!.ehash).toBe("b".repeat(64));
  });

  it("`_design` / `_local` / `syncinfo` **不进树**（它们不是笔记）", async () => {
    const world = makeWorld();
    const alice = world.account();
    const notebook = world.notebook(alice.id);
    const docs = world.fake.databases.get(notebook.dbName)!;
    docs.set("_design/opennote", { _id: "_design/opennote", _rev: "1-d" });
    docs.set("_local/device-abc", { _id: "_local/device-abc", _rev: "1-l" });
    docs.set("syncinfo", { _id: "syncinfo", _rev: "1-s", protocolVersion: 1, cryptoMode: "none" });
    docs.set("f:real", { _id: "f:real", _rev: "1-r", path: "a.md", hash: "a".repeat(64) });

    const body = (await (await call(world, `/v1/tree?nb=${notebook.id}`, { headers: auth(alice.token) })).json()) as { files: { did: string }[] };
    expect(body.files.map((entry) => entry.did)).toEqual(["f:real"]);
  });
});

describe("§6.4 规则 1 · `truncated` 如实上报（「禁止推断删除」的开关）", () => {
  it("取满一页时 `truncated` 为真", async () => {
    const world = makeWorld();
    const alice = world.account();
    const notebook = world.notebook(alice.id);
    const docs = world.fake.databases.get(notebook.dbName)!;
    for (let index = 0; index < 3; index += 1) {
      docs.set(`f:${index}`, { _id: `f:${index}`, _rev: `${index + 1}-a`, path: `n${index}.md`, hash: "a".repeat(64) });
    }
    const body = (await (await call(world, `/v1/tree?nb=${notebook.id}&limit=2`, { headers: auth(alice.token) })).json()) as {
      truncated: boolean;
      files: unknown[];
    };
    expect(body.files).toHaveLength(2);
    expect(body.truncated).toBe(true);
  });

  it("取得完时 `truncated` 为假", async () => {
    const world = makeWorld();
    const alice = world.account();
    const notebook = world.notebook(alice.id);
    world.fake.databases.get(notebook.dbName)!.set("f:a", { _id: "f:a", _rev: "1-a", path: "a.md", hash: "a".repeat(64) });
    const body = (await (await call(world, `/v1/tree?nb=${notebook.id}&limit=50`, { headers: auth(alice.token) })).json()) as { truncated: boolean };
    expect(body.truncated).toBe(false);
  });
});


  it("★ `startkey` 翻页要**真的前进**：第二页不是第一页的复制", async () => {
    /*
     * 这条是被一次**误诊**逼出来的：排查时用 `startKey`（驼峰）调接口，
     * 服务端读的是 `startkey`（全小写），于是第二页和第一页一模一样，
     * 看起来像「分页坏了」。实际是参数名不匹配。
     *
     * 但误诊本身暴露了一个真风险：**没有用例锁住这件事**。
     * 笔记本超过客户端一次取的量（1000 篇）时，翻页是唯一的取全手段；
     * 一旦它悄悄退化成「重复第一页」，客户端会以为远端只有一页 ——
     * 而那会让「远端删了它」的判断落在成千上百篇上。
     */
    const world = makeWorld();
    const alice = world.account();
    const notebook = world.notebook(alice.id);
    const docs = world.fake.databases.get(notebook.dbName)!;
    for (let index = 0; index < 5; index += 1) {
      docs.set(`f:${index}`, { _id: `f:${index}`, _rev: `${index + 1}-a`, path: `n${index}.md`, hash: "a".repeat(64) });
    }

    const first = (await (await call(world, `/v1/tree?nb=${notebook.id}&limit=2`, { headers: auth(alice.token) })).json()) as {
      files: { did: string }[];
      truncated: boolean;
    };
    expect(first.files).toHaveLength(2);
    expect(first.truncated).toBe(true);

    const cursor = first.files[first.files.length - 1]!.did;
    const second = (await (
      await call(world, `/v1/tree?nb=${notebook.id}&limit=2&startkey=${encodeURIComponent(cursor)}`, { headers: auth(alice.token) })
    ).json()) as { files: { did: string }[]; truncated: boolean };

    // ★ 关键：第二页的第一条绝不能是上一页的最后一条（否则就是原地打转）。
    expect(second.files[0]!.did).not.toBe(cursor);
    // 服务端靠 skip=1 把边界那一行排掉，所以这里应当正好从**下一条**开始。
    expect(second.files[0]!.did).toBe("f:2");
    expect(second.files.map((entry) => entry.did)).not.toEqual(first.files.map((entry) => entry.did));

    // 三页拼起来正好是全部 5 条，不重不漏。
    const third = (await (
      await call(world, `/v1/tree?nb=${notebook.id}&limit=2&startkey=${encodeURIComponent(second.files[second.files.length - 1]!.did)}`, {
        headers: auth(alice.token),
      })
    ).json()) as { files: { did: string }[]; truncated: boolean };
    const all = [...first.files, ...second.files, ...third.files].map((entry) => entry.did);
    expect(new Set(all).size).toBe(5);
    expect(third.truncated).toBe(false);
  });
describe("§4.7 设计点 7 · 正文走原始字节", () => {
  it("GET /v1/file 返回字节与内容标识头", async () => {
    const world = makeWorld();
    const alice = world.account();
    const notebook = world.notebook(alice.id);
    const payload = new TextEncoder().encode("# 你好 📓");
    const docs = world.fake.databases.get(notebook.dbName)!;
    docs.set("f:a", { _id: "f:a", _rev: "1-a", path: "a.md", hash: "h".repeat(64) });
    // 假 CouchDB 的附件读取：`getAttachment` 走 `{db}/{id}/blob`，为它补一个最小实现。
    const original = world.fake.fetchImpl;
    world.fake.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      if (url.pathname.endsWith("/blob")) {
        return new Response(payload, { status: 200, headers: { "content-type": "application/octet-stream" } });
      }
      return original(input, init);
    }) as unknown as typeof fetch;
    const client = couchClient(world.fake);

    const app = new Hono();
    app.route(
      "/v1",
      createV1Routes({
        accounts: world.accounts,
        notebooks: world.notebooks,
        config: world.config,
        couch: client,
        couchAdmin: client,
      }),
    );
    const response = await app.request(`http://localhost/v1/file?nb=${notebook.id}&did=f:a`, { headers: auth(alice.token) });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(payload);
    expect(response.headers.get("x-opennote-hash")).toBe("h".repeat(64));
    expect(response.headers.get("x-opennote-rev")).toBe("1-a");
  });
});

describe("§4.7 设计点 3 · `If-Match` 语义", () => {
  it("对不上 → 409 + **当前值**（客户端要靠它做三方 diff）", async () => {
    const world = makeWorld();
    const alice = world.account();
    const notebook = world.notebook(alice.id);
    world.fake.databases.get(notebook.dbName)!.set("f:a", { _id: "f:a", _rev: "2-live", path: "a.md", hash: "L".repeat(64) });

    const response = await call(world, `/v1/file?nb=${notebook.id}&did=f:a&path=a.md`, {
      method: "PUT",
      headers: { ...auth(alice.token), "if-match": "S".repeat(64) },
      body: "new content",
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string; current: { hash: string; rev: string } };
    expect(body.code).toBe("conflict");
    expect(body.current.hash).toBe("L".repeat(64));
    expect(body.current.rev).toBe("2-live");
  });

  it("缺省 `If-Match` 只允许**新建**：远端已有这一条 → 409", async () => {
    const world = makeWorld();
    const alice = world.account();
    const notebook = world.notebook(alice.id);
    world.fake.databases.get(notebook.dbName)!.set("f:a", { _id: "f:a", _rev: "1-a", path: "a.md", hash: "L".repeat(64) });
    const response = await call(world, `/v1/file?nb=${notebook.id}&did=f:a&path=a.md`, { method: "PUT", headers: auth(alice.token), body: "x" });
    expect(response.status).toBe(409);
  });

  it("超过上限 → 413（受边缘 30s 写超时约束的那个上限）", async () => {
    const world = makeWorld();
    const alice = world.account();
    const notebook = world.notebook(alice.id);
    const response = await call(world, `/v1/file?nb=${notebook.id}&did=f:big&path=big.md`, {
      method: "PUT",
      headers: auth(alice.token),
      body: new Uint8Array(world.config.maxFileBytes + 1),
    });
    expect(response.status).toBe(413);
  });
});

describe("★ 写一条笔记：内容标识必须**落库**（这里曾经有一个真 bug）", () => {
  /*
   * 这一组是补上的。在它之前，**所有**用例都只做过「写元数据 / 列空树」，
   * 从来没有真的往库里写过一条笔记 —— 于是这个 bug 一直没有被发现：
   *
   *   `PUT /v1/file` 把 `If-Match` 当成了「我这次写的是什么」，
   *   而 `If-Match` 的语义是「我以为远端现在是哪一版」。新建时 `If-Match` 缺省，
   *   于是**没有任何地方能拿到这一版的 hash**，写进去的文档根本没有内容标识。
   *
   * 必然的后果有两个，都很隐蔽：
   *   1. `/v1/tree` 里那一条过不了契约（`treeEntrySchema` 要求 hash 或 ehash）
   *      → 整个列树 500，而症状看起来像「服务端坏了」；
   *   2. 下一次 CAS 永远对不上 → 症状是「同步永远在冲突」。
   *
   * 修法：新增 `X-Opennote-Hash` 头带**这一版**的标识；`If-Match` 回归纯 CAS 语义。
   */
  const HASH = "a".repeat(64);

  it("★ 新建时必须带 `X-Opennote-Hash`，并且它真的落进了文档（列树能读到）", async () => {
    const world = makeWorld();
    const alice = world.account();
    const notebook = world.notebook(alice.id);

    const created = await call(world, `/v1/file?nb=${notebook.id}&did=f:aaa&path=notes/a.md`, {
      method: "PUT",
      headers: { ...auth(alice.token), "x-opennote-hash": HASH },
      body: "# 第一条笔记",
    });
    expect(created.status).toBe(201);
    // 响应里回**这一版**的标识与 rev（客户端据此更新基线）。
    const body = (await created.json()) as { hash?: string; rev?: string };
    expect(body.hash).toBe(HASH);
    expect(body.rev).toBeTruthy();

    // ★ 关键：列树能读到它，且**过契约**（`treeResponseSchema` 在这里会校验）。
    const tree = await call(world, `/v1/tree?nb=${notebook.id}`, { headers: auth(alice.token) });
    expect(tree.status).toBe(200);
    const listed = (await tree.json()) as { files: { did: string; hash?: string; path?: string }[] };
    expect(listed.files).toHaveLength(1);
    expect(listed.files[0]!.did).toBe("f:aaa");
    expect(listed.files[0]!.hash).toBe(HASH);
    expect(listed.files[0]!.path).toBe("notes/a.md");
  });

  it("模式 A 允许省略那个头（明文正文在我们手里 ⇒ 服务端算 `sha256` 兜底，值必然一致）", async () => {
    const world = makeWorld();
    const alice = world.account();
    const notebook = world.notebook(alice.id);
    const created = await call(world, `/v1/file?nb=${notebook.id}&did=f:bbb&path=b.md`, {
      method: "PUT",
      headers: auth(alice.token),
      body: "abc",
    });
    const body = (await created.json()) as { hash?: string };
    // `sha256("abc")` 是固定值 —— 这就是「服务端算的与客户端算的一致」的具体形式。
    expect(body.hash).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("★ 模式 B（E2EE）**必须**带那个头 —— 服务端算不出 `ehash`（红线 3）", async () => {
    const world = makeWorld();
    const alice = world.account();
    const notebook = world.notebook(alice.id, "加密", "user-key");
    const response = await call(world, `/v1/file?nb=${notebook.id}&did=h:${"a".repeat(32)}`, {
      method: "PUT",
      headers: auth(alice.token),
      body: "ciphertext",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("X-Opennote-Hash");
    // 而且**没有**写进去（否则会留下一条没有标识的坏文档）。
    expect(world.fake.databases.get(notebook.dbName)!.size).toBe(0);
  });

  it("改一条：`If-Match` = 我以为的当前值；对得上就 200，且新标识被写进去", async () => {
    const world = makeWorld();
    const alice = world.account();
    const notebook = world.notebook(alice.id);
    const HASH2 = "b".repeat(64);

    await call(world, `/v1/file?nb=${notebook.id}&did=f:ccc&path=c.md`, {
      method: "PUT",
      headers: { ...auth(alice.token), "x-opennote-hash": HASH },
      body: "v1",
    });
    const updated = await call(world, `/v1/file?nb=${notebook.id}&did=f:ccc&path=c.md`, {
      method: "PUT",
      headers: { ...auth(alice.token), "if-match": HASH, "x-opennote-hash": HASH2 },
      body: "v2",
    });
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { hash: string }).hash).toBe(HASH2);

    // 列树读到的是**新**标识。
    const listed = (await (await call(world, `/v1/tree?nb=${notebook.id}`, { headers: auth(alice.token) })).json()) as {
      files: { hash?: string }[];
    };
    expect(listed.files[0]!.hash).toBe(HASH2);
  });

  it("改一条但 `If-Match` 对不上 → 409 + **当前值**（客户端要做三方 diff）", async () => {
    const world = makeWorld();
    const alice = world.account();
    const notebook = world.notebook(alice.id);
    await call(world, `/v1/file?nb=${notebook.id}&did=f:ddd&path=d.md`, {
      method: "PUT",
      headers: { ...auth(alice.token), "x-opennote-hash": HASH },
      body: "v1",
    });
    const conflict = await call(world, `/v1/file?nb=${notebook.id}&did=f:ddd&path=d.md`, {
      method: "PUT",
      headers: { ...auth(alice.token), "if-match": "c".repeat(64), "x-opennote-hash": "d".repeat(64) },
      body: "v2",
    });
    expect(conflict.status).toBe(409);
    const body = (await conflict.json()) as { current: { hash: string } };
    expect(body.current.hash).toBe(HASH);
  });

  it("★ 读回来：字节与写进去的**逐字节相同**，且响应头带 hash/rev", async () => {
    const world = makeWorld();
    const alice = world.account();
    const notebook = world.notebook(alice.id);
    const payload = new TextEncoder().encode("# 中文 📓 与 CRLF 行尾" + String.fromCharCode(13) + String.fromCharCode(10) + "第二行");
    await call(world, `/v1/file?nb=${notebook.id}&did=f:eee&path=e.md`, {
      method: "PUT",
      headers: { ...auth(alice.token), "x-opennote-hash": HASH },
      body: payload,
    });

    // 假 CouchDB 的附件读取：为它补一个最小实现（真实 CouchDB 走 `/{db}/{id}/blob`）。
    const original = world.fake.fetchImpl;
    world.fake.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      if (url.pathname.endsWith("/blob") && (init?.method ?? "GET") === "GET") {
        return new Response(payload, { status: 200 });
      }
      return original(input, init);
    }) as unknown as typeof fetch;

    const client = couchClient(world.fake);
    const app = new Hono();
    app.route(
      "/v1",
      createV1Routes({
        accounts: world.accounts,
        notebooks: world.notebooks,
        config: world.config,
        couch: client,
        couchAdmin: client,
      }),
    );
    const response = await app.request(`http://localhost/v1/file?nb=${notebook.id}&did=f:eee`, { headers: auth(alice.token) });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(payload);
    expect(response.headers.get("x-opennote-hash")).toBe(HASH);
    expect(response.headers.get("x-opennote-rev")).toBeTruthy();
  });

  it("列树里的每一条都能过契约（`treeEntrySchema` 要求 hash 或 ehash）", async () => {
    const world = makeWorld();
    const alice = world.account();
    const notebook = world.notebook(alice.id);
    // 塞几条形状不同的：明文、密文、以及一条坏的（既无 hash 也无 ehash）。
    const docs = world.fake.databases.get(notebook.dbName)!;
    docs.set("f:ok1", { _id: "f:ok1", _rev: "1-a", path: "a.md", hash: HASH, size: 1 });
    docs.set(`h:${"a".repeat(32)}`, { _id: `h:${"a".repeat(32)}`, _rev: "1-b", ehash: "e".repeat(64), esize: 2 });
    docs.set("f:bad", { _id: "f:bad", _rev: "1-c", path: "bad.md" });
    docs.set("syncinfo", { _id: "syncinfo", _rev: "1-d", protocolVersion: 1 });

    const response = await call(world, `/v1/tree?nb=${notebook.id}`, { headers: auth(alice.token) });
    // 一条坏的**不该让整个列树 500** —— 那样一个损坏的文档就会让这个笔记本再也同步不了。
    expect(response.status).toBe(200);
    const listed = (await response.json()) as { files: { did: string }[] };
    expect(listed.files.map((entry) => entry.did).sort()).toEqual(["f:ok1", `h:${"a".repeat(32)}`].sort());
  });
});

describe("§6.4 规则 3 · 删除是**逻辑删除**（留墓碑）", () => {
  it("DELETE 之后文档变成墓碑（`_deleted: true`），不是消失", async () => {
    const world = makeWorld();
    const alice = world.account();
    const notebook = world.notebook(alice.id);
    const docs = world.fake.databases.get(notebook.dbName)!;
    docs.set("f:a", { _id: "f:a", _rev: "1-a", path: "a.md", hash: "h".repeat(64) });

    const response = await call(world, `/v1/file?nb=${notebook.id}&did=f:a`, { method: "DELETE", headers: auth(alice.token) });
    expect(response.status).toBe(204);
    // 墓碑留着（丢掉一个 delete 会让文件在另一端复活）。
    expect(docs.get("f:a")?._deleted).toBe(true);
  });

  it("删一条不存在的 → 410（已经没了，不是成功也不是冲突）", async () => {
    const world = makeWorld();
    const alice = world.account();
    const notebook = world.notebook(alice.id);
    const response = await call(world, `/v1/file?nb=${notebook.id}&did=f:nope`, { method: "DELETE", headers: auth(alice.token) });
    expect(response.status).toBe(410);
  });
});

describe("§3.7 · 检查点写进 `_local/device-<deviceId>`", () => {
  it("写入成功，且落在 `_local/` 下（不参与复制、不进 `_changes`）", async () => {
    const world = makeWorld();
    const alice = world.account();
    const notebook = world.notebook(alice.id);
    const deviceId = "a".repeat(32);

    const response = await call(world, `/v1/checkpoint?nb=${notebook.id}`, {
      method: "PUT",
      headers: { ...auth(alice.token), "content-type": "application/json" },
      body: JSON.stringify({ deviceId, cursor: "7-g1AAAA" }),
    });
    expect(response.status).toBe(204);
    const stored = world.fake.databases.get(notebook.dbName)!.get(`_local/device-${deviceId}`);
    expect(stored).toMatchObject({ cursor: "7-g1AAAA", deviceId });
  });

  it("`deviceId` 形状不对 → 400（它要进文档 id，不能任意）", async () => {
    const world = makeWorld();
    const alice = world.account();
    const notebook = world.notebook(alice.id);
    const response = await call(world, `/v1/checkpoint?nb=${notebook.id}`, {
      method: "PUT",
      headers: { ...auth(alice.token), "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "../evil", cursor: "1" }),
    });
    expect(response.status).toBe(400);
  });
});

describe("§4.3 · 客户端统计：只记计数", () => {
  it("上报后按天累加（同一天多次上报是相加，不是覆盖）", async () => {
    const world = makeWorld();
    const alice = world.account();
    const notebook = world.notebook(alice.id);
    const payload = (conflicts: number) =>
      JSON.stringify({ notebookId: notebook.id, day: "2026-10-13", conflicts, errors: 0, pushes: 3, pulls: 2, deletes: 1 });

    for (const conflicts of [1, 2]) {
      const response = await call(world, `/v1/stats?nb=${notebook.id}`, {
        method: "POST",
        headers: { ...auth(alice.token), "content-type": "application/json" },
        body: payload(conflicts),
      });
      expect(response.status).toBe(204);
    }
    const stats = world.notebooks.statsFor(alice.id);
    expect(stats).toHaveLength(1);
    // 1 + 2 = 3（累加），pushes 也是 3 + 3 = 6。
    expect(stats[0]).toMatchObject({ day: "2026-10-13", conflicts: 3, pushes: 6, pulls: 4, deletes: 2 });
  });
});

describe("§1.5 · 注册与轮换的端到端（K2 / K5）", () => {
  it("K2 · 没有码的注册请求 → 400（服务端不接受无码注册）", async () => {
    const world = makeWorld();
    const response = await call(world, "/v1/account", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: newAccountId(), authToken: newAuthTokenForTests(), wrappedEncRoot: "wrapped-too-short-0001" }),
    });
    expect(response.status).toBe(400);
    expect(world.accounts.count()).toBe(0);
  });

  it("K2 · `isAdmin` 只由引导码决定，**请求体说了不算**", async () => {
    const world = makeWorld();
    // 用邀请码注册，同时在请求体里塞 isAdmin: true（schema 里没有这个字段，应被剥掉）。
    const admin = world.account();
    const invite = world.accounts.createInvite({ createdBy: admin.id });
    const response = await call(world, "/v1/account", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: newAccountId(),
        authToken: newAuthTokenForTests(),
        wrappedEncRoot: "wrapped-by-invite-0001",
        inviteCode: invite.code,
        isAdmin: true,
      }),
    });
        expect(response.status).toBe(201);
    expect(((await response.json()) as { isAdmin: boolean }).isAdmin).toBe(false);
  });

  it("K5 · 轮换之后旧令牌立即 401、新令牌可用（204）", async () => {
    const world = makeWorld();
    const alice = world.account();
    const newToken = newAuthTokenForTests();

    const rotate = await call(world, "/v1/account/rotate", {
      method: "POST",
      headers: { ...auth(alice.token), "content-type": "application/json" },
      body: JSON.stringify({ newAuthToken: newToken, newWrappedEncRoot: "wrapped-after-rotation-0001" }),
    });
    expect(rotate.status).toBe(204);

    expect((await call(world, "/v1/account", { headers: auth(alice.token) })).status).toBe(401);
    const after = await call(world, "/v1/account", { headers: auth(newToken) });
    expect(after.status).toBe(200);
    // K7 · 解锁拿回**新的** wrappedEncRoot。
    const unlock = await call(world, "/v1/account/unlock", { method: "POST", headers: auth(newToken) });
    expect(((await unlock.json()) as { wrappedEncRoot: string }).wrappedEncRoot).toBe("wrapped-after-rotation-0001");
  });

  it("注册响应里**不含**任何密钥材料（红线 3）", async () => {
    const world = makeWorld();
    const response = await call(world, "/v1/account", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: newAccountId(), authToken: newAuthTokenForTests(), wrappedEncRoot: "wrapped-x", bootstrapCode: world.accounts.createBootstrapCode().code }),
    });
    const text = await response.text();
    expect(text).not.toContain("wrapped-x");
    expect(text).not.toContain("accountKey");
    expect(text).not.toContain("encRoot");
  });
});

/* ============================================================================
   §4.7 / §4.8 · `/v1/events` SSE 中继
   ============================================================================ */

describe("§4.7 · `/v1/events`（SSE 中继）", () => {
  /** 读出流的第一块（够了 —— 首帧就是 `ready`）。 */
  async function firstChunk(response: Response): Promise<string> {
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    return new TextDecoder().decode(value);
  }

  it("★ 令牌可以走**查询串**（`EventSource` 不能设置请求头 —— 这是浏览器限制，不是我们的选择）", async () => {
    /*
     * §4.7 第 529 行明确写了「`authToken`（**query 参数**或 cookie）」。
     * 别的接口一律要求 `Authorization` 头；只有 SSE 这一条给查询串的路。
     */
    const world = makeWorld();
    const account = world.account();
    const notebook = world.notebook(account.id);

    const response = await world.app.request(`/v1/events?nb=${notebook.id}&authToken=${account.token}`);
    expect(response.status).toBe(200);
    expect(await firstChunk(response)).toContain("event: ready");
  });

  it("`Authorization` 头也照常能用（非浏览器客户端会带）", async () => {
    const world = makeWorld();
    const account = world.account();
    const notebook = world.notebook(account.id);
    const response = await world.app.request(`/v1/events?nb=${notebook.id}`, { headers: { authorization: `Bearer ${account.token}` } });
    expect(response.status).toBe(200);
    await firstChunk(response);
  });

  it("没有令牌 ⇒ 401", async () => {
    const world = makeWorld();
    const account = world.account();
    const notebook = world.notebook(account.id);
    const response = await world.app.request(`/v1/events?nb=${notebook.id}`);
    expect(response.status).toBe(401);
  });

  it("★ 非成员 ⇒ 404，且与「笔记本不存在」**不可区分**（§4.4 纪律 2）", async () => {
    const world = makeWorld();
    const owner = world.account();
    const stranger = world.account();
    const notebook = world.notebook(owner.id);

    const nonMember = await world.app.request(`/v1/events?nb=${notebook.id}&authToken=${stranger.token}`);
    const nonexistent = await world.app.request(`/v1/events?nb=00000000-0000-4000-8000-000000000000&authToken=${stranger.token}`);
    expect(nonMember.status).toBe(404);
    expect(nonexistent.status).toBe(404);
    // 文案也必须一样（否则等于告诉攻击者「这个笔记本存在」）。
    expect(await nonMember.text()).toBe(await nonexistent.text());
  });

  it("★ 响应头禁止中间层缓存/缓冲（否则事件会攒到连接关闭才发 —— §4.8 的 Quick Tunnel 教训）", async () => {
    const world = makeWorld();
    const account = world.account();
    const notebook = world.notebook(account.id);
    const response = await world.app.request(`/v1/events?nb=${notebook.id}&authToken=${account.token}`);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    await firstChunk(response);
  });

  it("★ 首帧就把游标与心跳间隔告诉客户端（它才知道从哪儿开始、多久算掉线）", async () => {
    const world = makeWorld();
    const account = world.account();
    const notebook = world.notebook(account.id);
    const response = await world.app.request(`/v1/events?nb=${notebook.id}&authToken=${account.token}&since=5`);
    const chunk = await firstChunk(response);
    expect(chunk).toContain('"cursor":"5"');
    expect(chunk).toContain("heartbeatMs");
  });

  it("★ 连接数超上限 ⇒ 429（明确拒绝，不是静默把旧的踢掉）", async () => {
    const world = makeWorld();
    const account = world.account();
    const notebook = world.notebook(account.id);
    // 默认上限 4：开满之后第 5 条要被拒。
    const opened: Response[] = [];
    for (let index = 0; index < 4; index += 1) {
      const response = await world.app.request(`/v1/events?nb=${notebook.id}&authToken=${account.token}`);
      opened.push(response);
      await firstChunk(response);
    }
    const extra = await world.app.request(`/v1/events?nb=${notebook.id}&authToken=${account.token}`);
    expect(extra.status).toBe(429);
    expect(await extra.text()).toContain("实时连接太多");
  });
});

describe("批量取 · `POST /v1/files`（把请求数从「= 文件数」压到「文件数 / 批量」）", () => {
  /** 造一个带附件的假库（`attachments` 的键是 `db/id/blob`）。 */
  function seedDocs(world: World, dbName: string, entries: { did: string; path: string; text: string; hash: string }[]): void {
    const docs = world.fake.databases.get(dbName)!;
    for (const entry of entries) {
      docs.set(entry.did, { _id: entry.did, _rev: "1-a", path: entry.path, hash: entry.hash });
      world.fake.attachments.set(`${dbName}/${entry.did}/blob`, new TextEncoder().encode(entry.text));
    }
  }

  it("一次拿回多条：正文与内容标识都对", async () => {
    const world = makeWorld();
    const alice = world.account();
    const notebook = world.notebook(alice.id);
    seedDocs(world, notebook.dbName, [
      { did: "f:a", path: "a.md", text: "# a", hash: "a".repeat(64) },
      { did: "f:b", path: "b.md", text: "# b", hash: "b".repeat(64) },
    ]);

    const response = await call(world, `/v1/files?nb=${notebook.id}`, {
      method: "POST",
      headers: { ...auth(alice.token), "content-type": "application/json" },
      body: JSON.stringify({ dids: ["f:a", "f:b"] }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { files: { did: string; hash: string; rev: string; data: string }[] };
    expect(body.files.map((file) => file.did).sort()).toEqual(["f:a", "f:b"]);
    const a = body.files.find((file) => file.did === "f:a")!;
    expect(a.hash).toBe("a".repeat(64));
    expect(Buffer.from(a.data, "base64").toString("utf8")).toBe("# a");
  });

  it("不存在的 did **直接跳过**，不编造（客户端按「没有这一条」处理）", async () => {
    const world = makeWorld();
    const alice = world.account();
    const notebook = world.notebook(alice.id);
    seedDocs(world, notebook.dbName, [{ did: "f:a", path: "a.md", text: "# a", hash: "a".repeat(64) }]);

    const response = await call(world, `/v1/files?nb=${notebook.id}`, {
      method: "POST",
      headers: { ...auth(alice.token), "content-type": "application/json" },
      body: JSON.stringify({ dids: ["f:a", "f:missing"] }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { files: { did: string }[] };
    expect(body.files.map((file) => file.did)).toEqual(["f:a"]);
  });

  it("请求体不合法 ⇒ 400（不猜）", async () => {
    const world = makeWorld();
    const alice = world.account();
    const notebook = world.notebook(alice.id);
    const response = await call(world, `/v1/files?nb=${notebook.id}`, {
      method: "POST",
      headers: { ...auth(alice.token), "content-type": "application/json" },
      body: JSON.stringify({ dids: [] }),
    });
    expect(response.status).toBe(400);
  });
});

describe("列树的游标 · 增量同步的起点", () => {
  it("`/v1/tree` 返回**非空 cursor**（以前恒为 null ⇒ 检查点永远写不进去）", async () => {
    const world = makeWorld();
    const alice = world.account();
    const notebook = world.notebook(alice.id);
    world.fake.databases.get(notebook.dbName)!.set("f:a", { _id: "f:a", _rev: "1-a", path: "a.md", hash: "a".repeat(64) });

    const body = (await (await call(world, `/v1/tree?nb=${notebook.id}`, { headers: auth(alice.token) })).json()) as {
      cursor: string | null;
    };
    expect(typeof body.cursor).toBe("string");
    expect(body.cursor).not.toBe("");
  });
});
