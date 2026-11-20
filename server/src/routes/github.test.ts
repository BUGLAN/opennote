/**
 * GitHub 登录（`routes/github.ts`、`/v1/auth/github/exchange`、`/v1/me/github*`），GitHub 那一侧是假的。
 *
 * 钉住：
 * - 没绑定的 GitHub 账号进不来（除非组织策略放行）；不按邮箱自动绑定已有账号；
 * - 一次性登录码离了 PKCE verifier 换不出会话，而且错一次就作废；
 * - `join` / `panel` / `link` 各自的收尾；
 * - Secret 只写不读；GitHub 配好、且管理员已绑定之前不许关密码登录。
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../app";
import { openDatabase } from "../db";
import { loadConfig } from "../config";
import { FakeCouch, couchClient } from "../couch/fakeCouch.test-helper";
import { seedAccount } from "../auth/testAccounts.test-helper";
import { OAuthFlows, type GithubApi } from "../auth/github";

const ENV: Record<string, string> = {
  EXTERNAL_BASE_URL: "https://notes.example.com",
  COUCH_URL: "http://couchdb:5984",
  COUCH_USER: "sync-service",
  COUCH_PASSWORD: "pw",
  COUCH_ADMIN_USER: "admin",
  COUCH_ADMIN_PASSWORD: "apw",
};
const VERIFIER = "v".repeat(43);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const DEVICE = { deviceId: "d".repeat(32), name: "Pixel 8", platform: "android", os: "android" } as const;

interface FakeUser {
  id: number;
  login: string;
  email: string | null;
  verifiedEmails?: { email: string; primary: boolean; verified: boolean }[];
  orgs?: string[];
}

function makeWorld(options: { oauth?: OAuthFlows } = {}) {
  const fake = new FakeCouch();
  const users = new Map<string, FakeUser>();
  const github: GithubApi = {
    async exchangeCode({ code }) {
      if (!users.has(code)) throw new Error("bad code");
      return `tok-${code}`;
    },
    user: async (token) => {
      const user = users.get(token.slice(4))!;
      return { id: user.id, login: user.login, name: user.login.toUpperCase() };
    },
    emails: async (token) => {
      const user = users.get(token.slice(4))!;
      return user.verifiedEmails ?? (user.email ? [{ email: user.email, primary: true, verified: true }] : []);
    },
    orgs: async (token) => users.get(token.slice(4))!.orgs ?? [],
  };
  const built = createApp({
    config: loadConfig(ENV),
    db: openDatabase({ path: ":memory:" }),
    couch: couchClient(fake),
    couchAdmin: couchClient(fake),
    github,
    ...(options.oauth === undefined ? {} : { oauth: options.oauth }),
  });
  const { app, accounts, settings } = built;
  const configure = (extra: Record<string, unknown> = {}) =>
    settings.set({ githubEnabled: true, githubClientId: "Ov23li", githubClientSecret: "s3cret", ...extra });

  const call = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const response = await app.request(`http://localhost${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json", ...init.headers },
      redirect: "manual",
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    let body: Record<string, any> | null = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: response.status, location: response.headers.get("location"), headers: response.headers, body };
  };

  /** 走完一趟授权：起点 → （假装在 GitHub 上点了同意）→ 回调。返回回调的跳转目标。 */
  const authorize = async (startQuery: string, githubCode: string): Promise<{ location: string; headers: Headers }> => {
    const start = await call(`/auth/github?${startQuery}`);
    expect(start.status).toBe(302);
    const authorizeUrl = new URL(start.location!);
    expect(authorizeUrl.host).toBe("github.com");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe("https://notes.example.com/auth/github/callback");
    const callback = await call(`/auth/github/callback?code=${githubCode}&state=${authorizeUrl.searchParams.get("state")}`);
    expect(callback.status).toBe(302);
    return { location: callback.location!, headers: callback.headers };
  };
  const appStart = `mode=app&challenge=${CHALLENGE}&state=client-state-123456`;
  return { accounts, settings, users, configure, call, authorize, appStart };
}

