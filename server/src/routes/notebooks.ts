/**
 * `/v1/notebooks/*` 与 `/v1/devices`（`docs/执行-三端同步…` §4.3、§4.5、§4.7、§1.4、§7.1）。
 *
 * ## 三条从别处继承来的纪律（不在这里重新发明）
 *
 * 1. **越权 = 404**：判定统一走 `NotebookStore.resolveMembership()`（§4.4 纪律 2）。
 * 2. **E2EE 笔记本不可共享**：发码与用码两处都判（§1.4 的 v1 规则）。
 * 3. **置备不留半个笔记本**：建库任一步失败要回滚（§4.5）。这里把「SQLite 行」与
 *    「CouchDB 库」两个资源**配对处理** —— 先建行（可回滚），再置备，失败就删行删库。
 *
 * ## 为什么「建笔记本」要分两步而不是一个事务
 *
 * SQLite 事务管不到 CouchDB。所以顺序是：
 *
 * ```
 * 1. 事务：INSERT notebooks + INSERT memberships(owner)   ← 这一层可以回滚
 * 2. 置备（admin 凭据）：建库 / _security / _design / _revs_limit / syncinfo
 * 3. 失败 → 删库（provisionNotebook 内部已做）+ 删那两个行
 * ```
 *
 * 反过来（先建库再建行）会出现「库在、没有任何成员」的孤儿库 ——
 * 那比「行在、库没建」更难发现，也更难清理。
 */

import { Hono } from "hono";
import {
  ContractError,
  notebookCreateRequestSchema,
  notebookIdSchema,
  notebookInviteCreateRequestSchema,
  notebookJoinRequestSchema,
  notebookJoinResponseSchema,
  inviteCreatedResponseSchema,
  parseContract,
  type Role,
} from "../../../shared/contract";
import { AccountError, AccountStore, generateCode, hashCode, type AccountRow } from "../auth/accounts";
import type { CouchClient } from "../couch/client";
import { NotebookError, NotebookStore, assertNotebookQuota, type NotebookRow } from "../notebooks";
import { ProvisioningError, provisionNotebook } from "../provisioning";
import type { ServerConfig } from "../config";
import { bearerToken } from "./account";

export interface NotebookRoutesDeps {
  accounts: AccountStore;
  notebooks: NotebookStore;
  config: ServerConfig;
  /** 运行时客户端（读置备状态用）。 */
  couch: CouchClient;
  /** admin 客户端（**只在置备时用**，§4.5）。 */
  couchAdmin: CouchClient;
  audit?: (event: { actorId: string | null; action: string; target?: string | null; ip?: string | null; detail?: string | null }) => void;
}

/** `NotebookError` → HTTP。**`not-found` 一律 404**（与「不存在」不可区分）。 */
function notebookErrorResponse(error: NotebookError): Response {
  const status =
    error.code === "not-found"
      ? 404
      : error.code === "forbidden" || error.code === "crypto-mode-not-shareable"
        ? error.code === "crypto-mode-not-shareable"
          ? 409
          : 403
        : error.code === "bad-invite" || error.code === "invite-used" || error.code === "invite-expired"
          ? 400
          : error.code === "already-member"
            ? 409
            : error.code === "quota"
              ? 403
              : 400;
  return Response.json({ error: error.message, code: error.code }, { status });
}

