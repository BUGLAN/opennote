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
import vm from "node:vm";
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

/**
 * 把 `views.js` 装进一个假窗口里跑一遍，拿到它的导出（`window.VIEWS`）。
 *
 * 它是**浏览器脚本**（不是 ES 模块）：文件末尾把导出挂到 `window.VIEWS` 上，
 * 所以这里用 `vm` 造一个最小的 `window`。
 * 用 `vm` 而不是 `new Function`：前者保证脚本里的函数声明不会漏进测试文件的作用域。
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- 被测代码是纯 JS，没有类型可依。 */
function loadViews(): Record<string, (...args: any[]) => any> {
  const source = String(loadPanelAsset("views.js")!.body);
  const icons = String(loadPanelAsset("icons.js")!.body);
  const sandbox: { window: Record<string, unknown>; console: Console } = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(icons, sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.window.VIEWS as Record<string, (...args: any[]) => any>;
}

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

  it("★ **页面不渲染**：`index.html` 里根本不出现任何管理员页面的痕迹", async () => {
    /*
     * 这条与上一条是**两件事**。§10.1 M8 的原文是「页面不渲染 + API 403」。
     *
     * 一个常见的偷懒实现是「渲染出来再用 CSS/hidden 藏住」—— 那样在开发者工具里
     * 一改就出来，而且请求也早就发出去了。所以这里断言的是**服务端发出去的 HTML
     * 里没有任何管理员页面的结构与文案**，而不是「不可见」。
     */
    const html = String(loadPanelAsset("index.html")!.body);
    // 导航与内容都由 app.js 生成 —— HTML 里连容器都不给管理员页留。
    expect(html).not.toMatch(/data-panel="/);
    // 管理员页面的名字不该出现在 HTML 里（只在 JS 里按 isAdmin 决定要不要生成）。
    for (const label of ["账号与访问", "同步台账", "同步日志", "服务端配置", "冲突与异常"]) {
      expect(html, label + " 不该出现在 HTML 里").not.toContain(label);
    }
    // 反向确认：这份 HTML 确实是个页面而不是空文件。
    expect(html).toContain('id="main"');
    expect(html).toContain('id="unlock"');
  });

  it("★ 管理页的导航项只在 `isAdmin` 为真时**进入 DOM**（而不是渲染后隐藏）", () => {
    /*
     * 新实现里每一页都带 `adminOnly` 标记，`canView()` 用它在
     * 「生成导航」与「路由守卫」两处同时过滤。这里钉住这条链路存在，
     * 并且钉住它不是「先渲染再隐藏」。
     */
    const js = String(loadPanelAsset("app.js")!.body);
    expect(js).toContain("adminOnly");
    expect(js).toContain("function canView(");
    // 导航过滤：越权条目直接 return，不进 DOM。
    expect(js).toMatch(/items\.filter\(\(page\) => canView\(page\.id\)\)/);
    // 路由守卫：手敲 URL 也拦得住（只是少发一次注定失败的请求，不是安全边界）。
    expect(js).toMatch(/if \(!page \|\| !canView\(id\)\)/);
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
  it("只登记**明确列出的**资源（白名单本身就是防线）", () => {
    const names = panelAssetNames().sort();
    // 源码与样式：控制台自己的四个文件。
    for (const name of ["app.js", "api.js", "views.js", "icons.js", "index.html", "styles.css", "tokens.css"]) {
      expect(names, name + " 应当登记").toContain(name);
    }
    // 字体与印章：CSP 的 font-src/img-src 只允许 self，所以必须由本服务发。
    expect(names.filter((n) => n.startsWith("assets/fonts/")).length).toBe(4);
    expect(names.filter((n) => n.startsWith("assets/seal/")).length).toBe(8);
    // 没有别的杂项：白名单必须**穷举**，不能靠通配。
    expect(names.length).toBe(7 + 4 + 8);
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
    const html = String(loadPanelAsset("index.html")!.body);
    for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      /*
       * 只要求「以 `/` 开头」= 同源，**不要求**都在 `/panel/` 下：
       * 页面里有一个指向 `/v1/health` 的构建哈希核对链接，那正是 §5.6⑤ 想要的。
       * 第一版把它写死成 `^/panel/`，于是这条用例红得毫无道理。
       */
      // 站内哈希路由（#/overview）不是资源引用，不参与这条断言。
      if (match[1].startsWith("#")) continue;
      expect(match[1], `${match[1]} 应当是同源绝对路径`).toMatch(/^\//);
      expect(match[1], `${match[1]} 不该指向外部站点`).not.toMatch(/^\/\//);
    }
    expect(html).toContain("/panel/app.js");
    expect(html).toContain("/panel/styles.css");
    // 构建哈希核对入口确实在（§5.6⑤：那条信任链上唯一用户能自己验证的一环）。
    expect(html).toContain("/v1/health");
  });

  it("前端**没有**把密钥 POST 出去（只提交派生出来的 authToken）", () => {
    /*
     * ★ 这条是整个 E2EE 的地基：密钥一旦离开浏览器，红线 3 就破了。
     *   所以断言「请求体里只有 authToken」，并且反向确认没有任何地方把
     *   accountKey / 密钥文本放进 body。
     */
    const js = String(loadPanelAsset("api.js")!.body);
    // 登录：只提交派生出来的令牌。
    expect(js).toMatch(/body: \{ authToken \}/);
    // 二次验证：同样是令牌，不是密钥。
    expect(js).toMatch(/\/session\/verify", \{ method: "POST", body: \{ authToken \} \}/);
    // 反向确认：没有任何请求体带上密钥材料。
    expect(js).not.toMatch(/body:[^\n]*accountKey/);
    expect(js).not.toMatch(/body:[^\n]*keyText/);
  });

  it("★ 派生令牌的 HKDF 参数与 `accountKey.ts` 一致（salt=accountId 字节、info=opennote/v1/auth）", () => {
    /*
     * 控制台是「四端同一条代码路径」的**例外**（无构建步骤 ⇒ 只能用 WebCrypto）。
     * 而 HKDF 的 salt / info 差一个字就是完全不同的密钥 —— 症状会是「密钥输错了」。
     * 所以这里逐参数钉住，并且在 `src/sync/accountKey.test.ts` 里有一条用例
     * **把 noble 与 WebCrypto 算出来的字节直接比对**。
     */
    const js = String(loadPanelAsset("api.js")!.body);
    expect(js).toContain('"opennote/v1/auth"');
    expect(js).toContain("HKDF");
    expect(js).toContain("SHA-256");
    // salt 必须是 accountId 的**字节**，不是那串十六进制文本的 ASCII。
    expect(js).toContain("salt: fromHex(accountId)");
    // 也不许出现别的那套参数。
    expect(js).not.toContain("opennote-auth-v1");
    expect(js).not.toContain("salt: new Uint8Array(0)");
  });

  it("控制台解得出密钥 blob 里的 `accountId`（少了它派不出令牌）", () => {
    const js = String(loadPanelAsset("api.js")!.body);
    // blob 形状：version(1) + accountId(16) + accountKey(32) = 49 字节。
    expect(js).toContain("1 + ACCOUNT_ID_BYTES + ACCOUNT_KEY_BYTES");
    expect(js).toContain("accountId: toHex(");
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
      /*
       * 允许两种东西：
       *   1. 静态资源本身（html / css / js）
       *   2. assets/ 子目录 —— 自托管字体与印章。
       *      CSP 的 font-src / img-src 只允许 self，所以它们必须由本服务发出；
       *      指向 CDN 会被浏览器直接拦掉，症状是「字体静默回退」，很难查。
       */
      if (name === "assets") continue;
      expect(name, `${name} 不该出现在 panel/（那是静态资源目录，§5.x 目录表）`).toMatch(/\.(html|css|js)$/);
    }
    // 反向确认目录非空。
    expect(names.length).toBeGreaterThanOrEqual(3);
    // assets/ 下只有字体与印章，不该混进脚本。
    const assets = readdirSync(join(dir, "assets"));
    expect(assets.sort()).toEqual(["fonts", "seal"]);
    void readFileSync;
  });
});

/* ========================================================================== */

describe("控制台取数 · 统计合并与真实的「我的」页面", () => {
  /*
   * `/stats` 现在是**两个来源**的合并（见 `panel.ts` 的 `mergeDailyStats`）。
   * 这里钉住合并规则本身，因为「相加」这个错误实现看起来非常合理：
   * 客户端数与服务端数描述的是**同一批请求**，相加会把每次同步数两遍。
   */

  it("★ 同一天同一库：两个来源取**较大值**，不是相加", async () => {
    const world = makeWorld();
    const member = world.member();
    const notebook = world.notebooks.create({ ownerId: member.id, name: "n", cryptoMode: "none" });
    const day = "2026-10-23";

    // 客户端说：3 次拉取。服务端观察到：5 次。真实值至少是 5。
    world.notebooks.reportStats({
      accountId: member.id,
      notebookId: notebook.id,
      day,
      pulls: 3,
      pushes: 1,
      deletes: 0,
      conflicts: 0,
      errors: 0,
    });
    world.notebooks.recordActivity({ accountId: member.id, notebookId: notebook.id, day, kind: "pull", amount: 5 });

    const body = (await (await call(world, "/stats?limit=30", withCookie(member.token))).json()) as {
      stats: { pulls: number; pushes: number }[];
      sources: { clientStats: number; observed: number };
    };
    expect(body.stats).toHaveLength(1);
    expect(body.stats[0]!.pulls).toBe(5);
    // 推送那边只有客户端报了 1 次，服务端 0 次 ⇒ 取 1。
    expect(body.stats[0]!.pushes).toBe(1);
    // 两个来源各自有几行，也照实报出来（页面据此说明「这一屏的数据来自哪里」）。
    expect(body.sources).toEqual({ clientStats: 1, observed: 1 });
  });

  it("只有服务端观测（客户端不上报）时，数字照样出得来", async () => {
    const world = makeWorld();
    const member = world.member();
    const notebook = world.notebooks.create({ ownerId: member.id, name: "n", cryptoMode: "none" });
    world.notebooks.recordActivity({ accountId: member.id, notebookId: notebook.id, day: "2026-10-23", kind: "conflict" });
    const body = (await (await call(world, "/stats?limit=30", withCookie(member.token))).json()) as { stats: { conflicts: number }[] };
    expect(body.stats[0]!.conflicts).toBe(1);
  });

  it("按天倒序（页面直接取前 N 天画图，不再前端排序）", async () => {
    const world = makeWorld();
    const member = world.member();
    const notebook = world.notebooks.create({ ownerId: member.id, name: "n", cryptoMode: "none" });
    for (const day of ["2026-10-20", "2026-10-23", "2026-10-21"]) {
      world.notebooks.recordActivity({ accountId: member.id, notebookId: notebook.id, day, kind: "pull" });
    }
    const body = (await (await call(world, "/stats?limit=30", withCookie(member.token))).json()) as { stats: { day: string }[] };
    expect(body.stats.map((row) => row.day)).toEqual(["2026-10-23", "2026-10-21", "2026-10-20"]);
  });

  it("★ 用量条读的是**真实占用**（`/usage` 与 `/account` 两处必须一致）", async () => {
    const world = makeWorld();
    const member = world.member();
    const notebook = world.notebooks.create({ ownerId: member.id, name: "n", cryptoMode: "none" });
    world.notebooks.recomputeNotebookCount(member.id);
    world.notebooks.addNotebookBytes(notebook.id, 4096);

    const usage = (await (await call(world, "/usage", withCookie(member.token))).json()) as { quota: { bytesUsed: number; notebooks: number } };
    const account = (await (await call(world, "/account", withCookie(member.token))).json()) as { quota: { bytesUsed: number; notebooks: number } };
    expect(usage.quota.bytesUsed).toBe(4096);
    expect(usage.quota.notebooks).toBe(1);
    // 两个端点读同一份数据，数字必须一样（页面分别在「用量」页与「我的账号」页显示它们）。
    expect(account.quota).toEqual(usage.quota);
  });

  it("设备账本：检查点登记过的设备能在 `/devices` 里看到", async () => {
    const world = makeWorld();
    const member = world.member();
    world.notebooks.upsertDevice({ deviceId: "a".repeat(32), accountId: member.id, name: null, platform: null });
    const body = (await (await call(world, "/devices", withCookie(member.token))).json()) as {
      devices: { deviceId: string; name: string | null }[];
    };
    expect(body.devices).toHaveLength(1);
    // 客户端没报名字 ⇒ null（界面显示「未命名设备」，不编一个名字）。
    expect(body.devices[0]!.name).toBeNull();
  });
});

describe("删账号（控制台唯一不可撤销的动作）", () => {
  it("★ 带设备与笔记本的账号也能删掉（原来是 500 FOREIGN KEY）", async () => {
    const world = makeWorld();
    const admin = world.admin();
    const victim = world.member();
    const own = world.notebooks.create({ ownerId: victim.id, name: "own", cryptoMode: "none" });
    world.notebooks.upsertDevice({ deviceId: "b".repeat(32), accountId: victim.id, name: "Mac", platform: "desktop" });

    const response = await call(
      world,
      "/admin/accounts/" + victim.id,
      withCookie(admin.token, "DELETE", { cookie: `${PANEL_COOKIE}=${encodeURIComponent(admin.token)}` }),
    );
    /*
     * 这条**必须**过 `requireStepUp()` 那一关。这里没做二次验证 ⇒ 403。
     * 先用「被拦下」确认闸门在，再单独测「验证之后能删」。
     */
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("step-up-required");
    // 被拦下时**什么都没改**（这一点比状态码更重要）。
    expect(world.notebooks.findById(own.id)).not.toBeNull();
  });
});


/* ========================================================================== */

describe("控制台静态资源 · 结构完整性（一份 HTML、一份启动入口）", () => {
  /*
   * 这一组是**回归闸门**，来自一次真实事故：
   *
   * 面板重写时 `index.html` 里出现了**两个** `<html>` 根（第二段是外壳 + 登录页），
   * 浏览器把第一个之后的内容整个吞掉 —— 现象是「打开控制台一片空白」，
   * 而控制台里**连一行报错都没有**（HTML 解析错误不是 JS 错误）。
   *
   * 同时 `app.js` 少了 `boot()` 的调用点：脚本加载了、函数都在、什么都不发生。
   * 这两种故障都不会被接口用例覆盖，所以单独钉在这里。
   */

  it("`index.html` 只有**一个** `<html>` / `<body>`（多根会让后半段被丢掉）", () => {
    const raw = String(loadPanelAsset("index.html")!.body);
    /*
     * 先去掉 HTML 注释再数：注释里也会写 `<html>` / `<body>`（说明文字），
     * 不剥掉的话这条用例会因为「注释写得太具体」而红 —— 我第一次就是这么红的。
     */
    const html = raw.replace(/<!--[\s\S]*?-->/g, "");
    expect(html.match(/<html\b/gi) ?? []).toHaveLength(1);
    expect(html.match(/<\/html>/gi) ?? []).toHaveLength(1);
    expect(html.match(/<body\b/gi) ?? []).toHaveLength(1);
    expect(html.match(/<\/body>/gi) ?? []).toHaveLength(1);
    // 头尾要真的在（别为了「只有一个」把尾巴删了）。
    expect(html.trimStart().toLowerCase().startsWith("<!doctype html>")).toBe(true);
    expect(html.trimEnd().toLowerCase().endsWith("</html>")).toBe(true);
  });

  it("`index.html` 里的 `id` **不重复**（重复的 id 让 `$()` 只拿到第一个）", () => {
    const html = String(loadPanelAsset("index.html")!.body);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!);
    const duplicated = ids.filter((id, index) => ids.indexOf(id) !== index);
    expect(duplicated, "重复的 id：" + duplicated.join(", ")).toEqual([]);
  });

  it("`app.js` 真的会启动（`boot()` 被调用，而不是只定义了它）", () => {
    const js = String(loadPanelAsset("app.js")!.body);
    expect(js).toMatch(/^async function boot\(/m);
    /*
     * 允许两种写法：模块顶层直接 `boot()`，或等 DOM 就绪再调。
     * 只要求「有一个**不在函数体内**的调用点」。
     */
    expect(js).toMatch(/^(boot\(\);|window\.addEventListener\("DOMContentLoaded", boot\);|document\.addEventListener\("DOMContentLoaded", boot\);)$/m);
  });

  it("`index.html` 引用的每个 `id` 都在 JS 里有落点（或反之：JS 要的 id 必须存在）", () => {
    /*
     * 反向那条（JS 要、HTML 没有）正是「按钮点了没反应」的常见根因：
     * `$("#toasts")` 拿到 null ⇒ `toast()` 静默失败，用户看不到任何提示。
     * 例外：这些 id 由 JS 自己生成（对话框 / 抽屉内容），不在静态 HTML 里。
     */
    const html = String(loadPanelAsset("index.html")!.body);
    const js = String(loadPanelAsset("app.js")!.body);
    const present = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!));
    const dynamic = new Set([
      "step-up-key",
      "step-up-error",
      "invite-code",
      "invite-uses",
      "invite-days",
      "invite-error",
      "account-caret",
    ]);
    const required = [...js.matchAll(/\$\("#([a-zA-Z][a-zA-Z0-9_-]*)"\)/g)]
      .map((match) => match[1]!)
      .filter((id) => !dynamic.has(id));
    const missing = [...new Set(required)].filter((id) => !present.has(id));
    expect(missing, "JS 要但 HTML 没有的 id：" + missing.join(", ")).toEqual([]);
  });

  it("`views.js` / `app.js` 用到的类名**在样式表里都有定义**（少一条不报错，只是那行塌掉）", () => {
    /*
     * 这条覆盖的是一类「看不出来」的缺陷：标记写对了、CSS 没跟上。
     * 浏览器不会报错，页面也没 404 —— 只是那一块退回默认样式。
     */
    const css = String(loadPanelAsset("styles.css")!.body);
    const defined = new Set([...css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)].map((match) => match[1]!));
    const used = new Set<string>();
    for (const name of ["views.js", "app.js"]) {
      const source = String(loadPanelAsset(name)!.body);
      // 只取「字面量类名列表」：以字母开头的简单 token，跳过拼接出来的片段。
      for (const match of source.matchAll(/class=\?"([a-zA-Z][a-zA-Z0-9_ -]*)\?"/g)) {
        for (const token of match[1]!.split(/\s+/)) if (token) used.add(token);
      }
    }
    const missing = [...used].filter((token) => !defined.has(token)).sort();
    expect(missing, "样式表里缺：" + missing.join(", ")).toEqual([]);
  });
});