describe("开关", () => {
  it("没配好时健康检查报 false、起点直接给结果页；配好之后报 true", async () => {
    const world = makeWorld();
    expect((await world.call("/v1/health")).body?.auth.github).toBe(false);
    const start = await world.call(`/auth/github?${world.appStart}`);
    expect(start.location).toMatch(/^\/auth\/result\?error=github-disabled/);
    world.configure();
    expect((await world.call("/v1/health")).body?.auth.github).toBe(true);
  });

  it("Secret 只写不读；GitHub 配好之前、管理员绑定之前都不许关密码登录", async () => {
    const world = makeWorld();
    const admin = seedAccount(world.accounts, { isAdmin: true });
    const auth = { authorization: `Bearer ${admin.token}` };
    expect((await world.call("/v1/admin/settings", { method: "PATCH", body: { passwordLogin: false }, headers: auth })).status).toBe(409);
    const configured = await world.call("/v1/admin/settings", { method: "PATCH", body: { githubEnabled: true, githubClientId: "Ov23li", githubClientSecret: "s3cret", passwordLogin: false }, headers: auth });
    expect(configured.status).toBe(409);
    expect(configured.body?.code).toBe("no-admin-github");

    const member = seedAccount(world.accounts);
    world.accounts.linkIdentity({ accountId: member.id, provider: "github", subject: "2", login: "staff" });
    expect((await world.call("/v1/admin/settings", { method: "PATCH", body: { githubEnabled: true, githubClientId: "Ov23li", githubClientSecret: "s3cret", passwordLogin: false }, headers: auth })).status).toBe(409);

    world.accounts.linkIdentity({ accountId: admin.id, provider: "github", subject: "1", login: "boss" });
    const saved = await world.call("/v1/admin/settings", { method: "PATCH", body: { githubEnabled: true, githubClientId: "Ov23li", githubClientSecret: "s3cret", passwordLogin: false }, headers: auth });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ passwordLogin: false, githubAvailable: true, githubClientSecretSet: true });
    expect(JSON.stringify(saved.body)).not.toContain("s3cret");
    // 留空 = 不修改。
    await world.call("/v1/admin/settings", { method: "PATCH", body: { githubClientSecret: "" }, headers: auth });
    expect(world.settings.get("githubClientSecret")).toBe("s3cret");
  });
});

describe("待处理授权上限", () => {
  it("同一来源的 state 达到上限 ⇒ 429，不再分配", async () => {
    const oauth = new OAuthFlows({ limits: { statesPerSource: 2, statesGlobal: 10 } });
    const world = makeWorld({ oauth });
    world.configure();

    expect((await world.call(`/auth/github?${world.appStart}`)).status).toBe(302);
    expect((await world.call(`/auth/github?${world.appStart}`)).status).toBe(302);
    const limited = await world.call(`/auth/github?${world.appStart}`);
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ code: "too-many" });
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(oauth.stats().states).toBe(2);
  });

  it("同一账号的绑定票达到上限 ⇒ /v1/me/github/link 返回 429", async () => {
    const oauth = new OAuthFlows({ limits: { linkTicketsPerAccount: 1, linkTicketsGlobal: 10 } });
    const world = makeWorld({ oauth });
    world.configure();
    const lan = seedAccount(world.accounts);
    const auth = { authorization: `Bearer ${lan.token}` };

    expect((await world.call("/v1/me/github/link", { body: {}, headers: auth })).status).toBe(200);
    const limited = await world.call("/v1/me/github/link", { body: {}, headers: auth });
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ code: "too-many" });
  });
});

