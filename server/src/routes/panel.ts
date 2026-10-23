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
import {
  buildClearCookie,
  buildClearStepUpCookie,
  buildSessionCookie,
  buildStepUpCookie,
  isHttps,
  PANEL_COOKIE,
  readCookie,
  STEP_UP_COOKIE,
  STEP_UP_TTL_SECONDS,
} from "../panelSecurity";

/**
 * 把「客户端上报」与「服务端实测」两种按天计数**合并成一份**。
 *
 * ## 为什么是取较大值而不是相加
 *
 * 两者数的是**同一批请求的两端**：客户端数它发出去的，服务端数它收到的。
 * 相加会把同一次同步数两遍（一次按 `pulls`、一次按 `pushes`，或用例里重试一次就翻倍）；
 * 取较大值给出的是「这一天**至少**发生了这么多次」—— 一个不会骗人的下界。
 *
 * ## 按 `(day, notebookId)` 对齐
 *
 * 同一张表里，客户端可能按它自己的时区给 `day`，服务端按 UTC 给 —— 两条流对不上一天时
 * 就各留一行（`merge` 只在**两边都有**那一段时合并）。这比强行按 UTC 平移更诚实：
 * 平移会让「今天」的那一列在跨时区部署里凭空多出一条。
 */
function mergeDailyStats(
  reported: { notebookId: string; day: string; conflicts: number; errors: number; pushes: number; pulls: number; deletes: number }[],
  observed: { notebookId: string; day: string; conflicts: number; errors: number; pushes: number; pulls: number; deletes: number }[],
): { notebookId: string; day: string; conflicts: number; errors: number; pushes: number; pulls: number; deletes: number }[] {
  const key = (row: { notebookId: string; day: string }): string => `${row.notebookId}|${row.day}`;
  const merged = new Map<string, { notebookId: string; day: string; conflicts: number; errors: number; pushes: number; pulls: number; deletes: number }>();
  for (const row of [...reported, ...observed]) {
    const k = key(row);
    const current = merged.get(k);
    if (!current) {
      merged.set(k, { ...row });
      continue;
    }
    current.pulls = Math.max(current.pulls, row.pulls);
    current.pushes = Math.max(current.pushes, row.pushes);
    current.deletes = Math.max(current.deletes, row.deletes);
    current.conflicts = Math.max(current.conflicts, row.conflicts);
    current.errors = Math.max(current.errors, row.errors);
  }
  // 倒序（最近的在前）—— 与 `/stats` 原来那一路的排序一致。
  return [...merged.values()].sort((left, right) => (left.day < right.day ? 1 : left.day > right.day ? -1 : 0));
}

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

/**
 * 控制台会话有效期：**8 小时**（不是 30 天）。
 *
 * ## 为什么改
 *
 * 30 天的会话 + 管理员权限 = 一台没锁屏的机器可以在一个月里删账号、删库。
 * 那个组合的风险远大于「运维每天要重登一次」的不便。
 *
 * 8 小时覆盖一个完整工作日，且**跨不过一次睡觉** —— 这是有意选的：
 * 会话不该活过「人离开工位」这件事。
 *
 * 客户端（桌面 / Android）用 `Authorization: Bearer`，**不受这条影响** ——
 * 它们的凭据是那把密钥派生的令牌，本来就不该过期（离线优先）。
 */
