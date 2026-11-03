/**
 * HTTP 应用的装配（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §2.4、§4.7、§4.11）。
 *
 * ## 一个 hostname 的四个面（§2.4）
 *
 * | 路径 | 是什么 | 谁用 |
 * | --- | --- | --- |
 * | `/` + 静态资源 | **PWA 客户端**（与其它两个同源，所以 CSP 不用放开任何 https） | 网页端 |
 * | `/v1/*` | 客户端 API | 桌面 / Android / 网页 |
 * | `/admin`、`/join`、`/reset` | **控制台**与两张公开页（`routes/panel.ts`） | 浏览器（运维 / 被邀请的人） |
 * | `/v1/health` | 公开健康检查 | 隧道 / 监控 |
 *
 * 同源带来两件具体的好事：**CSP 里 `connect-src` 不用放开任何 https**；控制台不需要 CORS。
 *
 * ## 装配顺序（有讲究）
 *
 * ```
 * 1. 全局兜底限流（IP）      ← 最先，最便宜，挡住最粗的滥用
 * 2. 账号限流（Bearer → 键）  ← 在认证之前，所以它必须比认证便宜（只算 sha256 前 16 位）
 * 3. 路由（account / notebooks / v1 / admin）
 * 4. 404 / 500 兜底
 * ```
 *
 * 限流**放在认证之前**是有意的：认证要查库，而限流的目的正是「别让没资格的人把库打满」。
 *
 * ## 为什么没有 CORS 中间件
 *
 * 三个面同源（§2.4），不需要跨域。**不加比加错好** —— 一个宽泛的
 * `Access-Control-Allow-Origin: *` 会让任意网页拿着用户浏览器里的凭据打我们的 API。
 * 真需要跨域时（例如 `file://` 的桌面端）走主进程代理，不由服务端放开。
 */

import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { DatabaseSync } from "node:sqlite";
import type { ServerConfig } from "./config";
import { clientIpFrom } from "./config";
import { CouchClient } from "./couch/client";
import { AccountStore } from "./auth/accounts";
import { NotebookStore } from "./notebooks";
import { rateLimit, globalRateLimitKey, rateLimitKeyFromHeader } from "./ratelimit";
import { createAuthRoutes, LoginThrottle } from "./routes/auth";
import { createAdminRoutes } from "./routes/admin";
import { createAdminViewRoutes } from "./routes/adminView";
import { createPanelRoutes } from "./routes/panel";
import { createGithubRoutes } from "./routes/github";
import { createGithubApi, OAuthFlows, type GithubApi } from "./auth/github";
import { PairingStore } from "./auth/pairing";
import { createPairingRoutes } from "./routes/pairing";
import { createNotebookRoutes } from "./routes/notebooks";
import { createV1Routes } from "./routes/v1";
import { SettingsStore } from "./settings";
import { csrfGuard, isHttps, securityHeaders } from "./panelSecurity";

export interface AppOptions {
  config: ServerConfig;
  db: DatabaseSync;
  /** 覆盖 CouchDB 客户端（测试注入假实现）。 */
  couch?: CouchClient;
  couchAdmin?: CouchClient;
  /** 进程启动时间（uptime）。 */
  startedAt?: number;
  /** 覆盖 GitHub 接口（测试注入假实现）。 */
  github?: GithubApi;
  now?: () => number;
}

export interface BuiltApp {
  app: Hono;
  accounts: AccountStore;
  notebooks: NotebookStore;
  settings: SettingsStore;
  couch: CouchClient;
  couchAdmin: CouchClient;
}

/** 限流键用的短哈希（**不是**用来认证的，只是为了不在内存里存可用凭据）。 */
function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

/**
 * 对端 socket 地址 —— **可信代理头不存在时的兜底**。
 *
 * ## 为什么必须兜这一层（这是一次真实事故的修复）
 *
 * 全局兜底限流的键以前只有一条来源：`cf-connecting-ip`。而直连 `http://<host>:8787`
 * 的客户端（桌面端默认就是这么连的）**不会**带这个头 —— 于是所有这样的客户端
 * 都落进同一个 `ip:unknown` 桶，共享一份「600 请求/分钟」。两台设备一起同步时
 * 互相把对方挤掉，症状是满屏 `429`，而带宽根本没用上。
 *
 * socket 地址对**直连**是真的（NAT 之后是出口 IP），对「宿主上的隧道」是 `127.0.0.1` ——
 * 后者配了可信头之后就走可信头，不会走到这里。
 *
 * `getConnInfo` 在测试的 `app.request()` 下会抛（没有真实 socket），所以包一层。
 */
function socketAddress(c: Context): string | null {
  try {
    const info = getConnInfo(c);
    return info.remote.address ?? null;
  } catch {
    return null;
  }
}

/**
 * 装配应用。**不监听端口** —— 那由 `index.ts` 或测试来做，
 * 这样用例可以拿 `app.request()` 直接打，不需要真起服务器。
 */
