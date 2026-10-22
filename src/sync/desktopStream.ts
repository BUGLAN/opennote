/**
 * 桌面端的「实时推送」入口（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §4.6、§5.5）。
 *
 * ## 为什么桌面端不能直接用 `EventSource`
 *
 * 桌面端的 CSP 是 `connect-src 'self' file:` —— **不放任何 https**（§5.3 明确「不放宽 CSP」）。
 * 而 `/v1/events` 一定在远端。所以在渲染层里 `new EventSource(url)` 会被 CSP 直接拦掉，
 * 而且是**静默**的：不报错、不连、也没有任何回调。
 *
 * 于是桌面端的流只能由**主进程**建（它没有 CSP），再把「脏了」的信号经 IPC 推回渲染层。
 *
 * ## 这一层只做**翻译**，不做重连
 *
 * 重连、退避、看门狗都在 `stream.ts` 里，两种宿主共用同一份（那才是容易写错的部分）。
 * 这里只把「主进程 push 过来的事件」翻译成 `EventStreamLike` 的四件事：
 *
 * | 主进程给的 | 这里发出 |
 * | --- | --- |
 * | `open` | `open` |
 * | `ready` / `change` / `heartbeat` | 同名事件（`data` 原样带过去） |
 * | `error` | `error` |
 *
 * ## 令牌不进渲染层的这条链
 *
 * 流 URL 里带着 `authToken`（`EventSource` 不能设请求头，这是 §4.7 第 529 行的既定做法）。
 * 桌面端**不把这个令牌交给主进程**：`relPath` 只带 path + query，
 * 主进程会把渲染层给的 `authToken` **剥掉**，贴上自己手里那份（`setAuthToken`）。
 * 于是「令牌只由主进程注入」这条纪律在 SSE 上也成立（与逐请求代理同一条）。
 */

import type { EventStreamLike } from "./stream";

/** 主进程通过 preload 暴露的那一小块（`window.opennote.syncProxy` 的一部分）。 */
export interface DesktopStreamBridge {
  /** 开一条流（**相对** base 的路径；主进程自己贴令牌）。 */
  openStream(relPath: string): Promise<unknown> | unknown;
  /** 关掉当前这条（重复调用没有副作用）。 */
  closeStream(): Promise<unknown> | unknown;
  /** 订阅主进程推来的事件；返回退订函数。 */
  onStreamEvent(listener: (message: { type: string; data?: string }) => void): () => void;
}

/** 判断一个 `syncProxy` 是否支持开流（旧版 preload 没有这三个方法）。 */
export function supportsDesktopStream(bridge: unknown): bridge is DesktopStreamBridge {
  if (!bridge || typeof bridge !== "object") return false;
  const candidate = bridge as Partial<DesktopStreamBridge>;
  return (
    typeof candidate.openStream === "function" &&
    typeof candidate.closeStream === "function" &&
    typeof candidate.onStreamEvent === "function"
  );
}

/**
 * 把桌面端的 IPC 推送适配成 `EventStreamLike`。
 *
 * `close()` 同时做两件事：退订本地监听、让主进程断流 ——
 * 少任何一件都会留下一条**没人读还在跑**的连接（那正是「同步越用越慢」的一类来源）。
 */
export function createDesktopEventStream(options: {
  /** 完整的 `/v1/events` URL（含查询串；其中的 `authToken` 会被主进程替换）。 */
  url: string;
  bridge: DesktopStreamBridge;
  /** 失败时通知上层（`stream.ts` 会据此退避重连）。 */
  onError?: (error: unknown) => void;
}): EventStreamLike {
  const listeners = new Map<string, Set<(event: { data?: string }) => void>>();
  let closed = false;

  const emit = (type: string, event: { data?: string }): void => {
    for (const listener of [...(listeners.get(type) ?? [])]) {
      try {
        listener(event);
      } catch (error) {
        // 一个监听器抛错不该影响其它监听器（也不能把错误吞成「没收到信号」）。
        console.warn("[opennote] 同步流监听器抛错", error);
      }
    }
  };

  // 先订阅、再开流：反过来的话，主进程可能在渲染层注册监听之前就把 `open` 推过来了。
  const unsubscribe = options.bridge.onStreamEvent((message) => {
    if (closed) return;
    if (!message || typeof message.type !== "string") return;
    emit(message.type, message.data === undefined ? {} : { data: message.data });
  });

  /*
   * 只把 path + query 交给主进程：
   * - **不带 origin**（主进程的 base 是配置定的，渲染层不该能改目的地）；
   * - `authToken` 由主进程剥掉再贴自己那份（见模块头）。
   */
  let relPath = options.url;
  try {
    const parsed = new URL(options.url);
    relPath = parsed.pathname + parsed.search;
  } catch {
    // 不是绝对 URL：原样传（主进程还会再校验一次「必须是安全相对路径」）。
  }

  void Promise.resolve(options.bridge.openStream(relPath)).catch((error: unknown) => {
    if (closed) return;
    options.onError?.(error);
    emit("error", { data: error instanceof Error ? error.message : String(error) });
  });

  return {
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      void Promise.resolve(options.bridge.closeStream()).catch(() => undefined);
    },
    addEventListener(type: string, listener: (event: { data?: string }) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
  };
}
