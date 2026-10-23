/**
 * 管理员二次验证（step-up）、删除账号、管理员位与聚合读端点。
 *
 * ## 这一组钉的是什么
 *
 * 1. **step-up 是独立的一条闸门**：`requireAdmin()` 通过 ≠ 可以删东西。
 * 2. **step-up 标记必须对应同一个账号** —— 否则普通账号能拿自己的密钥
 *    通过验证，再去执行管理动作（那样这道门就白装了）。
 * 3. **不能删最后一个管理员**，也不能删自己。
 * 4. **提权/降权只在 CLI**：HTTP 上没有这个端点（有反证断言）。
 * 5. 管理端聚合端点**绝不返回密钥材料**。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { FakeCouch, couchClient } from "../couch/fakeCouch.test-helper";
import { AccountStore, newAccountId, newAuthTokenForTests } from "../auth/accounts";
import { NotebookStore } from "../notebooks";
import { createPanelApi } from "./panel";
import { createAdminViewRoutes } from "./adminView";
import { CSRF_VALUE, PANEL_COOKIE, STEP_UP_COOKIE, csrfGuard } from "../panelSecurity";
import { loadConfig, type ServerConfig } from "../config";

vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    openDatabase: (options: { path: string }) =>
      (actual as { openDatabase: (o: unknown) => DatabaseSync }).openDatabase({ ...options, path: ":memory:" }),
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
  app: Hono;
  accounts: AccountStore;
  notebooks: NotebookStore;
  config: ServerConfig;
  admin(): { id: string; token: string };
  member(): { id: string; token: string };
}

function makeWorld(): World {
  const db = openDatabase({ path: ":memory:" });
  const fake = new FakeCouch();
  const accounts = new AccountStore(db);
  const notebooks = new NotebookStore(db);
  const config = loadConfig(ENV);
  const couch = couchClient(fake);
  const app = new Hono();
  app.use("/panel/api/*", csrfGuard());
  const audit = (event: { actorId: string | null; action: string; target?: string | null; ip?: string | null; detail?: string | null }): void =>
    notebooks.audit(event);
  const deps = { accounts, notebooks, config, couch, couchAdmin: couch, audit };
  app.route("/panel/api", createPanelApi(deps));
  app.route("/panel/api/admin", createAdminViewRoutes(deps));
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
  return { app, accounts, notebooks, config, admin: () => create(true), member: () => create(false) };
}

const call = (world: World, path: string, init: RequestInit = {}): Promise<Response> =>
  Promise.resolve(world.app.request("http://localhost/panel/api" + path, init));

/** 带会话 cookie 的请求；变更类自动补 CSRF 头。 */
function as(token: string, method = "GET", extra: Record<string, string> = {}): RequestInit {
  return {
    method,
    headers: {
      cookie: PANEL_COOKIE + "=" + encodeURIComponent(token),
      ...(method === "GET" || method === "HEAD" ? {} : { "x-requested-with": CSRF_VALUE, "content-type": "application/json" }),
      ...extra,
    },
  };
}

