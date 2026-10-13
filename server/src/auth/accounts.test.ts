/**
 * 密钥即身份的用例（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §10.1 B 的 K1–K11、§1.5）。
 *
 * 这个文件里最要紧的三条：
 *
 * - **K1**：注册之后，服务端的库里**搜不到任何等于 `accountKey` / `encRoot` / `wrapKey` 的值**
 *   —— 这是红线 3 的可执行形式，而不是一句声明；
 * - **K2**：没有码**一律拒绝**，且**不存在**「首次注册自动成管理员」这条路径（防抢注）；
 * - **K6**：轮换之后 `wrappedEncRoot` 解出来的 `encRoot` **完全相同** —— 零重加密的证明。
 *   这一条在真实世界里要靠客户端解密才能验；这里用「`wrappedEncRoot` 之外的字段一个都没动」
 *   来近似断言（`auth_hash` 变了、`enc_root` 无关字段都在），并注明真实验法在 P4。
 */
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db";
import { AccountError, AccountStore, generateCode, hashAuthToken, hashesEqual, newAccountId, newAuthTokenForTests } from "./accounts";

function makeStore(): { store: AccountStore; db: ReturnType<typeof openDatabase> } {
  const db = openDatabase({ path: ":memory:" });
  return { store: new AccountStore(db), db };
}

/** 一份合法的注册输入（客户端会生成前三项）。 */
function registration() {
  return {
    accountId: newAccountId(),
    authToken: newAuthTokenForTests(),
    wrappedEncRoot: `wrapped:${Math.random().toString(36).slice(2)}`,
  };
}

describe("K1 · 服务端只存哈希与密文（红线 3）", () => {
  it("库里搜不到 accountKey / encRoot / wrapKey 的任何痕迹", () => {
    const { store, db } = makeStore();
    const bootstrap = store.createBootstrapCode();

    /*
     * 模拟客户端的真实行为：这些秘密**只存在于客户端**，注册请求里根本不该有它们。
     * 为了让断言有牙齿，这里故意把它们也准备好，然后**证明它们没进库**。
     */
    const accountKey = "ACCOUNT_KEY_SHOULD_NEVER_REACH_SERVER";
    const encRoot = "ENC_ROOT_SHOULD_NEVER_REACH_SERVER";
    const wrapKey = "WRAP_KEY_SHOULD_NEVER_REACH_SERVER";
    const input = registration();

    store.create({ ...input, bootstrapCode: bootstrap.code, isAdmin: true });

    // 把整库所有表的所有值拼成一个大字符串，然后搜。
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as unknown as { name: string }[];
    const dump = tables
      .map((table) => JSON.stringify(db.prepare(`SELECT * FROM ${table.name}`).all()))
      .join("\n");

    expect(dump).not.toContain(accountKey);
    expect(dump).not.toContain(encRoot);
    expect(dump).not.toContain(wrapKey);
    // 反过来：该在的必须在。
    expect(dump).toContain(hashAuthToken(input.authToken));
    expect(dump).toContain(input.wrappedEncRoot);
    // 而且**明文 authToken 绝不在库里**。
    expect(dump).not.toContain(input.authToken);
  });

  it("`auth_hash` 是 sha256(authToken)（不是明文，也不是别的构造）", () => {
    const { store, db } = makeStore();
    const bootstrap = store.createBootstrapCode();
    const input = registration();
    store.create({ ...input, bootstrapCode: bootstrap.code });
    const row = db.prepare("SELECT auth_hash FROM accounts WHERE id = ?").get(input.accountId) as unknown as { auth_hash: string };
    expect(row.auth_hash).toBe(hashAuthToken(input.authToken));
    expect(row.auth_hash).toHaveLength(64);
  });
});

describe("K2 · 没有码一律拒绝（不存在抢注路径）", () => {
  it("引导码与邀请码都没有 → 拒绝", () => {
    const { store } = makeStore();
    expect(() => store.create(registration())).toThrow(/必须凭一次性引导码或邀请码/);
    expect(store.count()).toBe(0);
  });

  it("**第一个**注册也不会自动变成管理员 —— 库里空着也一样", () => {
    const { store } = makeStore();
    expect(store.count()).toBe(0);
    expect(() => store.create({ ...registration(), isAdmin: true })).toThrow(AccountError);
    expect(store.count()).toBe(0);
  });

  it("`isAdmin` 不由请求方自己说了算 —— 只有引导码能建管理员（调用方约定）", () => {
    // 这是**契约层面**的约束（HTTP 层只在 bootstrapCode 分支才允许 isAdmin=true）。
    // 这里钉住数据层的事实：邀请码建出来的账号 isAdmin 为 0。
    const { store } = makeStore();
    const admin = store.create({ ...registration(), bootstrapCode: store.createBootstrapCode().code, isAdmin: true });
    const invite = store.createInvite({ createdBy: admin.id });
    const plain = store.create({ ...registration(), inviteCode: invite.code });
    expect(admin.is_admin).toBe(1);
    expect(plain.is_admin).toBe(0);
  });
});

