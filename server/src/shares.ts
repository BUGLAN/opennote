/**
 * 公开分享（一次性快照）的控制面。
 *
 * ## 它是什么、不是什么
 *
 * 用户在客户端右键一个文件选「分享」，客户端把这个文件**此刻**的字节传上来，服务端存一份、
 * 发一个公开链接（`/s/<id>` 是只读网页，`/s/<id>/raw` 是原文件）。
 *
 * - 它是**快照**：之后本地怎么改都不会更新它（要新内容就再分享一次，得到新链接）；
 * - 它**不参与同步**：不在任何笔记本里、没有 did / rev / CAS，客户端也不会再碰它；
 * - 它**是明文**：哪怕来源笔记本是端到端加密的 —— 公开就意味着服务端（和任何拿到链接的人）
 *   都能读。客户端在生成之前要把这一点说清楚。
 *
 * ## 存在哪
 *
 * | 什么 | 在哪 | 为什么 |
 * | --- | --- | --- |
 * | 谁、何时、文件名、大小、撤销了没有 | SQLite `shares` 表（本文件） | 控制面：配额、审计、删账号级联 |
 * | 快照的字节 | CouchDB 的 `opennote-shares` 库，一条文档一个附件 | `db.ts` 的纪律：SQLite 永不放笔记字节 |
 *
 * 公开页**以 SQLite 为准**判断「还在不在」：行没了或已撤销 ⇒ 404，哪怕 CouchDB 里字节还在
 * （撤销时会顺手删掉，删失败也不影响链接失效）。
 */

import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CouchClient } from "./couch/client";
import { buildSecurityDoc } from "./couch/design";

/** 存快照字节的 CouchDB 库（与笔记本的 `nb-<uuid>` 不同名，不会撞）。 */
export const SHARE_DATABASE = "opennote-shares";

export interface ShareRow {
  id: string;
  account_id: string;
  name: string;
  content_type: string;
  size: number;
  sha256: string;
  created_at: number;
  revoked_at: number | null;
}

export interface ShareReservationInput {
  accountId: string;
  name: string;
  contentType: string;
  size: number;
  sha256: string;
  now: number;
}

export type ShareReservationResult = { share: ShareRow } | { quotaExceeded: true; bytesUsed: number };

export interface ShareSnapshotCleanupResult {
  deleted: number;
  failed: number;
  pending: number;
}

/** 文件名的上限（与常见文件系统的 255 一致）。 */
export const SHARE_NAME_MAX = 255;

/**
 * 校验并整理客户端给的文件名：只留最后一段（不收路径）、去掉控制字符、两端空白。
 * 不合格返回 `null`（调用方回 400）。
 */
export function cleanShareName(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  const last = raw.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const name = last.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (name === "" || name === "." || name === ".." || name.length > SHARE_NAME_MAX) return null;
  return name;
}

/**
 * 扩展名 → `content-type`。**由服务端定，不信客户端**：公开链接上发出去的类型决定了
 * 浏览器怎么对待这些字节，不能让上传的人说了算。不认识的一律 `application/octet-stream`（下载）。
 *
 * Markdown 发成 `text/plain`：浏览器直接打开 `/raw` 时能读到原文，而不是弹下载框。
 */
const CONTENT_TYPES: Record<string, string> = {
  md: "text/plain; charset=utf-8",
  markdown: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  csv: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  canvas: "application/json; charset=utf-8",
  json: "application/json; charset=utf-8",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
};

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function contentTypeFor(name: string): string {
  return CONTENT_TYPES[extensionOf(name)] ?? "application/octet-stream";
}

/** 新分享的 id：128 位随机数，base64url（22 字符，见 `shareIdSchema`）。 */
export function newShareId(): string {
  return randomBytes(16).toString("base64url");
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 删除一份快照文档；文档已经不存在也算成功。 */
export async function deleteShareSnapshot(couch: CouchClient, shareId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const doc = await couch.getDoc(SHARE_DATABASE, shareId);
    if (!doc || doc._deleted === true) return;
    if (!doc._rev) throw new Error("分享快照文档缺少 revision");
    const result = await couch.putDoc(SHARE_DATABASE, { _id: shareId, _rev: String(doc._rev), _deleted: true });
    if (!("conflict" in result)) return;
  }
  throw new Error("删除分享快照时连续发生 revision 冲突");
}

