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
import type { SyncStream } from "./stream";

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

/** 一个记录调用的假流。 */
function fakeStream() {
  const resume = vi.fn();
  const stop = vi.fn();
  const stream: SyncStream = { start: vi.fn(), stop, resume, phase: () => "open" };
  return { stream, resume, stop };
}

function make(overrides: { openStream?: () => SyncStream | null; syncOnStart?: boolean } = {}) {
  const runner = fakeRunner();
  const created: { stream: SyncStream; resume: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = [];
  let onSignal: ((cursor: string | null) => void) | null = null;

  const controller = createSyncController({
    runner: runner.runner,
    openStream: (handler) => {
      onSignal = handler;
      if (overrides.openStream) return overrides.openStream();
      const made = fakeStream();
      created.push(made);
      return made.stream;
    },
    ...(overrides.syncOnStart === undefined ? {} : { syncOnStart: overrides.syncOnStart }),
  });

  return {
    controller,
    ...runner,
    created,
    /** 模拟服务端推来一个信号。 */
    signal: (cursor: string | null = "42") => onSignal?.(cursor),
  };
}

/* ============================================================================
   启动
   ============================================================================ */

describe("§5.3 · 启动：先同步一轮，再订阅", () => {
  it("`start()` 触发一次 `startup` 同步并建流", () => {
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
   停止与回前台
   ============================================================================ */

describe("停止与回前台", () => {
  it("`stop()` 退订 + 停掉去抖", () => {
    const world = make();
    world.controller.start();
    world.controller.stop();
    expect(world.created[0]!.stop).toHaveBeenCalledOnce();
    expect(world.controller.subscribed()).toBe(false);
    expect((world.runner.dispose as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
  });

  it("★ 第 2032 行 · `resume()` 一定触发一次同步（**即使宿主根本没建流**）", () => {
    /*
     * 用户可能在后台待了很久，期间的变更**不会重放**（SSE 没有历史）。
     * 如果宿主没建流（`openStream` 返回 null），`stream?.resume()` 什么都不会做 ——
     * 所以这里**必须**再发一次请求，否则回前台之后什么都不发生。
     */
    const world = make({ openStream: () => null });
    world.controller.start();
    world.triggers.length = 0;
    world.controller.resume();
    expect(world.triggers).toEqual(["focus"]);
  });

  it("有流时 `resume()` 既叫醒流、也发一次请求", () => {
    const world = make();
    world.controller.start();
    world.triggers.length = 0;
    world.controller.resume();
    expect(world.created[0]!.resume).toHaveBeenCalledOnce();
    expect(world.triggers).toEqual(["focus"]);
  });

  it("`stop()` 之后 `resume()` 相当于重新开始（登出再登入）", () => {
    const world = make();
    world.controller.start();
    world.controller.stop();
    world.triggers.length = 0;
    world.controller.resume();
    expect(world.created).toHaveLength(2);
    expect(world.triggers).toEqual(["startup"]);
  });

  it("`syncNow()` 用 `manual` 触发（与自动触发区分得开，便于日志与诊断）", async () => {
    const world = make();
    await world.controller.syncNow();
    expect(world.triggers).toEqual(["manual"]);
  });
});
