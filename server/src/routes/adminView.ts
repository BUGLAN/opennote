/**
 * `/v1/admin/*` 的聚合读：控制台各页一次取齐要显示的东西（`docs/执行-同步重写-2026-11-02.md` 阶段 ②）。
 *
 * | 接口 | 页面 |
 * | --- | --- |
 * | `GET /overview` | 概览：计数、「需要你处理」、「值得留意」、运行状态、最近活动 |
 * | `GET /activity` | 活动日志（审计 + 同步计数合成一条时间线，见 `activity.ts`） |
 * | `GET /accounts/:id` | 用户详情抽屉：账号、笔记本、设备、最近活动 |
 * | `GET /notebooks` | 全站笔记本 |
 * | `GET /devices` | 全站设备 |
 *
 * 写操作（改配额、移除设备、邀请……）在 `admin.ts`。这里只读，纪律相同：
 * 每个处理器的第一句是管理员闸门，响应里没有任何哈希、密文或笔记内容。
 *
 * 响应都带 `now`（服务端时钟）：「在线」「N 天前」由页面按它算，不受浏览器时钟偏差影响。
 */

import { statfsSync } from "node:fs";
import { dirname } from "node:path";
import { Hono } from "hono";
import { adminAccountSummarySchema, parseContract, type AdminAccountSummary } from "../../../shared/contract";
import { accountLabel, type AccountRow, type AccountStore } from "../auth/accounts";
import { buildTimeline, type ActivityCategory, type ActivityLabels } from "../activity";
import type { CouchClient } from "../couch/client";
import type { ServerConfig } from "../config";
import type { AdminDeviceRow, NotebookStore } from "../notebooks";
import type { SettingsStore } from "../settings";
import { createAdminGate } from "./adminGate";
import { quotaOf } from "./auth";

export interface AdminViewDeps {
  accounts: AccountStore;
  notebooks: NotebookStore;
  config: ServerConfig;
  couch: CouchClient;
  settings: SettingsStore;
  startedAt?: number;
  now?: () => number;
}

/** 多久之内同步过算「在线」。检查点每次同步都刷，客户端空闲时 SSE 心跳也会刷会话。 */
export const ONLINE_WINDOW_MS = 5 * 60_000;
/** 「值得留意」里「很久没同步」的门槛。 */
export const STALE_DEVICE_DAYS = 90;
/** 配额用到多少算「快满了」。 */
export const QUOTA_WARN_RATIO = 0.9;
/** 活动日志往回看多少天的同步计数。 */
const ACTIVITY_DAYS = 90;
/** 活动日志一次最多翻到多深（审计是一次读出来再合并的）。 */
const ACTIVITY_MAX_DEPTH = 5000;

const CATEGORIES: readonly ActivityCategory[] = ["sync", "conflict", "account", "admin", "error"];

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 用户列表 / 详情共用的账号摘要（一次取齐笔记本数与设备，不逐行查）。 */
export function accountSummaries(
  deps: Pick<AdminViewDeps, "notebooks" | "config" | "settings">,
  rows: AccountRow[],
  now: number,
): AdminAccountSummary[] {
  const notebookCounts = deps.notebooks.notebookCountsByAccount();
  const devices = deps.notebooks.listAllDevices({ now });
  return rows.map((row) => {
    const own = devices.filter((device) => device.accountId === row.id);
    const seen = own.map((device) => device.lastSeenAt).filter((value): value is number => value !== null);
    return parseContract(
      adminAccountSummarySchema,
      {
        accountId: row.id,
        email: row.email,
        displayName: row.display_name,
        loginMethods: { password: row.password_hash !== null },
        status: row.status === "disabled" ? "disabled" : "active",
        isAdmin: row.is_admin === 1,
        quota: quotaOf(deps, row),
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        notebookCount: notebookCounts.get(row.id) ?? 0,
        deviceCount: own.filter((device) => device.signedIn).length,
        lastSyncAt: seen.length > 0 ? Math.max(...seen) : null,
      },
      "管理端账号摘要",
    );
  });
}

