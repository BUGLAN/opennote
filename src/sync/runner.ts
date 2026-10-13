/**
 * 同步的调度与状态（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §5.3、§4.6、§1.5 代价 2）。
 *
 * ## 它解决三个具体问题
 *
 * ### ① **单飞**（single-flight）：同一时刻只跑一次同步
 *
 * 触发源天然是多个的：本地写成功（去抖）、收到 SSE 信号、窗口重新获得焦点、
 * 用户手动点「立即同步」。它们**会**撞在一起 —— 而两次并发同步会
 * 各自列树、各自算计划、各自 CAS：轻则白跑一遍，重则两边都以为自己是第一个写的人。
 *
 * 所以这里不是「加锁排队」，而是**合并**：进行中时来的请求只记一个「结束后再来一次」，
 * 不排队（排 10 次没有意义，它们要的是同一件事：把最新状态同步出去）。
 *
 * ### ② **状态**：`StatusBar` 要显示的那几个字（§5.3）
 *
 * 「已同步 / 同步中 / 离线 / N 冲突 / **密钥已轮换**」。
 * 其中**「密钥已轮换」是一个独立状态**，不是「错误」的一种 ——
 * §1.5 代价 2 与第 2030 行都要求客户端在 401 时给**明确文案**：
 * 「此设备的密钥已被轮换，请导入新密钥」。把它归进「同步失败」会让用户去查网络。
 *
 * ### ③ **本地写之后要去抖推一次**
 *
 * §5.3 把「`flushNote` 成功后挂防抖排队 push」列为自动同步的入口。
 * 去抖放在这里（而不是在 `library.ts` 里）是因为**它和单飞是同一件事的两半**：
 * 去抖决定「什么时候值得试」，单飞决定「试的时候有没有人在跑」。
 *
 * ## 一处刻意的不做
 *
 * **它不碰文件系统、不碰 provider** —— 那些通过 `deps` 注入。
 * 于是它可以用 memory provider 完整地测（包括并发与错误分类），
 * 而接线到真实 `library.ts` / `fs` 是另一件独立的事。
 */

import { SyncProviderError } from "./provider-types";
import type { SyncOnceResult } from "./engine";

/** `StatusBar` 要显示的状态（§5.3 列了五种，这里一一对应）。 */
export type SyncStatus =
  | { phase: "idle"; lastSyncedAt: number | null; conflicts: number }
  | { phase: "syncing"; startedAt: number }
  | { phase: "offline"; error: string; lastSyncedAt: number | null }
  /** 密钥已被轮换 / 账号被禁用 —— **独立状态**，不是「错误」的一种（§1.5 代价 2）。 */
  | { phase: "key-rotated"; lastSyncedAt: number | null }
  | { phase: "error"; error: string; code: string; lastSyncedAt: number | null };

/** 触发这次同步的原因（日志与诊断用；也便于用例断言「谁触发的」）。 */
export type SyncTrigger = "manual" | "local-write" | "signal" | "focus" | "startup";

export interface SyncRunnerDeps {
  /** 跑一次同步（`engine.syncOnce` 的包装）。 */
  syncOnce: () => Promise<SyncOnceResult>;
  /** 状态变化（UI 订阅它）。 */
  onStatus?: (status: SyncStatus) => void;
  /**
   * 拉取落地之后要刷新的**路径**（§5.4 第 2 条：**按路径**刷新，不要 `rescanWorkspace` 那种 O(库) 的）。
   * 上层把它接到 `applyExternalPaths()`。
   */
  onApplied?: (paths: string[]) => void;
  /** 本地写之后等多久才推（去抖）。默认 1200ms。 */
  localWriteDebounceMs?: number;
  /** 现在几点（测试注入）。 */
  now?: () => number;
  /** 定时器（测试注入）。 */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  log?: (line: string) => void;
}

export interface SyncRunner {
  status(): SyncStatus;
  /**
   * 请求一次同步。
   *
   * 返回这次**实际跑到**的结果；如果合并进了正在进行的那一次，返回 `null`
   * （调用方不需要知道细节，它只要「同步过了」这个事实）。
   */
  request(trigger: SyncTrigger): Promise<SyncOnceResult | null>;
  /** 本地写成功之后调（去抖）。重复调用只保留最后一次。 */
  scheduleAfterLocalWrite(): void;
  /** 停掉定时器（关工作区 / 卸载）。 */
  dispose(): void;
}

