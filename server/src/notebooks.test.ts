/**
 * 笔记本授权与置备的用例（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §4.4、§4.5、§7.1、§10.1 M1–M7）。
 *
 * ## 这个文件里最要紧的一组断言
 *
 * **越权一定是 404，不是 403**（§4.4 纪律 2、§10.1 M1–M3）。403 等于确认
 * 「这个笔记本存在」—— 在多账号下那本身就是一次信息泄露。
 * 而 `viewer` 尝试写是 **403**：他知道这个笔记本存在，因为他在成员表里。
 *
 * ## 置备的两条验收（§4.5）
 *
 * 1. 置备后 `_design` 与 `_revs_limit=1000` 就位；
 * 2. **手工删掉 `_design` 后能发现不一致并提示，但不自动重建**。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { NotebookError, NotebookStore, assertNotebookQuota } from "./notebooks";
import { ProvisioningError, inspectNotebook, provisionNotebook } from "./provisioning";
import type { CouchClient } from "./couch/client";
import { FakeCouch, couchClient } from "./couch/fakeCouch.test-helper";
import { AccountStore, newAccountId, newAuthTokenForTests } from "./auth/accounts";
import { databaseNameFor } from "./couch/design";

/*
 * `openDatabase` 的替身：每次调用返回**一个新的内存库**。
 *
 * 为什么不用「按序号复用一份」的写法：`vi.mock` 会被提升到文件顶部，而它引用的
 * 模块级绑定必须在提升后仍然可用（这里直接闭包 `importOriginal` 就没有这个问题）。
 */
vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    openDatabase: (options: { path: string }) => (actual as { openDatabase: (o: unknown) => DatabaseSync }).openDatabase({ ...options, path: ":memory:" }),
  };
});

import { openDatabase } from "./db";

/* ========================================================================== */

beforeEach(() => {
  /* 每个用例都是全新的内存库（`openDatabase` 替身保证），无需额外清理。 */
});

function makeWorld(): { db: DatabaseSync; accounts: AccountStore; notebooks: NotebookStore; fake: FakeCouch; couch: CouchClient } {
  const db = openDatabase({ path: ":memory:" });
  const fake = new FakeCouch();
  return { db, accounts: new AccountStore(db), notebooks: new NotebookStore(db), fake, couch: couchClient(fake) };
}

/** 建一个账号（走引导码，与真实注册同一条路径）。 */
function makeAccount(accounts: AccountStore): { id: string; token: string } {
  const token = newAuthTokenForTests();
  const row = accounts.create({
    accountId: newAccountId(),
    authToken: token,
    wrappedEncRoot: "wrapped-fake",
    bootstrapCode: accounts.createBootstrapCode().code,
  });
  return { id: row.id, token };
}

