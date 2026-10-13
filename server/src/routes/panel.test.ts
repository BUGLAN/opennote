/**
 * 控制台的用例（`docs/执行-三端同步…` §4.6、§7.3 Node 第 2/3 条、§10.1 M8/M9/M10）。
 *
 * ## 这里钉的是三道**互相独立**的闸门
 *
 * §10.1 M8 的验收原文是「页面不渲染 + API 403」—— 那是**两条**要求。再加上 CSRF，
 * 一共三道闸门，任何一道单独失效都不该导致越权：
 *
 * | 闸门 | 拦的是什么 | 失效后果 |
 * | --- | --- | --- |
 * | 服务端 API `requireAdmin()` | 任何非管理员的 `/panel/api/admin/*` | 越权读账号列表 |
 * | 页面**不生成**管理员 DOM | 普通账号在界面上看到管理员区块 | 至少是信息泄露，且诱导点击 |
 * | `X-Requested-With` + 无 CORS | 跨源页面拿 cookie 发变更请求 | CSRF：诱导管理员改状态 |
 *
 * 所以用例分三组，且**各自独立断言** —— 「API 拦住了」不能当作「页面也没渲染」的证据。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeCouch, couchClient } from "../couch/fakeCouch.test-helper";
import { AccountStore, newAccountId, newAuthTokenForTests } from "../auth/accounts";
import { NotebookStore } from "../notebooks";
import { createPanelApi } from "./panel";
import { CSRF_VALUE, PANEL_COOKIE, buildClearCookie, buildSessionCookie, csrfGuard, readCookie } from "../panelSecurity";
import { loadConfig, type ServerConfig } from "../config";
import { loadPanelAsset, panelAssetNames } from "../panelAssets";

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

function makeWorld(env: Record<string, string> = ENV): World {
  const db = openDatabase({ path: ":memory:" });
  const fake = new FakeCouch();
  const accounts = new AccountStore(db);
  const notebooks = new NotebookStore(db);
  const config = loadConfig(env);
  const couch = couchClient(fake);
  const app = new Hono();
  /*
   * ★ **闸门要在测试应用里也挂上**，否则测到的是「没有闸门的控制台」。
   *
   * 第一版就是这么漏的：`csrfGuard()` 实际挂在 `app.ts` 上，而这里的测试应用
   * 是手工拼的 ⇒ 「缺 X-Requested-With 应当 400」那条用例拿到了 201，
   * 看起来像 CSRF 没生效，其实是**测试应用比真实应用少了一层**。
   * 真实的接线另有一条用例（`createApp` 那一条）钉住。
   */
  app.use("/panel/api/*", csrfGuard());
  app.route(
    "/panel/api",
    createPanelApi({ accounts, notebooks, config, couch, couchAdmin: couch, audit: (event) => notebooks.audit(event) }),
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
  return { app, accounts, notebooks, config, admin: () => create(true), member: () => create(false) };
}

const call = (world: World, path: string, init: RequestInit = {}): Promise<Response> =>
  Promise.resolve(world.app.request(`http://localhost/panel/api${path}`, init));

