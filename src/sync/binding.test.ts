/**
 * 工作区 ↔ 同步绑定的用例（`docs/执行-三端同步…` §5.3、第 2032 行）。
 *
 * 最要紧的一组是**竞态**：`attach` 是异步的，而「当前是哪个工作区」可以在
 * 它还没回来的时候就变了。若那次迟到的结果被 `start()` 起来，
 * 就会有一个**没人能关掉**的同步在后台跑着。
 */
import { describe, expect, it } from "vitest";
import { createWorkspaceSyncBinding } from "./binding";
import type { AttachResult } from "./attach";
import type { SyncController } from "./controller";
import type { SyncSession } from "./session";
import type { SyncStatus } from "./runner";

/** 一个可观测的假 controller。 */
function fakeController() {
  const calls: string[] = [];
  const controller = {
    start: () => void calls.push("start"),
    stop: () => void calls.push("stop"),
    syncNow: async () => null,
    subscribed: () => false,
    status: (): SyncStatus => ({ phase: "idle", lastSyncedAt: null, conflicts: 0 }),
  } as unknown as SyncController;
  return { controller, calls };
}

/** 一个可以手动放行的 `attach`。 */
function deferredAttach() {
  const pending: { resolve: (result: AttachResult) => void }[] = [];
  return {
    pending,
    attach: () =>
      new Promise<AttachResult>((resolve) => {
        pending.push({ resolve });
      }),
    /** 放行第 index 个。 */
    release(index: number, result: AttachResult) {
      pending[index]!.resolve(result);
    },
  };
}

const ok = (controller: SyncController): AttachResult => ({
  ok: true,
  controller,
  // 绑定层只用 controller；session 是给上层（冲突裁决）的，这里给个占位。
  session: { runner: { scheduleAfterLocalWrite() {}, request: () => Promise.resolve(null) } } as unknown as SyncSession,
});

/* ============================================================================
   ★ 竞态
   ============================================================================ */

describe("★ attach 是异步的 ⇒ 迟到的结果必须被丢弃", () => {
  it("★ `stop()` 之后 attach 才回来 ⇒ **不 start**，而且把它收干净", async () => {
    /*
     * 没有这条：A 的同步会在后台跑着，而界面显示的是 B。用户看不到它、也关不掉它，
     * 直到下次切回 A 才发现「怎么一直在同步」。手机上那是持续的耗电与流量。
     */
    const deferred = deferredAttach();
    const made = fakeController();
    const binding = createWorkspaceSyncBinding({ attach: deferred.attach });

    const starting = binding.start();
    expect(binding.phase()).toBe("attaching");
    binding.stop();
    deferred.release(0, ok(made.controller));
    await starting;

    // 从没被 start 过。
    expect(made.calls).not.toContain("start");
    // 而且被 stop 收干净了（否则它会一直跑着而没人能关掉）。
    expect(made.calls).toContain("stop");
    expect(binding.controller()).toBeNull();
    expect(binding.phase()).toBe("idle");
  });

  it("★ 停掉又**立刻**重新开始 ⇒ 第一次的迟到结果仍然作废（用代次，不是布尔量）", async () => {
    /*
     * 这是布尔量会误判的那个场景：`running` 被新那一轮设成了 true，
     * 于是第一次的 attach 回来时**误以为自己是当前的**。
     */
    const deferred = deferredAttach();
    const first = fakeController();
    const second = fakeController();
    const binding = createWorkspaceSyncBinding({ attach: deferred.attach });

    const startingA = binding.start();
    binding.stop();
    const startingB = binding.start();

    // 先放行**第一次**（迟到的那个）。
    deferred.release(0, ok(first.controller));
    await startingA;
    expect(first.calls).not.toContain("start");

    // 再放行第二次（当前那个）。
    deferred.release(1, ok(second.controller));
    await startingB;
    expect(second.calls).toContain("start");
    expect(binding.phase()).toBe("attached");
  });

  it("正常路径：attach 回来 ⇒ `start()` 并进入 attached", async () => {
    const deferred = deferredAttach();
    const made = fakeController();
    const binding = createWorkspaceSyncBinding({ attach: deferred.attach });
    const starting = binding.start();
    deferred.release(0, ok(made.controller));
    await starting;
    expect(made.calls).toContain("start");
    expect(binding.phase()).toBe("attached");
    expect(binding.controller()).toBe(made.controller);
  });
});