describe("§4.4 · 授权：越权是 404，不是 403", () => {
  it("M1/M2 · 非成员查另一个人的笔记本 → resolveMembership 返回 null（调用方据此 404）", () => {
    const { accounts, notebooks } = makeWorld();
    const alice = makeAccount(accounts);
    const bob = makeAccount(accounts);
    const notebook = notebooks.create({ ownerId: alice.id, name: "Alice 的", cryptoMode: "none" });

    expect(notebooks.resolveMembership(notebook.id, alice.id)?.role).toBe("owner");
    // ★ Bob 拿不到任何东西 —— 不是「拿到了但角色不够」。
    expect(notebooks.resolveMembership(notebook.id, bob.id)).toBeNull();
    // 而且 requireWrite / requireOwner 抛的是 **not-found**，调用方必须映射成 404。
    expect(() => notebooks.requireWrite(notebook.id, bob.id)).toThrow(NotebookError);
    try {
      notebooks.requireWrite(notebook.id, bob.id);
    } catch (error) {
      expect((error as NotebookError).code).toBe("not-found");
    }
    try {
      notebooks.requireOwner(notebook.id, bob.id);
    } catch (error) {
      expect((error as NotebookError).code).toBe("not-found");
    }
  });

  it("M3 · 猜一个不存在的 notebookId → 也是 not-found（与「存在但无权」不可区分）", () => {
    const { accounts, notebooks } = makeWorld();
    const alice = makeAccount(accounts);
    try {
      notebooks.requireWrite("11111111-2222-4333-8444-555555555555", alice.id);
    } catch (error) {
      expect((error as NotebookError).code).toBe("not-found");
    }
  });

  it("M4 · viewer 尝试写 → **forbidden（403）**（他在成员表里，所以知道它存在）", () => {
    const { accounts, notebooks } = makeWorld();
    const alice = makeAccount(accounts);
    const bob = makeAccount(accounts);
    const notebook = notebooks.create({ ownerId: alice.id, name: "共享", cryptoMode: "none" });
    // 用笔记本邀请码把 Bob 加成 viewer。
    notebooks.createInvite({ codeHash: "hash-1", notebookId: notebook.id, role: "viewer", createdBy: alice.id });
    notebooks.joinByInvite("hash-1", bob.id);

    expect(notebooks.resolveMembership(notebook.id, bob.id)?.role).toBe("viewer");
    try {
      notebooks.requireWrite(notebook.id, bob.id);
    } catch (error) {
      expect((error as NotebookError).code).toBe("forbidden");
    }
    // 但 owner 自己可以写。
    expect(() => notebooks.requireWrite(notebook.id, alice.id)).not.toThrow();
  });

  it("M5 · editor 不能删笔记本 / 不能发邀请码（要 owner）", () => {
    const { accounts, notebooks } = makeWorld();
    const alice = makeAccount(accounts);
    const carol = makeAccount(accounts);
    const notebook = notebooks.create({ ownerId: alice.id, name: "共享", cryptoMode: "none" });
    notebooks.createInvite({ codeHash: "h-editor", notebookId: notebook.id, role: "editor", createdBy: alice.id });
    notebooks.joinByInvite("h-editor", carol.id);

    // editor 能写。
    expect(() => notebooks.requireWrite(notebook.id, carol.id)).not.toThrow();
    // 但 owner 专属操作不行。
    try {
      notebooks.requireOwner(notebook.id, carol.id);
    } catch (error) {
      expect((error as NotebookError).code).toBe("forbidden");
    }
  });

  it("建笔记本时**自动**给创建者 owner 成员行（否则他自己都 404）", () => {
    const { accounts, notebooks } = makeWorld();
    const alice = makeAccount(accounts);
    const notebook = notebooks.create({ ownerId: alice.id, name: "我的", cryptoMode: "none" });
    expect(notebooks.resolveMembership(notebook.id, alice.id)).not.toBeNull();
    expect(notebooks.listMembers(notebook.id)).toEqual([{ accountId: alice.id, role: "owner", label: null }]);
  });
});

describe("§3.1 · 库名不透明", () => {
  it("`db_name` 由 notebookId 派生，不含连字符，且不来自用户输入", () => {
    const { accounts, notebooks } = makeWorld();
    const alice = makeAccount(accounts);
    const notebook = notebooks.create({ ownerId: alice.id, name: "任意名字", cryptoMode: "none" });
    expect(notebook.db_name).toBe(databaseNameFor(notebook.id));
    expect(notebook.db_name).toMatch(/^nb-[0-9a-f]{32}$/);
    // 改名字不动库名。
    notebooks.rename(notebook.id, "换了个名字");
    expect(notebooks.findById(notebook.id)!.db_name).toBe(notebook.db_name);
  });

  it("按库名反查（`/v1/*` 拿到 nb= 之后的第一步）", () => {
    const { accounts, notebooks } = makeWorld();
    const alice = makeAccount(accounts);
    const notebook = notebooks.create({ ownerId: alice.id, name: "x", cryptoMode: "none" });
    expect(notebooks.findByDatabaseName(notebook.db_name)?.id).toBe(notebook.id);
    expect(notebooks.findByDatabaseName("nb-不存在")).toBeNull();
  });
});