const PANEL_SESSION_TTL_SECONDS = 8 * 3600;

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
        { "set-cookie": buildSessionCookie(token, { https, maxAgeSeconds: PANEL_SESSION_TTL_SECONDS }) },
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
    /*
     * 退出时**同时清掉 step-up 标记**：留着它等于「退出登录之后五分钟内还能
     * 拿它执行一次破坏性动作」，而那时主会话已经不在了 —— 一个很难解释的状态。
     */
    const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
    headers.append("set-cookie", buildClearCookie({ https }));
    headers.append("set-cookie", buildClearStepUpCookie({ https }));
    return new Response(null, { status: 204, headers });
  });

  /* ------------------------------------------------------- 二次验证 */

  /**
   * **二次验证（step-up）**：破坏性动作前重新证明「你手里还有那把密钥」。
   *
   * ## 它解决什么
   *
   * 控制台会话是一个 HttpOnly cookie。它有效期内，任何能碰到这台浏览器的人
   * 都能删账号、删库 —— 即使他不知道密钥。**「后果三行」是提醒，不是验证。**
   *
   * ## 它怎么运作
   *
   * 1. 页面让用户**重新粘贴一次**账号密钥（从密码管理器里，不是从内存里）
   * 2. 页面本地派生 `authToken`（与登录时同一条 HKDF）
   * 3. 提交到这里
   * 4. 这里确认：它命中某个账号 **且** 就是当前会话的那个账号 **且** active
   * 5. 签发一个 5 分钟有效的 step-up cookie
   *
   * ## 两个刻意的取舍
   *
   * - **不签发新令牌**：step-up cookie 的值就是那把 authToken。这样它会在轮换时
   *   自动失效，也不会多出一份可被长期持有的凭据。
   * - **不要求「密码」**：没有密码。密钥是唯一凭据，重新提供它就是最强的证明。
   *
   * ## 为什么校验「是同一个账号」
   *
   * 否则一个普通账号可以拿**自己的**密钥通过验证，然后去执行管理员的动作 ——
   * 那样这道闸门就只是「你还记得自己的密钥吗」。
   */
  api.post("/session/verify", async (c) => {
    const auth = authenticate(c as never);
    if (auth instanceof Response) return auth;
    const raw = (await c.req.json().catch(() => null)) as { authToken?: unknown } | null;
    const token = typeof raw?.authToken === "string" ? raw.authToken.trim() : "";
    if (token.length < TOKEN_MIN_LENGTH) return json({ error: "authToken 形状不对", code: "bad-request" }, 400);

    let row: AccountRow;
    try {
      row = deps.accounts.authenticate(token);
    } catch (error) {
      if (error instanceof AccountError) {
        return json({ error: "这个令牌无效" + (error.rejection === "disabled" ? "（账号已禁用）" : ""), code: "unauthorized" }, 401);
      }
      throw error;
    }
    /*
     * ★ 必须是**当前会话的这个账号**。
     * 少了这一条，普通账号能拿自己的密钥通过二次验证，再拿去执行管理动作。
     */
    if (row.id !== auth.id) {
      return json({ error: "这把密钥属于另一个账号，不能用来确认当前会话", code: "forbidden" }, 403);
    }

    deps.audit?.({ actorId: auth.id, action: "panel_step_up", target: auth.id, ip: null, detail: null });
    return json(
      { verified: true, expiresInSeconds: STEP_UP_TTL_SECONDS },
      200,
      { "set-cookie": buildStepUpCookie(token, { https }) },
    );
  });

  /**
   * 危险动作的闸门：**要求刚刚做过二次验证**。
   *
   * 与 `requireAdmin()` 是**两条**：那条问「你是不是管理员」，这条问
   * 「这一步是不是你本人刚点的」。两个问题的答案不能互相替代。
   *
   * 返回 `Response` = 拒绝（`code: "step-up-required"`，页面据此弹密钥框）。
   */
  const requireStepUp = (
    c: { req: { header: (name: string) => string | undefined } },
    row: AccountRow,
    sessionToken: string,
  ): Response | null => {
    const token = readCookie(c.req.header("cookie"), STEP_UP_COOKIE);
    if (token) {
      try {
        /* 标记值就是 authToken；它必须**仍然**对应这个账号（轮换后自动失效）。 */
        const marked = deps.accounts.authenticate(token);
        /*
         * ★ 两条都要：**是这个账号**，且**是这次会话的那把令牌**。
         *
         * 只判第一条的话，两个管理员之间可以互相借标记 —— Alice 拿到 Bob 的
         * step-up cookie（同一个浏览器上很容易），就能用 Bob 的二次验证去删账号。
         * 那样这道闸门问的就成了「**有人**刚验证过吗」，而不是「**你**刚验证过吗」。
         *
         * 这条是被用例逼出来的：第一版只写了 `marked.id === row.id`，
         * 两个管理员互相借标记的用例直接过了。
         */
        if (marked.id === row.id && token === sessionToken) return null;
      } catch {
        /* 落到下面统一拒绝 */
      }
    }
    return json(
      {
        error: "这个操作需要重新验证：请再粘贴一次账号密钥",
        code: "step-up-required",
        expiresInSeconds: STEP_UP_TTL_SECONDS,
      },
      403,
    );
  };

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
    const options = { limitDays, ...(notebookId === undefined ? {} : { notebookId }) };
    return json(
      {
        /*
         * ★ **两个来源合并成一个按天视图**，并把它们分开报出来。
         *
         * `clientStats` 是客户端上报的（`POST /v1/stats`）；`observed` 是服务端在
         * `/v1` 数据面上**自己数**的。当前产品客户端**没有**那个上报调用，
         * 所以只读前者的话这一页永远是 0 —— 而同步其实一直在跑。
         *
         * 合并规则：同一天取两者**较大值**，不是相加。
         * 相加会把「同一批请求」数两遍（客户端数它发出的、服务端数它收到的）；
         * 取较大值回答的是「这一天至少发生了这么多次」，而这是不会骗人的下界。
         */
        stats: mergeDailyStats(
          deps.notebooks.statsFor(auth.id, options),
          deps.notebooks.activityForAccount(auth.id, options),
        ),
        sources: {
          clientStats: deps.notebooks.statsFor(auth.id, options).length,
          observed: deps.notebooks.activityForAccount(auth.id, options).length,
        },
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

  /**
   * **删除账号**（§4.6「账号管理」）。
   *
   * 这是整套管理页里唯一不可撤销的动作，所以它同时要过两道闸门：
   *
   * 1. `requireAdmin()` —— 你是不是管理员
   * 2. `requireStepUp()` —— 这一步是不是你本人**刚刚**确认的
   *
   * 并且**不能删自己**：与「不能禁用自己」同一条纪律，理由也一样 ——
   * 那会让你永久失去管理入口（只能再跑一次 `bootstrap-admin`）。
   */
  api.delete("/admin/accounts/:id", async (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;
    /*
     * 当前会话的令牌：从主 cookie 里取。
     * 它必须和 step-up 标记里那把**是同一把** —— 否则就是「别人刚验证过」。
     */
    const sessionToken = readCookie(c.req.header("cookie"), PANEL_COOKIE) ?? "";
    const denied = requireStepUp(c as never, admin, sessionToken);
    if (denied) return denied;

    const accountId = c.req.param("id");
    if (accountId === admin.id) return json({ error: "不能删除自己（会让你失去管理入口）", code: "bad-request" }, 400);

    const target = deps.accounts.findById2(accountId);
    if (!target) return json({ error: "账号不存在", code: "not-found" }, 404);

    /*
     * 并发保护：如果这个账号是**最后一个活跃管理员**，拒绝。
     * 与 `setAdmin` 里那条约束是同一件事的两个入口 —— 都得守，
     * 否则「删掉最后一个管理员」会绕过「不能降权最后一个管理员」。
     */
    if (target.is_admin === 1 && target.status === "active" && deps.accounts.countAdmins() <= 1) {
      return json({ error: "这是最后一个管理员，不能删除", code: "last-admin" }, 400);
    }

    /*
     * 顺序很重要：先摘掉成员关系与独占的库，再删设备、最后删账号行。
     * 反过来会撞上外键约束，而且报错位置离根因很远（在 HTTP 处理器里）。
     *
     * ★ 编排本身在 `NotebookStore.deleteAccountCascade()`（一个事务里做完）：
     *   控制台、`/v1/admin`、客户端自助这三个入口必须走**同一套**规则，
     *   否则总有一个会漏一张表（真发生过：漏了 `devices` ⇒ 有设备的账号删不掉，500）。
     */
    const cascade = deps.notebooks.deleteAccountCascade(accountId);
    try {
      deps.accounts.delete(accountId);
    } catch (error) {
      // 外键以外的失败（例如库里还有我们没料到的引用）：如实回 409，而不是 500。
      console.warn("[opennote-server] 删账号失败", error);
      return json({ error: "这个账号还有未清理的关联数据，暂时无法删除", code: "still-referenced" }, 409);
    }
    deps.audit?.({
      actorId: admin.id,
      action: "panel_delete_account",
      target: accountId,
      ip: null,
      detail: `exclusive=${cascade.exclusiveNotebooks.length} transferred=${cascade.transferredNotebooks.length}`,
    });
    return json(
      {
        deleted: accountId,
        exclusiveNotebooks: cascade.exclusiveNotebooks,
        transferredNotebooks: cascade.transferredNotebooks,
      },
      200,
    );
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
