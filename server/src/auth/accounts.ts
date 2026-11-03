/**
 * 账号、会话、邀请与重置密码（`docs/执行-同步重写-2026-11-02.md`「身份模型」）。
 *
 * ## 账号 ≠ 凭据
 *
 * 「密钥即身份」时代令牌本身就是账号；现在账号是「邮箱 + 密码」（或 GitHub，下一阶段），
 * 登录后每台设备 / 每次控制台登录各拿一个**会话令牌**：
 *
 * ```
 * Authorization: Bearer ons_<43 字符>
 *   → h = sha256(令牌)
 *   → SELECT … FROM sessions JOIN accounts WHERE token_hash = h
 *   → 无行 / 已吊销 / 已过期 → 401；账号停用 → 403
 * ```
 *
 * 令牌是 256 位随机数，库里只存它的 sha256 —— 拖库拿不到可用令牌，索引查找也不泄露信息。
 * 移除设备 = 吊销该设备的会话；改密码 / 重置密码 = 吊销这个账号的全部会话。
 *
 * ## 一次性码
 *
 * 邀请（`join_…`）、重置密码（`reset_…`）、笔记本共享（`nb_…`）都是 192 位随机码，
 * 明文只在生成时返回一次，库里存 sha256。
 *
 * ## 服务端仍然没有加解密能力
 *
 * `wrapped_enc_root` 是客户端用「加密口令」包好的密文，这里只存不解（红线 3）。
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { hashPassword, passwordProblem, verifyPassword } from "./passwords";

/** 会话令牌 / 一次性码的哈希。**唯一产地** —— 别处不许再写一遍。 */
export function hashToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 一次性码与令牌用的是同一个哈希；分开命名只为读代码时知道手里是什么。 */
export const hashCode = hashToken;

/**
 * 生成一次性码：`<prefix>_<48 位十六进制>`。
 *
 * 前缀让运维一眼分清是什么码（`join_` 邀请 / `reset_` 重置密码 / `nb_` 笔记本共享）。
 */
export function generateCode(prefix: "join" | "reset" | "nb", bytes = 24): string {
  return `${prefix}_${randomBytes(bytes).toString("hex")}`;
}

/** 会话令牌：`ons_` + 32 字节 base64url。 */
export function newSessionToken(): string {
  return `ons_${randomBytes(32).toString("base64url")}`;
}

export function newAccountId(): string {
  return randomBytes(16).toString("hex");
}

export function newNotebookId(): string {
  return randomUUID();
}

/** 邮箱规范化：去空白、转小写。唯一约束本身也是 NOCASE，这里只是让存进去的样子一致。 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** 够用就好的形状检查（真正的校验是「邀请链接发到了这个人手里」）。 */
export function isPlausibleEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export type AccountStatus = "active" | "disabled";
export type SessionKind = "device" | "panel";

export interface AccountRow {
  id: string;
  email: string | null;
  display_name: string | null;
  password_hash: string | null;
  is_admin: number;
  status: string;
  quota_bytes: number | null;
  wrapped_enc_root: string | null;
  enc_params: string | null;
  created_at: number;
  last_seen_at: number | null;
}

export interface SessionRow {
  id: string;
  account_id: string;
  token_hash: string;
  kind: string;
  device_id: string | null;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  ip: string | null;
}

export type AccountRejection =
  | "bad-email"
  | "email-taken"
  | "weak-password"
  | "bad-credentials"
  | "setup-done"
  | "bad-invite"
  | "invite-revoked"
  | "invite-expired"
  | "invite-exhausted"
  | "invite-email-mismatch"
  | "bad-reset"
  | "reset-used"
  | "reset-expired"
  | "unauthorized"
  | "disabled"
  | "identity-taken"
  | "only-login-method"
  | "not-found";

export class AccountError extends Error {
  constructor(
    readonly rejection: AccountRejection,
    message: string,
  ) {
    super(message);
    this.name = "AccountError";
  }
}

/** 控制台会话的寿命。设备会话不过期（靠吊销）。 */
export const PANEL_SESSION_TTL_MS = 8 * 3600_000;
/** 重置密码链接的寿命。 */
export const PASSWORD_RESET_TTL_MS = 24 * 3600_000;