/** 已经通过二次验证的请求（多带一个 step-up cookie）。 */
function stepped(token: string, method = "POST", extra: Record<string, string> = {}): RequestInit {
  const base = as(token, method, extra);
  const headers = { ...(base.headers as Record<string, string>) };
  headers.cookie = headers.cookie + "; " + STEP_UP_COOKIE + "=" + encodeURIComponent(token);
  return { ...base, headers };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("二次验证（step-up）", () => {
  it("没验证过 → 删账号被拒，且 code 是 step-up-required（不是 403 forbidden）", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const victim = world.member();
    const response = await call(world, "/admin/accounts/" + victim.id, as(admin.token, "DELETE"));
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string };
    // ★ 与「你不是管理员」区分开：页面据此弹密钥框，而不是显示「无权限」。
    expect(body.code).toBe("step-up-required");
    // 账号必须还在。
    expect(world.accounts.findById2(victim.id)).not.toBeNull();
  });

  it("POST /session/verify 成功 → 回 step-up cookie，且响应体里没有令牌", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const response = await call(world, "/session/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-requested-with": CSRF_VALUE,
        cookie: PANEL_COOKIE + "=" + encodeURIComponent(admin.token),
      },
      body: JSON.stringify({ authToken: admin.token }),
    });
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(STEP_UP_COOKIE + "=");
    expect(setCookie).toContain("HttpOnly");
    // 5 分钟，不是 8 小时。
    expect(setCookie).toContain("Max-Age=300");
    expect(await response.text()).not.toContain(admin.token);
  });

  it("★ 拿**别人的**密钥验证 → 403（否则普通账号能自己给自己盖章）", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const member = world.member();
    const response = await call(world, "/session/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-requested-with": CSRF_VALUE,
        cookie: PANEL_COOKIE + "=" + encodeURIComponent(member.token),
      },
      body: JSON.stringify({ authToken: admin.token }),
    });
    expect(response.status).toBe(403);
    expect((await response.json() as { code: string }).code).toBe("forbidden");
    expect(response.headers.get("set-cookie") ?? "").not.toContain(STEP_UP_COOKIE + "=");
  });

  it("验证之后可以删账号，且独占库一并清理", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const victim = world.member();
    const notebook = world.notebooks.create({ ownerId: victim.id, name: "他的库", cryptoMode: "none" });
    expect(world.notebooks.findById(notebook.id)).not.toBeNull();

    const response = await call(world, "/admin/accounts/" + victim.id, stepped(admin.token, "DELETE"));
    expect(response.status).toBe(200);
    expect(world.accounts.findById2(victim.id)).toBeNull();
    expect(world.notebooks.findById(notebook.id)).toBeNull();
  });

  it("★ step-up 标记必须属于**当前会话账号**：两个管理员之间也不能借用", async () => {
    const world = makeWorld();
    const alice = world.admin();
    const bob = world.admin();
    const victim = world.member();
    /*
     * alice 用**bob 的** step-up 标记来删账号。
     * 两个都是管理员，所以管理员闸门会放行 —— 拦住它的必须是
     * requireStepUp 里那一条「标记对应的是不是当前会话的账号」。
     */
    const borrowed: RequestInit = {
      method: "DELETE",
      headers: {
        // ★ 会话是 alice 的，step-up 标记是 bob 的 —— 这正是要拦的那个形状。
        cookie: PANEL_COOKIE + "=" + encodeURIComponent(alice.token) + "; " + STEP_UP_COOKIE + "=" + encodeURIComponent(bob.token),
        "x-requested-with": CSRF_VALUE,
        "content-type": "application/json",
      },
    };
    const response = await call(world, "/admin/accounts/" + victim.id, borrowed);
    expect(response.status).toBe(403);
    expect((await response.json() as { code: string }).code).toBe("step-up-required");
    expect(world.accounts.findById2(victim.id)).not.toBeNull();
    // 用 alice 自己的标记则通过。
    const ok = await call(world, "/admin/accounts/" + victim.id, stepped(alice.token, "DELETE"));
    expect(ok.status).toBe(200);
  });

  it("不能删自己，也不能删最后一个管理员", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const self = await call(world, "/admin/accounts/" + admin.id, stepped(admin.token, "DELETE"));
    expect(self.status).toBe(400);

    const other = world.admin();
    // 现在有两个活跃管理员。删掉 other 是允许的（还剩一个）。
    const okDelete = await call(world, "/admin/accounts/" + other.id, stepped(admin.token, "DELETE"));
    expect(okDelete.status).toBe(200);
    // 只剩自己了，但「不能删自己」先拦住。
    const again = await call(world, "/admin/accounts/" + admin.id, stepped(admin.token, "DELETE"));
    expect(again.status).toBe(400);
  });

  it("退出登录时**同时清掉** step-up 标记", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const response = await call(world, "/session", as(admin.token, "DELETE"));
    expect(response.status).toBe(204);
    const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [response.headers.get("set-cookie") ?? ""];
    const joined = cookies.join("\n");
    expect(joined).toContain(PANEL_COOKIE + "=");
    expect(joined).toContain(STEP_UP_COOKIE + "=");
    expect(joined).toContain("Max-Age=0");
  });
});

