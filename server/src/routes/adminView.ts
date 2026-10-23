/**
 * 管理端聚合读端点（`docs/执行-三端同步…` §4.6、§10.1 M8）。
 *
 * ## 为什么单独一个文件，而不是继续往 `panel.ts` 里堆
 *
 * `panel.ts` 已经同时管着「我的账号 / 我的设备 / 我的笔记本」这些**普通账号也用**的
 * 端点，和少数管理员端点。再加台账、全站设备、邀请码、巡检、配置、诊断，
 * 会让那个文件里「哪一段需要 requireAdmin」变得只能靠记忆 —— 而纪律类的东西
 * **不该靠记忆**。这里每个处理器第一句都是 `requireAdmin()`，全文件同一个形状。
 *
 * ## 这个文件不返回什么（和 `/v1/admin/*` 同一条纪律）
 *
 * - `auth_hash` / `wrapped_enc_root`（密钥材料，一旦出去就收不回来）
 * - 明文路径 / 笔记内容（E2EE 下服务端根本没有；`user-key` 库连 `epath` 都是密文）
 * - 邀请码明文（明文只在生成那一刻出现，事后连我们也拿不回）
 *
 * ## 一个刻意的「不做」
 *
 * **没有**「一键重建 _design」「一键解决冲突」。前者会掩盖「谁删了它」这个更重要的
 * 问题；后者违反红线 2（裁决属于 CouchDB，不是我们）。
 */

import { Hono } from "hono";
import { AccountError, AccountStore, type AccountRow } from "../auth/accounts";
import type { CouchClient } from "../couch/client";
import type { NotebookStore } from "../notebooks";
import type { ServerConfig } from "../config";
import { inspectNotebook } from "../provisioning";
import { PANEL_COOKIE, readCookie } from "../panelSecurity";

/**
 * 合并两种按天计数（客户端上报 / 服务端实测），返回**带 `accountId` 的逐行视图**。
 *
 * 与 `panel.ts` 的 `mergeDailyStats()` 是同一套规则（取较大值，不相加），
 * 差别只在返回形状：那边按「我一个人」聚合、去掉 `accountId`；
 * 这里给管理页，必须保留「哪个账号」才能做热点排序。
 *
 * 为什么两份都要有（而不是抽成共享模块）：它们一个在 `/panel/api`、一个在
 * `/panel/api/admin`，共享一个工具模块会多出一层「谁都能 import」的公共面，
 * 而这段逻辑只有 20 行、且两边都会各自演化（一个要 `accountId`、一个不要）。
 * 合并规则的**唯一判据**写在两处的模块头里，改一处必须看另一处。
 */
function mergeActivity(
  reported: { accountId: string; notebookId: string; day: string; pulls: number; pushes: number; deletes: number; conflicts: number; errors: number }[],
  observed: { accountId: string; notebookId: string; day: string; pulls: number; pushes: number; deletes: number; conflicts: number; errors: number }[],
): { accountId: string; notebookId: string; day: string; pulls: number; pushes: number; deletes: number; conflicts: number; errors: number }[] {
  const merged = new Map<string, { accountId: string; notebookId: string; day: string; pulls: number; pushes: number; deletes: number; conflicts: number; errors: number }>();
  for (const row of [...reported, ...observed]) {
    const key = `${row.accountId}|${row.notebookId}|${row.day}`;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...row });
      continue;
    }
    current.pulls = Math.max(current.pulls, row.pulls);
    current.pushes = Math.max(current.pushes, row.pushes);
    current.deletes = Math.max(current.deletes, row.deletes);
    current.conflicts = Math.max(current.conflicts, row.conflicts);
    current.errors = Math.max(current.errors, row.errors);
  }
  return [...merged.values()];
}

export interface AdminViewDeps {
  accounts: AccountStore;
  notebooks: NotebookStore;
  config: ServerConfig;
  couch: CouchClient;
  /** 进程启动时间（uptime；测试注入）。 */
  startedAt?: number;
  now?: () => number;
  audit?: (event: { actorId: string | null; action: string; target?: string | null; ip?: string | null; detail?: string | null }) => void;
}

/** 近 N 天的按天聚合（管理页「运行状态」的流量图）。 */
const TRAFFIC_WINDOW_DAYS = 30;

/** 「30 天没露面」算不算陈旧。 */
const STALE_DEVICE_MS = 30 * 86_400_000;

