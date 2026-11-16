/**
 * 笔记本邀请码在**多个连接**上的消费用例。
 *
 * 服务端虽然跑在单线程里，但同一个 `control.db` 可以同时被多个进程 / 实例打开
 * （SQLite WAL 本来就支持多进程读写）。事务外的「先查再写」在这种部署下会
 * 让两个消费者都通过预检查 —— 卡片 `opennote/main#7` 报告的并发双用就是它。
 *
 * 这里用两个以上真实的 `DatabaseSync` 连接指向同一个文件库，确认：
 *
 * 1. 单次邀请只有一个赢家；
 * 2. 多用途邀请最多放行 `max_uses` 个，且成员行数与 `uses` 一致。
 *
 * 消费判定必须是**事务内**的 `UPDATE ... WHERE uses < max_uses`，不能依赖
 * 事务外读到的 `invite` 快照；否则跨进程时第二个事务看不到第一个事务的提交。
 */
import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { openDatabase } from "./db";
import { NotebookError, NotebookStore } from "./notebooks";
import { seedAccount, testAccountStore } from "./auth/testAccounts.test-helper";

function withSharedDatabase(run: (path: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(joinPath(tmpdir(), "opennote-invite-"));
  const path = joinPath(dir, "control.db");
  return run(path).finally(() => rmSync(dir, { recursive: true, force: true }));
}

type JoinAttempt = { ok: true; accountId: string } | { ok: false; code: string };

function attempt(store: NotebookStore, codeHash: string, accountId: string): JoinAttempt {
  try {
    store.joinByInvite(codeHash, accountId);
    return { ok: true, accountId };
  } catch (error) {
    return { ok: false, code: error instanceof NotebookError ? error.code : String(error) };
  }
}

describe("跨连接消费笔记本邀请码", () => {
  it("两个连接同时用同一张单次邀请：只有一个成功", async () => {
    await withSharedDatabase(async (path) => {
      const dbA = openDatabase({ path });
      const dbB = openDatabase({ path });
      try {
        const accounts = testAccountStore(dbA);
        const alice = seedAccount(accounts);
        const bob = seedAccount(accounts);
        const carol = seedAccount(accounts);
        const storeA = new NotebookStore(dbA);
        const storeB = new NotebookStore(dbB);
        const notebook = storeA.create({ ownerId: alice.id, name: "共享", cryptoMode: "none" });
        storeA.createInvite({ codeHash: "h-one", notebookId: notebook.id, role: "editor", createdBy: alice.id, maxUses: 1 });

        const results = await Promise.all([
          Promise.resolve().then(() => attempt(storeA, "h-one", bob.id)),
          Promise.resolve().then(() => attempt(storeB, "h-one", carol.id)),
        ]);

        expect(results.filter((result) => result.ok)).toHaveLength(1);
        const loser = results.find((result) => !result.ok);
        expect(loser && !loser.ok ? loser.code : null).toBe("invite-used");
        // 只有赢家变成成员（另加 owner）。
        expect(storeA.listMembers(notebook.id)).toHaveLength(2);
        const row = dbA.prepare("SELECT max_uses, uses FROM notebook_invites WHERE code_hash = ?").get("h-one") as unknown as {
          max_uses: number;
          uses: number;
        };
        expect(row).toEqual({ max_uses: 1, uses: 1 });
      } finally {
        dbA.close();
        dbB.close();
      }
    });
  });

  it("多用途邀请在 4 个连接上只放行 max_uses 个", async () => {
    await withSharedDatabase(async (path) => {
      const connections: DatabaseSync[] = [openDatabase({ path }), openDatabase({ path }), openDatabase({ path }), openDatabase({ path })];
      try {
        const accounts = testAccountStore(connections[0]!);
        const alice = seedAccount(accounts);
        const people = Array.from({ length: 6 }, () => seedAccount(accounts));
        const stores = connections.map((connection) => new NotebookStore(connection));
        const notebook = stores[0]!.create({ ownerId: alice.id, name: "共享", cryptoMode: "none" });
        stores[0]!.createInvite({ codeHash: "h-two", notebookId: notebook.id, role: "viewer", createdBy: alice.id, maxUses: 2 });

        const results = await Promise.all(
          people.map((person, index) => Promise.resolve().then(() => attempt(stores[index % stores.length]!, "h-two", person.id))),
        );

        expect(results.filter((result) => result.ok)).toHaveLength(2);
        for (const loser of results.filter((result) => !result.ok)) {
          expect(loser.ok ? null : loser.code).toBe("invite-used");
        }
        expect(stores[0]!.listMembers(notebook.id)).toHaveLength(3); // owner + 2
        const row = connections[0]!.prepare("SELECT max_uses, uses, used_at FROM notebook_invites WHERE code_hash = ?").get("h-two") as unknown as {
          max_uses: number;
          uses: number;
          used_at: number | null;
        };
        expect(row.max_uses).toBe(2);
        expect(row.uses).toBe(2);
        expect(row.used_at).not.toBeNull();
      } finally {
        for (const connection of connections) connection.close();
      }
    });
  });

  it("另一条连接在消费前读到的是旧快照，也不能二次消费", async () => {
    await withSharedDatabase(async (path) => {
      const dbA = openDatabase({ path });
      const dbB = openDatabase({ path });
      try {
        const accounts = testAccountStore(dbA);
        const alice = seedAccount(accounts);
        const bob = seedAccount(accounts);
        const carol = seedAccount(accounts);
        const storeA = new NotebookStore(dbA);
        const storeB = new NotebookStore(dbB);
        const notebook = storeA.create({ ownerId: alice.id, name: "共享", cryptoMode: "none" });
        storeA.createInvite({ codeHash: "h-stale", notebookId: notebook.id, role: "editor", createdBy: alice.id, maxUses: 1 });

        // B 的旧快照（事务外预检查会看到的样子）：uses = 0。
        const stale = dbB.prepare("SELECT uses, max_uses FROM notebook_invites WHERE code_hash = ?").get("h-stale") as unknown as {
          uses: number;
          max_uses: number;
        };
        expect(stale).toEqual({ uses: 0, max_uses: 1 });

        expect(attempt(storeA, "h-stale", bob.id).ok).toBe(true);
        // A 提交之后，B 再消费：不能因为手里有旧快照就放行。
        expect(attempt(storeB, "h-stale", carol.id)).toEqual({ ok: false, code: "invite-used" });
        expect(storeA.listMembers(notebook.id)).toHaveLength(2);
      } finally {
        dbA.close();
        dbB.close();
      }
    });
  });
});