/* ============================================================================
   接不上的情况
   ============================================================================ */

describe("接不上时要说清「为什么」", () => {
  it("`ok: false` ⇒ `skipped` 并把原因露出来", async () => {
    const deferred = deferredAttach();
    const binding = createWorkspaceSyncBinding({ attach: deferred.attach });
    const starting = binding.start();
    deferred.release(0, { ok: false, reason: "no-account-key", message: "还没导入密钥" });
    await starting;
    expect(binding.phase()).toBe("skipped");
    expect(binding.reason()).toBe("no-account-key");
    expect(binding.controller()).toBeNull();
  });

  it("★ `attach` **抛**（真的意外，例如 E2EE 缺密钥）⇒ 不崩，回到 idle", async () => {
    const binding = createWorkspaceSyncBinding({
      attach: async () => {
        throw new Error("这个笔记本是加密的，但这台设备还没有它的密钥");
      },
    });
    await expect(binding.start()).resolves.toBeUndefined();
    expect(binding.phase()).toBe("idle");
    binding.stop();
  });

  it("`skipped` 之后再 `start()` 能重试（用户导入密钥之后）", async () => {
    const deferred = deferredAttach();
    const made = fakeController();
    const binding = createWorkspaceSyncBinding({ attach: deferred.attach });
    const first = binding.start();
    deferred.release(0, { ok: false, reason: "no-account-key", message: "x" });
    await first;
    expect(binding.phase()).toBe("skipped");

    const second = binding.start();
    deferred.release(1, ok(made.controller));
    await second;
    expect(binding.phase()).toBe("attached");
  });
});

describe("★ attach 抛错之后自动重新接上", () => {
  function manualTimers() {
    const queued: { fn: () => void; ms: number }[] = [];
    return {
      queued,
      setTimeoutFn: (fn: () => void, ms: number) => {
        const entry = { fn, ms };
        queued.push(entry);
        return entry;
      },
      clearTimeoutFn: (handle: unknown) => {
        const index = queued.indexOf(handle as { fn: () => void; ms: number });
        if (index >= 0) queued.splice(index, 1);
      },
    };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("★ 开机时离线（解锁请求失败）⇒ 退避后再试，网络回来就接上", async () => {
    const timers = manualTimers();
    const made = fakeController();
    let calls = 0;
    const binding = createWorkspaceSyncBinding({
      attach: async () => {
        calls += 1;
        if (calls < 3) throw new Error("fetch failed");
        return ok(made.controller);
      },
      ...timers,
      retryBaseDelayMs: 1000,
    });
    await binding.start();
    expect(binding.phase()).toBe("idle");
    expect(timers.queued.map((t) => t.ms)).toEqual([1000]);
    timers.queued.shift()!.fn();
    await settle();
    expect(timers.queued.map((t) => t.ms)).toEqual([2000]);
    timers.queued.shift()!.fn();
    await settle();
    expect(binding.phase()).toBe("attached");
    expect(made.calls).toEqual(["start"]);
    expect(timers.queued).toHaveLength(0);
  });

  it("`stop()` 取消挂着的重试（关掉工作区之后不该再偷偷接上）", async () => {
    const timers = manualTimers();
    let calls = 0;
    const binding = createWorkspaceSyncBinding({
      attach: async () => {
        calls += 1;
        throw new Error("fetch failed");
      },
      ...timers,
    });
    await binding.start();
    expect(timers.queued).toHaveLength(1);
    binding.stop();
    expect(timers.queued).toHaveLength(0);
    expect(calls).toBe(1);
  });
});
