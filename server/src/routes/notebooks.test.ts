/**
 * 笔记本管理路由的用例（`docs/执行-三端同步…` §1.4、§3.1、§4.4、§4.5、§7.1、§10.1 M5/M7）。
 *
 * 重点压四件事：
 * 1. **建笔记本要「行 + 库 + 成员」三样齐全**，且置备失败时**不留半个笔记本**；
 * 2. **E2EE 笔记本不可共享** —— 发码处与用码处**都**要拦（§1.4）；
 * 3. **删笔记本要 owner**（editor 一律 403，非成员一律 404）；
 * 4. **设备是只读账本**（没有「踢设备」这个能力，§1.5 代价 3）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { FakeCouch, couchClient } from "../couch/fakeCouch.test-helper";
import { AccountStore, newAccountId, newAuthTokenForTests } from "../auth/accounts";
import { NotebookStore } from "../notebooks";
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
  config: ServerConfig;
  app: Hono;
  account(): { id: string; token: string };
}

function makeWorld(): World {
  const db = openDatabase({ path: ":memory:" });
  const fake = new FakeCouch();
  const accounts = new AccountStore(db);
  const notebooks = new NotebookStore(db);
  const config = loadConfig(ENV);
  const couch = couchClient(fake);
  const app = new Hono();
  app.route(
    "/v1",
    createNotebookRoutes({ accounts, notebooks, config, couch, couchAdmin: couch, audit: (event) => notebooks.audit(event) }),
  );
  return {
    fake,
    accounts,
    notebooks,
    config,
    app,
    account() {
      const token = newAuthTokenForTests();
      const row = accounts.create({
        accountId: newAccountId(),
        authToken: token,
        wrappedEncRoot: "wrapped-fake-0001",
        bootstrapCode: accounts.createBootstrapCode().code,
      });
      return { id: row.id, token };
    },
  };
}

const call = (world: World, path: string, init: RequestInit = {}): Promise<Response> =>
  Promise.resolve(world.app.request(`http://localhost${path}`, init));

const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
const jsonAuth = (token: string): Record<string, string> => ({ ...auth(token), "content-type": "application/json" });

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("§4.5 · 建笔记本：行 + 库 + 成员三样齐全", () => {
  it("建成功时：库被置备（`_design` / `_security` / `_revs_limit` / `syncinfo`）、owner 成员行写好", async () => {
    const world = makeWorld();
    const alice = world.account();
    const response = await call(world, "/v1/notebooks", {
      method: "POST",
      headers: jsonAuth(alice.token),
      body: JSON.stringify({ name: "我的笔记本", cryptoMode: "none" }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { notebookId: string; role: string; cryptoMode: string };
    expect(body.role).toBe("owner");
    expect(body.cryptoMode).toBe("none");

    const notebook = world.notebooks.findById(body.notebookId)!;
    const docs = world.fake.databases.get(notebook.db_name);
    expect(docs).toBeTruthy();
    expect(docs!.has("_design/opennote")).toBe(true);
    expect(docs!.has("syncinfo")).toBe(true);
    expect(world.fake.security.get(notebook.db_name)).toEqual({ admins: { names: [], roles: [] }, members: { names: ["sync-service"], roles: [] } });
    expect(world.fake.revsLimits.get(notebook.db_name)).toBe(1000);
    // ★ 成员行必须在：否则创建者自己都 404。
    expect(world.notebooks.resolveMembership(body.notebookId, alice.id)?.role).toBe("owner");
  });

  it("§11.3 A · 请求不写 `cryptoMode` 时默认 `none`", async () => {
    const world = makeWorld();
    const alice = world.account();
    const response = await call(world, "/v1/notebooks", { method: "POST", headers: jsonAuth(alice.token), body: JSON.stringify({ name: "x" }) });
    expect(((await response.json()) as { cryptoMode: string }).cryptoMode).toBe("none");
  });

  it("响应里**不带库名**（库名不透明，客户端不该知道，§3.1）", async () => {
    const world = makeWorld();
    const alice = world.account();
    const response = await call(world, "/v1/notebooks", { method: "POST", headers: jsonAuth(alice.token), body: JSON.stringify({ name: "x" }) });
    const text = await response.text();
    expect(text).not.toContain("db_name");
    expect(text).not.toContain("nb-");
  });

  it("**置备失败时不留半个笔记本**：库被回滚删掉，行也被撤掉（§4.5）", async () => {
    const world = makeWorld();
    const alice = world.account();
    // 让 `_security` 那一步失败。
    world.fake.failNext = "/_security";

    const response = await call(world, "/v1/notebooks", { method: "POST", headers: jsonAuth(alice.token), body: JSON.stringify({ name: "会失败的" }) });
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: string }).error).toContain("已回滚");

    // 行没了（`listForAccount` 空）。
    expect(world.notebooks.listForAccount(alice.id)).toHaveLength(0);
    // 库也没了。
    expect([...world.fake.databases.keys()].filter((name) => name.startsWith("nb-"))).toEqual([]);
    // 配额计数回到 0（不能因为一次失败把配额吃掉）。
    expect(world.notebooks.quotaOf(alice.id).notebooks).toBe(0);
  });

  it("配额超限 → 403 + `quota` 码（**只拦写入**）", async () => {
    const world = makeWorld();
    const alice = world.account();
    // 把上限压到 1，先建一个。
    const config = loadConfig({ ...ENV, DEFAULT_ACCOUNT_QUOTA_NOTEBOOKS: "1" });
    const app = new Hono();
    app.route(
      "/v1",
      createNotebookRoutes({ accounts: world.accounts, notebooks: world.notebooks, config, couch: couchClient(world.fake), couchAdmin: couchClient(world.fake) }),
    );
    const post = (body: unknown) => app.request("http://localhost/v1/notebooks", { method: "POST", headers: jsonAuth(alice.token), body: JSON.stringify(body) });

    expect((await post({ name: "第一个" })).status).toBe(201);
    const second = await post({ name: "第二个" });
    expect(second.status).toBe(403);
    expect(((await second.json()) as { code: string }).code).toBe("quota");
  });
});

describe("§4.4 · 单条读写：越权 404 / 无权 403", () => {
  it("非成员 GET → 404，且与「不存在」返回一样", async () => {
    const world = makeWorld();
    const alice = world.account();
    const bob = world.account();
    const created = (await (
      await call(world, "/v1/notebooks", { method: "POST", headers: jsonAuth(alice.token), body: JSON.stringify({ name: "x" }) })
    ).json()) as { notebookId: string };

    const unauthorized = await call(world, `/v1/notebooks/${created.notebookId}`, { headers: auth(bob.token) });
    const nonexistent = await call(world, "/v1/notebooks/11111111-2222-4333-8444-555555555555", { headers: auth(bob.token) });
    expect(unauthorized.status).toBe(404);
    expect(nonexistent.status).toBe(404);
    expect(await unauthorized.text()).toBe(await nonexistent.text());
  });

  it("M5 · editor 删笔记本 → **403**（他知道它存在）", async () => {
    const world = makeWorld();
    const alice = world.account();
    const carol = world.account();
    const created = (await (
      await call(world, "/v1/notebooks", { method: "POST", headers: jsonAuth(alice.token), body: JSON.stringify({ name: "x" }) })
    ).json()) as { notebookId: string };

    const invite = (await (
      await call(world, `/v1/notebooks/${created.notebookId}/invites`, {
        method: "POST",
        headers: jsonAuth(alice.token),
        body: JSON.stringify({ role: "editor" }),
      })
    ).json()) as { code: string };
    await call(world, "/v1/notebooks/join", { method: "POST", headers: jsonAuth(carol.token), body: JSON.stringify({ code: invite.code }) });

    const deleted = await call(world, `/v1/notebooks/${created.notebookId}`, { method: "DELETE", headers: auth(carol.token) });
    expect(deleted.status).toBe(403);
    // 笔记本还在。
    expect(world.notebooks.findById(created.notebookId)).not.toBeNull();
  });

  it("owner 删笔记本 → 库被真删（用户明确说不要了，磁盘不该只增不减）", async () => {
    const world = makeWorld();
    const alice = world.account();
    const created = (await (
      await call(world, "/v1/notebooks", { method: "POST", headers: jsonAuth(alice.token), body: JSON.stringify({ name: "x" }) })
    ).json()) as { notebookId: string };
    const dbName = world.notebooks.findById(created.notebookId)!.db_name;

    const response = await call(world, `/v1/notebooks/${created.notebookId}`, { method: "DELETE", headers: auth(alice.token) });
    expect(response.status).toBe(204);
    expect(world.fake.databases.has(dbName)).toBe(false);
    expect(world.notebooks.findById(created.notebookId)).toBeNull();
  });
});

describe("§1.4 · E2EE 笔记本不可共享（M7）", () => {
  async function makeNotebook(world: World, token: string, cryptoMode: "none" | "user-key"): Promise<string> {
    const response = await call(world, "/v1/notebooks", {
      method: "POST",
      headers: jsonAuth(token),
      body: JSON.stringify({ name: "x", cryptoMode }),
    });
    return ((await response.json()) as { notebookId: string }).notebookId;
  }

  it("发码处：`user-key` 的笔记本 → **409**", async () => {
    const world = makeWorld();
    const alice = world.account();
    const notebookId = await makeNotebook(world, alice.token, "user-key");
    const response = await call(world, `/v1/notebooks/${notebookId}/invites`, {
      method: "POST",
      headers: jsonAuth(alice.token),
      body: JSON.stringify({ role: "editor" }),
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("crypto-mode-not-shareable");
  });

  it("用码处也要拦：跨过发码限制的码仍然进不去", async () => {
    const world = makeWorld();
    const alice = world.account();
    const bob = world.account();
    const notebookId = await makeNotebook(world, alice.token, "none");
    const invite = (await (
      await call(world, `/v1/notebooks/${notebookId}/invites`, { method: "POST", headers: jsonAuth(alice.token), body: JSON.stringify({ role: "editor" }) })
    ).json()) as { code: string };

    /*
     * 把笔记本改成加密的，模拟「模式被切换过 / 有人手工改过库」。
     *
     * 这里用 `NotebookStore` 上**明确标注为测试用**的钩子，而不是去凿私有 `db` 字段 ——
     * 后者在重构（改字段名、加一层封装）时会以「测试编译不过」的形式炸掉，
     * 而且它会诱使别人也照抄这种写法。
     */
    world.notebooks.__setCryptoModeForTests(notebookId, "user-key");

    const join = await call(world, "/v1/notebooks/join", { method: "POST", headers: jsonAuth(bob.token), body: JSON.stringify({ code: invite.code }) });
    expect(join.status).toBe(409);
    expect(((await join.json()) as { code: string }).code).toBe("crypto-mode-not-shareable");
  });

  it("明文笔记本可以共享：editor 加入后能读到", async () => {
    const world = makeWorld();
    const alice = world.account();
    const bob = world.account();
    const notebookId = await makeNotebook(world, alice.token, "none");
    const invite = (await (
      await call(world, `/v1/notebooks/${notebookId}/invites`, { method: "POST", headers: jsonAuth(alice.token), body: JSON.stringify({ role: "editor" }) })
    ).json()) as { code: string };

    const join = await call(world, "/v1/notebooks/join", { method: "POST", headers: jsonAuth(bob.token), body: JSON.stringify({ code: invite.code }) });
    expect(join.status).toBe(200);
    expect(((await join.json()) as { role: string }).role).toBe("editor");
    expect((await call(world, `/v1/notebooks/${notebookId}`, { headers: auth(bob.token) })).status).toBe(200);
  });

  it("一次性：同一个码不能加两个人", async () => {
    const world = makeWorld();
    const alice = world.account();
    const bob = world.account();
    const carol = world.account();
    const notebookId = await makeNotebook(world, alice.token, "none");
    const invite = (await (
      await call(world, `/v1/notebooks/${notebookId}/invites`, { method: "POST", headers: jsonAuth(alice.token), body: JSON.stringify({ role: "viewer" }) })
    ).json()) as { code: string };

    expect((await call(world, "/v1/notebooks/join", { method: "POST", headers: jsonAuth(bob.token), body: JSON.stringify({ code: invite.code }) })).status).toBe(200);
    const second = await call(world, "/v1/notebooks/join", { method: "POST", headers: jsonAuth(carol.token), body: JSON.stringify({ code: invite.code }) });
    expect(second.status).toBe(400);
    expect(((await second.json()) as { code: string }).code).toBe("invite-used");
  });

  it("成员列表只有成员能看", async () => {
    const world = makeWorld();
    const alice = world.account();
    const bob = world.account();
    const notebookId = await makeNotebook(world, alice.token, "none");
    expect((await call(world, `/v1/notebooks/${notebookId}/members`, { headers: auth(alice.token) })).status).toBe(200);
    expect((await call(world, `/v1/notebooks/${notebookId}/members`, { headers: auth(bob.token) })).status).toBe(404);
  });
});

