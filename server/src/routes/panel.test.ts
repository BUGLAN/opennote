/**
 * 网页控制台的会话与页面（`routes/panel.ts`、`adminGate.ts`、`/v1/admin/*` 的 CSRF 闸门）。
 *
 * 钉住几件出了错不会自己暴露的事：
 * - cookie 是 HttpOnly、跟着公开地址决定 Secure，令牌从不出现在响应体里；
 * - 普通账号在控制台输对密码也拿不到 cookie；
 * - cookie 请求的变更必须带 `X-Requested-With`，Bearer 请求不受影响；
 * - cookie 只认控制台会话，设备令牌塞进 cookie 不算登录；
 * - 控制台与客户端登录共用失败计数。
 */

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { openDatabase } from "../db";
import { loadConfig } from "../config";
import { NotebookStore } from "../notebooks";
import { SettingsStore } from "../settings";
import { seedAccount, testAccountStore } from "../auth/testAccounts.test-helper";
import { FakeCouch, couchClient } from "../couch/fakeCouch.test-helper";
import { csrfGuard, PANEL_COOKIE } from "../panelSecurity";
import { panelAssetNames, loadPanelAsset } from "../panelAssets";
import { createAuthRoutes, LoginThrottle } from "./auth";
import { createAdminRoutes } from "./admin";
import { createAdminViewRoutes } from "./adminView";
import { createPanelRoutes } from "./panel";

const ENV: Record<string, string> = {
  EXTERNAL_BASE_URL: "https://notes.example.com",
  COUCH_URL: "http://couchdb:5984",
  COUCH_USER: "sync-service",
  COUCH_PASSWORD: "pw",
  COUCH_ADMIN_USER: "admin",
  COUCH_ADMIN_PASSWORD: "apw",
};
const PASSWORD = "long-enough-pw";
const CSRF = { "x-requested-with": "opennote-panel" };

