/**
 * 同步账本的单写队列。
 *
 * `sync.json` 是整份 JSON，多个入口（每轮成功后的 `onSynced`、同步中途的
 * 心跳式落盘）以前各自调用 `writeSyncLedger()`。后端只保证**单次**写入是
 * 临时文件 + rename，不能保证多次写入按调用顺序提交：先发起的写如果更晚
 * 完成，就会把后发起、内容更新的账本覆盖回去。
 *
 * 这里把每个 attached session 的账本写入收口成一条串行链：
 * 同一时刻最多一个写盘在途；在途期间的新请求只记「最新版」一遍，前一次
 * 完成后若期间有新请求，再写一次最新账本。最后一次写永远是排队时最新的
 * 快照，因此慢盘 / IPC 调度不会让基线回退。
 */

import type { SyncLedger } from "./state";

export interface LedgerWriteStats {
  /** 调用方请求写盘的次数。 */
  requested: number;
  /** 真正完成的写盘次数（合并后的请求不计）。 */
  written: number;
  /** 因已有写盘在途而被合并的请求数。 */
  coalesced: number;
  /** 写盘失败的次数；失败不会中断后续最新快照的写入。 */
  failed: number;
}

export interface LedgerWriteQueueOptions {
  /** 每次写盘失败时调用一次。异常会被这里吞掉，不会变成未处理的 rejection。 */
  onError?: (error: unknown) => void;
  /** 有新请求被合并到在途写入时调用；用于记录合并次数。 */
  onCoalesced?: (stats: Readonly<LedgerWriteStats>) => void;
}

export interface LedgerWriteQueue {
  /** 请求落盘；同一时刻最多一个写入在途，期间的新请求只保留最新账本。 */
  enqueue(ledger: SyncLedger): void;
  /** 等待当前及之前排队的写盘全部结束。失败已通过 `onError` 报告，不会 reject。 */
  flush(): Promise<void>;
  /**
   * 封口并等待已经排队的写盘结束。
   *
   * 关闭工作区 / 重连时，旧会话可能还有一次 `onSynced` 在飞。封口之后它的
   * 迟到请求会被丢弃，避免旧会话的账本晚于新会话写下去。
   */
  seal(): Promise<void>;
  /** 当前统计（副本，可安全展示 / 记录）。 */
  stats(): LedgerWriteStats;
}

/**
 * 建一条账本写盘链。`write` 必须自己保证**单次**写入的原子性（现有
 * `writeSyncLedger` 交给后端的 tmp + rename 满足这一点）；这里只负责多次
 * 写入之间的提交顺序和合并。
 */
export function createLedgerWriteQueue(
  write: (ledger: SyncLedger) => Promise<void>,
  options: LedgerWriteQueueOptions = {},
): LedgerWriteQueue {
  let latest: SyncLedger | null = null;
  let requested = 0;
  let completed = 0;
  let worker: Promise<void> | null = null;
  let sealed = false;
  const counters: LedgerWriteStats = { requested: 0, written: 0, coalesced: 0, failed: 0 };

  const reportError = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch (callbackError) {
      // 报告失败不能反过来中断写盘链，更不能制造未处理的 rejection。
      console.warn("[opennote] 账本落盘失败回调抛错", callbackError);
    }
  };

  const reportCoalesced = (): void => {
    try {
      options.onCoalesced?.(snapshotStats());
    } catch (callbackError) {
      console.warn("[opennote] 账本合并回调抛错", callbackError);
    }
  };

  const snapshotStats = (): LedgerWriteStats => ({ ...counters });

  const startWorker = (): void => {
    if (worker !== null) return;
    // 放进微任务再开始，确保 `worker` 先赋值：即使 `write` 同步触发新的
    // enqueue，也会走「合并」分支，而不是再起一条并发写链。
    worker = Promise.resolve().then(async () => {
      try {
        while (completed < requested) {
          const version = requested;
          const ledger = latest;
          if (ledger === null) {
            completed = version;
            break;
          }
          try {
            await write(ledger);
            counters.written += 1;
          } catch (error) {
            counters.failed += 1;
            reportError(error);
          } finally {
            completed = version;
          }
        }
      } finally {
        worker = null;
        // enqueue 可能恰好发生在循环退出与这里之间；别把最新请求留在队列里。
        if (completed < requested) startWorker();
      }
    });
  };

  const flush = async (): Promise<void> => {
    // worker 的 finally 可能紧接着启动下一条 worker，所以必须循环检查。
    while (worker !== null) await worker;
  };

  return {
    enqueue(ledger: SyncLedger): void {
      if (sealed) return;
      latest = ledger;
      requested += 1;
      counters.requested += 1;
      if (worker !== null) {
        counters.coalesced += 1;
        reportCoalesced();
        return;
      }
      startWorker();
    },

    flush,

    seal(): Promise<void> {
      sealed = true;
      return flush();
    },

    stats: snapshotStats,
  };
}