/** 时间线要的名字查找（一次读齐，避免每条事件查一次库）。 */
function activityLabels(deps: Pick<AdminViewDeps, "accounts" | "notebooks">): ActivityLabels {
  const accounts = new Map(deps.accounts.list().map((row) => [row.id, accountLabel(row)]));
  const notebooks = deps.notebooks.notebookLabels();
  return {
    account: (id) => accounts.get(id) ?? `已删除的账号 ${id.slice(0, 6)}`,
    notebook: (id) => {
      const row = notebooks.get(id);
      if (!row) return `笔记本 ${id.slice(0, 8)}`;
      return row.deleted ? `${row.name}（已删除）` : row.name;
    },
  };
}

/** 数据目录所在磁盘还剩多少（内存库 / 平台不支持时为 null）。 */
function diskFreeBytes(config: ServerConfig): number | null {
  if (config.sqlitePath === ":memory:") return null;
  try {
    const stats = statfsSync(dirname(config.sqlitePath));
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function deviceView(device: AdminDeviceRow, now: number): AdminDeviceRow & { online: boolean } {
  return { ...device, online: device.signedIn && device.lastSeenAt !== null && now - device.lastSeenAt < ONLINE_WINDOW_MS };
}

export function createAdminViewRoutes(deps: AdminViewDeps): Hono {
  const routes = new Hono();
  const requireAdmin = createAdminGate(deps);
  const now = (): number => deps.now?.() ?? Date.now();
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

  /* ---------------------------------------------------------------- 概览 */

  routes.get("/overview", async (c) => {
    const admin = requireAdmin(c);
    if (admin instanceof Response) return admin;
    const at = now();
    const accounts = deps.accounts.list();
    const summaries = accountSummaries(deps, accounts, at);
    const devices = deps.notebooks.listAllDevices({ now: at }).map((device) => deviceView(device, at));
    const signedIn = devices.filter((device) => device.signedIn);
    const invites = deps.notebooks.listInvites().filter(
      (invite) => invite.revokedAt === null && invite.uses < invite.maxUses && (invite.expiresAt === null || invite.expiresAt > at),
    );
    const today = utcDay(at);
    const weekAgo = utcDay(at - 6 * 86_400_000);
    const activity = deps.notebooks.activitySince(weekAgo);
    const todayRows = activity.filter((row) => row.day === today);
    const staleCutoff = at - STALE_DEVICE_DAYS * 86_400_000;

    const attention = [
      ...summaries
        .filter((account) => account.status === "active" && account.quota.bytesLimit > 0 && account.quota.bytesUsed / account.quota.bytesLimit >= QUOTA_WARN_RATIO)
        .map((account) => ({
          kind: "quota" as const,
          accountId: account.accountId,
          label: account.displayName || account.email || account.accountId.slice(0, 8),
          email: account.email,
          bytesUsed: account.quota.bytesUsed,
          bytesLimit: account.quota.bytesLimit,
        })),
      ...invites
        .filter((invite) => invite.expiresAt !== null && invite.expiresAt - at < 86_400_000)
        .map((invite) => ({ kind: "invite-expiring" as const, id: invite.codeHash, email: invite.email, expiresAt: invite.expiresAt })),
    ];

    let couchVersion: string | null = null;
    try {
      couchVersion = (await deps.couch.version()).version;
    } catch {
      couchVersion = null;
    }
    const page = deps.accounts.db.prepare("PRAGMA page_count").get() as { page_count: number };
    const pageSize = deps.accounts.db.prepare("PRAGMA page_size").get() as { page_size: number };
    const labels = activityLabels(deps);

    return json({
      now: at,
      users: {
        total: accounts.length,
        admins: summaries.filter((account) => account.isAdmin).length,
        disabled: summaries.filter((account) => account.status === "disabled").length,
        pendingInvites: invites.length,
      },
      devices: { total: signedIn.length, online: signedIn.filter((device) => device.online).length },
      storage: { usedBytes: deps.notebooks.totalBytes(), diskFreeBytes: diskFreeBytes(deps.config), notebooks: deps.notebooks.totalNotebooks() },
      today: {
        changes: todayRows.reduce((sum, row) => sum + row.pushes + row.deletes, 0),
        conflicts: todayRows.reduce((sum, row) => sum + row.conflicts, 0),
      },
      attention,
      noteworthy: {
        staleDevices: signedIn.filter((device) => (device.lastSeenAt ?? device.createdAt) < staleCutoff).length,
        staleDays: STALE_DEVICE_DAYS,
        conflictsThisWeek: activity.reduce((sum, row) => sum + row.conflicts, 0),
        errorsThisWeek: activity.reduce((sum, row) => sum + row.errors, 0),
      },
      server: {
        externalBaseUrl: deps.config.externalBaseUrl,
        protocolVersion: deps.config.protocolVersionExpected,
        couchVersion,
        uptimeSeconds: Math.max(0, Math.floor((at - (deps.startedAt ?? at)) / 1000)),
        databaseBytes: page.page_count * pageSize.page_size,
        maxFileBytes: deps.config.maxFileBytes,
      },
      recent: buildTimeline({ audit: deps.notebooks.auditBefore(null, 40), activity, labels, now: at, limit: 8 }).entries,
    });
  });

  /* ------------------------------------------------------------ 活动日志 */

  /** `?category=sync|conflict|account|admin|error&q=关键词&offset=0&limit=100` */
  routes.get("/activity", (c) => {
    const admin = requireAdmin(c);
    if (admin instanceof Response) return admin;
    const at = now();
    const rawCategory = c.req.query("category");
    const category = CATEGORIES.find((value) => value === rawCategory) ?? null;
    const limit = Math.min(500, Math.max(1, Number.parseInt(c.req.query("limit") ?? "", 10) || 100));
    const offset = Math.min(ACTIVITY_MAX_DEPTH, Math.max(0, Number.parseInt(c.req.query("offset") ?? "", 10) || 0));
    const timeline = buildTimeline({
      audit: deps.notebooks.auditBefore(null, ACTIVITY_MAX_DEPTH + limit),
      activity: deps.notebooks.activitySince(utcDay(at - (ACTIVITY_DAYS - 1) * 86_400_000)),
      labels: activityLabels(deps),
      now: at,
      category,
      query: c.req.query("q") ?? null,
      offset,
      limit,
    });
    return json({ now: at, ...timeline });
  });

  /* ------------------------------------------------------------ 用户详情 */

  routes.get("/accounts/:id", (c) => {
    const admin = requireAdmin(c);
    if (admin instanceof Response) return admin;
    const at = now();
    const row = deps.accounts.findById(c.req.param("id"));
    if (!row) return json({ error: "账号不存在", code: "not-found" }, 404);
    const [summary] = accountSummaries(deps, [row], at);
    const notebooks = deps.notebooks.listForAccount(row.id).map(({ notebook, role }) => ({
      id: notebook.id,
      name: notebook.name,
      role,
      cryptoMode: notebook.crypto_mode === "user-key" ? "user-key" : "none",
      bytesUsed: deps.notebooks.notebookBytesOf(notebook.id),
      createdAt: notebook.created_at,
    }));
    const devices = deps.notebooks.listAllDevices({ accountId: row.id, now: at }).map((device) => deviceView(device, at));
    const labels = activityLabels(deps);
    const recent = buildTimeline({
      audit: deps.notebooks.auditBefore(null, 500).filter((event) => event.actorId === row.id || event.target === row.id),
      activity: deps.notebooks.activitySince(utcDay(at - 29 * 86_400_000)).filter((item) => item.accountId === row.id),
      labels,
      now: at,
      limit: 10,
    }).entries;
    return json({ now: at, account: summary, notebooks, devices, recent, isSelf: row.id === admin.id });
  });

  /* ---------------------------------------------------------------- 笔记本 */

  routes.get("/notebooks", (c) => {
    const admin = requireAdmin(c);
    if (admin instanceof Response) return admin;
    return json({ now: now(), notebooks: deps.notebooks.listAllNotebooks() });
  });

  /* ---------------------------------------------------------------- 设备 */

  routes.get("/devices", (c) => {
    const admin = requireAdmin(c);
    if (admin instanceof Response) return admin;
    const at = now();
    return json({
      now: at,
      onlineWindowMs: ONLINE_WINDOW_MS,
      staleDays: STALE_DEVICE_DAYS,
      devices: deps.notebooks.listAllDevices({ now: at }).map((device) => deviceView(device, at)),
    });
  });

  return routes;
}
