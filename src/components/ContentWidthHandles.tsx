import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { Id, WidthId } from "../data/types";
import { applyContentWidthOverride, readContentWidthPreference, writeContentWidthPreference } from "../data/contentWidth";
import {
  CONTENT_WIDTH_MIN_RANGE,
  clampContentWidth,
  contentWidthBounds,
  contentWidthForKey,
  contentWidthFromDrag,
  resolveMeasureWidth,
  type ContentWidthBounds,
  type ContentWidthSide,
} from "../lib/contentWidth";

interface ContentWidthHandlesProps {
  /** 没有打开的笔记（欢迎页 / 空态）时不挂拖拽条。 */
  enabled: boolean;
  /** 当前「设置 · 栏宽」预设；持久化记录按它失效（见 data/contentWidth.ts）。 */
  preset: WidthId;
  /** 切标签 / 上锁都会换掉被测量的正文容器，用它们触发重新测量。 */
  activeId: Id | null;
  locked: boolean;
  /**
   * 宽度变化后通知外层。CodeMirror 的滚动锚点与行高表按 `.cm-content` 宽度缓存，
   * 只改 CSS 不会让它自己重新量 —— App 传 `view.requestMeasure()` 进来。
   */
  onWidthChange?(): void;
}

/** 拖动时先找正文容器：编辑态是 `.cm-content`，只读锁的阅读视图是 `.reading`。 */
function findColumn(main: HTMLElement): HTMLElement | null {
  const host = main.querySelector<HTMLElement>(".editor-host:not(.editor-host--hidden)");
  const content = host?.querySelector<HTMLElement>(".cm-content");
  if (content) return content;
  return main.querySelector<HTMLElement>(".reading-scroll .reading");
}

/**
 * 正文栏左右两侧的宽度拖拽条。
 *
 * 为什么不用 `setPointerCapture`：指针拖快一点就会离开那 22px 的命中区，捕获一旦丢了
 * 拖拽就卡在半路（侧栏把手踩过同一个坑，见 `SidebarResizer`）。这里同样把
 * `pointermove` / `pointerup` / `pointercancel` 挂到 `window` 上。
 *
 * 为什么把手的位置要 JS 量：正文栏是 `.cm-scroller`（可能带竖直滚动条）里居中的
 * `.cm-content`，而拖拽层铺在 `.main` 上 —— 两者中心差半个滚动条宽度。CSS 里算不准，
 * 所以量出「正文栏到拖拽层左右边的距离」写进 `--content-handle-left/right`，CSS 只负责
 * 贴着这两条边画。测量只在布局变化时发生，拖拽过程中只改 `--measure-override` 与这两个
 * 偏移量，不触发 React 重渲染（拖动 60fps 也不会让编辑器重画一遍）。
 */
