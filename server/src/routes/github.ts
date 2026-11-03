/**
 * GitHub 登录的两个浏览器路由（`docs/执行-同步重写-2026-11-02.md` 阶段 ③）。
 *
 * | 路径 | 做什么 |
 * | --- | --- |
 * | `GET /auth/github?mode=…` | 记下这次授权要干什么，跳到 github.com 的授权页 |
 * | `GET /auth/github/callback` | GitHub 回来：换令牌、读用户，按 mode 收尾 |
 *
 * 四种 mode：
 *
 * | mode | 谁发起 | 收尾 |
 * | --- | --- | --- |
 * | `app` | 客户端（桌面 / 手机 / 网页端） | 发一次性登录码 → 深链 `opennote://sync/callback` 或网页 `/?sync_code=` |
 * | `join` | `/join/<码>` 页的「用 GitHub 接受邀请」 | 建号 + 绑定 → `/auth/result` |
 * | `panel` | 控制台登录页 | 管理员 → 写 cookie → `/admin` |
 * | `link` | 已登录的客户端「绑定 GitHub」 | 绑定 → `/auth/result` |
 *
 * ## 谁能用 GitHub 进来
 *
 * 已经绑过这个 GitHub 身份的账号直接进。没绑过的：
 * - 服务设置是「只有已邀请 / 已绑定的」→ 拒绝，请对方先走邀请链接；
 * - 是「指定组织的成员自动加入」且他在组织里、注册没关 → 用 GitHub 上已验证的邮箱新建账号。
 *
 * **不按邮箱自动绑定已有账号**：「GitHub 上验证过这个邮箱」不等于「这台服务器上那个账号是他的」。
 * 要绑定就先用密码登录，再在客户端里点「绑定 GitHub」（`link`）。
 */

import { Hono, type Context } from "hono";
import { AccountError, PANEL_SESSION_TTL_MS, type AccountRow, type AccountStore } from "../auth/accounts";
import { verifiedEmailOf, type GithubApi, type GithubUser, type OAuthFlows, type OAuthStart } from "../auth/github";
import { clientIpFrom, type ServerConfig } from "../config";
import { buildSessionCookie, isHttps } from "../panelSecurity";
import type { SettingsStore } from "../settings";

export interface GithubRoutesDeps {
  accounts: AccountStore;
  config: ServerConfig;
  settings: SettingsStore;
  oauth: OAuthFlows;
  github: GithubApi;
  audit?: (event: { actorId: string | null; action: string; target?: string | null; ip?: string | null; detail?: string | null }) => void;
  now?: () => number;
}

/** 客户端的 state / challenge 形状（只收 base64url，长度有上限）。 */
const TOKENISH = /^[A-Za-z0-9_-]{16,128}$/;

/** 回到客户端时带的错误码（客户端据此选文案；`message` 是兜底的人话）。 */
type AppError = "not-invited" | "not-in-org" | "disabled" | "github-failed" | "denied" | "email-taken" | "registration-closed";

