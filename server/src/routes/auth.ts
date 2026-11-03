/**
 * 账号接口：初始化、登录 / 注册 / 登出、当前账号、我的设备、邀请、重置密码
 * （`docs/执行-同步重写-2026-11-02.md` 阶段 ①）。
 *
 * | 接口 | 谁调 | 鉴权 |
 * | --- | --- | --- |
 * | `POST /auth/setup` | `/admin` 初始化页 | 无（只在零账号时可用） |
 * | `POST /auth/login` · `POST /auth/register` | 客户端 | 无 |
 * | `POST /auth/logout` | 客户端 | 会话令牌 |
 * | `GET/POST /auth/invites/:code` | `/join` 页 | 无（码本身就是凭据；「关闭注册」时 403） |
 * | `GET/POST /auth/password-resets/:code` | `/reset` 页 | 无（同上） |
 * | `GET/PATCH /me` · `POST /me/password` · `GET/DELETE /me/devices` | 客户端 | 会话令牌 |
 *
 * 纪律：
 * 1. **登录错误不区分邮箱错还是密码错**，耗时也一致（见 `AccountStore.login`）。
 * 2. 同一邮箱连续失败 5 次锁 15 分钟（`LoginThrottle`），挡住在线爆破。
 * 3. 响应里只出现一次明文令牌（登录 / 注册的响应体），库里只有 sha256。
 */

import { Hono, type Context } from "hono";
import {
  encryptionUpdateRequestSchema,
  githubExchangeRequestSchema,
  inviteAcceptRequestSchema,
  inviteInfoSchema,
  loginRequestSchema,
  meSchema,
  meUpdateRequestSchema,
  passwordChangeRequestSchema,
  passwordResetRequestSchema,
  setupRequestSchema,
  type DeviceDescriptor,
  type DeviceInfo,
  type Me,
  type Quota,
} from "../../../shared/contract";
import { AccountError, accountLabel, type AccountRow, type AccountStore, type SessionRow } from "../auth/accounts";
import type { OAuthFlows } from "../auth/github";
import { clientIpFrom, type ServerConfig } from "../config";
import type { NotebookStore } from "../notebooks";
import type { SettingsStore } from "../settings";

