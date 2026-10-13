/**
 * 控制台 API（`docs/执行-三端同步…` §4.6、§10.1 M8/M9/M10、§7.3 Node 第 3 条）。
 *
 * ## 与 `/v1/*` 的关系：**同一个凭据，两种携带方式**
 *
 * | 入口 | 谁用 | 怎么带凭据 |
 * | --- | --- | --- |
 * | `/v1/*` | 客户端（桌面/Android/网页） | `Authorization: Bearer <authToken>` |
 * | `/panel/api/*` | 浏览器里的人 | `HttpOnly` cookie（值也是那个 `authToken`） |
 *
 * 认证链路**只有一条**（`sha256(authToken)` → 唯一索引查表 → 状态检查），
 * 这里只是换了个「从哪儿读令牌」。**没有会话表**（§4.3：一个凭据贯穿所有入口）。
 *
 * ## §10.1 M8：越权控制台页面要「**页面不渲染 + API 403**」
 *
 * 这两条是**两件事**，必须分别落实：
 *
 * - **API 403**：`requireAdmin()` 在**任何读取之前**返回（沿用 `/v1/admin/*` 的纪律）。
 * - **页面不渲染**：登录接口返回 `isAdmin`，页面据此**不生成**管理员区块的 DOM。
 *   关键在于「不生成」而不是「生成了再用 CSS 藏起来」—— 后者在开发者工具里一改就出来，
 *   而且请求也已经发出去了。有用例断言**普通账号拿到的 HTML 里没有管理员区块的标记**。
 *
 * ## 为什么「我的设备」是**只读**的
 *
 * 一个账号密钥所有设备共用 ⇒ 没有每设备凭据 ⇒ **踢不掉单台设备**（§1.5 代价 3）。
 * 所以界面必须**明说**这一点，而不是给一个按不动的按钮（§4.6 的三条必写说明之一）。
 */

import { Hono } from "hono";
import { PROTOCOL_VERSION, type Quota, type Role } from "../../../shared/contract";
import { AccountError, AccountStore, type AccountRow } from "../auth/accounts";
import type { CouchClient } from "../couch/client";
import type { NotebookStore, NotebookRow } from "../notebooks";
import type { ServerConfig } from "../config";
import { buildClearCookie, buildSessionCookie, isHttps, PANEL_COOKIE, readCookie } from "../panelSecurity";

export interface PanelApiDeps {
  accounts: AccountStore;
  notebooks: NotebookStore;
  config: ServerConfig;
  couch: CouchClient;
  couchAdmin: CouchClient;
  audit?: (event: { actorId: string | null; action: string; target?: string | null; ip?: string | null; detail?: string | null }) => void;
  startedAt?: number;
}

/** 控制台登录时提交的 `authToken` 的形状（与客户端派生出来的同一个东西）。 */
const TOKEN_MIN_LENGTH = 32;

