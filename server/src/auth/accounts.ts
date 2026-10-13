/**
 * **密钥即身份**：账号的建立、认证、轮换（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §1.5、§4.3、§4.4）。
 *
 * ## 这个文件里最要紧的一件事
 *
 * > **服务端从不生成、也从不持有任何密钥材料。**
 * >
 * > 客户端生成 `accountKey` / `encRoot`，派生出 `authToken`（发给我们）与 `wrapKey`（永不外发），
 * > 并把 `encRoot` 用 `wrapKey` 包成 `wrappedEncRoot` 一起送上来。我们只存：
 * >   - `auth_hash = sha256(authToken)`
 * >   - `wrapped_enc_root`（**服务端解不开**，因为没有 `wrapKey`）
 * >
 * > 这条一破，E2EE 就是假的（红线 3）。所以本文件**没有**任何 `encrypt` / `decrypt` /
 * > `deriveKey`，`server/` 里也不允许出现 `@noble/*`（`scripts/check-boundaries.mjs` 的 B3/B4 会拦）。
 *
 * ## 为什么不需要 Argon2id / 慢 KDF
 *
 * 慢 KDF 的唯一目的是对抗**低熵输入**（人类口令）。`authToken` 是 256 位 CSPRNG 的派生值，
 * `sha256(authToken)` **无法离线爆破** ⇒ `wrappedEncRoot` 安全 ⇒ HKDF 就够了。
 * 这直接砍掉一个依赖（§1.5「为什么不需要 Argon2id」）。
 *
 * ## 认证链路只有一条（§4.4）
 *
 * ```
 * Authorization: Bearer <authToken>
 *   → h = sha256(authToken)
 *   → SELECT ... FROM accounts WHERE auth_hash = h     （走唯一索引）
 *   → 无行 → 401；status != 'active' → 403
 * ```
 *
 * 因为 `authToken` 有 2²⁵⁶ 空间，索引查找**不泄露任何部分信息**，所以不需要再做常量时间比较。
 * **也没有会话表**：令牌本身就是身份，控制台也用它（塞进 HttpOnly cookie）。
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AccountInfo, Quota } from "../../../shared/contract";

/** `authToken` 的哈希。**唯一产地** —— 别处不许再写一遍。 */
export function hashAuthToken(authToken: string): string {
  return createHash("sha256").update(authToken, "utf8").digest("hex");
}

/** 一次性码（引导码/邀请码）的哈希。用 `randomBytes` 的十六进制，**明文只在生成时出现一次**。 */
export function hashCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/**
 * 生成一次性码：`<prefix>_<48 位十六进制>`。
 *
 * 24 字节 = 192 位熵 ⇒ 无法爆破。`prefix` 让运维**一眼能分清**它是什么码
 * （`boot_` / `inv_` / `nb_`），减少「把笔记本邀请码当注册码发出去」这类事故。
 */
export function generateCode(prefix: "boot" | "inv" | "nb", bytes = 24): string {
  return `${prefix}_${randomBytes(bytes).toString("hex")}`;
}

/** 恒定时间比较两个哈希（防时序侧信道）。长度不同直接返回假。 */
export function hashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 账号状态。 */
export type AccountStatus = "active" | "disabled";

export interface AccountRow {
  id: string;
  auth_hash: string;
  wrapped_enc_root: string;
  is_admin: number;
  status: string;
  label: string | null;
  created_at: number;
  last_seen_at: number | null;
}

export interface CreateAccountInput {
  /** 客户端生成的公开 `accountId`（16B 随机，十六进制）。 */
  accountId: string;
  /** 客户端派生出的 `authToken`（明文只在这一刻出现，我们只存哈希）。 */
  authToken: string;
  /** `AEAD(wrapKey, encRoot, aad=accountId)` —— 我们存下来但**解不开**。 */
  wrappedEncRoot: string;
  isAdmin?: boolean;
  label?: string | null;
  /** 注册门槛：引导码与邀请码**二选一，必须有其一**（§1.5「注册始终只能靠邀请码」）。 */
  bootstrapCode?: string;
  inviteCode?: string;
  now?: number;
}

/** 注册被拒的原因（机器可读，便于映射状态码）。 */
export type CreateAccountRejection =
  | "account-exists"
  | "missing-code"
  | "bad-bootstrap-code"
  | "bootstrap-code-used"
  | "bootstrap-code-expired"
  | "bad-invite-code"
  | "invite-revoked"
  | "invite-expired"
  | "invite-exhausted";

export class AccountError extends Error {
  constructor(
    readonly rejection: CreateAccountRejection | "unauthorized" | "disabled" | "not-found",
    message: string,
  ) {
    super(message);
    this.name = "AccountError";
  }
}

/** 引导码有效期：默认 30 分钟（CLI 打完码去客户端粘贴，够用且不久留）。 */
export const BOOTSTRAP_CODE_TTL_MS = 30 * 60_000;