export interface AuthRoutesDeps {
  accounts: AccountStore;
  notebooks: NotebookStore;
  config: ServerConfig;
  settings: SettingsStore;
  audit?: (event: { actorId: string | null; action: string; target?: string | null; ip?: string | null; detail?: string | null }) => void;
  /** 登录失败计数；与控制台登录共用一个（`app.ts` 装配时传入），不传就自己建一个。 */
  throttle?: LoginThrottle;
  /** GitHub 授权的一次性码与绑定票（与 `routes/github.ts` 共用）。不传 = 没有 GitHub 相关接口。 */
  oauth?: OAuthFlows;
  now?: () => number;
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

/** 账号的配额：账号自己设过就用自己的，否则跟随服务默认值。 */
export function quotaOf(
  deps: { notebooks: NotebookStore; config: ServerConfig; settings: SettingsStore },
  row: Pick<AccountRow, "id" | "quota_bytes">,
): Quota {
  const usage = deps.notebooks.quotaOf(row.id);
  return {
    bytesUsed: usage.bytesUsed,
    bytesLimit: row.quota_bytes ?? deps.settings.get("defaultQuotaBytes"),
    notebooks: usage.notebooks,
    notebooksLimit: deps.config.defaultAccountQuotaNotebooks,
  };
}

/** 账号能用哪些方式登录（`/me`、控制台账号摘要共用）。 */
export function loginMethodsOf(accounts: AccountStore, row: Pick<AccountRow, "id" | "password_hash">): { password: boolean; github: string | null } {
  const github = accounts.identityOf(row.id, "github");
  return { password: row.password_hash !== null, github: github ? (github.login ?? `#${github.subject}`) : null };
}

export function meOf(deps: { accounts: AccountStore; notebooks: NotebookStore; config: ServerConfig; settings: SettingsStore }, row: AccountRow, session: SessionRow | null): Me {
  return meSchema.parse({
    accountId: row.id,
    email: row.email,
    displayName: row.display_name,
    isAdmin: row.is_admin === 1,
    quota: quotaOf(deps, row),
    loginMethods: loginMethodsOf(deps.accounts, row),
    deviceId: session?.device_id ?? null,
  });
}

/**
 * 给一台设备发会话：登记设备（名字、系统、版本）、作废它旧的会话、发新令牌。
 * 密码登录、GitHub 登录、配对加入都走这一条。
 */
export function issueDeviceSession(
  deps: { accounts: AccountStore; notebooks: NotebookStore; config: ServerConfig; settings: SettingsStore },
  account: AccountRow,
  device: DeviceDescriptor,
  ip: string | null,
  now: number,
): { token: string; me: Me } {
  deps.notebooks.upsertDevice({
    deviceId: device.deviceId,
    accountId: account.id,
    name: device.name,
    platform: device.platform,
    os: device.os ?? null,
    clientVersion: device.clientVersion ?? null,
    now,
    ip,
  });
  // 同一台设备重新登录：旧会话作废，免得一台设备挂着好几条有效令牌。
  deps.accounts.revokeDeviceSessions(account.id, device.deviceId, now);
  const { token, session } = deps.accounts.createSession({ accountId: account.id, kind: "device", deviceId: device.deviceId, ip, now });
  deps.accounts.touch(account.id, now);
  return { token, me: meOf(deps, account, session) };
}

/** AccountError → HTTP。所有账号相关路由共用这一张表。 */
export function accountErrorResponse(error: AccountError): Response {
  const table: Record<AccountError["rejection"], [number, string]> = {
    "bad-email": [400, "bad-request"],
    "email-taken": [409, "email-taken"],
    "weak-password": [400, "weak-password"],
    "bad-credentials": [401, "bad-credentials"],
    "setup-done": [409, "setup-done"],
    "bad-invite": [404, "bad-invite"],
    "invite-revoked": [410, "invite-revoked"],
    "invite-expired": [410, "invite-expired"],
    "invite-exhausted": [410, "invite-exhausted"],
    "invite-email-mismatch": [400, "invite-email-mismatch"],
    "bad-reset": [404, "bad-reset"],
    "reset-used": [410, "reset-used"],
    "reset-expired": [410, "reset-expired"],
    unauthorized: [401, "unauthorized"],
    disabled: [403, "disabled"],
    "identity-taken": [409, "identity-taken"],
    "only-login-method": [409, "only-login-method"],
    "not-found": [404, "not-found"],
  };
  const [status, code] = table[error.rejection];
  return new Response(JSON.stringify({ error: error.message, code }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * 登录失败计数：同一邮箱 15 分钟内失败 5 次就锁到窗口结束。
 *
 * 只在内存里：服务重启会清零，这对「挡在线爆破」足够了（攻击者拿不到重启开关），
 * 也免得为一张临时表加迁移。按邮箱而不是按 IP 计，是因为爆破一个账号可以换 IP，换不了邮箱。
 */
export class LoginThrottle {
  private readonly failures = new Map<string, number[]>();
  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 15 * 60_000,
  ) {}

  private recent(key: string, now: number): number[] {
    const kept = (this.failures.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (kept.length === 0) this.failures.delete(key);
    else this.failures.set(key, kept);
    return kept;
  }

  /** 被锁时返回还要等多少秒，否则 null。 */
  lockedFor(key: string, now = Date.now()): number | null {
    const recent = this.recent(key, now);
    if (recent.length < this.maxFailures) return null;
    return Math.ceil((recent[0]! + this.windowMs - now) / 1000);
  }

  fail(key: string, now = Date.now()): void {
    this.failures.set(key, [...this.recent(key, now), now]);
  }

  succeed(key: string): void {
    this.failures.delete(key);
  }
}

export function createAuthRoutes(deps: AuthRoutesDeps): Hono {
  const routes = new Hono();
  const now = (): number => deps.now?.() ?? Date.now();
  const throttle = deps.throttle ?? new LoginThrottle();
  const json = (body: unknown, status: number): Response =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  const badRequest = (message: string): Response => json({ error: message, code: "bad-request" }, 400);

  const readBody = async <T>(c: Context, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: { message: string }[] } } }): Promise<T | Response> => {
    const raw = await c.req.json().catch(() => null);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "请求体形状不对");
    return parsed.data;
  };

  /** 会话鉴权（`/me*` 与 `logout` 用）。 */
  const authenticate = (c: Context): { account: AccountRow; session: SessionRow } | Response => {
    const token = bearerToken(c.req.header("authorization"));
    if (!token) return json({ error: "缺少 Authorization: Bearer 令牌", code: "unauthorized" }, 401);
    try {
      const result = deps.accounts.authenticateSession(token, now());
      deps.accounts.touch(result.account.id, now());
      return result;
    } catch (error) {
      if (error instanceof AccountError) return accountErrorResponse(error);
      throw error;
    }
  };

