/**
 * 公开分享（一次性快照）的接口与公开页（模块头的来龙去脉见 `../shares.ts`）。
 *
 * | 路径 | 谁能用 | 是什么 |
 * | --- | --- | --- |
 * | `POST /v1/shares?name=<文件名>` | 登录的账号（Bearer） | 请求体 = 文件此刻的原始字节 → 201 `ShareCreated` |
 * | `DELETE /v1/shares/:id` | 分享的作者 | 撤销：链接立刻失效，快照字节一并删除 |
 * | `GET /s/:id` | 任何人 | 只读网页（`sharePage.ts`） |
 * | `GET /s/:id/raw` | 任何人 | 原文件本身（`?download=1` 改成下载） |
 *
 * 三条纪律：
 * 1. **不按文件类型拦**：什么文件都能分享；类型只决定网页上怎么预览、`/raw` 发什么 `content-type`
 *    （由服务端按扩展名定，不信上传的人）。
 * 2. **公开面不泄露存在性**：不存在、已撤销、作者被停用 / 删除，一律同一个 404。
 * 3. **快照不随原文件变**：服务端只存这一次上传的字节，没有任何「更新」接口。
 */

import { Hono, type Context } from "hono";
import { parseContract, shareCreatedSchema, shareIdSchema } from "../../../shared/contract";
import { AccountError, type AccountRow, type AccountStore } from "../auth/accounts";
import { clientIpFrom, type ServerConfig } from "../config";
import type { CouchClient } from "../couch/client";
import { formatBytes } from "../activity";
import type { NotebookStore } from "../notebooks";
import { securityHeaders } from "../panelSecurity";
import type { SettingsStore } from "../settings";
import {
  SHARE_DATABASE,
  cleanShareName,
  contentTypeFor,
  newShareId,
  sha256Hex,
  shareDatabaseProvisioner,
  type ShareRow,
  type ShareStore,
} from "../shares";
import { SHARE_PAGE_CSP, SHARE_RAW_CSP, renderShareMissing, renderSharePage } from "../sharePage";
import { bearerToken } from "./auth";

export interface ShareRoutesDeps {
  accounts: AccountStore;
  notebooks: NotebookStore;
  shares: ShareStore;
  config: ServerConfig;
  /** 运行时客户端（`sync` 账号）：读写快照字节。 */
  couch: CouchClient;
  /** admin 客户端：只用来第一次建 `opennote-shares` 库。 */
  couchAdmin: CouchClient;
  settings?: SettingsStore;
  audit?: (event: { actorId: string | null; action: string; target?: string | null; ip?: string | null; detail?: string | null }) => void;
  now?: () => number;
}

