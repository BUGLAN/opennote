/**
 * 同步调度的用例（`docs/执行-三端同步…` §5.3、§5.4 第 2 条、§1.5 代价 2）。
 *
 * 两组最要紧的断言：
 *
 * 1. **单飞**：多个触发源撞在一起时只跑一次（+ 一次合并的补跑），
 *    而不是并发跑两次 —— 并发同步会让两边都以为自己是第一个写的人。
 * 2. **「密钥已轮换」是独立状态**，不是「错误」的一种。归进错误会让用户去查网络。
 */
import { describe, expect, it, vi } from "vitest";
import { createSyncRunner, describeSyncStatus, statusForError, type SyncStatus } from "./runner";
import { SyncProviderError } from "./provider-types";
import type { SyncOnceResult } from "./engine";

/** 让微任务队列跑一轮（等 IIFE 走到下一个 `await`）。 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** 造一个最小的 `SyncOnceResult`（只填用例关心的字段）。 */
function result(overrides: Partial<SyncOnceResult> = {}): SyncOnceResult {
  return {
    pushed: 0,
    remoteDeleted: 0,
    pulled: 0,
    pushConflicts: [],
    conflicts: [],
    deleted: 0,
    suspendedDeletes: [],
    blockedDeletes: 0,
    deletionGuardMessage: null,
    resync: false,
    appliedPaths: [],
    unknownDids: [],
    ...overrides,
  } as SyncOnceResult;
}

/** 一个可以手动放行的 `syncOnce` 桩（用来制造「并发撞上」）。 */
function controllable() {
  let release: (() => void) | null = null;
  let calls = 0;
  const gate = () => new Promise<void>((resolve) => (release = resolve));
  let currentGate: Promise<void> | null = null;
  return {
    get calls() {
      return calls;
    },
    open() {
      release?.();
      release = null;
    },
    /** 每次调用都等一个闸门（用例自己决定什么时候放行）。 */
    syncOnce: async (): Promise<SyncOnceResult> => {
      calls += 1;
      currentGate = gate();
      await currentGate;
      return result();
    },
    get pending() {
      return currentGate !== null && release !== null;
    },
  };
}

/* ============================================================================
   ★ 单飞
   ============================================================================ */

describe("★ 单飞：多个触发源撞在一起时只跑一次", () => {
  it("★ 并发 `request()` **不会并发跑两次**：第一次 + 一次合并的补跑", async () => {
    /*
     * ⚠️ 我第一版这条断言写成「`syncOnce` 只被调一次」，**那是错的** ——
     * 正确的单飞语义是「进行中时合并 + **跑完补一次**」（trailing single-flight）：
     * 那三次请求是在第一次同步**进行中**到达的，而第一次同步可能开始于
     * 它们所代表的变更之前，所以补跑一次才是「不丢更新」。
     *
     * 我第一版还漏了放行第二次的闸门，于是用例挂到超时 ——
     * 超时掩盖了「断言写错」这件事（看起来像实现卡住了）。
     */
    const stub = controllable();
    const runner = createSyncRunner({ syncOnce: stub.syncOnce });

    const first = runner.request("manual");
    const second = runner.request("signal");
    const third = runner.request("focus");
    // 合并掉的那两次**立刻**返回 null（调用方只需要「同步过了」这个事实）。
    await expect(second).resolves.toBeNull();
    await expect(third).resolves.toBeNull();
    expect(stub.calls).toBe(1);

    stub.open(); // 放行第 1 次
    await settle();
    // 补跑一次 —— 但**只补一次**（三次请求不会变成三次补跑）。
    expect(stub.calls).toBe(2);
    stub.open(); // 放行补跑那次
    await expect(first).resolves.not.toBeNull();
    expect(stub.calls).toBe(2);
  });

  it("补跑只发生一次（排队 10 次请求不会变成 10 次同步）", async () => {
    const stub = controllable();
    const runner = createSyncRunner({ syncOnce: stub.syncOnce });

    const first = runner.request("manual");
    for (let index = 0; index < 10; index += 1) void runner.request("signal");
    stub.open();
    await settle();
    expect(stub.calls).toBe(2);
    stub.open();
    await first;
    await settle();
    // 补跑跑完之后**没有**第三次。
    expect(stub.calls).toBe(2);
  });

  it("跑完之后可以再跑（单飞不是「只跑一次」）", async () => {
    let calls = 0;
    const runner = createSyncRunner({
      syncOnce: async () => {
        calls += 1;
        return result();
      },
    });
    await runner.request("manual");
    await runner.request("manual");
    expect(calls).toBe(2);
  });
});