  /** 登录 / 注册成功后的共同收尾：登记设备、发设备会话。 */
  const openDeviceSession = (account: AccountRow, device: DeviceDescriptor, ip: string | null): Response =>
    json(issueDeviceSession(deps, account, device, ip, now()), 200);

  /** 只信配置里列出的代理头（`TRUSTED_PROXY_HEADERS`）；没配就不记 IP，不去猜。 */
  const ipOf = (c: Context): string | null => clientIpFrom(c.req.raw.headers, deps.config);

  /* -------------------------------------------------------------- 初始化 */

  routes.post("/auth/setup", async (c) => {
    const body = await readBody(c, setupRequestSchema);
    if (body instanceof Response) return body;
    try {
      const row = await deps.accounts.setup({ email: body.email, password: body.password, displayName: body.displayName ?? null, now: now() });
      deps.audit?.({ actorId: row.id, action: "setup_admin", target: row.id, ip: ipOf(c), detail: null });
      return json({ me: meOf(deps, row, null) }, 201);
    } catch (error) {
      if (error instanceof AccountError) return accountErrorResponse(error);
      throw error;
    }
  });

  /* ---------------------------------------------------------------- 登录 */

  routes.post("/auth/login", async (c) => {
    if (!deps.settings.get("passwordLogin")) {
      return json({ error: "这台服务器关闭了邮箱密码登录，请用其它方式登录", code: "password-login-disabled" }, 403);
    }
    const body = await readBody(c, loginRequestSchema);
    if (body instanceof Response) return body;
    const key = body.email.trim().toLowerCase();
    const locked = throttle.lockedFor(key, now());
    if (locked !== null) {
      return json({ error: `登录失败次数太多，请 ${Math.ceil(locked / 60)} 分钟后再试`, code: "locked", retryAfterSeconds: locked }, 429);
    }
    try {
      const account = await deps.accounts.login(body.email, body.password);
      throttle.succeed(key);
      deps.audit?.({ actorId: account.id, action: "login", target: body.device.deviceId, ip: ipOf(c), detail: body.device.name });
      return openDeviceSession(account, body.device, ipOf(c));
    } catch (error) {
      if (error instanceof AccountError) {
        if (error.rejection === "bad-credentials") {
          throttle.fail(key, now());
          if (throttle.lockedFor(key, now()) !== null) {
            deps.audit?.({ actorId: deps.accounts.findByEmail(key)?.id ?? null, action: "login_locked", target: key, ip: ipOf(c), detail: null });
          }
        }
        return accountErrorResponse(error);
      }
      throw error;
    }
  });

  /** 开放注册（服务设置里「谁可以注册 = 开放」时才可用）。 */
  routes.post("/auth/register", async (c) => {
    if (deps.settings.get("registration") !== "open") {
      return json({ error: "这台服务器只接受邀请注册", code: "registration-closed" }, 403);
    }
    const body = await readBody(c, loginRequestSchema.extend({ displayName: setupRequestSchema.shape.displayName }));
    if (body instanceof Response) return body;
    try {
      const account = await deps.accounts.create({ email: body.email, password: body.password, displayName: body.displayName ?? null, now: now() });
      deps.audit?.({ actorId: account.id, action: "register", target: account.id, ip: ipOf(c), detail: null });
      return openDeviceSession(account, body.device, ipOf(c));
    } catch (error) {
      if (error instanceof AccountError) return accountErrorResponse(error);
      throw error;
    }
  });

  routes.post("/auth/logout", (c) => {
    const auth = authenticate(c);
    if (auth instanceof Response) return auth;
    deps.accounts.revokeSession(auth.session.id, now());
    return json(null, 204);
  });

  /* ---------------------------------------------------------------- 邀请 */

  /** 「关闭注册」连邀请也不收：已有账号照常用，只是不能再新增。 */
  const registrationClosed = (): Response | null =>
    deps.settings.get("registration") === "closed"
      ? json({ error: "这台服务器暂时不接受新账号，请联系管理员", code: "registration-closed" }, 403)
      : null;

  routes.get("/auth/invites/:code", (c) => {
    const closed = registrationClosed();
    if (closed) return closed;
    try {
      const info = deps.accounts.inviteInfo(c.req.param("code"), now());
      return json(
        inviteInfoSchema.parse({
          email: info.email,
          grantAdmin: info.grantAdmin,
          quotaBytes: info.quotaBytes ?? deps.settings.get("defaultQuotaBytes"),
          expiresAt: info.expiresAt,
          invitedBy: info.invitedBy,
        }),
        200,
      );
    } catch (error) {
      if (error instanceof AccountError) return accountErrorResponse(error);
      throw error;
    }
  });