export interface InviteRow {
  code_hash: string;
  created_by: string | null;
  created_at: number;
  expires_at: number | null;
  max_uses: number;
  uses: number;
  revoked_at: number | null;
  email: string | null;
  grant_admin: number;
  quota_bytes: number | null;
  accepted_by: string | null;
}

export interface IdentityRow {
  provider: string;
  subject: string;
  account_id: string;
  login: string | null;
  created_at: number;
  last_used_at: number | null;
}

export interface AccountStoreOptions {
  /** 测试注入低成本 scrypt 参数（见 `FAST_PARAMS_FOR_TESTS`）。 */
  passwordParams?: { N: number; r: number; p: number };
}

/**
 * 没有这个邮箱时也要跑一次 scrypt，让「邮箱不存在」与「密码错」耗时一致，
 * 不让人用响应时间探测哪些邮箱注册过。
 */
let dummyHash: Promise<string> | null = null;

export class AccountStore {
  constructor(
    /** 公开只为测试夹具能直接种行（`testAccounts.test-helper.ts`）；生产代码只走方法。 */
    readonly db: DatabaseSync,
    private readonly options: AccountStoreOptions = {},
  ) {}

  /* ---------------------------------------------------------------- 查询 */

  findById(accountId: string): AccountRow | null {
    return (this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as AccountRow | undefined) ?? null;
  }

  findByEmail(email: string): AccountRow | null {
    return (this.db.prepare("SELECT * FROM accounts WHERE email = ?").get(normalizeEmail(email)) as AccountRow | undefined) ?? null;
  }

  list(): AccountRow[] {
    return this.db.prepare("SELECT * FROM accounts ORDER BY created_at ASC").all() as unknown as AccountRow[];
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n;
  }

  /** 零账号 = 还没初始化：`/admin` 显示初始化表单，`POST /v1/auth/setup` 可用。 */
  needsSetup(): boolean {
    return this.count() === 0;
  }

  touch(accountId: string, now = Date.now()): void {
    this.db.prepare("UPDATE accounts SET last_seen_at = ? WHERE id = ?").run(now, accountId);
  }

  /* ---------------------------------------------------------------- 建号 */

  private async hash(password: string): Promise<string> {
    const problem = passwordProblem(password);
    if (problem) throw new AccountError("weak-password", problem);
    return hashPassword(password, this.options.passwordParams);
  }

  private checkEmail(email: string): string {
    const normalized = normalizeEmail(email);
    if (!isPlausibleEmail(normalized)) throw new AccountError("bad-email", "邮箱格式不对");
    if (this.findByEmail(normalized)) throw new AccountError("email-taken", "这个邮箱已经注册过了");
    return normalized;
  }

  /** 在调用方的事务里插一行账号（不开事务、不哈希，只写）。 */
  private insertAccount(input: { email: string; passwordHash: string | null; displayName: string | null; isAdmin: boolean; quotaBytes: number | null; now: number }): string {
    const id = newAccountId();
    this.db
      .prepare(
        `INSERT INTO accounts (id, email, display_name, password_hash, is_admin, status, quota_bytes, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL)`,
      )
      .run(id, input.email, input.displayName, input.passwordHash, input.isAdmin ? 1 : 0, input.quotaBytes, input.now);
    this.db.prepare("INSERT INTO quota_usage (account_id, bytes_used, notebooks, updated_at) VALUES (?, 0, 0, ?)").run(id, input.now);
    return id;
  }

  /** 直接建号（CLI `create-admin` 与测试用；正常用户走邀请）。 */
  async create(input: {
    email: string;
    password?: string | null;
    displayName?: string | null;
    isAdmin?: boolean;
    quotaBytes?: number | null;
    now?: number;
  }): Promise<AccountRow> {
    const email = this.checkEmail(input.email);
    const passwordHash = input.password ? await this.hash(input.password) : null;
    const id = this.transaction(() =>
      this.insertAccount({
        email: this.checkEmail(email),
        passwordHash,
        displayName: input.displayName?.trim() || null,
        isAdmin: input.isAdmin ?? false,
        quotaBytes: input.quotaBytes ?? null,
        now: input.now ?? Date.now(),
      }),
    );
    return this.findById(id)!;
  }

