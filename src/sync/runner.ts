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
/** 一轮同步进行中的逐文件进度（规划完成后 total 才确定）。 */
export interface SyncProgress {
  done: number;
  total: number;
}

export type SyncStatus =
  | { phase: "idle"; lastSyncedAt: number | null; conflicts: number }
  | { phase: "syncing"; startedAt: number; /** 规划完成后的逐文件进度；规划前为 null。 */
      progress: SyncProgress | null }
  | { phase: "offline"; error: string; lastSyncedAt: number | null }
  /** 密钥已被轮换 / 账号被禁用 —— **独立状态**，不是「错误」的一种（§1.5 代价 2）。 */
  | { phase: "key-rotated"; lastSyncedAt: number | null }
  | { phase: "error"; error: string; code: string; lastSyncedAt: number | null };

/** 触发这次同步的原因（日志与诊断用；也便于用例断言「谁触发的」）。 */
export type SyncTrigger = "manual" | "local-write" | "signal" | "focus" | "startup" | "retry";

export interface SyncRunnerDeps {
  /** 跑一次同步（`engine.syncOnce` 的包装）。 */
  syncOnce: () => Promise<SyncOnceResult>;
  /** 状态变化（UI 订阅它）。 */
  onStatus?: (status: SyncStatus) => void;
  /** 同步进行中的逐文件进度（引擎每完成一个文件回调一次；UI 画进度条用）。 */
  onProgress?: (progress: SyncProgress) => void;
  /**
   * 每一次同步**成功跑完**都回调（不管有没有实际改动）。
   *
   * 与 `onApplied` 的差别：`onApplied` 只在有落地改动时触发，而账本在
   * **纯推送**的那一轮也会变（rev / remoteHash 前进了）。落盘账本的调用方
   * 必须在**每一轮**之后写盘，否则「推完就退出」会把 rev 丢在内存里 ——
   * 下一次启动拿着空基线去 CAS，每条都撞 409。
   */
  onSynced?: (result: SyncOnceResult) => void;
  /**
   * 拉取落地之后要刷新的**路径**（§5.4 第 2 条：**按路径**刷新，不要 `rescanWorkspace` 那种 O(库) 的）。
   * 上层把它接到 `applyExternalPaths()`。
   */
  onApplied?: (paths: string[]) => void;
  /** 本地写之后等多久才推（去抖）。默认 1200ms。 */
  localWriteDebounceMs?: number;
  /**
   * 一轮失败之后**多久自动重试**（指数增长，带上限）。默认 5000ms 起、120000ms 封顶。
   *
   * ## 为什么必须有这条（而不是「等下一个信号」）
   *
   * 触发源本来只有四个：启动 / 远端信号 / 本地写 / 手点。它们在**失败之后都不会再来**
   * —— 远端没人在改、用户也没在编辑时，一次 429 或断网就让这台设备**永远停在那里**。
   * 状态栏还写着「网络恢复后会自动重试」，而代码里根本没有重试 —— 那是一句谎话。
   *
   * 只对**可重试**的失败重试（`network` / `server`）：密钥被轮换、配额满、
   * 协议不兼容这些重试一万次也不会好，重试只会刷屏。
   */
  retryBaseDelayMs?: number;
  /** 自动重试的延迟上限。默认 120000ms（2 分钟）。 */
  retryMaxDelayMs?: number;
  /** 现在几点（测试注入）。 */
  now?: () => number;
  /** 定时器（测试注入）。 */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  log?: (line: string) => void;
}

export interface SyncRunner {
  status(): SyncStatus;
  /** 引擎每完成一个文件回调一次；更新「同步中」状态里的进度（UI 进度条）。 */
  reportProgress(progress: SyncProgress): void;
  /**
   * 请求一次同步。
   *
   * 返回这次**实际跑到**的结果；如果合并进了正在进行的那一次，返回 `null`
   * （调用方不需要知道细节，它只要「同步过了」这个事实）。
   */
  request(trigger: SyncTrigger): Promise<SyncOnceResult | null>;
  /**
   * 「核对过：你已是最新」——**没有跑同步**，但游标与服务端一致。
   *
   * 为什么需要它：流连上时会先把 `ready.cursor` 和本机记的比一比，
   * 一致就跳过同步（这是「打开应用 0 个请求」的来源）。可是**跳过**之后状态栏
   * 还停在「尚未同步」，用户会以为没同步过 —— 而事实上我们刚刚**核对过**他确实是最新的。
   * 所以这里只更新「上次同步时间」，不碰 `conflicts`（那是上一轮的事实）。
   */
  noteUpToDate(): void;
  /** 本地写成功之后调（去抖）。重复调用只保留最后一次。 */
  scheduleAfterLocalWrite(): void;
  /** 停掉定时器（关工作区 / 卸载）。 */
  dispose(): void;
}