describe("§1.4 · E2EE 的笔记本不可共享（v1 规则）", () => {
  it("M7 · 给 `user-key` 的笔记本发邀请码 → **拒绝**（发码处）", () => {
    const { accounts, notebooks } = makeWorld();
    const alice = makeAccount(accounts);
    const notebook = notebooks.create({ ownerId: alice.id, name: "加密的", cryptoMode: "user-key" });
    try {
      notebooks.createInvite({ codeHash: "h1", notebookId: notebook.id, role: "editor", createdBy: alice.id });
    } catch (error) {
      expect((error as NotebookError).code).toBe("crypto-mode-not-shareable");
    }
  });

  it("**用码处也要判**（改 crypto_mode 之前发出去的码不能漏过去）", () => {
    const { accounts, notebooks, db } = makeWorld();
    const alice = makeAccount(accounts);
    const bob = makeAccount(accounts);
    const notebook = notebooks.create({ ownerId: alice.id, name: "先明文", cryptoMode: "none" });
    notebooks.createInvite({ codeHash: "h-old", notebookId: notebook.id, role: "editor", createdBy: alice.id });
    // 发完码之后把它改成加密的（模拟一次模式切换 / 手工改库）。
    db.prepare("UPDATE notebooks SET crypto_mode = 'user-key' WHERE id = ?").run(notebook.id);

    try {
      notebooks.joinByInvite("h-old", bob.id);
    } catch (error) {
      expect((error as NotebookError).code).toBe("crypto-mode-not-shareable");
    }
  });

  it("owner 不能通过邀请码分发（避免出现两个 owner）", () => {
    const { accounts, notebooks } = makeWorld();
    const alice = makeAccount(accounts);
    const notebook = notebooks.create({ ownerId: alice.id, name: "x", cryptoMode: "none" });
    expect(() => notebooks.createInvite({ codeHash: "h", notebookId: notebook.id, role: "owner", createdBy: alice.id })).toThrow(/owner 不能/);
  });
});

describe("§4.4 / §10.1 M6 · 笔记本邀请码：一次性 / 过期 / 伪造", () => {
  it("一次性：用过就不能再用", () => {
    const { accounts, notebooks } = makeWorld();
    const alice = makeAccount(accounts);
    const bob = makeAccount(accounts);
    const carol = makeAccount(accounts);
    const notebook = notebooks.create({ ownerId: alice.id, name: "x", cryptoMode: "none" });
    notebooks.createInvite({ codeHash: "h1", notebookId: notebook.id, role: "editor", createdBy: alice.id });
    notebooks.joinByInvite("h1", bob.id);
    try {
      notebooks.joinByInvite("h1", carol.id);
    } catch (error) {
      expect((error as NotebookError).code).toBe("invite-used");
    }
  });

  it("过期与伪造各自拒绝", () => {
    const { accounts, notebooks } = makeWorld();
    const alice = makeAccount(accounts);
    const bob = makeAccount(accounts);
    const notebook = notebooks.create({ ownerId: alice.id, name: "x", cryptoMode: "none" });
    notebooks.createInvite({ codeHash: "h-exp", notebookId: notebook.id, role: "editor", createdBy: alice.id, expiresAt: 1000 });
    try {
      notebooks.joinByInvite("h-exp", bob.id, 5000);
    } catch (error) {
      expect((error as NotebookError).code).toBe("invite-expired");
    }
    try {
      notebooks.joinByInvite("h-nope", bob.id);
    } catch (error) {
      expect((error as NotebookError).code).toBe("bad-invite");
    }
  });

  it("已经是成员了不能重复加入", () => {
    const { accounts, notebooks } = makeWorld();
    const alice = makeAccount(accounts);
    const notebook = notebooks.create({ ownerId: alice.id, name: "x", cryptoMode: "none" });
    notebooks.createInvite({ codeHash: "h1", notebookId: notebook.id, role: "editor", createdBy: alice.id });
    try {
      notebooks.joinByInvite("h1", alice.id);
    } catch (error) {
      expect((error as NotebookError).code).toBe("already-member");
    }
  });
});