export class ShareStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: ShareReservationInput): ShareRow {
    const row = this.makeRow(input);
    this.insert(row);
    return row;
  }

  /**
   * 在同一写事务里重算配额并插入占位行。
   *
   * 事务外的「先读用量、再插入」会在两个并发请求之间留下窗口：两边都读到同一份
   * 剩余额度，最后都插入成功。`BEGIN IMMEDIATE` 让本实例和多实例部署共用同一把
   * SQLite 写锁，后到者一定看见先到者提交的占位行。
   *
   * `usedBytes` 在拿锁后执行；路由用它把笔记本占用与分享占用合在一起算。
   * `limit <= 0` 表示不限，仍走同一插入路径。
   */
  createWithinQuota(input: ShareReservationInput, options: { limit: number; usedBytes: () => number }): ShareReservationResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (options.limit > 0) {
        const bytesUsed = options.usedBytes() + this.activeBytesOf(input.accountId);
        if (bytesUsed + input.size > options.limit) {
          this.db.exec("ROLLBACK");
          return { quotaExceeded: true, bytesUsed };
        }
      }
      const row = this.makeRow(input);
      this.insert(row);
      this.db.exec("COMMIT");
      return { share: row };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private makeRow(input: ShareReservationInput): ShareRow {
    const row: ShareRow = {
      id: newShareId(),
      account_id: input.accountId,
      name: input.name,
      content_type: input.contentType,
      size: input.size,
      sha256: input.sha256,
      created_at: input.now,
      revoked_at: null,
    };
    return row;
  }

  private insert(row: ShareRow): void {
    this.db
      .prepare("INSERT INTO shares (id, account_id, name, content_type, size, sha256, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)")
      .run(row.id, row.account_id, row.name, row.content_type, row.size, row.sha256, row.created_at);
  }

  /** 读一条（含已撤销的；调用方自己判 `revoked_at`）。 */
  find(id: string): ShareRow | null {
    const row = this.db.prepare("SELECT * FROM shares WHERE id = ?").get(id) as unknown as ShareRow | undefined;
    return row ?? null;
  }

  /** 还能公开访问的那一条；不存在或已撤销返回 `null`。 */
  findActive(id: string): ShareRow | null {
    const row = this.find(id);
    return row && row.revoked_at === null ? row : null;
  }

  /** 撤销（幂等：已撤销的再撤一次返回 false）。 */
  revoke(id: string, now: number): boolean {
    const result = this.db.prepare("UPDATE shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id);
    return Number(result.changes) > 0;
  }

  /** 一个账号仍然有效的分享占了多少字节（算进空间配额）。 */
  activeBytesOf(accountId: string): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM shares WHERE account_id = ? AND revoked_at IS NULL").get(accountId) as unknown as {
      total: number;
    };
    return Number(row.total);
  }

  /** 一个账号的全部分享 id，含已撤销但可能没清掉字节的。 */
  listIdsForAccount(accountId: string): string[] {
    return (
      this.db.prepare("SELECT id FROM shares WHERE account_id = ? ORDER BY created_at ASC").all(accountId) as unknown as { id: string }[]
    ).map((row) => row.id);
  }

  /** 把待删的快照 id 记进清理队列；应由账号删除事务调用，保证账号、分享行与队列一起提交。 */
  enqueueSnapshotCleanup(accountId: string, shareIds: readonly string[], now: number): void {
    const insert = this.db.prepare("INSERT OR IGNORE INTO share_cleanup (share_id, account_id, queued_at) VALUES (?, ?, ?)");
    for (const shareId of shareIds) insert.run(shareId, accountId, now);
  }

  pendingSnapshotCleanupCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM share_cleanup").get() as unknown as { n: number };
    return Number(row.n);
  }

  /** 依次清理队列里的 CouchDB 文档；失败的留在队列里，下一次调用继续重试。 */
  async cleanupQueuedSnapshots(couch: CouchClient, now = Date.now()): Promise<ShareSnapshotCleanupResult> {
    const rows = this.db.prepare("SELECT share_id FROM share_cleanup ORDER BY queued_at ASC, share_id ASC").all() as unknown as { share_id: string }[];
    let deleted = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await deleteShareSnapshot(couch, row.share_id);
        this.db.prepare("DELETE FROM share_cleanup WHERE share_id = ?").run(row.share_id);
        deleted += 1;
      } catch (error) {
        failed += 1;
        this.db
          .prepare("UPDATE share_cleanup SET attempts = attempts + 1, last_attempt_at = ?, last_error = ? WHERE share_id = ?")
          .run(now, String(error).slice(0, 1000), row.share_id);
      }
    }
    return { deleted, failed, pending: this.pendingSnapshotCleanupCount() };
  }
}

/**
 * 确保 `opennote-shares` 库存在且只有 `sync` 服务账号能读写（**幂等**）。
 *
 * 用 admin 凭据（与笔记本置备同一条纪律，`provisioning.ts`）。每个进程只做一次：
 * 成功后记住，失败则清掉记忆、下次请求再试。
 */
export function shareDatabaseProvisioner(options: { couchAdmin: CouchClient; syncUser: string }): () => Promise<void> {
  let ready: Promise<void> | null = null;
  return () => {
    ready ??= (async () => {
      await options.couchAdmin.createDatabase(SHARE_DATABASE);
      await options.couchAdmin.putSecurity(SHARE_DATABASE, buildSecurityDoc({ syncUser: options.syncUser }));
    })().catch((error: unknown) => {
      ready = null;
      throw error;
    });
    return ready;
  };
}