/** 默认去抖：1200ms。比自动保存的 450ms 长一些，让一次连续编辑只推一次。 */
const DEFAULT_DEBOUNCE_MS = 1200;

/** 自动重试：首次 5 秒，之后翻倍，2 分钟封顶（见 `retryBaseDelayMs`）。 */
const DEFAULT_RETRY_BASE_MS = 5000;
const DEFAULT_RETRY_MAX_MS = 120_000;

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

/** 这类失败值不值得自动重试（见 `retryBaseDelayMs`）。 */
export function isRetryableFailure(error: unknown): boolean {
  return error instanceof SyncProviderError && (error.code === "network" || error.code === "server");
}

export function createSyncRunner(deps: SyncRunnerDeps): SyncRunner {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const debounceMs = deps.localWriteDebounceMs ?? DEFAULT_DEBOUNCE_MS;
  const retryBase = deps.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS;
  const retryMax = deps.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_MS;

  let lastSyncedAt: number | null = null;
  let conflicts = 0;
  let current: SyncStatus = { phase: "idle", lastSyncedAt: null, conflicts: 0 };
  /** 进行中的那一次（单飞用）。 */
  let inFlight: Promise<SyncOnceResult | null> | null = null;
  /** 本轮进行中的逐文件进度（引擎回调；runOnce 开始时清零）。 */
  let progress: SyncProgress | null = null;
  /** 进行中时又来了请求 ⇒ 跑完再来一次（**只记一次**，不排队）。 */
  let pendingAgain = false;
  let debounceHandle: unknown = null;
  /** 自动重试的定时器（`retryHandle`）与已经重试过几次（决定退避长度）。 */
  let retryHandle: unknown = null;
  let retryAttempt = 0;
  /** 对象自引用（定时器要回调 `request`，而它在对象字面量里）。 */
  let runner: SyncRunner | null = null;
  let disposed = false;

  const publish = (status: SyncStatus): void => {
    current = status;
    deps.onStatus?.(status);
  };

  /** 取消挂着的自动重试（成功之后 / 用户手动同步 / dispose 都要调）。 */
  const clearRetry = (): void => {
    if (retryHandle === null) return;
    clearTimer(retryHandle);
    retryHandle = null;
  };

  /**
   * 失败之后排一次自动重试（指数退避，2 分钟封顶）。
   *
   * 只对可重试的失败排（见 `isRetryableFailure`）：密钥被轮换、配额满这些
   * 重试一万次也不会好，反倒会把状态栏刷成一片「同步失败」。
   */
  const scheduleRetry = (error: unknown): void => {
    if (disposed || !isRetryableFailure(error)) return;
    clearRetry();
    const delay = Math.min(retryBase * 2 ** retryAttempt, retryMax);
    retryAttempt += 1;
    deps.log?.(`[sync] ${delay}ms 后自动重试（第 ${retryAttempt} 次）`);
    retryHandle = setTimer(() => {
      retryHandle = null;
      if (disposed) return;
      void runner?.request("retry");
    }, delay);
  };

  /** 跑一次（内部；调用方保证没有别的在跑）。 */
  const runOnce = async (): Promise<SyncOnceResult | null> => {
    progress = null;
    publish({ phase: "syncing", startedAt: now(), progress: null });
    try {
      const result = await deps.syncOnce();
      lastSyncedAt = now();
      conflicts = result.conflicts.length + result.pushConflicts.length;
      /*
       * 拉取落地之后**按路径**刷新（§5.4 第 2 条）。
       * 只在真有落地时才调 —— 空数组也调一次会让上层白跑一轮索引重建。
       */
      if (result.appliedPaths.length > 0) deps.onApplied?.(result.appliedPaths);
      // 每一轮成功都通知（见 deps.onSynced 的说明：账本落盘不能只盯「有落地」的那几轮）。
      deps.onSynced?.(result);
      // 成功 ⇒ 退避计数归零，挂着的重试也没必要了。
      retryAttempt = 0;
      clearRetry();
      publish({ phase: "idle", lastSyncedAt, conflicts });
      return result;
    } catch (error) {
      const status = statusForError(error, lastSyncedAt);
      deps.log?.(`[sync] 失败：${JSON.stringify(status)}`);
      publish(status);
      scheduleRetry(error);
      return null;
    }
  };

  const api: SyncRunner = {
    status: () => current,

    noteUpToDate(): void {
      // 只把「上次同步时间」推到现在：我们确实刚和服务端核对过，内容也一致。
      lastSyncedAt = now();
      publish({ phase: "idle", lastSyncedAt, conflicts });
    },

    /** 引擎每完成一个文件回调一次（session 把它接到引擎的 onProgress 上）。 */
    reportProgress(newProgress: SyncProgress): void {
      progress = newProgress;
      if (current?.phase === "syncing") publish({ ...current, progress });
    },

    async request(trigger) {
      if (disposed) return null;
      /*
       * 任何一次显式请求都作废「挂着的自动重试」：我们**现在**就在跑，
       * 跑完之后要么成功（清计数）要么失败（重新排）。
       */
      clearRetry();
      if (trigger === "manual") retryAttempt = 0;
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
      clearRetry();
    },
  };
  runner = api;
  return api;
}