export function createApp(options: AppOptions): BuiltApp {
  const { config, db } = options;
  const accounts = new AccountStore(db);
  const notebooks = new NotebookStore(db);
  const settings = new SettingsStore(db, config);
  const couch = options.couch ?? CouchClient.fromConfig(config);
  const couchAdmin = options.couchAdmin ?? CouchClient.adminFromConfig(config);

  const app = new Hono();

  /*
   * 全局兜底限流（令牌桶）：**可信头优先，socket 地址兜底**。
   *
   * 只信配置里声明过的代理头（默认空 = 谁都不信），按一个可伪造的头分桶等于给
   * 攻击者一个「换头就换桶」的开关（U19）。但**没有可信头 ≠ 没有身份**：
   * 直连的客户端有真实的 socket 地址，拿它兜底才不会退化成「全体共用一个桶」。
   */
  app.use(
    "*",
    rateLimit({
      perMinute: config.globalRequestsPerMinute,
      burst: config.globalBurst,
      keyOf: (c) => {
        // 健康检查不记账：它要能被监控高频打，而且它不查库。
        if (c.req.path === "/v1/health") return null;
        return globalRateLimitKey(clientIpFrom(c.req.raw.headers, config) ?? socketAddress(c));
      },
    }),
  );

  /* 账号限流：**在认证之前**（见模块头）。 */
  app.use(
    "/v1/*",
    rateLimit({
      perMinute: config.accountRequestsPerMinute,
      burst: config.accountBurst,
      keyOf: (c) => rateLimitKeyFromHeader(c, shortHash),
    }),
  );

  /* ------------------------------------------------------------ 安全响应头 */
  /*
   * §7.3 Node 第 2 条。**所有**响应都发（静态资源也发 —— `nosniff` 对它们同样重要：
   * 这个服务到处在传用户可控的字节）。
   * `csp` 只给控制台页面发：`/v1/*` 返回的是 JSON，给它发 CSP 没有意义（也没有害处，
   * 但会让「CSP 到底保护了什么」变得含糊）。
   */
  const https = isHttps(config);
  app.use("*", async (c, next) => {
    await next();
    const headers = securityHeaders({ https, csp: null });
    for (const [key, value] of Object.entries(headers)) {
      // 不覆盖路由自己设的头（例如静态资源已经给了准确的 content-type）。
      if (!c.res.headers.has(key)) c.res.headers.set(key, value);
    }
  });

  const nowOption = options.now === undefined ? {} : { now: options.now };
  const audit = (event: Parameters<NotebookStore["audit"]>[0]): void => notebooks.audit(event);
  // 客户端登录与控制台登录共用一份失败计数：换个入口不该换来五次新机会。
  const throttle = new LoginThrottle();
  // 进行中的 GitHub 授权与一次性登录码（只在内存）：回调路由发码，`/v1/auth/github/exchange` 收码。
  const oauth = new OAuthFlows();

  app.route("/v1", createAuthRoutes({ accounts, notebooks, config, settings, audit, throttle, oauth, ...nowOption }));
  app.route("/v1", createPairingRoutes({ accounts, notebooks, config, settings, pairings: new PairingStore(), audit, ...nowOption }));
  app.route(
    "/v1",
    createNotebookRoutes({
      accounts,
      notebooks,
      config,
      couch,
      couchAdmin,
      audit: (event) => notebooks.audit(event),
    }),
  );
  app.route(
    "/v1",
    createV1Routes({ accounts, notebooks, config, couch, couchAdmin, settings, audit: (event) => notebooks.audit(event) }),
  );
  /*
   * 控制台用 cookie 调管理接口：cookie 会被浏览器自动带上，所以变更请求必须带自定义头
   * （跨源页面发不出来）。纯 Bearer 的请求没有 cookie，不受影响（见 `csrfGuard`）。
   */
  app.use("/v1/admin/*", csrfGuard());
  app.route(
    "/v1/admin",
    createAdminViewRoutes({
      accounts,
      notebooks,
      config,
      couch,
      settings,
      ...(options.startedAt === undefined ? {} : { startedAt: options.startedAt }),
      ...nowOption,
    }),
  );
  app.route(
    "/v1/admin",
    createAdminRoutes({
      accounts,
      notebooks,
      config,
      couch,
      settings,
      audit: (event) => notebooks.audit(event),
      ...(options.startedAt === undefined ? {} : { startedAt: options.startedAt }),
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
  );

  /* 网页控制台（`/admin`）、`/join`、`/reset` 与它们的静态资源、cookie 会话接口。 */
  app.route("/", createPanelRoutes({ accounts, notebooks, config, settings, throttle, audit, ...nowOption }));
  app.route("/", createGithubRoutes({ accounts, config, settings, oauth, github: options.github ?? createGithubApi(), audit, ...nowOption }));

  // 兜底 404：**形状与其它错误一致**（`{error, code}`），免得客户端要处理两种错误体。
  app.notFound((c) =>
    new Response(JSON.stringify({ error: `没有这个接口：${c.req.method} ${c.req.path}`, code: "not-found" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
  );

  /*
   * 兜底 500：**不把内部错误直接吐给客户端**（可能带路径、SQL、库名）。
   * 服务端日志里留全量，客户端只拿到一句可读的话 + 一个可追踪的 requestId。
   */
  app.onError((error, c) => {
    const requestId = shortHash(`${c.req.method} ${c.req.path} ${Date.now()}`);
    console.error(`[opennote-server] 未处理错误（${requestId}）`, error);
    return new Response(JSON.stringify({ error: "服务端内部错误", code: "server", requestId }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  });

  return { app, accounts, notebooks, settings, couch, couchAdmin };
}
