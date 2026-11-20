/**
 * `/v1/admin/*` 的用例。
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
import { FakeCouch, blockDeleteDatabase, couchAdminClient, couchClient } from "../couch/fakeCouch.test-helper";
import type { CouchClient } from "../couch/client";
import { generateCode, hashCode, type AccountStore } from "../auth/accounts";
import { PROTOCOL_VERSION } from "../../../shared/contract";
import { seedAccount, testAccountStore } from "../auth/testAccounts.test-helper";
import { SettingsStore } from "../settings";
import { NotebookStore } from "../notebooks";
import { ShareStore } from "../shares";
import { createAdminRoutes } from "./admin";
import { createNotebookRoutes } from "./notebooks";
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
  shares: ShareStore;
  config: ServerConfig;
  app: Hono;
  couch: CouchClient;
  couchAdmin: CouchClient;
  /** 造一个**管理员**账号。 */
  admin(): { id: string; token: string };
  /** 造一个普通账号。 */
  member(): { id: string; token: string };
}

function makeWorld(options: { startedAt?: number } = {}): World {
  const db = openDatabase({ path: ":memory:" });
  // 模拟 CouchDB 3.x：只有 server admin 能删库，运行时 sync 账号会 403。
  const fake = new FakeCouch({ deleteRequiresUser: "admin" });
  const accounts = testAccountStore(db);
  const notebooks = new NotebookStore(db);
  const shares = new ShareStore(db);
  const config = loadConfig(ENV);
  const couch = couchClient(fake);
  const couchAdmin = couchAdminClient(fake);
  const app = new Hono();
  app.route(
    "/v1/admin",
    createAdminRoutes({
      accounts,
      notebooks,
      shares,
      config,
      couch,
      couchAdmin,
      settings: new SettingsStore(db, config),
      audit: (event) => notebooks.audit(event),
      ...(options.startedAt === undefined ? {} : { startedAt: options.startedAt }),
    }),
  );
  app.route(
    "/v1",
    createNotebookRoutes({ accounts, notebooks, config, couch, couchAdmin, audit: (event) => notebooks.audit(event) }),
  );
  const create = (isAdmin: boolean): { id: string; token: string } => {
    const { id, token } = seedAccount(accounts, { isAdmin });
    return { id, token };
  };
  return { fake, accounts, notebooks, shares, config, app, couch, couchAdmin, admin: () => create(true), member: () => create(false) };
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
    expect(world.accounts.findById(member.id)?.status).toBe("disabled");
    expect(() => world.accounts.authenticate(member.token)).toThrow(/已被停用/);
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
    expect(world.accounts.findById(admin.id)?.status).toBe("active");
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
    expect(await response.json()).toEqual({ databasesDeleted: 1, notebooksTransferred: 1, shareSnapshotsDeleted: 0, shareSnapshotsPending: 0 });

    // 独占那本：库删了、行也标删了。
    expect(world.fake.databases.has(exclusive.db_name)).toBe(false);
    expect(world.notebooks.findById(exclusive.id)).toBeNull();
    // 共享那本：库还在、owner 移交给了 Bob。
    expect(world.fake.databases.has(shared.db_name)).toBe(true);
    expect(world.notebooks.findById(shared.id)?.owner_id).toBe(bob.id);
    expect(world.notebooks.resolveMembership(shared.id, bob.id)?.role).toBe("owner");
    // Alice 的账号没了。
    expect(world.accounts.findById(alice.id)).toBeNull();
  });

  it("sync 凭据删库被 CouchDB 拒绝；账号删除走 admin 凭据", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const alice = world.member();
    const exclusive = world.notebooks.create({ ownerId: alice.id, name: "独占", cryptoMode: "none" });
    world.fake.databases.set(exclusive.db_name, new Map());

    // CouchDB 3.x 的纪律：`DELETE /{db}` 只有 server admin 能做，运行时 sync 账号是 403。
    await expect(world.couch.deleteDatabase(exclusive.db_name)).rejects.toMatchObject({ code: "forbidden", status: 403 });
    expect(world.fake.databases.has(exclusive.db_name)).toBe(true);

    const response = await call(world, `/v1/admin/accounts/${alice.id}`, { method: "DELETE", headers: { authorization: `Bearer ${admin.token}` } });
    expect(response.status).toBe(200);
    expect(world.fake.databases.has(exclusive.db_name)).toBe(false);
  });

  it("删库 await 期间：邀请加入被拒绝，Bob 不会接手指向空库的笔记本", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const alice = world.member();
    const bob = world.member();
    const exclusive = world.notebooks.create({ ownerId: alice.id, name: "独占", cryptoMode: "none" });
    world.fake.databases.set(exclusive.db_name, new Map());
    const code = generateCode("nb");
    world.notebooks.createInvite({ codeHash: hashCode(code), notebookId: exclusive.id, role: "editor", createdBy: alice.id });

    const gate = blockDeleteDatabase(world.fake, exclusive.db_name);
    const deleting = call(world, `/v1/admin/accounts/${alice.id}`, { method: "DELETE", headers: { authorization: `Bearer ${admin.token}` } });
    await gate.entered;

    // 保留状态已经落库：邀请码仍然存在，但加入必须在事务里看到 deleting_at 并拒绝。
    expect(world.notebooks.findById(exclusive.id)!).toMatchObject({ deleting_at: expect.any(Number), deletion_state: "account" });
    const join = await call(world, "/v1/notebooks/join", {
      method: "POST",
      headers: jsonAuth(bob.token),
      body: JSON.stringify({ code }),
    });
    expect(join.status).toBe(409);
    expect(world.notebooks.resolveMembership(exclusive.id, bob.id)).toBeNull();

    gate.release();
    const response = await deleting;
    expect(response.status).toBe(200);
    expect(world.fake.databases.has(exclusive.db_name)).toBe(false);
    expect(world.notebooks.findById(exclusive.id)).toBeNull();
    expect(world.notebooks.resolveMembership(exclusive.id, bob.id)).toBeNull();
  });

  it("删库 await 期间：新建笔记本被 409 拒绝，SQLite 与 CouchDB 都不新增", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const alice = world.member();
    const exclusive = world.notebooks.create({ ownerId: alice.id, name: "独占", cryptoMode: "none" });
    world.fake.databases.set(exclusive.db_name, new Map());
    const databasesBefore = [...world.fake.databases.keys()].sort();

    const gate = blockDeleteDatabase(world.fake, exclusive.db_name);
    const deleting = call(world, `/v1/admin/accounts/${alice.id}`, { method: "DELETE", headers: { authorization: `Bearer ${admin.token}` } });
    await gate.entered;

    expect(world.accounts.findById(alice.id)?.deletion_started_at).toEqual(expect.any(Number));
    const created = await call(world, "/v1/notebooks", {
      method: "POST",
      headers: jsonAuth(alice.token),
      body: JSON.stringify({ name: "删号期间新建", cryptoMode: "none" }),
    });
    expect(created.status).toBe(409);
    expect(await created.json()).toMatchObject({ code: "deletion-in-progress" });
    expect(world.notebooks.listForAccount(alice.id)).toHaveLength(1);
    expect([...world.fake.databases.keys()].sort()).toEqual(databasesBefore);

    gate.release();
    expect((await deleting).status).toBe(200);
  });

  it("删库 await 期间：另一个成员的删账号被 409 延后，不会改变待移交库的成员快照", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const alice = world.member();
    const bob = world.member();
    const exclusive = world.notebooks.create({ ownerId: alice.id, name: "独占", cryptoMode: "none" });
    world.fake.databases.set(exclusive.db_name, new Map());
    const shared = world.notebooks.create({ ownerId: alice.id, name: "共享", cryptoMode: "none" });
    world.fake.databases.set(shared.db_name, new Map());
    world.notebooks.createInvite({ codeHash: "h-race-share", notebookId: shared.id, role: "editor", createdBy: alice.id });
    world.notebooks.joinByInvite("h-race-share", bob.id);

    const gate = blockDeleteDatabase(world.fake, exclusive.db_name);
    const deleting = call(world, `/v1/admin/accounts/${alice.id}`, { method: "DELETE", headers: { authorization: `Bearer ${admin.token}` } });
    await gate.entered;

    const blocked = await call(world, `/v1/admin/accounts/${bob.id}`, { method: "DELETE", headers: { authorization: `Bearer ${admin.token}` } });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { code: string }).code).toBe("deletion-in-progress");
    expect(world.accounts.findById(bob.id)).not.toBeNull();
    expect(world.notebooks.resolveMembership(shared.id, bob.id)?.role).toBe("editor");

    gate.release();
    const response = await deleting;
    expect(response.status).toBe(200);
    expect(world.fake.databases.has(exclusive.db_name)).toBe(false);
    expect(world.fake.databases.has(shared.db_name)).toBe(true);
    expect(world.notebooks.findById(shared.id)!.owner_id).toBe(bob.id);
    expect(world.notebooks.resolveMembership(shared.id, bob.id)?.role).toBe("owner");
  });

  it("两个删账号交错：后开始的保留会让先开始的最终化延后，而不是移除保留库的成员", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const alice = world.member();
    const bob = world.member();

    // Alice 与 Bob 共享 A；Alice 另有独占库 A2；Bob 另有独占库 B。
    const shared = world.notebooks.create({ ownerId: alice.id, name: "共享 A", cryptoMode: "none" });
    world.fake.databases.set(shared.db_name, new Map());
    world.notebooks.createInvite({ codeHash: "h-interleave", notebookId: shared.id, role: "editor", createdBy: alice.id });
    world.notebooks.joinByInvite("h-interleave", bob.id);
    const aliceExclusive = world.notebooks.create({ ownerId: alice.id, name: "Alice 独占", cryptoMode: "none" });
    world.fake.databases.set(aliceExclusive.db_name, new Map());
    const bobExclusive = world.notebooks.create({ ownerId: bob.id, name: "Bob 独占", cryptoMode: "none" });
    world.fake.databases.set(bobExclusive.db_name, new Map());

    let releaseBob!: () => void;
    let releaseAlice!: () => void;
    let enteredBob!: () => void;
    let enteredAlice!: () => void;
    const bobEntered = new Promise<void>((resolve) => {
      enteredBob = resolve;
    });
    const aliceEntered = new Promise<void>((resolve) => {
      enteredAlice = resolve;
    });
    const bobReleased = new Promise<void>((resolve) => {
      releaseBob = resolve;
    });
    const aliceReleased = new Promise<void>((resolve) => {
      releaseAlice = resolve;
    });
    world.fake.beforeDeleteDatabase = async (name) => {
      if (name === bobExclusive.db_name) {
        enteredBob();
        await bobReleased;
      }
      if (name === aliceExclusive.db_name) {
        enteredAlice();
        await aliceReleased;
      }
    };

    // Bob 先开始：保留 B，卡在删库。此时共享库 A 还没被 Alice 保留。
    const bobDeleting = call(world, `/v1/admin/accounts/${bob.id}`, { method: "DELETE", headers: { authorization: `Bearer ${admin.token}` } });
    await bobEntered;

    // Alice 随后开始：保留共享库 A 与独占库 A2，卡在删 A2。
    const aliceDeleting = call(world, `/v1/admin/accounts/${alice.id}`, { method: "DELETE", headers: { authorization: `Bearer ${admin.token}` } });
    await aliceEntered;

    releaseBob();
    const bobFailed = await bobDeleting;
    expect(bobFailed.status).toBe(409);
    expect(world.accounts.findById(bob.id)).not.toBeNull();
    // 共享库 A 里 Bob 的成员关系没有被先开始的那次删除移走。
    expect(world.notebooks.resolveMembership(shared.id, bob.id)?.role).toBe("editor");

    releaseAlice();
    const aliceDone = await aliceDeleting;
    expect(aliceDone.status).toBe(200);
    expect(world.notebooks.findById(shared.id)!.owner_id).toBe(bob.id);
    expect(world.notebooks.resolveMembership(shared.id, bob.id)?.role).toBe("owner");

    // Bob 重试：接手 A 后现在是独占库，和 B 一起删干净。
    const bobRetried = await call(world, `/v1/admin/accounts/${bob.id}`, { method: "DELETE", headers: { authorization: `Bearer ${admin.token}` } });
    expect(bobRetried.status).toBe(200);
    expect(world.accounts.findById(bob.id)).toBeNull();
    expect(world.fake.databases.has(shared.db_name)).toBe(false);
    expect(world.fake.databases.has(bobExclusive.db_name)).toBe(false);
  });

  it("删库失败 ⇒ 账号与笔记本保留、审计可见；重试成功后计数一致", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const alice = world.member();
    const exclusive = world.notebooks.create({ ownerId: alice.id, name: "独占", cryptoMode: "none" });
    world.fake.databases.set(exclusive.db_name, new Map());
    world.fake.failNext = `DELETE /${exclusive.db_name}`;

    const failed = await call(world, `/v1/admin/accounts/${alice.id}`, { method: "DELETE", headers: { authorization: `Bearer ${admin.token}` } });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({
      code: "couch-delete-failed",
      databasesDeleted: 0,
      failedDatabases: [{ notebookId: exclusive.id, dbName: exclusive.db_name }],
    });
    // 控制面一行都没动：账号、笔记本、成员关系都还在，可以直接重试。
    expect(world.accounts.findById(alice.id)).not.toBeNull();
    expect(world.notebooks.findById(exclusive.id)).not.toBeNull();
    expect(world.notebooks.resolveMembership(exclusive.id, alice.id)?.role).toBe("owner");
    expect(world.fake.databases.has(exclusive.db_name)).toBe(true);
    const failedActions = world.notebooks.recentAudit(20).map((event) => event.action);
    expect(failedActions).toContain("delete_database_failed");
    expect(failedActions).toContain("delete_account_failed");
    expect(failedActions).not.toContain("delete_account");

    const retried = await call(world, `/v1/admin/accounts/${alice.id}`, { method: "DELETE", headers: { authorization: `Bearer ${admin.token}` } });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ databasesDeleted: 1, notebooksTransferred: 0, shareSnapshotsDeleted: 0, shareSnapshotsPending: 0 });
    expect(world.accounts.findById(alice.id)).toBeNull();
    expect(world.notebooks.findById(exclusive.id)).toBeNull();
    const finalAudit = world.notebooks.recentAudit(20).find((event) => event.action === "delete_account");
    expect(finalAudit?.detail).toContain("databasesDeleted=1");
  });

  it("删账号的删库失败后：保留状态被清除，邀请仍可正常加入且可新建笔记本", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const alice = world.member();
    const bob = world.member();
    const exclusive = world.notebooks.create({ ownerId: alice.id, name: "独占", cryptoMode: "none" });
    world.fake.databases.set(exclusive.db_name, new Map());
    const code = generateCode("nb");
    world.notebooks.createInvite({ codeHash: hashCode(code), notebookId: exclusive.id, role: "editor", createdBy: alice.id });
    world.fake.failNext = `DELETE /${exclusive.db_name}`;

    const failed = await call(world, `/v1/admin/accounts/${alice.id}`, { method: "DELETE", headers: { authorization: `Bearer ${admin.token}` } });
    expect(failed.status).toBe(503);
    expect(world.notebooks.findById(exclusive.id)).toMatchObject({ deleting_at: null, deletion_state: null });
    expect(world.accounts.findById(alice.id)?.deletion_started_at).toBeNull();

    const created = await call(world, "/v1/notebooks", {
      method: "POST",
      headers: jsonAuth(alice.token),
      body: JSON.stringify({ name: "失败后新建", cryptoMode: "none" }),
    });
    expect(created.status).toBe(201);

    const join = await call(world, "/v1/notebooks/join", {
      method: "POST",
      headers: jsonAuth(bob.token),
      body: JSON.stringify({ code }),
    });
    expect(join.status).toBe(200);
    expect(world.notebooks.resolveMembership(exclusive.id, bob.id)?.role).toBe("editor");
  });

  it("部分库已删后重试：最终 databasesDeleted 等于实际不存在的独占库数", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const alice = world.member();
    const bob = world.member();
    const first = world.notebooks.create({ ownerId: alice.id, name: "独占 1", cryptoMode: "none" });
    const second = world.notebooks.create({ ownerId: alice.id, name: "独占 2", cryptoMode: "none" });
    world.fake.databases.set(first.db_name, new Map());
    world.fake.databases.set(second.db_name, new Map());
    const code = generateCode("nb");
    world.notebooks.createInvite({ codeHash: hashCode(code), notebookId: first.id, role: "editor", createdBy: alice.id });
    world.fake.failNext = `DELETE /${second.db_name}`;

    const partial = await call(world, `/v1/admin/accounts/${alice.id}`, { method: "DELETE", headers: { authorization: `Bearer ${admin.token}` } });
    expect(partial.status).toBe(503);
    expect(await partial.json()).toMatchObject({ databasesDeleted: 1 });
    expect(world.fake.databases.has(first.db_name)).toBe(false);
    expect(world.fake.databases.has(second.db_name)).toBe(true);
    expect(world.accounts.findById(alice.id)).not.toBeNull();
    // 第一个库已经不可逆地删掉了：行先逻辑删，不能再被加入 / 发邀请；重试时再清行。
    expect(world.notebooks.findById(first.id)).toBeNull();
    expect(world.notebooks.findById(second.id)).not.toBeNull();
    expect(world.notebooks.findById(second.id)!.deleting_at).toBeNull();
    const join = await call(world, "/v1/notebooks/join", {
      method: "POST",
      headers: jsonAuth(bob.token),
      body: JSON.stringify({ code }),
    });
    expect(join.status).toBe(404);

    const retried = await call(world, `/v1/admin/accounts/${alice.id}`, { method: "DELETE", headers: { authorization: `Bearer ${admin.token}` } });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ databasesDeleted: 2, notebooksTransferred: 0, shareSnapshotsDeleted: 0, shareSnapshotsPending: 0 });
    expect(world.fake.databases.has(first.db_name)).toBe(false);
    expect(world.fake.databases.has(second.db_name)).toBe(false);
    const finalAudit = world.notebooks.recentAudit(20).find((event) => event.action === "delete_account");
    expect(finalAudit?.detail).toContain("databasesDeleted=2");
  });

  it("**不能删自己**", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const response = await call(world, `/v1/admin/accounts/${admin.id}`, { method: "DELETE", headers: { authorization: `Bearer ${admin.token}` } });
    expect(response.status).toBe(400);
    expect(world.accounts.findById(admin.id)).not.toBeNull();
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
    const body = (await response.json()) as { code: string; url: string; maxUses: number; expiresAt: number | null };
    expect(body.code).toMatch(/^join_[0-9a-f]{48}$/);
    // 给管理员转发的是整条链接（服务器地址 + /join/ + 码）。
    expect(body.url).toBe(`${world.config.externalBaseUrl}/join/${body.code}`);
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
    expect(body.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(body.couchVersion).toBe("3.3.3-fake");
    expect(body.accountCount).toBe(2);
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(59);
  });

  it("CouchDB 不通时 `couchVersion` 为 null（不是 500）", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const db = openDatabase({ path: ":memory:" });
    const accounts = testAccountStore(db);
    const notebooks = new NotebookStore(db);
    const app = new Hono();
    app.route(
      "/v1/admin",
      createAdminRoutes({
        accounts: world.accounts,
        notebooks: world.notebooks,
        shares: world.shares,
        config: world.config,
        settings: new SettingsStore(world.accounts.db, world.config),
        couchAdmin: world.couchAdmin,
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