export function createGithubRoutes(deps: GithubRoutesDeps): Hono {
  const routes = new Hono();
  const now = (): number => deps.now?.() ?? Date.now();
  const base = deps.config.externalBaseUrl;
  const callbackUrl = `${base}/auth/github/callback`;
  const ipOf = (c: Context): string | null => clientIpFrom(c.req.raw.headers, deps.config);

  const redirect = (location: string, headers: Record<string, string> = {}): Response =>
    new Response(null, { status: 302, headers: { location, "cache-control": "no-store", ...headers } });

  /** 网页上的结果页（`/auth/result`，由控制台外壳画）。 */
  const resultPage = (params: Record<string, string>): Response => redirect(`/auth/result?${new URLSearchParams(params).toString()}`);

  /** 回到客户端：桌面 / 手机走深链，网页端回到同源首页。 */
  const backToApp = (start: OAuthStart, params: Record<string, string>): Response => {
    const query = new URLSearchParams({ ...params, state: start.clientState ?? "" }).toString();
    if (start.returnTo === "web") {
      const web = new URLSearchParams();
      for (const [key, value] of new URLSearchParams(query)) web.set(`sync_${key}`, value);
      return redirect(`/?${web.toString()}`);
    }
    return redirect(`opennote://sync/callback?${query}`);
  };

  const fail = (start: OAuthStart | null, error: AppError, message: string): Response =>
    start?.mode === "app" ? backToApp(start, { error, message }) : resultPage({ error, message });

  /* ------------------------------------------------------------ 起点 */

  routes.get("/auth/github", (c) => {
    if (!deps.settings.githubAvailable()) return resultPage({ error: "github-disabled", message: "这台服务器没有开启 GitHub 登录" });
    const mode = c.req.query("mode");
    let start: OAuthStart;
    if (mode === "app") {
      const challenge = c.req.query("challenge") ?? "";
      const clientState = c.req.query("state") ?? "";
      if (!/^[A-Za-z0-9_-]{43}$/.test(challenge) || !TOKENISH.test(clientState)) {
        return resultPage({ error: "bad-request", message: "登录链接不完整，请回到 Opennote 重新点「使用 GitHub 登录」" });
      }
      start = { mode, challenge, clientState, returnTo: c.req.query("return") === "web" ? "web" : "app" };
    } else if (mode === "join") {
      const invite = c.req.query("invite") ?? "";
      try {
        deps.accounts.inviteInfo(invite, now());
      } catch (error) {
        if (error instanceof AccountError) return resultPage({ error: error.rejection, message: error.message });
        throw error;
      }
      if (deps.settings.get("registration") === "closed") return resultPage({ error: "registration-closed", message: "这台服务器暂时不接受新账号，请联系管理员" });
      start = { mode, invite };
    } else if (mode === "panel") {
      start = { mode };
    } else if (mode === "link") {
      const accountId = deps.oauth.redeemLinkTicket(c.req.query("ticket") ?? "", now());
      if (!accountId) return resultPage({ error: "bad-request", message: "绑定链接已过期，请回到 Opennote 重新点「绑定 GitHub」" });
      start = { mode, accountId };
    } else {
      return resultPage({ error: "bad-request", message: "不认识的登录方式" });
    }

    const state = deps.oauth.begin(start, now());
    const scope = deps.settings.get("githubPolicy") === "org" ? "read:user user:email read:org" : "read:user user:email";
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", deps.settings.get("githubClientId"));
    authorize.searchParams.set("redirect_uri", callbackUrl);
    authorize.searchParams.set("scope", scope);
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("allow_signup", "false");
    return redirect(authorize.toString());
  });

  /* ------------------------------------------------------------ 回调 */

  routes.get("/auth/github/callback", async (c) => {
    const start = deps.oauth.finish(c.req.query("state") ?? "", now());
    if (!start) return resultPage({ error: "bad-request", message: "这次授权已经过期或用过了，请重新开始" });
    if (c.req.query("error")) return fail(start, "denied", "你在 GitHub 上取消了授权");
    if (!deps.settings.githubAvailable()) return fail(start, "github-failed", "这台服务器刚刚关闭了 GitHub 登录");

    let user: GithubUser;
    let email: string | null;
    let orgs: string[] | null = null;
    try {
      const token = await deps.github.exchangeCode({
        clientId: deps.settings.get("githubClientId"),
        clientSecret: deps.settings.get("githubClientSecret"),
        code: c.req.query("code") ?? "",
        redirectUri: callbackUrl,
      });
      user = await deps.github.user(token);
      email = verifiedEmailOf(await deps.github.emails(token));
      if (deps.settings.get("githubPolicy") === "org") orgs = await deps.github.orgs(token);
    } catch (error) {
      console.warn("[opennote-server] GitHub 授权失败", error);
      return fail(start, "github-failed", error instanceof Error ? error.message : "GitHub 授权失败，请重试");
    }
    const subject = String(user.id);
    const login = user.login;

    try {
      if (start.mode === "join") {
        const account = deps.accounts.acceptInviteWithIdentity(start.invite!, { githubEmail: email, displayName: user.name, provider: "github", subject, login }, now());
        deps.audit?.({ actorId: account.id, action: "accept_invite", target: account.id, ip: ipOf(c), detail: `github:${login}` });
        return resultPage({ done: "joined", email: account.email ?? "", github: login });
      }
      if (start.mode === "link") {
        deps.accounts.linkIdentity({ accountId: start.accountId!, provider: "github", subject, login, now: now() });
        deps.audit?.({ actorId: start.accountId!, action: "link_github", target: start.accountId!, ip: ipOf(c), detail: login });
        return resultPage({ done: "linked", github: login });
      }

      const account = resolveAccount(subject, login, user.name, email, orgs);
      if ("error" in account) return fail(start, account.error, account.message);
      if (account.status !== "active") return fail(start, "disabled", "账号已被停用，请联系管理员");
      deps.accounts.touchIdentity("github", subject, login, now());
      deps.accounts.touch(account.id, now());

      if (start.mode === "panel") {
        if (account.is_admin !== 1) return resultPage({ error: "forbidden", message: "这个账号不是管理员，控制台只给管理员用" });
        const { token } = deps.accounts.createSession({ accountId: account.id, kind: "panel", ip: ipOf(c), now: now() });
        deps.audit?.({ actorId: account.id, action: "panel_login", target: null, ip: ipOf(c), detail: `github:${login}` });
        return redirect("/admin", { "set-cookie": buildSessionCookie(token, { https: isHttps(deps.config), maxAgeSeconds: PANEL_SESSION_TTL_MS / 1000 }) });
      }
      const code = deps.oauth.issueLoginCode(account.id, start.challenge!, now());
      return backToApp(start, { code, github: login });
    } catch (error) {
      if (error instanceof AccountError) {
        if (start.mode === "app") return fail(start, error.rejection === "email-taken" ? "email-taken" : "github-failed", error.message);
        return resultPage({ error: error.rejection, message: error.message });
      }
      throw error;
    }
  });

  /** 已绑定的直接进；没绑定的按「谁能用 GitHub 登录」决定能不能自动建号。 */
  const resolveAccount = (
    subject: string,
    login: string,
    name: string | null,
    email: string | null,
    orgs: string[] | null,
  ): AccountRow | { error: AppError; message: string } => {
    const linked = deps.accounts.findByIdentity("github", subject);
    if (linked) return linked;
    if (deps.settings.get("githubPolicy") !== "org") {
      return { error: "not-invited", message: `@${login} 不在这台服务器的用户里。请先向管理员要邀请链接；已有账号的话，用密码登录后在「设置 → 同步」里绑定 GitHub。` };
    }
    const allowed = deps.settings.get("githubOrgs").map((org) => org.toLowerCase());
    if (!orgs || !orgs.some((org) => allowed.includes(org))) {
      return { error: "not-in-org", message: `这台服务器只允许 ${allowed.join("、") || "（未设置）"} 组织的成员登录。` };
    }
    if (deps.settings.get("registration") === "closed") return { error: "registration-closed", message: "这台服务器暂时不接受新账号，请联系管理员" };
    if (!email) return { error: "github-failed", message: "GitHub 上没有已验证的邮箱，没法建账号" };
    if (deps.accounts.findByEmail(email)) {
      return { error: "email-taken", message: `${email} 已经有账号了：用密码登录后在「设置 → 同步」里绑定 GitHub。` };
    }
    const created = deps.accounts.createWithIdentity({ email, displayName: name, provider: "github", subject, login, now: now() });
    deps.audit?.({ actorId: created.id, action: "register_github", target: created.id, ip: null, detail: login });
    return created;
  };

  return routes;
}