  routes.post("/auth/invites/:code", async (c) => {
    const closed = registrationClosed();
    if (closed) return closed;
    const body = await readBody(c, inviteAcceptRequestSchema);
    if (body instanceof Response) return body;
    try {
      const account = await deps.accounts.acceptInvite(c.req.param("code"), { email: body.email, password: body.password, displayName: body.displayName ?? null }, now());
      deps.audit?.({ actorId: account.id, action: "accept_invite", target: account.id, ip: ipOf(c), detail: accountLabel(account) });
      return json({ me: meOf(deps, account, null) }, 201);
    } catch (error) {
      if (error instanceof AccountError) return accountErrorResponse(error);
      throw error;
    }
  });

  /* ------------------------------------------------------------ 重置密码 */

  routes.get("/auth/password-resets/:code", (c) => {
    try {
      return json({ email: deps.accounts.passwordResetInfo(c.req.param("code"), now()).email }, 200);
    } catch (error) {
      if (error instanceof AccountError) return accountErrorResponse(error);
      throw error;
    }
  });

  routes.post("/auth/password-resets/:code", async (c) => {
    const body = await readBody(c, passwordResetRequestSchema);
    if (body instanceof Response) return body;
    try {
      const account = await deps.accounts.resetPassword(c.req.param("code"), body.password, now());
      deps.audit?.({ actorId: account.id, action: "reset_password", target: account.id, ip: ipOf(c), detail: null });
      return json(null, 204);
    } catch (error) {
      if (error instanceof AccountError) return accountErrorResponse(error);
      throw error;
    }
  });

  /* --------------------------------------------------------------- 加密口令 */

  /**
   * 账号级的「加密口令」包好的 encRoot（阶段 ④）。服务端只存不解：没有口令就没有 wrapKey。
   * 没设过 → `{ configured: false }`。
   */
  routes.get("/me/encryption", (c) => {
    const auth = authenticate(c);
    if (auth instanceof Response) return auth;
    const row = auth.account;
    if (!row.wrapped_enc_root || !row.enc_params) return json({ configured: false }, 200);
    return json({ configured: true, wrappedEncRoot: row.wrapped_enc_root, kdf: JSON.parse(row.enc_params) as unknown }, 200);
  });

  /**
   * 设置 / 改加密口令。改口令时 encRoot 不变，只是换一层包装 —— 所有已加密的笔记本不用重新加密。
   *
   * `expected` 是比较并交换：必须等于服务端当前那一份（第一次设置时是 null）。
   * 两台设备同时设口令时，后到的那台会拿到 409，而不是悄悄覆盖掉对方的 encRoot
   * （那会让先上传的加密笔记本再也解不开）。
   */
  routes.put("/me/encryption", async (c) => {
    const auth = authenticate(c);
    if (auth instanceof Response) return auth;
    const body = await readBody(c, encryptionUpdateRequestSchema);
    if (body instanceof Response) return body;
    const current = auth.account.wrapped_enc_root;
    if ((current ?? null) !== body.expected) {
      return json({ error: current ? "这个账号已经设过加密口令了（可能是另一台设备刚设的），请先用它解锁" : "加密口令已经被移除了，请刷新后重试", code: "conflict" }, 409);
    }
    deps.accounts.setEncryption(auth.account.id, body.wrappedEncRoot, JSON.stringify(body.kdf));
    deps.audit?.({ actorId: auth.account.id, action: current ? "change_passphrase" : "set_passphrase", target: auth.account.id, ip: ipOf(c), detail: null });
    return json({ configured: true, wrappedEncRoot: body.wrappedEncRoot, kdf: body.kdf }, 200);
  });

  /* --------------------------------------------------------------- GitHub */

  /**
   * 客户端拿 GitHub 回调发的一次性登录码 + 自己的 PKCE verifier 换设备会话。
   * 码只能用一次；verifier 对不上同样作废（不给第二次机会）。
   */
  routes.post("/auth/github/exchange", async (c) => {
    if (!deps.oauth) return json({ error: "这台服务器没有开启 GitHub 登录", code: "github-disabled" }, 403);
    const body = await readBody(c, githubExchangeRequestSchema);
    if (body instanceof Response) return body;
    const accountId = deps.oauth.redeemLoginCode(body.code, body.verifier, now());
    const account = accountId ? deps.accounts.findById(accountId) : null;
    if (!account) return json({ error: "GitHub 登录已过期，请重新登录", code: "bad-credentials" }, 401);
    if (account.status !== "active") return json({ error: "账号已被停用", code: "disabled" }, 403);
    deps.audit?.({ actorId: account.id, action: "login_github", target: body.device.deviceId, ip: ipOf(c), detail: body.device.name });
    return openDeviceSession(account, body.device, ipOf(c));
  });

