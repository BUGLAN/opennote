import { describe, expect, it } from "vitest";
import { createLedgerWriteQueue } from "./ledgerWriter";
import { createSyncLedger, type SyncLedger } from "./state";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function newLedger(notebookId: string): SyncLedger {
  return createSyncLedger({
    baseUrl: "https://notes.example.com",
    notebookId,
    cryptoMode: "none",
    protocolVersion: 2,
  });
}

describe("账本单写队列", () => {
  it("同一时刻只有一个写入；在途期间的请求合并，最终写最新账本", async () => {
    const firstWrite = deferred();
    const seen: string[] = [];
    let active = 0;
    let maxActive = 0;
    const queue = createLedgerWriteQueue(async (ledger) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      seen.push(ledger.remote.notebookId);
      if (seen.length === 1) await firstWrite.promise;
      active -= 1;
    });

    const ledger = newLedger("v1");
    queue.enqueue(ledger);
    await Promise.resolve();

    ledger.remote.notebookId = "v2";
    queue.enqueue(ledger);
    ledger.remote.notebookId = "v3";
    queue.enqueue(ledger);

    const flushed = queue.flush();
    firstWrite.resolve();
    await flushed;

    expect(seen).toEqual(["v1", "v3"]);
    expect(maxActive).toBe(1);
    expect(queue.stats()).toEqual({ requested: 3, written: 2, coalesced: 2, failed: 0 });
  });

  it("写失败被报告，后续请求仍会写最新账本，flush 不产生未处理 rejection", async () => {
    const firstWrite = deferred();
    const seen: string[] = [];
    const errors: unknown[] = [];
    const queue = createLedgerWriteQueue(
      async (ledger) => {
        seen.push(ledger.remote.notebookId);
        if (seen.length === 1) {
          await firstWrite.promise;
          throw new Error("模拟慢盘写失败");
        }
      },
      { onError: (error) => errors.push(error) },
    );

    const ledger = newLedger("v1");
    queue.enqueue(ledger);
    await Promise.resolve();

    ledger.remote.notebookId = "v2";
    queue.enqueue(ledger);

    const flushed = queue.flush();
    firstWrite.resolve();
    await expect(flushed).resolves.toBeUndefined();

    expect(seen).toEqual(["v1", "v2"]);
    expect(errors).toHaveLength(1);
    expect(queue.stats()).toEqual({ requested: 2, written: 1, coalesced: 1, failed: 1 });
  });

  it("flush 等到最后一份账本真正写完", async () => {
    const gate = deferred();
    let finished = false;
    const queue = createLedgerWriteQueue(async () => {
      await gate.promise;
      finished = true;
    });

    queue.enqueue(newLedger("v1"));
    let flushed = false;
    const flushing = queue.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);

    gate.resolve();
    await flushing;
    expect(finished).toBe(true);
    expect(flushed).toBe(true);
  });

  it("seal 会丢弃迟到请求，旧会话不能晚于新会话覆盖账本", async () => {
    const gate = deferred();
    const seen: string[] = [];
    const queue = createLedgerWriteQueue(async (ledger) => {
      seen.push(ledger.remote.notebookId);
      if (seen.length === 1) await gate.promise;
    });

    const ledger = newLedger("v1");
    queue.enqueue(ledger);
    await Promise.resolve();

    const sealed = queue.seal();
    ledger.remote.notebookId = "late";
    queue.enqueue(ledger);
    gate.resolve();
    await sealed;

    expect(seen).toEqual(["v1"]);
    expect(queue.stats()).toEqual({ requested: 1, written: 1, coalesced: 0, failed: 0 });
  });
});