describe("客户端登录（mode=app）", () => {
  it("已绑定：回到深链拿一次性码；没有 verifier 换不出会话，错一次码就作废", async () => {
    const world = makeWorld();
    world.configure();
    const lan = seedAccount(world.accounts, { email: "lan@example.com" });
    world.accounts.linkIdentity({ accountId: lan.id, provider: "github", subject: "42", login: "buglan" });
    world.users.set("gh1", { id: 42, login: "buglan-renamed", email: "lan@example.com" });

    const { location } = await world.authorize(world.appStart, "gh1");
    const back = new URL(location);
    expect(back.protocol).toBe("opennote:");
    expect(back.searchParams.get("state")).toBe("client-state-123456");
    const code = back.searchParams.get("code")!;

    const wrong = await world.call("/v1/auth/github/exchange", { body: { code, verifier: "w".repeat(43), device: DEVICE } });
    expect(wrong.status).toBe(401);
    // 同一个码再用正确的 verifier 也不行了。
    expect((await world.call("/v1/auth/github/exchange", { body: { code, verifier: VERIFIER, device: DEVICE } })).status).toBe(401);

    const again = new URL((await world.authorize(world.appStart, "gh1")).location);
    const ok = await world.call("/v1/auth/github/exchange", { body: { code: again.searchParams.get("code"), verifier: VERIFIER, device: DEVICE } });
    expect(ok.status).toBe(200);
    expect(ok.body?.token).toMatch(/^ons_/);
    // GitHub 上改了名，这里跟着变。
    expect(ok.body?.me).toMatchObject({ email: "lan@example.com", loginMethods: { password: false, github: "buglan-renamed" }, deviceId: DEVICE.deviceId });
  });

  it("没绑定、也不是组织策略：回到客户端说「不在用户里」；同邮箱的已有账号**不**自动绑定", async () => {
    const world = makeWorld();
    world.configure();
    seedAccount(world.accounts, { email: "someone@example.com" });
    world.users.set("gh2", { id: 7, login: "someone", email: "someone@example.com" });
    const back = new URL((await world.authorize(world.appStart, "gh2")).location);
    expect(back.searchParams.get("error")).toBe("not-invited");
    expect(back.searchParams.get("code")).toBeNull();
    expect(world.accounts.findByIdentity("github", "7")).toBeNull();
  });

  it("组织策略：组织成员自动建号；不在组织里的被拒", async () => {
    const world = makeWorld();
    world.configure({ githubPolicy: "org", githubOrgs: ["buglan-team"] });
    world.users.set("member", { id: 1, login: "mia", email: "mia@example.com", orgs: ["buglan-team"] });
    world.users.set("outsider", { id: 2, login: "eve", email: "eve@example.com", orgs: ["other"] });
    const member = new URL((await world.authorize(world.appStart, "member")).location);
    expect(member.searchParams.get("code")).toMatch(/^ghc_/);
    expect(world.accounts.findByEmail("mia@example.com")).not.toBeNull();
    const outsider = new URL((await world.authorize(world.appStart, "outsider")).location);
    expect(outsider.searchParams.get("error")).toBe("not-in-org");
    expect(world.accounts.findByEmail("eve@example.com")).toBeNull();
  });

  it("网页端回到同源首页（sync_ 前缀），GitHub 上点了取消也回来说清楚", async () => {
    const world = makeWorld();
    world.configure();
    const lan = seedAccount(world.accounts);
    world.accounts.linkIdentity({ accountId: lan.id, provider: "github", subject: "42", login: "buglan" });
    world.users.set("gh1", { id: 42, login: "buglan", email: null });
    const { location } = await world.authorize(`${world.appStart}&return=web`, "gh1");
    expect(location).toMatch(/^\/\?sync_code=ghc_.+&sync_github=buglan&sync_state=client-state-123456$/);

    const start = await world.call(`/auth/github?${world.appStart}`);
    const state = new URL(start.location!).searchParams.get("state");
    const denied = await world.call(`/auth/github/callback?error=access_denied&state=${state}`);
    expect(new URL(denied.location!).searchParams.get("error")).toBe("denied");
  });
});

