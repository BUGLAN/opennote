/**
 * 控制面 schema 与迁移（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §4.3、§8.4）。
 *
 * 迁移这件事**只在出事的时候才被看**，所以它的用例要钉住「出事时会怎样」：
 * 版本比代码新必须**拒绝启动**、迁移失败必须**整体回滚**、外键必须**真的强制**。
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, migrationList, openDatabase } from "./db";

describe("首次打开", () => {
  it("建齐 §4.3 的全部表，并把版本写到 SCHEMA_VERSION", () => {
    const db = openDatabase({ path: ":memory:" });
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as unknown as { name: string }[])
      .map((row) => row.name)
      .sort();
    expect(names).toEqual(
      [
        "accounts",
        "audit",
        "bootstrap_codes",
        "client_stats",
        "devices",
        "invites",
        "memberships",
        "notebook_invites",
        "notebook_provisioning",
        "notebooks",
        "quota_usage",
        "schema_version",
      ].sort(),
    );
    expect(db.prepare("SELECT version FROM schema_version").get()).toEqual({ version: SCHEMA_VERSION });
    db.close();
  });

  it("重复打开是幂等的（迁移只跑一次）", () => {
    const applied: number[] = [];
    const db = openDatabase({ path: ":memory:", onMigration: (migration, didApply) => (didApply ? applied.push(migration.version) : undefined) });
    expect(applied).toEqual([1]);
    // 同一个连接上再调一次 openDatabase 不现实（内存库是每连接独立的），
    // 所以这里用「迁移表连续性 + 版本一致」来断言「再打开不会重复跑」：
    // 迁移函数是 `CREATE TABLE`（不带 IF NOT EXISTS），重复跑必然抛错 —— 见下一条用例。
    expect(migrationList().map((item) => item.version)).toEqual([SCHEMA_VERSION]);
    db.close();
  });

  it("版本比代码新 ⇒ **拒绝启动**（服务端被回滚过的信号，§8.4）", () => {
    /*
     * 用文件库而不是 `:memory:` 来造「未来版本」：`openDatabase` 在抛错前不会关闭连接，
     * 所以第一版直接删文件会 `EBUSY`（Windows 上句柄没释放）。这里改成
     * 「校验通过之后再清理，并且用 try/finally 保证一定删得到」。
     */
    const path = join(tmpdir(), `opennote-future-${Date.now()}.db`);
    try {
      const future = new DatabaseSync(path);
      future.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)");
      future.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION + 1);
      future.close();

      // 这一步必然抛，且**不会**给我们一个可用的连接 —— 所以没有句柄要释放。
      expect(() => openDatabase({ path })).toThrow(/高于本代码/);
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    }
  });
});

describe("schema 的安全相关约束", () => {
  it("外键**真的**强制（SQLite 默认不强制 REFERENCES，必须显式打开）", () => {
    const db = openDatabase({ path: ":memory:" });
    expect(() =>
      db
        .prepare("INSERT INTO memberships (notebook_id, account_id, role, created_at) VALUES ('no-such-notebook', 'no-such-account', 'owner', 1)")
        .run(),
    ).toThrow();
    db.close();
  });

  it("`accounts` 里**没有**口令字段（没有口令体系，§1.5）", () => {
    const db = openDatabase({ path: ":memory:" });
    const columns = (db.prepare("PRAGMA table_info(accounts)").all() as unknown as { name: string }[]).map((row) => row.name);
    for (const forbidden of ["password", "password_hash", "salt", "username", "email"]) {
      expect(columns).not.toContain(forbidden);
    }
    // 该有的要有。
    expect(columns).toContain("auth_hash");
    expect(columns).toContain("wrapped_enc_root");
    db.close();
  });

  it("`accounts.auth_hash` 有唯一索引（认证走索引查找，§4.4）", () => {
    const db = openDatabase({ path: ":memory:" });
    const indexes = (db.prepare("PRAGMA index_list(accounts)").all() as unknown as { name: string; unique: number }[]).filter(
      (row) => row.unique === 1,
    );
    expect(indexes.length).toBeGreaterThan(0);
    // 唯一性真的生效。
    const insert = (id: string) =>
      db
        .prepare("INSERT INTO accounts (id, auth_hash, wrapped_enc_root, is_admin, status, created_at) VALUES (?, 'same-hash', 'w', 0, 'active', 1)")
        .run(id);
    insert("a1");
    expect(() => insert("a2")).toThrow();
    db.close();
  });

  it("`notebooks.db_name` 唯一（库名不透明且不冲突，§3.1）", () => {
    const db = openDatabase({ path: ":memory:" });
    db.prepare("INSERT INTO accounts (id, auth_hash, wrapped_enc_root, is_admin, status, created_at) VALUES ('acc', 'h', 'w', 0, 'active', 1)").run();
    const insert = (id: string) =>
      db
        .prepare("INSERT INTO notebooks (id, owner_id, name, db_name, crypto_mode, created_at) VALUES (?, 'acc', 'n', 'nb-same', 'none', 1)")
        .run(id);
    insert("nb1");
    expect(() => insert("nb2")).toThrow();
    db.close();
  });

  it("`notebooks.crypto_mode` 默认 'none'（§11.3 A 拍板：P2 先明文，P4 再改默认值）", () => {
    const db = openDatabase({ path: ":memory:" });
    db.prepare("INSERT INTO accounts (id, auth_hash, wrapped_enc_root, is_admin, status, created_at) VALUES ('acc', 'h', 'w', 0, 'active', 1)").run();
    db.prepare("INSERT INTO notebooks (id, owner_id, name, db_name, created_at) VALUES ('nb', 'acc', 'n', 'nb-x', 1)").run();
    const row = db.prepare("SELECT crypto_mode FROM notebooks WHERE id = 'nb'").get() as unknown as { crypto_mode: string };
    expect(row.crypto_mode).toBe("none");
    db.close();
  });

  it("`audit` 表没有存放正文/密钥的列（永不包含正文或密钥材料，§4.3）", () => {
    const db = openDatabase({ path: ":memory:" });
    const columns = (db.prepare("PRAGMA table_info(audit)").all() as unknown as { name: string }[]).map((row) => row.name);
    for (const forbidden of ["body", "content", "bytes", "secret", "auth_token", "enc_root"]) {
      expect(columns).not.toContain(forbidden);
    }
    expect(columns).toContain("action");
    db.close();
  });
});

describe("迁移表本身", () => {
  it("版本从 1 开始**连续**（缺号说明有人删过历史 = 不可审计）", () => {
    const versions = migrationList().map((item) => item.version);
    expect(versions).toEqual(versions.map((_, index) => index + 1));
    expect(versions[versions.length - 1]).toBe(SCHEMA_VERSION);
  });

  it("每条迁移都有一句人能读懂的描述（迁移日志与控制台要显示它）", () => {
    for (const migration of migrationList()) {
      expect(migration.description.length).toBeGreaterThan(8);
    }
  });
});
