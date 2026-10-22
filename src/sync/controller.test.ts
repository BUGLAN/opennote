/**
 * 同步控制器的用例（`docs/执行-三端同步…` §5.3、§5.4、第 2032 行）。
 *
 * 这里验的是**接线**：谁在什么时候被调用、调用了几次。
 * 单飞/退避/超时的内部行为已经在 `runner.test.ts` 与 `stream.test.ts` 里验过，
 * 所以这里的桩只需要记录调用。
 */
import { describe, expect, it, vi } from "vitest";
import { createSyncController } from "./controller";
import type { SyncRunner, SyncStatus } from "./runner";
import type { StreamPhase, SyncStream } from "./stream";

/** 一个记录触发的假调度器。 */
function fakeRunner() {
  const triggers: string[] = [];
  const runner = {
    status: (): SyncStatus => ({ phase: "idle", lastSyncedAt: null, conflicts: 0 }),
    request: async (trigger: string) => {
      triggers.push(trigger);
      return null;
    },
    scheduleAfterLocalWrite: () => undefined,
    dispose: vi.fn(),
  } as unknown as SyncRunner;
  return { runner, triggers };
}

/**
 * 一个记录调用的假流。
 *
 * `reconciles` 决定它会不会在连上时比对游标 —— 那正是「启动要不要无条件拉一轮」的分水岭，
 * 所以它必须是**可配的**，而不是写死一个值。
 */
function fakeStream(options: { reconciles?: boolean; phase?: StreamPhase } = {}) {
  const reconciles = options.reconciles === true;
  const stop = vi.fn();
  let phase: StreamPhase = options.phase ?? "open";
  const stream: SyncStream = {
    start: vi.fn(),
    stop,
    phase: () => phase,
    reconcilesCursor: () => reconciles,
  };
  return { stream, stop, setPhase: (next: StreamPhase) => void (phase = next) };
}

function make(
  overrides: {
    openStream?: () => SyncStream | null;
    syncOnStart?: boolean;
    reconciles?: boolean;
    phase?: StreamPhase;
  } = {},
) {
  /** 手动定时器：用例自己决定「兜底超时」什么时候到点。 */
  const timers: { fn: () => void; ms: number }[] = [];
  const runner = fakeRunner();
  const created: { stream: SyncStream; stop: ReturnType<typeof vi.fn> }[] = [];
  let onSignal: ((cursor: string | null) => void) | null = null;
  let onUpToDate: (() => void) | null = null;

  const controller = createSyncController({
    runner: runner.runner,
    openStream: (handler, upToDate) => {
      onSignal = handler;
      onUpToDate = upToDate;
      if (overrides.openStream) return overrides.openStream();
      const made = fakeStream({
        reconciles: overrides.reconciles === true,
        ...(overrides.phase === undefined ? {} : { phase: overrides.phase }),
      });
      created.push(made);
      return made.stream;
    },
    ...(overrides.syncOnStart === undefined ? {} : { syncOnStart: overrides.syncOnStart }),
    setTimeoutFn: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return timers.length - 1;
    },
    clearTimeoutFn: () => undefined,
  });

  return {
    controller,
    ...runner,
    created,
    /** 模拟服务端推来一个信号。 */
    signal: (cursor: string | null = "42") => onSignal?.(cursor),
    /** 模拟「连上后核对：已经是最新」。 */
    upToDate: () => onUpToDate?.(),
    /** 让所有已排队的定时器到点。 */
    fireTimers: () => {
      const queued = timers.splice(0, timers.length);
      for (const timer of queued) timer.fn();
    },
    timers,
  };
}

/* ============================================================================
   启动
   ============================================================================ */