/** 默认去抖：1200ms。比自动保存的 450ms 长一些，让一次连续编辑只推一次。 */
const DEFAULT_DEBOUNCE_MS = 1200;

/** 把一次失败翻成状态。**401 单独成一种状态**，见模块头 ②。 */
export function statusForError(error: unknown, lastSyncedAt: number | null): SyncStatus {
  if (error instanceof SyncProviderError) {
    // ★ 「密钥已轮换」不是错误，是一个**要用户动手**的状态。
    if (error.code === "rotated") return { phase: "key-rotated", lastSyncedAt };
    // 网络类问题报「离线」——它对用户的含义与「服务端 500」不同（前者等等就好）。
    if (error.code === "network") return { phase: "offline", error: error.message, lastSyncedAt };
    return { phase: "error", error: error.message, code: error.code, lastSyncedAt };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { phase: "error", error: message, code: "unknown", lastSyncedAt };
}

export function createSyncRunner(deps: SyncRunnerDeps): SyncRunner {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const debounceMs = deps.localWriteDebounceMs ?? DEFAULT_DEBOUNCE_MS;

  let lastSyncedAt: number | null = null;
  let conflicts = 0;
  let current: SyncStatus = { phase: "idle", lastSyncedAt: null, conflicts: 0 };
  /** 进行中的那一次（单飞用）。 */
  let inFlight: Promise<SyncOnceResult | null> | null = null;
  /** 进行中时又来了请求 ⇒ 跑完再来一次（**只记一次**，不排队）。 */
  let pendingAgain = false;
  let debounceHandle: unknown = null;
  let disposed = false;

  const publish = (status: SyncStatus): void => {
    current = status;
    deps.onStatus?.(status);
  };

  /** 跑一次（内部；调用方保证没有别的在跑）。 */
  const runOnce = async (): Promise<SyncOnceResult | null> => {
    publish({ phase: "syncing", startedAt: now() });
    try {
      const result = await deps.syncOnce();
      lastSyncedAt = now();
      conflicts = result.conflicts.length + result.pushConflicts.length;
      /*
       * 拉取落地之后**按路径**刷新（§5.4 第 2 条）。
       * 只在真有落地时才调 —— 空数组也调一次会让上层白跑一轮索引重建。
       */
      if (result.appliedPaths.length > 0) deps.onApplied?.(result.appliedPaths);
      publish({ phase: "idle", lastSyncedAt, conflicts });
      return result;
    } catch (error) {
      const status = statusForError(error, lastSyncedAt);
      deps.log?.(`[sync] 失败：${JSON.stringify(status)}`);
      publish(status);
      return null;
    }
  };

  return {
    status: () => current,

    async request(trigger) {
      if (disposed) return null;
      if (inFlight) {
        /*
         * ★ **合并，不排队**：这次请求要的是「把最新状态同步出去」，
         * 而正在跑的那一次跑完之后会再跑一次 —— 那已经覆盖了它。
         */
        pendingAgain = true;
        deps.log?.(`[sync] ${trigger} 合并进进行中的那一次`);
        return null;
      }

      inFlight = (async () => {
        try {
          let last: SyncOnceResult | null = null;
          // 先跑一次；如果期间又有人请求，就再跑一次（最多两轮，避免活锁）。
          last = await runOnce();
          if (pendingAgain) {
            pendingAgain = false;
            last = await runOnce();
          }
          return last;
        } finally {
          inFlight = null;
          pendingAgain = false;
        }
      })();
      return inFlight;
    },

    scheduleAfterLocalWrite() {
      if (disposed) return;
      if (debounceHandle !== null) clearTimer(debounceHandle);
      debounceHandle = setTimer(() => {
        debounceHandle = null;
        void this.request("local-write");
      }, debounceMs);
    },

    dispose() {
      disposed = true;
      if (debounceHandle !== null) {
        clearTimer(debounceHandle);
        debounceHandle = null;
      }
    },
  };
}
