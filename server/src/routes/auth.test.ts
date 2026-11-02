/**
 * `/v1/auth/*` 与 `/v1/me*`（`docs/执行-同步重写-2026-11-02.md` 阶段 ①）。
 *
 * 走真实的路由 + 内存库，只把 scrypt 换成低成本参数。
 */

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { openDatabase } from "../db";
import { loadConfig } from "../config";
import { NotebookStore } from "../notebooks";
import { SettingsStore } from "../settings";
import { testAccountStore } from "../auth/testAccounts.test-helper";
import { createAuthRoutes } from "./auth";
import { createAdminRoutes } from "./admin";
import { FakeCouch, couchClient } from "../couch/fakeCouch.test-helper";

const ENV: Record<string, string> = {
  EXTERNAL_BASE_URL: "https://notes.example.com",
  COUCH_URL: "http://couchdb:5984",
  COUCH_USER: "sync-service",
  COUCH_PASSWORD: "pw",
  COUCH_ADMIN_USER: "admin",
  COUCH_ADMIN_PASSWORD: "apw",
};

const DEVICE_A = { deviceId: "a".repeat(32), name: "Lan 的 MacBook Pro", platform: "desktop", os: "macos", clientVersion: "0.16.0" } as const;
const DEVICE_B = { deviceId: "b".repeat(32), name: "公司 ThinkPad", platform: "desktop", os: "windows" } as const;
const PASSWORD = "long-enough-pw";