export function createNotebookRoutes(deps: NotebookRoutesDeps): Hono {
  const routes = new Hono();
  const json = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

  /** 认证（与其它路由同一条链路）。 */
  const authenticate = (c: { req: { header: (name: string) => string | undefined } }): AccountRow | Response => {
    const token = bearerToken(c.req.header("authorization"));
    if (!token) return json({ error: "缺少 Authorization: Bearer 令牌", code: "unauthorized" }, 401);
    try {
      return deps.accounts.authenticate(token);
    } catch (error) {
      if (error instanceof AccountError) {
        const disabled = error.rejection === "disabled";
        return json({ error: error.message, code: disabled ? "disabled" : "unauthorized" }, disabled ? 403 : 401);
      }
      throw error;
    }
  };

  /** 笔记本的公开形状（**绝不带 db_name** —— 库名不透明，客户端不需要也不该知道，§3.1）。 */
  const summaryOf = (notebook: NotebookRow, role: Role): Record<string, unknown> => ({
    notebookId: notebook.id,
    name: notebook.name,
    role,
    cryptoMode: notebook.crypto_mode === "user-key" ? "user-key" : "none",
    protocolVersion: deps.config.protocolVersionExpected,
    createdAt: notebook.created_at,
  });

  /* -------------------------------------------------------------- 列表 */

  routes.get("/notebooks", (c) => {
    const auth = authenticate(c as never);
    if (auth instanceof Response) return auth;
    const items = deps.notebooks.listForAccount(auth.id).map(({ notebook, role }) => summaryOf(notebook, role));
    return json({ notebooks: items }, 200);
  });

  /* -------------------------------------------------------------- 新建 */

  /**
   * 建笔记本。**先建行、再置备、失败都撤回**（见模块头）。
   *
   * 配额：`assertNotebookQuota` **只拦写入**（超限时读取仍然可用，§10.1 M9）。
   */
  routes.post("/notebooks", async (c) => {
    const auth = authenticate(c as never);
    if (auth instanceof Response) return auth;

    const raw = await c.req.json().catch(() => null);
    let input;
    try {
      input = parseContract(notebookCreateRequestSchema, raw, "POST /v1/notebooks");
    } catch (error) {
      return json({ error: error instanceof ContractError ? error.message : String(error), code: "bad-request" }, 400);
    }

    const current = deps.notebooks.recomputeNotebookCount(auth.id);
    try {
      assertNotebookQuota(current, deps.config.defaultAccountQuotaNotebooks);
    } catch (error) {
      if (error instanceof NotebookError) return notebookErrorResponse(error);
      throw error;
    }

    // ① 先建行（这一层可回滚）。
    let notebook: NotebookRow;
    try {
      notebook = deps.notebooks.create({ ownerId: auth.id, name: input.name, cryptoMode: input.cryptoMode });
    } catch (error) {
      if (error instanceof NotebookError) return notebookErrorResponse(error);
      throw error;
    }

    // ② 再置备（CouchDB 那一层由 provisionNotebook 自己负责回滚删库）。
    try {
      await provisionNotebook({
        couch: deps.couchAdmin,
        dbName: notebook.db_name,
        syncUser: deps.config.couchUser,
        protocolVersion: deps.config.protocolVersionExpected,
        cryptoMode: input.cryptoMode,
        maxFileBytes: deps.config.maxFileBytes,
      });
    } catch (error) {
      // ③ 把刚才那两个行撤掉，**不留半个笔记本**（§4.5）。
      deps.notebooks.markDeleted(notebook.id);
      deps.notebooks.recomputeNotebookCount(auth.id);
      const detail = error instanceof ProvisioningError ? `${error.step}：${error.message}` : String(error);
      deps.audit?.({ actorId: auth.id, action: "create_notebook_failed", target: notebook.id, ip: null, detail });
      return json({ error: `建笔记本失败（已回滚）：${detail}`, code: "server" }, 500);
    }

    deps.notebooks.recomputeNotebookCount(auth.id);
    deps.audit?.({ actorId: auth.id, action: "create_notebook", target: notebook.id, ip: null, detail: input.cryptoMode });
    return json(summaryOf(notebook, "owner"), 201);
  });

  /* -------------------------------------------------------------- 单条 */

  routes.get("/notebooks/:id", (c) => {
    const auth = authenticate(c as never);
    if (auth instanceof Response) return auth;
    const notebookId = c.req.param("id");
    const notebook = deps.notebooks.findById(notebookId);
    const membership = notebook ? deps.notebooks.resolveMembership(notebook.id, auth.id) : null;
    // ★ 不存在与无权同一条返回。
    if (!notebook || !membership) return json({ error: "笔记本不存在", code: "not-found" }, 404);
    return json(summaryOf(notebook, membership.role as Role), 200);
  });

  routes.delete("/notebooks/:id", async (c) => {
    const auth = authenticate(c as never);
    if (auth instanceof Response) return auth;
    const notebookId = c.req.param("id");
    const notebook = deps.notebooks.findById(notebookId);
    const membership = notebook ? deps.notebooks.resolveMembership(notebook.id, auth.id) : null;
    if (!notebook || !membership) return json({ error: "笔记本不存在", code: "not-found" }, 404);
    if (membership.role !== "owner") return json({ error: "需要 owner 权限", code: "forbidden" }, 403);

    /*
     * 删笔记本：**逻辑删行 + 物理删库**。
     *
     * 与「删账号」不同，这里是用户明确的「这个笔记本我不要了」，所以库要真删
     * （否则磁盘只增不减）。两个资源的顺序是「先删库、再标记行」：
     * 库删成功而标记失败，最坏是留下一个指向空库的行（可重试）；
     * 反过来则是「行说没了、库还在」—— 那会一直占着磁盘且没人知道。
     */
    try {
      await deps.couchAdmin.deleteDatabase(notebook.db_name);
    } catch (error) {
      return json({ error: `删除库失败：${String(error)}`, code: "server" }, 500);
    }
    deps.notebooks.markDeleted(notebook.id);
    deps.notebooks.recomputeNotebookCount(auth.id);
    deps.notebooks.audit({ actorId: auth.id, action: "delete_notebook", target: notebook.id, ip: null, detail: null });
    return new Response(null, { status: 204 });
  });

  /* ------------------------------------------------------------ 成员 */

  routes.get("/notebooks/:id/members", (c) => {
    const auth = authenticate(c as never);
    if (auth instanceof Response) return auth;
    const notebook = deps.notebooks.findById(c.req.param("id"));
    const membership = notebook ? deps.notebooks.resolveMembership(notebook.id, auth.id) : null;
    if (!notebook || !membership) return json({ error: "笔记本不存在", code: "not-found" }, 404);
    return json({ members: deps.notebooks.listMembers(notebook.id) }, 200);
  });

  /* ---------------------------------------------------------- 邀请码 */

  /** 发笔记本邀请码（**仅 owner**；`crypto_mode != 'none'` → 409，§1.4）。 */
  routes.post("/notebooks/:id/invites", async (c) => {
    const auth = authenticate(c as never);
    if (auth instanceof Response) return auth;
    const notebook = deps.notebooks.findById(c.req.param("id"));
    const membership = notebook ? deps.notebooks.resolveMembership(notebook.id, auth.id) : null;
    if (!notebook || !membership) return json({ error: "笔记本不存在", code: "not-found" }, 404);
    if (membership.role !== "owner") return json({ error: "需要 owner 权限", code: "forbidden" }, 403);

    const raw = await c.req.json().catch(() => null);
    let input;
    try {
      input = parseContract(notebookInviteCreateRequestSchema, raw ?? {}, "POST /v1/notebooks/:id/invites");
    } catch (error) {
      return json({ error: error instanceof ContractError ? error.message : String(error), code: "bad-request" }, 400);
    }

    const now = Date.now();
    const expiresAt = input.expiresInSeconds ? now + input.expiresInSeconds * 1000 : null;
    const maxUses = input.maxUses ?? 1;
    // 明文生成、只存哈希：事后连我们也拿不回明文（与引导码同一条纪律）。
    const code = generateCode("nb");
    try {
      deps.notebooks.createInvite({
        codeHash: hashCode(code),
        notebookId: notebook.id,
        role: input.role,
        createdBy: auth.id,
        expiresAt,
        now,
      });
    } catch (error) {
      if (error instanceof NotebookError) return notebookErrorResponse(error);
      throw error;
    }
    deps.audit?.({ actorId: auth.id, action: "create_notebook_invite", target: notebook.id, ip: null, detail: input.role });
    const body = parseContract(inviteCreatedResponseSchema, { code, expiresAt, maxUses }, "邀请码响应");
    return json(body, 201);
  });

  /** 加入笔记本（凭一次性邀请码）。**不需要知道对方是谁**（§1.5）。 */
  routes.post("/notebooks/join", async (c) => {
    const auth = authenticate(c as never);
    if (auth instanceof Response) return auth;
    const raw = await c.req.json().catch(() => null);
    let input;
    try {
      input = parseContract(notebookJoinRequestSchema, raw, "POST /v1/notebooks/join");
    } catch (error) {
      return json({ error: error instanceof ContractError ? error.message : String(error), code: "bad-request" }, 400);
    }
    try {
      const result = deps.notebooks.joinByInvite(hashCode(input.code), auth.id);
      const notebook = deps.notebooks.findById(result.notebookId);
      deps.audit?.({ actorId: auth.id, action: "join_notebook", target: result.notebookId, ip: null, detail: result.role });
      const body = parseContract(
        notebookJoinResponseSchema,
        {
          notebookId: result.notebookId,
          role: result.role,
          cryptoMode: notebook?.crypto_mode === "user-key" ? "user-key" : "none",
        },
        "加入笔记本响应",
      );
      return json(body, 200);
    } catch (error) {
      if (error instanceof NotebookError) return notebookErrorResponse(error);
      throw error;
    }
  });

  /* ------------------------------------------------------------ 设备 */

  /**
   * 设备登记（§4.3：`devices` **不是凭据**，只是账本）。
   *
   * 因为「一个账号密钥所有设备共用」，这里**没有**「踢掉某台设备」的能力 ——
   * 控制台的设备列表因此是**只读账本**（§1.5 代价 3）。这一点在控制台文案里要说清，
   * 不能让用户以为有个不存在的按钮。
   */
  routes.post("/devices", async (c) => {
    const auth = authenticate(c as never);
    if (auth instanceof Response) return auth;
    const raw = (await c.req.json().catch(() => null)) as { deviceId?: unknown; name?: unknown; platform?: unknown } | null;
    const deviceId = typeof raw?.deviceId === "string" ? raw.deviceId : "";
    if (!/^[0-9a-f]{32}$/.test(deviceId)) return json({ error: "deviceId 形状不对", code: "bad-request" }, 400);
    const platform = raw?.platform === "desktop" || raw?.platform === "android" || raw?.platform === "web" ? raw.platform : null;
    const name = typeof raw?.name === "string" ? raw.name.slice(0, 120) : null;
    const now = Date.now();

    deps.notebooks.upsertDevice({ deviceId, accountId: auth.id, name, platform, now });
    return new Response(null, { status: 204 });
  });

  routes.get("/devices", (c) => {
    const auth = authenticate(c as never);
    if (auth instanceof Response) return auth;
    return json({ devices: deps.notebooks.listDevices(auth.id) }, 200);
  });

  return routes;
}

/** `notebookIdSchema` 重导出（诊断与夹具用；避免调用方各写一份正则）。 */
export { notebookIdSchema };
