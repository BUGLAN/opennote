/**
 * 控制台「活动日志」：把审计（`audit`）与服务端实测的同步活动（`sync_activity`）
 * 合成**一条**带类别的时间线（`docs/执行-同步重写-2026-11-02.md` 阶段 ②）。
 *
 * 以前排查要在「冲突与异常」「同步日志」两页之间来回切；现在一条线，按类别筛。
 *
 * ## 两个来源的粒度不一样
 *
 * | 来源 | 粒度 | 时刻 |
 * | --- | --- | --- |
 * | `audit` | 一件事一行 | 精确到毫秒 |
 * | `sync_activity` | （账号, 笔记本, UTC 天）一行，计数 | `last_at`（v5 起）；旧行按当天末尾 |
 *
 * 所以同步类条目读起来是「某人 · 某笔记本 · 今天写入 12 次」，而不是逐个文件 ——
 * 服务端只记计数，从来不记路径（明文笔记本也不记，见 `notebooks.ts` 的记账说明）。
 *
 * ## 只出「谁、什么时候、做了什么」
 *
 * 文案里没有笔记内容、没有路径、没有任何令牌；审计表本来就不存这些（`db.ts` 迁移 1）。
 */

import type { SyncActivityRow } from "./notebooks";

export type ActivityCategory = "sync" | "conflict" | "account" | "admin" | "error";

export interface ActivityEntry {
  at: number;
  category: ActivityCategory;
  /** 谁（显示名 / 邮箱）；系统或命令行发起的是 `"系统"` / `"命令行"`。 */
  actor: string;
  /** 做了什么（一句人话，不带主语）。 */
  text: string;
  /** 只有登录类事件带（且只在配置了可信代理头时才有）。 */
  ip: string | null;
}

export interface AuditEvent {
  at: number;
  actorId: string | null;
  action: string;
  target: string | null;
  ip: string | null;
  detail: string | null;
}

export interface ActivityLabels {
  account: (accountId: string) => string;
  notebook: (notebookId: string) => string;
}

const SETTING_NAMES: Record<string, string> = {
  registration: "谁可以注册",
  passwordLogin: "邮箱密码登录",
  defaultQuotaBytes: "默认空间配额",
  githubEnabled: "GitHub 登录开关",
  githubClientId: "GitHub Client ID",
  githubClientSecret: "GitHub Client Secret",
  githubPolicy: "谁能用 GitHub 登录",
  githubOrgs: "允许的 GitHub 组织",
};

/** 字节 → 人话（与控制台页面上的写法一致：1024 进位）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** `a=1,b=2` 形状的 detail → 对象（审计里有几个动作这么写）。 */
function detailFields(detail: string | null): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const part of (detail ?? "").split(",")) {
    const index = part.indexOf("=");
    if (index > 0) fields[part.slice(0, index)] = part.slice(index + 1);
  }
  return fields;
}

