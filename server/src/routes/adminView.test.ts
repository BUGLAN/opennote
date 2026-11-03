/**
 * 控制台的聚合读（`adminView.ts`）与阶段 ② 新加的管理动作（移除设备、邀请延长 / 按 id 作废、
 * 关不掉的密码登录、关闭注册挡住邀请）。
 */

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { openDatabase } from "../db";
import { loadConfig } from "../config";
import { NotebookStore } from "../notebooks";
import { SettingsStore } from "../settings";
import { seedAccount, testAccountStore } from "../auth/testAccounts.test-helper";
import { FakeCouch, couchClient } from "../couch/fakeCouch.test-helper";
import { buildTimeline, describeAudit, describeSyncActivity } from "../activity";
import { createAuthRoutes } from "./auth";
import { createAdminRoutes } from "./admin";
import { createAdminViewRoutes } from "./adminView";

const ENV: Record<string, string> = {
  EXTERNAL_BASE_URL: "https://notes.example.com",
  COUCH_URL: "http://couchdb:5984",
  COUCH_USER: "sync-service",
  COUCH_PASSWORD: "pw",
  COUCH_ADMIN_USER: "admin",
  COUCH_ADMIN_PASSWORD: "apw",
  DEFAULT_ACCOUNT_QUOTA_BYTES: String(1000),
};
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-02T12:00:00Z");
const TODAY = "2026-11-02";

