/**
 * 「回到前台」的统一来源（`docs/执行-三端同步-密钥即身份-2026-10-13.md` 第 2032 行、第 1448 行）。
 *
 * ## 为什么需要它，以及为什么它不能只靠 `visibilitychange`
 *
 * 第 2032 行：「手机上从后台回前台 ⇒ **立刻增量拉取**」。
 *
 * 手机上「回前台」有两个不同的信号源，而且**它们各自都会漏**：
 *
 * | 宿主 | 信号 | 什么时候会漏 |
 * | --- | --- | --- |
 * | Android/iOS App | `@capacitor/app` 的 `appStateChange` | WebView 里 `visibilitychange` **可能不触发**（App 被系统挂起时 JS 整个停了） |
 * | 浏览器 / 桌面 | `document.visibilitychange` | 没有 Capacitor，那个插件不存在 |
 *
 * 所以两个都订，**去重**（同一个动作可能同时触发两个）。
 * 去重的窗口不用很大 —— 重复触发本身无害（单飞会合并），
 * 但不去重会让「切一次前台」触发两轮同步，白跑一遍列树。
 *
 * ## 一个刻意的**不**做
 *
 * 它**不**在这里调 `resume()`。它只回答「用户回来了」，由上层决定做什么 ——
 * 这样这个模块能用十几行用例测完，而「回来之后要同步」那条判断留在 `controller.ts`
 * （那里已经有用例）。
 */

/** 「回到前台」的订阅源。 */
export interface ResumeSource {
  /** 订阅；返回退订函数。 */
  subscribe(onResume: () => void): () => void;
}

/** Capacitor `App` 插件里我们用到的那一小块。 */
export interface CapacitorAppLike {
  addListener(event: "appStateChange", listener: (state: { isActive: boolean }) => void): Promise<{ remove: () => void }> | { remove: () => void };
}

/** `document` 里我们用到的那一小块。 */
export interface DocumentLike {
  visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface ResumeSourceOptions {
  capacitor?: CapacitorAppLike | null;
  document?: DocumentLike | null;
  /** 去重窗口（毫秒）。默认 500ms。 */
  dedupeMs?: number;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  log?: (line: string) => void;
}

const DEFAULT_DEDUPE_MS = 500;

export function createResumeSource(options: ResumeSourceOptions = {}): ResumeSource {
  const dedupeMs = options.dedupeMs ?? DEFAULT_DEDUPE_MS;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  return {
    subscribe(onResume) {
      let lastAt = Number.NEGATIVE_INFINITY;
      let resetTimer: unknown = null;

      /** 去重：同一动作在 `dedupeMs` 内只报一次。 */
      const fire = (source: string): void => {
        const at = now();
        if (at - lastAt < dedupeMs) {
          options.log?.(`[resume] ${source} 与上一次太近，忽略（去重）`);
          return;
        }
        lastAt = at;
        options.log?.(`[resume] ${source} ⇒ 回到前台`);
        onResume();
        // 窗口过了就把 `lastAt` 放掉，免得长时间不切前台之后一次误判。
        if (resetTimer !== null) clearTimer(resetTimer);
        resetTimer = setTimer(() => {
          lastAt = Number.NEGATIVE_INFINITY;
          resetTimer = null;
        }, dedupeMs);
      };

      const disposers: (() => void)[] = [];

      // ① 原生 App：`appStateChange`。`addListener` 返回 Promise 或对象，两种都要收。
      if (options.capacitor) {
        try {
          const handle = options.capacitor.addListener("appStateChange", (state) => {
            // 只在**变成活跃**时报（切到后台也会触发这个事件，那不是「回来了」）。
            if (state && state.isActive) fire("appStateChange");
          });
          disposers.push(() => {
            if (handle && typeof (handle as Promise<{ remove: () => void }>).then === "function") {
              void (handle as Promise<{ remove: () => void }>).then((listener) => listener?.remove?.()).catch(() => undefined);
            } else {
              (handle as { remove?: () => void })?.remove?.();
            }
          });
        } catch (error) {
          // 插件不在（网页 / 桌面）不是错误 —— 下一个信号源会兜住。
          options.log?.(`[resume] Capacitor 不可用：${String(error)}`);
        }
      }

      // ② 浏览器 / 桌面：`visibilitychange`。只在**变成可见**时报。
      if (options.document) {
        const doc = options.document;
        const listener = (): void => {
          if (doc.visibilityState === "visible") fire("visibilitychange");
        };
        doc.addEventListener("visibilitychange", listener);
        disposers.push(() => doc.removeEventListener("visibilitychange", listener));
      }

      return () => {
        if (resetTimer !== null) clearTimer(resetTimer);
        for (const dispose of disposers) dispose();
      };
    },
  };
}

/**
 * 按当前环境挑一个来源。
 *
 * `capacitor` 由调用方传进来（`@capacitor/app` 是可选依赖，
 * 而**在网页/桌面构建里 import 它会引入一个用不上的模块**）。
 */
export function resolveResumeSource(options: { capacitor?: CapacitorAppLike | null; log?: (line: string) => void } = {}): ResumeSource {
  const doc = (globalThis as { document?: DocumentLike }).document ?? null;
  return createResumeSource({
    capacitor: options.capacitor ?? null,
    document: doc,
    ...(options.log === undefined ? {} : { log: options.log }),
  });
}