export function createAdminViewRoutes(deps: AdminViewDeps): Hono {
  const api = new Hono();
  const now = deps.now ?? (() => Date.now());
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

  /** 与 `panel.ts` 完全同一条闸门：401 与 403 分开，且拒绝发生在任何读取之前。 */
  const requireAdmin = (c: { req: { header: (name: string) => string | undefined } }): AccountRow | Response => {
    const fromCookie = readCookie(c.req.header("cookie"), PANEL_COOKIE);
    const header = c.req.header("authorization");
    const match = header ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
    const token = fromCookie ?? (match ? match[1]!.trim() : null);
    if (!token) return json({ error: "未登录", code: "unauthorized" }, 401);
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

  /* ------------------------------------------------------------ 概览 */

  /**
   * 运行状态页需要的一屏数字。
   *
   * ★ **一次请求给齐**，而不是让页面打 6 个端点：运维页最怕「一半成功一半失败」，
   *   那种状态下每个数字的可信度都要单独判断。
   */
  api.get("/overview", async (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;

    const accounts = deps.accounts.list();
    const notebooks = deps.notebooks.listAllNotebooks();
    const devices = deps.notebooks.listAllDevices();
    const staleDevices = devices.filter((d) => (d.lastSeenAt ?? d.createdAt) < now() - STALE_DEVICE_MS);

    /*
     * 近 30 天按天汇总。**两个来源**：
     *
     * ① `client_stats` —— 客户端上报的（`POST /v1/stats`）。当前产品客户端**没有**调用它，
     *    所以这一路通常是空的；
     * ② `sync_activity` —— 服务端在 `/v1` 数据面上自己数的（见迁移 3）。**这一路一直有数**。
     *
     * 两者按 `(账号, 库, 天)` 取**较大值**合并（不是相加：那会把同一批请求数两遍，
     * 因为客户端数它发出的、服务端数它收到的）。合并后的结果才是「这一天至少发生了什么」。
     */
    const byDay = new Map<string, { pulls: number; pushes: number; conflicts: number; errors: number; deletes: number }>();
    const tally = (key: string, row: { pulls: number; pushes: number; conflicts: number; errors: number; deletes: number }): void => {
      const bucket = byDay.get(key) ?? { pulls: 0, pushes: 0, conflicts: 0, errors: 0, deletes: 0 };
      bucket.pulls += row.pulls;
      bucket.pushes += row.pushes;
      bucket.conflicts += row.conflicts;
      bucket.errors += row.errors;
      bucket.deletes += row.deletes;
      byDay.set(key, bucket);
    };
    const mergedDays = mergeActivity(
      // `statsFor()` 是按账号查的，行里没有 `accountId` —— 合并前补上（热点排序需要它）。
      accounts.flatMap((account) =>
        deps.notebooks.statsFor(account.id, { limitDays: TRAFFIC_WINDOW_DAYS * 12 }).map((row) => ({ accountId: account.id, ...row })),
      ),
      deps.notebooks.activityForAll(),
    );
    for (const row of mergedDays) tally(row.day, row);
    const daily = [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .slice(-TRAFFIC_WINDOW_DAYS)
      .map(([day, value]) => ({ day, ...value }));

    const sum = (key: "pulls" | "pushes" | "conflicts" | "errors"): number => daily.reduce((acc, row) => acc + row[key], 0);

    /*
     * 按账号聚合的冲突热点（「哪一端坏了」比总数更有用）。
     *
     * ★ 这段必须在这里算：`client_stats` 是按 (account, notebook, day) 存的，
     *   前端只看得到自己那一份 —— 让前端去拼全站热点只能拼出当前登录的人，
     *   而那一页叫「冲突与异常」，问的是**全站**哪一端坏了。
     */
    const accountLabel = new Map(accounts.map((row) => [row.id, row.label]));
    const hotspots = new Map<string, { accountId: string; label: string | null; conflicts: number; errors: number; notebooks: Set<string> }>();
    /*
     * 与上面的流量图**同一套合并规则**（两个来源取较大值），否则会出现
     * 「图上 0 次冲突、热点里 7 次」这种自相矛盾的一屏。
     */
    for (const row of mergedDays) {
      if (row.conflicts === 0 && row.errors === 0) continue;
      const bucket = hotspots.get(row.accountId) ?? {
        accountId: row.accountId,
        label: accountLabel.get(row.accountId) ?? null,
        conflicts: 0,
        errors: 0,
        notebooks: new Set<string>(),
      };
      bucket.conflicts += row.conflicts;
      bucket.errors += row.errors;
      bucket.notebooks.add(row.notebookId);
      hotspots.set(row.accountId, bucket);
    }
    const conflictHotspots = [...hotspots.values()]
      .map((row) => ({
        accountId: row.accountId,
        label: row.label,
        conflicts: row.conflicts,
        errors: row.errors,
        notebooks: row.notebooks.size,
      }))
      .sort((a, b) => b.conflicts + b.errors - (a.conflicts + a.errors));

    /* 健康：CouchDB 可达 + 协议版本 + 没有「置备不一致」的库。 */
    let couchVersion: string | null = null;
    let couchOk = true;
    try {
      couchVersion = (await deps.couch.version()).version;
    } catch {
      couchOk = false;
    }
    const mismatched = notebooks.filter((nb) => nb.provisioning !== null && (!nb.provisioning.designOk || !nb.provisioning.syncInfoOk));
    const startedAt = deps.startedAt ?? now();

    /*
     * 「需要处理」的几条：**判读随数据一起下发**，不在前端重算阈值。
     * 阈值属于结论，放在前端等于让结论和事实分开演化。
     */
    const attention: { id: string; tone: string; title: string; detail: string; action: string }[] = [];
    if (mismatched.length > 0) {
      attention.push({
        id: "provisioning",
        tone: "danger",
        title: mismatched.length + " 个库的置备状态不一致",
        detail: mismatched.map((nb) => nb.name).slice(0, 3).join("、"),
        action: "data",
      });
    }
    if (sum("conflicts") > 0) {
      attention.push({
        id: "conflicts",
        tone: "attention",
        title: "近 30 天累计 " + sum("conflicts") + " 次冲突",
        detail: "持续增长通常意味着一端基线坏了",
        action: "issues",
      });
    }
    if (staleDevices.length > 0) {
      attention.push({
        id: "stale-devices",
        tone: "quiet",
        title: staleDevices.length + " 台设备 30 天未同步",
        detail: "可能是已经弃用的设备",
        action: "devices",
      });
    }

    return json({
      generatedAt: now(),
      accounts: {
        total: accounts.length,
        admins: accounts.filter((row) => row.is_admin === 1).length,
        disabled: accounts.filter((row) => row.status !== "active").length,
      },
      notebooks: {
        total: notebooks.length,
        bytesUsed: notebooks.reduce((acc, nb) => acc + nb.bytesUsed, 0),
      },
      devices: { total: devices.length, stale: staleDevices.length },
      traffic: {
        days: daily,
        total: { pulls: sum("pulls"), pushes: sum("pushes"), conflicts: sum("conflicts"), errors: sum("errors") },
      },
      health: {
        couchOk,
        couchVersion,
        protocolVersion: deps.config.protocolVersionExpected,
        provisioningMismatch: mismatched.length,
        uptimeSeconds: Math.max(0, (now() - startedAt) / 1000),
      },
      attention,
      conflictHotspots,
      /*
       * 最近的控制面动作（概览页「最近控制面动作」卡）。
       * 只取 6 条：概览是「扫一眼」的地方，完整列表在 /panel#/logs。
       */
      recentEvents: deps.notebooks.recentAudit(6),
    });
  });

  /* ------------------------------------------------------------ 台账 */

  /** 全站笔记本台账。**库级视图，不提供笔记内容浏览**（E2EE 下也没有）。 */
  api.get("/notebooks", (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;
    return json({
      notebooks: deps.notebooks.listAllNotebooks(),
      note: "这是库级账本。服务端看不到笔记正文；user-key 库连路径都是密文（epath）。",
    });
  });

  /* ------------------------------------------------------------ 设备 */

  /** 全站设备账本。**只读** —— 没有每设备凭据，所以没有「踢掉这一台」。 */
  api.get("/devices", (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;
    return json({
      devices: deps.notebooks.listAllDevices(),
      canRevoke: false,
      note: "一个账号密钥所有设备共用，所以踢不掉单台设备。唯一的吊销手段是让那个账号轮换密钥（会波及它的所有设备）。",
    });
  });

  /* ---------------------------------------------------------- 邀请码 */

  api.get("/invites", (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;
    return json({
      invites: deps.notebooks.listInvites(),
      note: "库里只有 sha256(邀请码)，明文在生成那一刻就没了 —— 这里显示的是哈希前缀，只能用来对账。",
    });
  });

  /**
   * 作废邀请码（**按哈希**）。
   *
   * `/v1/admin/invites/:code` 收的是**明文码**，而管理页只拿得到哈希
   * （明文在生成那一刻就没了）—— 所以那条端点在这里用不了。
   * 这不是重复实现：收凭据的形状不同，能做的事也不同。
   *
   * 幂等：已经作废过仍返回 204（目标状态已达成，不是错误）。
   */
  api.delete("/invites/:codeHash", (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;
    const codeHash = c.req.param("codeHash");
    /*
     * 只接受 SHA-256 十六进制（64 位）。这个形状校验不是洁癖：
     * 它挡住「把明文码当哈希传进来」——那会静默地作废失败（哈希不匹配），
     * 而运维会以为已经作废了。
     */
    if (!/^[0-9a-f]{64}$/i.test(codeHash)) {
      return json({ error: "邀请码哈希应当是 64 位十六进制", code: "bad-request" }, 400);
    }
    const changed = deps.notebooks.revokeInviteByHash(codeHash);
    deps.audit?.({
      actorId: admin.id,
      action: "panel_revoke_invite",
      target: codeHash.slice(0, 12),
      ip: null,
      detail: changed ? "revoked" : "already-revoked-or-unknown",
    });
    return new Response(null, { status: 204 });
  });

  /* ------------------------------------------------------------ 配置 */

  /**
   * 服务端配置（**只读**）。
   *
   * ★ 刻意不提供写入口：改配置要走环境变量 + 重启。做成热更新会让
   *   「当前生效的到底是什么」变得不可回答 —— 而那正是运维页面存在的意义。
   */
  api.get("/config", (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;
    return json({
      readOnly: true,
      // 密钥类配置**一律不下发**；只给「是不是配了」这种布尔事实。
      config: {
        externalBaseUrl: deps.config.externalBaseUrl,
        protocolVersionExpected: deps.config.protocolVersionExpected,
        couchUrl: deps.config.couchUrl,
        couchUser: deps.config.couchUser,
        couchAdminUserConfigured: Boolean(deps.config.couchAdminUser),
        sqlitePath: deps.config.sqlitePath,
        maxFileBytes: deps.config.maxFileBytes,
        defaultAccountQuotaBytes: deps.config.defaultAccountQuotaBytes,
        defaultAccountQuotaNotebooks: deps.config.defaultAccountQuotaNotebooks,
        sseHeartbeatMs: deps.config.sseHeartbeatMs,
        trustedProxyHeaders: deps.config.trustedProxyHeaders,
        accountRequestsPerMinute: deps.config.accountRequestsPerMinute,
        globalRequestsPerMinute: deps.config.globalRequestsPerMinute,
        logLevel: deps.config.logLevel,
      },
      note: "配置只读。改动请改环境变量后重启服务 —— 热更新会让「当前生效值」变得不可回答。",
    });
  });

  /* ------------------------------------------------------------ 巡检 */

  /**
   * 单个库的置备核对（只读）。
   *
   * 页面按需触发而不是「进来就查全库」：500 个库一次性核对会把 CouchDB 打满。
   * 结果写进 notebook_provisioning，所以下次看台账不用再查一遍。
   */
  api.get("/notebooks/:id/inspection", async (c) => {
    const admin = requireAdmin(c as never);
    if (admin instanceof Response) return admin;
    const notebookId = c.req.param("id");
    const notebook = deps.notebooks.findById(notebookId);
    if (!notebook) return json({ error: "笔记本不存在", code: "not-found" }, 404);

    const report = await inspectNotebook(deps.couch, notebook.db_name, {
      protocolVersion: deps.config.protocolVersionExpected,
      cryptoMode: notebook.crypto_mode === "user-key" ? "user-key" : "none",
    });
    deps.notebooks.recordProvisioning(notebookId, {
      designOk: report.designComplete,
      revsLimit: report.revsLimit === null ? null : String(report.revsLimit),
      syncInfoOk: report.syncInfoExists,
    });
    deps.audit?.({
      actorId: admin.id,
      action: "panel_inspect_notebook",
      target: notebookId,
      ip: null,
      detail: report.healthy ? "healthy" : "problems",
    });
    return json({ inspection: report }, 200);
  });

  return api;
}