function makeWorld() {
  const db = openDatabase({ path: ":memory:" });
  const config = loadConfig(ENV);
  const accounts = testAccountStore(db);
  const notebooks = new NotebookStore(db);
  const settings = new SettingsStore(db, config);
  const couch = couchClient(new FakeCouch());
  const audit = (event: Parameters<NotebookStore["audit"]>[0]) => notebooks.audit({ ...event, now: NOW });
  const now = () => NOW;
  const app = new Hono();
  app.route("/v1", createAuthRoutes({ accounts, notebooks, config, settings, audit, now }));
  app.route("/v1/admin", createAdminViewRoutes({ accounts, notebooks, config, couch, settings, now, startedAt: NOW - 3600_000 }));
  app.route("/v1/admin", createAdminRoutes({ accounts, notebooks, config, couch, settings, audit, now }));
  const call = async (path: string, init: { method?: string; token?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    const response = await app.request(`http://localhost${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    return { status: response.status, text, body: text ? (JSON.parse(text) as Record<string, any>) : null };
  };
  const notebook = (ownerId: string, name: string, bytes: number, cryptoMode: "none" | "user-key" = "none") => {
    const row = notebooks.create({ ownerId, name, cryptoMode, now: NOW - 10 * DAY });
    notebooks.addNotebookBytes(row.id, bytes, NOW - 3600_000);
    return row;
  };
  return { db, accounts, notebooks, settings, call, notebook };
}

describe("闸门", () => {
  it("普通账号访问每个聚合读都是 403，且不带任何数据", async () => {
    const world = makeWorld();
    const member = seedAccount(world.accounts, { email: "secret-member@example.com" });
    for (const path of ["/v1/admin/overview", "/v1/admin/activity", "/v1/admin/notebooks", "/v1/admin/devices", `/v1/admin/accounts/${member.id}`]) {
      const response = await world.call(path, { token: member.token });
      expect(response.status, path).toBe(403);
      expect(response.text, path).not.toContain("secret-member");
    }
    expect((await world.call("/v1/admin/overview")).status).toBe(401);
  });
});

describe("概览", () => {
  it("计数、需要处理（配额 ≥ 90%、一天内过期的邀请）、值得留意、今日变更", async () => {
    const world = makeWorld();
    const admin = seedAccount(world.accounts, { isAdmin: true, now: NOW - 30 * DAY });
    const mia = seedAccount(world.accounts, { email: "mia@example.com", displayName: "Mia", now: NOW - 30 * DAY });
    const nb = world.notebook(mia.id, "摄影", 950);
    world.notebooks.recordActivity({ accountId: mia.id, notebookId: nb.id, day: TODAY, kind: "push", amount: 7, now: NOW - 60_000 });
    world.notebooks.recordActivity({ accountId: mia.id, notebookId: nb.id, day: TODAY, kind: "delete", amount: 2, now: NOW - 60_000 });
    world.notebooks.recordActivity({ accountId: mia.id, notebookId: nb.id, day: TODAY, kind: "conflict", now: NOW - 60_000 });
    world.accounts.createInvite({ createdBy: admin.id, email: "chen@example.com", expiresInSeconds: 3600, now: NOW });
    world.accounts.createInvite({ createdBy: admin.id, expiresInSeconds: 7 * 24 * 3600, now: NOW });
    // mia 的设备刚同步过（在线）；管理员的设备 100 天没动。
    world.notebooks.upsertDevice({ deviceId: mia.deviceId, accountId: mia.id, name: "Mac", platform: "desktop", now: NOW - 60_000 });
    world.notebooks.upsertDevice({ deviceId: admin.deviceId, accountId: admin.id, name: "Old", platform: "desktop", now: NOW - 100 * DAY });
    world.db.prepare("UPDATE sessions SET last_used_at = ? WHERE account_id = ?").run(NOW - 100 * DAY, admin.id);

    // 用控制台会话来问（没有 device_id）：拿设备令牌问会把那台设备自己刷成「在线」。
    const { token: panelToken } = world.accounts.createSession({ accountId: admin.id, kind: "panel", now: NOW });
    const { status, body } = await world.call("/v1/admin/overview", { token: panelToken });
    expect(status).toBe(200);
    expect(body!.users).toMatchObject({ total: 2, admins: 1, pendingInvites: 2 });
    expect(body!.devices).toEqual({ total: 2, online: 1 });
    expect(body!.storage.usedBytes).toBe(950);
    expect(body!.today).toEqual({ changes: 9, conflicts: 1 });
    expect(body!.attention).toEqual([
      expect.objectContaining({ kind: "quota", accountId: mia.id, bytesUsed: 950, bytesLimit: 1000 }),
      expect.objectContaining({ kind: "invite-expiring", email: "chen@example.com" }),
    ]);
    expect(body!.noteworthy).toMatchObject({ staleDevices: 1, conflictsThisWeek: 1 });
    expect(body!.server).toMatchObject({ uptimeSeconds: 3600, externalBaseUrl: "https://notes.example.com" });
    expect(body!.recent.length).toBeGreaterThan(0);
  });
});

describe("活动日志", () => {
  it("审计与同步计数合成一条线，按类别 / 关键词筛，按偏移翻页", async () => {
    const world = makeWorld();
    const admin = seedAccount(world.accounts, { isAdmin: true, displayName: "Admin" });
    const lan = seedAccount(world.accounts, { displayName: "Lan" });
    const nb = world.notebook(lan.id, "读书笔记", 10);
    world.notebooks.recordActivity({ accountId: lan.id, notebookId: nb.id, day: TODAY, kind: "push", amount: 3, now: NOW - 5000 });
    world.notebooks.recordActivity({ accountId: lan.id, notebookId: nb.id, day: TODAY, kind: "conflict", now: NOW - 5000 });
    world.notebooks.audit({ actorId: admin.id, action: "grant_admin", target: lan.id, now: NOW - 1000 });
    world.notebooks.audit({ actorId: lan.id, action: "login", target: lan.deviceId, detail: "MacBook", now: NOW - 9000 });

    const all = (await world.call("/v1/admin/activity", { token: admin.token })).body!;
    expect(all.entries.map((entry: { category: string }) => entry.category)).toEqual(["admin", "sync", "conflict", "account"]);
    expect(all.entries[0]).toMatchObject({ actor: "Admin", text: "把 Lan 设为管理员" });
    expect(all.entries[1].text).toBe("「读书笔记」写入 3 次");

    const conflicts = (await world.call("/v1/admin/activity?category=conflict", { token: admin.token })).body!;
    expect(conflicts.entries).toHaveLength(1);
    const search = (await world.call(`/v1/admin/activity?q=${encodeURIComponent("macbook")}`, { token: admin.token })).body!;
    expect(search.entries).toHaveLength(1);

    const page1 = (await world.call("/v1/admin/activity?limit=3", { token: admin.token })).body!;
    expect(page1.nextOffset).toBe(3);
    const page2 = (await world.call("/v1/admin/activity?limit=3&offset=3", { token: admin.token })).body!;
    expect(page2.entries).toHaveLength(1);
    expect(page2.nextOffset).toBeNull();
  });

  it("文案：未知动作原样写出；计数为 0 的列不出现；旧行没有 last_at 时按当天末尾、且不晚于现在", () => {
    const labels = { account: (id: string) => `@${id}`, notebook: (id: string) => `#${id}` };
    expect(describeAudit({ at: 1, actorId: null, action: "mystery_action", target: null, ip: null, detail: "x" }, labels)).toMatchObject({ actor: "系统", text: "mystery_action（x）" });
    expect(describeAudit({ at: 1, actorId: null, action: "cli_reset_password", target: "a", ip: null, detail: null }, labels).actor).toBe("命令行");
    const rows = describeSyncActivity({ accountId: "a", notebookId: "n", day: "2026-11-01", pulls: 4, pushes: 0, deletes: 0, conflicts: 0, errors: 2, lastAt: null }, labels, NOW);
    expect(rows.map((row) => [row.category, row.text])).toEqual([
      ["sync", "「#n」读取 4 次"],
      ["error", "「#n」2 次请求在存储那一侧出错"],
    ]);
    expect(rows[0]!.at).toBe(Date.parse("2026-11-01T23:59:59.999Z"));
    const today = describeSyncActivity({ accountId: "a", notebookId: "n", day: TODAY, pulls: 1, pushes: 0, deletes: 0, conflicts: 0, errors: 0, lastAt: null }, labels, NOW);
    expect(today[0]!.at).toBe(NOW);
    expect(buildTimeline({ audit: [], activity: [], labels, now: NOW, limit: 10 })).toEqual({ entries: [], nextOffset: null });
  });
});