  /** 已登录的客户端绑定 GitHub：拿一张一次性票，在浏览器里打开返回的地址。 */
  routes.post("/me/github/link", (c) => {
    const auth = authenticate(c);
    if (auth instanceof Response) return auth;
    if (!deps.oauth || !deps.settings.githubAvailable()) return json({ error: "这台服务器没有开启 GitHub 登录", code: "github-disabled" }, 403);
    const ticket = deps.oauth.issueLinkTicket(auth.account.id, now());
    return json({ url: `${deps.config.externalBaseUrl}/auth/github?mode=link&ticket=${encodeURIComponent(ticket)}` }, 200);
  });

  routes.delete("/me/github", (c) => {
    const auth = authenticate(c);
    if (auth instanceof Response) return auth;
    try {
      const removed = deps.accounts.unlinkIdentity(auth.account.id, "github", { requireOtherMethod: true });
      if (removed) deps.audit?.({ actorId: auth.account.id, action: "unlink_github", target: auth.account.id, ip: ipOf(c), detail: null });
      return json(meOf(deps, deps.accounts.findById(auth.account.id)!, auth.session), 200);
    } catch (error) {
      if (error instanceof AccountError) return accountErrorResponse(error);
      throw error;
    }
  });

  /* ---------------------------------------------------------------- 我 */

  routes.get("/me", (c) => {
    const auth = authenticate(c);
    if (auth instanceof Response) return auth;
    return json(meOf(deps, auth.account, auth.session), 200);
  });

  routes.patch("/me", async (c) => {
    const auth = authenticate(c);
    if (auth instanceof Response) return auth;
    const body = await readBody(c, meUpdateRequestSchema);
    if (body instanceof Response) return body;
    deps.accounts.setDisplayName(auth.account.id, body.displayName);
    return json(meOf(deps, deps.accounts.findById(auth.account.id)!, auth.session), 200);
  });

  /** 改密码：其它设备全部下线，当前这台保留。 */
  routes.post("/me/password", async (c) => {
    const auth = authenticate(c);
    if (auth instanceof Response) return auth;
    const body = await readBody(c, passwordChangeRequestSchema);
    if (body instanceof Response) return body;
    try {
      await deps.accounts.changePassword(auth.account.id, body.currentPassword, body.newPassword, { keepSessionId: auth.session.id });
      deps.audit?.({ actorId: auth.account.id, action: "change_password", target: auth.account.id, ip: ipOf(c), detail: null });
      return json(null, 204);
    } catch (error) {
      if (error instanceof AccountError) return accountErrorResponse(error);
      throw error;
    }
  });

  routes.get("/me/devices", (c) => {
    const auth = authenticate(c);
    if (auth instanceof Response) return auth;
    const active = deps.accounts.activeDeviceIds(auth.account.id, now());
    const devices: DeviceInfo[] = deps.notebooks.listDevices(auth.account.id).map((row) => ({
      deviceId: row.deviceId,
      name: row.name,
      platform: row.platform === "desktop" || row.platform === "android" || row.platform === "web" ? row.platform : null,
      os: (["macos", "windows", "linux", "android", "ios", "other"] as const).find((os) => os === row.os) ?? null,
      clientVersion: row.clientVersion,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      current: row.deviceId === auth.session.device_id,
      active: row.revokedAt === null && active.has(row.deviceId),
    }));
    return json({ devices }, 200);
  });

  /** 移除设备：吊销它的会话。它下次联网会收到 401，客户端显示「需要重新登录」。 */
  routes.delete("/me/devices/:id", (c) => {
    const auth = authenticate(c);
    if (auth instanceof Response) return auth;
    const deviceId = c.req.param("id");
    if (deviceId === auth.session.device_id) return badRequest("不能在这台设备上移除它自己，请用「退出登录」");
    const known = deps.notebooks.markDeviceRevoked(auth.account.id, deviceId, now());
    if (!known) return json({ error: "没有这台设备", code: "not-found" }, 404);
    deps.accounts.revokeDeviceSessions(auth.account.id, deviceId, now());
    deps.audit?.({ actorId: auth.account.id, action: "remove_device", target: deviceId, ip: ipOf(c), detail: null });
    return json(null, 204);
  });

  return routes;
}