describe("管理员位：只能从 CLI 改（§4.12 根信任通道）", () => {
  it("★ HTTP 上**没有**提权端点（有它就是「被盗管理员能无限造管理员」）", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const member = world.member();
    for (const path of ["/admin/accounts/" + member.id + "/admin", "/admin/grant", "/admin/accounts/" + member.id + "/role"]) {
      const response = await call(world, path, as(admin.token, "POST", { "content-type": "application/json" }));
      // 404（没这个路由）才算对；201/200 就是开了一个提权口子。
      expect(response.status, path + " 不该存在").toBe(404);
    }
    expect(world.accounts.findById2(member.id)?.is_admin).toBe(0);
  });

  it("setAdmin 提升之后，该账号立刻能打开管理区块（不用重新登录）", async () => {
    const world = makeWorld();
    const member = world.member();
    expect((await call(world, "/admin/overview", as(member.token))).status).toBe(403);
    const result = world.accounts.setAdmin(member.id, true);
    expect(result.ok).toBe(true);
    expect((await call(world, "/admin/overview", as(member.token))).status).toBe(200);
  });

  it("★ 不能降权最后一个活跃管理员", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const result = world.accounts.setAdmin(admin.id, false);
    expect(result).toEqual({ ok: false, reason: "last-admin" });
    expect(world.accounts.findById2(admin.id)?.is_admin).toBe(1);
  });

  it("有两个管理员时可以降掉其中一个", async () => {
    const world = makeWorld();
    const first = world.admin();
    const second = world.admin();
    expect(world.accounts.setAdmin(second.id, false)).toEqual({ ok: true, changed: true });
    expect(world.accounts.countAdmins()).toBe(1);
    // 剩下的那个仍然降不掉。
    expect(world.accounts.setAdmin(first.id, false)).toEqual({ ok: false, reason: "last-admin" });
  });
});

describe("管理端聚合读端点", () => {
  it("普通账号访问每一个新端点 → 403", async () => {
    const world = makeWorld();
    const member = world.member();
    for (const path of ["/admin/overview", "/admin/notebooks", "/admin/devices", "/admin/invites", "/admin/config"]) {
      const response = await call(world, path, as(member.token));
      expect(response.status, path).toBe(403);
    }
  });

  it("未登录 → 401（与 403 分开）", async () => {
    const world = makeWorld();
    const response = await call(world, "/admin/overview");
    expect(response.status).toBe(401);
  });

  it("★ 响应里不出现任何密钥材料", async () => {
    const world = makeWorld();
    const admin = world.admin();
    for (const path of ["/admin/overview", "/admin/notebooks", "/admin/devices", "/admin/invites", "/admin/config"]) {
      const text = await (await call(world, path, as(admin.token))).text();
      for (const forbidden of ["auth_hash", "authHash", "wrapped_enc_root", "wrappedEncRoot"]) {
        expect(text, path + " 泄露了 " + forbidden).not.toContain(forbidden);
      }
    }
  });

  it("overview 的 attention 是**判读**（随数据下发，不是前端算）", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const response = await call(world, "/admin/overview", as(admin.token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { attention: unknown[]; health: { couchOk: boolean }; accounts: { admins: number } };
    expect(Array.isArray(body.attention)).toBe(true);
    expect(body.health.couchOk).toBe(true);
    expect(body.accounts.admins).toBe(1);
  });

  it("config 只读，且不下发密钥类配置", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const response = await call(world, "/admin/config", as(admin.token));
    const body = (await response.json()) as { readOnly: boolean; config: Record<string, unknown> };
    expect(body.readOnly).toBe(true);
    expect(body.config.couchAdminUserConfigured).toBe(true);
    // 口令本身不能出现。
    expect(JSON.stringify(body)).not.toContain("apw");
    expect(JSON.stringify(body)).not.toContain("couchAdminPassword");
  });

  it("对单个库做核对会写进 notebook_provisioning 并留审计", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const notebook = world.notebooks.create({ ownerId: admin.id, name: "核对我", cryptoMode: "none" });
    const response = await call(world, "/admin/notebooks/" + notebook.id + "/inspection", as(admin.token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { inspection: { databaseExists: boolean; problems: string[] } };
    // FakeCouch 里没建过这个库，所以它诚实地说「不存在」而不是编一个健康的结论。
    expect(body.inspection.databaseExists).toBe(false);
    expect(body.inspection.problems.length).toBeGreaterThan(0);
  });

  it("核对不存在的笔记本 → 404", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const response = await call(world, "/admin/notebooks/does-not-exist/inspection", as(admin.token));
    expect(response.status).toBe(404);
  });
});

