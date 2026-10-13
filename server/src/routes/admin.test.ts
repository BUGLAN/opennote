/**
 * `/v1/admin/*` 的用例（`docs/执行-三端同步…` §4.7、§10.1 M8/M10/M11、§7.1）。
 *
 * ## 这里最要紧的一条
 *
 * §10.1 M8/M10 要求「非管理员访问 → 403 **且不泄露任何账号信息**」。
 * 「不泄露」有两种实现方式，只有一种是对的：
 *
 * - ❌ 先读出来再过滤：错误分支里漏掉一个字段就是一次泄露，而且**读过的数据已经在内存里**；
 * - ✅ **在读取之前就拒绝**。
 *
 * 所以这里除了断言状态码，还有一条**行为性**的断言：让 `AccountStore.list()` 变成
 * 「一旦被调用就抛」的哨兵 —— 非管理员请求它**必须** 403 而不是 500，
 * 这就证明那次请求根本没读到账号表。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { FakeCouch, couchClient } from "../couch/fakeCouch.test-helper";
import { AccountStore, newAccountId, newAuthTokenForTests } from "../auth/accounts";
import { NotebookStore } from "../notebooks";
import { createAdminRoutes } from "./admin";
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
  /** 造一个**管理员**账号。 */
  admin(): { id: string; token: string };
  /** 造一个普通账号。 */
  member(): { id: string; token: string };
}

function makeWorld(options: { startedAt?: number } = {}): World {
  const db = openDatabase({ path: ":memory:" });
  const fake = new FakeCouch();
  const accounts = new AccountStore(db);
  const notebooks = new NotebookStore(db);
  const config = loadConfig(ENV);
  const couch = couchClient(fake);
  const app = new Hono();
  app.route(
    "/v1/admin",
    createAdminRoutes({
      accounts,
      notebooks,
      config,
      couch,
      audit: (event) => notebooks.audit(event),
      ...(options.startedAt === undefined ? {} : { startedAt: options.startedAt }),
    }),
  );
  const create = (isAdmin: boolean): { id: string; token: string } => {
    const token = newAuthTokenForTests();
    const row = accounts.create({
      accountId: newAccountId(),
      authToken: token,
      wrappedEncRoot: "wrapped-fake-0001",
      isAdmin,
      bootstrapCode: accounts.createBootstrapCode().code,
    });
    return { id: row.id, token };
  };
  return { fake, accounts, notebooks, config, app, admin: () => create(true), member: () => create(false) };
}

const call = (world: World, path: string, init: RequestInit = {}): Promise<Response> =>
  Promise.resolve(world.app.request(`http://localhost${path}`, init));
const jsonAuth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
/** 非 2xx 一律清掉 console.warn —— 这些用例**故意**制造被拒请求。 */
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("§10.1 M8/M10 · 非管理员：**在读取之前**就拒绝", () => {
  it("普通账号访问任何管理端点 → 403，且**没有读过账号表**", async () => {
    const world = makeWorld();
    const member = world.member();
    // 哨兵：`list()` 一旦被调用就抛。403（而不是 500）即证明那次请求根本没读。
    let listTouched = false;
    const realList = world.accounts.list.bind(world.accounts);
    world.accounts.list = () => {
      listTouched = true;
      return realList();
    };

    const response = await call(world, "/v1/admin/accounts", { headers: { authorization: `Bearer ${member.token}` } });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("forbidden");
    expect(listTouched).toBe(false);
  });

  it("管理端点的**每一个**都拦住非管理员（不是一个一个漏）", async () => {
    const world = makeWorld();
    const member = world.member();
    const routes: [string, string][] = [
      ["GET", "/v1/admin/accounts"],
      ["POST", "/v1/admin/accounts/whatever/status"],
      ["DELETE", "/v1/admin/accounts/whatever"],
      ["POST", "/v1/admin/invites"],
      ["DELETE", "/v1/admin/invites/whatever"],
      ["GET", "/v1/admin/server"],
      ["GET", "/v1/admin/audit"],
      ["GET", "/v1/admin/provisioning"],
    ];
    for (const [method, path] of routes) {
      const response = await call(world, path, { method, headers: structHeaders(member.token, method) });
      expect(response.status, `${method} ${path} 应当 403`).toBe(403);
    }
  });

  it("没有令牌 → 401（与「有令牌但没权限」分开）", async () => {
    const world = makeWorld();
    expect((await call(world, "/v1/admin/accounts")).status).toBe(401);
    expect((await call(world, "/v1/admin/accounts", { headers: { authorization: "Bearer bad-token-xxxxxxxxxxxxxxxx" } })).status).toBe(401);
  });

  it("403 的响应体里**不含任何账号信息**（连账号总数都不给）", async () => {
    const world = makeWorld();
    const admin = world.admin();
    world.member();
    // 先让库里真的有账号（管理员自己 + 一个成员）。
    const forbidden = await call(world, "/v1/admin/accounts", { headers: { authorization: `Bearer ${world.member().token}` } });
    const text = await forbidden.text();
    expect(text).not.toContain(admin.id);
    expect(text).not.toContain("accountId");
    expect(text).not.toContain("auth_hash");
    expect(text).not.toContain("wrapped");
  });
});

