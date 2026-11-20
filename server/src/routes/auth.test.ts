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
import { ShareStore } from "../shares";
import { testAccountStore } from "../auth/testAccounts.test-helper";
import { createAuthRoutes, LoginThrottle } from "./auth";
import { createAdminRoutes } from "./admin";
import { FakeCouch, couchClient } from "../couch/fakeCouch.test-helper";
import { holdAccountLogins, waitUntil } from "./loginConcurrency.test-helper";

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

function makeWorld(options: { throttle?: LoginThrottle } = {}) {
  const db = openDatabase({ path: ":memory:" });
  const config = loadConfig(ENV);
  const accounts = testAccountStore(db);
  const notebooks = new NotebookStore(db);
  const shares = new ShareStore(db);
  const settings = new SettingsStore(db, config);
  const audit = (event: Parameters<NotebookStore["audit"]>[0]) => notebooks.audit(event);
  const throttle = options.throttle ?? new LoginThrottle();
  const app = new Hono();
  app.route("/v1", createAuthRoutes({ accounts, notebooks, config, settings, audit, throttle }));
  app.route(
    "/v1/admin",
    createAdminRoutes({ accounts, notebooks, shares, config, settings, couch: couchClient(new FakeCouch()), couchAdmin: couchClient(new FakeCouch()), audit }),
  );
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
  return { db, accounts, notebooks, settings, throttle, call, login };
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

  it("★ 同一台电脑换账号登录 ⇒ 设备跟到新账号（真机：Windows 换账号后设置页只列出 Mac）", async () => {
    const world = makeWorld();
    await world.accounts.create({ email: "old@example.com", password: PASSWORD });
    await world.accounts.create({ email: "new@example.com", password: PASSWORD });
    const old = (await world.login("old@example.com", PASSWORD, DEVICE_B)).body!.token as string;
    const fresh = (await world.login("new@example.com", PASSWORD, DEVICE_B)).body!.token as string;

    const mine = (await world.call("/v1/me/devices", { token: fresh })).body!.devices as { deviceId: string; current: boolean }[];
    expect(mine).toEqual([expect.objectContaining({ deviceId: DEVICE_B.deviceId, current: true })]);
    // 旧账号那边不再列它（它已经不是那个账号的设备了）。
    const theirs = (await world.call("/v1/me/devices", { token: old })).body!.devices as unknown[];
    expect(theirs).toEqual([]);
  });

  it("没有这台设备会话的账号**不能**靠填 deviceId 把别人的设备改挂过来", async () => {
    const world = makeWorld();
    const alice = await world.accounts.create({ email: "alice@example.com", password: PASSWORD });
    const bob = await world.accounts.create({ email: "bob@example.com", password: PASSWORD });
    await world.login("alice@example.com", PASSWORD, DEVICE_A);
    // bob 从别的设备登录，然后在检查点 / POST /v1/devices 里填 alice 的 deviceId。
    world.notebooks.upsertDevice({ deviceId: DEVICE_A.deviceId, accountId: bob.id, name: "抢来的", platform: "web" });

    expect(world.notebooks.listDevices(bob.id)).toEqual([]);
    expect(world.notebooks.listDevices(alice.id)).toEqual([expect.objectContaining({ deviceId: DEVICE_A.deviceId, name: DEVICE_A.name })]);
  });

  it("已经换过账号的设备：下一次带着新账号会话登记（检查点）时自己改挂过来", async () => {
    const world = makeWorld();
    const oldAccount = await world.accounts.create({ email: "old@example.com", password: PASSWORD });
    const newAccount = await world.accounts.create({ email: "new@example.com", password: PASSWORD });
    // 修复之前的现场：设备行挂在旧账号名下，而新账号已经有这台设备的有效会话。
    world.notebooks.upsertDevice({ deviceId: DEVICE_B.deviceId, accountId: oldAccount.id, name: "win 一号机", platform: "desktop" });
    world.accounts.createSession({ accountId: newAccount.id, kind: "device", deviceId: DEVICE_B.deviceId });
    expect(world.notebooks.listDevices(newAccount.id)).toEqual([]);

    world.notebooks.upsertDevice({ deviceId: DEVICE_B.deviceId, accountId: newAccount.id, name: null, platform: null });
    expect(world.notebooks.listDevices(newAccount.id)).toEqual([expect.objectContaining({ deviceId: DEVICE_B.deviceId, name: "win 一号机" })]);
    expect(world.notebooks.listDevices(oldAccount.id)).toEqual([]);
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

  it("同一邮箱并发 10 次错密码：只有在途名额进入校验，其余直接 429", async () => {
    const throttle = new LoginThrottle(5, 15 * 60_000, 100, 2, 10);
    const world = makeWorld({ throttle });
    await world.accounts.create({ email: "lan@example.com", password: PASSWORD });
    const held = holdAccountLogins(world.accounts);
    try {
      const requests = Array.from({ length: 10 }, (_, index) =>
        world.login("lan@example.com", "wrong-password", {
          ...DEVICE_A,
          deviceId: index.toString(16).padStart(32, "0"),
        }),
      );
      await waitUntil(() => held.entered() >= 2, "两个登录请求进入账号校验");
      held.release();
      const results = await Promise.all(requests);

      expect(held.entered()).toBe(2);
      expect(results.filter((result) => result.status === 401)).toHaveLength(2);
      expect(results.filter((result) => result.status === 429 && result.body?.code === "busy")).toHaveLength(8);
    } finally {
      held.restore();
    }
  });

  it("并发正确密码都成功，不占失败额度；之后仍能连续失败 4 次", async () => {
    const throttle = new LoginThrottle(5, 15 * 60_000, 100, 5, 10);
    const world = makeWorld({ throttle });
    await world.accounts.create({ email: "lan@example.com", password: PASSWORD });
    const held = holdAccountLogins(world.accounts);
    try {
      const requests = Array.from({ length: 5 }, (_, index) =>
        world.login("lan@example.com", PASSWORD, {
          ...DEVICE_A,
          deviceId: (index + 16).toString(16).padStart(32, "0"),
        }),
      );
      await waitUntil(() => held.entered() >= 5, "五个正确密码同时进入账号校验");
      held.release();
      const results = await Promise.all(requests);

      expect(results.map((result) => result.status)).toEqual([200, 200, 200, 200, 200]);
      expect(throttle.lockedFor("lan@example.com")).toBeNull();
      for (let attempt = 0; attempt < 4; attempt += 1) {
        expect((await world.login("lan@example.com", "wrong-password")).status).toBe(401);
      }
      expect(throttle.lockedFor("lan@example.com")).toBeNull();
    } finally {
      held.restore();
    }
  });

  it("成功与失败并发时各自结算，成功会清掉已记下的失败", async () => {
    const throttle = new LoginThrottle(5, 15 * 60_000, 100, 5, 10);
    const world = makeWorld({ throttle });
    await world.accounts.create({ email: "lan@example.com", password: PASSWORD });
    const held = holdAccountLogins(world.accounts);
    try {
      const batch = [
        world.login("lan@example.com", PASSWORD),
        world.login("lan@example.com", "wrong-password"),
        world.login("lan@example.com", PASSWORD),
        world.login("lan@example.com", "wrong-password"),
        world.login("lan@example.com", "wrong-password"),
      ];
      await waitUntil(() => held.entered() >= 5, "五个混合登录请求进入账号校验");
      held.release();
      const results = await Promise.all(batch);

      expect(results.map((result) => result.status)).toEqual([200, 401, 200, 401, 401]);
      expect(throttle.lockedFor("lan@example.com")).toBeNull();
      expect((await world.login("lan@example.com", PASSWORD)).status).toBe(200);
      expect(throttle.lockedFor("lan@example.com")).toBeNull();
    } finally {
      held.restore();
    }
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

describe("LoginThrottle", () => {
  it("在途名额是同步预占的：同一邮箱超限、全局超限都直接拒绝", () => {
    const throttle = new LoginThrottle(5, 15 * 60_000, 100, 2, 2);
    const now = 1_000_000;

    const first = throttle.reserve("lan@example.com", now);
    const second = throttle.reserve("lan@example.com", now);
    expect(first.admitted).toBe(true);
    expect(second.admitted).toBe(true);
    if (!first.admitted || !second.admitted) throw new Error("前两个请求应当拿到在途名额");
    expect(throttle.reserve("lan@example.com", now)).toMatchObject({ admitted: false, reason: "busy" });
    expect(throttle.reserve("other@example.com", now)).toMatchObject({ admitted: false, reason: "busy" });

    first.attempt.release();
    const third = throttle.reserve("other@example.com", now);
    expect(third.admitted).toBe(true);
    second.attempt.release();
    expect(throttle.reserve("lan@example.com", now).admitted).toBe(true);
  });

  it("失败结算后才回到窗口计数；窗口过期后可重新进入", () => {
    const throttle = new LoginThrottle(2, 60_000, 100);
    const now = 1_000_000;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const admission = throttle.reserve("lan@example.com", now + attempt);
      expect(admission.admitted).toBe(true);
      if (admission.admitted) admission.attempt.fail(now + attempt);
    }
    expect(throttle.reserve("lan@example.com", now + 2)).toMatchObject({ admitted: false, reason: "locked" });
    expect(throttle.reserve("lan@example.com", now + 60_001).admitted).toBe(true);
  });

  it("大量随机邮箱不会无界增长：超过上限时淘汰最久没失败的", () => {
    const throttle = new LoginThrottle(5, 15 * 60_000, 100);
    const now = 1_000_000;
    for (let i = 0; i < 100; i += 1) {
      for (let attempt = 0; attempt < 5; attempt += 1) throttle.fail(`random-${i}@example.com`, now);
    }
    expect(throttle.size).toBe(100);
    expect(throttle.lockedFor("random-0@example.com", now)).not.toBeNull();

    throttle.fail("one-more@example.com", now);
    expect(throttle.size).toBe(100);
    expect(throttle.lockedFor("random-0@example.com", now)).toBeNull();
    expect(throttle.lockedFor("random-1@example.com", now)).not.toBeNull();
  });

  it("没人再访问的过期邮箱也会被全局清理", () => {
    const throttle = new LoginThrottle(5, 60_000, 100);
    const now = 1_000_000;
    throttle.fail("old@example.com", now);
    expect(throttle.size).toBe(1);

    throttle.fail("new@example.com", now + 60_001);
    expect(throttle.size).toBe(1);
    expect(throttle.lockedFor("old@example.com", now + 60_001)).toBeNull();
  });

  it("5 次失败锁 15 分钟，成功后立即清零", () => {
    const throttle = new LoginThrottle();
    const now = 1_000_000;
    for (let attempt = 0; attempt < 5; attempt += 1) throttle.fail("lan@example.com", now + attempt);
    expect(throttle.lockedFor("lan@example.com", now + 4)).not.toBeNull();
    expect(throttle.lockedFor("lan@example.com", now + 4 + 15 * 60_000)).toBeNull();

    for (let attempt = 0; attempt < 4; attempt += 1) throttle.fail("lan@example.com", now + 200 + attempt);
    throttle.succeed("lan@example.com");
    for (let attempt = 0; attempt < 4; attempt += 1) throttle.fail("lan@example.com", now + 300 + attempt);
    expect(throttle.lockedFor("lan@example.com", now + 303)).toBeNull();
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

  it("关闭邮箱密码登录后，开放注册也拒绝且不建号", async () => {
    const world = makeWorld();
    world.settings.set({ registration: "open", passwordLogin: false });
    const body = { email: "new@example.com", password: PASSWORD, device: DEVICE_A };
    const response = await world.call("/v1/auth/register", { body });
    expect(response.status).toBe(403);
    expect(response.body?.code).toBe("password-login-disabled");
    expect(world.accounts.findByEmail("new@example.com")).toBeNull();
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

  it("关闭邮箱密码登录后，/join 仍能读邀请给 GitHub 用；密码接受 403 且不消耗邀请", async () => {
    const world = makeWorld();
    const admin = await world.accounts.setup({ email: "admin@example.com", password: PASSWORD });
    const { code } = world.accounts.createInvite({ createdBy: admin.id });
    world.settings.set({ passwordLogin: false });

    expect((await world.call(`/v1/auth/invites/${code}`)).status).toBe(200);
    const rejected = await world.call(`/v1/auth/invites/${code}`, { body: { email: "chen@example.com", password: PASSWORD } });
    expect(rejected.status).toBe(403);
    expect(rejected.body?.code).toBe("password-login-disabled");
    expect(world.accounts.findByEmail("chen@example.com")).toBeNull();

    world.settings.set({ passwordLogin: true });
    expect((await world.call(`/v1/auth/invites/${code}`, { body: { email: "chen@example.com", password: PASSWORD } })).status).toBe(201);
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

  it("关闭邮箱密码登录后，读取和提交重置都 403；链接不消耗，重开后仍可用", async () => {
    const world = makeWorld();
    const member = await world.accounts.create({ email: "mia@example.com", password: "old-password-1" });
    const { code } = world.accounts.createPasswordReset({ accountId: member.id, createdBy: null });
    const oldSession = world.accounts.createSession({ accountId: member.id, kind: "device", deviceId: DEVICE_B.deviceId }).token;
    world.settings.set({ passwordLogin: false });

    for (const response of [
      await world.call(`/v1/auth/password-resets/${code}`),
      await world.call(`/v1/auth/password-resets/${code}`, { body: { password: "brand-new-password" } }),
    ]) {
      expect(response.status).toBe(403);
      expect(response.body?.code).toBe("password-login-disabled");
    }
    expect((await world.call("/v1/me", { token: oldSession })).status).toBe(200);

    world.settings.set({ passwordLogin: true });
    expect((await world.call(`/v1/auth/password-resets/${code}`, { body: { password: "brand-new-password" } })).status).toBe(204);
    expect((await world.call("/v1/me", { token: oldSession })).status).toBe(401);
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