describe("按哈希作废邀请码（管理页只有哈希，没有明文）", () => {
  it("作废成功后列表里变成「已作废」；重复作废仍是 204（幂等）", async () => {
    const world = makeWorld();
    const admin = world.admin();
    world.accounts.createInvite({ createdBy: admin.id, expiresInSeconds: 3600, maxUses: 1 });
    const before = await call(world, "/admin/invites", as(admin.token));
    const list = (await before.json()) as { invites: { codeHash: string; revokedAt: number | null }[] };
    const hash = list.invites.find((row) => row.revokedAt === null)!.codeHash;

    const first = await call(world, "/admin/invites/" + hash, as(admin.token, "DELETE"));
    expect(first.status).toBe(204);
    const after = (await (await call(world, "/admin/invites", as(admin.token))).json()) as { invites: { codeHash: string; revokedAt: number | null }[] };
    expect(after.invites.find((row) => row.codeHash === hash)!.revokedAt).not.toBeNull();

    // 幂等：目标状态已达成，再作废一次不是错误。
    expect((await call(world, "/admin/invites/" + hash, as(admin.token, "DELETE"))).status).toBe(204);
  });

  it("★ 哈希形状不对 → 400（挡住「把明文码当哈希传进来」这种静默失败）", async () => {
    const world = makeWorld();
    const admin = world.admin();
    for (const bad of ["inv_abc", "not-a-hash", "zz".repeat(32)]) {
      const response = await call(world, "/admin/invites/" + bad, as(admin.token, "DELETE"));
      expect(response.status, bad).toBe(400);
    }
  });

  it("普通账号不能作废（先撞管理员闸门）", async () => {
    const world = makeWorld();
    const member = world.member();
    const response = await call(world, "/admin/invites/" + "a".repeat(64), as(member.token, "DELETE"));
    expect(response.status).toBe(403);
  });
});

describe("冲突热点是**全站**聚合（不是当前账号）", () => {
  it("★ 两个账号的冲突分别归到自己名下", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const other = world.member();
    const nbA = world.notebooks.create({ ownerId: admin.id, name: "甲的库", cryptoMode: "none" });
    const nbB = world.notebooks.create({ ownerId: other.id, name: "乙的库", cryptoMode: "none" });
    world.notebooks.reportStats({ accountId: admin.id, notebookId: nbA.id, day: "2026-10-20", conflicts: 3, errors: 1, pushes: 10, pulls: 12, deletes: 0 });
    world.notebooks.reportStats({ accountId: other.id, notebookId: nbB.id, day: "2026-10-20", conflicts: 7, errors: 0, pushes: 8, pulls: 9, deletes: 0 });

    const body = (await (await call(world, "/admin/overview", as(admin.token))).json()) as {
      conflictHotspots: { accountId: string; conflicts: number; errors: number; notebooks: number }[];
    };
    expect(body.conflictHotspots.length).toBe(2);
    // 按影响排序：乙（7）在甲（4）前面。
    expect(body.conflictHotspots[0]!.accountId).toBe(other.id);
    expect(body.conflictHotspots[0]!.conflicts).toBe(7);
    expect(body.conflictHotspots[1]!.accountId).toBe(admin.id);
    expect(body.conflictHotspots[1]!.conflicts).toBe(3);
    expect(body.conflictHotspots[1]!.notebooks).toBe(1);
  });

  it("没有冲突时热点是空数组（不是 null）", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const body = (await (await call(world, "/admin/overview", as(admin.token))).json()) as { conflictHotspots: unknown[] };
    expect(Array.isArray(body.conflictHotspots)).toBe(true);
    expect(body.conflictHotspots.length).toBe(0);
  });
});