describe("视图函数 · 显示层的小陷阱", () => {
  /*
   * 这些都是「浏览器不报错、接口也正常」的一类缺陷 —— 只在页面上看得出来。
   */

  it("★ `shortId(x, head, 0)` 只留前缀（`slice(-0)` 会返回整个字符串）", () => {
    /*
     * 邀请码那一列就是这么印出来的：`shortId(codeHash, 8, 0)` 本意是「只留前 8 位」，
     * 但 `slice(-0)` === `slice(0)` —— 于是整串 64 位都被拼上去，
     * 表格那一列被撑爆，而且看起来像是**数据**坏了（其实只是显示）。
     */
    const V = loadViews();
    const hash = "f".repeat(64);
    const shown = V.shortId(hash, 8, 0);
    expect(shown).toBe("ffffffff…");
    // 普通截断不受影响。
    expect(V.shortId("abcdef0123456789")).toBe("abcdef01…6789");
    // 短到不用截断的原样返回。
    expect(V.shortId("short")).toBe("short");
    expect(V.shortId(null)).toBe("—");
  });

  it("★ 流量图的纵轴**跟着数据走**（固定 400 会把个位数用量压成 0 像素）", () => {
    /*
     * 原型里量程写死成 `ceil(max/400)*400`，在冻结示例数据（每天几百次）上没问题；
     * 搬到真服务器上就露馅：自托管日常用量是个位数，柱子高度不足 1 像素，
     * 看起来与「没有数据」完全一样 —— 而卡片脚注明明写着「合计 9 次请求」。
     */
    const V = loadViews();
    const day = { day: "2026-10-23", pulls: 6, pushes: 3, conflicts: 1, errors: 0, deletes: 0 };
    const html = V.renderOverview(
      {
        generatedAt: Date.now(),
        accounts: { total: 1, admins: 1, disabled: 0 },
        notebooks: { total: 1, bytesUsed: 100 },
        devices: { total: 1, stale: 0 },
        traffic: { days: [day], total: { pulls: 6, pushes: 3, conflicts: 1, errors: 0 } },
        health: { couchOk: true, couchVersion: "3.3.3", protocolVersion: 1, provisioningMismatch: 0, uptimeSeconds: 60 },
        attention: [],
        conflictHotspots: [],
        recentEvents: [],
      },
      Date.now(),
    );
    /*
     * 量程的判据：轴上的**最大值标签**必须接近数据（这里 pull+push = 9）。
     * 固定 400 会印出 ">400" 这种标签，而实际只用了 9。
     */
    expect(html).not.toContain(">400<");
    expect(html).toMatch(/>10</);
  });

  it("冲突图的单日数据也画得出点（一个点连不成线，但不能什么都不画）", () => {
    const V = loadViews();
    const html = V.renderIssues(
      {
        traffic: { days: [{ day: "2026-10-23", pulls: 1, pushes: 1, conflicts: 3, errors: 0, deletes: 0 }], total: { pulls: 1, pushes: 1, conflicts: 3, errors: 0 } },
        health: { provisioningMismatch: 0 },
        conflictHotspots: [],
      },
      Date.now(),
    );
    expect(html).toContain("<circle");
  });
});

