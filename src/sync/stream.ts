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
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  log?: (line: string) => void;
}

export interface SyncStream {
  start(): void;
  /** 主动断开并停止重连（关工作区 / 登出）。 */
  stop(): void;
  /** 从后台回前台（第 2032 行）：立刻**增量拉取**，并确保流是活的。 */
  resume(): void;
  phase(): StreamPhase;
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
    stream.addEventListener("ready", () => touch());
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

    resume() {
      /*
       * 第 2032 行：手机上从后台回前台要**立刻增量拉取**。
       *
       * 这里同时做两件事：① 触发一次信号（上层会立刻同步一轮）；
       * ② 如果流已经断了（后台期间大概率断了），把它重开。
       *
       * 为什么不能只靠「重开流」：重开之后要等服务端下一次 `_changes` 才有事件 ——
       * 而用户在后台期间错过的那些变更**不会重放**（SSE 没有历史）。
       * 所以必须主动拉一次。
       */
      if (stopped) {
        stopped = false;
        attempt = 0;
      }
      options.onSignal(null);
      if (stream === null) {
        if (retryTimer !== null) {
          clearTimer(retryTimer);
          retryTimer = null;
        }
        attempt = 0;
        connect();
      } else {
        touch();
      }
    },

    phase: () => phase,
  };
}