/** 用 cookie 发请求（模拟浏览器）。变更类请求补上 CSRF 头。 */
function withCookie(token: string, method = "GET", extra: Record<string, string> = {}): RequestInit {
  return {
    method,
    headers: {
      cookie: `${PANEL_COOKIE}=${encodeURIComponent(token)}`,
      ...(method === "GET" || method === "HEAD" ? {} : { "x-requested-with": CSRF_VALUE, "content-type": "application/json" }),
      ...extra,
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("§4.6 · 登录：把客户端派生的令牌换成 HttpOnly cookie", () => {
  it("POST /session 成功时**回一个 cookie**，且响应体里**没有**令牌", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const response = await call(world, "/session", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": CSRF_VALUE },
      body: JSON.stringify({ authToken: admin.token }),
    });
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${PANEL_COOKIE}=`);
    // ★ HttpOnly + SameSite：XSS 偷不到，跨站请求不带。
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    // https 公开地址 ⇒ Secure 必须在。
    expect(setCookie).toContain("Secure");
    // ★ 响应体里**不能**回显令牌（它已经进 cookie 了，不该再出现在能被 JS 读到的地方）。
    const text = await response.text();
    expect(text).not.toContain(admin.token);
  });

  it("令牌太短 → 400（形状不对的请求不该进认证链路）", async () => {
    const world = makeWorld();
    const response = await call(world, "/session", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": CSRF_VALUE },
      body: JSON.stringify({ authToken: "short" }),
    });
    expect(response.status).toBe(400);
  });

  it("坏令牌 → 401 且**顺带清掉 cookie**（否则浏览器会一直带着坏 cookie 重试）", async () => {
    const world = makeWorld();
    const response = await call(world, "/session", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": CSRF_VALUE },
      body: JSON.stringify({ authToken: "x".repeat(64) }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  });

  it("★ 本地 http 开发时**不发 `Secure`**（否则 cookie 存不下来，表现为「登录后立刻又是未登录」）", async () => {
    const world = makeWorld({ ...ENV, EXTERNAL_BASE_URL: "http://localhost:8787" });
    const admin = world.admin();
    const response = await call(world, "/session", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": CSRF_VALUE },
      body: JSON.stringify({ authToken: admin.token }),
    });
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).not.toContain("Secure");

    /*
     * ★ 关键：**不能**因为「有反代」就当成 https —— 判断只看 `EXTERNAL_BASE_URL`，
     * 不看 `X-Forwarded-Proto`（那是可伪造的头，§4.11 U19 的同一教训）。
     */
    const spoofed = await call(world, "/session", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": CSRF_VALUE, "x-forwarded-proto": "https" },
      body: JSON.stringify({ authToken: admin.token }),
    });
    expect(spoofed.headers.get("set-cookie") ?? "").not.toContain("Secure");
  });

  it("DELETE /session 清 cookie", async () => {
    const world = makeWorld();
    const response = await call(world, "/session", { method: "DELETE" });
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  });
});

describe("§10.1 M8 · 管理员区块：**API 403** + **页面不渲染**（两条独立要求）", () => {
  it("普通账号访问每一个管理端点 → 403", async () => {
    const world = makeWorld();
    const member = world.member();
    const endpoints: [string, string][] = [
      ["GET", "/admin/accounts"],
      ["POST", "/admin/invites"],
      ["POST", "/admin/accounts/x/status"],
      ["GET", "/admin/server"],
      ["GET", "/admin/audit"],
    ];
    for (const [method, path] of endpoints) {
      const response = await call(world, path, withCookie(member.token, method, method === "POST" ? {} : {}));
      expect(response.status, `${method} ${path} 应当 403`).toBe(403);
    }
  });

  it("*未登录*访问管理端点 → 401（与 403 分开：一个是你没登录，一个是登录了没权限）", async () => {
    const world = makeWorld();
    expect((await call(world, "/admin/accounts")).status).toBe(401);
  });

  it("★ **页面不渲染**：`index.html` 里根本不出现管理员区块的标记", async () => {
    /*
     * 这条与上一条是**两件事**。§10.1 M8 的原文是「页面不渲染 + API 403」。
     *
     * 一个常见的偷懒实现是「渲染出来再用 CSS/hidden 藏住」—— 那样在开发者工具里
     * 一改就出来，而且请求也早就发出去了。所以这里断言的是**服务端发出去的 HTML
     * 里没有管理员区块**，而不是「不可见」。
     */
    const html = loadPanelAsset("index.html")!.body;
    // 管理员区块的 section 在 HTML 里**不该存在**（它们由 app.js 在确认 isAdmin 后创建）。
    expect(html).not.toMatch(/data-panel="admin-/);
    // 也不能出现那些区块的标题文字（区块名出现在普通账号的源码里同样含糊）。
    expect(html).not.toContain("账号管理");
    expect(html).not.toContain("服务器信息");
    // 反向确认：用户区块**在**（否则上面那些断言可以靠删空文件通过）。
    expect(html).toContain('data-panel="notebooks"');
    expect(html).toContain('data-panel="devices"');
  });

  it("★ 管理员区块确实由 `app.js` **创建**（`isAdmin` 是唯一开关）", () => {
    const js = loadPanelAsset("app.js")!.body;
    // 创建动作在 createAdminPanels 里，且它只在 `session.isAdmin` 为真时被调用。
    expect(js).toContain("createAdminPanels");
    expect(js).toMatch(/if \(session\.isAdmin && !adminPanels\)/);
    expect(js).toContain('data-panel": "admin-accounts"');
    // 也**不能**有「先渲染后隐藏」的写法。
    expect(js).not.toMatch(/adminPanels\.\w+\.hidden = false[^]*isAdmin/);
  });

  it("管理员自己访问 → 200（否则上面那些 403 可能只是因为端点根本没挂上）", async () => {
    const world = makeWorld();
    const admin = world.admin();
    expect((await call(world, "/admin/accounts", withCookie(admin.token))).status).toBe(200);
    expect((await call(world, "/admin/server", withCookie(admin.token))).status).toBe(200);
    expect((await call(world, "/admin/audit", withCookie(admin.token))).status).toBe(200);
  });

  it("管理端点的响应里**不含**任何密钥材料", async () => {
    const world = makeWorld();
    const admin = world.admin();
    world.member();
    const text = await (await call(world, "/admin/accounts", withCookie(admin.token))).text();
    for (const forbidden of ["auth_hash", "authHash", "wrapped_enc_root", "wrappedEncRoot", "accountKey"]) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe("§4.6 · CSRF：靠自定义头，不靠 token", () => {
  it("带 cookie 的**变更类**请求缺 `X-Requested-With` → 400", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const response = await call(world, "/admin/invites", {
      method: "POST",
      headers: { cookie: `${PANEL_COOKIE}=${admin.token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("X-Requested-With");
  });

  it("读请求不需要那个头（GET 不带也照常）", async () => {
    const world = makeWorld();
    const admin = world.admin();
    expect((await call(world, "/admin/accounts", { headers: { cookie: `${PANEL_COOKIE}=${admin.token}` } })).status).toBe(200);
  });

  it("★ **纯 Bearer 客户端不受 CSRF 闸门影响**（跨源页面拿不到 Bearer，本来就不受 CSRF 威胁）", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const response = await call(world, "/admin/invites", {
      method: "POST",
      headers: { authorization: `Bearer ${admin.token}`, "content-type": "application/json" },
      body: "{}",
    });
    // 闸门只保护 cookie 会话。
    expect(response.status).toBe(201);
  });

  it("带上正确的头就放行", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const response = await call(world, "/admin/invites", withCookie(admin.token, "POST", { "content-type": "application/json" }));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { code: string };
    expect(body.code).toMatch(/^inv_[0-9a-f]{48}$/);
  });
});