/* ============================================================================
   状态 → 界面文案（`StatusBar` 直接用它）
   ============================================================================ */

/** 状态栏要显示的东西（`tone` 决定颜色，`detail` 是次要的一行）。 */
export interface SyncStatusText {
  label: string;
  detail: string | null;
  tone: "idle" | "busy" | "warn" | "error";
  /** 这个状态是否需要用户**动手**（状态栏据此决定要不要显示一个可点的入口）。 */
  actionable: boolean;
}

/**
 * 把 `SyncStatus` 翻成界面文案。
 *
 * ## 为什么单独抽成纯函数
 *
 * 三种情况都要求「**说准**」，而它们很容易被写成一句笼统的「同步失败」：
 *
 * 1. **`key-rotated` 有指定文案**（§1.5 代价 2、第 2030 行）：
 *    「此设备的密钥已被轮换，请导入新密钥」。写成「同步失败」会让用户去查网络 ——
 *    而这条**只有他自己能解决**（重新导入密钥），所以要 `actionable: true`。
 * 2. **`offline` 与 `error` 不是一回事**：前者「等等就好」，后者要人管。
 * 3. **冲突数必须露出来**（§5.3 的「N 冲突」）：冲突是**只报不猜**的
 *    （引擎绝不动它们），所以用户不知道就等于永远不解决。
 *
 * 放在 `runner.ts` 旁边是为了让它和状态定义**一起改**：状态加了分支而文案没跟上，
 * 是那种「编译通过、界面空白」的错。
 */
export function describeSyncStatus(status: SyncStatus): SyncStatusText {
  switch (status.phase) {
    case "syncing":
      return { label: "同步中…", detail: null, tone: "busy", actionable: false };

    case "key-rotated":
      return {
        // ★ 这句是文档指定的，不要改写成「同步失败」。
        label: "此设备的密钥已被轮换",
        detail: "请导入新的账号密钥。",
        tone: "error",
        // 只有用户自己能解决 —— 状态栏要给他一个入口。
        actionable: true,
      };

    case "offline":
      return { label: "离线", detail: "网络恢复后会自动重试。", tone: "warn", actionable: false };

    case "error":
      return { label: "同步失败", detail: status.error, tone: "error", actionable: false };

    case "idle": {
      if (status.conflicts > 0) {
        return {
          label: `已同步（${status.conflicts} 处冲突）`,
          // 冲突是「只报不猜」的，引擎不会动它们 —— 所以要明确告诉用户去哪儿看。
          detail: "有内容两边都改过，需要你自己决定保留哪一份。",
          tone: "warn",
          actionable: true,
        };
      }
      return {
        label: status.lastSyncedAt === null ? "尚未同步" : "已同步",
        detail: null,
        tone: "idle",
        actionable: false,
      };
    }
  }
}