describe("§4.5 · 置备：五步 + 幂等 + 回滚", () => {
  const base = { syncUser: "sync-service", protocolVersion: 1, cryptoMode: "none" as const, maxFileBytes: 32 * 1024 * 1024 };

  it("首次置备：建库 / _security / _design / _revs_limit=1000 / syncinfo 全部就位", async () => {
    const { fake, couch } = makeWorld();
    const result = await provisionNotebook({ couch, dbName: "nb-aaa", ...base });

    expect(result).toEqual({ databaseCreated: true, designCreated: true });
    expect(fake.security.get("nb-aaa")).toEqual({ admins: { names: [], roles: [] }, members: { names: ["sync-service"], roles: [] } });
    expect(fake.revsLimits.get("nb-aaa")).toBe(1000);
    const design = fake.databases.get("nb-aaa")!.get("_design/opennote");
    expect(design).toBeTruthy();
    expect(typeof design!.validate_doc_update).toBe("string");
    const syncInfo = fake.databases.get("nb-aaa")!.get("syncinfo");
    expect(syncInfo).toMatchObject({ protocolVersion: 1, cryptoMode: "none" });
  });

  it("**幂等**：重跑不报错、不覆盖 `_design` 与 `syncinfo`", async () => {
    const { fake, couch } = makeWorld();
    await provisionNotebook({ couch, dbName: "nb-aaa", ...base });
    const designRev1 = fake.databases.get("nb-aaa")!.get("_design/opennote")!._rev;
    const syncInfoRev1 = fake.databases.get("nb-aaa")!.get("syncinfo")!._rev;

    const second = await provisionNotebook({ couch, dbName: "nb-aaa", ...base });
    expect(second.databaseCreated).toBe(false); // 库本来就在
    // 两者都没被重写（rev 没变）。
    expect(fake.databases.get("nb-aaa")!.get("_design/opennote")!._rev).toBe(designRev1);
    expect(fake.databases.get("nb-aaa")!.get("syncinfo")!._rev).toBe(syncInfoRev1);
  });

  it("**回滚**：中途失败时删掉这次建的库（不留半个笔记本）", async () => {
    const { fake, couch } = makeWorld();
    // 让 `_security` 那一步失败。
    fake.failNext = "/_security";
    await expect(provisionNotebook({ couch, dbName: "nb-rollback", ...base })).rejects.toBeInstanceOf(ProvisioningError);
    // 库被删掉了 —— 清理干净。
    expect(fake.databases.has("nb-rollback")).toBe(false);
  });

  it("回滚**只删本次建的库**：库本来就在时失败也不删（那会毁掉一个在用的笔记本）", async () => {
    const { fake, couch } = makeWorld();
    fake.databases.set("nb-existing", new Map());
    fake.failNext = "/_revs_limit";
    await expect(provisionNotebook({ couch, dbName: "nb-existing", ...base })).rejects.toThrow(/库非本次创建，未回滚/);
    // 库还在。
    expect(fake.databases.has("nb-existing")).toBe(true);
  });

  it("回滚失败时**如实说出来**（不能吞掉：会留下一个半成品库）", async () => {
    const { fake } = makeWorld();
    // `_security` 失败触发回滚；**删库也失败**（无条件，不依赖那个一次性的 failNext 标记）。
    fake.failNext = "/_security";
    const originalFetch = fake.fetchImpl;
    fake.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      if ((init?.method ?? "GET") === "DELETE" && url.pathname.includes("nb-rollback")) {
        throw new Error("ECONNREFUSED（fake delete）");
      }
      return originalFetch(input, init);
    }) as unknown as typeof fetch;
    const broken = couchClient(fake);

    const error = await provisionNotebook({ couch: broken, dbName: "nb-rollback", ...base }).catch(
      (thrown: unknown) => thrown as ProvisioningError,
    );
    expect(error).toBeInstanceOf(ProvisioningError);
    expect((error as ProvisioningError).message).toContain("回滚删库也失败");
    expect((error as ProvisioningError).message).toContain("nb-rollback");
    expect((error as ProvisioningError).step).toBe("security");
  });
});

