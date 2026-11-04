/**
 * 网页控制台与两张公开页（`docs/执行-同步重写-2026-11-02.md` 阶段 ②）。
 *
 * | 路径 | 是什么 |
 * | --- | --- |
 * | `GET /admin`、`/admin/*` | 控制台（零账号时显示初始化表单，没登录显示登录表单） |
 * | `GET /join/:code` | 被邀请的人设密码、建账号 |
 * | `GET /reset/:code` | 管理员发出的「设置密码」链接 |
 * | `GET /auth/result` | GitHub 授权在网页上的收尾（接受邀请 / 绑定成功，或失败原因） |
 * | `GET /panel/*` | 上面三者共用的静态资源（白名单，见 `panelAssets.ts`） |
 * | `GET /v1/panel/session` | 页面启动时问：要不要初始化、登录了没有 |
 * | `POST /v1/panel/setup` · `login` · `logout` | 初始化 / 登录 / 退出（cookie 会话） |
 *
 * 四个页面路径发的是**同一份** `index.html`，由 `app.js` 按路径决定画哪一页。
 *
 * ## 控制台会话
 *
 * 邮箱密码登录 → `kind = panel` 的会话（8 小时）→ 令牌只进 `HttpOnly` cookie，页面 JS 碰不到。
 * 之后 `/v1/admin/*` 同时认 cookie 与 Bearer（`adminGate.ts`），cookie 请求的变更要过 CSRF 闸门
 * （`X-Requested-With: opennote-panel`，见 `panelSecurity.ts`）。
 *
 * 本文件的三个 POST **不管有没有 cookie 都要那个头**：登录 / 初始化时还没有 cookie，
 * 但「别的网站替你提交一次登录」同样不该发生。
 *
 * 只有管理员能登录控制台：普通账号在这里输对密码也拿不到 cookie（403），
 * 免得一个用不了任何页面的会话挂在浏览器里。
 */

import { Hono, type Context } from "hono";
import { loginRequestSchema, setupRequestSchema } from "../../../shared/contract";
import { AccountError, PANEL_SESSION_TTL_MS, type AccountStore } from "../auth/accounts";
import { clientIpFrom, type ServerConfig } from "../config";
import type { NotebookStore } from "../notebooks";
import { loadPanelAsset } from "../panelAssets";
import {
  CSRF_HEADER,
  CSRF_HEADER_DISPLAY,
  CSRF_VALUE,
  PANEL_COOKIE,
  PANEL_CSP,
  buildClearCookie,
  buildSessionCookie,
  isHttps,
  readCookie,
  securityHeaders,
} from "../panelSecurity";
import type { SettingsStore } from "../settings";
import { authenticateAdminRequest } from "./adminGate";
import { accountErrorResponse, LoginThrottle, meOf } from "./auth";

export interface PanelRoutesDeps {
  accounts: AccountStore;
  notebooks: NotebookStore;
  config: ServerConfig;
  settings: SettingsStore;
  /** 与客户端登录共用：同一个邮箱在两边失败的次数合在一起算。 */
  throttle: LoginThrottle;
  audit?: (event: { actorId: string | null; action: string; target?: string | null; ip?: string | null; detail?: string | null }) => void;
  now?: () => number;
}

/** 发同一份外壳的页面路径。 */
const PAGE_PATHS = ["/admin", "/admin/*", "/join/:code", "/reset/:code", "/auth/result"] as const;