/**
 * 账号仓库。所有方法都是**同步**的（`node:sqlite` 是同步 API），
 * 由 HTTP 层包成 async。这样避免「假异步」把事务边界搞乱。
 */
export class AccountStore {
  constructor(private readonly db: DatabaseSync) {}

  /** 按 `authToken` 找账号 —— 认证的唯一链路（§4.4）。 */
  findById(authToken: string): AccountRow | null {
    const row = this.db.prepare("SELECT * FROM accounts WHERE auth_hash = ?").get(hashAuthToken(authToken)) as AccountRow | undefined;
    return row ?? null;
  }

  /** 按 `accountId` 找（控制台与管理接口用）。 */
  findById2(accountId: string): AccountRow | null {
    const row = this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as AccountRow | undefined;
    return row ?? null;
  }

  /**
   * 认证 + 状态检查。返回账号行，或抛 `AccountError`。
   *
   * 区分 `unauthorized`（401）与 `disabled`（403）：前者不该泄露「这个账号存在」，
   * 后者是管理员主动的动作，用户需要知道为什么进不去（§4.4 纪律 5）。
   */
  authenticate(authToken: string): AccountRow {
    const row = this.findById(authToken);
    if (!row) throw new AccountError("unauthorized", "令牌无效");
    if (row.status !== "active") throw new AccountError("disabled", "账号已被禁用");
    return row;
  }

  /** 更新 `last_seen_at`（每次成功认证都会调；失败不影响请求）。 */
  touch(accountId: string, now = Date.now()): void {
    this.db.prepare("UPDATE accounts SET last_seen_at = ? WHERE id = ?").run(now, accountId);
  }

  /** 这个 `accountId` 是否已被占用（客户端生成 id，理论上可能撞上已有的）。 */
  exists(accountId: string): boolean {
    return this.db.prepare("SELECT 1 FROM accounts WHERE id = ?").get(accountId) !== undefined;
  }