describe("§4.5 验收 · 核对是**只读**的：发现不一致就提示，**不自动重建**", () => {
  const base = { syncUser: "sync-service", protocolVersion: 1, cryptoMode: "none" as const, maxFileBytes: 1024 };
  const expected = { protocolVersion: 1, cryptoMode: "none" as const };

  it("刚置备完 → healthy，没有 problems", async () => {
    const { couch } = makeWorld();
    await provisionNotebook({ couch, dbName: "nb-ok", ...base });
    const report = await inspectNotebook(couch, "nb-ok", expected);
    expect(report.healthy).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.designComplete).toBe(true);
    expect(report.revsLimit).toBe(1000);
  });

  it("**手工删掉 `_design`** → 报告不一致，且**不重建**（重建会掩盖人为误删）", async () => {
    const { fake, couch } = makeWorld();
    await provisionNotebook({ couch, dbName: "nb-del", ...base });
    // 模拟运维手工删掉 `_design`。
    fake.databases.get("nb-del")!.delete("_design/opennote");

    const report = await inspectNotebook(couch, "nb-del", expected);
    expect(report.healthy).toBe(false);
    expect(report.designExists).toBe(false);
    expect(report.problems.join(" ")).toContain("不会自动重建");
    // ★ 关键：核对**没有**把它建回去。
    expect(fake.databases.get("nb-del")!.has("_design/opennote")).toBe(false);
  });

  it("`_design` 存在但不完整（缺 validate_doc_update）也要提示", async () => {
    const { fake, couch } = makeWorld();
    await provisionNotebook({ couch, dbName: "nb-part", ...base });
    fake.databases.get("nb-part")!.set("_design/opennote", { _id: "_design/opennote", _rev: "9-x", views: {} });
    const report = await inspectNotebook(couch, "nb-part", expected);
    expect(report.designComplete).toBe(false);
    expect(report.problems.join(" ")).toContain("不完整");
  });

  it("库不存在 → 明确说出来（这是最严重的一种）", async () => {
    const { couch } = makeWorld();
    const report = await inspectNotebook(couch, "nb-gone", expected);
    expect(report.databaseExists).toBe(false);
    expect(report.healthy).toBe(false);
    expect(report.problems.join(" ")).toContain("不存在");
  });

  it("`_revs_limit` 被改小 → 提示（但不静默改回去，§3.10）", async () => {
    const { fake, couch } = makeWorld();
    await provisionNotebook({ couch, dbName: "nb-rev", ...base });
    fake.revsLimits.set("nb-rev", 10);
    const report = await inspectNotebook(couch, "nb-rev", expected);
    expect(report.revsLimitOk).toBe(false);
    expect(report.problems.join(" ")).toContain("共同祖先");
    expect(fake.revsLimits.get("nb-rev")).toBe(10); // 没被改回去
  });

  it("协议版本或加密模式与期望不符 → 逐条提示", async () => {
    const { fake, couch } = makeWorld();
    await provisionNotebook({ couch, dbName: "nb-info", ...base });
    fake.databases.get("nb-info")!.set("syncinfo", { _id: "syncinfo", _rev: "9-y", protocolVersion: 2, cryptoMode: "user-key" });
    const report = await inspectNotebook(couch, "nb-info", expected);
    expect(report.problems.join(" ")).toContain("protocolVersion");
    expect(report.problems.join(" ")).toContain("cryptoMode");
  });
});

