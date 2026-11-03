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
 * - 任何 `password_hash` 与会话的 `token_hash`
 * - 任何 `wrapped_enc_root`（**服务端自己也解不开**，但没必要发出去）
 * - 任何明文路径 / 笔记内容（那在 CouchDB 里，管理接口不碰）
 *
 * 有一条用例直接断言这些字段名**不出现在响应文本里**。
 */

import { Hono } from "hono";
import { adminServerInfoSchema, emailSchema, parseContract } from "../../../shared/contract";
import { AccountError, AccountStore, accountLabel } from "../auth/accounts";
import type { CouchClient } from "../couch/client";
import type { NotebookStore } from "../notebooks";
import type { ServerConfig } from "../config";
import type { SettingsStore } from "../settings";
import { accountErrorResponse } from "./auth";
import { createAdminGate } from "./adminGate";
import { accountSummaries } from "./adminView";

export interface AdminRoutesDeps {
  accounts: AccountStore;
  notebooks: NotebookStore;
  config: ServerConfig;
  /** 运行时客户端（报 CouchDB 版本用）。 */
  couch: CouchClient;
  settings: SettingsStore;
  audit?: (event: { actorId: string | null; action: string; target?: string | null; ip?: string | null; detail?: string | null }) => void;
  /** 进程启动时间（算 uptime；测试可注入）。 */
  startedAt?: number;
  now?: () => number;
}

/** 列表里给的邀请 id：码的 sha256。 */
const HASH_ID = /^[0-9a-f]{64}$/;

/** 默认邀请码有效期：7 天（管理员发码给人，通常不会当天就用）。 */
export const DEFAULT_INVITE_TTL_SECONDS = 7 * 24 * 3600;

