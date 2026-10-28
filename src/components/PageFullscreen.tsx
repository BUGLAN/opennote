import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { notify } from "../lib/toast";
import { cn } from "../lib/utils";
import { Icon } from "./Icons";

/**
 * HTML 页面的**悬浮全屏按钮**（与它控制的那块容器一起工作）。
 *
 * ## 为什么是「真全屏」而不是放大到铺满主栏
 *
 * 铺满主栏的写法在任何情况下都能实现，但用户按 Esc 不会退出、系统手势也不生效 ——
 * 那是一个**看起来像全屏的普通浮层**。这里优先用 {@link Element.requestFullscreen}，
 * 只有浏览器明确不支持（或调用被拒）时才退化成铺满视口的浮层，并如实说明。
 *
 * ## 为什么状态的真相是 `fullscreenchange`，而不是这个组件的 state
 *
 * 用户退出全屏的方式不止一种：点按钮、按 Esc、系统手势（平板）、切窗口。
 * 只听按钮会让「按了 Esc 但界面还标着全屏」成为常态，所以按钮只是**触发动作**，
 * 浏览器事件才是状态来源。
 *
 * ## 为什么不重新挂一棵子树
 *
 * 见 `HtmlPageView`：全屏**不重建 iframe**（重建 = 页面重载，滚动位置、表单内容、
 * 动画进度全丢）。所以这里只对**已经挂载好的容器元素**做全屏，不搬运 React 子树。
 */

interface PageFullscreenProps {
  /** 要被全屏的那块容器（`.html-page` 的外层 div）。 */
  containerRef: RefObject<HTMLDivElement | null>;
  /** 无障碍名称。 */
  title: string;
  /** 全屏状态变化时通知外层（外层据此给容器加 class，让内容铺满）。 */
  onFullscreenChange?(fullscreen: boolean): void;
}

/**
 * 把「请求 / 退出原生全屏」与「浏览器事件」之间的差异收在一处。
 *
 * 返回 `enter` / `exit` / `native`：`native === false` 表示「退化成应用内全屏」，
 * 调用方据此给容器换成 `position: fixed` 的铺满样式 —— 两种模式**用户看到的都是全屏**，
 * 区别只在按 Esc 时谁来收场。
 */
export function useNativeFullscreen(containerRef: RefObject<HTMLElement | null>): {
  fullscreen: boolean;
  native: boolean;
  enter(): void;
  exit(): void;
} {
  const [fullscreen, setFullscreen] = useState(false);
  const [native, setNative] = useState(false);

  useEffect(() => {
    const onChange = () => {
      const active = Boolean(document.fullscreenElement);
      setNative(active);
      // 浏览器退出了全屏（Esc / 系统手势）⇒ 我们也要退出，否则界面停在「全屏中」。
      if (!active) setFullscreen(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const enter = useCallback(() => {
    setFullscreen(true);
    const element = containerRef.current;
    if (!element || typeof element.requestFullscreen !== "function") {
      setNative(false);
      return;
    }
    element.requestFullscreen({ navigationUI: "hide" }).then(
      () => setNative(true),
      (error: unknown) => {
        // 被拒是**正常情况**（非用户手势、iframe 权限策略、某些 WebView）：
        // 退化成应用内全屏，并把原因如实说一次，而不是让按钮「点了没反应」。
        setNative(false);
        notify(
          error instanceof Error && error.message ? `已改为应用内全屏：${error.message}` : "已改为应用内全屏",
          { kind: "info" },
        );
      },
    );
  }, [containerRef]);

  const exit = useCallback(() => {
    setFullscreen(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  }, []);

  return { fullscreen, native, enter, exit };
}

export function PageFullscreen({ containerRef, title, onFullscreenChange }: PageFullscreenProps): ReactNode {
  const { fullscreen, native, enter, exit } = useNativeFullscreen(containerRef);
  const titleRef = useRef(title);
  titleRef.current = title;

  // 通知外层（外层据此加 class 让容器铺满）。用 ref 存回调，避免每次渲染换函数导致死循环。
  const notifyRef = useRef(onFullscreenChange);
  notifyRef.current = onFullscreenChange;
  useEffect(() => {
    notifyRef.current?.(fullscreen);
    if (!fullscreen) return;
    /*
     * 全屏期间锁住背景滚动。**必须在退出时恢复原值**（不是无条件写回 ""）：
     * 别处可能已经把 body 的 overflow 设成了别的值，无条件清空会把别人的样式也改掉。
     */
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [fullscreen]);

  // Esc 兜底：只在**应用内全屏**（原生全屏时浏览器自己处理 Esc，我们再拦一次会重复执行）。
  useEffect(() => {
    if (!fullscreen || native) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      exit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, native, exit]);

  return (
    <button
      type="button"
      className={cn("html-page__fullscreen-btn", fullscreen && "is-on")}
      title={fullscreen ? `退出全屏（${title}）` : "全屏查看这个页面"}
      aria-label={fullscreen ? "退出全屏" : "全屏查看页面"}
      aria-pressed={fullscreen}
      onClick={() => (fullscreen ? exit() : enter())}
    >
      <Icon name={fullscreen ? "fullscreenExit" : "fullscreen"} size={15} />
    </button>
  );
}