function makeWorld(env: Record<string, string> = ENV, options: { now?: () => number } = {}) {
  const db = openDatabase({ path: ":memory:" });
  const config = loadConfig(env);
  const accounts = testAccountStore(db);
  const notebooks = new NotebookStore(db);
  const settings = new SettingsStore(db, config);
  const couch = couchClient(new FakeCouch());
  const audit = (event: Parameters<NotebookStore["audit"]>[0]) => notebooks.audit(event);
  const throttle = new LoginThrottle();
  const now = options.now ? { now: options.now } : {};
  const app = new Hono();
  app.route("/v1", createAuthRoutes({ accounts, notebooks, config, settings, audit, throttle, ...now }));
  app.use("/v1/admin/*", csrfGuard());
  app.route("/v1/admin", createAdminViewRoutes({ accounts, notebooks, config, couch, settings, ...now }));
  app.route("/v1/admin", createAdminRoutes({ accounts, notebooks, config, couch, settings, audit, ...now }));
  app.route("/", createPanelRoutes({ accounts, notebooks, config, settings, throttle, audit, ...now }));

  const call = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const response = await app.request(`http://localhost${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json", ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    let body: Record<string, any> | null = null;
    try {
      body = text ? (JSON.parse(text) as Record<string, any>) : null;
    } catch {
      body = null;
    }
    return { status: response.status, headers: response.headers, text, body };
  };
  /** 登录控制台，返回 `Cookie` 头的值。 */
  const panelLogin = async (email: string, password = PASSWORD): Promise<string> => {
    const response = await call("/v1/panel/login", { body: { email, password }, headers: CSRF });
    expect(response.status).toBe(200);
    return response.headers.get("set-cookie")!.split(";")[0]!;
  };
  return { db, accounts, notebooks, settings, call, panelLogin };
}

describe("页面与静态资源", () => {
  it("/admin、/admin/*、/join/:code、/reset/:code 发同一份外壳，带控制台 CSP", async () => {
    const world = makeWorld();
    for (const path of ["/admin", "/admin/users/abc", "/join/join_x", "/reset/reset_x"]) {
      const page = await world.call(path);
      expect(page.status, path).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(page.text).toContain('<div id="root">');
    }
  });

  it("资源只发白名单里的；白名单里的每个文件都真的在", async () => {
    const world = makeWorld();
    for (const name of panelAssetNames()) expect(loadPanelAsset(name), name).not.toBeNull();
    const script = await world.call("/panel/console.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("javascript");
    expect((await world.call("/panel/../panelSecurity.ts")).status).toBe(404);
    expect((await world.call("/panel/views.js")).status).toBe(404);
  });

  it("页面里没有内联脚本和 style 属性（CSP 会拦掉它们）", () => {
    for (const name of panelAssetNames().filter((item) => /\.(html|js)$/.test(item))) {
      const body = String(loadPanelAsset(name)!.body);
      expect(body, name).not.toMatch(/<script>(?!<\/script>)/);
      expect(body, name).not.toMatch(/\sstyle="/);
    }
  });
});

describe("初始化", () => {
  it("零账号：session 说要初始化；setup 建管理员、记下注册方式、直接发 cookie", async () => {
    const world = makeWorld();
    const before = await world.call("/v1/panel/session");
    expect(before.body).toMatchObject({ setupRequired: true, me: null, externalBaseUrl: "https://notes.example.com" });

    expect((await world.call("/v1/panel/setup", { body: { email: "admin@example.com", password: PASSWORD } })).status).toBe(400);

    const setup = await world.call("/v1/panel/setup", { body: { email: "admin@example.com", password: PASSWORD, registration: "closed" }, headers: CSRF });
    expect(setup.status).toBe(201);
    const cookie = setup.headers.get("set-cookie")!;
    expect(cookie).toMatch(new RegExp(`^${PANEL_COOKIE}=ons_`));
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Max-Age=28800");
    // 令牌只在 cookie 里，不在响应体里。
    expect(setup.text).not.toContain("ons_");
    expect(world.settings.get("registration")).toBe("closed");

    const after = await world.call("/v1/panel/session", { headers: { cookie: cookie.split(";")[0]! } });
    expect(after.body).toMatchObject({ setupRequired: false, me: { email: "admin@example.com", isAdmin: true } });

    const again = await world.call("/v1/panel/setup", { body: { email: "x@example.com", password: PASSWORD }, headers: CSRF });
    expect(again.status).toBe(409);
  });

  it("本地 http 部署不加 Secure（否则 cookie 存不下来）", async () => {
    const world = makeWorld({ ...ENV, EXTERNAL_BASE_URL: "http://localhost:8787" });
    const setup = await world.call("/v1/panel/setup", { body: { email: "admin@example.com", password: PASSWORD }, headers: CSRF });
    expect(setup.headers.get("set-cookie")).not.toContain("Secure");
  });
});

describe("登录与退出", () => {
  it("普通账号输对密码也拿不到 cookie", async () => {
    const world = makeWorld();
    await world.accounts.create({ email: "lan@example.com", password: PASSWORD });
    const response = await world.call("/v1/panel/login", { body: { email: "lan@example.com", password: PASSWORD }, headers: CSRF });
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("登录要 CSRF 头", async () => {
    const world = makeWorld();
    await world.accounts.create({ email: "admin@example.com", password: PASSWORD, isAdmin: true });
    expect((await world.call("/v1/panel/login", { body: { email: "admin@example.com", password: PASSWORD } })).status).toBe(400);
  });

  it("退出吊销会话并清 cookie；之后同一个 cookie 不能再用", async () => {
    const world = makeWorld();
    await world.accounts.create({ email: "admin@example.com", password: PASSWORD, isAdmin: true });
    const cookie = await world.panelLogin("admin@example.com");
    expect((await world.call("/v1/admin/accounts", { headers: { cookie } })).status).toBe(200);

    const logout = await world.call("/v1/panel/logout", { body: {}, headers: { ...CSRF, cookie } });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await world.call("/v1/admin/accounts", { headers: { cookie } })).status).toBe(401);
    expect((await world.call("/v1/panel/session", { headers: { cookie } })).body?.me).toBeNull();
  });

  it("控制台与客户端共用失败计数：控制台错 5 次，客户端登录也被锁", async () => {
    const world = makeWorld();
    await world.accounts.create({ email: "admin@example.com", password: PASSWORD, isAdmin: true });
    for (let i = 0; i < 5; i += 1) {
      expect((await world.call("/v1/panel/login", { body: { email: "admin@example.com", password: "wrong-password!" }, headers: CSRF })).status).toBe(401);
    }
    expect((await world.call("/v1/panel/login", { body: { email: "admin@example.com", password: PASSWORD }, headers: CSRF })).status).toBe(429);
    const device = { deviceId: "a".repeat(32), name: "Mac", platform: "desktop" };
    expect((await world.call("/v1/auth/login", { body: { email: "admin@example.com", password: PASSWORD, device } })).status).toBe(429);
  });

  it("控制台会话 8 小时后过期：session 回 me=null 并清 cookie", async () => {
    let clock = Date.now();
    const world = makeWorld(ENV, { now: () => clock });
    await world.accounts.create({ email: "admin@example.com", password: PASSWORD, isAdmin: true });
    const cookie = await world.panelLogin("admin@example.com");
    clock += 8 * 3600_000 + 1000;
    const session = await world.call("/v1/panel/session", { headers: { cookie } });
    expect(session.body?.me).toBeNull();
    expect(session.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await world.call("/v1/admin/overview", { headers: { cookie } })).status).toBe(401);
  });
});

describe("cookie 调管理接口", () => {
  it("变更请求没带 CSRF 头 → 400；带了 → 通过", async () => {
    const world = makeWorld();
    await world.accounts.create({ email: "admin@example.com", password: PASSWORD, isAdmin: true });
    const cookie = await world.panelLogin("admin@example.com");
    expect((await world.call("/v1/admin/settings", { method: "PATCH", body: { registration: "open" }, headers: { cookie } })).status).toBe(400);
    expect(world.settings.get("registration")).toBe("invite");
    expect((await world.call("/v1/admin/settings", { method: "PATCH", body: { registration: "open" }, headers: { cookie, ...CSRF } })).status).toBe(200);
    expect(world.settings.get("registration")).toBe("open");
  });

  it("Bearer 请求不需要 CSRF 头", async () => {
    const world = makeWorld();
    const admin = seedAccount(world.accounts, { isAdmin: true });
    expect((await world.call("/v1/admin/settings", { method: "PATCH", body: { registration: "open" }, headers: { authorization: `Bearer ${admin.token}` } })).status).toBe(200);
  });

  it("设备令牌塞进 cookie 不算登录", async () => {
    const world = makeWorld();
    const admin = seedAccount(world.accounts, { isAdmin: true });
    const response = await world.call("/v1/admin/accounts", { headers: { cookie: `${PANEL_COOKIE}=${admin.token}` } });
    expect(response.status).toBe(401);
  });

  it("管理员被取消身份后，cookie 立刻失去管理权限", async () => {
    const world = makeWorld();
    seedAccount(world.accounts, { isAdmin: true });
    const second = await world.accounts.create({ email: "b@example.com", password: PASSWORD, isAdmin: true });
    const cookie = await world.panelLogin("b@example.com");
    world.accounts.setAdmin(second.id, false);
    expect((await world.call("/v1/admin/accounts", { headers: { cookie } })).status).toBe(403);
    expect((await world.call("/v1/panel/session", { headers: { cookie } })).body?.me).toBeNull();
  });
});
