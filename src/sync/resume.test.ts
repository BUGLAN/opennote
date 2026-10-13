/**
 * 「回到前台」来源的用例（`docs/执行-三端同步…` 第 2032 行、第 1448 行）。
 *
 * 最要紧的两条：
 * - **切到后台不算「回来了」**（两个信号源都会在切走时触发，判错会让同步在后台跑）；
 * - **去重**（同一动作两个源都会报，不去重就白跑一轮列树）。
 */
import { describe, expect, it, vi } from "vitest";
import { createResumeSource, resolveResumeSource, type CapacitorAppLike, type DocumentLike } from "./resume";

/** 一个可以手动触发的假 Capacitor。 */
function fakeCapacitor(options: { fail?: boolean; promise?: boolean } = {}) {
  const listeners: ((state: { isActive: boolean }) => void)[] = [];
  const removed: number[] = [];
  const capacitor = {
    addListener: (_event: string, listener: (state: { isActive: boolean }) => void) => {
      if (options.fail) throw new Error("插件不在");
      listeners.push(listener);
      const handle = { remove: () => void removed.push(listeners.length) };
      return options.promise ? Promise.resolve(handle) : handle;
    },
  } as unknown as CapacitorAppLike;
  return { capacitor, listeners, removed, emit: (isActive: boolean) => listeners.forEach((listener) => listener({ isActive })) };
}

/** 一个可以手动触发的假 document。 */
function fakeDocument(initial: string = "visible") {
  const listeners: (() => void)[] = [];
  let state = initial;
  const doc = {
    get visibilityState() {
      return state;
    },
    addEventListener: (_type: string, listener: () => void) => void listeners.push(listener),
    removeEventListener: (_type: string, listener: () => void) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
  } as unknown as DocumentLike;
  return {
    doc,
    emit: (next: string) => {
      state = next;
      listeners.forEach((listener) => listener());
    },
    listenerCount: () => listeners.length,
  };
}

/** 手动时钟（去重窗口用）。 */
function fakeClock() {
  let current = 1_000_000;
  const timers: { fn: () => void; at: number }[] = [];
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    setTimeoutFn: (fn: () => void, ms: number) => {
      timers.push({ fn, at: current + ms });
      return timers.length;
    },
    clearTimeoutFn: () => undefined,
    timers,
  };
}

/* ============================================================================
   ★ 只认「回来了」
   ============================================================================ */

describe("★ 只在**回到前台**时报，切走时不报", () => {
  it("`appStateChange` 的 `isActive: true` ⇒ 报", () => {
    const capacitor = fakeCapacitor();
    const seen: string[] = [];
    createResumeSource({ capacitor: capacitor.capacitor }).subscribe(() => void seen.push("x"));
    capacitor.emit(true);
    expect(seen).toEqual(["x"]);
  });

  it("★ `isActive: false`（切到后台）⇒ **不报**（判错会让同步在后台跑）", () => {
    const capacitor = fakeCapacitor();
    const seen: string[] = [];
    createResumeSource({ capacitor: capacitor.capacitor }).subscribe(() => void seen.push("x"));
    capacitor.emit(false);
    expect(seen).toEqual([]);
  });

  it("`visibilitychange` 只在 `visible` 时报", () => {
    const doc = fakeDocument("hidden");
    const seen: string[] = [];
    createResumeSource({ document: doc.doc }).subscribe(() => void seen.push("x"));
    doc.emit("hidden"); // 还在隐藏
    expect(seen).toEqual([]);
    doc.emit("visible");
    expect(seen).toEqual(["x"]);
  });
});

/* ============================================================================
   ★ 去重
   ============================================================================ */

describe("★ 去重：两个信号源报同一件事时只算一次", () => {
  it("同一动作两个源都报 ⇒ 只回调一次", () => {
    /*
     * 手机 App 里 `appStateChange` 与 `visibilitychange` **可能同时触发**。
     * 不去重就会白跑一轮列树（单飞能合并掉并发，但这里是**先后**两次，会跑两轮）。
     */
    const capacitor = fakeCapacitor();
    const doc = fakeDocument("hidden");
    const clock = fakeClock();
    const seen: string[] = [];
    createResumeSource({ capacitor: capacitor.capacitor, document: doc.doc, dedupeMs: 500, now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn }).subscribe(() => void seen.push("x"));

    capacitor.emit(true);
    clock.advance(100);
    doc.emit("visible");
    expect(seen).toEqual(["x"]);
  });

  it("窗口过了之后**再**回来还是要报（不能因为去过一次就永远不报）", () => {
    const capacitor = fakeCapacitor();
    const clock = fakeClock();
    const seen: string[] = [];
    createResumeSource({ capacitor: capacitor.capacitor, dedupeMs: 500, now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn }).subscribe(() => void seen.push("x"));

    capacitor.emit(true);
    clock.advance(5000); // 用户用了一会儿
    capacitor.emit(true);
    expect(seen).toEqual(["x", "x"]);
  });
});

/* ============================================================================
   退化与退订
   ============================================================================ */

describe("退化与退订", () => {
  it("Capacitor 抛（插件不在）⇒ 不崩，`visibilitychange` 仍然工作", () => {
    const capacitor = fakeCapacitor({ fail: true });
    const doc = fakeDocument("hidden");
    const seen: string[] = [];
    createResumeSource({ capacitor: capacitor.capacitor, document: doc.doc }).subscribe(() => void seen.push("x"));
    doc.emit("visible");
    expect(seen).toEqual(["x"]);
  });

  it("两个源都没有 ⇒ 订阅是空操作（不崩）", () => {
    const dispose = createResumeSource({}).subscribe(() => undefined);
    expect(() => dispose()).not.toThrow();
  });

  it("退订之后不再报，且真的把监听摘了", () => {
    const doc = fakeDocument("hidden");
    const seen: string[] = [];
    const dispose = createResumeSource({ document: doc.doc }).subscribe(() => void seen.push("x"));
    expect(doc.listenerCount()).toBe(1);
    dispose();
    expect(doc.listenerCount()).toBe(0);
    doc.emit("visible");
    expect(seen).toEqual([]);
  });

  it("★ `addListener` 返回 Promise 时，退订要等它 resolve 再 `remove()`", async () => {
    // 真实 Capacitor 的 `addListener` 是异步的 —— 直接当同步对象用会拿到一个 Promise，
    // 于是「摘监听」静默失败（监听一直挂着，每切一次前台多报一次）。
    const capacitor = fakeCapacitor({ promise: true });
    const dispose = createResumeSource({ capacitor: capacitor.capacitor }).subscribe(() => undefined);
    dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(capacitor.removed).toHaveLength(1);
    void vi;
  });

  it("`resolveResumeSource()` 在 node 环境里也能建（没有 `document`）", () => {
    const source = resolveResumeSource();
    const dispose = source.subscribe(() => undefined);
    expect(() => dispose()).not.toThrow();
  });
});
