/**
 * SQLite 控制面：schema + **可审计的顺序迁移**（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §4.3）。
 *
 * ## 这里只放控制面数据，**永不放笔记字节**
 *
 * 笔记是 CouchDB 的事（一笔记本一库）。SQLite 只回答「谁是谁、谁能干什么、用了多少」。
 * 这条边界让「换掉 CouchDB」与「换掉账号体系」变成两件互不影响的事。
 *
 * ## 迁移纪律（§4.3、§8.4）
 *
 * - **`schema_version` + 顺序迁移函数**，不用「启动时自动改表」的魔法 ORM；
 * - **只加不删**：多账号下回滚 `sync` 版本可能不兼容新 schema，所以迁移设计成单向可加；
 * - 每条迁移在**一个事务里**跑完，失败就整体回滚（不留半张表）；
 * - 迁移函数是**纯 SQL + 可选的 JS**，没有隐式副作用。
 *
 * ## 三条与安全直接相关的写法
 *
 * 1. **`accounts` 里没有口令字段**（没有口令体系，§1.5）。存的是 `auth_hash = sha256(authToken)`
 *    —— 256 位随机令牌的哈希，**无法离线爆破**（这也正是「不需要 Argon2id」的依据）。
 * 2. **`wrapped_enc_root` 是密文**：`AEAD(wrapKey, encRoot, aad=accountId)`。
 *    服务端**解不开**，因为它没有 `wrapKey`（红线 3）。
 * 3. **审计表永不包含正文或密钥材料**（§4.3 注释里写死了这一条）。
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** 当前 schema 版本。加一条迁移就 +1（**只加不删**）。 */
export const SCHEMA_VERSION = 2;

interface Migration {
  version: number;
  /** 人类可读的一句话（迁移日志与控制台都会显示，便于审计）。 */
  description: string;
  up: (db: DatabaseSync) => void;
}

