import { useEffect, useRef, type ReactNode } from "react";
import { SIDEBAR_WIDTH, clampSidebarWidth } from "../data/types";

interface SidebarResizerProps {
  /** 已落盘的宽度（拖拽过程中不变，拖拽起点以它为准）。 */
  width: number;
  /** 侧栏收起时把手不可用：宽度为 0、不可聚焦、不接收指针事件。 */
  disabled: boolean;
  /** 一次调整**结束时**才调用（松手 / 键盘 / 双击），持久化走这里。 */
  onCommit(width: number): void;
}

/** 键盘一次走多少：普通 8px，按住 Shift 走 24px（和大多数编辑器的手感一致）。 */
const STEP = 8;
const STEP_COARSE = 24;

/**
 * 侧栏右边框上的拖拽把手。
 *
 * 三条硬性约束：
 * 1. **拖拽过程中直接写 `--sidebar-w` 内联变量，不写 store** —— 每移动一像素都
 *    走 `patchUi()` 会让整个应用（含文件树）重渲染一次，长笔记库下就是掉帧；
 *    落盘只在松手时发生一次。
 * 2. 监听挂在 `window` 上而不是用 `setPointerCapture`：指针一旦拖到把手外面
 *    （拖快一点就会），捕获失败或者事件丢了都会让拖拽卡在半路；`pointercancel`
 *    一并收尾，松手前被打断也不会把 `--sidebar-w` 留在半途。
 * 3. 它必须显式声明 `-webkit-app-region: no-drag`（见 `app.css`）：桌面端窗口
 *    没有系统标题栏，头部那一条是窗口拖拽区，漏了这条就变成「拖窗口」而不是「拖侧栏」。
 */
export function SidebarResizer({ width, disabled, onCommit }: SidebarResizerProps): ReactNode {
  const cleanupRef = useRef<(() => void) | null>(null);

  // 拖拽中组件被卸载（例如收起侧栏）：把监听与光标状态一起收掉。
  useEffect(() => () => cleanupRef.current?.(), []);

  const preview = (next: number) => {
    document.documentElement.style.setProperty("--sidebar-w", `${next}px`);
  };

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const pointerId = event.pointerId;
    let latest = startWidth;

    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      latest = clampSidebarWidth(startWidth + (move.clientX - startX));
      preview(latest);
    };
    const finish = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return;
      cleanupRef.current?.();
      onCommit(latest);
    };

    const cleanup = () => {
      cleanupRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.documentElement.classList.remove("is-resizing-sidebar");
    };
    cleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    document.documentElement.classList.add("is-resizing-sidebar");
  };

  const nudge = (delta: number) => onCommit(clampSidebarWidth(width + delta));

  return (
    <div
      className="sidebar__resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整侧栏宽度"
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuemax={SIDEBAR_WIDTH.max}
      aria-valuenow={clampSidebarWidth(width)}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onPointerDown={beginDrag}
      onDoubleClick={() => {
        if (!disabled) onCommit(SIDEBAR_WIDTH.default);
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === "ArrowLeft") nudge(-(event.shiftKey ? STEP_COARSE : STEP));
        else if (event.key === "ArrowRight") nudge(event.shiftKey ? STEP_COARSE : STEP);
        else if (event.key === "Home") onCommit(SIDEBAR_WIDTH.min);
        else if (event.key === "End") onCommit(SIDEBAR_WIDTH.max);
        else return;
        event.preventDefault();
      }}
    />
  );
}
