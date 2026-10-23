/**
 * 迁移 2 的**升级路径**用例（`docs/执行-三端同步…` §8.4、§4.12）。
 *
 * ## 为什么单独立一个文件
 *
 * `db.test.ts` 里的用例都是「**全新**开库」，而迁移最危险的地方恰恰是**升级**：
 * 一个只在空库上正确的迁移，会在真实部署上**丢数据**。这里手工造一个 v1 形状的库，
 * 再让 `openDatabase` 只跑迁移 2，验证数据活着。
 *
 * ## 它记的是一个真实的 bug
 *
 * 第一版 `invites.created_by` 写成 `NOT NULL REFERENCES accounts(id)`，
 * 而 CLI 的 `create-invite` 用了一个不存在的 id（`"cli"`）——
 * **第一次真跑就炸** `FOREIGN KEY constraint failed`。
 *
 * 根因不是「忘了填合法 id」，而是**约束本身错了**：CLI 是「根信任」通道（§4.12），
 * 它的典型场景就是**还没有任何可用账号**的时候。所以「谁发的这个码」在那时**没有答案**。
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, migrationList, openDatabase } from "./db";

/** 造一个「schema_version = 1」的库：只建迁移 2 会碰到的那些表。 */
function createV1Database(path: string): void {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    CREATE TABLE accounts (
      id                TEXT PRIMARY KEY,
      auth_hash         TEXT NOT NULL UNIQUE,
      wrapped_enc_root  TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      last_seen_at      INTEGER,
      disabled_at       INTEGER,
      label             TEXT,
      is_admin          INTEGER NOT NULL DEFAULT 0
    );
    -- ★ v1 的形状：created_by 是 NOT NULL 且指向 accounts(id)
    CREATE TABLE invites (
      code_hash  TEXT PRIMARY KEY,
      created_by TEXT NOT NULL REFERENCES accounts(id),
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      max_uses   INTEGER NOT NULL DEFAULT 1,
      uses       INTEGER NOT NULL DEFAULT 0,
      revoked_at INTEGER
    );
  `);
  db.prepare("INSERT INTO schema_version (version) VALUES (1)").run();
  db.prepare(
    "INSERT INTO accounts (id, auth_hash, wrapped_enc_root, created_at, last_seen_at, disabled_at, label, is_admin) VALUES (?, ?, ?, ?, NULL, NULL, ?, 1)",
  ).run("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "hash-alice", "wrapped-alice", 1_700_000_000_000, "Alice");
  // 一条**已存在**的邀请码（由 Alice 发出）—— 迁移必须把它带过去。
  db.prepare("INSERT INTO invites (code_hash, created_by, created_at, expires_at, max_uses, uses, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)").run(
    "hash-of-old-invite",
    "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    1_700_000_000_001,
    null,
    3,
    1,
  );
  db.close();
}

function withTempDb<T>(run: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "opennote-mig-"));
  try {
    return run(join(dir, "control.db"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("迁移 2 · `invites.created_by` 允许为空", () => {
  it("**升级一个 v1 库：老数据活着**（表重建最危险的就是这里）", () => {
    withTempDb((path) => {
      createV1Database(path);

      const applied: number[] = [];
      const db = openDatabase({ path, onMigration: (migration, didApply) => (didApply ? applied.push(migration.version) : undefined) });

      //
      // 只跑了**尚未应用**的那些（这个库标记为 v1 ⇒ 迁移 1 被跳过）。
      // 期望值从迁移表推而不是写死 `[2]`：加迁移 3 时它又红了一次，
      // 而那次失败不是升级路径坏了，只是期望值过期 —— 与 `db.test.ts` 里那条同一个道理。
      expect(applied).toEqual(migrationList().map((item) => item.version).filter((version) => version > 1));
      expect((db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number }).version).toBe(SCHEMA_VERSION);

      // ★ 老的那条邀请码原样还在（连 uses 都保住）。
      const old = db.prepare("SELECT * FROM invites WHERE code_hash = ?").get("hash-of-old-invite") as unknown as {
        created_by: string | null;
        max_uses: number;
        uses: number;
        created_at: number;
      };
      expect(old).toBeTruthy();
      expect(old.created_by).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
      expect(old.max_uses).toBe(3);
      expect(old.uses).toBe(1);
      expect(old.created_at).toBe(1_700_000_000_001);

      // ★ 账号也还在（重建 invites 不该碰它）。
      expect((db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n).toBe(1);
      db.close();
    });
  });

  it("升级之后**能插入 `created_by = NULL`**（CLI 发码的那条路）", () => {
    withTempDb((path) => {
      createV1Database(path);
      const db = openDatabase({ path });

      // 这就是修好之前会炸的那一句。
      db.prepare("INSERT INTO invites (code_hash, created_by, created_at, expires_at, max_uses, uses, revoked_at) VALUES (?, NULL, ?, NULL, 1, 0, NULL)").run(
        "hash-of-cli-invite",
        1_700_000_000_002,
      );
      const row = db.prepare("SELECT created_by FROM invites WHERE code_hash = ?").get("hash-of-cli-invite") as unknown as { created_by: string | null };
      expect(row.created_by).toBeNull();
      db.close();
    });
  });

  it("**删账号不再需要手工清 `invites`**（`ON DELETE SET NULL` 兜住）", () => {
    withTempDb((path) => {
      createV1Database(path);
      const db = openDatabase({ path });
      db.exec("PRAGMA foreign_keys = ON");

      // 删掉 Alice：她发的那条邀请码不该变成悬空引用，而是 created_by 变 NULL。
      db.prepare("DELETE FROM accounts WHERE id = ?").run("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
      const row = db.prepare("SELECT created_by FROM invites WHERE code_hash = ?").get("hash-of-old-invite") as unknown as { created_by: string | null };
      expect(row).toBeTruthy();
      expect(row.created_by).toBeNull();
      db.close();
    });
  });

  it("重建表时**索引/主键语义不变**：`code_hash` 仍然是主键（不能插两条一样的）", () => {
    withTempDb((path) => {
      createV1Database(path);
      const db = openDatabase({ path });
      expect(() =>
        db.prepare("INSERT INTO invites (code_hash, created_by, created_at, expires_at, max_uses, uses, revoked_at) VALUES (?, NULL, ?, NULL, 1, 0, NULL)").run(
          "hash-of-old-invite",
          1,
        ),
      ).toThrow(/UNIQUE|PRIMARY/i);
      db.close();
    });
  });
});