/**
 * 迁移表。**顺序即版本**：`version` 必须连续递增，`migrate()` 会检查这一点。
 *
 * ⚠️ 已发布的迁移**永不修改**（那是「改历史」），要改就加一条新的。
 */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: "初始 schema：账号/引导码/邀请码/设备/笔记本/成员/配额/统计/审计",
    up: (db) => {
      db.exec(`
        -- 账号：**一条密钥就是一个账号**（无口令、无用户名）。
        CREATE TABLE accounts (
          id                TEXT PRIMARY KEY,       -- accountId（客户端生成的公开随机 id）
          auth_hash         TEXT NOT NULL UNIQUE,   -- sha256(authToken)  ★ 反推不出 authToken
          wrapped_enc_root  TEXT NOT NULL,          -- AEAD(wrapKey, encRoot, aad=accountId)  ★ 服务端解不开
          is_admin          INTEGER NOT NULL DEFAULT 0,
          status            TEXT NOT NULL DEFAULT 'active',   -- active | disabled
          label             TEXT,                   -- 可选备注名（★ 纯装饰，不参与鉴权、不唯一）
          created_at        INTEGER NOT NULL,
          last_seen_at      INTEGER
        );
        CREATE INDEX idx_accounts_hash ON accounts(auth_hash);

        -- 引导码（首次创建管理员用；由 CLI 生成，一次性，只在 stdout 出现一次）
        CREATE TABLE bootstrap_codes (
          code_hash  TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          used_at    INTEGER
        );

        -- 邀请码（注册用；只能由管理员在控制台生成）
        CREATE TABLE invites (
          code_hash  TEXT PRIMARY KEY,
          created_by TEXT NOT NULL REFERENCES accounts(id),
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          max_uses   INTEGER NOT NULL DEFAULT 1,
          uses       INTEGER NOT NULL DEFAULT 0,
          revoked_at INTEGER
        );

        -- 设备登记（★ 不是凭据：一个账号密钥所有设备共用，所以这里只是账本）
        CREATE TABLE devices (
          id           TEXT PRIMARY KEY,            -- 客户端生成的 deviceId（= 同步检查点用的那个）
          account_id   TEXT NOT NULL REFERENCES accounts(id),
          name         TEXT,
          platform     TEXT,                        -- desktop | android | web
          created_at   INTEGER NOT NULL,
          last_seen_at INTEGER,
          last_ip      TEXT
        );
        CREATE INDEX idx_devices_account ON devices(account_id);

        -- 笔记本
        CREATE TABLE notebooks (
          id          TEXT PRIMARY KEY,             -- uuid（对外 notebookId）
          owner_id    TEXT NOT NULL REFERENCES accounts(id),
          name        TEXT NOT NULL,
          db_name     TEXT NOT NULL UNIQUE,         -- 'nb-' + uuid（去连字符）★ 不透明
          crypto_mode TEXT NOT NULL DEFAULT 'none', -- 'none' | 'user-key'
          created_at  INTEGER NOT NULL,
          deleted_at  INTEGER
        );
        CREATE INDEX idx_notebooks_owner ON notebooks(owner_id);

        -- ★ 授权的唯一真源
        CREATE TABLE memberships (
          notebook_id TEXT NOT NULL REFERENCES notebooks(id),
          account_id  TEXT NOT NULL REFERENCES accounts(id),
          role        TEXT NOT NULL,                -- owner | editor | viewer
          created_at  INTEGER NOT NULL,
          PRIMARY KEY (notebook_id, account_id)
        );
        CREATE INDEX idx_memberships_account ON memberships(account_id);

        -- 笔记本邀请码（共享用；不需要知道对方是谁）
        CREATE TABLE notebook_invites (
          code_hash   TEXT PRIMARY KEY,
          notebook_id TEXT NOT NULL REFERENCES notebooks(id),
          role        TEXT NOT NULL,                -- editor | viewer
          created_by  TEXT NOT NULL REFERENCES accounts(id),
          created_at  INTEGER NOT NULL,
          expires_at  INTEGER,
          used_at     INTEGER
        );
        CREATE INDEX idx_notebook_invites_nb ON notebook_invites(notebook_id);

        -- 配额
        CREATE TABLE quota_usage (
          account_id  TEXT PRIMARY KEY REFERENCES accounts(id),
          bytes_used  INTEGER NOT NULL DEFAULT 0,
          notebooks   INTEGER NOT NULL DEFAULT 0,
          updated_at  INTEGER NOT NULL
        );

        -- 客户端上报（供控制台展示；★ 服务端看不到冲突内容，只有计数）
        CREATE TABLE client_stats (
          account_id  TEXT NOT NULL,
          notebook_id TEXT NOT NULL,
          day         TEXT NOT NULL,
          conflicts   INTEGER NOT NULL DEFAULT 0,
          errors      INTEGER NOT NULL DEFAULT 0,
          pushes      INTEGER NOT NULL DEFAULT 0,
          pulls       INTEGER NOT NULL DEFAULT 0,
          deletes     INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (account_id, notebook_id, day)
        );

        -- 审计（★ 永不包含正文或密钥材料）
        CREATE TABLE audit (
          id       INTEGER PRIMARY KEY AUTOINCREMENT,
          at       INTEGER NOT NULL,
          actor_id TEXT,                            -- accountId 或 null
          action   TEXT NOT NULL,                   -- rotate_key / create_invite / revoke_invite / ...
          target   TEXT,
          ip       TEXT,
          detail   TEXT
        );
        CREATE INDEX idx_audit_at ON audit(at);

        -- 每库的置备状态（控制台要能发现「_design 被手工删了」这类不一致，§4.5 验收）
        CREATE TABLE notebook_provisioning (
          notebook_id   TEXT PRIMARY KEY REFERENCES notebooks(id),
          design_ok     INTEGER NOT NULL DEFAULT 0,
          revs_limit    TEXT,
          sync_info_ok  INTEGER NOT NULL DEFAULT 0,
          last_checked  INTEGER
        );
      `);
    },
  },
  {
    version: 2,
    description: "invites.created_by 允许为空（CLI 发码时还没有任何账号）",
    up: (db) => {
      /*
       * ## 为什么必须允许为空
       *
       * 第一版写成 `created_by TEXT NOT NULL REFERENCES accounts(id)`，而 CLI 的
       * `create-invite` 用 `createdBy: "cli"` —— 于是**第一次真跑就炸**
       * `FOREIGN KEY constraint failed`。
       *
       * 根因不是「忘了填一个合法的 id」，而是**约束本身是错的**：CLI 是「根信任」的
       * 运维通道（§4.12），它的典型场景恰恰是**还没有任何可用账号**的时候
       * （`bootstrap-admin` 存在的理由就是「管理员密钥丢了、控制台进不去」）。
       * 所以「谁发的这个码」在这个场景下**没有答案**，约束不该要求它有。
       *
       * 顺带把 `ON DELETE SET NULL` 写上：删账号时不再需要手工清 `invites`
       * （`NotebookStore.deleteRowsOwnedBy` 里那一步仍然保留 —— 显式优于隐式，
       * 但外键也不该留下会炸的悬空引用）。
       *
       * SQLite 改不了列的约束，只能重建表。
       */
      db.exec(`
        ALTER TABLE invites RENAME TO invites_v1;

        CREATE TABLE invites (
          code_hash  TEXT PRIMARY KEY,
          -- NULL = 由 CLI 发出（那时还没有账号）。见本迁移的说明。
          created_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          max_uses   INTEGER NOT NULL DEFAULT 1,
          uses       INTEGER NOT NULL DEFAULT 0,
          revoked_at INTEGER
        );

        INSERT INTO invites (code_hash, created_by, created_at, expires_at, max_uses, uses, revoked_at)
          SELECT code_hash, created_by, created_at, expires_at, max_uses, uses, revoked_at FROM invites_v1;

        DROP TABLE invites_v1;
      `);
    },
  },
];