describe("§4.3 / §1.5 代价 3 · 设备是**只读账本**", () => {
  it("登记是幂等的：同一 deviceId 重复登记只刷新 lastSeenAt", async () => {
    const world = makeWorld();
    const alice = world.account();
    const deviceId = "a".repeat(32);
    const body = JSON.stringify({ deviceId, name: "我的桌面", platform: "desktop" });

    expect((await call(world, "/v1/devices", { method: "POST", headers: jsonAuth(alice.token), body })).status).toBe(204);
    // 第二次换个名字：仍然是**同一行**（不是两行）。
    const renamed = JSON.stringify({ deviceId, name: "改了个名", platform: "desktop" });
    expect((await call(world, "/v1/devices", { method: "POST", headers: jsonAuth(alice.token), body: renamed })).status).toBe(204);

    const list = (await (await call(world, "/v1/devices", { headers: auth(alice.token) })).json()) as {
      devices: { deviceId: string; name: string }[];
    };
    expect(list.devices).toHaveLength(1);
    expect(list.devices[0]!.name).toBe("改了个名");
  });

  it("**没有**「踢掉某台设备」的端点（一个密钥所有设备共用，§1.5 代价 3）", async () => {
    const world = makeWorld();
    const alice = world.account();
    const deviceId = "b".repeat(32);
    await call(world, "/v1/devices", { method: "POST", headers: jsonAuth(alice.token), body: JSON.stringify({ deviceId, platform: "web" }) });

    // 任何形状的「删设备」都不存在 —— 返回 404（Hono 的默认 no-route），不是 204。
    for (const path of [`/v1/devices/${deviceId}`, "/v1/devices"]) {
      const response = await call(world, path, { method: "DELETE", headers: auth(alice.token) });
      expect(response.status, `${path} 不该存在`).toBe(404);
    }
    // 设备还在。
    expect(((await (await call(world, "/v1/devices", { headers: auth(alice.token) })).json()) as { devices: unknown[] }).devices).toHaveLength(1);
  });

  it("别人看不到我的设备", async () => {
    const world = makeWorld();
    const alice = world.account();
    const bob = world.account();
    await call(world, "/v1/devices", {
      method: "POST",
      headers: jsonAuth(alice.token),
      body: JSON.stringify({ deviceId: "c".repeat(32), platform: "desktop" }),
    });
    expect(((await (await call(world, "/v1/devices", { headers: auth(bob.token) })).json()) as { devices: unknown[] }).devices).toEqual([]);
  });

  it("deviceId 形状不对 → 400（它要进文档 id）", async () => {
    const world = makeWorld();
    const alice = world.account();
    const response = await call(world, "/v1/devices", {
      method: "POST",
      headers: jsonAuth(alice.token),
      body: JSON.stringify({ deviceId: "../evil", platform: "desktop" }),
    });
    expect(response.status).toBe(400);
  });
});

describe("鉴权", () => {
  it("所有端点都要令牌", async () => {
    const world = makeWorld();
    for (const [method, path] of [
      ["GET", "/v1/notebooks"],
      ["POST", "/v1/notebooks"],
      ["GET", "/v1/devices"],
      ["POST", "/v1/devices"],
      ["POST", "/v1/notebooks/join"],
    ] as const) {
      const response = await call(world, path, { method });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });
});