/** 一条审计 → 时间线条目。不认识的动作照原样写出来，不吞掉。 */
export function describeAudit(event: AuditEvent, labels: ActivityLabels): ActivityEntry {
  const actor = event.action.startsWith("cli_") ? "命令行" : event.actorId ? labels.account(event.actorId) : "系统";
  const target = event.target;
  const entry = (category: ActivityCategory, text: string, ip: string | null = null): ActivityEntry => ({ at: event.at, category, actor, text, ip });
  const fields = detailFields(event.detail);

  switch (event.action) {
    /* ------------------------------------------------------ 账号与设备 */
    case "setup_admin":
      return entry("account", "初始化了这台服务器，成为第一个管理员", event.ip);
    case "login":
      return entry("account", event.detail ? `登录，设备「${event.detail}」` : "登录了一台设备", event.ip);
    case "login_locked":
      return entry("account", `${target ?? "某个邮箱"} 登录失败次数太多，临时锁定 15 分钟${event.ip ? `（来自 ${event.ip}）` : ""}`, event.ip);
    case "panel_login":
      return entry("account", (event.detail ?? "").startsWith("github:") ? `用 GitHub（@${event.detail!.slice(7)}）登录控制台` : "登录控制台", event.ip);
    case "login_github":
      return entry("account", event.detail ? `用 GitHub 登录，设备「${event.detail}」` : "用 GitHub 登录了一台设备", event.ip);
    case "register_github":
      return entry("account", `用 GitHub（@${event.detail ?? "?"}）自动加入（组织成员）`, event.ip);
    case "link_github":
      return entry("account", `绑定了 GitHub @${event.detail ?? "?"}`, event.ip);
    case "unlink_github":
      return entry("account", "解绑了 GitHub", event.ip);
    case "pair_device":
      return entry("account", event.detail ? `用配对码添加了设备「${event.detail}」` : "用配对码添加了一台设备", event.ip);
    case "set_passphrase":
      return entry("account", "设置了加密口令", event.ip);
    case "change_passphrase":
      return entry("account", "修改了加密口令", event.ip);
    case "register":
      return entry("account", "注册了账号", event.ip);
    case "accept_invite":
      return entry("account", (event.detail ?? "").startsWith("github:") ? `用 GitHub（@${event.detail!.slice(7)}）接受邀请，建好了账号` : "接受邀请，建好了账号", event.ip);
    case "reset_password":
      return entry("account", "用重置链接设了新密码，其它设备已全部下线", event.ip);
    case "change_password":
      return entry("account", "修改了密码，其它设备已全部下线", event.ip);
    case "remove_device":
      return entry("account", "移除了自己的一台设备", event.ip);
    case "create_notebook_invite":
      return entry("account", `生成了笔记本「${target ? labels.notebook(target) : "?"}」的共享链接`);
    case "join_notebook":
      return entry("account", `通过共享链接加入了笔记本「${target ? labels.notebook(target) : "?"}」`);

    /* ------------------------------------------------------------ 同步 */
    case "create_notebook":
      return entry("sync", `新建了${event.detail === "user-key" ? "端到端加密" : ""}笔记本「${target ? labels.notebook(target) : "?"}」`);
    case "delete_notebook":
      return entry("sync", `删除了笔记本「${target ? labels.notebook(target) : "?"}」`);

    /* -------------------------------------------------------- 管理操作 */
    case "create_invite": {
      const who = target ? `邀请 ${target}` : `生成了一个通用邀请链接（可用 ${fields.maxUses ?? "1"} 次）`;
      return entry("admin", `${who}${(event.detail ?? "").includes("admin") ? "，身份是管理员" : ""}`);
    }
    case "revoke_invite":
      return entry("admin", "作废了一个邀请");
    case "extend_invite":
      return entry("admin", `把一个邀请延长了 ${Math.round(Number(event.detail ?? 0) / 86_400) || 1} 天`);
    case "set_quota": {
      const value = event.detail === null || event.detail === "null" ? "跟随默认值" : formatBytes(Number(event.detail));
      return entry("admin", `把 ${target ? labels.account(target) : "?"} 的空间配额改为 ${value}`);
    }
    case "grant_admin":
      return entry("admin", `把 ${target ? labels.account(target) : "?"} 设为管理员`);
    case "revoke_admin":
      return entry("admin", `取消了 ${target ? labels.account(target) : "?"} 的管理员身份`);
    case "disable_account":
    case "cli_disable_account":
      return entry("admin", `停用了 ${target ? labels.account(target) : "?"}`);
    case "enable_account":
      return entry("admin", `重新启用了 ${target ? labels.account(target) : "?"}`);
    case "delete_account":
      return entry("admin", `删除了账号 ${fields.label ?? (target ? labels.account(target) : "?")}（删掉 ${fields.databasesDeleted ?? 0} 个库，移交 ${fields.notebooksTransferred ?? 0} 个共享笔记本）`);
    case "create_password_reset":
      return entry("admin", `为 ${target ? labels.account(target) : "?"} 生成了设置密码链接`);
    case "cli_reset_password":
      return entry("admin", `为 ${target ? labels.account(target) : "?"} 生成了设置密码链接`);
    case "cli_create_admin":
      return entry("admin", `建了管理员 ${target ? labels.account(target) : "?"}`);
    case "update_settings": {
      const names = (event.detail ?? "").split(",").filter(Boolean).map((key) => SETTING_NAMES[key] ?? key);
      return entry("admin", names.length > 0 ? `修改了服务设置：${names.join("、")}` : "保存了服务设置（没有改动）");
    }
    case "admin_unlink_github":
      return entry("admin", `解绑了 ${target ? labels.account(target) : "?"} 的 GitHub`);
    case "admin_remove_device":
      return entry("admin", `移除了 ${target ? labels.account(target) : "?"} 的设备「${event.detail ?? "?"}」`);
    case "prune_devices":
      return entry("admin", `移除了 ${fields.count ?? 0} 台超过 ${fields.days ?? 90} 天没同步的设备`);

    /* ------------------------------------------------------------ 错误 */
    case "delete_database_failed":
      return entry("error", `删除笔记本「${target ? labels.notebook(target) : "?"}」的库失败，需要人工清理`);
    case "create_notebook_failed":
      return entry("error", `新建笔记本「${target ? labels.notebook(target) : "?"}」失败`);

    default:
      return entry(event.action.endsWith("_failed") ? "error" : "admin", event.action + (event.detail ? `（${event.detail}）` : ""));
  }
}