export function ContentWidthHandles({ enabled, preset, activeId, locked, onWidthChange }: ContentWidthHandlesProps): ReactNode {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const presetRef = useRef(preset);
  presetRef.current = preset;
  /** 拖拽 / 键盘结束后清理用（组件卸载、窗口失焦等都要能收尾）。 */
  const cleanupRef = useRef<(() => void) | null>(null);
  /** 无障碍数值：只在测量与一次调整结束时更新，不在拖拽的每一帧 setState。 */
  const [a11y, setA11y] = useState<{ min: number; max: number; now: number } | null>(null);
  /** 可拖范围是否成立（窗口太窄 / 满幅预设时为 false，拖拽条整条隐藏）。 */
  const [available, setAvailable] = useState(false);

  /** 最近一次量到的正文栏左右留白（相对拖拽层），拖拽中用它们做增量推算。 */
  const offsetsRef = useRef({ left: 0, right: 0 });

  /** 把正文栏边界换算成相对拖拽层的像素偏移，写到 CSS 变量上。 */
  const publishOffsets = useCallback((column: HTMLElement) => {
    const root = rootRef.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    const columnRect = column.getBoundingClientRect();
    const offsets = {
      left: Math.max(0, Math.round(columnRect.left - rootRect.left)),
      right: Math.max(0, Math.round(rootRect.right - columnRect.right)),
    };
    offsetsRef.current = offsets;
    root.style.setProperty("--content-handle-left", `${offsets.left}px`);
    root.style.setProperty("--content-handle-right", `${offsets.right}px`);
    root.setAttribute("data-ready", "true");
  }, []);

  /** 读当前布局下的可拖范围：最小值 = 当前栏宽预设（超过可用宽度时就是可用宽度）。 */
  const readBounds = useCallback((column: HTMLElement): ContentWidthBounds => {
    const scroller = column.parentElement;
    const containerWidth = scroller?.clientWidth ?? column.getBoundingClientRect().width;
    const rootStyle = getComputedStyle(document.documentElement);
    const rootFontSize = Number.parseFloat(rootStyle.fontSize) || 16;
    // `--measure` 是栏宽预设的「真源」。自定义宽度只落在 `--measure-override` 上，
    // 所以这里读到的永远是默认宽度 —— 双击恢复、最小宽度都靠它。
    const presetWidth = resolveMeasureWidth(rootStyle.getPropertyValue("--measure"), rootFontSize, containerWidth);
    return contentWidthBounds({
      presetWidth: Math.min(presetWidth, containerWidth),
      containerWidth,
      viewportWidth: window.innerWidth,
    });
  }, []);

  const measure = useCallback((): { column: HTMLElement; bounds: ContentWidthBounds } | null => {
    const root = rootRef.current;
    const main = root?.parentElement;
    if (!root || !main) return null;
    const column = findColumn(main);
    if (!column) {
      root.removeAttribute("data-ready");
      return null;
    }
    const rect = column.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) {
      root.removeAttribute("data-ready");
      return null;
    }
    publishOffsets(column);
    const bounds = readBounds(column);
    /*
     * 窗口 / 侧栏 / 大纲变窄后，上次存下的自定义宽度可能已经超过新的上限。这里把**显示值**
     * 夹回范围内（不覆盖 localStorage）：否则正文会顶满容器，拖拽条被挤到容器外、抓不到。
     * 不写回存储，是为了让窗口再放大时还能恢复用户原本选的宽度。
     */
    const stored = presetRef.current === "full" ? null : readContentWidthPreference(presetRef.current);
    if (stored !== null && !root.hasAttribute("data-dragging")) {
      const clamped = clampContentWidth(stored, bounds);
      if (Math.abs(clamped - column.getBoundingClientRect().width) > 1) applyContentWidthOverride(clamped);
    }
    const canResize = bounds.max - bounds.min >= CONTENT_WIDTH_MIN_RANGE;
    root.toggleAttribute("data-disabled", !canResize);
    setAvailable(canResize);
    const now = clampContentWidth(rect.width, bounds);
    setA11y((prev) =>
      prev && prev.min === bounds.min && prev.max === bounds.max && prev.now === now
        ? prev
        : { min: bounds.min, max: bounds.max, now },
    );
    return { column, bounds };
  }, [publishOffsets, readBounds]);

  // 布局变化（窗口 / 侧栏 / 大纲 / 栏宽预设 / 切换标签 / 上锁）后重新量一次。
  //
  // 三个观察源缺一不可：
  //  1. `ResizeObserver` 盯 `.main`、滚动容器与正文栏本身 —— 侧栏 / 大纲拖宽、窗口缩放、
  //     竖直滚动条出现（scroller 的 clientWidth 变了）都会改变正文栏几何；
  //  2. `MutationObserver` 盯 `.main` 的子树 —— CodeMirror 是**被动 effect** 里才挂载的，
  //     组件的 layout effect 第一次跑时 `.cm-content` 还不存在；切换标签 / 上锁也会换容器；
  //  3. `resize` 事件兜底（移动端地址栏收起等 ResizeObserver 覆盖不到的情况）。
  // 所有回调都合并到同一帧，且拖拽期间不排测量（尺寸变化由 `publishOffsets()` 负责）。
  useLayoutEffect(() => {
    if (!enabled) return;
    const root = rootRef.current;
    const main = root?.parentElement;
    if (!root || !main) return;

    let frame: number | null = null;
    const observed = new Set<HTMLElement>();
    let lastColumn: HTMLElement | null = null;

    const resizeObserver =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            if (!root.hasAttribute("data-dragging")) schedule();
          })
        : null;

    /** 把观察目标同步成「主栏 + 滚动容器 + 当前正文栏」三件套。 */
    const observeTargets = (column: HTMLElement | null) => {
      if (!resizeObserver) return;
      const next = new Set<HTMLElement>();
      next.add(main);
      if (column?.parentElement) next.add(column.parentElement);
      if (column) next.add(column);
      for (const element of observed) if (!next.has(element)) resizeObserver.unobserve(element);
      for (const element of next) if (!observed.has(element)) resizeObserver.observe(element);
      observed.clear();
      for (const element of next) observed.add(element);
    };

    const refresh = () => {
      const next = measure();
      lastColumn = next?.column ?? null;
      observeTargets(lastColumn);
    };

    function schedule() {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        refresh();
      });
    }

    const mutationObserver =
      typeof MutationObserver === "function"
        ? new MutationObserver(() => {
            // 只在「正文容器换了 / 刚出现」时重量：CodeMirror 每次敲字都会改子树，
            // 不做这层过滤的话每敲一个字都要跑一次 getBoundingClientRect。
            const host = root.parentElement;
            const column = host ? findColumn(host) : null;
            if (column !== lastColumn) schedule();
          })
        : null;
    mutationObserver?.observe(main, { childList: true, subtree: true });

    refresh();
    // 首帧再量一次：被动 effect 里才挂载的 CodeMirror 此刻已经就位。
    schedule();
    window.addEventListener("resize", schedule);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      observed.clear();
      root.removeAttribute("data-ready");
      root.removeAttribute("data-dragging");
      setAvailable(false);
    };
  }, [enabled, preset, activeId, locked, measure]);

  // 组件卸载（切去欢迎页等）：拖拽中的监听、全局光标状态一并收掉。
  useEffect(() => () => cleanupRef.current?.(), []);

  /** 把宽度写进 CSS 并持久化；`null` 或等于最小宽度时清掉覆盖值，回到栏宽预设。 */
  const commit = useCallback(
    (width: number, bounds: ContentWidthBounds) => {
      const next = width <= bounds.min ? null : clampContentWidth(width, bounds);
      applyContentWidthOverride(next);
      writeContentWidthPreference(next, presetRef.current);
      const measured = measure();
      if (measured) {
        setA11y({ min: measured.bounds.min, max: measured.bounds.max, now: Math.round(measured.column.getBoundingClientRect().width) });
      }
      onWidthChange?.();
    },
    [measure, onWidthChange],
  );

  const beginDrag = (side: ContentWidthSide) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled || event.button !== 0) return;
    /*
     * 双击恢复默认：优先看 pointerdown 的 `detail`（鼠标连击计数）。浏览器在第二下
     * pointerdown 时就会给出 detail=2，而 `dblclick` 要等第二下 pointerup 之后才发 ——
     * 拖拽又必须阻止 pointerdown 的默认行为（不许选中文本），某些浏览器会因此吞掉
     * 兼容鼠标事件、dblclick 干脆不来。`onDoubleClick` 仍作为兜底接在下面（幂等）。
     */
    if (event.detail >= 2) {
      event.preventDefault();
      event.stopPropagation();
      resetToPreset();
      return;
    }
    const root = rootRef.current;
    const geometry = measure();
    if (!root || !geometry) return;
    const { column, bounds } = geometry;
    // 范围太小（窗口已经放不下正文栏 + 两侧安全边距）时不开始拖拽，避免一按就跳。
    if (bounds.max - bounds.min < CONTENT_WIDTH_MIN_RANGE) return;

    event.preventDefault();
    event.stopPropagation();

    const startWidth = clampContentWidth(column.getBoundingClientRect().width, bounds);
    const startOffsets = { ...offsetsRef.current };
    const startX = event.clientX;
    const pointerId = event.pointerId;
    // 取消时恢复按下前的覆盖值（不是 startWidth）：拖到一半被打断不该产生新持久化值。
    const startPreference = readContentWidthPreference(presetRef.current);
    let pointerX = startX;
    let applied = startWidth;
    let frame: number | null = null;
    let finished = false;

    const applyFrame = () => {
      frame = null;
      if (finished) return;
      const next = contentWidthFromDrag(startWidth, pointerX - startX, side, bounds);
      if (next === applied) return;
      applied = next;
      // 只更新 CSS 变量：正文宽度与两条拖拽条的贴边位置同一帧生效，不经过 React。
      applyContentWidthOverride(next);
      /*
       * 拖拽中**不做布局读取**（getBoundingClientRect 会强制同步重排，长文档下每帧一次
       * 就是抖动来源）。正文始终居中：总宽从 startWidth 变到 next，左右边界各移动
       * (next - startWidth) / 2，于是两条把手的外侧留白同步减去这个量即可。
       */
      const half = (next - startWidth) / 2;
      root.style.setProperty("--content-handle-left", `${startOffsets.left - half}px`);
      root.style.setProperty("--content-handle-right", `${startOffsets.right - half}px`);
      onWidthChange?.();
    };

    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      pointerX = move.clientX;
      // requestAnimationFrame 节流：一帧最多写一次样式。指针事件通常高于 60Hz，
      // 直接写会让每一帧做多次布局，长文档下能看出拖影。
      if (frame === null) frame = requestAnimationFrame(applyFrame);
    };

    const finish = (up: PointerEvent, commitValue: boolean) => {
      if (finished || up.pointerId !== pointerId) return;
      finished = true;
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      cleanupRef.current?.();
      /*
       * 只有「指针真的动过」才落盘：单击一次不该写 localStorage（尤其是当前正好是预设
       * 宽度时，把 null 写一遍会顺手删掉别的预设留下的记录）。`applied !== startWidth`
       * 覆盖「拖出去又拖回原点」的情况 —— 这时最后一帧可能还停在中间值，必须用
       * 起点宽度把 CSS 收回来（commit 会按边界自动清成预设或写回原值）。
       */
      if (commitValue && (up.clientX !== startX || applied !== startWidth)) {
        const finalWidth = contentWidthFromDrag(startWidth, up.clientX - startX, side, bounds);
        commit(finalWidth, bounds);
      } else if (commitValue) {
        onWidthChange?.();
      } else {
        // pointercancel：回到按下前的状态，不写入 localStorage。
        applyContentWidthOverride(startPreference);
        const measured = measure();
        if (measured) {
          setA11y({
            min: measured.bounds.min,
            max: measured.bounds.max,
            now: Math.round(measured.column.getBoundingClientRect().width),
          });
        }
        onWidthChange?.();
      }
    };

    const cleanup = () => {
      cleanupRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      document.documentElement.classList.remove("is-resizing-content");
      root.removeAttribute("data-dragging");
    };
    const onUp = (up: PointerEvent) => finish(up, true);
    const onCancel = (up: PointerEvent) => finish(up, false);

    cleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    document.documentElement.classList.add("is-resizing-content");
    root.setAttribute("data-dragging", side);
    setA11y({ min: bounds.min, max: bounds.max, now: startWidth });
  };

  /** 双击 / 键盘 Home：清掉自定义宽度，回到当前栏宽预设。 */
  const resetToPreset = () => {
    applyContentWidthOverride(null);
    writeContentWidthPreference(null, presetRef.current);
    const measured = measure();
    if (measured) {
      setA11y({
        min: measured.bounds.min,
        max: measured.bounds.max,
        now: Math.round(measured.column.getBoundingClientRect().width),
      });
    }
    onWidthChange?.();
  };

  const nudge = (side: ContentWidthSide, key: "ArrowLeft" | "ArrowRight" | "Home" | "End", shift: boolean) => {
    const geometry = measure();
    if (!geometry) return;
    const { column, bounds } = geometry;
    const current = clampContentWidth(column.getBoundingClientRect().width, bounds);
    if (key === "Home") return commit(bounds.min, bounds);
    if (key === "End") return commit(bounds.max, bounds);
    commit(contentWidthForKey(current, key, side, bounds, shift), bounds);
  };

  const handleProps = (side: ContentWidthSide) => ({
    role: "separator" as const,
    "aria-orientation": "vertical" as const,
    "aria-label": side === "left" ? "调整正文宽度（左）" : "调整正文宽度（右）",
    "aria-valuemin": a11y?.min,
    "aria-valuemax": a11y?.max,
    "aria-valuenow": a11y?.now,
    tabIndex: available ? 0 : -1,
    title: "拖动调整正文宽度，双击恢复默认",
    onPointerDown: beginDrag(side),
    // `dblclick` 兜底：`pointerdown` 里的 `detail` 判据在部分合成事件 / 触控板路径下拿不到，
    // 两条都接上（`resetToPreset()` 幂等，重复触发没有副作用）。
    onDoubleClick: resetToPreset,
    onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") {
        event.preventDefault();
        nudge(side, event.key, event.shiftKey);
      }
    },
  });

  return (
    <div className="content-resize" ref={rootRef}>
      <div className="content-resize__handle content-resize__handle--left" {...handleProps("left")} />
      <div className="content-resize__handle content-resize__handle--right" {...handleProps("right")} />
    </div>
  );
}
