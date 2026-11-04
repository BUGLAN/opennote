import { Fragment, useEffect, useReducer, useRef, type ReactNode } from "react";
import { cn } from "../lib/utils";

/**
 * 退场时长：与进场同一档 `--dur-fast`（120ms），再留一点余量让最后一帧画完。
 * 退场动画本身在 `app.css` 的 `.presence.is-leaving` 下（反向播放进场的那几个 keyframes）。
 */
export const EXIT_MS = 140;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

/**
 * 「值没了」之后再留 {@link EXIT_MS}：返回最后一个非空值与 `leaving` 标记，到点才变回 null。
 *
 * - 期间值又回来了 ⇒ 直接取消退场，`generation` 加一 —— 调用方用它做 key，重新打开的
 *   浮层是一个**新实例**（状态归零），而不是把正在淡出的那个旧实例捡回来；
 * - `prefers-reduced-motion` 下不留：降级规则把动画压到 0.01ms，再白挂 140ms 的隐形浮层没有意义。
 */
export function usePresence<T>(value: T | null | undefined): { value: T | null; leaving: boolean; generation: number } {
  const lastRef = useRef<T | null>(null);
  const generationRef = useRef(0);
  const wasPresentRef = useRef(false);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const present = value !== null && value !== undefined;

  if (present) {
    if (!wasPresentRef.current) generationRef.current += 1;
    lastRef.current = value;
  }
  wasPresentRef.current = present;
  const leaving = !present && lastRef.current !== null;

  useEffect(() => {
    if (!leaving) return;
    if (prefersReducedMotion()) {
      lastRef.current = null;
      rerender();
      return;
    }
    const timer = window.setTimeout(() => {
      lastRef.current = null;
      rerender();
    }, EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  return { value: present ? value : lastRef.current, leaving, generation: generationRef.current };
}

/**
 * 退场容器：`display: contents` 不参与布局，只负责在退场时挂上 `is-leaving` 与 `inert`
 * （淡出中的浮层不再接点击、不再抢焦点，Tab 也走不进去）。
 *
 * 进场与退场**用的是同一个容器元素**：如果只在退场时才包一层，React 会把里面的对话框
 * 当成新树卸载重建 —— 状态清零、挂载副作用再跑一遍。
 */
export function Leaving({ leaving, children }: { leaving: boolean; children: ReactNode }): ReactNode {
  return (
    <div className={cn("presence", leaving && "is-leaving")} inert={leaving}>
      {children}
    </div>
  );
}

/** 条件渲染的浮层套一层即可：`<Presence>{open ? <Dialog … /> : null}</Presence>`。 */
export function Presence({ children }: { children: ReactNode }): ReactNode {
  const shown = children === false || children === "" ? null : children;
  const { value, leaving, generation } = usePresence(shown);
  if (value === null) return null;
  return (
    <Leaving leaving={leaving}>
      <Fragment key={generation}>{value}</Fragment>
    </Leaving>
  );
}
