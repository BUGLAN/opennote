import { useSyncExternalStore } from "react";

/**
 * 「移动端」的判定：窄屏（与 app.css 的抽屉布局同一条 820px 线）或粗指针（触屏）。
 * 平板横屏可能宽于 820px，但没有物理键盘、以阅读为主，所以 `pointer: coarse` 也算。
 */
export const MOBILE_QUERY = "(max-width: 820px), (pointer: coarse)";

/** 订阅一条媒体查询；没有 `matchMedia` 的环境（测试、SSR）恒为 false。 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false),
    () => false,
  );
}

export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}

/** 窄屏：侧栏变抽屉的那条线（app.css 的 `@media (max-width: 820px)`），只看宽度。 */
export const NARROW_QUERY = "(max-width: 820px)";

export function useIsNarrow(): boolean {
  return useMediaQuery(NARROW_QUERY);
}

/**
 * 当前 Markdown 笔记显示成什么：
 * - `locked`：用户手动锁定（`ui.lockedNotes`，持久化）—— 阅读视图，移动端的「编辑」也绕不过去；
 * - `mobile-reading`：移动端默认阅读（会话级 UI 状态，不写回 `lockedNotes`）；
 * - `editing`：编辑器。
 *
 * 只对 Markdown 笔记有意义：画布、HTML 页面各有自己的视图，这里一律当 `editing`（= 不叠阅读视图）。
 */
export type NoteViewMode = "locked" | "mobile-reading" | "editing";

export function noteViewMode(input: {
  isNote: boolean;
  isMobile: boolean;
  /** 手动只读锁（`ui.lockedNotes` 命中）。 */
  locked: boolean;
  /** 本会话里用户在移动端点过「编辑」的笔记。 */
  mobileEditing: boolean;
}): NoteViewMode {
  if (!input.isNote) return "editing";
  if (input.locked) return "locked";
  if (input.isMobile && !input.mobileEditing) return "mobile-reading";
  return "editing";
}
