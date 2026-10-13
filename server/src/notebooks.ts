/**
 * 笔记本与**成员授权**（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §3.1、§3.9、§4.4、§4.5、§7.1）。
 *
 * ## 这个文件是「授权」的唯一真源
 *
 * 所有涉及笔记本的请求都走同一条判定（§4.4）：
 *
 * ```
 * 1. 认证 → accountId
 * 2. 解析 notebookId
 * 3. SELECT role FROM memberships WHERE notebook_id=? AND account_id=?
 *    ├─ 无行                    → **404**（★ 不是 403：不泄露「这个笔记本存在」）
 *    ├─ role == viewer          → 只允许 GET
 *    └─ role in (editor, owner) → 允许写
 * 4. 需要 owner 的操作 → 再查 role == 'owner'
 * ```
 *
 * ⚠️ **越权返回 404 而不是 403** 是多账号下的核心断言（§10.1 M1–M3），
 * 所以它写在**一个**地方（`resolveMembership`），而不是散在每个端点里。
 *
 * ## 为什么 ACL **不**镜像进 CouchDB `_security`（§4.4 纪律 1）
 *
 * 那会立刻产生「两份真相」。`_security` 的角色是**纵深防御**：只设成「只有 `sync` 服务账号」，
 * 于是万一 `sync` 的 CouchDB 凭据泄露，攻击者拿到的也不会比 `sync` 本来能拿的更多。
 *
 * ## 库名不透明（§3.1）
 *
 * `db_name = "nb-" + uuid去连字符`。**不由用户输入**，只由服务端生成：
 * 不能枚举或猜别人的库，改笔记本名不动库名，跨账号天然唯一。
 */

import type { DatabaseSync } from "node:sqlite";
import type { CryptoMode, Role } from "../../shared/contract";
import { newNotebookId } from "./auth/accounts";
import { databaseNameFor } from "./couch/design";

export interface NotebookRow {
  id: string;
  owner_id: string;
  name: string;
  db_name: string;
  crypto_mode: string;
  created_at: number;
  deleted_at: number | null;
}

export interface MembershipRow {
  notebook_id: string;
  account_id: string;
  role: string;
  created_at: number;
}

/** 笔记本邀请码（共享用；**不需要知道对方是谁**，§1.5）。 */
export interface NotebookInviteRow {
  code_hash: string;
  notebook_id: string;
  role: string;
  created_by: string;
  created_at: number;
  expires_at: number | null;
  used_at: number | null;
}

export class NotebookError extends Error {
  constructor(
    readonly code:
      | "not-found"
      | "forbidden"
      | "crypto-mode-not-shareable"
      | "bad-invite"
      | "invite-used"
      | "invite-expired"
      | "already-member"
      | "quota",
    message: string,
  ) {
    super(message);
    this.name = "NotebookError";
  }
}

/** v1 规则：`crypto_mode != 'none'` 的笔记本**不可共享**（§1.4）。 */
export const CRYPTO_MODE_SHAREABLE: CryptoMode = "none";

export interface CreateNotebookInput {
  ownerId: string;
  name: string;
  cryptoMode: CryptoMode;
  /** 覆盖自动生成的 id（测试用；生产不传）。 */
  notebookId?: string;
  now?: number;
}

export class NotebookStore {
  constructor(private readonly db: DatabaseSync) {}

  /* ------------------------------------------------------------ 笔记本 */