  /**
   * 注册。**必须有码**（引导码或邀请码），且**不存在「首次注册自动成管理员」这条路径**
   * —— 那会被抢注（§1.5）。
   *
   * 整个流程在一个事务里：消耗码与建账号**要么都成、要么都不成**。
   */
  create(input: CreateAccountInput): AccountRow {
    const now = input.now ?? Date.now();
    if (this.exists(input.accountId)) throw new AccountError("account-exists", "这个账号标识已被占用");

    if (!input.bootstrapCode && !input.inviteCode) {
      throw new AccountError("missing-code", "注册必须凭一次性引导码或邀请码");
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (input.bootstrapCode) {
        this.consumeBootstrapCode(input.bootstrapCode, now);
      } else if (input.inviteCode) {
        this.consumeInvite(input.inviteCode, now);
      }
      this.db
        .prepare(
          `INSERT INTO accounts (id, auth_hash, wrapped_enc_root, is_admin, status, label, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(
          input.accountId,
          hashAuthToken(input.authToken),
          input.wrappedEncRoot,
          input.isAdmin ? 1 : 0,
          input.label ?? null,
          now,
          now,
        );
      this.db.prepare("INSERT INTO quota_usage (account_id, bytes_used, notebooks, updated_at) VALUES (?, 0, 0, ?)").run(input.accountId, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    const created = this.findById2(input.accountId);
    if (!created) throw new Error("注册后读不到刚建的账号（不应该发生）");
    return created;
  }

  /* ------------------------------------------------------------ 引导码 */

  /**
   * 发一个**一次性管理员引导码**（只由 CLI 调）。
   *
   * 返回明文 —— 调用方（CLI）负责**只打印一次、不写日志、不落盘**（§4.12）。
   * 库里只存哈希，所以事后**连我们也拿不回明文**，这正是想要的。
   */
  createBootstrapCode(options: { now?: number; ttlMs?: number } = {}): { code: string; expiresAt: number } {
    const now = options.now ?? Date.now();
    const expiresAt = now + (options.ttlMs ?? BOOTSTRAP_CODE_TTL_MS);
    const code = generateCode("boot");
    this.db.prepare("INSERT INTO bootstrap_codes (code_hash, created_at, expires_at, used_at) VALUES (?, ?, ?, NULL)").run(hashCode(code), now, expiresAt);
    return { code, expiresAt };
  }

  private consumeBootstrapCode(code: string, now: number): void {
    const hash = hashCode(code);
    const row = this.db.prepare("SELECT * FROM bootstrap_codes WHERE code_hash = ?").get(hash) as
      | { code_hash: string; expires_at: number; used_at: number | null }
      | undefined;
    // 不区分「没有这个码」与「码错了」—— 两者对外都是「引导码无效」。
    if (!row) throw new AccountError("bad-bootstrap-code", "引导码无效");
    if (row.used_at !== null) throw new AccountError("bootstrap-code-used", "引导码已经被用过了");
    if (now > row.expires_at) throw new AccountError("bootstrap-code-expired", "引导码已过期");
    // 一次性：立刻标用掉（同一事务内，所以并发重复提交只会有一个成功）。
    this.db.prepare("UPDATE bootstrap_codes SET used_at = ? WHERE code_hash = ?").run(now, hash);
  }

  /* ------------------------------------------------------------ 邀请码 */

  createInvite(options: { createdBy: string; expiresInSeconds?: number; maxUses?: number; now?: number }): {
    code: string;
    expiresAt: number | null;
    maxUses: number;
  } {
    const now = options.now ?? Date.now();
    const maxUses = options.maxUses ?? 1;
    const expiresAt = options.expiresInSeconds ? now + options.expiresInSeconds * 1000 : null;
    const code = generateCode("inv");
    this.db
      .prepare("INSERT INTO invites (code_hash, created_by, created_at, expires_at, max_uses, uses, revoked_at) VALUES (?, ?, ?, ?, ?, 0, NULL)")
      .run(hashCode(code), options.createdBy, now, expiresAt, maxUses);
    return { code, expiresAt, maxUses };
  }

  private consumeInvite(code: string, now: number): void {
    const hash = hashCode(code);
    const row = this.db.prepare("SELECT * FROM invites WHERE code_hash = ?").get(hash) as
      | { code_hash: string; expires_at: number | null; max_uses: number; uses: number; revoked_at: number | null }
      | undefined;
    if (!row) throw new AccountError("bad-invite-code", "邀请码无效");
    if (row.revoked_at !== null) throw new AccountError("invite-revoked", "邀请码已被作废");
    if (row.expires_at !== null && now > row.expires_at) throw new AccountError("invite-expired", "邀请码已过期");
    if (row.uses >= row.max_uses) throw new AccountError("invite-exhausted", "邀请码已用尽");
    this.db.prepare("UPDATE invites SET uses = uses + 1 WHERE code_hash = ?").run(hash);
  }

  revokeInvite(code: string, now = Date.now()): boolean {
    const result = this.db.prepare("UPDATE invites SET revoked_at = ? WHERE code_hash = ? AND revoked_at IS NULL").run(now, hashCode(code));
    return Number(result.changes ?? 0) > 0;
  }

  /* ---------------------------------------------------------------- 轮换 */

  /**
   * **轮换（零重加密）**：换 `accountKey` → 换 `authToken` / `wrapKey` → **重包** `wrappedEncRoot`。
   *
   * `encRoot` **不变**，所以一个字节的笔记都不用重新加密 —— 这是本设计最漂亮的一点（§1.5③）。
   * 库操作只有一条 UPDATE，且**旧令牌立即失效**（因为 `auth_hash` 被换掉了）。
   *
   * 用**旧令牌**认证（调用方保证），所以这里只需要新值。
   */
  rotate(accountId: string, newAuthToken: string, newWrappedEncRoot: string): void {
    const result = this.db
      .prepare("UPDATE accounts SET auth_hash = ?, wrapped_enc_root = ? WHERE id = ?")
      .run(hashAuthToken(newAuthToken), newWrappedEncRoot, accountId);
    if (Number(result.changes ?? 0) === 0) throw new AccountError("not-found", "账号不存在");
  }

  /** 解锁（新设备）：用 `accountKey` 派生的令牌换回 `wrappedEncRoot`，客户端自己解。 */
  unlock(authToken: string): { accountId: string; wrappedEncRoot: string } {
    const row = this.authenticate(authToken);
    return { accountId: row.id, wrappedEncRoot: row.wrapped_enc_root };
  }

  /* -------------------------------------------------------- 状态与删除 */

  setStatus(accountId: string, status: AccountStatus): boolean {
    const result = this.db.prepare("UPDATE accounts SET status = ? WHERE id = ?").run(status, accountId);
    return Number(result.changes ?? 0) > 0;
  }

  delete(accountId: string): boolean {
    const result = this.db.prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
    return Number(result.changes ?? 0) > 0;
  }

  list(): AccountRow[] {
    return this.db.prepare("SELECT * FROM accounts ORDER BY created_at ASC").all() as unknown as AccountRow[];
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** 供控制台/接口用的公开形状（**绝不含 `auth_hash` 或 `wrapped_enc_root`**）。 */
  info(row: AccountRow, quota: Quota): AccountInfo {
    return { accountId: row.id, isAdmin: row.is_admin === 1, label: row.label, quota };
  }
}

/** 造一个 `accountId`（控制台/测试用；真实客户端自己生成并送上来）。 */
export function newAccountId(): string {
  return randomBytes(16).toString("hex");
}

/** 造一个 `notebookId`（uuid v4；库名由它派生，见 `notebooks.ts`）。 */
export function newNotebookId(): string {
  return randomUUID();
}

/** 造一个 `authToken`（仅测试/CLI 夹具用 —— 真实客户端自己派生，我们**不该**有生成它的能力）。 */
export function newAuthTokenForTests(): string {
  return randomBytes(32).toString("hex");
}