  /** 初始化：只在零账号时可用，建出来的是管理员。并发两次只会成功一次（事务内复查）。 */
  async setup(input: { email: string; password: string; displayName?: string | null; now?: number }): Promise<AccountRow> {
    if (!this.needsSetup()) throw new AccountError("setup-done", "这台服务器已经初始化过了");
    const email = this.checkEmail(input.email);
    const passwordHash = await this.hash(input.password);
    const id = this.transaction(() => {
      if (!this.needsSetup()) throw new AccountError("setup-done", "这台服务器已经初始化过了");
      return this.insertAccount({ email, passwordHash, displayName: input.displayName?.trim() || null, isAdmin: true, quotaBytes: null, now: input.now ?? Date.now() });
    });
    return this.findById(id)!;
  }

  /* ---------------------------------------------------------------- 登录 */

  /** 邮箱 + 密码。错误一律是「邮箱或密码不对」，不区分哪一个错。 */
  async login(email: string, password: string): Promise<AccountRow> {
    const row = this.findByEmail(email);
    if (!row || !row.password_hash) {
      dummyHash ??= hashPassword("opennote-dummy-password", this.options.passwordParams);
      await verifyPassword(password, await dummyHash);
      throw new AccountError("bad-credentials", "邮箱或密码不对");
    }
    if (!(await verifyPassword(password, row.password_hash))) throw new AccountError("bad-credentials", "邮箱或密码不对");
    if (row.status !== "active") throw new AccountError("disabled", "账号已被停用");
    return row;
  }