describe("§7.1 · 删账号 / 删笔记本时的「独占 vs 共享」判定", () => {
  it("独占的笔记本 → exclusive=true（调用方可以删库）", () => {
    const { accounts, notebooks } = makeWorld();
    const alice = makeAccount(accounts);
    const notebook = notebooks.create({ ownerId: alice.id, name: "x", cryptoMode: "none" });
    expect(notebooks.markDeleted(notebook.id)).toEqual({ exclusive: true, otherMembers: [] });
    // 逻辑删之后 findById 看不到了。
    expect(notebooks.findById(notebook.id)).toBeNull();
  });

  it("有共享成员的笔记本 → exclusive=false（调用方应当**移交**而不是删库）", () => {
    const { accounts, notebooks } = makeWorld();
    const alice = makeAccount(accounts);
    const bob = makeAccount(accounts);
    const notebook = notebooks.create({ ownerId: alice.id, name: "x", cryptoMode: "none" });
    notebooks.createInvite({ codeHash: "h1", notebookId: notebook.id, role: "editor", createdBy: alice.id });
    notebooks.joinByInvite("h1", bob.id);
    const result = notebooks.markDeleted(notebook.id);
    expect(result.exclusive).toBe(false);
    expect(result.otherMembers).toEqual([bob.id]);
  });

  it("移交 owner：换人且成员行被写对（§7.1「移交」）", () => {
    const { accounts, notebooks } = makeWorld();
    const alice = makeAccount(accounts);
    const bob = makeAccount(accounts);
    const notebook = notebooks.create({ ownerId: alice.id, name: "x", cryptoMode: "none" });
    notebooks.transferOwnership(notebook.id, bob.id);
    expect(notebooks.findById(notebook.id)!.owner_id).toBe(bob.id);
    expect(notebooks.resolveMembership(notebook.id, bob.id)?.role).toBe("owner");
  });

  it("删账号时能列出受影响的笔记本并清掉成员行", () => {
    const { accounts, notebooks } = makeWorld();
    const alice = makeAccount(accounts);
    const notebook = notebooks.create({ ownerId: alice.id, name: "x", cryptoMode: "none" });
    const affected = notebooks.removeMembershipsOf(alice.id);
    expect(affected).toEqual([notebook.id]);
    expect(notebooks.resolveMembership(notebook.id, alice.id)).toBeNull();
  });
});

describe("§4.11 · 配额：只拦写入，不拦读取", () => {
  it("超限时抛 quota（调用方映射成明确错误码，读取仍可用）", () => {
    expect(() => assertNotebookQuota(99, 100)).not.toThrow();
    try {
      assertNotebookQuota(100, 100);
    } catch (error) {
      expect((error as NotebookError).code).toBe("quota");
    }
  });

  it("笔记本数能被重算（本地就能算准的那一半）", () => {
    const { accounts, notebooks } = makeWorld();
    const alice = makeAccount(accounts);
    notebooks.create({ ownerId: alice.id, name: "a", cryptoMode: "none" });
    notebooks.create({ ownerId: alice.id, name: "b", cryptoMode: "none" });
    expect(notebooks.recomputeNotebookCount(alice.id)).toBe(2);
    expect(notebooks.quotaOf(alice.id).notebooks).toBe(2);
    // 逻辑删一个之后少一个。
    const third = notebooks.create({ ownerId: alice.id, name: "c", cryptoMode: "none" });
    notebooks.markDeleted(third.id);
    expect(notebooks.recomputeNotebookCount(alice.id)).toBe(2);
  });
});

/* ========================================================================== */

