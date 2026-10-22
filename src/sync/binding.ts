/**
 * 工作区 ↔ 同步的生命周期绑定（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §5.3、第 2032 行）。
 *
 * ## 为什么它不是「一个 React hook」
 *
 * 这里真正难的东西**与 React 无关**：`attachWorkspaceSync()` 是**异步**的
 * （它要解密钥、可能还要往主进程登记 base URL），而「当前是哪个工作区」
 * 可以在它还没回来的时候就变了。
 *
 * 于是有一个经典竞态：
 *
 * ```
 * t0  用户打开工作区 A      → attach(A) 开始（异步）
 * t1  用户切到工作区 B      → 旧的要停掉
 * t2  attach(A) 才返回      → ★ 它把一个**已经不属于当前工作区**的 controller
 *                              交给了上层，然后被 start() 起来
 * ```
 *
 * 结果：**A 的同步在后台跑着**，而界面显示的是 B。用户看不到它、也关不掉它，
 * 直到下次切回 A 才发现「怎么一直在同步」。手机上那是持续的耗电与流量。
 *
 * 所以这一层把「取消」做成一等公民：`stop()` 之后**所有在途的 attach 结果都被丢弃**，
 * 而且用一个**代次**（generation）计数来判断，而不是靠一个布尔量
 * （布尔量在「停掉又立刻重新开始」时会误判）。
 *
 * 它不 import React，于是能用十几行用例把竞态测完 —— 而 React 那边只剩一个
 * `useEffect` 的壳。
 */

import type { AttachResult, AttachSkipReason } from "./attach";
import type { SyncController } from "./controller";

export type BindingPhase = "idle" | "attaching" | "attached" | "skipped";

export interface WorkspaceSyncBindingOptions {
  /** 接上（通常就是 `attachWorkspaceSync`）。 */
  attach: () => Promise<AttachResult>;
  onPhase?: (phase: BindingPhase) => void;
  onStatus?: (status: ReturnType<SyncController["status"]>) => void;
  log?: (line: string) => void;
}

export interface WorkspaceSyncBinding {
  /** 接上并开始。重复调用 = 先停掉上一个再重来。 */
  start(): Promise<void>;
  /** 停掉并把在途的 attach 作废。 */
  stop(): void;
  phase(): BindingPhase;
  /** `skipped` 时的原因（界面据此说「为什么没同步」）。 */
  reason(): AttachSkipReason | null;
  /** 当前接上的 controller（没接上就是 null）。 */
  controller(): SyncController | null;
}

export function createWorkspaceSyncBinding(options: WorkspaceSyncBindingOptions): WorkspaceSyncBinding {
  let phase: BindingPhase = "idle";
  let skipReason: AttachSkipReason | null = null;
  let current: SyncController | null = null;
  /**
   * ★ **代次**，不是布尔量。
   *
   * `stop()` 与 `start()` 都会 +1。一个在途的 attach 回来时如果代次变了，
   * 它的结果就作废。用布尔量在「停掉又立刻重新开始」时会误判：
   * 那一次 attach 看到 `running === true`（新那一轮设的），就**误以为自己是当前的**。
   */
  let generation = 0;

  const publish = (next: BindingPhase): void => {
    phase = next;
    options.onPhase?.(next);
  };

  return {
    async start() {
      // 先停掉上一个（切工作区 / 重新开始），并让在途的那次作废。
      this.stop();
      const mine = ++generation;
      publish("attaching");

      let result: AttachResult;
      try {
        result = await options.attach();
      } catch (error) {
        // 接不上（例如 E2EE 缺密钥）**不是**要吞掉的异常：
        // `attachWorkspaceSync` 会为「能预期」的情况返回 ok:false，
        // 走到这里的是**真的意外**，如实记下来。
        options.log?.(`[binding] attach 抛错：${String(error)}`);
        if (mine === generation) publish("idle");
        return;
      }

      // ★ 回来时先看代次：变了说明这已经不是当前那一次了（用户切走了 / 又重开了）。
      if (mine !== generation) {
        options.log?.("[binding] attach 回来时代次已变，丢弃这次结果（切了工作区）");
        // 万一它已经建出了 controller，也要收干净 —— 否则它会一直跑着而没人能关掉它。
        if (result.ok) result.controller.stop();
        return;
      }

      if (!result.ok) {
        skipReason = result.reason;
        current = null;
        publish("skipped");
        return;
      }

      skipReason = null;
      current = result.controller;
      if (options.onStatus) options.onStatus(current.status());
      current.start();
      publish("attached");

    },

    stop() {
      // +1 ⇒ 任何在途的 attach 回来时都会看到代次变了。
      generation += 1;
      if (current) {
        current.stop();
        current = null;
      }
      skipReason = null;
      publish("idle");
    },

    phase: () => phase,
    reason: () => skipReason,
    controller: () => current,
  };
}
