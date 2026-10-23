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
    const otherMembers = this.otherMembersOf(notebookId);
    // ⚠️ **只有独占时才软删**。第一版无条件软删，于是「删账号」那条路上
    // 「共享笔记本移交给别人」之后它**仍然是 deleted_at 非空** ⇒ `findById()` 返回 null
    // ⇒ 从 Bob 的列表里彻底消失。而那本来就不该被删（它有别的成员）。
    if (otherMembers.length === 0) {
      this.db.prepare("UPDATE notebooks SET deleted_at = ? WHERE id = ?").run(now, notebookId);
    }
    return { exclusive: otherMembers.length === 0, otherMembers };
  }

  /**
   * **只看**这个笔记本除了 owner 还有没有别的成员（**不写**）。
   *
   * 为什么要单独拆出来：删账号的处理流程需要**先问再决定**（独占 ⇒ 删库删行；
   * 有共享成员 ⇒ 移交），而 `markDeleted()` 会改状态。把「判断」与「改状态」分开，
   * 调用方就不会落进「先改了再发现不该改」的坑（第一版正是这样）。
   */
  otherMembersOf(notebookId: string): string[] {
    return this.listMembers(notebookId)
      .filter((member) => member.role !== "owner")
      .map((member) => member.accountId);
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
    /*
     * ★ `bytesUsed` 现在由**账本**算，不再读 `quota_usage.bytes_used`。
     *
     * 那一列从注册起就是 0，之后没有任何代码更新它 —— 于是控制台的用量条永远是
     * 空的、台账的「占用」永远是 0 B，而库里明明有数据。真正的字节数在
     * `notebook_usage`（服务端在每一次写/删正文时记账，见 `addNotebookBytes`），
     * 所以这里按「这个人拥有的、未被删掉的库」求和 —— 一个聚合查询，不会比原来贵。
     *
     * `notebooks` 仍然读缓存：它是**本地就能算准**的那一半，而且建/删库时都会刷。
     */
    return {
      bytesUsed: this.bytesOwnedBy(accountId),
      notebooks: 0,
      bytesLimit: 0,
      notebooksLimit: 0,
      ...this.readQuota(accountId),
    };
  }

  private readQuota(accountId: string): { notebooks: number } | null {
    const row = this.db.prepare("SELECT notebooks FROM quota_usage WHERE account_id = ?").get(accountId) as unknown as
      | { notebooks: number }
      | undefined;
    return row ?? null;
  }

  /** 这个人拥有的、未被删除的库合计占用了多少字节（`notebook_usage` 的聚合）。 */
  bytesOwnedBy(accountId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(u.bytes_used), 0) AS total
           FROM notebook_usage u
           JOIN notebooks n ON n.id = u.notebook_id
          WHERE n.owner_id = ? AND n.deleted_at IS NULL`,
      )
      .get(accountId) as unknown as { total: number } | undefined;
    return row?.total ?? 0;
  }

  /* -------------------------------------------------------------- 用量记账 */

  /**
   * 记一个库的占用变化（**服务端在写/删正文时调**）。
   *
   * ## 为什么是「增量」而不是「重算」
   *
   * 重算要对每个库问一次 CouchDB（`_all_docs` 的 sizes），1000 个库时会把库打满
   * （文档 §10 的 U22）。而写路径上手边就有 `body.byteLength` —— 它正是写进去的字节数。
   * 所以这里记账是**免费**的，代价只有一次 UPSERT。
   *
   * ## 为什么允许负数、并且夹到 0
   *
   * 删除、覆盖写都会让占用变小。夹到 0 是因为「负数占用」没有任何解释空间：
   * 真出现负数是账本漂移的信号（例如历史数据没记过），此时显示 0 比显示 -12 KB 诚实。
   */
  addNotebookBytes(notebookId: string, delta: number, now = Date.now()): number {
    if (!Number.isFinite(delta) || delta === 0) return this.notebookBytesOf(notebookId);
    const amount = Math.trunc(delta);
    /*
     * ⚠️ 增量要传**两次**：插入时夹到 0（新行不能是负数），更新时用原始值
     * （`旧值 + 原始增量` 再夹 0）。
     *
     * 只传一次会有一个很隐蔽的错：SQLite 把 `excluded.bytes_used` 当成**已经**
     * 夹过的值，于是 `-100` 变成 `0` —— 覆盖写和删除**永远不会让占用变小**，
     * 用量只增不减。用例当场抓到（`expected 10 to be 0`）。
     */
    this.db
      .prepare(
        `INSERT INTO notebook_usage (notebook_id, bytes_used, updated_at) VALUES (?, MAX(0, ?), ?)
         ON CONFLICT(notebook_id) DO UPDATE SET
           bytes_used = MAX(0, notebook_usage.bytes_used + ?),
           updated_at = ?`,
      )
      .run(notebookId, amount, now, amount, now);
    return this.notebookBytesOf(notebookId);
  }

  /** 一个库当前记录在案的占用（控制台抽屉里那一行用）。 */
  notebookBytesOf(notebookId: string): number {
    const row = this.db.prepare("SELECT bytes_used FROM notebook_usage WHERE notebook_id = ?").get(notebookId) as unknown as
      | { bytes_used: number }
      | undefined;
    return row?.bytes_used ?? 0;
  }

  /* ---------------------------------------------------------- 同步活动 */

  /**
   * 记一次**服务端亲自观察到**的同步活动（`/v1` 数据面的读写路径上调）。
   *
   * ## 为什么服务端要自己数
   *
   * `client_stats` 是**客户端上报**的（`POST /v1/stats`），而当前产品客户端**没有**
   * 这个上报调用 —— 于是控制台的流量图、冲突热点永远是空的，而同步其实一直在跑。
   *
   * 服务端不需要客户端配合就能回答同一类问题：请求是它接的、409 是它回的。
   * 所以这里按 `(账号, 库, 天)` 记一份**实测值**，与客户端上报的那份**分开存**
   * （见迁移 3 的说明：两个来源不能混进一行）。
   *
   * `kind` 决定加在哪一列。**冲突与错误是「别人已经失败了」的事实**，
   * 它们与被计入 pulls/pushes 的那次请求是**两件事**（一次 409 既是一次 push 尝试，
   * 也是一次冲突），所以分开计数而不是二选一。
   */
  recordActivity(input: {
    accountId: string;
    notebookId: string;
    day: string;
    kind: "pull" | "push" | "delete" | "conflict" | "error";
    amount?: number;
  }): void {
    const amount = Math.max(0, Math.trunc(input.amount ?? 1));
    if (amount === 0) return;
    const column = { pull: "pulls", push: "pushes", delete: "deletes", conflict: "conflicts", error: "errors" }[input.kind];
    /*
     * 先确保那一行在（`DO NOTHING`），再单独 UPDATE 加一列。
     * 为什么不写一条「五个 excluded 相加」的 UPSERT：那样要把**没变的那四列**
     * 也读出来再写回去，而这里只需要动一列 —— 少一半参数，也少一半出错的机会。
     */
    this.db
      .prepare(
        `INSERT INTO sync_activity (account_id, notebook_id, day, pulls, pushes, deletes, conflicts, errors)
         VALUES (?, ?, ?, 0, 0, 0, 0, 0)
         ON CONFLICT(account_id, notebook_id, day) DO NOTHING`,
      )
      .run(input.accountId, input.notebookId, input.day);
    // 列名来自**上面那张白名单**（不是外部输入），所以拼接是安全的。
    this.db
      .prepare(
        `UPDATE sync_activity SET ` + column + ` = ` + column + ` + ? WHERE account_id = ? AND notebook_id = ? AND day = ?`,
      )
      .run(amount, input.accountId, input.notebookId, input.day);
  }

  /**
   * 某个账号的同步活动（与 `statsFor` 同形状，供「我的」视角与合并用）。
   *
   * 默认只给近 `limitDays` 天 —— 与 `statsFor` 的语义一致（控制台只画这段时间）。
   */
  activityForAccount(
    accountId: string,
    options: { notebookId?: string; limitDays?: number } = {},
  ): { notebookId: string; day: string; pulls: number; pushes: number; deletes: number; conflicts: number; errors: number }[] {
    const limit = options.limitDays ?? 30;
    const rows = (
      options.notebookId
        ? this.db
            .prepare("SELECT * FROM sync_activity WHERE account_id = ? AND notebook_id = ? ORDER BY day DESC LIMIT ?")
            .all(accountId, options.notebookId, limit)
        : this.db.prepare("SELECT * FROM sync_activity WHERE account_id = ? ORDER BY day DESC LIMIT ?").all(accountId, limit)
    ) as unknown as {
      notebook_id: string;
      day: string;
      pulls: number;
      pushes: number;
      deletes: number;
      conflicts: number;
      errors: number;
    }[];
    return rows.map((row) => ({
      notebookId: row.notebook_id,
      day: row.day,
      pulls: row.pulls,
      pushes: row.pushes,
      deletes: row.deletes,
      conflicts: row.conflicts,
      errors: row.errors,
    }));
  }

  /** **全站**同步活动（管理页按天聚合；与 `activityForAccount` 同一张表）。 */
  activityForAll(): { accountId: string; notebookId: string; day: string; pulls: number; pushes: number; deletes: number; conflicts: number; errors: number }[] {
    const rows = this.db.prepare("SELECT * FROM sync_activity").all() as unknown as {
      account_id: string;
      notebook_id: string;
      day: string;
      pulls: number;
      pushes: number;
      deletes: number;
      conflicts: number;
      errors: number;
    }[];
    return rows.map((row) => ({
      accountId: row.account_id,
      notebookId: row.notebook_id,
      day: row.day,
      pulls: row.pulls,
      pushes: row.pushes,
      deletes: row.deletes,
      conflicts: row.conflicts,
      errors: row.errors,
    }));
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

  /** 全站笔记本总数（控制台顶栏用；**不逐库问 CouchDB** —— 那会把库打满）。 */
  totalNotebooks(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM notebooks WHERE deleted_at IS NULL").get() as unknown as { n: number };
    return row.n;
  }

  /* ---------------------------------------------------------------- 统计 */

  /**
   * 客户端上报的按天计数（§4.3 `client_stats`）。
   *
   * **`conflicts` / `errors` 是控制台判断「同步是否正常」最快的信号**：
   * 持续增长 = 有一端基线坏了（§8.5）。所以这里用**累加**而不是覆盖 ——
   * 同一天里客户端可能上报多次（每次同步一次），覆盖会把中间的过程丢掉。
   *
   * ⚠️ 只记**计数**：服务端看不到冲突内容（红线 2；E2EE 下它也只有密文）。
   */
  reportStats(input: {
    accountId: string;
    notebookId: string;
    day: string;
    conflicts: number;
    errors: number;
    pushes: number;
    pulls: number;
    deletes: number;
  }): void {
    const nonNegative = (value: number): number => Math.max(0, Math.floor(value));
    this.db
      .prepare(
        `INSERT INTO client_stats (account_id, notebook_id, day, conflicts, errors, pushes, pulls, deletes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, notebook_id, day) DO UPDATE SET
           conflicts = conflicts + excluded.conflicts,
           errors    = errors    + excluded.errors,
           pushes    = pushes    + excluded.pushes,
           pulls     = pulls     + excluded.pulls,
           deletes   = deletes   + excluded.deletes`,
      )
      .run(
        input.accountId,
        input.notebookId,
        input.day,
        nonNegative(input.conflicts),
        nonNegative(input.errors),
        nonNegative(input.pushes),
        nonNegative(input.pulls),
        nonNegative(input.deletes),
      );
  }

  /** 读某个账号的按天统计（控制台「冲突与错误」页）。 */
  statsFor(
    accountId: string,
    options: { notebookId?: string; limitDays?: number } = {},
  ): { notebookId: string; day: string; conflicts: number; errors: number; pushes: number; pulls: number; deletes: number }[] {
    const limit = options.limitDays ?? 30;
    const rows = (
      options.notebookId
        ? this.db
            .prepare("SELECT * FROM client_stats WHERE account_id = ? AND notebook_id = ? ORDER BY day DESC LIMIT ?")
            .all(accountId, options.notebookId, limit)
        : this.db.prepare("SELECT * FROM client_stats WHERE account_id = ? ORDER BY day DESC LIMIT ?").all(accountId, limit)
    ) as unknown as {
      notebook_id: string;
      day: string;
      conflicts: number;
      errors: number;
      pushes: number;
      pulls: number;
      deletes: number;
    }[];
    return rows.map((row) => ({
      notebookId: row.notebook_id,
      day: row.day,
      conflicts: row.conflicts,
      errors: row.errors,
      pushes: row.pushes,
      pulls: row.pulls,
      deletes: row.deletes,
    }));
  }

  /**
   * **测试用**：把一个笔记本的 `crypto_mode` 改掉。
   *
   * 为什么要它：`crypto_mode` 在正式流程里**没有**「改」这个操作（v1 不做加密迁移，
   * §11.3 A），但用例需要模拟「发完邀请码之后模式被改过 / 有人手工改过库」这种状态 ——
   * 那正是「用码处也要判可共享性」这条纪律要防的场景。
   *
   * 放在这里而不是让用例去凿私有 `db` 字段：后者在重构时会以「测试编译不过」炸掉，
   * 而且会诱使别人照抄。
   */
  __setCryptoModeForTests(notebookId: string, cryptoMode: CryptoMode): void {
    this.db.prepare("UPDATE notebooks SET crypto_mode = ? WHERE id = ?").run(cryptoMode, notebookId);
  }

  /**
   * **物理删掉**某个账号名下的笔记本行（连同置备状态行）。
   *
   * 为什么需要它：`notebooks.owner_id` 有 `REFERENCES accounts(id)` 外键，
   * 而 `markDeleted()` 是**软删**（行还在）。于是「删账号」必须先把这些行清掉，
   * 否则外键会挡住 —— 而且是在**成员行已经删掉之后**才失败，
   * 留下「删了一半」的状态。
   *
   * ⚠️ 只该在**库已经删掉**或**已移交**之后调（否则会留下无主的 CouchDB 库）。
   */
  deleteRowsOwnedBy(accountId: string): number {
    const ids = (this.db.prepare("SELECT id FROM notebooks WHERE owner_id = ?").all(accountId) as unknown as { id: string }[]).map((row) => row.id);
    for (const id of ids) {
      /*
       * ⚠️ **顺序：先把所有「指向这个笔记本」的子行清掉，最后才删 `notebooks` 本身。**
       *
       * `notebooks` 被三张表引用：`memberships`、`notebook_invites`、
       * `notebook_provisioning`（还有 `client_stats`，它不是外键但同样按 notebook_id 记）。
       * 第一版漏了 `memberships` 与 `client_stats`，于是删 `notebooks` 时
       * `FOREIGN KEY constraint failed` —— 而且我在 admin 那侧把它包成了 500，
       * 现象是「删账号直接 500」，根因藏在一层之外。
       */
      this.db.prepare("DELETE FROM memberships WHERE notebook_id = ?").run(id);
      this.db.prepare("DELETE FROM notebook_invites WHERE notebook_id = ?").run(id);
      this.db.prepare("DELETE FROM notebook_provisioning WHERE notebook_id = ?").run(id);
      this.db.prepare("DELETE FROM client_stats WHERE notebook_id = ?").run(id);
      /*
       * ★ 迁移 3 的两张新表也有 `notebook_id`（`notebook_usage` 还是外键）。
       * 漏掉它们的症状与当年漏掉 `memberships` 一模一样：`FOREIGN KEY constraint failed`，
       * 而且报错位置离根因很远（在删账号的 HTTP 处理器里）。
       */
      this.db.prepare("DELETE FROM notebook_usage WHERE notebook_id = ?").run(id);
      this.db.prepare("DELETE FROM sync_activity WHERE notebook_id = ?").run(id);
      this.db.prepare("DELETE FROM notebooks WHERE id = ?").run(id);
    }
    /*
     * 还有一处**指向账号**（不是指向笔记本）的引用：`notebook_invites.created_by`。
     *
     * 它在上面那轮循环里**清不掉** —— 因为「共享笔记本被移交给别人」时，
     * 那本笔记本的行留着，而它上面由该账号发出的邀请码仍然 `created_by = 该账号`。
     * 现象是 `FOREIGN KEY constraint failed`，而当时「还有几个笔记本行指向它」查出来是 0
     * —— 于是看起来像「没有任何东西指向它」，很容易查错方向。
     */
    this.db.prepare("DELETE FROM notebook_invites WHERE created_by = ?").run(accountId);
    this.db.prepare("DELETE FROM invites WHERE created_by = ?").run(accountId);
    return ids.length;
  }

  /* ------------------------------------------------------ 删账号的编排 */

  /**
   * **删一个账号在控制面上留下的全部痕迹**（一个事务里做完）。
   *
   * ## 为什么要有这一个方法
   *
   * 「删账号」在三个入口上都有（控制台、`/v1/admin`、客户端自助 `DELETE /v1/account`），
   * 而它要按 §7.1 做三件不同的事：
   *
   * 1. **独占**的库 → 逻辑删行（库由调用方删，那是 CouchDB 的事）；
   * 2. **共享**的库 → **移交** owner 给最早加入的其他成员（不删库）；
   * 3. 清掉这个人名下的所有引用行（成员、设备、邀请码、用量、统计、审计里的 actor 不动）。
   *
   * 三个入口各写一遍的后果是**总有一个会漏**（真发生过：控制台那条漏了设备行，
   * 于是 `FOREIGN KEY constraint failed` → 500 → 账号删不掉）。所以编排收敛在这里，
   * 调用方只负责「库要不要真删」。
   *
   * ## 为什么先处理笔记本、再删账号行
   *
   * `notebooks.owner_id` 与 `devices.account_id` 都 `REFERENCES accounts(id)`。
   * 先删账号行的话，所有指向它的子行会**一起炸**（而且错误只报第一张表）。
   *
   * @returns `{ exclusiveNotebooks, transferredNotebooks }` —— 前者需要调用方去删库。
   */
  deleteAccountCascade(accountId: string, now = Date.now()): { exclusiveNotebooks: string[]; transferredNotebooks: string[] } {
    const exclusiveNotebooks: string[] = [];
    const transferredNotebooks: string[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const owned = this.listForAccount(accountId).filter((item) => item.role === "owner");
      for (const { notebook } of owned) {
        /*
         * `markDeleted` **只对独占库软删**（共享库不动）—— 那一条已在它的实现里，
         * 这里只需要按 `exclusive` 分桶。
         */
        const result = this.markDeleted(notebook.id, now);
        if (result.exclusive) {
          exclusiveNotebooks.push(notebook.id);
        } else if (result.otherMembers.length > 0) {
          /*
           * ⚠️ **不能调 `transferOwnership()`** —— 它自己会 `BEGIN IMMEDIATE`，
           * 而 SQLite **不支持嵌套事务**（`cannot start a transaction within a transaction`）。
           * 所以这里把它的两条语句直接写在本事务里：语义完全一样，只是不另开事务。
           */
          const next = result.otherMembers[0]!;
          this.db.prepare("UPDATE notebooks SET owner_id = ? WHERE id = ?").run(next, notebook.id);
          this.db
            .prepare("INSERT OR REPLACE INTO memberships (notebook_id, account_id, role, created_at) VALUES (?, ?, 'owner', ?)")
            .run(notebook.id, next, now);
          transferredNotebooks.push(notebook.id);
        }
      }
      this.removeMembershipsOf(accountId);
      // 独占库的行**物理删掉**（库由调用方删；行留着会挡住 accounts 的外键）。
      for (const id of exclusiveNotebooks) this.deleteNotebookRow(id);
      this.deleteDevicesOf(accountId);
      this.db.prepare("DELETE FROM notebook_invites WHERE created_by = ?").run(accountId);
      this.db.prepare("DELETE FROM invites WHERE created_by = ?").run(accountId);
      this.db.prepare("DELETE FROM sync_activity WHERE account_id = ?").run(accountId);
      this.db.prepare("DELETE FROM client_stats WHERE account_id = ?").run(accountId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { exclusiveNotebooks, transferredNotebooks };
  }

  /** 物理删掉**一个**笔记本的全部子行（不含 CouchDB 库）。 */
  private deleteNotebookRow(notebookId: string): void {
    this.db.prepare("DELETE FROM memberships WHERE notebook_id = ?").run(notebookId);
    this.db.prepare("DELETE FROM notebook_invites WHERE notebook_id = ?").run(notebookId);
    this.db.prepare("DELETE FROM notebook_provisioning WHERE notebook_id = ?").run(notebookId);
    this.db.prepare("DELETE FROM client_stats WHERE notebook_id = ?").run(notebookId);
    this.db.prepare("DELETE FROM notebook_usage WHERE notebook_id = ?").run(notebookId);
    this.db.prepare("DELETE FROM sync_activity WHERE notebook_id = ?").run(notebookId);
    this.db.prepare("DELETE FROM notebooks WHERE id = ?").run(notebookId);
  }

  /** 删一个账号的设备账本行（设备**不是凭据**，所以删行不会留下安全后果）。 */
  deleteDevicesOf(accountId: string): number {
    const result = this.db.prepare("DELETE FROM devices WHERE account_id = ?").run(accountId);
    return Number(result.changes ?? 0);
  }

  /* ---------------------------------------------------------------- 设备 */

  /**
   * 设备登记（**幂等**：同一 `deviceId` 重复登记只刷新 `last_seen_at`）。
   *
   * ⚠️ 这里**没有**「踢掉某台设备」—— 一个账号密钥所有设备共用，没有每设备凭据，
   * 所以 `devices` 是**只读账本**（§1.5 代价 3）。唯一的吊销手段是轮换账号密钥。
   */
  upsertDevice(input: {
    deviceId: string;
    accountId: string;
    name: string | null;
    platform: string | null;
    now?: number;
    ip?: string | null;
  }): void {
    const now = input.now ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO devices (id, account_id, name, platform, created_at, last_seen_at, last_ip)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, platform = excluded.platform, last_seen_at = excluded.last_seen_at, last_ip = excluded.last_ip`,
      )
      .run(input.deviceId, input.accountId, input.name, input.platform, now, now, input.ip ?? null);
  }

  /** 列出某个账号的设备（控制台「我的设备」页 —— **只读**）。 */
  listDevices(accountId: string): { deviceId: string; name: string | null; platform: string | null; createdAt: number; lastSeenAt: number | null }[] {
    const rows = this.db
      .prepare("SELECT * FROM devices WHERE account_id = ? ORDER BY created_at ASC")
      .all(accountId) as unknown as {
      id: string;
      name: string | null;
      platform: string | null;
      created_at: number;
      last_seen_at: number | null;
    }[];
    return rows.map((row) => ({
      deviceId: row.id,
      name: row.name,
      platform: row.platform,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    }));
  }

  /* ------------------------------------------------------ 管理端聚合读 */

  /**
   * **全站**笔记本台账（管理页「同步台账」）。
   *
   * 只读、只出**服务端真有的**列：库名不透明、没有明文路径、没有笔记内容。
   * `members` 走一次聚合而不是逐库 N+1 —— 台账页一屏 9 行只是恰好，
   * 500 个库时那份 N+1 会变成 500 次查询。
   */
  listAllNotebooks(): {
    id: string;
    name: string;
    ownerId: string;
    ownerLabel: string | null;
    cryptoMode: "none" | "user-key";
    createdAt: number;
    memberCount: number;
    bytesUsed: number;
    provisioning: { designOk: boolean; revsLimit: string | null; syncInfoOk: boolean; lastChecked: number | null } | null;
  }[] {
    const rows = this.db
      .prepare(
        `SELECT n.id, n.name, n.owner_id, n.crypto_mode, n.created_at,
                a.label AS owner_label,
                (SELECT COUNT(*) FROM memberships m WHERE m.notebook_id = n.id) AS member_count,
                -- ★ 体积取 notebook_usage（服务端自己记账的**库级**占用），
                -- 不是 quota_usage（账号级缓存，且从来没被更新过 —— 服务端那份实现
                -- 用 SUM(quota_usage) 顶替，结果恒为 0，因为没有任何代码更新那一列）。
                -- 台账问的是「这个库占了多少」，而一个账号下的库各占多少只有前者回答得了。
                COALESCE(u.bytes_used, 0) AS bytes_used,
                p.design_ok, p.revs_limit, p.sync_info_ok, p.last_checked
           FROM notebooks n
           LEFT JOIN accounts a ON a.id = n.owner_id
           LEFT JOIN notebook_provisioning p ON p.notebook_id = n.id
           LEFT JOIN notebook_usage u ON u.notebook_id = n.id
          WHERE n.deleted_at IS NULL
          ORDER BY n.created_at DESC`,
      )
      .all() as unknown as {
      id: string;
      name: string;
      owner_id: string;
      crypto_mode: string;
      created_at: number;
      owner_label: string | null;
      member_count: number;
      bytes_used: number;
      design_ok: number | null;
      revs_limit: string | null;
      sync_info_ok: number | null;
      last_checked: number | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      ownerId: row.owner_id,
      ownerLabel: row.owner_label,
      cryptoMode: row.crypto_mode === "user-key" ? "user-key" : "none",
      createdAt: row.created_at,
      memberCount: row.member_count,
      bytesUsed: row.bytes_used,
      /*
       * ★ **`last_checked` 才是「核对过没有」的判据**，不是 `design_ok`。
       *
       * `create()` 会先插一行 `design_ok = 0, sync_info_ok = 0, last_checked = NULL`
       * （占位，表示「还没核对」）。以前这里用 `design_ok === null` 判「未核对」，
       * 而那一列**永远不是 NULL** —— 于是每个刚建好的库都显示成红色的「不一致」，
       * 建库之后立刻去看台账会以为置备坏了。现在按 `last_checked` 判：
       * 没核对过就是「未核对」，核对过才谈「就位 / 不一致」。
       *
       * 服务器那份实现在这里还多要求 `design_ok === null`（`&& row.design_ok === null`），
       * 那等于把「未核对」的条件收得更窄 —— 占位行的 `design_ok` 是 0 而不是 NULL，
       * 所以它永远不成立，假的「不一致」照旧出现。合并时取这边。
       */
      provisioning:
        row.last_checked === null
          ? null
          : {
              designOk: row.design_ok === 1,
              revsLimit: row.revs_limit,
              syncInfoOk: row.sync_info_ok === 1,
              lastChecked: row.last_checked,
            },
    }));
  }

  /**
   * **全站**设备账本（管理页「设备」）。
   *
   * 仍然是只读账本：一个账号密钥所有设备共用，所以没有「踢掉这一台」这个动作。
   */
  listAllDevices(): {
    deviceId: string;
    accountId: string;
    accountLabel: string | null;
    name: string | null;
    platform: string | null;
    createdAt: number;
    lastSeenAt: number | null;
  }[] {
    const rows = this.db
      .prepare(
        `SELECT d.id, d.account_id, d.name, d.platform, d.created_at, d.last_seen_at, a.label AS account_label
           FROM devices d
           LEFT JOIN accounts a ON a.id = d.account_id
          ORDER BY COALESCE(d.last_seen_at, d.created_at) DESC`,
      )
      .all() as unknown as {
      id: string;
      account_id: string;
      name: string | null;
      platform: string | null;
      created_at: number;
      last_seen_at: number | null;
      account_label: string | null;
    }[];
    return rows.map((row) => ({
      deviceId: row.id,
      accountId: row.account_id,
      accountLabel: row.account_label,
      name: row.name,
      platform: row.platform,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    }));
  }

  /**
   * 邀请码列表（管理页「账号与访问」）。
   *
   * ★ **只有哈希，没有明文** —— 明文在生成那一刻就没了。这里展示前 8 位是为了
   * 让运维能对上「哪张码」，不是为了让谁复制它。
   */
  listInvites(): {
    codeHash: string;
    createdBy: string | null;
    creatorLabel: string | null;
    createdAt: number;
    expiresAt: number | null;
    maxUses: number;
    uses: number;
    revokedAt: number | null;
  }[] {
    const rows = this.db
      .prepare(
        `SELECT i.code_hash, i.created_by, i.created_at, i.expires_at, i.max_uses, i.uses, i.revoked_at, a.label AS creator_label
           FROM invites i
           LEFT JOIN accounts a ON a.id = i.created_by
          ORDER BY i.created_at DESC`,
      )
      .all() as unknown as {
      code_hash: string;
      created_by: string | null;
      created_at: number;
      expires_at: number | null;
      max_uses: number;
      uses: number;
      revoked_at: number | null;
      creator_label: string | null;
    }[];
    return rows.map((row) => ({
      codeHash: row.code_hash,
      createdBy: row.created_by,
      creatorLabel: row.creator_label,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      maxUses: row.max_uses,
      uses: row.uses,
      revokedAt: row.revoked_at,
    }));
  }

  /**
   * 按**哈希**作废邀请码。
   *
   * `AccountStore.revokeInvite()` 收的是明文码；管理页只有哈希，所以这里
   * 直接在 `code_hash` 上更新。两条路径改的是同一张表、同一列。
   *
   * 返回 false 表示「没有这个哈希」或「已经作废过」—— 对运维来说目标状态
   * 都已达成，所以上层按 204 处理。
   */
  revokeInviteByHash(codeHash: string, now = Date.now()): boolean {
    const result = this.db
      .prepare("UPDATE invites SET revoked_at = ? WHERE code_hash = ? AND revoked_at IS NULL")
      .run(now, codeHash);
    return Number(result.changes ?? 0) > 0;
  }

  /** 写一次置备核对结果（`inspectNotebook()` 之后调；它是**唯一**写这张表的地方）。 */
  recordProvisioning(notebookId: string, input: { designOk: boolean; revsLimit: string | null; syncInfoOk: boolean; now?: number }): void {
    const now = input.now ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO notebook_provisioning (notebook_id, design_ok, revs_limit, sync_info_ok, last_checked)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(notebook_id) DO UPDATE SET
           design_ok = excluded.design_ok,
           revs_limit = excluded.revs_limit,
           sync_info_ok = excluded.sync_info_ok,
           last_checked = excluded.last_checked`,
      )
      .run(notebookId, input.designOk ? 1 : 0, input.revsLimit, input.syncInfoOk ? 1 : 0, now);
  }

  /** 审计写入（**永不包含正文或密钥材料**，§4.3）。 */
  audit(event: { actorId: string | null; action: string; target?: string | null; ip?: string | null; detail?: string | null; now?: number }): void {
    this.db
      .prepare("INSERT INTO audit (at, actor_id, action, target, ip, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .run(event.now ?? Date.now(), event.actorId, event.action, event.target ?? null, event.ip ?? null, event.detail ?? null);
  }

  /** 审计尾部（控制台用；倒序）。 */
  recentAudit(limit = 50): { at: number; actorId: string | null; action: string; target: string | null; ip: string | null; detail: string | null }[] {
    const rows = this.db.prepare("SELECT * FROM audit ORDER BY at DESC LIMIT ?").all(limit) as unknown as {
      at: number;
      actor_id: string | null;
      action: string;
      target: string | null;
      ip: string | null;
      detail: string | null;
    }[];
    return rows.map((row) => ({ at: row.at, actorId: row.actor_id, action: row.action, target: row.target, ip: row.ip, detail: row.detail }));
  }
}

/** 建的笔记本是否超出配额（**只拦写入，不拦读取**）。 */
export function assertNotebookQuota(currentNotebooks: number, limit: number): void {
  if (currentNotebooks >= limit) {
    throw new NotebookError("quota", `笔记本数量已达配额上限（${limit}）`);
  }
}