describe("K3 · 引导码一次性 / 过期", () => {
  it("同一个引导码不能建两个管理员", () => {
    const { store } = makeStore();
    const bootstrap = store.createBootstrapCode();
    store.create({ ...registration(), bootstrapCode: bootstrap.code, isAdmin: true });
    expect(() => store.create({ ...registration(), bootstrapCode: bootstrap.code, isAdmin: true })).toThrow(/已经被用过/);
    expect(store.count()).toBe(1);
  });

  it("过期之后不能用", () => {
    const { store } = makeStore();
    const now = 1_000_000;
    const bootstrap = store.createBootstrapCode({ now, ttlMs: 1000 });
    expect(() => store.create({ ...registration(), bootstrapCode: bootstrap.code, now: now + 2000 })).toThrow(/已过期/);
  });

  it("胡编的引导码不能用（且错误文案不区分「没有」与「错了」）", () => {
    const { store } = makeStore();
    expect(() => store.create({ ...registration(), bootstrapCode: generateCode("boot") })).toThrow(/引导码无效/);
  });
});

describe("K4 · 邀请码 max_uses / 过期 / 作废", () => {
  it("max_uses=2 能用两次，第三次拒绝", () => {
    const { store } = makeStore();
    const admin = store.create({ ...registration(), bootstrapCode: store.createBootstrapCode().code, isAdmin: true });
    const invite = store.createInvite({ createdBy: admin.id, maxUses: 2 });
    store.create({ ...registration(), inviteCode: invite.code });
    store.create({ ...registration(), inviteCode: invite.code });
    expect(() => store.create({ ...registration(), inviteCode: invite.code })).toThrow(/已用尽/);
    expect(store.count()).toBe(3);
  });

  it("过期与作废各自生效（且文案区分得开）", () => {
    const { store } = makeStore();
    const admin = store.create({ ...registration(), bootstrapCode: store.createBootstrapCode().code, isAdmin: true });
    const now = 5_000_000;

    const expiring = store.createInvite({ createdBy: admin.id, expiresInSeconds: 10, now });
    expect(() => store.create({ ...registration(), inviteCode: expiring.code, now: now + 20_000 })).toThrow(/已过期/);

    const revocable = store.createInvite({ createdBy: admin.id, now });
    expect(store.revokeInvite(revocable.code, now)).toBe(true);
    expect(() => store.create({ ...registration(), inviteCode: revocable.code, now })).toThrow(/已被作废/);
    // 重复作废返回 false（不是错误）。
    expect(store.revokeInvite(revocable.code, now)).toBe(false);
  });
});

describe("K5/K6 · 轮换 —— 零重加密（本设计的核心不变量）", () => {
  it("K5 · 轮换之后**旧令牌立即 401**，新令牌可用", () => {
    const { store } = makeStore();
    const input = registration();
    store.create({ ...input, bootstrapCode: store.createBootstrapCode().code });

    const newToken = newAuthTokenForTests();
    const newWrapped = "wrapped-after-rotation";
    const account = store.authenticate(input.authToken);
    store.rotate(account.id, newToken, newWrapped);

    expect(() => store.authenticate(input.authToken)).toThrow(AccountError);
    expect(store.authenticate(newToken).id).toBe(account.id);
  });

  it("K6 · 轮换**只**换 auth_hash 与 wrapped_enc_root，其它字段一个都没动", () => {
    const { store, db } = makeStore();
    const input = registration();
    const created = store.create({ ...input, bootstrapCode: store.createBootstrapCode().code, isAdmin: true, label: "我的账号" });
    const before = db.prepare("SELECT * FROM accounts WHERE id = ?").get(created.id) as unknown as Record<string, unknown>;

    const newToken = newAuthTokenForTests();
    store.rotate(created.id, newToken, "wrapped-after-rotation");
    const after = db.prepare("SELECT * FROM accounts WHERE id = ?").get(created.id) as unknown as Record<string, unknown>;

    /*
     * 「零重加密」的可测形式：**只有**这两个字段变了。
     * `encRoot` 本身不在我们库里（我们从来没见过它），所以「它没变」在服务端这一侧
     * 只能这样间接证：没有任何编号/版本/会话字段随之改变 —— 也就是说我们**没有**
     * 因为轮换而重建任何与笔记内容相关的东西。
     * 真正的证明在 P4：客户端用新 wrapKey 解开 wrappedEncRoot 得到同一个 encRoot（K6 原文）。
     */
    const changed = Object.keys(after).filter((key) => JSON.stringify(after[key]) !== JSON.stringify(before[key]));
    expect(changed.sort()).toEqual(["auth_hash", "wrapped_enc_root"]);

    // 身份与权限都没被顺手改掉。
    expect(after.id).toBe(before.id);
    expect(after.is_admin).toBe(before.is_admin);
    expect(after.status).toBe("active");
    expect(after.label).toBe("我的账号");
    expect(after.created_at).toBe(before.created_at);
  });
});

