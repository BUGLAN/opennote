/**
 * GitHub 登录（OAuth App）的两块零件（`docs/执行-同步重写-2026-11-02.md` 阶段 ③）：
 *
 * 1. `GithubApi`：和 github.com 说话的三四个请求（换令牌、读用户、读邮箱、读组织）。
 *    测试注入假实现，所以路由层从不直接 `fetch` GitHub。
 * 2. `OAuthFlows`：进行中的授权（`state`）与发给客户端的一次性登录码，都只在**内存**里、10 分钟过期。
 *    服务重启会让正在授权的人重来一次 —— 换来的是不用为两张临时表加迁移。
 *
 * ## 客户端拿到会话的路（PKCE）
 *
 * ```
 * 客户端：verifier = 随机 32 字节；challenge = base64url(sha256(verifier))
 *   → 浏览器打开 /auth/github?mode=app&challenge=…&state=…
 *   → GitHub 授权 → /auth/github/callback
 *   → 服务端认出账号，发一次性登录码 code（绑着 challenge）
 *   → opennote://sync/callback?code=…&state=…（网页端是 /?sync_code=…）
 * 客户端：POST /v1/auth/github/exchange { code, verifier, device } → 设备会话
 * ```
 *
 * 登录码本身不是凭据：没有 verifier 换不出会话。别的程序截走深链也没用。
 * 码与 state 在内存里只存 sha256（和库里的一次性码同一条纪律）。
 */

import { createHash, randomBytes } from "node:crypto";
import { hashCode } from "./accounts";

export interface GithubUser {
  id: number;
  login: string;
  name: string | null;
}

export interface GithubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

export interface GithubApi {
  /** 用回调里的 `code` 换访问令牌。 */
  exchangeCode(input: { clientId: string; clientSecret: string; code: string; redirectUri: string }): Promise<string>;
  user(token: string): Promise<GithubUser>;
  emails(token: string): Promise<GithubEmail[]>;
  /** 用户所在组织的 login（小写）。需要 `read:org`。 */
  orgs(token: string): Promise<string[]>;
}

export class GithubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubError";
  }
}

/** 真的 GitHub。`fetchImpl` 留给测试 / 代理环境。 */
export function createGithubApi(fetchImpl: typeof fetch = fetch): GithubApi {
  const api = async <T>(token: string, path: string): Promise<T> => {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "opennote-sync" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new GithubError(`GitHub 接口 ${path} 返回 ${response.status}`);
    return (await response.json()) as T;
  };
  return {
    async exchangeCode({ clientId, clientSecret, code, redirectUri }) {
      const response = await fetchImpl("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", "user-agent": "opennote-sync" },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await response.json().catch(() => null)) as { access_token?: string; error?: string; error_description?: string } | null;
      if (!response.ok || !body?.access_token) {
        throw new GithubError(body?.error === "bad_verification_code" ? "GitHub 授权码已过期，请重新登录" : `GitHub 换令牌失败：${body?.error_description ?? body?.error ?? response.status}`);
      }
      return body.access_token;
    },
    user: (token) => api<GithubUser>(token, "/user"),
    emails: (token) => api<GithubEmail[]>(token, "/user/emails"),
    async orgs(token) {
      const rows = await api<{ login: string }[]>(token, "/user/orgs?per_page=100");
      return rows.map((row) => row.login.toLowerCase());
    },
  };
}

/** 主邮箱（已验证）优先，其次任一已验证邮箱。 */
export function verifiedEmailOf(emails: GithubEmail[]): string | null {
  const verified = emails.filter((item) => item.verified);
  return (verified.find((item) => item.primary) ?? verified[0])?.email.toLowerCase() ?? null;
}

/** PKCE：`challenge = base64url(sha256(verifier))`。 */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

/* ------------------------------------------------------------ 进行中的授权 */

export type OAuthMode = "app" | "join" | "panel" | "link";

export interface OAuthStart {
  mode: OAuthMode;
  /** app：客户端的 PKCE challenge 与它自己的 state（原样带回去，防串号）。 */
  challenge?: string;
  clientState?: string;
  /** app：回到桌面 / 手机应用（深链）还是网页端（同源页面）。 */
  returnTo?: "app" | "web";
  /** join：邀请码明文。 */
  invite?: string;
  /** link：要绑定到哪个账号（由一次性绑定票换来）。 */
  accountId?: string;
}

interface Expiring<T> {
  value: T;
  expiresAt: number;
}

export const OAUTH_TTL_MS = 10 * 60_000;
export const LOGIN_CODE_TTL_MS = 5 * 60_000;

export class OAuthFlows {
  private readonly states = new Map<string, Expiring<OAuthStart>>();
  private readonly codes = new Map<string, Expiring<{ accountId: string; challenge: string }>>();
  private readonly tickets = new Map<string, Expiring<{ accountId: string }>>();

  private sweep(now: number): void {
    for (const map of [this.states, this.codes, this.tickets] as Map<string, Expiring<unknown>>[]) {
      for (const [key, item] of map) if (item.expiresAt <= now) map.delete(key);
    }
  }

  /** 开一次授权：返回发给 GitHub 的 `state`。 */
  begin(start: OAuthStart, now = Date.now()): string {
    this.sweep(now);
    const state = randomBytes(24).toString("base64url");
    this.states.set(hashCode(state), { value: start, expiresAt: now + OAUTH_TTL_MS });
    return state;
  }

  /** 回调时取出并作废（一个 state 只能用一次）。 */
  finish(state: string, now = Date.now()): OAuthStart | null {
    const key = hashCode(state);
    const item = this.states.get(key);
    this.states.delete(key);
    return item && item.expiresAt > now ? item.value : null;
  }

  /** 给客户端发一次性登录码（绑 challenge）。 */
  issueLoginCode(accountId: string, challenge: string, now = Date.now()): string {
    this.sweep(now);
    const code = `ghc_${randomBytes(24).toString("base64url")}`;
    this.codes.set(hashCode(code), { value: { accountId, challenge }, expiresAt: now + LOGIN_CODE_TTL_MS });
    return code;
  }

  /** 用 verifier 换回账号 id；码不对 / 过期 / verifier 不匹配都返回 null（码随即作废）。 */
  redeemLoginCode(code: string, verifier: string, now = Date.now()): string | null {
    const key = hashCode(code);
    const item = this.codes.get(key);
    this.codes.delete(key);
    if (!item || item.expiresAt <= now) return null;
    return pkceChallenge(verifier) === item.value.challenge ? item.value.accountId : null;
  }

  /** 已登录的客户端要绑定 GitHub：先换一张一次性票，再拿它在浏览器里走授权。 */
  issueLinkTicket(accountId: string, now = Date.now()): string {
    this.sweep(now);
    const ticket = `ghl_${randomBytes(24).toString("base64url")}`;
    this.tickets.set(hashCode(ticket), { value: { accountId }, expiresAt: now + OAUTH_TTL_MS });
    return ticket;
  }

  redeemLinkTicket(ticket: string, now = Date.now()): string | null {
    const key = hashCode(ticket);
    const item = this.tickets.get(key);
    this.tickets.delete(key);
    return item && item.expiresAt > now ? item.value.accountId : null;
  }
}
