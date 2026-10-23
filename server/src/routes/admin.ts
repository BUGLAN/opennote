/**
 * `/v1/admin/*`：管理接口（`docs/执行-三端同步…` §4.7、§10.1 M8/M10/M11、§7.1）。
 *
 * ## 一条贯穿全文件的纪律：**拒绝发生在读取之前**
 *
 * §10.1 M8/M10 的原文要求是「非管理员访问 → 403 **且不泄露任何账号信息**」。
 * 这句要求有一个很具体的落地形式 ——
 *
 * ```ts
 * // ❌ 读出来再过滤：错误分支里漏掉一个字段就是一次泄露
 * const rows = db.all(); if (!isAdmin) return 403; return rows.map(sanitize);
 *
 * // ✅ 先拒了再说：`requireAdmin()` 在**任何** SELECT 之前返回
 * const denied = requireAdmin(c); if (denied) return denied;
 * ```
 *
 * 所以本文件的每个处理器**第一句**都是 `requireAdmin()`，此后才碰数据库。
 * 判断依据是 `accounts.is_admin`（**不是**请求体里的任何东西，也不是自报的角色）。
 *
 * ## 管理接口**不返回**的东西
 *
 * - 任何 `auth_hash`（它是 `sha256(authToken)` —— 泄露了就能直接冒充，虽然反推不出令牌，
 *   但它本身就是「用户名」那一半）
 * - 任何 `wrapped_enc_root`（**服务端自己也解不开**，但没必要发出去）
 * - 任何明文路径 / 笔记内容（那在 CouchDB 里，管理接口不碰）
 *
 * 有一条用例直接断言这些字段名**不出现在响应文本里**。
 */

import { Hono } from "hono";
import { adminAccountSummarySchema, adminServerInfoSchema, parseContract, type Quota } from "../../../shared/contract";
import { AccountError, AccountStore, type AccountRow } from "../auth/accounts";
import type { CouchClient } from "../couch/client";
import type { NotebookStore } from "../notebooks";
import type { ServerConfig } from "../config";
import { bearerToken } from "./account";

export interface AdminRoutesDeps {
  accounts: AccountStore;
  notebooks: NotebookStore;
  config: ServerConfig;
  /** 运行时客户端（报 CouchDB 版本用）。 */
  couch: CouchClient;
  audit?: (event: { actorId: string | null; action: string; target?: string | null; ip?: string | null; detail?: string | null }) => void;
  /** 进程启动时间（算 uptime；测试可注入）。 */
  startedAt?: number;
  now?: () => number;
}

/** 默认邀请码有效期：7 天（管理员发码给人，通常不会当天就用）。 */
export const DEFAULT_INVITE_TTL_SECONDS = 7 * 24 * 3600;