export function createPanelRoutes(deps: PanelRoutesDeps): Hono {
  const routes = new Hono();
  const now = (): number => deps.now?.() ?? Date.now();
  const https = isHttps(deps.config);
  const json = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
    });
  const ipOf = (c: Context): string | null => clientIpFrom(c.req.raw.headers, deps.config);

  /** 本文件 POST 的 CSRF 头：有没有 cookie 都要（见模块头）。 */
  const csrfMissing = (c: Context): Response | null =>
    c.req.header(CSRF_HEADER) === CSRF_VALUE
      ? null
      : json({ error: `请求必须带 ${CSRF_HEADER_DISPLAY}: ${CSRF_VALUE}（防 CSRF）`, code: "bad-request" }, 400);

  const sessionCookie = (token: string): string => buildSessionCookie(token, { https, maxAgeSeconds: PANEL_SESSION_TTL_MS / 1000 });

  /* ---------------------------------------------------------------- 页面 */

  const shell = (): Response => {
    const asset = loadPanelAsset("index.html");
    if (!asset) return new Response("控制台页面缺失", { status: 500 });
    return new Response(asset.body as string, {
      status: 200,
      headers: {
        "content-type": asset.contentType,
        "cache-control": "no-store",
        ...securityHeaders({ https, csp: PANEL_CSP }),
      },
    });
  };
  for (const path of PAGE_PATHS) routes.get(path, shell);

  routes.get("/panel/*", (c) => {
    const name = c.req.path.slice("/panel/".length);
    const asset = loadPanelAsset(name);
    if (!asset) return json({ error: `没有这个资源：${name}`, code: "not-found" }, 404);
    return new Response(asset.body as ConstructorParameters<typeof Response>[0], {
      status: 200,
      headers: {
        "content-type": asset.contentType,
        // 字体与印章不变，可以缓存；脚本与样式跟着部署变，每次都重新取（文件很小）。
        "cache-control": asset.binary ? "public, max-age=604800" : "no-cache",
      },
    });
  });

  /* ---------------------------------------------------------------- 会话 */

  /** 页面启动时问一次。没登录不算错误（200 + `me: null`），页面据此画初始化 / 登录表单。 */
  routes.get("/v1/panel/session", (c) => {
    const base = {
      setupRequired: deps.accounts.needsSetup(),
      externalBaseUrl: deps.config.externalBaseUrl,
      protocolVersion: deps.config.protocolVersionExpected,
      maxFileBytes: deps.config.maxFileBytes,
      github: deps.settings.githubAvailable(),
      passwordLogin: deps.settings.get("passwordLogin"),
    };
    if (!readCookie(c.req.header("cookie"), PANEL_COOKIE)) return json({ ...base, me: null }, 200);
    const auth = authenticateAdminRequest(deps, c);
    if (auth instanceof Response || auth.account.is_admin !== 1) {
      // 过期 / 被吊销 / 不再是管理员：顺手清掉 cookie，免得每次都带着一张废票来。
      return json({ ...base, me: null }, 200, { "set-cookie": buildClearCookie({ https }) });
    }
    return json({ ...base, me: meOf(deps, auth.account, null), sessionExpiresAt: auth.session.expires_at }, 200);
  });

  routes.post("/v1/panel/login", async (c) => {
    const missing = csrfMissing(c);
    if (missing) return missing;
    const parsed = loginRequestSchema.pick({ email: true, password: true }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return json({ error: "请填写邮箱和密码", code: "bad-request" }, 400);
    const { email, password } = parsed.data;
    const key = email.trim().toLowerCase();
    const locked = deps.throttle.lockedFor(key, now());
    if (locked !== null) {
      return json({ error: `登录失败次数太多，请 ${Math.ceil(locked / 60)} 分钟后再试`, code: "locked", retryAfterSeconds: locked }, 429);
    }
    try {
      const account = await deps.accounts.login(email, password);
      deps.throttle.succeed(key);
      if (account.is_admin !== 1) return json({ error: "这个账号不是管理员，控制台只给管理员用", code: "forbidden" }, 403);
      const { token } = deps.accounts.createSession({ accountId: account.id, kind: "panel", ip: ipOf(c), now: now() });
      deps.accounts.touch(account.id, now());
      deps.audit?.({ actorId: account.id, action: "panel_login", target: null, ip: ipOf(c), detail: null });
      return json({ me: meOf(deps, account, null) }, 200, { "set-cookie": sessionCookie(token) });
    } catch (error) {
      if (error instanceof AccountError) {
        if (error.rejection === "bad-credentials") {
          deps.throttle.fail(key, now());
          if (deps.throttle.lockedFor(key, now()) !== null) {
            deps.audit?.({ actorId: deps.accounts.findByEmail(key)?.id ?? null, action: "login_locked", target: key, ip: ipOf(c), detail: null });
          }
        }
        return accountErrorResponse(error);
      }
      throw error;
    }
  });

  routes.post("/v1/panel/logout", (c) => {
    const missing = csrfMissing(c);
    if (missing) return missing;
    const auth = authenticateAdminRequest(deps, c);
    if (!(auth instanceof Response)) deps.accounts.revokeSession(auth.session.id, now());
    return json(null, 204, { "set-cookie": buildClearCookie({ https }) });
  });

  /**
   * 初始化：只在零账号时可用。建第一个管理员、写下「谁可以注册」，并直接登录控制台
   * （`POST /v1/auth/setup` 是不带 cookie 的同一件事，给脚本用）。
   */
  routes.post("/v1/panel/setup", async (c) => {
    const missing = csrfMissing(c);
    if (missing) return missing;
    const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const parsed = setupRequestSchema.safeParse(raw);
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "请求体形状不对", code: "bad-request" }, 400);
    const registration = raw?.registration;
    if (registration !== undefined && registration !== "invite" && registration !== "open" && registration !== "closed") {
      return json({ error: "registration 必须是 invite / open / closed", code: "bad-request" }, 400);
    }
    try {
      const account = await deps.accounts.setup({ email: parsed.data.email, password: parsed.data.password, displayName: parsed.data.displayName ?? null, now: now() });
      if (registration !== undefined) deps.settings.set({ registration }, now());
      deps.audit?.({ actorId: account.id, action: "setup_admin", target: account.id, ip: ipOf(c), detail: null });
      const { token } = deps.accounts.createSession({ accountId: account.id, kind: "panel", ip: ipOf(c), now: now() });
      return json({ me: meOf(deps, account, null) }, 201, { "set-cookie": sessionCookie(token) });
    } catch (error) {
      if (error instanceof AccountError) return accountErrorResponse(error);
      throw error;
    }
  });

  return routes;
}