  createSession(input: { accountId: string; kind: SessionKind; deviceId?: string | null; ttlMs?: number | null; ip?: string | null; now?: number }): {
    token: string;
    session: SessionRow;
  } {
    const now = input.now ?? Date.now();
    const token = newSessionToken();
    const id = randomUUID();
    const ttl = input.ttlMs === undefined ? (input.kind === "panel" ? PANEL_SESSION_TTL_MS : null) : input.ttlMs;
    this.db
      .prepare(
        `INSERT INTO sessions (id, account_id, token_hash, kind, device_id, created_at, last_used_at, expires_at, revoked_at, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(id, input.accountId, hashToken(token), input.kind, input.deviceId ?? null, now, now, ttl === null ? null : now + ttl, input.ip ?? null);
    return { token, session: this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as unknown as SessionRow };
  }

  /** 令牌 → 会话 + 账号。路由层的唯一鉴权入口。 */
  authenticateSession(token: string, now = Date.now()): { account: AccountRow; session: SessionRow } {
    const session = this.db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(hashToken(token)) as SessionRow | undefined;
    if (!session || session.revoked_at !== null || (session.expires_at !== null && now > session.expires_at)) {
      throw new AccountError("unauthorized", "登录已失效，请重新登录");
    }
    const account = this.findById(session.account_id);
    if (!account) throw new AccountError("unauthorized", "登录已失效，请重新登录");
    if (account.status !== "active") throw new AccountError("disabled", "账号已被停用");
    // 每分钟最多写一次，免得每个同步请求都写库。
    if (session.last_used_at === null || now - session.last_used_at > 60_000) {
      this.db.prepare("UPDATE sessions SET last_used_at = ? WHERE id = ?").run(now, session.id);
    }
    return { account, session };
  }

  /** 只要账号的调用点（绝大多数路由）用这个。 */
  authenticate(token: string): AccountRow {
    return this.authenticateSession(token).account;
  }

  revokeSession(sessionId: string, now = Date.now()): boolean {
    const result = this.db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, sessionId);
    return Number(result.changes ?? 0) > 0;
  }

  /** 移除设备：吊销它的所有会话。返回吊销了几条。 */
  revokeDeviceSessions(accountId: string, deviceId: string, now = Date.now()): number {
    const result = this.db
      .prepare("UPDATE sessions SET revoked_at = ? WHERE account_id = ? AND device_id = ? AND revoked_at IS NULL")
      .run(now, accountId, deviceId);
    return Number(result.changes ?? 0);
  }

  /** 改密码 / 重置密码 / 停用账号时用：除了 `exceptSessionId`（当前这台）以外全部吊销。 */
  revokeAllSessions(accountId: string, options: { exceptSessionId?: string; now?: number } = {}): number {
    const now = options.now ?? Date.now();
    const result = options.exceptSessionId
      ? this.db.prepare("UPDATE sessions SET revoked_at = ? WHERE account_id = ? AND id != ? AND revoked_at IS NULL").run(now, accountId, options.exceptSessionId)
      : this.db.prepare("UPDATE sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL").run(now, accountId);
    return Number(result.changes ?? 0);
  }

  /** 某台设备是否还有有效会话（设备列表据此显示「已移除」）。 */
  activeDeviceIds(accountId: string, now = Date.now()): Set<string> {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT device_id FROM sessions WHERE account_id = ? AND device_id IS NOT NULL AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
      )
      .all(accountId, now) as unknown as { device_id: string }[];
    return new Set(rows.map((row) => row.device_id));
  }

  /* ---------------------------------------------------------------- 密码 */

  async changePassword(accountId: string, current: string, next: string, options: { keepSessionId?: string } = {}): Promise<void> {
    const row = this.findById(accountId);
    if (!row) throw new AccountError("not-found", "账号不存在");
    if (row.password_hash && !(await verifyPassword(current, row.password_hash))) {
      throw new AccountError("bad-credentials", "当前密码不对");
    }
    await this.setPassword(accountId, next, options.keepSessionId === undefined ? {} : { keepSessionId: options.keepSessionId });
  }

  async setPassword(accountId: string, next: string, options: { keepSessionId?: string } = {}): Promise<void> {
    const passwordHash = await this.hash(next);
    this.transaction(() => {
      const result = this.db.prepare("UPDATE accounts SET password_hash = ? WHERE id = ?").run(passwordHash, accountId);
      if (Number(result.changes ?? 0) === 0) throw new AccountError("not-found", "账号不存在");
      this.revokeAllSessions(accountId, options.keepSessionId === undefined ? {} : { exceptSessionId: options.keepSessionId });
    });
  }

  createPasswordReset(input: { accountId: string; createdBy: string | null; ttlMs?: number; now?: number }): { code: string; expiresAt: number } {
    if (!this.findById(input.accountId)) throw new AccountError("not-found", "账号不存在");
    const now = input.now ?? Date.now();
    const expiresAt = now + (input.ttlMs ?? PASSWORD_RESET_TTL_MS);
    const code = generateCode("reset");
    this.db
      .prepare("INSERT INTO password_resets (code_hash, account_id, created_by, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, NULL)")
      .run(hashCode(code), input.accountId, input.createdBy, now, expiresAt);
    return { code, expiresAt };
  }

  /** 重置链接对应谁（页面上显示「为 xx 设置新密码」）。 */
  passwordResetInfo(code: string, now = Date.now()): { accountId: string; email: string | null } {
    const row = this.db.prepare("SELECT * FROM password_resets WHERE code_hash = ?").get(hashCode(code)) as
      | { account_id: string; expires_at: number; used_at: number | null }
      | undefined;
    if (!row) throw new AccountError("bad-reset", "链接无效");
    if (row.used_at !== null) throw new AccountError("reset-used", "这个链接已经用过了");
    if (now > row.expires_at) throw new AccountError("reset-expired", "链接已过期，请找管理员重新发一个");
    return { accountId: row.account_id, email: this.findById(row.account_id)?.email ?? null };
  }

  async resetPassword(code: string, next: string, now = Date.now()): Promise<AccountRow> {
    const { accountId } = this.passwordResetInfo(code, now);
    const passwordHash = await this.hash(next);
    this.transaction(() => {
      // 事务内复查一次：两个标签页同时提交，只有一个成功。
      this.passwordResetInfo(code, now);
      this.db.prepare("UPDATE password_resets SET used_at = ? WHERE code_hash = ?").run(now, hashCode(code));
      this.db.prepare("UPDATE accounts SET password_hash = ? WHERE id = ?").run(passwordHash, accountId);
      this.revokeAllSessions(accountId, { now });
    });
    return this.findById(accountId)!;
  }

  /* ---------------------------------------------------------------- 邀请 */

  createInvite(input: {
    createdBy: string | null;
    email?: string | null;
    grantAdmin?: boolean;
    quotaBytes?: number | null;
    expiresInSeconds?: number | null;
    maxUses?: number;
    now?: number;
  }): { code: string; expiresAt: number | null; maxUses: number } {
    const now = input.now ?? Date.now();
    const email = input.email ? normalizeEmail(input.email) : null;
    if (email !== null && !isPlausibleEmail(email)) throw new AccountError("bad-email", "邮箱格式不对");
    // 绑定了邮箱的邀请天然只能用一次。
    const maxUses = email !== null ? 1 : (input.maxUses ?? 1);
    const expiresAt = input.expiresInSeconds ? now + input.expiresInSeconds * 1000 : null;
    const code = generateCode("join");
    this.db
      .prepare(
        `INSERT INTO invites (code_hash, created_by, created_at, expires_at, max_uses, uses, revoked_at, email, grant_admin, quota_bytes, accepted_by)
         VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, NULL)`,
      )
      .run(hashCode(code), input.createdBy, now, expiresAt, maxUses, email, input.grantAdmin ? 1 : 0, input.quotaBytes ?? null);
    return { code, expiresAt, maxUses };
  }

  private usableInvite(code: string, now: number): InviteRow {
    const row = this.db.prepare("SELECT * FROM invites WHERE code_hash = ?").get(hashCode(code)) as InviteRow | undefined;
    if (!row) throw new AccountError("bad-invite", "邀请链接无效");
    if (row.revoked_at !== null) throw new AccountError("invite-revoked", "邀请已被作废");
    if (row.expires_at !== null && now > row.expires_at) throw new AccountError("invite-expired", "邀请已过期，请找管理员重新发一个");
    if (row.uses >= row.max_uses) throw new AccountError("invite-exhausted", "邀请已经被用掉了");
    return row;
  }

  /** `/join` 页面要显示的内容：发给谁、是什么角色、谁发的。 */
  inviteInfo(code: string, now = Date.now()): { email: string | null; grantAdmin: boolean; quotaBytes: number | null; expiresAt: number | null; invitedBy: string | null } {
    const row = this.usableInvite(code, now);
    const creator = row.created_by ? this.findById(row.created_by) : null;
    return {
      email: row.email,
      grantAdmin: row.grant_admin === 1,
      quotaBytes: row.quota_bytes,
      expiresAt: row.expires_at,
      invitedBy: creator ? accountLabel(creator) : null,
    };
  }

  /** 接受邀请：建号 + 记一次使用，同一事务。 */
  async acceptInvite(code: string, input: { email: string; password: string; displayName?: string | null }, now = Date.now()): Promise<AccountRow> {
    const invite = this.usableInvite(code, now);
    const email = normalizeEmail(input.email);
    if (invite.email !== null && invite.email !== email) {
      throw new AccountError("invite-email-mismatch", "这个邀请是发给另一个邮箱的");
    }
    this.checkEmail(email);
    const passwordHash = await this.hash(input.password);
    const id = this.transaction(() => {
      const fresh = this.usableInvite(code, now);
      const accountId = this.insertAccount({
        email: this.checkEmail(email),
        passwordHash,
        displayName: input.displayName?.trim() || null,
        isAdmin: fresh.grant_admin === 1,
        quotaBytes: fresh.quota_bytes,
        now,
      });
      this.db.prepare("UPDATE invites SET uses = uses + 1, accepted_by = ? WHERE code_hash = ?").run(accountId, fresh.code_hash);
      return accountId;
    });
    return this.findById(id)!;
  }

  /**
   * 延长邀请（控制台只有哈希：明文码生成后就没了）。已作废、已用完的不延长。
   * 新的到期时间从「现在」和「原到期时间」里较晚的那个往后算，所以没过期的邀请不会被缩短。
   */
  extendInviteByHash(codeHash: string, extraSeconds: number, now = Date.now()): number | null {
    const row = this.db.prepare("SELECT * FROM invites WHERE code_hash = ?").get(codeHash) as InviteRow | undefined;
    if (!row || row.revoked_at !== null || row.uses >= row.max_uses) return null;
    const expiresAt = Math.max(now, row.expires_at ?? now) + extraSeconds * 1000;
    this.db.prepare("UPDATE invites SET expires_at = ? WHERE code_hash = ?").run(expiresAt, codeHash);
    return expiresAt;
  }

  revokeInvite(code: string, now = Date.now()): boolean {
    const result = this.db.prepare("UPDATE invites SET revoked_at = ? WHERE code_hash = ? AND revoked_at IS NULL").run(now, hashCode(code));
    return Number(result.changes ?? 0) > 0;
  }

  /* ---------------------------------------------------------- 加密口令 */

  /** 写入客户端包好的 encRoot 与 KDF 参数（服务端解不开，见模块头）。 */
  setEncryption(accountId: string, wrappedEncRoot: string, encParams: string): void {
    this.db.prepare("UPDATE accounts SET wrapped_enc_root = ?, enc_params = ? WHERE id = ?").run(wrappedEncRoot, encParams, accountId);
  }

  /* ---------------------------------------------------------- 第三方身份 */

  identityOf(accountId: string, provider: "github"): IdentityRow | null {
    return (this.db.prepare("SELECT * FROM identities WHERE account_id = ? AND provider = ?").get(accountId, provider) as IdentityRow | undefined) ?? null;
  }

  findByIdentity(provider: "github", subject: string): AccountRow | null {
    const row = this.db.prepare("SELECT account_id FROM identities WHERE provider = ? AND subject = ?").get(provider, subject) as { account_id: string } | undefined;
    return row ? this.findById(row.account_id) : null;
  }

  /** 绑定（已经绑在别的账号上 → `identity-taken`；这个账号已绑了另一个 → 换成新的）。 */
  linkIdentity(input: { accountId: string; provider: "github"; subject: string; login: string | null; now?: number }): void {
    const now = input.now ?? Date.now();
    this.transaction(() => {
      const owner = this.db.prepare("SELECT account_id FROM identities WHERE provider = ? AND subject = ?").get(input.provider, input.subject) as { account_id: string } | undefined;
      if (owner && owner.account_id !== input.accountId) throw new AccountError("identity-taken", "这个 GitHub 账号已经绑定了另一个账号");
      this.db.prepare("DELETE FROM identities WHERE account_id = ? AND provider = ?").run(input.accountId, input.provider);
      this.db
        .prepare("INSERT INTO identities (provider, subject, account_id, login, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(input.provider, input.subject, input.accountId, input.login, now, now);
    });
  }

  /** 用这个身份登录了一次：刷新 login（GitHub 上改名了也跟上）与最近使用时间。 */
  touchIdentity(provider: "github", subject: string, login: string | null, now = Date.now()): void {
    this.db.prepare("UPDATE identities SET login = ?, last_used_at = ? WHERE provider = ? AND subject = ?").run(login, now, provider, subject);
  }

  /**
   * 解绑。`requireOtherMethod`：账号没有密码时不许解（那是它唯一的登录方式）。
   * 返回 false = 本来就没绑。
   */
  unlinkIdentity(accountId: string, provider: "github", options: { requireOtherMethod: boolean }): boolean {
    const account = this.findById(accountId);
    if (!account) throw new AccountError("not-found", "账号不存在");
    if (options.requireOtherMethod && account.password_hash === null && this.identityOf(accountId, provider)) {
      throw new AccountError("only-login-method", "这是这个账号唯一的登录方式，先设一个密码再解绑");
    }
    const result = this.db.prepare("DELETE FROM identities WHERE account_id = ? AND provider = ?").run(accountId, provider);
    return Number(result.changes ?? 0) > 0;
  }

  /** 用第三方身份新建账号（GitHub 组织成员自动加入时用）：没有密码。 */
  createWithIdentity(input: { email: string; displayName: string | null; provider: "github"; subject: string; login: string | null; quotaBytes?: number | null; now?: number }): AccountRow {
    const now = input.now ?? Date.now();
    const id = this.transaction(() => {
      const accountId = this.insertAccount({ email: this.checkEmail(input.email), passwordHash: null, displayName: input.displayName?.trim() || null, isAdmin: false, quotaBytes: input.quotaBytes ?? null, now });
      this.db
        .prepare("INSERT INTO identities (provider, subject, account_id, login, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(input.provider, input.subject, accountId, input.login, now, now);
      return accountId;
    });
    return this.findById(id)!;
  }

  /**
   * 用 GitHub 接受邀请：建号（没有密码）+ 绑身份 + 记一次使用，同一事务。
   * 邮箱：邀请绑了邮箱就用邀请的，否则用 GitHub 上已验证的那个。
   */
  acceptInviteWithIdentity(
    code: string,
    input: { githubEmail: string | null; displayName: string | null; provider: "github"; subject: string; login: string | null },
    now = Date.now(),
  ): AccountRow {
    const id = this.transaction(() => {
      const invite = this.usableInvite(code, now);
      const email = invite.email ?? input.githubEmail;
      if (!email) throw new AccountError("bad-email", "GitHub 上没有已验证的邮箱，请改用「设置一个密码」接受邀请");
      const taken = this.db.prepare("SELECT account_id FROM identities WHERE provider = ? AND subject = ?").get(input.provider, input.subject) as { account_id: string } | undefined;
      if (taken) throw new AccountError("identity-taken", "这个 GitHub 账号已经绑定了另一个账号，直接用它登录即可");
      const accountId = this.insertAccount({
        email: this.checkEmail(email),
        passwordHash: null,
        displayName: input.displayName?.trim() || null,
        isAdmin: invite.grant_admin === 1,
        quotaBytes: invite.quota_bytes,
        now,
      });
      this.db
        .prepare("INSERT INTO identities (provider, subject, account_id, login, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(input.provider, input.subject, accountId, input.login, now, now);
      this.db.prepare("UPDATE invites SET uses = uses + 1, accepted_by = ? WHERE code_hash = ?").run(accountId, invite.code_hash);
      return accountId;
    });
    return this.findById(id)!;
  }

  /* ------------------------------------------------------ 管理员能改的字段 */

  setStatus(accountId: string, status: AccountStatus): boolean {
    // 不吊销会话：停用后每个请求都回 403 `disabled`（客户端据此说「账号已被停用」而不是「请重新登录」），
    // 重新启用就立刻恢复，不用每台设备再登录一遍。
    const result = this.db.prepare("UPDATE accounts SET status = ? WHERE id = ?").run(status, accountId);
    return Number(result.changes ?? 0) > 0;
  }

  setDisplayName(accountId: string, displayName: string | null): boolean {
    const result = this.db.prepare("UPDATE accounts SET display_name = ? WHERE id = ?").run(displayName?.trim() || null, accountId);
    return Number(result.changes ?? 0) > 0;
  }

  /** `null` = 跟随服务默认配额。 */
  setQuota(accountId: string, quotaBytes: number | null): boolean {
    const result = this.db.prepare("UPDATE accounts SET quota_bytes = ? WHERE id = ?").run(quotaBytes, accountId);
    return Number(result.changes ?? 0) > 0;
  }

  countAdmins(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE is_admin = 1 AND status = 'active'").get() as { n: number }).n;
  }

  setAdmin(accountId: string, isAdmin: boolean): { ok: true; changed: boolean } | { ok: false; reason: "not-found" | "last-admin" } {
    const row = this.findById(accountId);
    if (!row) return { ok: false, reason: "not-found" };
    const currently = row.is_admin === 1;
    if (currently === isAdmin) return { ok: true, changed: false };
    // 不允许取消最后一个活跃管理员 —— 那会让控制台永久进不去。
    if (!isAdmin && row.status === "active" && this.countAdmins() <= 1) return { ok: false, reason: "last-admin" };
    this.db.prepare("UPDATE accounts SET is_admin = ? WHERE id = ?").run(isAdmin ? 1 : 0, accountId);
    return { ok: true, changed: true };
  }

  delete(accountId: string): boolean {
    return this.transaction(() => {
      this.db.prepare("DELETE FROM quota_usage WHERE account_id = ?").run(accountId);
      const result = this.db.prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
      return Number(result.changes ?? 0) > 0;
    });
  }

  /* ---------------------------------------------------------------- 工具 */

  private transaction<T>(body: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

/** 给人看的名字：显示名 → 邮箱 → 截断的 id。 */
export function accountLabel(row: Pick<AccountRow, "id" | "display_name" | "email">): string {
  return row.display_name || row.email || `账号 ${row.id.slice(0, 8)}`;
}