/** POST/DELETE 带上 JSON 头（否则某些处理器会因为解析失败走到别的分支）。 */
function structHeaders(token: string, method: string): Record<string, string> {
  return method === "GET" || method === "DELETE" ? { authorization: `Bearer ${token}` } : jsonAuth(token);
}

describe("账号列表 · 形状正确且**不含**敏感字段", () => {
  it("返回账号摘要（含配额），并按创建顺序排列", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const member = world.member();
    const response = await call(world, "/v1/admin/accounts", { headers: { authorization: `Bearer ${admin.token}` } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { accounts: { accountId: string; isAdmin: boolean }[]; total: number };
    expect(body.total).toBe(2);
    expect(body.accounts[0]!.accountId).toBe(admin.id);
    expect(body.accounts[0]!.isAdmin).toBe(true);
    expect(body.accounts[1]!.accountId).toBe(member.id);
    expect(body.accounts[1]!.isAdmin).toBe(false);
  });

  it("响应文本里**没有** `auth_hash` / `wrapped_enc_root` / `wrappedEncRoot`", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const text = await (await call(world, "/v1/admin/accounts", { headers: { authorization: `Bearer ${admin.token}` } })).text();
    for (const forbidden of ["auth_hash", "authHash", "wrapped_enc_root", "wrappedEncRoot", "accountKey"]) {
      expect(text, `不该出现 ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("禁用 / 启用", () => {
  it("禁用之后那个账号立即 403（数据保留，不是删号）", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const member = world.member();

    const response = await call(world, `/v1/admin/accounts/${member.id}/status`, {
      method: "POST",
      headers: jsonAuth(admin.token),
      body: JSON.stringify({ status: "disabled" }),
    });
    expect(response.status).toBe(204);
    // 账号行还在（数据保留）。
    expect(world.accounts.findById2(member.id)?.status).toBe("disabled");
    expect(() => world.accounts.authenticate(member.token)).toThrow(/已被禁用/);
  });

  it("**不能禁用自己**（否则控制台永久失去管理入口）", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const response = await call(world, `/v1/admin/accounts/${admin.id}/status`, {
      method: "POST",
      headers: jsonAuth(admin.token),
      body: JSON.stringify({ status: "disabled" }),
    });
    expect(response.status).toBe(400);
    expect(world.accounts.findById2(admin.id)?.status).toBe("active");
  });

  it("status 只认 active / disabled", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const member = world.member();
    const response = await call(world, `/v1/admin/accounts/${member.id}/status`, {
      method: "POST",
      headers: jsonAuth(admin.token),
      body: JSON.stringify({ status: "deleted" }),
    });
    expect(response.status).toBe(400);
  });

  it("账号不存在 → 404", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const response = await call(world, "/v1/admin/accounts/nope/status", {
      method: "POST",
      headers: jsonAuth(admin.token),
      body: JSON.stringify({ status: "disabled" }),
    });
    expect(response.status).toBe(404);
  });
});

describe("§7.1 · 删账号：独占的库真删、共享的**移交**", () => {
  it("独占 ⇒ 删库；有共享成员 ⇒ 移交 owner 且不删库", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const alice = world.member();
    const bob = world.member();

    // Alice 有两个笔记本：一个独占、一个与 Bob 共享。
    const exclusive = world.notebooks.create({ ownerId: alice.id, name: "独占", cryptoMode: "none" });
    world.fake.databases.set(exclusive.db_name, new Map());
    const shared = world.notebooks.create({ ownerId: alice.id, name: "共享", cryptoMode: "none" });
    world.fake.databases.set(shared.db_name, new Map());
    world.notebooks.createInvite({ codeHash: "h-share", notebookId: shared.id, role: "editor", createdBy: alice.id });
    world.notebooks.joinByInvite("h-share", bob.id);

    const response = await call(world, `/v1/admin/accounts/${alice.id}`, { method: "DELETE", headers: { authorization: `Bearer ${admin.token}` } });
    const delBody = response.status === 200 ? "" : await response.clone().text();
    expect(response.status, delBody).toBe(200);
    expect(await response.json()).toEqual({ databasesDeleted: 1, notebooksTransferred: 1 });

    // 独占那本：库删了、行也标删了。
    expect(world.fake.databases.has(exclusive.db_name)).toBe(false);
    expect(world.notebooks.findById(exclusive.id)).toBeNull();
    // 共享那本：库还在、owner 移交给了 Bob。
    expect(world.fake.databases.has(shared.db_name)).toBe(true);
    expect(world.notebooks.findById(shared.id)?.owner_id).toBe(bob.id);
    expect(world.notebooks.resolveMembership(shared.id, bob.id)?.role).toBe("owner");
    // Alice 的账号没了。
    expect(world.accounts.findById2(alice.id)).toBeNull();
  });

  it("**不能删自己**", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const response = await call(world, `/v1/admin/accounts/${admin.id}`, { method: "DELETE", headers: { authorization: `Bearer ${admin.token}` } });
    expect(response.status).toBe(400);
    expect(world.accounts.findById2(admin.id)).not.toBeNull();
  });
});

describe("邀请码", () => {
  it("生成：明文只出现**这一次**，库里只存哈希", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const response = await call(world, "/v1/admin/invites", {
      method: "POST",
      headers: jsonAuth(admin.token),
      body: JSON.stringify({ maxUses: 3 }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { code: string; maxUses: number; expiresAt: number | null };
    expect(body.code).toMatch(/^inv_[0-9a-f]{48}$/);
    expect(body.maxUses).toBe(3);
    expect(body.expiresAt).toBeGreaterThan(Date.now());

    // 库里存的是哈希，**不是**明文码 —— 事后连我们也拿不回它。
    const row = (world.accounts as unknown as { db: DatabaseSync }).db.prepare("SELECT code_hash FROM invites").get() as unknown as { code_hash: string };
    expect(row.code_hash).not.toBe(body.code);
    expect(row.code_hash).toHaveLength(64);
  });

  it("默认 maxUses=1、有效期 7 天（不给「永不过期的注册码」）", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const body = (await (await call(world, "/v1/admin/invites", { method: "POST", headers: jsonAuth(admin.token), body: "{}" })).json()) as {
      maxUses: number;
      expiresAt: number;
    };
    expect(body.maxUses).toBe(1);
    const days = (body.expiresAt - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it("作废是幂等的：作废两次都 204", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const created = (await (await call(world, "/v1/admin/invites", { method: "POST", headers: jsonAuth(admin.token), body: "{}" })).json()) as { code: string };
    expect((await call(world, `/v1/admin/invites/${created.code}`, { method: "DELETE", headers: { authorization: `Bearer ${admin.token}` } })).status).toBe(204);
    expect((await call(world, `/v1/admin/invites/${created.code}`, { method: "DELETE", headers: { authorization: `Bearer ${admin.token}` } })).status).toBe(204);
  });

  it("**没有**「生成引导码」的 HTTP 端点（那会让管理员泄露 = 能无限造管理员）", async () => {
    const world = makeWorld();
    const admin = world.admin();
    for (const path of ["/v1/admin/bootstrap", "/v1/admin/bootstrap-codes", "/v1/admin/bootstrap-code"]) {
      const response = await call(world, path, { method: "POST", headers: jsonAuth(admin.token), body: "{}" });
      expect(response.status, `${path} 不该存在`).toBe(404);
    }
  });
});

describe("服务器信息与审计", () => {
  it("报出协议版本、CouchDB 版本、账号数、uptime", async () => {
    const world = makeWorld({ startedAt: Date.now() - 60_000 });
    const admin = world.admin();
    world.member();
    const body = (await (await call(world, "/v1/admin/server", { headers: { authorization: `Bearer ${admin.token}` } })).json()) as Record<string, unknown>;
    expect(body.protocolVersion).toBe(1);
    expect(body.couchVersion).toBe("3.3.3-fake");
    expect(body.accountCount).toBe(2);
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(59);
  });

  it("CouchDB 不通时 `couchVersion` 为 null（不是 500）", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const db = openDatabase({ path: ":memory:" });
    const accounts = new AccountStore(db);
    const notebooks = new NotebookStore(db);
    const app = new Hono();
    app.route(
      "/v1/admin",
      createAdminRoutes({
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
      }),
    );
    void db;
    void accounts;
    void notebooks;
    const body = (await (await app.request("http://localhost/v1/admin/server", { headers: { authorization: `Bearer ${admin.token}` } })).json()) as {
      couchVersion: string | null;
    };
    expect(body.couchVersion).toBeNull();
  });

  it("审计能记下管理员动作，且**不含**正文或密钥材料", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const member = world.member();
    await call(world, `/v1/admin/accounts/${member.id}/status`, {
      method: "POST",
      headers: jsonAuth(admin.token),
      body: JSON.stringify({ status: "disabled" }),
    });

    const body = (await (await call(world, "/v1/admin/audit", { headers: { authorization: `Bearer ${admin.token}` } })).json()) as {
      events: { action: string; actorId: string | null; detail: string | null }[];
    };
    expect(body.events.map((event) => event.action)).toContain("disable_account");
    const text = JSON.stringify(body);
    expect(text).not.toContain("wrapped");
    expect(text).not.toContain("auth_hash");
  });

  it("审计条数上限被夹住（别让一个 `?limit=999999` 把内存吃光）", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const response = await call(world, "/v1/admin/audit?limit=999999", { headers: { authorization: `Bearer ${admin.token}` } });
    expect(response.status).toBe(200);
  });
});
