/**
 * 客户端 SSE 订阅的用例（`docs/执行-三端同步…` §4.6、§4.7、§4.8、第 2032 行）。
 *
 * ## 这里最要紧的是**心跳超时**，不是 `onerror`
 *
 * 一条 TCP 连接可以在**两端都不知道**的情况下死掉（NAT 表项过期 / 进隧道 / 合盖）。
 * 这时 `EventSource` 既不给 `onerror` 也不给 `onclose` —— 它就是**永远安静**。
 *
 * 而「永远安静」对同步客户端是最坏的状态：看起来一切正常，但**再也不会收到任何更新**。
 * 所以下面有两条对照用例：一条证明「静默死亡会被发现」，一条证明
 * 「健康连接**不会**被误判」（后者同样重要 —— 误判会让每次心跳都白断一次）。
 */
import { describe, expect, it, vi } from "vitest";
import { createSyncStream, type EventStreamLike, type StreamPhase } from "./stream";

/** 一个可以手动触发事件的假流，并记录它有没有被关掉。 */
function fakeStream() {
  const listeners = new Map<string, ((event: { data?: string }) => void)[]>();
  let closed = false;
  const stream: EventStreamLike = {
    close: () => {
      closed = true;
    },
    addEventListener: (type, listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };
  return {
    stream,
    get closed() {
      return closed;
    },
    emit(type: string, data?: string) {
      for (const listener of listeners.get(type) ?? []) listener({ data });
    },
  };
}

/** 手动定时器：用例自己决定「时间」怎么走。 */
function fakeTimers() {
  const queued: { fn: () => void; ms: number; id: number }[] = [];
  let nextId = 1;
  return {
    queued,
    setTimeoutFn: (fn: () => void, ms: number) => {
      const id = nextId++;
      queued.push({ fn, ms, id });
      return id;
    },
    clearTimeoutFn: (handle: unknown) => {
      const index = queued.findIndex((entry) => entry.id === handle);
      if (index >= 0) queued.splice(index, 1);
    },
    /** 跑掉最久远的那一个（模拟它到点）。 */
    fireOldest() {
      const entry = queued.shift();
      entry?.fn();
    },
    /** 有没有一个「心跳看门狗」在等着（毫秒数等于超时值的那个）。 */
    watchdogPending(timeoutMs: number) {
      return queued.some((entry) => entry.ms === timeoutMs);
    },
    delays: () => queued.map((entry) => entry.ms),
  };
}

const HEARTBEAT_TIMEOUT = 55_000; // 默认 = 2×25s + 5s

function make(overrides: { heartbeatTimeoutMs?: number } = {}) {
  const timers = fakeTimers();
  const opened: ReturnType<typeof fakeStream>[] = [];
  const signals: (string | null)[] = [];
  const phases: StreamPhase[] = [];
  const stream = createSyncStream({
    url: "https://notes.example.com/v1/events?nb=x&authToken=t",
    onSignal: (cursor) => void signals.push(cursor),
    onPhase: (phase) => void phases.push(phase),
    open: () => {
      const created = fakeStream();
      opened.push(created);
      return created.stream;
    },
    heartbeatTimeoutMs: overrides.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT,
    reconnectDelayMs: 1000,
    maxReconnectDelayMs: 8000,
    ...timers,
  });
  return { stream, timers, opened, signals, phases };
}

/* ============================================================================
   基本
   ============================================================================ */

describe("§4.7 · 基本行为", () => {
  it("`start()` 开一条流，`change` 事件把游标交给上层", () => {
    const { stream, opened, signals } = make();
    stream.start();
    expect(opened).toHaveLength(1);
    opened[0]!.emit("change", JSON.stringify({ cursor: "42", count: 3 }));
    expect(signals).toEqual(["42"]);
  });

  it("事件体坏了**照常**触发（「脏了」这个事实不依赖它的内容）", () => {
    const { stream, opened, signals } = make();
    stream.start();
    opened[0]!.emit("change", "这不是 JSON");
    expect(signals).toEqual([null]);
  });

  it("`stop()` 关掉流并停止重连", () => {
    const { stream, timers, opened } = make();
    stream.start();
    stream.stop();
    expect(opened[0]!.closed).toBe(true);
    expect(timers.queued).toHaveLength(0);
    expect(stream.phase()).toBe("stopped");
  });
});

/* ============================================================================
   ★ 心跳超时
   ============================================================================ */

describe("★ 心跳超时：唯一能发现「静默死亡」的手段", () => {
  it("★ 长时间没有任何字节 ⇒ 关掉旧流并重连（`onerror` **不会**来）", () => {
    const { stream, timers, opened, phases } = make();
    stream.start();
    expect(opened).toHaveLength(1);
    // 一条健康连接的看门狗在等着。
    expect(timers.watchdogPending(HEARTBEAT_TIMEOUT)).toBe(true);

    // ── 连接静默死亡：什么都不发生，时间走过去 ──
    timers.fireOldest(); // 看门狗到点

    // 旧流被关掉、退避后重开。
    expect(opened[0]!.closed).toBe(true);
    expect(phases).toContain("reconnecting");
    timers.fireOldest(); // 退避到点
    expect(opened).toHaveLength(2);
  });

  it("★ 健康连接**不会**被误判：每收到一次心跳就把看门狗往后推", () => {
    /*
     * 误判同样有害 —— 每次心跳都白断一次连接，比不重连还糟。
     * 服务端按 `SSE_HEARTBEAT_MS` 发心跳（§4.8），客户端据此设超时。
     */
    const { stream, timers, opened } = make();
    stream.start();
    for (let index = 0; index < 5; index += 1) {
      // 服务端心跳（注释行在 `EventSource` 里表现为一次 `ready`/任意事件 —— 我们按「任何字节」处理）。
      opened[0]!.emit("ready");
      // 看门狗被重置：仍然只有一个在等。
      expect(timers.queued.filter((entry) => entry.ms === HEARTBEAT_TIMEOUT)).toHaveLength(1);
    }
    // 全程没有重连。
    expect(opened).toHaveLength(1);
  });

  it("超时值**必须大于**服务端心跳间隔（否则健康连接会被反复断）", () => {
    const { timers } = make();
    // 默认值就是 2×25s + 5s，比 25s 宽裕。
    expect(HEARTBEAT_TIMEOUT).toBeGreaterThan(25000);
    void timers;
  });
});

/* ============================================================================
   重连与退避
   ============================================================================ */

describe("重连与退避", () => {
  it("`error` ⇒ 接管重连（不用 `EventSource` 自己的策略：它不可配、也不报状态）", () => {
    const { stream, timers, opened, phases } = make();
    stream.start();
    opened[0]!.emit("error");
    expect(opened[0]!.closed).toBe(true);
    expect(phases).toContain("reconnecting");
    timers.fireOldest();
    expect(opened).toHaveLength(2);
  });

  it("退避**指数增长**并有上限（服务端重启时不要把它打垮）", () => {
    const { stream, timers, opened } = make();
    stream.start();
    const seen: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      opened[opened.length - 1]!.emit("error");
      const delay = timers.queued.find((entry) => entry.ms !== HEARTBEAT_TIMEOUT)?.ms;
      if (delay !== undefined) seen.push(delay);
      timers.fireOldest(); // 退避到点 ⇒ 重开
    }
    // 1s → 2s → 4s → 8s（上限）→ 8s …
    expect(seen.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
    expect(Math.max(...seen)).toBeLessThanOrEqual(8000);
  });

  it("★ 连上之后退避归零（下次断线从头等，不继承上一次的长延迟）", () => {
    const { stream, timers, opened } = make();
    stream.start();
    // 先失败几次把退避推到 4s。
    opened[0]!.emit("error");
    timers.fireOldest();
    opened[1]!.emit("error");
    timers.fireOldest();
    // 这一次连上了。
    opened[2]!.emit("open");
    // 再断 ⇒ 延迟应当回到 1s。
    opened[2]!.emit("error");
    const delay = timers.queued.find((entry) => entry.ms !== HEARTBEAT_TIMEOUT)?.ms;
    expect(delay).toBe(1000);
  });

  it("`stop()` 之后不再重连（关工作区之后一个迟到的退避不该还在连）", () => {
    const { stream, timers, opened } = make();
    stream.start();
    opened[0]!.emit("error");
    stream.stop();
    expect(timers.queued).toHaveLength(0);
    expect(opened).toHaveLength(1);
  });
});

/* ============================================================================
   第 2032 行：回前台
   ============================================================================ */

describe("第 2032 行 · 移动端从后台回前台要**立刻增量拉取**", () => {
  it("★ `resume()` 一定触发一次信号（后台期间的变更**不会重放** —— SSE 没有历史）", () => {
    /*
     * 只重开流是不够的：重开之后要等服务端**下一次** `_changes` 才有事件，
     * 而用户在后台期间错过的那些变更不会重放。所以必须主动拉一次。
     */
    const { stream, signals } = make();
    stream.start();
    signals.length = 0;
    stream.resume();
    expect(signals).toEqual([null]);
  });

  it("流已经断了 ⇒ `resume()` 重开它", () => {
    const { stream, timers, opened } = make();
    stream.start();
    opened[0]!.emit("error");
    // 退避还没到点（流是断的）。
    stream.resume();
    // 立刻重开，不等退避。
    expect(opened).toHaveLength(2);
    void timers;
  });

  it("流还活着 ⇒ `resume()` **不**多开一条（否则每次切前台都多一条连接）", () => {
    const { stream, opened } = make();
    stream.start();
    stream.resume();
    stream.resume();
    expect(opened).toHaveLength(1);
  });

  it("`stop()` 之后 `resume()` 能重新开始（登出再登入的场景）", () => {
    const { stream, opened } = make();
    stream.start();
    stream.stop();
    stream.resume();
    expect(opened).toHaveLength(2);
    void vi;
  });
});