/* ============================================================================
   状态
   ============================================================================ */

describe("§5.3 · `StatusBar` 要的那几个状态", () => {
  it("初始 `idle`，跑完带 `lastSyncedAt` 与冲突数", async () => {
    const seen: SyncStatus[] = [];
    const runner = createSyncRunner({
      syncOnce: async () => result({ conflicts: [{ path: "a.md", kind: "both-modified", localId: "1", remoteId: "2" }] }),
      onStatus: (status) => void seen.push(status),
      now: () => 1000,
    });

    expect(runner.status()).toEqual({ phase: "idle", lastSyncedAt: null, conflicts: 0 });
    await runner.request("manual");

    expect(seen.map((status) => status.phase)).toEqual(["syncing", "idle"]);
    expect(runner.status()).toEqual({ phase: "idle", lastSyncedAt: 1000, conflicts: 1 });
  });

  it("★ **401 ⇒ `key-rotated`**（独立状态，不是 error）—— §1.5 代价 2", async () => {
    const runner = createSyncRunner({
      syncOnce: async () => {
        throw new SyncProviderError("rotated", "令牌无效", 401);
      },
    });
    await runner.request("manual");
    expect(runner.status().phase).toBe("key-rotated");
  });

  it("网络错误 ⇒ `offline`（「等等就好」与「服务端 500」对用户是两件事）", async () => {
    const runner = createSyncRunner({
      syncOnce: async () => {
        throw new SyncProviderError("network", "连不上同步服务", null);
      },
    });
    await runner.request("manual");
    expect(runner.status().phase).toBe("offline");
  });

  it("其它错误 ⇒ `error` 且带机器可读的 `code`（UI 依赖 code，不依赖文案）", async () => {
    const runner = createSyncRunner({
      syncOnce: async () => {
        throw new SyncProviderError("quota", "配额满了", 413);
      },
    });
    await runner.request("manual");
    expect(runner.status()).toMatchObject({ phase: "error", code: "quota" });
  });

  it("失败**不清掉** `lastSyncedAt`（用户仍需要知道「上次成功是什么时候」）", async () => {
    let shouldFail = false;
    const runner = createSyncRunner({
      now: () => 5000,
      syncOnce: async () => {
        if (shouldFail) throw new SyncProviderError("network", "断网", null);
        return result();
      },
    });
    await runner.request("manual");
    shouldFail = true;
    await runner.request("manual");
    expect(runner.status()).toMatchObject({ phase: "offline", lastSyncedAt: 5000 });
  });

  it("非 `SyncProviderError` 的异常也能翻成状态（不把异常漏给 UI）", () => {
    expect(statusForError(new Error("别的什么东西"), null)).toMatchObject({ phase: "error", code: "unknown" });
    expect(statusForError("字符串异常", null)).toMatchObject({ phase: "error", code: "unknown" });
  });
});

/* ============================================================================
   §5.4 第 2 条 · 按路径刷新
   ============================================================================ */

describe("§5.4 第 2 条 · 拉取落地之后**按路径**刷新", () => {
  it("有落地时把**具体路径**交给上层（不是 `rescanWorkspace` 那种 O(库) 的做法）", async () => {
    const applied: string[][] = [];
    const runner = createSyncRunner({
      syncOnce: async () => result({ appliedPaths: ["a.md", "notes/b.md"] }),
      onApplied: (paths) => void applied.push(paths),
    });
    await runner.request("manual");
    expect(applied).toEqual([["a.md", "notes/b.md"]]);
  });

  it("没有落地时**不调**（空数组也调一次会让上层白跑一轮索引重建）", async () => {
    const applied: string[][] = [];
    const runner = createSyncRunner({ syncOnce: async () => result(), onApplied: (paths) => void applied.push(paths) });
    await runner.request("manual");
    expect(applied).toEqual([]);
  });
});

/* ============================================================================
   本地写之后的去抖
   ============================================================================ */