  create(input: CreateNotebookInput): NotebookRow {
    const now = input.now ?? Date.now();
    const id = input.notebookId ?? newNotebookId();
    const dbName = databaseNameFor(id);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO notebooks (id, owner_id, name, db_name, crypto_mode, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, NULL)")
        .run(id, input.ownerId, input.name, dbName, input.cryptoMode, now);
      // ★ 建笔记本与建 owner 成员必须在同一事务里：否则会出现一个没有任何成员的笔记本，
      //   而「授权真源」查不到行 ⇒ 连创建者自己都 404。
      this.db.prepare("INSERT INTO memberships (notebook_id, account_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(id, input.ownerId, now);
      this.db.prepare("INSERT INTO notebook_provisioning (notebook_id, design_ok, revs_limit, sync_info_ok, last_checked) VALUES (?, 0, NULL, 0, NULL)").run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const created = this.findById(id);
    if (!created) throw new Error("建完笔记本却读不到它（不应该发生）");
    return created;
  }

  findById(id: string): NotebookRow | null {
    const row = this.db.prepare("SELECT * FROM notebooks WHERE id = ? AND deleted_at IS NULL").get(id) as unknown as NotebookRow | undefined;
    return row ?? null;
  }

  /** 库名反查（`/v1/*` 拿到 `nb=` 之后的第一步）。 */
  findByDatabaseName(dbName: string): NotebookRow | null {
    const row = this.db.prepare("SELECT * FROM notebooks WHERE db_name = ? AND deleted_at IS NULL").get(dbName) as unknown as NotebookRow | undefined;
    return row ?? null;
  }

  /**
   * **授权判定：唯一入口**。
   *
   * 返回 `null` = 这个人**无权看这个笔记本**。调用方**必须把它变成 404**，
   * 而不是 403 —— 403 等于确认「这个笔记本存在」（§4.4 纪律 2、§10.1 M1–M3）。
   */
  resolveMembership(notebookId: string, accountId: string): MembershipRow | null {
    const row = this.db
      .prepare("SELECT * FROM memberships WHERE notebook_id = ? AND account_id = ?")
      .get(notebookId, accountId) as unknown as MembershipRow | undefined;
    return row ?? null;
  }

  /** 明确要求 owner 的操作（删笔记本、生成/撤销笔记本邀请码）。 */
  requireOwner(notebookId: string, accountId: string): MembershipRow {
    const membership = this.resolveMembership(notebookId, accountId);
    if (!membership) throw new NotebookError("not-found", "笔记本不存在");
    if (membership.role !== "owner") throw new NotebookError("forbidden", "需要 owner 权限");
    return membership;
  }

  /** 写权限：`editor` 与 `owner` 可以写，`viewer` 不行。 */
  requireWrite(notebookId: string, accountId: string): MembershipRow {
    const membership = this.resolveMembership(notebookId, accountId);
    if (!membership) throw new NotebookError("not-found", "笔记本不存在");
    if (membership.role !== "owner" && membership.role !== "editor") {
      throw new NotebookError("forbidden", "只读成员不能写入");
    }
    return membership;
  }

  /** 这个人能看到的所有笔记本（`/v1/notebooks`）。 */
  listForAccount(accountId: string): { notebook: NotebookRow; role: Role }[] {
    const rows = this.db
      .prepare(
        `SELECT n.*, m.role AS role FROM memberships m
         JOIN notebooks n ON n.id = m.notebook_id
         WHERE m.account_id = ? AND n.deleted_at IS NULL
         ORDER BY m.created_at ASC`,
      )
      .all(accountId) as unknown as (NotebookRow & { role: string })[];
    return rows.map((row) => ({ notebook: row, role: row.role as Role }));
  }

  listMembers(notebookId: string): { accountId: string; role: Role; label: string | null }[] {
    const rows = this.db
      .prepare(
        `SELECT m.account_id AS accountId, m.role AS role, a.label AS label FROM memberships m
         JOIN accounts a ON a.id = m.account_id
         WHERE m.notebook_id = ? ORDER BY m.created_at ASC`,
      )
      .all(notebookId) as unknown as { accountId: string; role: string; label: string | null }[];
    return rows.map((row) => ({ accountId: row.accountId, role: row.role as Role, label: row.label }));
  }

  rename(notebookId: string, name: string): boolean {
    return Number(this.db.prepare("UPDATE notebooks SET name = ? WHERE id = ?").run(name, notebookId).changes ?? 0) > 0;
  }

  /**
   * **逻辑删除**笔记本并返回它是否**没有其它成员**（决定库要不要真的删掉）。
   *
   * 为什么不是「直接删行」：`plan_notebooks` 的角色是「把这块地标记为没了」，
   * 而 CouchDB 的库与其中所有密文是**另一个资源**。文档 §7.1 要求
   * 「删账号 → 级联删其**独占**笔记本的库；有共享成员的笔记本**移交** owner」
   * —— 所以「有没有别的成员」这个判断必须发生在删库之前。
   */
  markDeleted(notebookId: string, now = Date.now()): { exclusive: boolean; otherMembers: string[] } {
    const members = this.listMembers(notebookId).filter((member) => member.role !== "owner");
    this.db.prepare("UPDATE notebooks SET deleted_at = ? WHERE id = ?").run(now, notebookId);
    return { exclusive: members.length === 0, otherMembers: members.map((member) => member.accountId) };
  }

  /** 把一个笔记本的 owner 换成别人（「移交」而不是删掉，§7.1）。 */
  transferOwnership(notebookId: string, toAccountId: string, now = Date.now()): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE notebooks SET owner_id = ? WHERE id = ?").run(toAccountId, notebookId);
      this.db.prepare("INSERT OR REPLACE INTO memberships (notebook_id, account_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(
        notebookId,
        toAccountId,
        now,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 账号删除时清掉它的成员行（连同它独占的笔记本，由调用方决定库的处置）。 */
  removeMembershipsOf(accountId: string): string[] {
    const affected = (
      this.db.prepare("SELECT notebook_id FROM memberships WHERE account_id = ?").all(accountId) as unknown as { notebook_id: string }[]
    ).map((row) => row.notebook_id);
    this.db.prepare("DELETE FROM memberships WHERE account_id = ?").run(accountId);
    return affected;
  }

  /* ------------------------------------------------------- 成员与邀请码 */

  /**
   * 加入笔记本（凭一次性邀请码）。
   *
   * ⚠️ **`crypto_mode != 'none'` 直接拒绝**（§1.4 的 v1 规则）。这条必须在**发码**与
   * **用码**两处都判：只判发码处的话，一个在改 crypto_mode 之前发出去的码仍然能用。
   */
  joinByInvite(codeHash: string, accountId: string, now = Date.now()): { notebookId: string; role: Role } {
    const invite = this.db.prepare("SELECT * FROM notebook_invites WHERE code_hash = ?").get(codeHash) as unknown as NotebookInviteRow | undefined;
    if (!invite) throw new NotebookError("bad-invite", "邀请码无效");
    if (invite.used_at !== null) throw new NotebookError("invite-used", "邀请码已经被用过了");
    if (invite.expires_at !== null && now > invite.expires_at) throw new NotebookError("invite-expired", "邀请码已过期");

    const notebook = this.findById(invite.notebook_id);
    if (!notebook) throw new NotebookError("not-found", "笔记本不存在");
    if (notebook.crypto_mode !== CRYPTO_MODE_SHAREABLE) {
      throw new NotebookError("crypto-mode-not-shareable", "端到端加密的笔记本在 v1 里不可共享");
    }
    if (this.resolveMembership(notebook.id, accountId)) {
      throw new NotebookError("already-member", "你已经是这个笔记本的成员了");
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO memberships (notebook_id, account_id, role, created_at) VALUES (?, ?, ?, ?)")
        .run(notebook.id, accountId, invite.role, now);
      this.db.prepare("UPDATE notebook_invites SET used_at = ? WHERE code_hash = ?").run(now, codeHash);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { notebookId: notebook.id, role: invite.role as Role };
  }

  createInvite(input: { codeHash: string; notebookId: string; role: Role; createdBy: string; expiresAt?: number | null; now?: number }): void {
    const notebook = this.findById(input.notebookId);
    if (!notebook) throw new NotebookError("not-found", "笔记本不存在");
    if (notebook.crypto_mode !== CRYPTO_MODE_SHAREABLE) {
      throw new NotebookError("crypto-mode-not-shareable", "端到端加密的笔记本在 v1 里不可共享");
    }
    if (input.role === "owner") throw new NotebookError("forbidden", "owner 不能通过邀请码分发");
    this.db
      .prepare("INSERT INTO notebook_invites (code_hash, notebook_id, role, created_by, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?, NULL)")
      .run(input.codeHash, input.notebookId, input.role, input.createdBy, input.now ?? Date.now(), input.expiresAt ?? null);
  }

  /* ---------------------------------------------------------------- 配额 */

  /**
   * 配额缓存（§4.11：`quota_usage` 是缓存，定期从 CouchDB 重算）。
   *
   * 这里只做**记账**，不做判定；判定在 `assertQuota()` 里（读写分开：超限时
   * **读取仍可用**，只有写入被拒，§10.1 M9）。
   */
  quotaOf(accountId: string): { bytesUsed: number; notebooks: number; bytesLimit: number; notebooksLimit: number } {
    return { bytesUsed: 0, notebooks: 0, bytesLimit: 0, notebooksLimit: 0, ...this.readQuota(accountId) };
  }

  private readQuota(accountId: string): { bytesUsed: number; notebooks: number } | null {
    const row = this.db.prepare("SELECT bytes_used, notebooks FROM quota_usage WHERE account_id = ?").get(accountId) as unknown as
      | { bytes_used: number; notebooks: number }
      | undefined;
    if (!row) return null;
    return { bytesUsed: row.bytes_used, notebooks: row.notebooks };
  }

  /** 重算「笔记本数」这一项（每次建/删笔记本时调）—— 它是本地就能算准的那一半。 */
  recomputeNotebookCount(accountId: string, now = Date.now()): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM notebooks WHERE owner_id = ? AND deleted_at IS NULL`,
      )
      .get(accountId) as unknown as { n: number };
    this.db
      .prepare("INSERT INTO quota_usage (account_id, bytes_used, notebooks, updated_at) VALUES (?, 0, ?, ?) ON CONFLICT(account_id) DO UPDATE SET notebooks = ?, updated_at = ?")
      .run(accountId, row.n, now, row.n, now);
    return row.n;
  }

  setQuotaUsage(accountId: string, input: { bytesUsed?: number; now?: number }): void {
    const now = input.now ?? Date.now();
    this.db
      .prepare(
        "INSERT INTO quota_usage (account_id, bytes_used, notebooks, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(account_id) DO UPDATE SET bytes_used = ?, updated_at = ?",
      )
      .run(accountId, input.bytesUsed ?? 0, now, input.bytesUsed ?? 0, now);
  }
}

/** 建的笔记本是否超出配额（**只拦写入，不拦读取**）。 */
export function assertNotebookQuota(currentNotebooks: number, limit: number): void {
  if (currentNotebooks >= limit) {
    throw new NotebookError("quota", `笔记本数量已达配额上限（${limit}）`);
  }
}
