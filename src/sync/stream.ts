/**
 * 客户端侧的 SSE 订阅（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §4.6、§4.7、第 2032 行）。
 *
 * ## 它只做一件事：把「远端脏了」变成一个回调
 *
 * 收到事件之后**不在这里同步** —— 它调 `onSignal()`，由上层交给 `runner.request("signal")`。
 * 这样单飞、状态、去抖都还只有一份实现（`runner.ts`）。
 *
 * ## ★ 这里最要紧的是「**心跳超时**」而不是 `onerror`
 *
 * 一条 TCP 连接可以在**两端都不知道**的情况下死掉：NAT/防火墙的表项过期、
 * 手机进了隧道、笔记本合盖。这时 `EventSource` 既不会触发 `onerror`、也不会 `onclose` ——
 * 它就是**永远安静**。
 *
 * 而「永远安静」对一个同步客户端是最坏的状态：它看起来一切正常，
 * 但**再也不会收到任何更新**。用户会以为「同步坏了」，而我们没有任何报错可查。
 *
 * 所以服务端按 `SSE_HEARTBEAT_MS`（默认 25s）发心跳（§4.8），
 * 而客户端必须**据此设一个超时**：超过 `heartbeatTimeoutMs` 没有任何字节 ⇒
 * 认定这条连接死了，主动重连。**这是唯一能发现「静默死亡」的手段。**
 *
 * ## 桌面端走主进程（§5.5）
 *
 * 桌面 CSP 不放 https，所以渲染层**连不上** `/v1/events`。
 * 那里的订阅由主进程建、把「脏了」的信号通过 IPC 转给渲染层。
 * 本模块把「怎么开一条流」做成注入的（`open`），于是两种宿主共用同一套
 * 重连/超时/退避逻辑 —— 而**那段逻辑才是容易写错的部分**。
 */

/** `EventSource` 里我们用到的那一小块。 */
export interface EventStreamLike {
  close(): void;
  addEventListener(type: string, listener: (event: { data?: string }) => void): void;
}

export type StreamPhase = "idle" | "connecting" | "open" | "reconnecting" | "stopped";

export interface SyncStreamOptions {
  /** 完整的 `/v1/events` URL（**令牌在查询串里** —— `EventSource` 不能设置请求头）。 */
  url: string;
  /** 收到「远端脏了」的信号（参数是远端游标，可能为 null）。 */
  onSignal: (cursor: string | null) => void;
  onPhase?: (phase: StreamPhase) => void;
  /** 开一条流（注入：网页/移动用 `EventSource`，桌面走主进程）。 */
  open: (url: string) => EventStreamLike;
  /**
   * 多久没收到**任何字节**就认定连接死了。
   *
   * 默认 = `2 × 心跳间隔 + 5s` 余量。**必须大于服务端的心跳间隔**，
   * 否则会在健康的连接上反复重连（那比不重连还糟：每次都白断一次）。
   */
  heartbeatTimeoutMs?: number;
  /** 重连的基础延迟（指数增长，带上限）。默认 1000ms。 */
  reconnectDelayMs?: number;
  /** 重连延迟上限。默认 30000ms。 */
  maxReconnectDelayMs?: number;
  /**
   * 本机**上一次同步到达的游标**（没有就 `null`）。
   *
   * 给了它，这里就在**每次连上**时把服务端的 `ready.cursor` 和它比一比：
   * 一样 ⇒ 什么都不做（打开应用 0 个请求）；不一样 ⇒ 发一次信号去补。
   *
   * ## 为什么这比「打开就同步一轮」「回前台就同步一轮」都好
   *
   * 那两条都是**无条件**的：没变化也白跑一轮（实测 2 个请求、约 650ms）。
   * 而「连上时比游标」恰好是**唯一需要**同步的时刻：
   * - 冷启动：离线期间别人改过 → 游标不同 → 补；
   * - 睡觉/断网后重连：连接是被静默掐死的，重连时游标不同 → 补；
   * - 什么都没发生：游标相同 → 一个请求都不发。
   *
   * 不给它（没有游标存储的宿主）就退回旧行为：`ready` 只喂看门狗，由上层
   * 自己决定要不要无条件拉一轮（见 `controller.ts` 的 `reconcilesCursor()`）。
   */
  knownCursor?: () => string | null;
  /**
   * 连上之后**核对为最新**（游标一致，没有触发同步）。
   *
   * 上层据此把「上次同步时间」推到现在 —— 否则状态栏会停在「尚未同步」，
   * 而我们其实刚刚确认过他确实是最新的。
   */
  onUpToDate?: (cursor: string) => void;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  log?: (line: string) => void;
}

export interface SyncStream {
  start(): void;
  /** 主动断开并停止重连（关工作区 / 登出）。 */
  stop(): void;
  phase(): StreamPhase;
  /**
   * 它会不会在**连上时比对游标**（`knownCursor` 给了才会）。
   *
   * `controller` 据此决定还要不要无条件跑一轮 startup：
   * 能比对就不必白跑（连上那一刻会自己判断落后没落后）；
   * 不能比对就必须无条件拉，否则离线期间的变更永远补不上。
   */
  reconcilesCursor(): boolean;
}

/** 服务端心跳的默认间隔（`SSE_HEARTBEAT_MS`），用来推默认超时。 */
export const DEFAULT_HEARTBEAT_MS = 25000;