function makeWorld() {
  const db = openDatabase({ path: ":memory:" });
  const config = loadConfig(ENV);
  const accounts = testAccountStore(db);
  const notebooks = new NotebookStore(db);
  const settings = new SettingsStore(db, config);
  const audit = (event: Parameters<NotebookStore["audit"]>[0]) => notebooks.audit(event);
  const app = new Hono();
  app.route("/v1", createAuthRoutes({ accounts, notebooks, config, settings, audit }));
  app.route("/v1/admin", createAdminRoutes({ accounts, notebooks, config, settings, couch: couchClient(new FakeCouch()), audit }));
  const call = async (path: string, init: { method?: string; token?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    const response = await app.request(`http://localhost${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    return { status: response.status, text, body: text ? (JSON.parse(text) as Record<string, any>) : null };
  };
  const login = (email: string, password = PASSWORD, device: object = DEVICE_A) => call("/v1/auth/login", { body: { email, password, device } });
  return { db, accounts, notebooks, settings, call, login };
}

describe("初始化", () => {
  it("零账号时建出管理员；第二次 409", async () => {
    const world = makeWorld();
    const first = await world.call("/v1/auth/setup", { body: { email: "admin@example.com", password: PASSWORD } });
    expect(first.status).toBe(201);
    expect(first.body?.me).toMatchObject({ email: "admin@example.com", isAdmin: true });
    const second = await world.call("/v1/auth/setup", { body: { email: "x@example.com", password: PASSWORD } });
    expect(second.status).toBe(409);
    expect(second.body?.code).toBe("setup-done");
  });
});

describe("登录", () => {
  it("登录拿到令牌，/me 能用；设备登记了名字与系统", async () => {
    const world = makeWorld();
    await world.accounts.create({ email: "lan@example.com", password: PASSWORD });
    const login = await world.login("LAN@example.com");
    expect(login.status).toBe(200);
    const token = login.body!.token as string;
    expect(token.startsWith("ons_")).toBe(true);
    expect(login.body!.me).toMatchObject({ email: "lan@example.com", deviceId: DEVICE_A.deviceId, loginMethods: { password: true } });

    const me = await world.call("/v1/me", { token });
    expect(me.status).toBe(200);
    expect(me.body?.email).toBe("lan@example.com");

    const devices = await world.call("/v1/me/devices", { token });
    expect(devices.body?.devices).toEqual([
      expect.objectContaining({ deviceId: DEVICE_A.deviceId, name: DEVICE_A.name, os: "macos", clientVersion: "0.16.0", current: true, active: true }),
    ]);
  });

  it("密码错 → 401 bad-credentials；同一邮箱连错 5 次 → 429，正确密码也要等", async () => {
    const world = makeWorld();
    await world.accounts.create({ email: "lan@example.com", password: PASSWORD });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await world.login("lan@example.com", "wrong-password");
      expect(wrong.status).toBe(401);
      expect(wrong.body?.code).toBe("bad-credentials");
    }
    const locked = await world.login("lan@example.com");
    expect(locked.status).toBe(429);
    expect(locked.body?.code).toBe("locked");
  });

  it("同一台设备重新登录：旧令牌作废", async () => {
    const world = makeWorld();
    await world.accounts.create({ email: "lan@example.com", password: PASSWORD });
    const first = (await world.login("lan@example.com")).body!.token as string;
    const second = (await world.login("lan@example.com")).body!.token as string;
    expect((await world.call("/v1/me", { token: first })).status).toBe(401);
    expect((await world.call("/v1/me", { token: second })).status).toBe(200);
  });

  it("登出之后令牌失效", async () => {
    const world = makeWorld();
    await world.accounts.create({ email: "lan@example.com", password: PASSWORD });
    const token = (await world.login("lan@example.com")).body!.token as string;
    expect((await world.call("/v1/auth/logout", { method: "POST", token })).status).toBe(204);
    expect((await world.call("/v1/me", { token })).status).toBe(401);
  });

  it("关掉邮箱密码登录后 → 403", async () => {
    const world = makeWorld();
    await world.accounts.create({ email: "lan@example.com", password: PASSWORD });
    world.settings.set({ passwordLogin: false });
    const response = await world.login("lan@example.com");
    expect(response.status).toBe(403);
    expect(response.body?.code).toBe("password-login-disabled");
  });

  it("响应里没有密码哈希或令牌哈希", async () => {
    const world = makeWorld();
    await world.accounts.create({ email: "lan@example.com", password: PASSWORD });
    const login = await world.login("lan@example.com");
    const me = await world.call("/v1/me", { token: login.body!.token as string });
    for (const text of [login.text, me.text]) {
      expect(text).not.toContain("password_hash");
      expect(text).not.toContain("token_hash");
      expect(text).not.toContain("scrypt$");
    }
  });
});

describe("开放注册", () => {
  it("默认只接受邀请；改成开放后可以直接注册并登录", async () => {
    const world = makeWorld();
    const body = { email: "new@example.com", password: PASSWORD, device: DEVICE_A, displayName: "New" };
    const closed = await world.call("/v1/auth/register", { body });
    expect(closed.status).toBe(403);
    world.settings.set({ registration: "open" });
    const open = await world.call("/v1/auth/register", { body });
    expect(open.status).toBe(200);
    expect(open.body?.me).toMatchObject({ email: "new@example.com", displayName: "New" });
  });
});

describe("邀请链接", () => {
  it("管理员生成链接 → /join 页读内容 → 设密码接受 → 客户端登录", async () => {
    const world = makeWorld();
    await world.accounts.setup({ email: "admin@example.com", password: PASSWORD });
    const adminToken = (await world.login("admin@example.com")).body!.token as string;
    const invite = await world.call("/v1/admin/invites", { token: adminToken, body: { email: "chen@example.com", quotaBytes: 5_000_000_000 } });
    expect(invite.status).toBe(201);
    const code = invite.body!.code as string;
    expect(invite.body!.url).toBe(`https://notes.example.com/join/${code}`);

    const info = await world.call(`/v1/auth/invites/${code}`);
    expect(info.body).toMatchObject({ email: "chen@example.com", grantAdmin: false, quotaBytes: 5_000_000_000 });

    const accepted = await world.call(`/v1/auth/invites/${code}`, { body: { email: "chen@example.com", password: PASSWORD, displayName: "Chen" } });
    expect(accepted.status).toBe(201);
    expect(accepted.body?.me).toMatchObject({ email: "chen@example.com", displayName: "Chen", quota: { bytesLimit: 5_000_000_000 } });

    expect((await world.call(`/v1/auth/invites/${code}`)).status).toBe(410);
    expect((await world.login("chen@example.com", PASSWORD, DEVICE_B)).status).toBe(200);
  });

  it("不存在的码 → 404", async () => {
    const world = makeWorld();
    expect((await world.call("/v1/auth/invites/join_nope")).status).toBe(404);
  });
});

describe("重置密码链接", () => {
  it("管理员发链接 → /reset 页设新密码 → 旧设备全部下线、新密码能登录", async () => {
    const world = makeWorld();
    await world.accounts.setup({ email: "admin@example.com", password: PASSWORD });
    const member = await world.accounts.create({ email: "mia@example.com", password: "old-password-1" });
    const adminToken = (await world.login("admin@example.com")).body!.token as string;
    const miaToken = (await world.login("mia@example.com", "old-password-1", DEVICE_B)).body!.token as string;

    const reset = await world.call(`/v1/admin/accounts/${member.id}/password-reset`, { method: "POST", token: adminToken });
    expect(reset.status).toBe(201);
    const code = reset.body!.code as string;
    expect(reset.body!.url).toBe(`https://notes.example.com/reset/${code}`);

    expect((await world.call(`/v1/auth/password-resets/${code}`)).body).toEqual({ email: "mia@example.com" });
    expect((await world.call(`/v1/auth/password-resets/${code}`, { body: { password: "short" } })).status).toBe(400);
    expect((await world.call(`/v1/auth/password-resets/${code}`, { body: { password: "brand-new-password" } })).status).toBe(204);

    expect((await world.call("/v1/me", { token: miaToken })).status).toBe(401);
    expect((await world.login("mia@example.com", "brand-new-password", DEVICE_B)).status).toBe(200);
  });
});