describe("§5.3 · 本地写之后去抖推一次", () => {
  /** 一个可手动推进的定时器。 */
  function fakeTimers() {
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
      /** 跑掉当前排队的那个（模拟去抖到点）。 */
      flush() {
        const entry = queued.shift();
        entry?.fn();
      },
    };
  }

  it("连续多次本地写**只排一个**定时器（去抖，不是每次都排）", () => {
    const timers = fakeTimers();
    const runner = createSyncRunner({ syncOnce: async () => result(), ...timers, localWriteDebounceMs: 1200 });
    runner.scheduleAfterLocalWrite();
    runner.scheduleAfterLocalWrite();
    runner.scheduleAfterLocalWrite();
    expect(timers.queued).toHaveLength(1);
    expect(timers.queued[0]!.ms).toBe(1200);
  });

  it("到点之后真的跑一次同步", async () => {
    const timers = fakeTimers();
    let calls = 0;
    const runner = createSyncRunner({
      syncOnce: async () => {
        calls += 1;
        return result();
      },
      ...timers,
    });
    runner.scheduleAfterLocalWrite();
    timers.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
  });

  it("`dispose()` 之后不再跑（关工作区之后一个迟到的定时器不该还在同步）", async () => {
    const timers = fakeTimers();
    let calls = 0;
    const runner = createSyncRunner({
      syncOnce: async () => {
        calls += 1;
        return result();
      },
      ...timers,
    });
    runner.scheduleAfterLocalWrite();
    runner.dispose();
    // 定时器已经被清掉；就算有人手动放行，`request` 也不再干活。
    expect(timers.queued).toHaveLength(0);
    await runner.request("manual");
    expect(calls).toBe(0);
  });

  it("`dispose()` 之后再 `scheduleAfterLocalWrite()` 也不排定时器", () => {
    const timers = fakeTimers();
    const runner = createSyncRunner({ syncOnce: async () => result(), ...timers });
    runner.dispose();
    runner.scheduleAfterLocalWrite();
    expect(timers.queued).toHaveLength(0);
    void vi;
  });
});

/* ============================================================================
   §5.3 · 状态 → 界面文案
   ============================================================================ */

describe("§5.3 · 状态栏文案：三种「说准」", () => {
  it("★ `key-rotated` 用**文档指定的**文案，且标记为「需要用户动手」", () => {
    /*
     * §1.5 代价 2 与第 2030 行都要求 401 时给明确文案。写成「同步失败」会让用户
     * 去查网络 —— 而这条**只有他自己能解决**（重新导入密钥）。
     */
    const text = describeSyncStatus({ phase: "key-rotated", lastSyncedAt: null });
    expect(text.label).toContain("密钥已被轮换");
    expect(text.detail).toContain("导入新的账号密钥");
    // 状态栏据此决定要不要给一个可点的入口。
    expect(text.actionable).toBe(true);
    // 绝不能退化成一句笼统的「同步失败」。
    expect(text.label).not.toBe("同步失败");
  });

  it("★ `offline` 与 `error` **不是一回事**（前者等等就好，后者要人管）", () => {
    const offline = describeSyncStatus({ phase: "offline", error: "连不上", lastSyncedAt: null });
    const error = describeSyncStatus({ phase: "error", error: "配额满了", code: "quota", lastSyncedAt: null });
    expect(offline.label).toBe("离线");
    expect(offline.tone).toBe("warn");
    expect(error.label).toBe("同步失败");
    expect(error.tone).toBe("error");
    expect(offline.label).not.toBe(error.label);
  });

  it("★ 冲突数必须**露出来**（冲突是「只报不猜」的，不说就等于永远不解决）", () => {
    const none = describeSyncStatus({ phase: "idle", lastSyncedAt: 1, conflicts: 0 });
    const some = describeSyncStatus({ phase: "idle", lastSyncedAt: 1, conflicts: 3 });
    expect(none.label).toBe("已同步");
    expect(some.label).toContain("3");
    expect(some.actionable).toBe(true);
    expect(some.detail).toContain("自己决定");
  });

  it("从未同步过 ⇒ 说「尚未同步」（而不是「已同步」）", () => {
    expect(describeSyncStatus({ phase: "idle", lastSyncedAt: null, conflicts: 0 }).label).toBe("尚未同步");
  });

  it("同步中 ⇒ busy（界面据此转圈，且不该再给一个「立即同步」按钮）", () => {
    const text = describeSyncStatus({ phase: "syncing", startedAt: 1 });
    expect(text.label).toBe("同步中…");
    expect(text.tone).toBe("busy");
    expect(text.actionable).toBe(false);
  });

  it("每个状态都有文案（`switch` 没有漏分支）", () => {
    const all: SyncStatus[] = [
      { phase: "idle", lastSyncedAt: null, conflicts: 0 },
      { phase: "idle", lastSyncedAt: 1, conflicts: 1 },
      { phase: "syncing", startedAt: 1 },
      { phase: "offline", error: "x", lastSyncedAt: null },
      { phase: "key-rotated", lastSyncedAt: null },
      { phase: "error", error: "x", code: "server", lastSyncedAt: null },
    ];
    for (const status of all) {
      const text = describeSyncStatus(status);
      expect(text.label.length, status.phase).toBeGreaterThan(0);
    }
  });
});
