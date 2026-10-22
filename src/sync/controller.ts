/**
 * 同步的生命周期控制器：把「流」接到「调度器」上
 * （`docs/执行-三端同步-密钥即身份-2026-10-13.md` §5.3、§5.4、第 2032 行）。
 *
 * ## 为什么还要一层
 *
 * `session.ts` 管「一次同步怎么跑」，`stream.ts` 管「远端什么时候脏了」。
 * 两者之间还差一件小事：**把后者变成前者的一次触发**，并且管好
 * 「什么时候开、什么时候关、回前台怎么办」。
 *
 * 这件小事单独放一层，是为了让 `App.tsx` 只需要认识**一个**对象 ——
 * 否则 React 组件里会散落着「订阅流、退订流、把信号转给 runner、回前台再拉一次」
 * 这些与界面无关的逻辑，而它们**没有地方能被单独测**。
 *
 * ## 一条刻意的分工
 *
 * - **流只负责说「脏了」**（不带内容、不带顺序）；
 * - **调度器负责合并**（进行中的请求不会并发第二次）；
 * - **控制器不判断「这次信号值不值得同步」** —— 那是调度器单飞的职责。
 *   在这里再加一层「去重」会变成第二份合并逻辑，而两份迟早不一致。
 */

import type { SyncOnceResult } from "./engine";
import type { SyncRunner, SyncStatus } from "./runner";
import type { SyncStream } from "./stream";

export interface SyncControllerOptions {
  runner: SyncRunner;
  /**
   * 建一条流。两个回调各管一件事：
   * - `onSignal`：远端**确实前进**了 ⇒ 跑一轮同步；
   * - `onUpToDate`：连上后核对**已经是最新** ⇒ 不跑同步，只更新状态（见 `runner.noteUpToDate`）。
   *
   * 返回 `null` = 这个宿主不订阅实时（用户关了实时 / 宿主没有流）。
   */
  openStream: (
    onSignal: (cursor: string | null) => void,
    onUpToDate: () => void,
  ) => SyncStream | null;
  /**
   * 没有「能比对游标」的流时，启动要不要先同步一轮。默认 `true`。
   *
   * 有那种流时**不需要**它：连上那一刻会自己判断落后没落后（见 `start()`）。
   */
  syncOnStart?: boolean;
  log?: (line: string) => void;
}

export interface SyncController {
  /** 启动：先同步一轮，再订阅实时。重复调用无副作用。 */
  start(): void;
  /** 停止：退订 + 停掉去抖（关工作区 / 登出）。 */
  stop(): void;
  /** 用户手动点「立即同步」。 */
  syncNow(): Promise<SyncOnceResult | null>;
  status(): SyncStatus;
  /** 实时订阅当前是否活着（诊断 / 状态栏用）。 */
  subscribed(): boolean;
}

export function createSyncController(options: SyncControllerOptions): SyncController {
  let stream: SyncStream | null = null;
  let running = false;

  return {
    start() {
      if (running) return;
      running = true;
      stream = options.openStream(
        (cursor) => {
          options.log?.(`[sync] 收到远端信号（游标 ${cursor ?? "未知"}）`);
          // 不在这一层判「值不值得」—— 单飞会合并掉重复的触发。
          void options.runner.request("signal");
        },
        () => {
          options.log?.("[sync] 连上后核对：已是最新，跳过同步");
          options.runner.noteUpToDate();
        },
      );
      /*
       * ★ 「启动先拉一轮」现在**只在流不会比对游标时**才做。
       *
       * 会比对时（`stream.reconcilesCursor()`），连上那一刻服务端会先发 `ready`，
       * 里面带着当前游标；`stream.ts` 拿它和本机记的比一比，落后才发信号。
       * 于是「什么都没变就打开应用」从 2 个请求变成 **0 个**。
       *
       * 不会比对时（宿主没有游标存储 / 没有实时流）**必须**无条件拉：
       * 否则离线期间别人写的东西永远补不上 —— 流只报告「连上之后」的变化。
       */
      const reconciles = stream !== null && stream.reconcilesCursor();
      if (!reconciles && options.syncOnStart !== false) void options.runner.request("startup");
    },

    stop() {
      running = false;
      stream?.stop();
      stream = null;
      options.runner.dispose();
    },


    syncNow: () => options.runner.request("manual"),
    status: () => options.runner.status(),
    subscribed: () => stream !== null,
  };
}