describe("我的设备", () => {
  it("移除另一台设备：它的令牌立刻 401，列表里标成已移除；不能移除自己", async () => {
    const world = makeWorld();
    await world.accounts.create({ email: "lan@example.com", password: PASSWORD });
    const here = (await world.login("lan@example.com", PASSWORD, DEVICE_A)).body!.token as string;
    const there = (await world.login("lan@example.com", PASSWORD, DEVICE_B)).body!.token as string;

    expect((await world.call(`/v1/me/devices/${DEVICE_A.deviceId}`, { method: "DELETE", token: here })).status).toBe(400);
    expect((await world.call(`/v1/me/devices/${DEVICE_B.deviceId}`, { method: "DELETE", token: here })).status).toBe(204);
    expect((await world.call("/v1/me", { token: there })).status).toBe(401);

    const devices = (await world.call("/v1/me/devices", { token: here })).body!.devices as { deviceId: string; active: boolean }[];
    expect(devices.find((device) => device.deviceId === DEVICE_B.deviceId)?.active).toBe(false);

    // 被移除的设备重新登录就回来了。
    expect((await world.login("lan@example.com", PASSWORD, DEVICE_B)).status).toBe(200);
    const after = (await world.call("/v1/me/devices", { token: here })).body!.devices as { deviceId: string; active: boolean }[];
    expect(after.find((device) => device.deviceId === DEVICE_B.deviceId)?.active).toBe(true);
  });

  it("改密码：这台保留，其它设备下线", async () => {
    const world = makeWorld();
    await world.accounts.create({ email: "lan@example.com", password: PASSWORD });
    const here = (await world.login("lan@example.com", PASSWORD, DEVICE_A)).body!.token as string;
    const there = (await world.login("lan@example.com", PASSWORD, DEVICE_B)).body!.token as string;
    const wrong = await world.call("/v1/me/password", { token: here, body: { currentPassword: "nope-nope-nope", newPassword: "next-password-1" } });
    expect(wrong.status).toBe(401);
    const ok = await world.call("/v1/me/password", { token: here, body: { currentPassword: PASSWORD, newPassword: "next-password-1" } });
    expect(ok.status).toBe(204);
    expect((await world.call("/v1/me", { token: here })).status).toBe(200);
    expect((await world.call("/v1/me", { token: there })).status).toBe(401);
  });
});

describe("管理员改账号", () => {
  it("设配额、设管理员；不能撤掉最后一个管理员", async () => {
    const world = makeWorld();
    const admin = await world.accounts.setup({ email: "admin@example.com", password: PASSWORD });
    const member = await world.accounts.create({ email: "mia@example.com" });
    const token = (await world.login("admin@example.com")).body!.token as string;

    expect((await world.call(`/v1/admin/accounts/${member.id}`, { method: "PATCH", token, body: { quotaBytes: 5_000 } })).status).toBe(204);
    expect(world.accounts.findById(member.id)?.quota_bytes).toBe(5_000);
    const last = await world.call(`/v1/admin/accounts/${admin.id}`, { method: "PATCH", token, body: { isAdmin: false } });
    expect(last.status).toBe(409);
    expect((await world.call(`/v1/admin/accounts/${member.id}`, { method: "PATCH", token, body: { isAdmin: true } })).status).toBe(204);

    const list = await world.call("/v1/admin/accounts", { token });
    const mia = (list.body!.accounts as { email: string; isAdmin: boolean; quota: { bytesLimit: number } }[]).find((row) => row.email === "mia@example.com");
    expect(mia).toMatchObject({ isAdmin: true, quota: { bytesLimit: 5_000 } });
  });

  it("服务设置可读可改，非法值 400", async () => {
    const world = makeWorld();
    await world.accounts.setup({ email: "admin@example.com", password: PASSWORD });
    const token = (await world.login("admin@example.com")).body!.token as string;
    expect((await world.call("/v1/admin/settings", { token })).body).toMatchObject({ registration: "invite", passwordLogin: true });
    expect((await world.call("/v1/admin/settings", { method: "PATCH", token, body: { registration: "anyone" } })).status).toBe(400);
    const patched = await world.call("/v1/admin/settings", { method: "PATCH", token, body: { registration: "open", defaultQuotaBytes: 1_000 } });
    expect(patched.body).toMatchObject({ registration: "open", defaultQuotaBytes: 1_000 });
  });
});