/** `Content-Disposition`：ASCII 兜底名 + RFC 5987 的 UTF-8 原名（中文文件名下载下来不乱码）。 */
export function contentDisposition(kind: "inline" | "attachment", name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "file";
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function createShareRoutes(deps: ShareRoutesDeps): Hono {
  const routes = new Hono();
  const now = (): number => deps.now?.() ?? Date.now();
  const https = deps.config.externalBaseUrl.startsWith("https:");
  const ensureDatabase = shareDatabaseProvisioner({ couchAdmin: deps.couchAdmin, syncUser: deps.config.couchUser });
  const json = (body: unknown, status: number): Response =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });

  /** 与 `/v1/*` 其它接口同一条认证链路。 */
  const authenticate = (c: Context): AccountRow | Response => {
    const token = bearerToken(c.req.header("authorization"));
    if (!token) return json({ error: "缺少 Authorization: Bearer 令牌", code: "unauthorized" }, 401);
    try {
      const account = deps.accounts.authenticate(token);
      deps.accounts.touch(account.id);
      return account;
    } catch (error) {
      if (error instanceof AccountError) {
        const disabled = error.rejection === "disabled";
        return json({ error: error.message, code: disabled ? "disabled" : "unauthorized" }, disabled ? 403 : 401);
      }
      throw error;
    }
  };

  /** 公开页能看的那一条：存在、没撤销、作者还是正常账号。 */
  const visible = (id: string): ShareRow | null => {
    if (!shareIdSchema.safeParse(id).success) return null;
    const share = deps.shares.findActive(id);
    if (!share) return null;
    const owner = deps.accounts.findById(share.account_id);
    return owner && owner.status === "active" ? share : null;
  };

  const publicUrl = (id: string): string => `${deps.config.externalBaseUrl}/s/${id}`;

  /* ------------------------------------------------------------ 创建 */

  routes.post("/v1/shares", async (c) => {
    const account = authenticate(c);
    if (account instanceof Response) return account;

    const name = cleanShareName(c.req.query("name"));
    if (!name) return json({ error: "缺少或不合法的 name 参数（文件名，1–255 个字符，不含路径）", code: "bad-request" }, 400);

    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength > deps.config.maxFileBytes) {
      return json({ error: `文件超过上限（${formatBytes(deps.config.maxFileBytes)}）`, code: "too-large" }, 413);
    }

    /* 快照算进作者的空间配额（与笔记本同一个上限；≤ 0 视为不限）。 */
    const limit = account.quota_bytes ?? deps.settings?.get("defaultQuotaBytes") ?? deps.config.defaultAccountQuotaBytes;
    const createdAt = now();
    const shareId = newShareId();
    /* 响应契约是服务端自己产出的东西；在写 SQLite / CouchDB 前先校验，失败时现场干净。 */
    const body = parseContract(
      shareCreatedSchema,
      {
        id: shareId,
        url: publicUrl(shareId),
        rawUrl: `${publicUrl(shareId)}/raw`,
        name,
        size: bytes.byteLength,
        createdAt,
      },
      "POST /v1/shares",
    );
    await ensureDatabase();
    const reserved = deps.shares.createWithinQuota(
      {
        id: shareId,
        accountId: account.id,
        name,
        contentType: contentTypeFor(name),
        size: bytes.byteLength,
        sha256: sha256Hex(bytes),
        now: createdAt,
      },
      { limit },
    );
    if ("quotaExceeded" in reserved) {
      return json(
        {
          error: `空间已满：已用 ${formatBytes(reserved.bytesUsed)}，配额 ${formatBytes(limit)}，这份快照还要 ${formatBytes(bytes.byteLength)}`,
          code: "quota",
          bytesUsed: reserved.bytesUsed,
          bytesLimit: limit,
        },
        413,
      );
    }
    const { share, reservationId } = reserved;
    /*
     * 先在账本事务里把预占换成 shares 行（删预占 + 插行原子完成），再去写快照。
     *
     * 行先于字节存在意味着写入期间用量**只会偏高、不会低估**，并发读写都看得见
     * 这次分享；任何后续失败都会撤销这一行并把快照 id 持久化进清理队列。
     */
    try {
      deps.shares.settleCreation({ share, reservationId });
    } catch (error) {
      deps.shares.releaseQuotaReservation(reservationId);
      throw error;
    }
    const ip = clientIpFrom(c.req.raw.headers, deps.config);
    /*
     * 占位行提交后，SQLite 与 CouchDB 没有共同事务：Couch 可能在回复超时前已经落盘。
     * 所以任何后续失败都先撤销并把 id 持久化进清理队列，再尽力立即删一次；删不掉就留给后台清扫。
     */
    const cleanUpFailedCreate = async (): Promise<void> => {
      try {
        deps.shares.revokeAndQueueSnapshotCleanup(share, now());
      } catch (queueError) {
        console.warn("[opennote-server] 创建分享失败后撤销并登记快照清理失败", queueError);
        return;
      }
      try {
        await deps.shares.cleanupQueuedSnapshot(deps.couch, share.id, now());
      } catch (cleanupError) {
        try {
          deps.audit?.({
            actorId: account.id,
            action: "share_create_snapshot_cleanup_failed",
            target: share.id,
            ip,
            detail: `pending=${deps.shares.pendingSnapshotCleanupCount()}`,
          });
        } catch (auditError) {
          console.warn("[opennote-server] 创建分享失败后记录快照清理失败审计时出错", auditError);
        }
        console.warn("[opennote-server] 创建分享失败后删快照字节失败（已留在清理队列）", cleanupError);
      }
    };

    /* 正文与元数据一次写进同一个 revision（与 `PUT /v1/file` 同一做法）。 */
    try {
      const written = await deps.couch.putDoc(SHARE_DATABASE, {
        _id: share.id,
        size: share.size,
        sha256: share.sha256,
        createdAt: share.created_at,
        _attachments: { blob: { content_type: "application/octet-stream", data: Buffer.from(bytes).toString("base64") } },
      });
      if ("conflict" in written) throw new Error("分享 id 撞车（极不可能）");
      deps.audit?.({ actorId: account.id, action: "share_create", target: share.id, ip, detail: `size=${share.size}` });
    } catch (error) {
      await cleanUpFailedCreate();
      throw error;
    }

    return json(body, 201);
  });

  /* ------------------------------------------------------------ 撤销 */

  routes.delete("/v1/shares/:id", async (c) => {
    const account = authenticate(c);
    if (account instanceof Response) return account;
    const id = c.req.param("id");
    const share = shareIdSchema.safeParse(id).success ? deps.shares.find(id) : null;
    // 别人的分享与不存在的分享不可区分。
    if (!share || share.account_id !== account.id) return json({ error: "没有这个分享", code: "not-found" }, 404);
    const ip = clientIpFrom(c.req.raw.headers, deps.config);
    /* 撤销与入队一起提交：链接先失效，字节能不能立刻删掉不影响撤销本身。 */
    if (deps.shares.revokeAndQueueSnapshotCleanup(share, now())) {
      deps.audit?.({ actorId: account.id, action: "share_revoke", target: share.id, ip, detail: null });
    }
    /* 提交后再尽力立即删一次；失败不影响撤销（公开页以 SQLite 为准，链接已经失效）。 */
    try {
      await deps.shares.cleanupQueuedSnapshot(deps.couch, share.id, now());
    } catch (error) {
      /* 队列行还在，管理端清扫会继续删；计数进审计，别让孤儿字节静默堆积。 */
      deps.audit?.({
        actorId: account.id,
        action: "share_revoke_snapshot_cleanup_failed",
        target: share.id,
        ip,
        detail: `pending=${deps.shares.pendingSnapshotCleanupCount()}`,
      });
      console.warn("[opennote-server] 撤销分享时删快照字节失败（链接已失效，已留在清理队列）", error);
    }
    return json(null, 204);
  });

  /* ------------------------------------------------------------ 公开页 */

  const html = (body: string, status: number): Response =>
    new Response(body, {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
        ...securityHeaders({ https, csp: SHARE_PAGE_CSP }),
        // 公开链接本身就是访问凭据：点出去的外链不带它。
        "referrer-policy": "no-referrer",
        "x-robots-tag": "noindex, nofollow",
      },
    });

  const loadBytes = async (share: ShareRow): Promise<Uint8Array | null> => {
    try {
      return await deps.couch.getAttachment(SHARE_DATABASE, share.id);
    } catch (error) {
      console.warn("[opennote-server] 读分享快照失败", error);
      return null;
    }
  };

  routes.get("/s/:id", async (c) => {
    const share = visible(c.req.param("id"));
    if (!share) return html(renderShareMissing(), 404);
    const bytes = await loadBytes(share);
    if (!bytes) return html(renderShareMissing(), 404);
    return html(renderSharePage(share, bytes, { host: new URL(deps.config.externalBaseUrl).host }), 200);
  });

  routes.get("/s/:id/raw", async (c) => {
    const share = visible(c.req.param("id"));
    const bytes = share ? await loadBytes(share) : null;
    if (!share || !bytes) return html(renderShareMissing(), 404);
    const etag = `"${share.sha256}"`;
    const headers: Record<string, string> = {
      "content-type": share.content_type,
      "content-disposition": contentDisposition(c.req.query("download") === "1" ? "attachment" : "inline", share.name),
      // 撤销要立刻生效：每次都回来问（没变就 304）。
      "cache-control": "no-cache",
      etag,
      ...securityHeaders({ https, csp: SHARE_RAW_CSP }),
      // 只允许被同源的分享页嵌（HTML 预览框）；全局默认是 DENY。
      "x-frame-options": "SAMEORIGIN",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
    };
    if (c.req.header("if-none-match") === etag) return new Response(null, { status: 304, headers });
    return new Response(bytes, { status: 200, headers: { ...headers, "content-length": String(bytes.byteLength) } });
  });

  return routes;
}