export function createPanelApi(deps: PanelApiDeps): Hono {
  const api = new Hono();
  const json = (body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
    });

  const https = isHttps(deps.config);

  /**
   * 认证：先看 cookie，再看 `Authorization`。
   *
   * 两条都走**同一个** `accounts.authenticate()` —— 控制台与客户端在服务端看来是同一件事。
   */
  const authenticate = (c: { req: { header: (name: string) => string | undefined } }): AccountRow | Response => {
    const fromCookie = readCookie(c.req.header("cookie"), PANEL_COOKIE);
    const fromHeader = (() => {
      const header = c.req.header("authorization");
      const match = header ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
      return match ? match[1]!.trim() : null;
    })();
    const token = fromCookie ?? fromHeader;
    if (!token) return json({ error: "未登录", code: "unauthorized" }, 401);
    try {
      const row = deps.accounts.authenticate(token);
      deps.accounts.touch(row.id);
      return row;
    } catch (error) {
      if (error instanceof AccountError) {
        const disabled = error.rejection === "disabled";
        /*
         * 令牌无效（例如**刚轮换过**、浏览器 cookie 还是旧值）：清掉 cookie。
         *
         * 这一条很重要：不清的话浏览器会一直带着那个坏 cookie 重试，
         * 用户会看到「反复跳回未登录」而不知道为什么。清掉之后页面能干净地回到导入页。
         * 这也正是 §4.6 说的「轮换即全端失效（这是特性）」。
         */
        return json(
          { error: error.message, code: disabled ? "disabled" : "unauthorized" },
          disabled ? 403 : 401,
          disabled ? {} : { "set-cookie": buildClearCookie({ https }) },
        );
      }
      throw error;
    }
  };

  /** **管理员闸门**：与 `/v1/admin/*` 同一条纪律 —— 拒绝发生在读取之前。 */
  const requireAdmin = (c: { req: { header: (name: string) => string | undefined } }): AccountRow | Response => {
    const auth = authenticate(c);
    if (auth instanceof Response) return auth;
    if (auth.is_admin !== 1) return json({ error: "需要管理员权限", code: "forbidden" }, 403);
    return auth;
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

  const notebookView = (notebook: NotebookRow, role: Role): Record<string, unknown> => ({
    notebookId: notebook.id,
    name: notebook.name,
    role,
    cryptoMode: notebook.crypto_mode === "user-key" ? "user-key" : "none",
    createdAt: notebook.created_at,
  });

  /* ------------------------------------------------------------- 会话 */

  /**
   * 登录：把客户端派生出来的 `authToken` 换成 cookie。
   *
   * ⚠️ **服务端不派生、不返回令牌**，只是把它存进 HttpOnly cookie。
   * 页面 JS 已经知道令牌（它自己算的），但**存进 cookie 之后就不再接触它** ——
   * 于是 XSS 也偷不到（`HttpOnly`）。
   */
  api.post("/session", async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { authToken?: unknown } | null;
    const token = typeof raw?.authToken === "string" ? raw.authToken.trim() : "";
    if (token.length < TOKEN_MIN_LENGTH) {
      return json({ error: "authToken 形状不对", code: "bad-request" }, 400);
    }
    try {
      const row = deps.accounts.authenticate(token);
      deps.accounts.touch(row.id);
      deps.audit?.({ actorId: row.id, action: "panel_login", target: row.id, ip: null, detail: null });
      return json(
        {
          accountId: row.id,
          isAdmin: row.is_admin === 1,
          label: row.label,
          protocolVersion: PROTOCOL_VERSION,
        },
        200,
        { "set-cookie": buildSessionCookie(token, { https, maxAgeSeconds: 30 * 24 * 3600 }) },
      );
    } catch (error) {
      if (error instanceof AccountError) {
        const disabled = error.rejection === "disabled";
        /*
         * 失败时**同时清掉 cookie**：浏览器可能还带着一个旧令牌（例如刚轮换过）。
         * 不清的话它会一直重试那个坏值，用户看到「反复跳回未登录」而不知道为什么。
         */
        return json({ error: error.message, code: disabled ? "disabled" : "unauthorized" }, disabled ? 403 : 401, {
          "set-cookie": buildClearCookie({ https }),
        });
      }
      throw error;
    }
  });

  api.delete("/session", (c) => {
    void c;
    return new Response(null, { status: 204, headers: { "set-cookie": buildClearCookie({ https }) } });
  });

  /**
   * 「我是谁 + 我能看哪些区块」。
   *
   * 页面靠 `isAdmin` **决定渲不渲染**管理员区块（§10.1 M8）——
   * 是「不生成 DOM」而不是「生成后用 CSS 藏起来」，后者在开发者工具里一改就出来。
   */
  api.get("/me", (c) => {
    const auth = authenticate(c as never);
    if (auth instanceof Response) return auth;
    return json(
      {
        accountId: auth.id,
        isAdmin: auth.is_admin === 1,
        label: auth.label,
        status: auth.status,
        quota: quotaFor(auth.id),
        protocolVersion: PROTOCOL_VERSION,
      },
      200,
    );
  });

  /* --------------------------------------------------------- 我的账号 */

  /** 账号信息 + **三条必须写在界面上的说明**（§4.6）。 */
  api.get("/account", (c) => {
    const auth = authenticate(c as never);
    if (auth instanceof Response) return auth;
    return json(
      {
        accountId: auth.id,
        isAdmin: auth.is_admin === 1,
        label: auth.label,
        status: auth.status,
        createdAt: auth.created_at,
        lastSeenAt: auth.last_seen_at,
        quota: quotaFor(auth.id),
        /*
         * 这三条**随数据一起下发**，而不是写死在 HTML 里。
         * 理由：它们是对「服务端能力边界」的陈述，属于**事实**而不是文案排版；
         * 放在 API 里能让「界面说了什么」也被用例断言（而不是只能人眼检查 HTML）。
         */
        capabilityNotes: [
          "服务端无法补发你的密钥。你的账号密钥从来没到过服务端，所以「导出密钥」只能在已经有密钥的设备上做。",
          "要踢掉某台设备，只能轮换密钥。没有每设备凭据，所以轮换会让所有其它设备也要重新导入。",
          "管理员也无法重置任何人的密钥。管理员能做的只有：禁用账号、删除账号、生成邀请码。",
        ],
      },
      200,
    );
  });

  /* ----------------------------------------------------------- 设备 */

  /** 设备账本：**只读**（§1.5 代价 3）。有意的「没有删除按钮」。 */
  api.get("/devices", (c) => {
    const auth = authenticate(c as never);
    if (auth instanceof Response) return auth;
    return json(
      {
        devices: deps.notebooks.listDevices(auth.id),
        // 明确告诉前端「这里没有可执行的动作」，免得它去猜。
        canRevoke: false,
        note: "设备列表是只读账本：一个账号密钥所有设备共用，所以踢不掉单台设备。唯一的吊销手段是轮换账号密钥。",
      },
      200,
    );
  });

  /* --------------------------------------------------------- 我的笔记本 */

  api.get("/notebooks", (c) => {
    const auth = authenticate(c as never);
    if (auth instanceof Response) return auth;
    return json(
      { notebooks: deps.notebooks.listForAccount(auth.id).map(({ notebook, role }) => notebookView(notebook, role)) },
      200,
    );
  });

  /* -------------------------------------------------------------- 用量 */

  api.get("/usage", (c) => {
    const auth = authenticate(c as never);
    if (auth instanceof Response) return auth;
    return json({ quota: quotaFor(auth.id) }, 200);
  });

  /* ------------------------------------------------------- 冲突与错误 */

  /**
   * 按天冲突/错误计数（§4.6「冲突与错误」页、§8.5）。
   *
   * §8.5：**持续增长 = 有一端基线坏了**。所以这里只**展示**，绝不提供「自动解决」——
   * 那会违反红线 2（裁决是 CouchDB 的事）。
   */
  api.get("/stats", (c) => {
    const auth = authenticate(c as never);
    if (auth instanceof Response) return auth;
    const limitRaw = c.req.query("limit");
    const limitDays = limitRaw === undefined ? 30 : Math.min(365, Math.max(1, Number.parseInt(limitRaw, 10) || 30));
    const notebookId = c.req.query("nb");
    return json(
      {
        stats: deps.notebooks.statsFor(auth.id, { limitDays, ...(notebookId === undefined ? {} : { notebookId }) }),
        note: "服务端只记计数，看不到冲突内容（红线 2）。持续增长通常意味着有一端基线坏了。",
        canAutoResolve: false,
      },
      200,
    );
  });

  /* ============================ 以下全部是**管理员专属** ============================ */

  /** 账号列表（§4.6「账号管理」，仅管理员）。**不返回任何密钥材料。** */
  api.get("/admin/accounts", (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;
    return json(
      {
        accounts: deps.accounts.list().map((row) => ({
          accountId: row.id,
          label: row.label,
          status: row.status,
          isAdmin: row.is_admin === 1,
          createdAt: row.created_at,
          lastSeenAt: row.last_seen_at,
          quota: quotaFor(row.id),
        })),
      },
      200,
    );
  });

  /** 生成注册邀请码（§4.6「账号管理」）。明文**只出现这一次**。 */
  api.post("/admin/invites", async (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;
    const raw = (await c.req.json().catch(() => null)) as { maxUses?: unknown; days?: unknown } | null;
    const maxUses = typeof raw?.maxUses === "number" && raw.maxUses > 0 ? Math.min(1000, Math.floor(raw.maxUses)) : 1;
    const days = typeof raw?.days === "number" && raw.days > 0 ? Math.min(365, Math.floor(raw.days)) : 7;
    const created = deps.accounts.createInvite({ createdBy: admin.id, expiresInSeconds: days * 86400, maxUses });
    deps.audit?.({ actorId: admin.id, action: "panel_create_invite", target: null, ip: null, detail: `maxUses=${maxUses}` });
    return json({ code: created.code, expiresAt: created.expiresAt, maxUses }, 201);
  });

  /** 禁用/启用账号（§4.6）。 */
  api.post("/admin/accounts/:id/status", async (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;
    const accountId = c.req.param("id");
    const raw = (await c.req.json().catch(() => null)) as { status?: unknown } | null;
    const status = raw?.status === "disabled" ? "disabled" : raw?.status === "active" ? "active" : null;
    if (status === null) return json({ error: "status 必须是 active 或 disabled", code: "bad-request" }, 400);
    // 与 `/v1/admin/*` 同一条纪律：不能把自己锁在外面。
    if (accountId === admin.id && status === "disabled") {
      return json({ error: "不能禁用自己（会让你失去管理入口）", code: "bad-request" }, 400);
    }
    if (!deps.accounts.setStatus(accountId, status)) return json({ error: "账号不存在", code: "not-found" }, 404);
    deps.audit?.({ actorId: admin.id, action: `panel_${status === "disabled" ? "disable" : "enable"}_account`, target: accountId, ip: null, detail: null });
    return new Response(null, { status: 204 });
  });

  /** 服务器信息（§4.6「服务器」区块，仅管理员）。 */
  api.get("/admin/server", async (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;
    let couchVersion: string | null = null;
    try {
      couchVersion = (await deps.couch.version()).version;
    } catch {
      couchVersion = null;
    }
    const now = Date.now();
    return json(
      {
        protocolVersion: deps.config.protocolVersionExpected,
        couchVersion,
        dbCount: deps.notebooks.totalNotebooks(),
        accountCount: deps.accounts.count(),
        uptimeSeconds: Math.max(0, (now - (deps.startedAt ?? now)) / 1000),
      },
      200,
    );
  });

  /** 审计尾部（仅管理员）。 */
  api.get("/admin/audit", (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;
    const limitRaw = c.req.query("limit");
    const limit = limitRaw === undefined ? 50 : Math.min(500, Math.max(1, Number.parseInt(limitRaw, 10) || 50));
    return json({ events: deps.notebooks.recentAudit(limit) }, 200);
  });

  return api;
}
