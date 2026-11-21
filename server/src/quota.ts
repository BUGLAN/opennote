/**
 * 账号级空间配额账本（笔记本 + 公开分享 + 在途预占）。
 *
 * ## 为什么必须只有一份
 *
 * 笔记本写入和公开分享都会让账号的占用变大，但它们原先各算一套：笔记本只看
 * `notebook_usage`，分享只看 `shares`，两边都看不见对方的**在途写入**（预占）。
 * 于是两个请求可以同时通过检查、再一起落盘，把账号配额突破；界面上显示的用量
 * 也只算笔记本，用户看不到真实剩余空间。
 *
 * 这里把「已用」定义成一个函数：`notebook_usage`（未删除的库）+ 未撤销的分享
 * + 未过期的 `quota_reservations`。笔记本写、分享创建都只在 `reserve()` 里
 * 通过 `BEGIN IMMEDIATE` 读写这个总数并插入自己的预占；成功后再用 `settle()`
 * 在同一事务里把预占换成真实资源（笔记本字节或分享行）。
 *
 * ## 为什么仍然要预占
 *
 * 预占不是缓存，而是跨网络往返的**持久证据**：`PUT /v1/file` 在 CouchDB 写入
 * 之前检查配额，写成功后才记账；分享创建也要先写快照字节。没有预占时，并发
 * 请求会看到同一份旧用量。`BEGIN IMMEDIATE` 让本实例和多实例部署共用同一把
 * SQLite 写锁；`expires_at` 是进程崩溃后的兜底，下一次预占会顺手清理过期行。
 */

import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface AccountQuotaUsage {
  /** 三部分之和：配额判定、`/me` 与控制台都读这一个数。 */
  bytesUsed: number;
  /** 名下未删除笔记本的正文占用。 */
  notebookBytes: number;
  /** 未撤销公开分享的快照占用。 */
  shareBytes: number;
  /** 已经通过检查、还没结算的在途写入。 */
  reservedBytes: number;
}

export interface QuotaReservation {
  id: string;
  accountId: string;
  bytes: number;
}

export type ReserveQuotaResult = { reservation: QuotaReservation } | { quotaExceeded: true; bytesUsed: number };

export interface ReserveQuotaInput {
  accountId: string;
  bytes: number;
  /** ≤ 0 视为不限。 */
  limit: number;
  now?: number;
  ttlMs?: number;
}

/** 预占 id：与笔记本 id 无关，但只要在表里唯一即可（128 位随机数）。 */
function newReservationId(): string {
  return randomBytes(16).toString("hex");
}

export class QuotaLedger {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * 账号当前的总占用。**这是唯一的用量函数**：`/me`、控制台、两条预占路径
   * 与配额错误响应都从这里取数，不再各写一条 SQL。
   */
  usageOf(accountId: string, now = Date.now()): AccountQuotaUsage {
    const row = this.db
      .prepare(
        `SELECT
           (SELECT COALESCE(SUM(u.bytes_used), 0)
              FROM notebook_usage u
              JOIN notebooks n ON n.id = u.notebook_id
             WHERE n.owner_id = ? AND n.deleted_at IS NULL) AS notebook_bytes,
           (SELECT COALESCE(SUM(s.size), 0)
              FROM shares s
             WHERE s.account_id = ? AND s.revoked_at IS NULL) AS share_bytes,
           (SELECT COALESCE(SUM(r.bytes), 0)
              FROM quota_reservations r
             WHERE r.account_id = ? AND r.expires_at > ?) AS reserved_bytes`,
      )
      .get(accountId, accountId, accountId, now) as unknown as {
      notebook_bytes: number;
      share_bytes: number;
      reserved_bytes: number;
    };
    return {
      bytesUsed: row.notebook_bytes + row.share_bytes + row.reserved_bytes,
      notebookBytes: row.notebook_bytes,
      shareBytes: row.share_bytes,
      reservedBytes: row.reserved_bytes,
    };
  }

  /**
   * 原子预占一次增长：清理过期行、重算「笔记本 + 分享 + 在途」、检查上限、
   * 插入本次预占都在同一个 `BEGIN IMMEDIATE` 里。
   */
  reserve(input: ReserveQuotaInput): ReserveQuotaResult {
    const bytes = Math.trunc(input.bytes);
    if (!Number.isFinite(bytes) || bytes <= 0) throw new Error("预占字节数必须是正整数");
    const now = input.now ?? Date.now();
    const ttlMs = Math.max(1, Math.trunc(input.ttlMs ?? 10 * 60_000));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // 过期预占属于已经死掉的写入，不能继续占着配额。
      this.db.prepare("DELETE FROM quota_reservations WHERE expires_at <= ?").run(now);
      const usage = this.usageOf(input.accountId, now);
      if (input.limit > 0 && usage.bytesUsed + bytes > input.limit) {
        this.db.exec("COMMIT");
        return { quotaExceeded: true, bytesUsed: usage.bytesUsed };
      }
      const id = newReservationId();
      this.db
        .prepare("INSERT INTO quota_reservations (id, account_id, bytes, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, input.accountId, bytes, now, now + ttlMs);
      this.db.exec("COMMIT");
      return { reservation: { id, accountId: input.accountId, bytes } };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 当前仍未结算的预占（控制台诊断 / 用例用）。 */
  reservedBytesOf(accountId: string, now = Date.now()): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(bytes), 0) AS total FROM quota_reservations WHERE account_id = ? AND expires_at > ?")
      .get(accountId, now) as unknown as { total: number } | undefined;
    return row?.total ?? 0;
  }

  /**
   * 结算：删除预占，并在**同一个事务**里落下真实资源。
   *
   * 笔记本写入传「记增长」，分享创建传「插入 shares 行」。两者都必须在删除预占的
   * 同一事务里完成，否则并发读会看到预占和真实资源同时存在（用量凭空翻倍），
   * 或者两者都不存在（短暂低估）。
   */
  settle(reservationId: string | null, apply: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (reservationId !== null) this.db.prepare("DELETE FROM quota_reservations WHERE id = ?").run(reservationId);
      apply();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 写入失败 / 409 / 超时：只释放预占，不动已用量。 */
  release(reservationId: string): void {
    this.db.prepare("DELETE FROM quota_reservations WHERE id = ?").run(reservationId);
  }
}