describe("用 GitHub 接受邀请（mode=join）", () => {
  it("绑定邮箱的邀请：邀请邮箱是次要已验证邮箱也可接受，身份绑好，邀请用掉", async () => {
    const world = makeWorld();
    world.configure();
    const admin = seedAccount(world.accounts, { isAdmin: true });
    const { code } = world.accounts.createInvite({ createdBy: admin.id, email: "chen@example.com" });
    world.users.set("gh3", {
      id: 3,
      login: "chen-gh",
      email: null,
      verifiedEmails: [
        { email: "chen.personal@example.com", primary: true, verified: true },
        { email: "chen@example.com", primary: false, verified: true },
      ],
    });
    const { location } = await world.authorize(`mode=join&invite=${code}`, "gh3");
    expect(location).toBe("/auth/result?done=joined&email=chen%40example.com&github=chen-gh");
    const account = world.accounts.findByIdentity("github", "3");
    expect(account?.email).toBe("chen@example.com");
    expect(account?.password_hash).toBeNull();
    expect((await world.call(`/v1/auth/invites/${code}`)).status).toBe(410);
  });

  it("邀请邮箱与 GitHub 已验证邮箱不一致：拒绝，不建管理员、不消费邀请", async () => {
    const world = makeWorld();
    world.configure();
    const admin = seedAccount(world.accounts, { isAdmin: true });
    const { code } = world.accounts.createInvite({ createdBy: admin.id, email: "chen@example.com", grantAdmin: true });
    world.users.set("gh4", {
      id: 4,
      login: "attacker",
      email: null,
      verifiedEmails: [{ email: "attacker@example.com", primary: true, verified: true }],
    });
    const { location } = await world.authorize(`mode=join&invite=${code}`, "gh4");
    expect(new URL(location, "https://notes.example.com").searchParams.get("error")).toBe("invite-email-mismatch");
    expect(world.accounts.count()).toBe(1);
    expect(world.accounts.findByIdentity("github", "4")).toBeNull();
    expect(world.accounts.findByEmail("chen@example.com")).toBeNull();
    expect(world.accounts.inviteInfo(code).email).toBe("chen@example.com");
  });

  it("没有已验证邮箱：不建号、不消费邀请", async () => {
    const world = makeWorld();
    world.configure();
    const admin = seedAccount(world.accounts, { isAdmin: true });
    const { code } = world.accounts.createInvite({ createdBy: admin.id });
    world.users.set("gh6", {
      id: 6,
      login: "no-verified-email",
      email: null,
      verifiedEmails: [{ email: "unverified@example.com", primary: true, verified: false }],
    });
    const { location } = await world.authorize(`mode=join&invite=${code}`, "gh6");
    expect(new URL(location, "https://notes.example.com").searchParams.get("error")).toBe("bad-email");
    expect(world.accounts.count()).toBe(1);
    expect(world.accounts.findByIdentity("github", "6")).toBeNull();
    expect(world.accounts.inviteInfo(code).email).toBeNull();
  });

  it("邀请未绑定邮箱：用已验证主邮箱建号，忽略未验证邮箱", async () => {
    const world = makeWorld();
    world.configure();
    const admin = seedAccount(world.accounts, { isAdmin: true });
    const { code } = world.accounts.createInvite({ createdBy: admin.id });
    world.users.set("gh7", {
      id: 7,
      login: "primary-email",
      email: null,
      verifiedEmails: [
        { email: "secondary@example.com", primary: false, verified: true },
        { email: "unverified@example.com", primary: true, verified: false },
        { email: "primary@example.com", primary: true, verified: true },
      ],
    });
    const { location } = await world.authorize(`mode=join&invite=${code}`, "gh7");
    expect(location).toBe("/auth/result?done=joined&email=primary%40example.com&github=primary-email");
    expect(world.accounts.findByIdentity("github", "7")?.email).toBe("primary@example.com");
  });

  it("用过的邀请在起点就拦下", async () => {
    const world = makeWorld();
    world.configure();
    const start = await world.call("/auth/github?mode=join&invite=join_nope");
    expect(start.location).toMatch(/^\/auth\/result\?error=bad-invite/);

    const admin = seedAccount(world.accounts, { isAdmin: true });
    const used = world.accounts.createInvite({ createdBy: admin.id, email: "used@example.com" });
    world.users.set("gh8", { id: 8, login: "used", email: "used@example.com" });
    expect((await world.authorize(`mode=join&invite=${used.code}`, "gh8")).location).toMatch(/^\/auth\/result\?done=joined/);
    const replay = await world.call(`/auth/github?mode=join&invite=${used.code}`);
    expect(replay.location).toMatch(/^\/auth\/result\?error=invite-exhausted/);
  });
});