/** UTC 天的最后一毫秒（旧行没有 `last_at` 时用它排序）。 */
function endOfUtcDay(day: string): number {
  return Date.parse(`${day}T23:59:59.999Z`);
}

/** 一行同步计数 → 0–3 条时间线条目（同步 / 冲突 / 错误各一条，计数为 0 的不出）。 */
export function describeSyncActivity(row: SyncActivityRow, labels: ActivityLabels, now: number): ActivityEntry[] {
  const at = Math.min(row.lastAt ?? endOfUtcDay(row.day), now);
  const actor = labels.account(row.accountId);
  const notebook = labels.notebook(row.notebookId);
  const entries: ActivityEntry[] = [];
  const parts = [
    row.pushes > 0 ? `写入 ${row.pushes} 次` : null,
    row.deletes > 0 ? `删除 ${row.deletes} 次` : null,
    row.pulls > 0 ? `读取 ${row.pulls} 次` : null,
  ].filter((part): part is string => part !== null);
  if (parts.length > 0) entries.push({ at, category: "sync", actor, text: `「${notebook}」${parts.join("、")}`, ip: null });
  if (row.conflicts > 0) {
    entries.push({ at, category: "conflict", actor, text: `「${notebook}」${row.conflicts} 次写入冲突（两台设备改了同一篇，由客户端裁决）`, ip: null });
  }
  if (row.errors > 0) entries.push({ at, category: "error", actor, text: `「${notebook}」${row.errors} 次请求在存储那一侧出错`, ip: null });
  return entries;
}

/**
 * 合成时间线：倒序、按类别 / 关键词筛，`offset` 分页。
 * 用偏移而不是「`at` 早于某个时刻」：同一天的旧同步行共用一个时刻，按时刻翻页会漏行。
 */
export function buildTimeline(input: {
  audit: AuditEvent[];
  activity: SyncActivityRow[];
  labels: ActivityLabels;
  now: number;
  category?: ActivityCategory | null;
  query?: string | null;
  offset?: number;
  limit: number;
}): { entries: ActivityEntry[]; nextOffset: number | null } {
  const query = input.query?.trim().toLowerCase() ?? "";
  const offset = input.offset ?? 0;
  const all = [
    ...input.audit.map((event) => describeAudit(event, input.labels)),
    ...input.activity.flatMap((row) => describeSyncActivity(row, input.labels, input.now)),
  ]
    .filter((entry) => !input.category || entry.category === input.category)
    .filter((entry) => query === "" || `${entry.actor} ${entry.text}`.toLowerCase().includes(query))
    .sort((a, b) => b.at - a.at);
  const entries = all.slice(offset, offset + input.limit);
  return { entries, nextOffset: all.length > offset + input.limit ? offset + input.limit : null };
}