export function createAdminRoutes(deps: AdminRoutesDeps): Hono {
  const routes = new Hono();
  const json = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

  /**
   * **管理员闸门。**
   *
   * 返回 `Response` = 已经可以提前返回（**此刻还没有碰过数据库里的任何业务表**）；
   * 返回 `AccountRow` = 通过。
   *
   * ⚠️ 401（没令牌）与 403（有令牌但不是管理员）要分开：前者是「你没登录」，
   * 后者是「你登录了但没权限」——**两者都不透露「有没有别的账号」**。
   */
  const requireAdmin = (c: { req: { header: (name: string) => string | undefined } }): AccountRow | Response => {
    const token = bearerToken(c.req.header("authorization"));
    if (!token) return json({ error: "缺少 Authorization: Bearer 令牌", code: "unauthorized" }, 401);
    let row: AccountRow;
    try {
      row = deps.accounts.authenticate(token);
    } catch (error) {
      if (error instanceof AccountError) {
        const disabled = error.rejection === "disabled";
        return json({ error: error.message, code: disabled ? "disabled" : "unauthorized" }, disabled ? 403 : 401);
      }
      throw error;
    }
    if (row.is_admin !== 1) return json({ error: "需要管理员权限", code: "forbidden" }, 403);
    return row;
  };

  const quotaFor = (accountId: string): Quota => {
    const usage = deps.notebooks.quotaOf(accountId);
    return {
      bytesUsed: usage.bytesUsed,
      bytesLimit: deps.config.defaultAccountQuotaBytes,
      notebooks: usage.notebooks,
      notebooksLimit: deps.config.defaultAccountQuotaNotebooks,
    };
  };

  /* -------------------------------------------------------------- 账号 */

  /** 账号列表（控制台主页）。**绝不带 `auth_hash` / `wrapped_enc_root`。** */
  routes.get("/accounts", (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;

    const rows = deps.accounts.list();
    const accounts = rows.map((row) =>
      parseContract(
        adminAccountSummarySchema,
        {
          accountId: row.id,
          label: row.label,
          status: row.status === "disabled" ? "disabled" : "active",
          isAdmin: row.is_admin === 1,
          quota: quotaFor(row.id),
          createdAt: row.created_at,
          lastSeenAt: row.last_seen_at,
        },
        "GET /v1/admin/accounts 条目",
      ),
    );
    return json({ accounts, total: accounts.length }, 200);
  });

  /** 禁用 / 启用账号（**数据保留**，不是删账号）。 */
  routes.post("/accounts/:id/status", async (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;

    const accountId = c.req.param("id");
    const raw = (await c.req.json().catch(() => null)) as { status?: unknown } | null;
    const status = raw?.status === "disabled" ? "disabled" : raw?.status === "active" ? "active" : null;
    if (status === null) return json({ error: "status 必须是 active 或 disabled", code: "bad-request" }, 400);

    // 管理员不能把自己锁在外面（否则控制台会永久失去管理入口 —— 只能手工改库）。
    if (accountId === admin.id && status === "disabled") {
      return json({ error: "不能禁用自己（会让你失去管理入口）", code: "bad-request" }, 400);
    }

    const changed = deps.accounts.setStatus(accountId, status);
    if (!changed) return json({ error: "账号不存在", code: "not-found" }, 404);
    deps.audit?.({ actorId: admin.id, action: status === "disabled" ? "disable_account" : "enable_account", target: accountId, ip: null, detail: null });
    return new Response(null, { status: 204 });
  });

  /** 删账号（级联：独占笔记本的库真删；有共享成员的**移交**，§7.1）。 */
  routes.delete("/accounts/:id", async (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;
    const accountId = c.req.param("id");
    if (accountId === admin.id) return json({ error: "不能删除自己（会让你失去管理入口）", code: "bad-request" }, 400);

    const target = deps.accounts.findById2(accountId);
    if (!target) return json({ error: "账号不存在", code: "not-found" }, 404);

    /*
     * ★ **先算出「哪些独占库要真删」，交给编排去清控制面**，再删库。
     *
     * 顺序是刻意的：库（CouchDB）与控制面（SQLite）跨两个系统、没有共同事务。
     * 先清控制面、后删库 ⇒ 最坏是留下一个没人引用的库（可人工清）；
     * 反过来 ⇒ 先删了库、控制面还指着它（用户会看到「这个笔记本还在」但打不开）。
     *
     * 编排在 `deleteAccountCascade()`（与控制台走同一条），这里只负责删库。
     */
    const owned = deps.notebooks.listForAccount(accountId).filter((item) => item.role === "owner");
    const cascade = deps.notebooks.deleteAccountCascade(accountId);
    let databasesDeleted = 0;
    for (const notebookId of cascade.exclusiveNotebooks) {
      const notebook = owned.find((item) => item.notebook.id === notebookId)?.notebook;
      if (!notebook) continue;
      try {
        await deps.couch.deleteDatabase(notebook.db_name);
        databasesDeleted += 1;
      } catch (error) {
        // 删库失败**不**阻断账号删除（账号已经没用了），但如实记审计。
        deps.audit?.({ actorId: admin.id, action: "delete_database_failed", target: notebook.id, ip: null, detail: String(error) });
      }
    }
    const notebooksTransferred = cascade.transferredNotebooks.length;
    const deleted = deps.accounts.delete(accountId);
    if (!deleted) return json({ error: "账号不存在", code: "not-found" }, 404);
    deps.audit?.({
      actorId: admin.id,
      action: "delete_account",
      target: accountId,
      ip: null,
      detail: `databasesDeleted=${databasesDeleted},notebooksTransferred=${notebooksTransferred}`,
    });
    return json({ databasesDeleted, notebooksTransferred }, 200);
  });

  /* -------------------------------------------------------------- 邀请码 */

  /**
   * 生成注册邀请码。
   *
   * 明文**只在这一次响应里出现** —— 库里只存哈希，事后连我们也拿不回明文
   * （与引导码同一条纪律，§4.12）。这一点必须写进控制台文案，否则运维会以为
   * 「以后还能再查一次」。
   */
  routes.post("/invites", async (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;
    const raw = (await c.req.json().catch(() => null)) as { expiresInSeconds?: unknown; maxUses?: unknown; label?: unknown } | null;
    const expiresInSeconds =
      typeof raw?.expiresInSeconds === "number" && Number.isFinite(raw.expiresInSeconds) && raw.expiresInSeconds > 0
        ? Math.min(raw.expiresInSeconds, 365 * 24 * 3600)
        : DEFAULT_INVITE_TTL_SECONDS;
    const maxUses = typeof raw?.maxUses === "number" && Number.isFinite(raw.maxUses) && raw.maxUses > 0 ? Math.min(Math.floor(raw.maxUses), 1000) : 1;

    const created = deps.accounts.createInvite({ createdBy: admin.id, expiresInSeconds, maxUses });
    deps.audit?.({ actorId: admin.id, action: "create_invite", target: null, ip: null, detail: `maxUses=${maxUses}` });
    return json({ code: created.code, expiresAt: created.expiresAt, maxUses: created.maxUses }, 201);
  });

  /** 作废邀请码。 */
  routes.delete("/invites/:code", (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;
    const code = c.req.param("code");
    // 作废是**幂等**的：已经作废过返回 204（不是 404）—— 目标状态已经达成。
    const changed = deps.accounts.revokeInvite(code);
    deps.audit?.({ actorId: admin.id, action: "revoke_invite", target: null, ip: null, detail: changed ? "revoked" : "already-revoked-or-unknown" });
    return new Response(null, { status: 204 });
  });

  /* ---------------------------------------------------------- 服务器信息 */

  /** 服务器信息（控制台顶栏 + 「CouchDB 版本」）。 */
  routes.get("/server", async (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;

    let couchVersion: string | null = null;
    try {
      couchVersion = (await deps.couch.version()).version;
    } catch {
      couchVersion = null;
    }
    const now = deps.now?.() ?? Date.now();
    const startedAt = deps.startedAt ?? now;

    const body = parseContract(
      adminServerInfoSchema,
      {
        protocolVersion: deps.config.protocolVersionExpected,
        couchVersion,
        // 库数量与总体积要逐个库问 CouchDB（贵）—— 这里只报**控制面**已知的笔记本数，
        // 免得一个管理页面把 CouchDB 打满。真正的用量在「配额重算」作业里（§4.11）。
        dbCount: deps.notebooks.totalNotebooks(),
        totalBytes: 0,
        accountCount: deps.accounts.count(),
        uptimeSeconds: Math.max(0, (now - startedAt) / 1000),
      },
      "GET /v1/admin/server",
    );
    return json(body, 200);
  });

  /** 审计尾部（控制台「最近动作」）。 */
  routes.get("/audit", (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;
    const limitRaw = c.req.query("limit");
    const limit = limitRaw === undefined ? 50 : Math.min(500, Math.max(1, Number.parseInt(limitRaw, 10) || 50));
    return json({ events: deps.notebooks.recentAudit(limit) }, 200);
  });

  /* ---------------------------------------------------------------- 诊断 */

  /** 置备状态自检提示（**只读**，只报控制面已知的信息）。 */
  routes.get("/provisioning", (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;
    return json(
      {
        protocolVersion: deps.config.protocolVersionExpected,
        expectations: {
          revsLimit: 1000,
          designDoc: "_design/opennote",
          syncInfoDoc: "syncinfo",
        },
        // 真正的逐库核对走 `inspectNotebook()`（`provisioning.ts`），由控制台按需触发 ——
        // 一次性把 1000 个库全查一遍会把 CouchDB 打满（U22 那条待核实项正与此有关）。
        note: "逐库核对请对单个笔记本触发（GET /v1/notebooks/:id/inspection）",
      },
      200,
    );
  });

  /* ---------------------------------------------------------- 冒烟用夹具 */

  /*
   * ⚠️ **这里刻意没有「生成引导码」的 HTTP 端点。**
   *
   * 引导码只能由 **CLI** 生成（`pnpm cli:server bootstrap-admin`，直连数据库、明文只打印一次）。
   * 暴露成 HTTP 端点的后果是：任何一次管理员账号泄露 ⇒「能无限造管理员」。
   * §4.12 把引导码放在 CLI 里正是为了这个。
   *
   * 需要它的话看 `cli.ts` 的 `bootstrapAdmin()`（它直接调 `AccountStore.createBootstrapCode()`）。
   */

  return routes;
}
