/**
 * 账号 / 会话 / 邀请 / 重置密码（`docs/执行-同步重写-2026-11-02.md`「身份模型」）。
 *
 * 用低成本 scrypt 参数（`testAccountStore`）：这里测的是流程，不是 KDF 的强度。
 */

import { describe, expect, it } from "vitest";
import { openDatabase } from "../db";
import { AccountError, hashToken, PANEL_SESSION_TTL_MS } from "./accounts";
import { hashPassword, verifyPassword, FAST_PARAMS_FOR_TESTS } from "./passwords";
import { seedAccount, testAccountStore } from "./testAccounts.test-helper";

function makeStore() {
  const db = openDatabase({ path: ":memory:" });
  return { db, store: testAccountStore(db) };
}

async function rejection(promise: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (error) {
    if (error instanceof AccountError) return error.rejection;
    throw error;
  }
  throw new Error("预期抛 AccountError，结果成功了");
}

describe("密码哈希", () => {
  it("同一个密码两次哈希结果不同（带盐），都能校验通过；错的密码不通过", async () => {
    const a = await hashPassword("correct horse battery", FAST_PARAMS_FOR_TESTS);
    const b = await hashPassword("correct horse battery", FAST_PARAMS_FOR_TESTS);
    expect(a).not.toBe(b);
    expect(a.startsWith("scrypt$16$1$1$")).toBe(true);
    expect(await verifyPassword("correct horse battery", a)).toBe(true);
    expect(await verifyPassword("correct horse batterY", a)).toBe(false);
  });

  it("坏掉的哈希串当作「不对」，不抛错", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "scrypt$abc$1$1$c2FsdA$aGFzaA")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$whatever")).toBe(false);
  });
});

describe("初始化（零账号时建第一个管理员）", () => {
  it("零账号时可用，建出来的是管理员；之后再调就拒绝", async () => {
    const { store } = makeStore();
    expect(store.needsSetup()).toBe(true);
    const admin = await store.setup({ email: "Admin@Example.com ", password: "long-enough-pw" });
    expect(admin.is_admin).toBe(1);
    expect(admin.email).toBe("admin@example.com");
    expect(store.needsSetup()).toBe(false);
    expect(await rejection(store.setup({ email: "other@example.com", password: "long-enough-pw" }))).toBe("setup-done");
  });

  it("密码太短直接拒绝，不建号", async () => {
    const { store } = makeStore();
    expect(await rejection(store.setup({ email: "a@example.com", password: "short" }))).toBe("weak-password");
    expect(store.count()).toBe(0);
  });
});

describe("登录", () => {
  it("邮箱不区分大小写；密码对才行；错误不区分是邮箱错还是密码错", async () => {
    const { store } = makeStore();
    await store.create({ email: "lan@example.com", password: "long-enough-pw" });
    expect((await store.login("LAN@example.com", "long-enough-pw")).email).toBe("lan@example.com");

    const wrongPassword = await rejection(store.login("lan@example.com", "nope-nope-nope"));
    const noSuchEmail = await rejection(store.login("ghost@example.com", "long-enough-pw"));
    expect(wrongPassword).toBe("bad-credentials");
    expect(noSuchEmail).toBe("bad-credentials");
  });

  it("没设密码的账号（例如以后只用 GitHub 的）不能用密码登录", async () => {
    const { store } = makeStore();
    await store.create({ email: "gh@example.com" });
    expect(await rejection(store.login("gh@example.com", "anything-at-all"))).toBe("bad-credentials");
  });

  it("停用的账号密码对也进不来，且说的是「停用」而不是「密码错」", async () => {
    const { store } = makeStore();
    const row = await store.create({ email: "a@example.com", password: "long-enough-pw" });
    store.setStatus(row.id, "disabled");
    expect(await rejection(store.login("a@example.com", "long-enough-pw"))).toBe("disabled");
  });

  it("同一个邮箱不能注册两次", async () => {
    const { store } = makeStore();
    await store.create({ email: "a@example.com" });
    expect(await rejection(store.create({ email: "A@example.com" }))).toBe("email-taken");
  });
});