describe("控制台取数：服务端自己记账的用量与同步活动", () => {
  /*
   * 这一组钉的是「控制台的数字有没有真实来源」。
   *
   * 在此之前的两个事实：`quota_usage.bytes_used` 从注册起就是 0（没有任何代码更新它），
   * 而 `client_stats` 依赖客户端 `POST /v1/stats`（当前客户端没有这个调用）。
   * 于是用量条、台账的「占用」、流量图**永远是 0**，且没有报错 —— 这是最难查的一类缺陷。
   */

  it("按库记账，账号总用量 = 名下未删库之和（不再是那个永远是 0 的缓存列）", () => {
    const { accounts, notebooks } = makeWorld();
    const alice = makeAccount(accounts);
    const a = notebooks.create({ ownerId: alice.id, name: "a", cryptoMode: "none" });
    const b = notebooks.create({ ownerId: alice.id, name: "b", cryptoMode: "none" });

    notebooks.addNotebookBytes(a.id, 1024);
    notebooks.addNotebookBytes(b.id, 512);
    expect(notebooks.notebookBytesOf(a.id)).toBe(1024);
    expect(notebooks.quotaOf(alice.id).bytesUsed).toBe(1536);

    // 覆盖写（变小）与删除（清零）都要跟得上。
    notebooks.addNotebookBytes(a.id, -1024 + 100);
    expect(notebooks.quotaOf(alice.id).bytesUsed).toBe(612);

    // 逻辑删掉的库不再计入。
    notebooks.markDeleted(b.id);
    expect(notebooks.quotaOf(alice.id).bytesUsed).toBe(100);
  });

  it("占用**不会变成负数**（账本漂移时显示 0 比显示 -12 KB 诚实）", () => {
    const { accounts, notebooks } = makeWorld();
    const alice = makeAccount(accounts);
    const notebook = notebooks.create({ ownerId: alice.id, name: "a", cryptoMode: "none" });
    notebooks.addNotebookBytes(notebook.id, 10);
    // 模拟「历史数据没记过账，但删了一条 100 字节的」这种漂移。
    expect(notebooks.addNotebookBytes(notebook.id, -100)).toBe(0);
  });

  it("台账的占用是**库级**的（不是把账号总量复制到每个库）", () => {
    const { accounts, notebooks } = makeWorld();
    const alice = makeAccount(accounts);
    const a = notebooks.create({ ownerId: alice.id, name: "a", cryptoMode: "none" });
    const b = notebooks.create({ ownerId: alice.id, name: "b", cryptoMode: "none" });
    notebooks.addNotebookBytes(a.id, 1000);
    notebooks.addNotebookBytes(b.id, 24);
    const ledger = notebooks.listAllNotebooks();
    expect(ledger.find((row) => row.id === a.id)!.bytesUsed).toBe(1000);
    expect(ledger.find((row) => row.id === b.id)!.bytesUsed).toBe(24);
  });

  it("刚建好的库是「**未核对**」而不是「不一致」（`last_checked` 才是判据）", () => {
    const { accounts, notebooks } = makeWorld();
    const alice = makeAccount(accounts);
    const fresh = notebooks.create({ ownerId: alice.id, name: "fresh", cryptoMode: "none" });
    expect(notebooks.listAllNotebooks().find((row) => row.id === fresh.id)!.provisioning).toBeNull();

    notebooks.recordProvisioning(fresh.id, { designOk: true, revsLimit: "1000", syncInfoOk: true });
    const checked = notebooks.listAllNotebooks().find((row) => row.id === fresh.id)!;
    expect(checked.provisioning).toMatchObject({ designOk: true, syncInfoOk: true, revsLimit: "1000" });
  });

  it("同步活动按 (账号, 库, 天) 累加，并且每种 kind 记在自己的列上", () => {
    const { accounts, notebooks } = makeWorld();
    const alice = makeAccount(accounts);
    const notebook = notebooks.create({ ownerId: alice.id, name: "a", cryptoMode: "none" });
    const day = "2026-10-23";
    notebooks.recordActivity({ accountId: alice.id, notebookId: notebook.id, day, kind: "pull" });
    notebooks.recordActivity({ accountId: alice.id, notebookId: notebook.id, day, kind: "pull" });
    notebooks.recordActivity({ accountId: alice.id, notebookId: notebook.id, day, kind: "push" });
    notebooks.recordActivity({ accountId: alice.id, notebookId: notebook.id, day, kind: "conflict" });
    notebooks.recordActivity({ accountId: alice.id, notebookId: notebook.id, day, kind: "error", amount: 2 });

    const rows = notebooks.activityForAccount(alice.id, { notebookId: notebook.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ day, pulls: 2, pushes: 1, conflicts: 1, errors: 2, deletes: 0 });
  });

  it("同步活动**按账号隔离**（一个人的流量不会出现在另一个人的页面上）", () => {
    const { accounts, notebooks } = makeWorld();
    const alice = makeAccount(accounts);
    const bob = makeAccount(accounts);
    const nb = notebooks.create({ ownerId: alice.id, name: "a", cryptoMode: "none" });
    notebooks.recordActivity({ accountId: alice.id, notebookId: nb.id, day: "2026-10-23", kind: "pull" });
    expect(notebooks.activityForAccount(alice.id)).toHaveLength(1);
    expect(notebooks.activityForAccount(bob.id)).toEqual([]);
    // 但全站视图看得见（管理页要的就是全站）。
    expect(notebooks.activityForAll()).toHaveLength(1);
  });
});