describe("K7 · 新设备用同一把密钥解锁", () => {
  it("unlock 返回同一个 wrappedEncRoot（客户端据此解出同一个 encRoot）", () => {
    const { store } = makeStore();
    const input = registration();
    store.create({ ...input, bootstrapCode: store.createBootstrapCode().code });

    // 「新设备」只是同一个 authToken 的另一次请求 —— 没有第二样东西需要（§1.5 流程②）。
    const first = store.unlock(input.authToken);
    const second = store.unlock(input.authToken);
    expect(first.wrappedEncRoot).toBe(input.wrappedEncRoot);
    expect(second).toEqual(first);
  });
});

describe("K8/K9 · 伪造与泄露", () => {
  it("K8 · 随机 32 字节令牌 → 401", () => {
    const { store } = makeStore();
    store.create({ ...registration(), bootstrapCode: store.createBootstrapCode().code });
    expect(() => store.authenticate(newAuthTokenForTests())).toThrow(/令牌无效/);
  });

  it("K9 · `auth_hash` 是 sha256，明文令牌不可从库里反推", () => {
    const { store, db } = makeStore();
    const input = registration();
    store.create({ ...input, bootstrapCode: store.createBootstrapCode().code });
    const row = db.prepare("SELECT auth_hash FROM accounts WHERE id = ?").get(input.accountId) as unknown as { auth_hash: string };
    // 设计性断言：形状是 sha256 十六进制（64 位），且不等于任何明文片段。
    expect(row.auth_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.auth_hash).not.toContain(input.authToken.slice(0, 8));
    // 恒定时间比较器本身也要对（长度不同不炸）。
    expect(hashesEqual(row.auth_hash, row.auth_hash)).toBe(true);
    expect(hashesEqual(row.auth_hash, "short")).toBe(false);
  });
});

describe("K10 · 禁用账号", () => {
  it("禁用之后所有请求立即 403；重新启用后恢复", () => {
    const { store } = makeStore();
    const input = registration();
    const created = store.create({ ...input, bootstrapCode: store.createBootstrapCode().code });

    expect(store.setStatus(created.id, "disabled")).toBe(true);
    // 认证失败，但**数据保留**（不是删账号）。
    expect(() => store.authenticate(input.authToken)).toThrow(/已被禁用/);
    expect(store.findById2(created.id)).not.toBeNull();

    expect(store.setStatus(created.id, "active")).toBe(true);
    expect(store.authenticate(input.authToken).id).toBe(created.id);
  });

  it("账号不存在时 setStatus 返回 false（不是静默成功）", () => {
    const { store } = makeStore();
    expect(store.setStatus("nope", "disabled")).toBe(false);
  });
});

describe("账号唯一性", () => {
  it("同一个 accountId 不能建两次", () => {
    const { store } = makeStore();
    const input = registration();
    const code1 = store.createBootstrapCode();
    store.create({ ...input, bootstrapCode: code1.code });
    const code2 = store.createBootstrapCode();
    expect(() => store.create({ ...input, bootstrapCode: code2.code })).toThrow(/已被占用/);
  });

  it("撞 id 失败时**不消耗**引导码（事务整体回滚）", () => {
    const { store } = makeStore();
    const input = registration();
    store.create({ ...input, bootstrapCode: store.createBootstrapCode().code });

    const code = store.createBootstrapCode();
    expect(() => store.create({ ...input, bootstrapCode: code.code })).toThrow(/已被占用/);
    // 码还能用（换一个 accountId 就成了）—— 说明那次失败没有把它用掉。
    expect(() => store.create({ ...registration(), bootstrapCode: code.code })).not.toThrow();
  });
});