describe("会话", () => {
  it("令牌明文不进库，库里只有 sha256；能用令牌找回账号", () => {
    const { db, store } = makeStore();
    const account = seedAccount(store);
    const row = db.prepare("SELECT token_hash FROM sessions WHERE account_id = ?").get(account.id) as unknown as { token_hash: string };
    expect(row.token_hash).toBe(hashToken(account.token));
    expect(row.token_hash).not.toContain(account.token);
    expect(store.authenticate(account.token).id).toBe(account.id);
    expect(account.token.startsWith("ons_")).toBe(true);
  });

  it("吊销 / 过期 / 乱写的令牌都是 unauthorized", async () => {
    const { store } = makeStore();
    const account = seedAccount(store);
    expect(await rejection(() => store.authenticate("ons_not-a-real-token"))).toBe("unauthorized");

    const { token, session } = store.createSession({ accountId: account.id, kind: "panel", now: 1_000 });
    expect(session.expires_at).toBe(1_000 + PANEL_SESSION_TTL_MS);
    expect(await rejection(() => store.authenticateSession(token, 1_000 + PANEL_SESSION_TTL_MS + 1))).toBe("unauthorized");

    const { session: device } = store.authenticateSession(account.token);
    store.revokeSession(device.id);
    expect(await rejection(() => store.authenticate(account.token))).toBe("unauthorized");
  });

  it("停用账号：令牌还在但每次都回 disabled；重新启用立刻恢复", async () => {
    const { store } = makeStore();
    const account = seedAccount(store);
    store.setStatus(account.id, "disabled");
    expect(await rejection(() => store.authenticate(account.token))).toBe("disabled");
    store.setStatus(account.id, "active");
    expect(store.authenticate(account.token).id).toBe(account.id);
  });

  it("移除设备只吊销那台设备的会话", () => {
    const { store } = makeStore();
    const account = seedAccount(store);
    const other = store.createSession({ accountId: account.id, kind: "device", deviceId: "b".repeat(32) });
    expect(store.revokeDeviceSessions(account.id, "b".repeat(32))).toBe(1);
    expect(() => store.authenticate(other.token)).toThrow(AccountError);
    expect(store.authenticate(account.token).id).toBe(account.id);
    expect(store.activeDeviceIds(account.id)).toEqual(new Set([account.deviceId]));
  });

  it("改密码：当前这台保留，其它设备全部下线；当前密码错就不改", async () => {
    const { store } = makeStore();
    const row = await store.create({ email: "a@example.com", password: "old-password-1" });
    const here = store.createSession({ accountId: row.id, kind: "device", deviceId: "a".repeat(32) });
    const there = store.createSession({ accountId: row.id, kind: "device", deviceId: "b".repeat(32) });

    expect(await rejection(store.changePassword(row.id, "wrong-password", "new-password-1"))).toBe("bad-credentials");
    await store.changePassword(row.id, "old-password-1", "new-password-1", { keepSessionId: here.session.id });

    expect(store.authenticate(here.token).id).toBe(row.id);
    expect(() => store.authenticate(there.token)).toThrow(AccountError);
    expect((await store.login("a@example.com", "new-password-1")).id).toBe(row.id);
  });
});