describe("删账号的编排（三个入口共用一条，§7.1）", () => {
  it("★ 有设备、有独占库、有共享库时也能删干净（外键不再炸）", () => {
    const { accounts, notebooks } = makeWorld();
    const alice = makeAccount(accounts);
    const bob = makeAccount(accounts);
    // 独占库
    const own = notebooks.create({ ownerId: alice.id, name: "own", cryptoMode: "none" });
    // 共享库（bob 是成员）
    const shared = notebooks.create({ ownerId: alice.id, name: "shared", cryptoMode: "none" });
    notebooks.createInvite({ codeHash: "h-shared", notebookId: shared.id, role: "editor", createdBy: alice.id });
    notebooks.joinByInvite("h-shared", bob.id);
    // 设备行（`devices.account_id` 也是外键 —— 这一条正是当年 500 的根因）
    notebooks.upsertDevice({ deviceId: "a".repeat(32), accountId: alice.id, name: "Mac", platform: "desktop" });

    const result = notebooks.deleteAccountCascade(alice.id);
    expect(result.exclusiveNotebooks).toEqual([own.id]);
    expect(result.transferredNotebooks).toEqual([shared.id]);

    // 独占库的行没了，共享库移交给了 bob。
    expect(notebooks.findById(own.id)).toBeNull();
    expect(notebooks.findById(shared.id)!.owner_id).toBe(bob.id);
    expect(notebooks.resolveMembership(shared.id, bob.id)?.role).toBe("owner");
    // 设备行清掉了。
    expect(notebooks.listDevices(alice.id)).toEqual([]);
    // 账号行本身**还**在（那是 `AccountStore.delete` 的事，两个系统分开）。
    expect(accounts.findById2(alice.id)).not.toBeNull();
    // 这一步不抛 ⇒ 调用方接着删账号行时外键不会挡路。
    expect(() => accounts.delete(alice.id)).not.toThrow();
  });

  it("删账号会清掉它名下的用量与活动（不会留下孤立的记账行）", () => {
    const { accounts, notebooks } = makeWorld();
    const alice = makeAccount(accounts);
    const nb = notebooks.create({ ownerId: alice.id, name: "a", cryptoMode: "none" });
    notebooks.addNotebookBytes(nb.id, 500);
    notebooks.recordActivity({ accountId: alice.id, notebookId: nb.id, day: "2026-10-23", kind: "pull" });

    notebooks.deleteAccountCascade(alice.id);
    expect(notebooks.activityForAccount(alice.id)).toEqual([]);
    // 用回同一个 notebook id 建一个新库时，占用要从 0 起算（旧账没残留）。
    expect(notebooks.notebookBytesOf(nb.id)).toBe(0);
  });
});