export function createAdminRoutes(deps: AdminRoutesDeps): Hono {
  const routes = new Hono();
  const json = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

  /** 管理员闸门（Bearer 或控制台 cookie，见 `adminGate.ts`）。每个处理器的第一句。 */
  const requireAdmin = createAdminGate(deps);

  /** 账号 id → 给人看的名字（账号已删除时退回截断的 id）。 */
  const labelOf = (accountId: string): string => {
    const row = deps.accounts.findById(accountId);
    return row ? accountLabel(row) : `账号 ${accountId.slice(0, 8)}`;
  };

  const joinUrl = (code: string): string => `${deps.config.externalBaseUrl}/join/${code}`;
  const resetUrl = (code: string): string => `${deps.config.externalBaseUrl}/reset/${code}`;
  const now = (): number => deps.now?.() ?? Date.now();

  /* -------------------------------------------------------------- 账号 */

  /** 账号列表（控制台主页）。**绝不带 `auth_hash` / `wrapped_enc_root`。** */
  routes.get("/accounts", (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;

    const accounts = accountSummaries(deps, deps.accounts.list(), now());
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
  /** 改配额 / 角色 / 显示名。`quotaBytes: null` = 跟随服务默认值。 */
  routes.patch("/accounts/:id", async (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;
    const accountId = c.req.param("id");
    if (!deps.accounts.findById(accountId)) return json({ error: "账号不存在", code: "not-found" }, 404);
    const raw = (await c.req.json().catch(() => null)) as { quotaBytes?: unknown; isAdmin?: unknown; displayName?: unknown } | null;
    if (raw === null || typeof raw !== "object") return json({ error: "请求体必须是对象", code: "bad-request" }, 400);

    if ("quotaBytes" in raw) {
      const quota = raw.quotaBytes;
      if (quota !== null && !(typeof quota === "number" && Number.isInteger(quota) && quota >= 0)) {
        return json({ error: "quotaBytes 必须是非负整数或 null", code: "bad-request" }, 400);
      }
      deps.accounts.setQuota(accountId, quota as number | null);
      deps.audit?.({ actorId: admin.id, action: "set_quota", target: accountId, ip: null, detail: String(quota) });
    }
    if (typeof raw.isAdmin === "boolean") {
      const result = deps.accounts.setAdmin(accountId, raw.isAdmin);
      if (!result.ok) return json({ error: "不能取消最后一个管理员（会让控制台永久进不去）", code: "last-admin" }, 409);
      if (result.changed) deps.audit?.({ actorId: admin.id, action: raw.isAdmin ? "grant_admin" : "revoke_admin", target: accountId, ip: null, detail: null });
    }
    if (raw.displayName === null || typeof raw.displayName === "string") {
      deps.accounts.setDisplayName(accountId, raw.displayName === null ? null : raw.displayName.slice(0, 80));
    }
    return new Response(null, { status: 204 });
  });

  /** 发重置密码链接（服务器不发邮件：链接由管理员转交）。 */
  routes.post("/accounts/:id/password-reset", (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;
    try {
      const created = deps.accounts.createPasswordReset({ accountId: c.req.param("id"), createdBy: admin.id, now: now() });
      deps.audit?.({ actorId: admin.id, action: "create_password_reset", target: c.req.param("id"), ip: null, detail: null });
      return json({ code: created.code, url: resetUrl(created.code), expiresAt: created.expiresAt }, 201);
    } catch (error) {
      if (error instanceof AccountError) return accountErrorResponse(error);
      throw error;
    }
  });

  /** 解绑 GitHub（管理员可以解掉没有密码的账号的唯一登录方式：之后给对方发设置密码链接）。 */
  routes.delete("/accounts/:id/github", (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;
    try {
      const removed = deps.accounts.unlinkIdentity(c.req.param("id"), "github", { requireOtherMethod: false });
      if (removed) deps.audit?.({ actorId: admin.id, action: "admin_unlink_github", target: c.req.param("id"), ip: null, detail: null });
      return new Response(null, { status: 204 });
    } catch (error) {
      if (error instanceof AccountError) return accountErrorResponse(error);
      throw error;
    }
  });

  routes.delete("/accounts/:id", async (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;
    const accountId = c.req.param("id");
    if (accountId === admin.id) return json({ error: "不能删除自己（会让你失去管理入口）", code: "bad-request" }, 400);

    const target = deps.accounts.findById(accountId);
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
      // 账号删掉之后就查不到名字了，所以名字跟着审计走（去掉逗号：detail 按逗号分字段）。
      detail: `databasesDeleted=${databasesDeleted},notebooksTransferred=${notebooksTransferred},label=${accountLabel(target).replace(/[,=]/g, " ")}`,
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
  routes.get("/invites", (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;
    const at = now();
    const invites = deps.notebooks.listInvites().map((invite) => ({
      ...invite,
      // 控制台只拿得到哈希（明文码只在生成那一刻返回过一次），作废 / 延长都用它当 id。
      id: invite.codeHash,
      state: invite.revokedAt !== null
        ? "revoked"
        : invite.uses >= invite.maxUses
          ? "used"
          : invite.expiresAt !== null && at > invite.expiresAt
            ? "expired"
            : "open",
      acceptedByLabel: invite.acceptedBy ? labelOf(invite.acceptedBy) : null,
    }));
    return json({ invites }, 200);
  });

  /**
   * 生成邀请链接。可选：绑定邮箱（绑定后只能用一次）、授予管理员、单独的配额、有效期、次数。
   * 明文码只在这个响应里出现一次。
   */
  routes.post("/invites", async (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;
    const raw = (await c.req.json().catch(() => null)) as {
      email?: unknown;
      grantAdmin?: unknown;
      quotaBytes?: unknown;
      expiresInSeconds?: unknown;
      maxUses?: unknown;
    } | null;
    const expiresInSeconds =
      typeof raw?.expiresInSeconds === "number" && Number.isFinite(raw.expiresInSeconds) && raw.expiresInSeconds > 0
        ? Math.min(raw.expiresInSeconds, 365 * 24 * 3600)
        : DEFAULT_INVITE_TTL_SECONDS;
    const maxUses = typeof raw?.maxUses === "number" && Number.isFinite(raw.maxUses) && raw.maxUses > 0 ? Math.min(Math.floor(raw.maxUses), 1000) : 1;
    const email = typeof raw?.email === "string" && raw.email.trim() !== "" ? emailSchema.safeParse(raw.email) : null;
    if (email && !email.success) return json({ error: "邮箱格式不对", code: "bad-request" }, 400);
    const quotaBytes = typeof raw?.quotaBytes === "number" && Number.isInteger(raw.quotaBytes) && raw.quotaBytes >= 0 ? raw.quotaBytes : null;

    try {
      const created = deps.accounts.createInvite({
        createdBy: admin.id,
        email: email?.data ?? null,
        grantAdmin: raw?.grantAdmin === true,
        quotaBytes,
        expiresInSeconds,
        maxUses,
        now: now(),
      });
      deps.audit?.({ actorId: admin.id, action: "create_invite", target: email?.data ?? null, ip: null, detail: `maxUses=${created.maxUses}${raw?.grantAdmin === true ? ",admin" : ""}` });
      return json({ code: created.code, url: joinUrl(created.code), expiresAt: created.expiresAt, maxUses: created.maxUses }, 201);
    } catch (error) {
      if (error instanceof AccountError) return accountErrorResponse(error);
      throw error;
    }
  });

  /** 作废邀请。`:code` 可以是明文码（`join_…`，刚生成时手里有）或列表里的 id（哈希）。 */
  routes.delete("/invites/:code", (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;
    const code = c.req.param("code");
    // 作废是**幂等**的：已经作废过返回 204（不是 404）—— 目标状态已经达成。
    const changed = HASH_ID.test(code) ? deps.notebooks.revokeInviteByHash(code, now()) : deps.accounts.revokeInvite(code, now());
    deps.audit?.({ actorId: admin.id, action: "revoke_invite", target: null, ip: null, detail: changed ? "revoked" : "already-revoked-or-unknown" });
    return new Response(null, { status: 204 });
  });

  /** 延长邀请：`{ extendSeconds }`，默认再给 7 天。 */
  routes.patch("/invites/:id", async (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;
    const id = c.req.param("id");
    if (!HASH_ID.test(id)) return json({ error: "邀请 id 形状不对", code: "bad-request" }, 400);
    const raw = (await c.req.json().catch(() => null)) as { extendSeconds?: unknown } | null;
    const extendSeconds =
      typeof raw?.extendSeconds === "number" && Number.isFinite(raw.extendSeconds) && raw.extendSeconds > 0
        ? Math.min(Math.floor(raw.extendSeconds), 365 * 24 * 3600)
        : DEFAULT_INVITE_TTL_SECONDS;
    const expiresAt = deps.accounts.extendInviteByHash(id, extendSeconds, now());
    if (expiresAt === null) return json({ error: "这个邀请已经作废或用完了", code: "not-found" }, 404);
    deps.audit?.({ actorId: admin.id, action: "extend_invite", target: null, ip: null, detail: String(extendSeconds) });
    return json({ expiresAt }, 200);
  });

  /* ---------------------------------------------------------------- 设备 */

  /** 移除设备：账本上标记 + 吊销它的会话。它下次联网会收到 401（「需要重新登录」）。 */
  routes.delete("/devices/:id", (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;
    const device = deps.notebooks.findDevice(c.req.param("id"));
    if (!device) return json({ error: "没有这台设备", code: "not-found" }, 404);
    deps.notebooks.markDeviceRevoked(device.accountId, device.deviceId, now());
    const revoked = deps.accounts.revokeDeviceSessions(device.accountId, device.deviceId, now());
    deps.audit?.({ actorId: admin.id, action: "admin_remove_device", target: device.accountId, ip: null, detail: device.name ?? device.deviceId.slice(0, 8) });
    return json({ revokedSessions: revoked }, 200);
  });

  /** 批量移除 `inactiveDays` 天（默认 90）没同步过、还登录着的设备。 */
  routes.post("/devices/prune", async (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;
    const raw = (await c.req.json().catch(() => null)) as { inactiveDays?: unknown } | null;
    const days = typeof raw?.inactiveDays === "number" && Number.isInteger(raw.inactiveDays) && raw.inactiveDays >= 1 ? raw.inactiveDays : 90;
    const cutoff = now() - days * 86_400_000;
    const stale = deps.notebooks.listAllDevices({ now: now() }).filter((device) => device.signedIn && (device.lastSeenAt ?? device.createdAt) < cutoff);
    for (const device of stale) {
      deps.notebooks.markDeviceRevoked(device.accountId, device.deviceId, now());
      deps.accounts.revokeDeviceSessions(device.accountId, device.deviceId, now());
    }
    deps.audit?.({ actorId: admin.id, action: "prune_devices", target: null, ip: null, detail: `count=${stale.length},days=${days}` });
    return json({ removed: stale.length }, 200);
  });

  /* ------------------------------------------------------------ 服务设置 */

  routes.get("/settings", (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;
    return json(deps.settings.publicView(), 200);
  });

  routes.patch("/settings", async (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;
    const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (raw === null || typeof raw !== "object") return json({ error: "请求体必须是对象", code: "bad-request" }, 400);
    const patch: Parameters<SettingsStore["set"]>[0] = {};
    if ("registration" in raw) {
      if (raw.registration !== "invite" && raw.registration !== "open" && raw.registration !== "closed") {
        return json({ error: "registration 必须是 invite / open / closed", code: "bad-request" }, 400);
      }
      patch.registration = raw.registration;
    }
    if ("passwordLogin" in raw) {
      if (typeof raw.passwordLogin !== "boolean") return json({ error: "passwordLogin 必须是布尔值", code: "bad-request" }, 400);
      patch.passwordLogin = raw.passwordLogin;
    }
    if ("githubEnabled" in raw) {
      if (typeof raw.githubEnabled !== "boolean") return json({ error: "githubEnabled 必须是布尔值", code: "bad-request" }, 400);
      patch.githubEnabled = raw.githubEnabled;
    }
    if ("githubClientId" in raw) {
      if (typeof raw.githubClientId !== "string" || raw.githubClientId.length > 100) return json({ error: "githubClientId 形状不对", code: "bad-request" }, 400);
      patch.githubClientId = raw.githubClientId.trim();
    }
    // Secret 只写不读：空字符串 / 不传 = 不修改（控制台的输入框留空就是这个意思）。
    if (typeof raw.githubClientSecret === "string" && raw.githubClientSecret.trim() !== "") {
      if (raw.githubClientSecret.length > 200) return json({ error: "githubClientSecret 太长", code: "bad-request" }, 400);
      patch.githubClientSecret = raw.githubClientSecret.trim();
    }
    if ("githubPolicy" in raw) {
      if (raw.githubPolicy !== "invited" && raw.githubPolicy !== "org") return json({ error: "githubPolicy 必须是 invited 或 org", code: "bad-request" }, 400);
      patch.githubPolicy = raw.githubPolicy;
    }
    if ("githubOrgs" in raw) {
      const orgs = raw.githubOrgs;
      if (!Array.isArray(orgs) || orgs.length > 20 || !orgs.every((org) => typeof org === "string" && /^[A-Za-z0-9-]{1,39}$/.test(org))) {
        return json({ error: "githubOrgs 必须是 GitHub 组织名的列表", code: "bad-request" }, 400);
      }
      patch.githubOrgs = [...new Set(orgs.map((org: string) => org.toLowerCase()))];
    }
    /*
     * 关掉邮箱密码登录之后，只剩 GitHub 能进来。GitHub 不可用时关掉它 = 所有人、
     * 包括管理员自己都登录不了，只能上服务器改库 —— 所以按「保存之后的样子」检查一遍。
     */
    const projected = { ...deps.settings.all(), ...patch };
    const githubAfter = projected.githubEnabled && projected.githubClientId.trim() !== "" && projected.githubClientSecret.trim() !== "";
    if (!projected.passwordLogin && !githubAfter) {
      return json({ error: "GitHub 登录还没配好，关掉邮箱密码登录会让所有人都登录不了", code: "no-other-login" }, 409);
    }
    if ("defaultQuotaBytes" in raw) {
      const value = raw.defaultQuotaBytes;
      if (!(typeof value === "number" && Number.isInteger(value) && value >= 0)) {
        return json({ error: "defaultQuotaBytes 必须是非负整数", code: "bad-request" }, 400);
      }
      patch.defaultQuotaBytes = value;
    }
    deps.settings.set(patch, now());
    deps.audit?.({ actorId: admin.id, action: "update_settings", target: null, ip: null, detail: Object.keys(patch).join(",") });
    return json(deps.settings.publicView(), 200);
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

  /*
   * ⚠️ **这里刻意没有「直接建管理员」的 HTTP 端点。**
   *
   * 第一个管理员走零账号时的 `POST /v1/auth/setup`；之后要么邀请时勾「管理员」，
   * 要么由已有管理员 `PATCH /accounts/:id { isAdmin: true }`。管理员全丢了的根信任通道
   * 是 CLI（`create-admin` / `reset-password`），直连数据库，不走 HTTP。
   */

  return routes;
}