describe("§4.6 · 界面必须说清的三条能力边界", () => {
  it("`/account` 把三条说明**随数据下发**（于是「界面说了什么」也能被断言）", async () => {
    const world = makeWorld();
    const member = world.member();
    const account = (await (await call(world, "/account", withCookie(member.token))).json()) as { capabilityNotes: string[] };
    expect(account.capabilityNotes).toHaveLength(3);
    const joined = account.capabilityNotes.join("\n");
    // ① 服务端补发不了密钥。
    expect(joined).toContain("服务端无法补发你的密钥");
    // ② 踢设备只能靠轮换。
    expect(joined).toContain("只能轮换密钥");
    // ③ 管理员也重置不了任何人的密钥。
    expect(joined).toContain("管理员也无法重置任何人的密钥");
  });

  it("设备列表是**只读**的：响应里明说 `canRevoke: false`，且**没有**删除端点", async () => {
    const world = makeWorld();
    const member = world.member();
    const devices = (await (await call(world, "/devices", withCookie(member.token))).json()) as { canRevoke: boolean; note: string };
    expect(devices.canRevoke).toBe(false);
    expect(devices.note).toContain("只读账本");
    // 任何形状的「删设备」都不存在。
    expect((await call(world, "/devices/abc", withCookie(member.token, "DELETE"))).status).toBe(404);
  });

  it("冲突页**只展示**、明确不提供自动解决（红线 2）", async () => {
    const world = makeWorld();
    const member = world.member();
    const stats = (await (await call(world, "/stats", withCookie(member.token))).json()) as { canAutoResolve: boolean; note: string };
    expect(stats.canAutoResolve).toBe(false);
    expect(stats.note).toContain("看不到冲突内容");
  });
});