describe("控制台（mode=panel）", () => {
  it("管理员拿到 cookie 回到 /admin；普通账号被拒", async () => {
    const world = makeWorld();
    world.configure();
    const admin = seedAccount(world.accounts, { isAdmin: true });
    const member = seedAccount(world.accounts);
    world.accounts.linkIdentity({ accountId: admin.id, provider: "github", subject: "10", login: "boss" });
    world.accounts.linkIdentity({ accountId: member.id, provider: "github", subject: "11", login: "staff" });
    world.users.set("a", { id: 10, login: "boss", email: null });
    world.users.set("m", { id: 11, login: "staff", email: null });

    const ok = await world.authorize("mode=panel", "a");
    expect(ok.location).toBe("/admin");
    expect(ok.headers.get("set-cookie")).toMatch(/^opennote_panel=ons_.*HttpOnly/);
    const denied = await world.authorize("mode=panel", "m");
    expect(denied.location).toMatch(/^\/auth\/result\?error=forbidden/);
  });
});

describe("绑定与解绑（mode=link）", () => {
  it("已登录的客户端换票绑定；没有密码时自己解不了，管理员可以", async () => {
    const world = makeWorld();
    world.configure();
    const admin = seedAccount(world.accounts, { isAdmin: true });
    const lan = seedAccount(world.accounts);
    world.users.set("gh5", { id: 5, login: "lan-gh", email: null });

    const link = await world.call("/v1/me/github/link", { body: {}, headers: { authorization: `Bearer ${lan.token}` } });
    expect(link.status).toBe(200);
    const url = new URL(link.body!.url as string);
    expect(url.pathname).toBe("/auth/github");
    const { location } = await world.authorize(url.search.slice(1), "gh5");
    expect(location).toBe("/auth/result?done=linked&github=lan-gh");
    expect(world.accounts.findByIdentity("github", "5")?.id).toBe(lan.id);

    // 票只能用一次。
    expect((await world.call(`/auth/github${url.search}`)).location).toMatch(/error=bad-request/);

    const self = await world.call("/v1/me/github", { method: "DELETE", headers: { authorization: `Bearer ${lan.token}` } });
    expect(self.status).toBe(409);
    expect(self.body?.code).toBe("only-login-method");
    expect((await world.call(`/v1/admin/accounts/${lan.id}/github`, { method: "DELETE", headers: { authorization: `Bearer ${admin.token}` } })).status).toBe(204);
    expect(world.accounts.identityOf(lan.id, "github")).toBeNull();
  });

  it("同一个 GitHub 已经绑在别的账号上：拒绝", async () => {
    const world = makeWorld();
    world.configure();
    const a = seedAccount(world.accounts);
    const b = seedAccount(world.accounts);
    world.accounts.linkIdentity({ accountId: a.id, provider: "github", subject: "9", login: "x" });
    world.users.set("gh9", { id: 9, login: "x", email: null });
    const link = await world.call("/v1/me/github/link", { body: {}, headers: { authorization: `Bearer ${b.token}` } });
    const { location } = await world.authorize(new URL(link.body!.url as string).search.slice(1), "gh9");
    expect(location).toMatch(/^\/auth\/result\?error=identity-taken/);
  });
});