describe("用户", () => {
  it("列表带笔记本数、登录中的设备数、最近同步", async () => {
    const world = makeWorld();
    const admin = seedAccount(world.accounts, { isAdmin: true });
    const mia = seedAccount(world.accounts);
    world.notebook(mia.id, "a", 1);
    world.notebook(mia.id, "b", 1);
    world.notebooks.upsertDevice({ deviceId: mia.deviceId, accountId: mia.id, name: "Mac", platform: "desktop", now: NOW - 5000 });
    const row = (await world.call("/v1/admin/accounts", { token: admin.token })).body!.accounts.find((x: { accountId: string }) => x.accountId === mia.id);
    expect(row).toMatchObject({ notebookCount: 2, deviceCount: 1 });
    expect(row.lastSyncAt).toBeGreaterThanOrEqual(NOW - 5000);
  });

  it("详情：笔记本、设备、最近活动；不存在 404；响应里没有哈希", async () => {
    const world = makeWorld();
    const admin = seedAccount(world.accounts, { isAdmin: true });
    const mia = seedAccount(world.accounts);
    world.notebook(mia.id, "私密", 5, "user-key");
    world.notebooks.upsertDevice({ deviceId: mia.deviceId, accountId: mia.id, name: "Mac", platform: "desktop", os: "macos", now: NOW });
    world.notebooks.audit({ actorId: admin.id, action: "set_quota", target: mia.id, detail: "2048", now: NOW });

    const detail = await world.call(`/v1/admin/accounts/${mia.id}`, { token: admin.token });
    expect(detail.status).toBe(200);
    expect(detail.body!.notebooks).toEqual([expect.objectContaining({ name: "私密", cryptoMode: "user-key", role: "owner", bytesUsed: 5 })]);
    expect(detail.body!.devices).toEqual([expect.objectContaining({ deviceId: mia.deviceId, os: "macos", signedIn: true, online: true })]);
    expect(detail.body!.recent[0].text).toContain("空间配额改为 2.0 KB");
    expect(detail.body!.isSelf).toBe(false);
    expect(detail.text).not.toMatch(/token_hash|password_hash|wrapped_enc_root/);
    expect((await world.call(`/v1/admin/accounts/${"0".repeat(32)}`, { token: admin.token })).status).toBe(404);
  });
});

