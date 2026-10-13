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
   * 建一条流并把信号交给 `onSignal`。返回 `null` = 这个宿主不订阅实时
   * （例如用户关了实时、或桌面端主进程代理还没接上）。
   */
  openStream: (onSignal: (cursor: string | null) => void) => SyncStream | null;
  /** 启动时先同步一轮（用户打开应用不该等着第一条 SSE 信号）。默认 true。 */
  syncOnStart?: boolean;
  log?: (line: string) => void;
}

export interface SyncController {
  /** 启动：先同步一轮，再订阅实时。重复调用无副作用。 */
  start(): void;
  /** 停止：退订 + 停掉去抖（关工作区 / 登出）。 */
  stop(): void;
  /** 从后台回前台（第 2032 行）：立刻增量拉取一次，并确保流是活的。 */
  resume(): void;
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
      // ① 先拉一轮：用户打开应用不该干等着第一条 SSE 信号（那可能要等很久）。
      if (options.syncOnStart !== false) void options.runner.request("startup");
      // ② 再订阅。顺序是刻意的：先拉后订，中间那一段变更不会丢
      //    （订阅之后到达的会触发新的一轮；订阅之前到达的已经被那一轮拉到了）。
      stream = options.openStream((cursor) => {
        options.log?.(`[sync] 收到远端信号（游标 ${cursor ?? "未知"}）`);
        // 不在这一层判「值不值得」—— 单飞会合并掉重复的触发。
        void options.runner.request("signal");
      });
    },

    stop() {
      running = false;
      stream?.stop();
      stream = null;
      options.runner.dispose();
    },

    resume() {
      if (!running) {
        // 已经停了（例如登出后回来）：当作重新开始。
        this.start();
        return;
      }
      /*
       * 第 2032 行：回前台要**立刻增量拉取**。
       *
       * `stream.resume()` 自己也会发一次信号，但这里**再发一次**是有意的：
       * 宿主可能根本没建流（`openStream` 返回 null），那时只有这一次请求
       * 能把后台期间的变更拉回来。而重复的请求会被单飞合并掉，代价接近零。
       */
      stream?.resume();
      void options.runner.request("focus");
    },

    syncNow: () => options.runner.request("manual"),
    status: () => options.runner.status(),
    subscribed: () => stream !== null,
  };
}