describe("全站流量：客户端上报与服务端实测**合并**（不是只信上报）", () => {
  /*
   * 背景：`traffic` 原先只读 `client_stats`，而当前客户端从不调 `POST /v1/stats`
   * ⇒ 概览页的流量图在生产上**永远是一条空线**，哪怕同步一直在跑。
   *
   * 现在服务端在 `/v1` 数据面上自己数一份（`sync_activity`），两份按天取较大值合并。
   * 这组用例钉住「只有实测」「只有上报」「两者都有」三种情况。
   */

  it("★ 只有服务端实测（客户端不上报）时，流量图也有数", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const notebook = world.notebooks.create({ ownerId: admin.id, name: "n", cryptoMode: "none" });
    world.notebooks.recordActivity({ accountId: admin.id, notebookId: notebook.id, day: "2026-10-20", kind: "pull", amount: 4 });
    world.notebooks.recordActivity({ accountId: admin.id, notebookId: notebook.id, day: "2026-10-20", kind: "push", amount: 2 });
    world.notebooks.recordActivity({ accountId: admin.id, notebookId: notebook.id, day: "2026-10-20", kind: "conflict" });

    const body = (await (await call(world, "/admin/overview", as(admin.token))).json()) as {
      traffic: { days: { day: string; pulls: number; pushes: number; conflicts: number }[]; total: { pulls: number; pushes: number; conflicts: number } };
    };
    expect(body.traffic.days).toHaveLength(1);
    expect(body.traffic.days[0]).toMatchObject({ day: "2026-10-20", pulls: 4, pushes: 2, conflicts: 1 });
    expect(body.traffic.total).toMatchObject({ pulls: 4, pushes: 2, conflicts: 1 });
  });

  it("两边都有时取**较大值**（同一批请求不该被数两遍）", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const notebook = world.notebooks.create({ ownerId: admin.id, name: "n", cryptoMode: "none" });
    // 客户端说 3 次拉取，服务端数到 5 次。
    world.notebooks.reportStats({ accountId: admin.id, notebookId: notebook.id, day: "2026-10-20", pulls: 3, pushes: 0, deletes: 0, conflicts: 0, errors: 0 });
    world.notebooks.recordActivity({ accountId: admin.id, notebookId: notebook.id, day: "2026-10-20", kind: "pull", amount: 5 });

    const body = (await (await call(world, "/admin/overview", as(admin.token))).json()) as { traffic: { total: { pulls: number } } };
    // 相加会得到 8；正确答案是 5。
    expect(body.traffic.total.pulls).toBe(5);
  });

  it("实测到的冲突也会进热点榜（否则「图上有冲突、榜上没有账号」）", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const notebook = world.notebooks.create({ ownerId: admin.id, name: "n", cryptoMode: "none" });
    world.notebooks.recordActivity({ accountId: admin.id, notebookId: notebook.id, day: "2026-10-20", kind: "conflict", amount: 3 });

    const body = (await (await call(world, "/admin/overview", as(admin.token))).json()) as {
      conflictHotspots: { accountId: string; conflicts: number; notebooks: number }[];
    };
    expect(body.conflictHotspots).toHaveLength(1);
    expect(body.conflictHotspots[0]).toMatchObject({ accountId: admin.id, conflicts: 3, notebooks: 1 });
  });
});