describe("§5.3 · 启动：流能比对游标时不先拉，不能比时才无条件拉", () => {
  it("★ 流会在连上时比对游标 ⇒ **一个请求都不发**（没变化就什么都不该跑）", () => {
    /*
     * 这是「打开应用」应有的成本：连上 → 服务端发 `ready`（带游标）→
     * `stream.ts` 拿它和本机记的比一比 → 一样就什么都不做。
     * 以前这里是**无条件**一轮（实测 2 个请求、约 650ms），哪怕什么都没变。
     */
    const world = make({ reconciles: true });
    world.controller.start();
    expect(world.triggers).toEqual([]);
    expect(world.created).toHaveLength(1);
    expect(world.controller.subscribed()).toBe(true);
  });

  it("流不会比对游标（没有游标存储）⇒ 仍然无条件拉一轮", () => {
    const world = make();
    world.controller.start();
    expect(world.triggers).toEqual(["startup"]);
    expect(world.created).toHaveLength(1);
    expect(world.controller.subscribed()).toBe(true);
  });

  it("`syncOnStart: false` 时不先拉（有些宿主想等用户动作）", () => {
    const world = make({ syncOnStart: false });
    world.controller.start();
    expect(world.triggers).toEqual([]);
    expect(world.created).toHaveLength(1);
  });

  it("重复 `start()` **不会**多订阅一条（React 严格模式会调两次）", () => {
    const world = make();
    world.controller.start();
    world.controller.start();
    expect(world.created).toHaveLength(1);
    expect(world.triggers).toEqual(["startup"]);
  });

  it("宿主不订阅实时（`openStream` 返回 null）也能用", () => {
    const world = make({ openStream: () => null });
    world.controller.start();
    expect(world.triggers).toEqual(["startup"]);
    expect(world.controller.subscribed()).toBe(false);
  });
});

/* ============================================================================
   信号 → 同步
   ============================================================================ */

describe("§4.6 · 远端信号变成一次同步触发", () => {
  it("流推来信号 ⇒ `runner.request(\"signal\")`", () => {
    const world = make();
    world.controller.start();
    world.signal("42");
    world.signal("43");
    expect(world.triggers).toEqual(["startup", "signal", "signal"]);
  });

  it("★ 控制器**不**自己判「值不值得」—— 重复触发交给单飞合并", () => {
    /*
     * 在这里再加一层「去重」会变成**第二份**合并逻辑，而两份迟早不一致
     * （例如一处的窗口是 500ms、另一处是 1s）。所以这里只负责转发。
     */
    const world = make();
    world.controller.start();
    for (let index = 0; index < 5; index += 1) world.signal();
    // 五次信号 ⇒ 五次 `request`（单飞在 runner 里合并，不在这里）。
    expect(world.triggers.filter((trigger) => trigger === "signal")).toHaveLength(5);
  });
});

/* ============================================================================
   停止
   ============================================================================ */

describe("停止", () => {
  it("`stop()` 退订 + 停掉去抖", () => {
    const world = make();
    world.controller.start();
    world.controller.stop();
    expect(world.created[0]!.stop).toHaveBeenCalledOnce();
    expect(world.controller.subscribed()).toBe(false);
    expect((world.runner.dispose as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
  });

  it("`syncNow()` 用 `manual` 触发（与自动触发区分得开，便于日志与诊断）", async () => {
    const world = make();
    await world.controller.syncNow();
    expect(world.triggers).toEqual(["manual"]);
  });
});
describe("连上后核对为最新：不跑同步，但状态要跟上", () => {
  it("★ `onUpToDate` ⇒ 调用 `runner.noteUpToDate()`，**不发**同步请求", () => {
    /*
     * 跳过同步是「0 个请求」的来源，但状态栏不能因此停在「尚未同步」——
     * 我们刚刚确实和服务端核对过，内容也一致。
     */
    const world = make({ reconciles: true });
    const note = vi.fn();
    (world.runner as unknown as { noteUpToDate: () => void }).noteUpToDate = note;
    world.controller.start();
    world.upToDate();
    expect(note).toHaveBeenCalledOnce();
    expect(world.triggers).toEqual([]);
  });
});

describe("兜底：流连不上时不能干等着", () => {
  it("★ 流一直没连上 ⇒ 超时后补一轮 startup（否则打开应用什么都不发生）", () => {
    /*
     * 「跳过启动同步」的依据只有一条：流会发来 `ready` 让我们比游标。
     * 流连不上（被代理拦 / 服务端挂了 / 旧 preload 的 EventSource 被 CSP 拦）时
     * `ready` 永远不来 —— 没有这道兜底，用户只能手点同步。
     */
    const world = make({ reconciles: true, phase: "connecting" });
    world.controller.start();
    expect(world.triggers).toEqual([]);

    world.fireTimers();
    expect(world.triggers).toEqual(["startup"]);
  });

  it("流已经连上 ⇒ 超时什么都不做（不白跑一轮）", () => {
    const world = make({ reconciles: true, phase: "open" });
    world.controller.start();
    world.fireTimers();
    expect(world.triggers).toEqual([]);
  });

  it("`stop()` 之后兜底不再触发（关掉工作区别在后台偷偷同步）", () => {
    const world = make({ reconciles: true, phase: "connecting" });
    world.controller.start();
    world.controller.stop();
    world.fireTimers();
    expect(world.triggers).toEqual([]);
  });
});
