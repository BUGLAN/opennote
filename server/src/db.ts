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
 * 1. **密码只存 scrypt 哈希**（`auth/passwords.ts`），会话令牌只存 sha256（v4 起，
 *    `docs/执行-同步重写-2026-11-02.md`）。明文令牌只在登录响应里出现一次。
 * 2. **`wrapped_enc_root` 是密文**：由客户端用「加密口令」派生的 `wrapKey` 包好再上传。
 *    服务端**解不开**，因为它没有 `wrapKey`（红线 3）。
 * 3. **审计表永不包含正文或密钥材料**（§4.3 注释里写死了这一条）。
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** 当前 schema 版本。加一条迁移就 +1（**只加不删**）。 */
export const SCHEMA_VERSION = 4;

interface Migration {
  version: number;
  /** 人类可读的一句话（迁移日志与控制台都会显示，便于审计）。 */
  description: string;
  up: (db: DatabaseSync) => void;
  /**
   * 要重建被外键引用的表时置 true：`migrate()` 在事务**外**关掉外键、事务内跑完后用
   * `PRAGMA foreign_key_check` 兜底，再打开（SQLite 官方的「12 步改表」流程）。
   * 外键开关在事务里改不了，所以只能由 `migrate()` 来做。
   */
  foreignKeysOff?: boolean;
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
  {
    version: 3,
    description: "控制台需要的真实用量与同步活动：notebook_usage / sync_activity",
    up: (db) => {
      /*
       * ## 为什么需要这两张表
       *
       * 控制台的「同步台账」「账号与访问」「运行状态」都要回答**服务端自己就能回答**的问题，
       * 而 v2 的 schema 里没有地方存答案：
       *
       * - `quota_usage.bytes_used` 只在注册时写过一次 0，之后**没有任何代码更新它**
       *   （`quotaOf()` 读到的永远是 0）—— 用量条、台账的「占用」都是 0 B。
       * - `client_stats` 是**客户端上报**的计数，而当前客户端没有上报调用
       *   （`POST /v1/stats` 在生产路径上没人调）—— 流量图永远是空的。
       *
       * 这两件事服务端都**有证据**：正文是它写进 CouchDB 的（大小它知道），
       * 请求是它自己接的（次数它知道）。所以这里给它们各自一张表，
       * 由 `NotebookStore` 在数据面的读写路径上记账。
       *
       * ## 为什么不直接复用 `quota_usage` / `client_stats`
       *
       * - `quota_usage` 是**按账号**的配额缓存（一个账号一行）。而台账要的是
       *   **按库**的占用 —— 一个账号有 20 个库时，「哪个库占了多少」是行级信息。
       * - `client_stats` 是**客户端说是多少**。服务端自己数出来的不能和它混在一行，
       *   否则「客户端上报」与「服务端实测」这两个来源就再也分不开了 ——
       *   而它们回答的不是同一个问题（客户端数的是它自己发的请求，
       *   服务端数的是它收到的请求；差一个重试、一个 429 就对不上）。
       *
       * ## 只加不删
       *
       * 两张都是新表，不动任何已有列。回滚服务端版本时旧代码看不到它们，也不会被它们影响。
       */
      db.exec(`
        -- 每个库实际占用的字节数（服务端在写/删正文时记账，见 NotebookStore.addNotebookBytes）。
        CREATE TABLE notebook_usage (
          notebook_id TEXT PRIMARY KEY REFERENCES notebooks(id),
          bytes_used  INTEGER NOT NULL DEFAULT 0,
          updated_at  INTEGER NOT NULL
        );

        -- 服务端在 /v1 数据面**亲自观察到**的同步活动（按账号 / 库 / 天）。
        -- ★ 与 client_stats 刻意分开：那张是客户端上报的，这张是服务端实测的。
        CREATE TABLE sync_activity (
          account_id  TEXT NOT NULL,
          notebook_id TEXT NOT NULL,
          day         TEXT NOT NULL,
          pulls       INTEGER NOT NULL DEFAULT 0,
          pushes      INTEGER NOT NULL DEFAULT 0,
          deletes     INTEGER NOT NULL DEFAULT 0,
          conflicts   INTEGER NOT NULL DEFAULT 0,
          errors      INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (account_id, notebook_id, day)
        );

        -- 按天做范围查询（控制台近 30 天聚合）要它；否则每次都要全表扫。
        --
        -- ⚠️ 这里**只**给新表建索引。client_stats 上也该有一条（同样的按天查询），
        -- 但那是迁移 1 建的表 —— 在一个「只跑了迁移 1 的库」上它当然在，
        -- 而迁移用例会造**形状不完整的 v1 库**（只建迁移会碰到的表），
        -- 对不存在的表建索引会让整个迁移回滚。需要的话另加一条迁移，别在这里赌。
        CREATE INDEX idx_sync_activity_day ON sync_activity(day);
      `);
    },
  },
  {
    version: 4,
    description: "账号改为邮箱 + 密码：重建 accounts，新增 sessions / password_resets / server_settings，邀请带邮箱与角色",
    foreignKeysOff: true,
    up: (db) => {
      /*
       * ## 为什么重建 accounts（而不是加列）
       *
       * v1–v3 的 accounts 是「密钥即身份」：`auth_hash` / `wrapped_enc_root` 都是 NOT NULL，
       * 新账号根本没有这两样东西。同步重写（`docs/执行-同步重写-2026-11-02.md`）决定**不兼容**
       * 旧账号，所以旧行原样搬过来但没有邮箱和密码 —— 它们再也登录不了，只留着让外键与审计不断。
       *
       * - `email` 用 `COLLATE NOCASE` 的唯一约束：`Lan@x.com` 与 `lan@x.com` 是同一个人。
       * - `password_hash` 可空：只用 GitHub 登录的账号没有密码。
       * - `quota_bytes` 可空：空 = 跟随服务默认值（改默认值时不用逐个改账号）。
       * - `wrapped_enc_root` / `enc_params` 留给「加密口令」阶段，现在恒为空。
       *
       * ## 凭据不再是账号本身
       *
       * 以前令牌就是身份，所以没有会话表。现在登录换来不透明令牌，`sessions` 只存它的 sha256；
       * 移除设备 = 吊销它的会话，改密码 = 吊销全部会话。
       *
       * `bootstrap_codes` 删掉：第一个管理员改由「零账号时的初始化接口」与 CLI `create-admin` 产生。
       */
      db.exec(`
        CREATE TABLE accounts_v4 (
          id               TEXT PRIMARY KEY,
          email            TEXT UNIQUE COLLATE NOCASE,
          display_name     TEXT,
          password_hash    TEXT,
          is_admin         INTEGER NOT NULL DEFAULT 0,
          status           TEXT NOT NULL DEFAULT 'active',   -- active | disabled
          quota_bytes      INTEGER,
          wrapped_enc_root TEXT,
          enc_params       TEXT,
          created_at       INTEGER NOT NULL,
          last_seen_at     INTEGER
        );
      `);
      // 旧表的列在不同版本里不完全一样（早期是 `disabled_at` 而不是 `status`），按实际存在的列搬。
      const legacy = new Set((db.prepare("PRAGMA table_info(accounts)").all() as unknown as { name: string }[]).map((row) => row.name));
      const statusExpr = legacy.has("status") ? "status" : legacy.has("disabled_at") ? "CASE WHEN disabled_at IS NULL THEN 'active' ELSE 'disabled' END" : "'active'";
      db.exec(`
        INSERT INTO accounts_v4 (id, email, display_name, password_hash, is_admin, status, quota_bytes, wrapped_enc_root, enc_params, created_at, last_seen_at)
          SELECT id, NULL, ${legacy.has("label") ? "label" : "NULL"}, NULL, ${legacy.has("is_admin") ? "is_admin" : "0"}, ${statusExpr}, NULL, NULL, NULL, created_at, ${legacy.has("last_seen_at") ? "last_seen_at" : "NULL"}
            FROM accounts;
        DROP TABLE accounts;
        ALTER TABLE accounts_v4 RENAME TO accounts;

        CREATE TABLE sessions (
          id           TEXT PRIMARY KEY,
          account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          token_hash   TEXT NOT NULL UNIQUE,          -- sha256(令牌)  ★ 明文只在登录响应里出现一次
          kind         TEXT NOT NULL,                 -- device | panel
          device_id    TEXT,
          created_at   INTEGER NOT NULL,
          last_used_at INTEGER,
          expires_at   INTEGER,                       -- 空 = 不过期（设备会话）
          revoked_at   INTEGER,
          ip           TEXT
        );
        CREATE INDEX idx_sessions_account ON sessions(account_id);

        CREATE TABLE password_resets (
          code_hash  TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          created_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          used_at    INTEGER
        );

        -- 可在控制台改、即时生效的服务设置（键值对；值是 JSON 文本）
        CREATE TABLE server_settings (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        ALTER TABLE invites ADD COLUMN email TEXT;
        ALTER TABLE invites ADD COLUMN grant_admin INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE invites ADD COLUMN quota_bytes INTEGER;
        ALTER TABLE invites ADD COLUMN accepted_by TEXT;

        ALTER TABLE devices ADD COLUMN os TEXT;
        ALTER TABLE devices ADD COLUMN client_version TEXT;
        ALTER TABLE devices ADD COLUMN revoked_at INTEGER;

        DROP TABLE IF EXISTS bootstrap_codes;
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
    if (migration.foreignKeysOff) db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN");
    try {
      migration.up(db);
      if (migration.foreignKeysOff) {
        const broken = db.prepare("PRAGMA foreign_key_check").all();
        if (broken.length > 0) throw new Error(`外键检查失败：${JSON.stringify(broken.slice(0, 3))}`);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(`迁移 ${migration.version}（${migration.description}）失败，已回滚：${String(error)}`);
    } finally {
      if (migration.foreignKeysOff) db.exec("PRAGMA foreign_keys = ON");
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