describe("邀请", () => {
  it("明文码只出现一次，库里存哈希；接受后建号并带上邀请里的角色与配额", async () => {
    const { db, store } = makeStore();
    const created = store.createInvite({ createdBy: null, grantAdmin: true, quotaBytes: 5_000, expiresInSeconds: 3600 });
    expect(created.code).toMatch(/^join_[0-9a-f]{48}$/);
    const stored = db.prepare("SELECT code_hash FROM invites").get() as unknown as { code_hash: string };
    expect(stored.code_hash).toBe(hashToken(created.code));

    expect(store.inviteInfo(created.code)).toMatchObject({ email: null, grantAdmin: true, quotaBytes: 5_000 });
    const row = await store.acceptInvite(created.code, { email: "new@example.com", password: "long-enough-pw", displayName: "  Chen " });
    expect(row).toMatchObject({ email: "new@example.com", display_name: "Chen", is_admin: 1, quota_bytes: 5_000 });
    expect(await rejection(() => store.inviteInfo(created.code))).toBe("invite-exhausted");
  });

  it("绑定了邮箱的邀请：只能用那个邮箱，且只能用一次", async () => {
    const { store } = makeStore();
    const created = store.createInvite({ createdBy: null, email: "Chen@Example.com", maxUses: 5 });
    expect(created.maxUses).toBe(1);
    expect(await rejection(store.acceptInvite(created.code, { email: "someone@example.com", password: "long-enough-pw" }))).toBe("invite-email-mismatch");
    await store.acceptInvite(created.code, { email: "chen@example.com", password: "long-enough-pw" });
  });

  it("过期 / 作废 / 不存在的邀请各有各的说法", async () => {
    const { store } = makeStore();
    const expired = store.createInvite({ createdBy: null, expiresInSeconds: 1, now: 0 });
    expect(await rejection(() => store.inviteInfo(expired.code, 5_000))).toBe("invite-expired");
    const revoked = store.createInvite({ createdBy: null });
    store.revokeInvite(revoked.code);
    expect(await rejection(() => store.inviteInfo(revoked.code))).toBe("invite-revoked");
    expect(await rejection(() => store.inviteInfo("join_nope"))).toBe("bad-invite");
  });

  it("接受邀请时密码太短：不建号，邀请也没被用掉", async () => {
    const { store } = makeStore();
    const created = store.createInvite({ createdBy: null });
    expect(await rejection(store.acceptInvite(created.code, { email: "a@example.com", password: "short" }))).toBe("weak-password");
    expect(store.count()).toBe(0);
    expect(store.inviteInfo(created.code).email).toBeNull();
  });
});

describe("重置密码", () => {
  it("链接一次性；重置后旧密码失效、所有会话下线", async () => {
    const { store } = makeStore();
    const row = await store.create({ email: "a@example.com", password: "old-password-1" });
    const session = store.createSession({ accountId: row.id, kind: "device", deviceId: "a".repeat(32) });
    const { code } = store.createPasswordReset({ accountId: row.id, createdBy: null });
    expect(code).toMatch(/^reset_/);
    expect(store.passwordResetInfo(code).email).toBe("a@example.com");

    await store.resetPassword(code, "brand-new-password");
    expect(() => store.authenticate(session.token)).toThrow(AccountError);
    expect(await rejection(store.login("a@example.com", "old-password-1"))).toBe("bad-credentials");
    expect((await store.login("a@example.com", "brand-new-password")).id).toBe(row.id);
    expect(await rejection(store.resetPassword(code, "another-password"))).toBe("reset-used");
  });

  it("过期的链接不能用", async () => {
    const { store } = makeStore();
    const row = await store.create({ email: "a@example.com" });
    const { code } = store.createPasswordReset({ accountId: row.id, createdBy: null, ttlMs: 10, now: 0 });
    expect(await rejection(() => store.passwordResetInfo(code, 100))).toBe("reset-expired");
  });
});

describe("管理员位", () => {
  it("不能取消最后一个活跃管理员", async () => {
    const { store } = makeStore();
    const admin = await store.setup({ email: "admin@example.com", password: "long-enough-pw" });
    expect(store.setAdmin(admin.id, false)).toEqual({ ok: false, reason: "last-admin" });
    const other = await store.create({ email: "b@example.com" });
    expect(store.setAdmin(other.id, true)).toEqual({ ok: true, changed: true });
    expect(store.setAdmin(admin.id, false)).toEqual({ ok: true, changed: true });
  });

  it("删账号会连带删掉它的会话（外键级联）", () => {
    const { db, store } = makeStore();
    const account = seedAccount(store);
    expect(store.delete(account.id)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  });
});