describe("设备", () => {
  it("移除：账本标记 + 吊销会话，那台设备的令牌立刻 401", async () => {
    const world = makeWorld();
    const admin = seedAccount(world.accounts, { isAdmin: true });
    const mia = seedAccount(world.accounts);
    world.notebooks.upsertDevice({ deviceId: mia.deviceId, accountId: mia.id, name: "Mac", platform: "desktop", now: NOW });
    expect((await world.call("/v1/me", { token: mia.token })).status).toBe(200);

    const removed = await world.call(`/v1/admin/devices/${mia.deviceId}`, { method: "DELETE", token: admin.token });
    expect(removed.status).toBe(200);
    expect(removed.body!.revokedSessions).toBe(1);
    expect((await world.call("/v1/me", { token: mia.token })).status).toBe(401);
    const list = (await world.call("/v1/admin/devices", { token: admin.token })).body!.devices;
    expect(list.find((device: { deviceId: string }) => device.deviceId === mia.deviceId)).toMatchObject({ signedIn: false, online: false });
    expect((await world.call(`/v1/admin/devices/${"f".repeat(32)}`, { method: "DELETE", token: admin.token })).status).toBe(404);
  });

  it("批量移除只动「登录着、超过 N 天没同步」的", async () => {
    const world = makeWorld();
    const admin = seedAccount(world.accounts, { isAdmin: true });
    const fresh = seedAccount(world.accounts);
    const stale = seedAccount(world.accounts);
    world.notebooks.upsertDevice({ deviceId: fresh.deviceId, accountId: fresh.id, name: "new", platform: "desktop", now: NOW - DAY });
    world.notebooks.upsertDevice({ deviceId: stale.deviceId, accountId: stale.id, name: "old", platform: "desktop", now: NOW - 120 * DAY });
    world.db.prepare("UPDATE sessions SET last_used_at = ? WHERE account_id = ?").run(NOW - 120 * DAY, stale.id);

    const pruned = await world.call("/v1/admin/devices/prune", { token: admin.token, body: { inactiveDays: 90 } });
    expect(pruned.body).toEqual({ removed: 1 });
    expect((await world.call("/v1/me", { token: stale.token })).status).toBe(401);
    expect((await world.call("/v1/me", { token: fresh.token })).status).toBe(200);
  });
});

describe("邀请", () => {
  it("列表给 id 与状态；按 id 延长、作废", async () => {
    const world = makeWorld();
    const admin = seedAccount(world.accounts, { isAdmin: true });
    await world.call("/v1/admin/invites", { token: admin.token, body: { email: "chen@example.com", expiresInSeconds: 3600 } });
    const [invite] = (await world.call("/v1/admin/invites", { token: admin.token })).body!.invites;
    expect(invite).toMatchObject({ state: "open", email: "chen@example.com" });
    expect(invite.id).toMatch(/^[0-9a-f]{64}$/);

    const extended = await world.call(`/v1/admin/invites/${invite.id}`, { method: "PATCH", token: admin.token, body: { extendSeconds: 2 * 86_400 } });
    expect(extended.body!.expiresAt).toBe(invite.expiresAt + 2 * DAY);

    expect((await world.call(`/v1/admin/invites/${invite.id}`, { method: "DELETE", token: admin.token })).status).toBe(204);
    const [after] = (await world.call("/v1/admin/invites", { token: admin.token })).body!.invites;
    expect(after.state).toBe("revoked");
    expect((await world.call(`/v1/admin/invites/${invite.id}`, { method: "PATCH", token: admin.token, body: {} })).status).toBe(404);
  });

  it("「关闭注册」时邀请链接也用不了；/join 页拿到的信息带发邀请的人", async () => {
    const world = makeWorld();
    const admin = seedAccount(world.accounts, { isAdmin: true, displayName: "Admin" });
    const created = await world.call("/v1/admin/invites", { token: admin.token, body: {} });
    const code = created.body!.code as string;
    expect((await world.call(`/v1/auth/invites/${code}`)).body).toMatchObject({ invitedBy: "Admin" });

    world.settings.set({ registration: "closed" });
    expect((await world.call(`/v1/auth/invites/${code}`)).status).toBe(403);
    const accept = await world.call(`/v1/auth/invites/${code}`, { body: { email: "x@example.com", password: "long-enough-pw" } });
    expect(accept.status).toBe(403);
    expect(accept.body!.code).toBe("registration-closed");
  });
});

describe("服务设置", () => {
  it("在有第二种登录方式之前，不许关掉邮箱密码登录", async () => {
    const world = makeWorld();
    const admin = seedAccount(world.accounts, { isAdmin: true });
    const response = await world.call("/v1/admin/settings", { method: "PATCH", token: admin.token, body: { passwordLogin: false } });
    expect(response.status).toBe(409);
    expect(world.settings.get("passwordLogin")).toBe(true);
  });
});