describe("§7.3 Node 第 2 条 · 安全响应头", () => {
  it("`nosniff` / `DENY` / `Referrer-Policy` 都在；https 时带 HSTS", async () => {
    const { securityHeaders } = await import("../panelSecurity");
    const headers = securityHeaders({ https: true, csp: "default-src 'self'" });
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("same-origin");
    expect(headers["strict-transport-security"]).toContain("max-age=");
  });

  it("http 本地开发**不发 HSTS**（否则浏览器会把 localhost 也升级成 https，本地就用不了）", async () => {
    const { securityHeaders } = await import("../panelSecurity");
    expect(securityHeaders({ https: false, csp: null })["strict-transport-security"]).toBeUndefined();
  });

  it("控制台的 CSP **没有** `unsafe-inline`（有它等于把 CSP 关掉）", async () => {
    const { PANEL_CSP } = await import("../panelSecurity");
    expect(PANEL_CSP).not.toContain("unsafe-inline");
    expect(PANEL_CSP).not.toContain("unsafe-eval");
    expect(PANEL_CSP).toContain("default-src 'self'");
    expect(PANEL_CSP).toContain("frame-ancestors 'none'");
    // 同源部署 ⇒ 不需要放开任何外部源（§2.4）。
    expect(PANEL_CSP).not.toMatch(/https?:\/\//);
  });
});

describe("cookie 工具函数", () => {
  it("`readCookie` 能处理多 cookie、空格、坏编码", () => {
    expect(readCookie("a=1; opennote_panel=xyz; b=2", PANEL_COOKIE)).toBe("xyz");
    expect(readCookie(`  ${PANEL_COOKIE} = spaced  `, PANEL_COOKIE)).toBe("spaced");
    expect(readCookie("other=1", PANEL_COOKIE)).toBeNull();
    expect(readCookie(undefined, PANEL_COOKIE)).toBeNull();
    // 坏百分号编码：当成没有，而不是抛（否则一个畸形 cookie 能让请求 500）。
    expect(readCookie(`${PANEL_COOKIE}=%E0%A4%A`, PANEL_COOKIE)).toBeNull();
  });

  it("`buildSessionCookie` 的值会 URL 编码（令牌可能含 `=`/`+`）", () => {
    const cookie = buildSessionCookie("ab+cd=ef", { https: true });
    expect(cookie).toContain(`${PANEL_COOKIE}=ab%2Bcd%3Def`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Path=/");
  });

  it("`buildClearCookie` 立刻失效", () => {
    expect(buildClearCookie({ https: true })).toContain("Max-Age=0");
  });
});

describe("静态资源是白名单（不是通用静态服务器）", () => {
  it("只登记三个资源", () => {
    expect(panelAssetNames().sort()).toEqual(["app.js", "index.html", "styles.css"]);
  });

  it("★ 名字不在白名单里 → `null`（**不拼路径**，于是没有目录穿越）", () => {
    for (const bad of ["../package.json", "..%2F..%2Fetc%2Fpasswd", "app.js.map", "", "index.html/../../x"]) {
      expect(loadPanelAsset(bad), `${bad} 不该被读到`).toBeNull();
    }
  });

  it("资源真的能从磁盘读到（构建时没拷到 dist/panel/ 的话这里会红）", () => {
    for (const name of panelAssetNames()) {
      const asset = loadPanelAsset(name);
      expect(asset, `${name} 应当可读`).toBeTruthy();
      expect(asset!.body.length).toBeGreaterThan(100);
      expect(asset!.contentType).toBeTruthy();
    }
  });

  it("页面里的引用**全是同源绝对路径**（CSP 的 `'self'` 才够用）", () => {
    const html = loadPanelAsset("index.html")!.body;
    for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      /*
       * 只要求「以 `/` 开头」= 同源，**不要求**都在 `/panel/` 下：
       * 页面里有一个指向 `/v1/health` 的构建哈希核对链接，那正是 §5.6⑤ 想要的。
       * 第一版把它写死成 `^/panel/`，于是这条用例红得毫无道理。
       */
      expect(match[1], `${match[1]} 应当是同源绝对路径`).toMatch(/^\//);
      expect(match[1], `${match[1]} 不该指向外部站点`).not.toMatch(/^\/\//);
    }
    expect(html).toContain("/panel/app.js");
    expect(html).toContain("/panel/styles.css");
    // 构建哈希核对入口确实在（§5.6⑤：那条信任链上唯一用户能自己验证的一环）。
    expect(html).toContain("/v1/health");
  });

  it("前端**没有**把密钥 POST 出去（只提交派生出来的 authToken）", () => {
    const js = loadPanelAsset("app.js")!.body;
    // 登录只提交 authToken。
    expect(js).toContain('request("/session", { method: "POST", body: { authToken } })');
    // 反向确认：没有任何地方把 accountKey / key 放进请求体。
    expect(js).not.toMatch(/body:\s*\{[^}]*\bkey\b/);
    expect(js).not.toMatch(/body:\s*\{[^}]*accountKey/);
  });

  it("派生令牌用的 HKDF info 与服务端/客户端一致（不一致的症状是 401，看起来像密钥错）", () => {
    const js = loadPanelAsset("app.js")!.body;
    expect(js).toContain('"opennote-auth-v1"');
    expect(js).toContain("HKDF");
    expect(js).toContain("SHA-256");
  });
});

describe("★ 真实装配（`createApp`）里这些闸门**真的挂上了**", () => {
  /*
   * 上面那些用例用的是**手工拼的**测试应用。手工拼的风险是「测试应用比真实应用多一层
   * 或少一层」—— 我在这一轮就踩过一次：CSRF 闸门在 `app.ts` 上，而测试应用没挂它，
   * 于是「缺 X-Requested-With 应当 400」拿到了 201。
   *
   * 所以这一组**只用真实入口**，不碰手工拼装。
   */
  async function realApp(env: Record<string, string> = ENV) {
    const { createApp } = await import("../app");
    const { loadConfig } = await import("../config");
    const fake = new FakeCouch();
    return createApp({
      config: loadConfig(env),
      db: openDatabase({ path: ":memory:" }),
      couch: couchClient(fake),
      couchAdmin: couchClient(fake),
    });
  }

  it("安全响应头出现在真实响应上（含控制台页面的 CSP）", async () => {
    const { app } = await realApp();
    const page = await app.request("http://localhost/panel");
    expect(page.status).toBe(200);
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    // 不缓存：控制台是运维界面，「改了没生效」会浪费很多时间。
    expect(page.headers.get("cache-control")).toBe("no-store");

    // `/v1/*` 的 JSON 响应**不发**控制台的 CSP（那会让「CSP 保护了什么」变含糊）。
    const health = await app.request("http://localhost/v1/health");
    expect(health.headers.get("content-security-policy")).toBeNull();
    // 但基础安全头仍然发。
    expect(health.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("★ CSRF 闸门在真实装配上生效（缺头的 cookie 变更请求 → 400）", async () => {
    const { app, accounts } = await realApp();
    const token = newAuthTokenForTests();
    accounts.create({
      accountId: newAccountId(),
      authToken: token,
      wrappedEncRoot: "wrapped-fake-0001",
      isAdmin: true,
      bootstrapCode: accounts.createBootstrapCode().code,
    });
    const response = await app.request("http://localhost/panel/api/admin/invites", {
      method: "POST",
      headers: { cookie: `${PANEL_COOKIE}=${token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(400);

    // 带上正确的头就过（否则上面那条可能只是因为端点没挂上）。
    const ok = await app.request("http://localhost/panel/api/admin/invites", {
      method: "POST",
      headers: { cookie: `${PANEL_COOKIE}=${token}`, "content-type": "application/json", "x-requested-with": CSRF_VALUE },
      body: "{}",
    });
    expect(ok.status).toBe(201);
  });

  it("控制台三个资源都能取到，且 `content-type` 正确", async () => {
    const { app } = await realApp();
    const expected: Record<string, string> = {
      "/panel": "text/html",
      "/panel/": "text/html",
      "/panel/app.js": "text/javascript",
      "/panel/styles.css": "text/css",
    };
    for (const [path, type] of Object.entries(expected)) {
      const response = await app.request(`http://localhost${path}`);
      expect(response.status, `${path}`).toBe(200);
      expect(response.headers.get("content-type"), `${path}`).toContain(type);
    }
  });

  it("★ 静态资源**不是**通用静态服务器：路径穿越一律 404", async () => {
    const { app } = await realApp();
    for (const path of ["/panel/../package.json", "/panel/%2e%2e/package.json", "/panel/does-not-exist.js", "/panel/server/src/app.ts"]) {
      const response = await app.request(`http://localhost${path}`);
      expect(response.status, `${path} 不该被读到`).toBe(404);
    }
  });

  it("`/panel/api/me` 未登录 → 401（页面靠这个决定显示导入界面还是主界面）", async () => {
    const { app } = await realApp();
    expect((await app.request("http://localhost/panel/api/me")).status).toBe(401);
  });
});

describe("控制台源码不该混进静态资源目录", () => {
  it("`server/src/panel/` 下只有静态资源（构建脚本按扩展名白名单拷贝，但约定也要钉住）", () => {
    const dir = join(process.cwd(), "server", "src", "panel");
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const names = readdirSync(dir);
    for (const name of names) {
      expect(name, `${name} 不该出现在 panel/（那是静态资源目录，§5.x 目录表）`).toMatch(/\.(html|css|js)$/);
    }
    // 反向确认目录非空。
    expect(names.length).toBeGreaterThanOrEqual(3);
    void readFileSync;
  });
});