export function createSyncStream(options: SyncStreamOptions): SyncStream {
  const setTimer = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const baseDelay = options.reconnectDelayMs ?? 1000;
  const maxDelay = options.maxReconnectDelayMs ?? 30000;
  // ★ 必须**大于**服务端心跳间隔，否则会在健康连接上反复重连。
  const heartbeatTimeout = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_MS * 2 + 5000;

  let phase: StreamPhase = "idle";
  let stream: EventStreamLike | null = null;
  let watchdog: unknown = null;
  let retryTimer: unknown = null;
  let attempt = 0;
  let stopped = true;

  const publish = (next: StreamPhase): void => {
    phase = next;
    options.onPhase?.(next);
  };

  const clearWatchdog = (): void => {
    if (watchdog !== null) {
      clearTimer(watchdog);
      watchdog = null;
    }
  };

  /** 每次收到**任何**字节就重置看门狗 —— 心跳也是字节。 */
  const touch = (): void => {
    clearWatchdog();
    watchdog = setTimer(() => {
      /*
       * ★ 走到这里意味着「超时了还没等到任何东西」。
       * 连接可能**在两端都不知道的情况下**死了（NAT 过期 / 进隧道 / 合盖），
       * 而 `EventSource` 不会给我们任何回调。所以只能自己判。
       */
      options.log?.(`[stream] ${heartbeatTimeout}ms 没有任何字节，认定连接已死，重连`);
      teardown();
      scheduleReconnect();
    }, heartbeatTimeout);
  };

  const teardown = (): void => {
    clearWatchdog();
    if (stream) {
      try {
        stream.close();
      } catch {
        /* 已经关了 */
      }
      stream = null;
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped) return;
    // 指数退避 + 上限（服务端重启时不要把它打垮）。
    const delay = Math.min(baseDelay * 2 ** attempt, maxDelay);
    attempt += 1;
    publish("reconnecting");
    options.log?.(`[stream] ${delay}ms 后重连（第 ${attempt} 次）`);
    retryTimer = setTimer(() => {
      retryTimer = null;
      connect();
    }, delay);
  };

  const connect = (): void => {
    if (stopped) return;
    publish(attempt === 0 ? "connecting" : "reconnecting");
    try {
      stream = options.open(options.url);
    } catch (error) {
      options.log?.(`[stream] 开流失败：${String(error)}`);
      scheduleReconnect();
      return;
    }
    touch();

    stream.addEventListener("open", () => {
      // 连上了 ⇒ 退避计数归零（下次断线从头开始等，不继承上一次的长延迟）。
      attempt = 0;
      publish("open");
      touch();
    });
    stream.addEventListener("ready", (event) => {
      touch();
      /*
       * ★ 连上就**比游标**：落后才补，没落后一个请求都不发。
       *
       * 这是「打开应用 / 睡觉醒来 / 断网恢复」三种情况的**统一入口** ——
       * 它们本质上是同一件事：此刻服务端的位置与本机记的位置是否一致。
       * 以前靠「启动先拉一轮」和「回前台再拉一轮」兜，那是无条件开销；
       * 而 `knownCursor` 没给时（没有游标存储）这里什么都不做，由上层自己决定。
       */
      if (options.knownCursor) {
        let remote: string | null = null;
        try {
          const parsed = JSON.parse(event.data ?? "{}") as { cursor?: unknown };
          remote = typeof parsed.cursor === "string" ? parsed.cursor : null;
        } catch {
          remote = null;
        }
        const local = options.knownCursor();
        if (remote === null) {
          // 服务端没给游标：无从判断，交给上层按旧规矩处理（宁可多拉一次）。
        } else if (remote !== local) {
          options.log?.(`[stream] 连上后发现落后（本地 ${local ?? "无"}，远端 ${remote}），补一轮`);
          options.onSignal(remote);
        } else {
          options.log?.(`[stream] 连上后核对：已是最新（游标 ${remote}），跳过同步`);
          options.onUpToDate?.(remote);
        }
      }
    });
    /*
     * 心跳（服务端每 `SSE_HEARTBEAT_MS` 发一次）。
     *
     * 它只用来**喂看门狗**：安静的笔记本 25 秒没有变更是常态，没有这一条，
     * 客户端会在 55 秒时把一条健康的连接判死并重连一次（每次都白断一次）。
     */
    stream.addEventListener("heartbeat", () => touch());
    stream.addEventListener("change", (event) => {
      touch();
      let cursor: string | null = null;
      try {
        const parsed = JSON.parse(event.data ?? "{}") as { cursor?: unknown };
        cursor = typeof parsed.cursor === "string" ? parsed.cursor : null;
      } catch {
        // 事件体坏了不影响「脏了」这个事实 —— 照常触发同步。
        cursor = null;
      }
      options.onSignal(cursor);
    });
    stream.addEventListener("error", () => {
      /*
       * `EventSource` 的 `error` 在**自动重连**时也会触发，所以不能当成「永久失败」。
       * 我们一律自己接管：关掉它、退避、重开 —— 这样网页/移动/桌面三种宿主
       * 的重连行为完全一致（`EventSource` 自己的重连策略不可配、也不报状态）。
       */
      options.log?.("[stream] 出错，接管重连");
      teardown();
      scheduleReconnect();
    });
  };

  return {
    reconcilesCursor: () => typeof options.knownCursor === "function",

    start() {
      if (!stopped) return;
      stopped = false;
      attempt = 0;
      connect();
    },

    stop() {
      stopped = true;
      if (retryTimer !== null) {
        clearTimer(retryTimer);
        retryTimer = null;
      }
      teardown();
      publish("stopped");
    },

    phase: () => phase,
  };
}