export interface OpenDatabaseOptions {
  /** 落点；`:memory:` 用于用例。 */
  path: string;
  /** 迁移日志（默认吞掉；测试与启动脚本传一个收集器）。 */
  onMigration?: (migration: Migration, applied: boolean) => void;
}

/**
 * 打开（必要时创建）控制面数据库，并把 schema 迁到 `SCHEMA_VERSION`。
 *
 * **每次打开都会核对版本**：库比代码新（回滚过服务端）时**拒绝启动** ——
 * 带着不认识的 schema 跑比停下来危险得多（§8.4「回滚 `sync` 版本可能不兼容新 schema」）。
 */
export function openDatabase(options: OpenDatabaseOptions): DatabaseSync {
  const inMemory = options.path === ":memory:";
  if (!inMemory) mkdirSync(dirname(options.path), { recursive: true });
  const db = new DatabaseSync(options.path);

  // WAL：读写不互相阻塞（同步请求会并发读配额与成员表）。内存库没有 WAL，跳过。
  if (!inMemory) db.exec("PRAGMA journal_mode = WAL");
  // ★ 外键必须显式打开：SQLite 默认**不**强制 REFERENCES。
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");

  // 迁移表必须**连续**：缺号说明有人删过历史，那是不可审计的。
  for (let index = 0; index < MIGRATIONS.length; index += 1) {
    const expected = index + 1;
    if (MIGRATIONS[index]!.version !== expected) {
      throw new Error(`迁移表不连续：第 ${index + 1} 条是版本 ${MIGRATIONS[index]!.version}，期望 ${expected}`);
    }
  }

  /*
   * 从这里开始可能抛错（版本太高、迁移失败）。**抛之前必须关掉连接** ——
   * 否则调用方拿不到连接、却留下一个占着文件句柄的 `DatabaseSync`：
   * Windows 上后续 `unlink` 会 `EBUSY`，重试启动也会撞上锁（用例当场抓到过一次）。
   */
  try {
    migrate(db, options);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

function migrate(db: DatabaseSync, options: OpenDatabaseOptions): void {
  let current = readSchemaVersion(db);
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `数据库 schema 版本是 ${current}，高于本代码的 ${SCHEMA_VERSION}。` +
        `这通常意味着服务端被回滚过；带着不认识的 schema 运行是危险的，因此拒绝启动。`,
    );
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) {
      options.onMigration?.(migration, false);
      continue;
    }
    db.exec("BEGIN");
    try {
      migration.up(db);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(`迁移 ${migration.version}（${migration.description}）失败，已回滚：${String(error)}`);
    }
    writeSchemaVersion(db, migration.version);
    current = migration.version;
    options.onMigration?.(migration, true);
  }

  const finalVersion = readSchemaVersion(db);
  if (finalVersion !== SCHEMA_VERSION) {
    throw new Error(`迁移结束后 schema 版本是 ${finalVersion}，期望 ${SCHEMA_VERSION}`);
  }
}

function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version?: number } | undefined;
  if (row === undefined || typeof row.version !== "number") return 0;
  return row.version;
}

function writeSchemaVersion(db: DatabaseSync, version: number): void {
  // 单行表：先清再写，避免出现两行而读到一个旧版本。
  db.exec("DELETE FROM schema_version");
  db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(version);
}

/** 迁移列表（诊断 / 文档用）。**只读**。 */
export function migrationList(): readonly { version: number; description: string }[] {
  return MIGRATIONS.map((migration) => ({ version: migration.version, description: migration.description }));
}
