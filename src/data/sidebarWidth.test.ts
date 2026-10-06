import { describe, expect, it } from "vitest";
import { DEFAULT_UI, SIDEBAR_WIDTH, clampSidebarWidth } from "./types";

describe("clampSidebarWidth", () => {
  it("区间内的值原样保留（取整）", () => {
    expect(clampSidebarWidth(268)).toBe(268);
    expect(clampSidebarWidth(300.4)).toBe(300);
  });

  it("越界值夹到边界：旧版本没有这个键、手改过 localStorage、拖到窗口外都会留下越界值", () => {
    expect(clampSidebarWidth(10)).toBe(SIDEBAR_WIDTH.min);
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_WIDTH.max);
  });

  it("非数字一律退回默认值（不是 NaN、不是 0、不是最小值）", () => {
    expect(clampSidebarWidth(undefined)).toBe(SIDEBAR_WIDTH.default);
    // `Number(null)` / `Number("")` 都是 0：直接夹取会得到最小值 200，
    // 那就把一个坏值当成了「用户选了最窄的侧栏」。
    expect(clampSidebarWidth(null)).toBe(SIDEBAR_WIDTH.default);
    expect(clampSidebarWidth("")).toBe(SIDEBAR_WIDTH.default);
    expect(clampSidebarWidth("abc")).toBe(SIDEBAR_WIDTH.default);
    expect(clampSidebarWidth(NaN)).toBe(SIDEBAR_WIDTH.default);
    expect(clampSidebarWidth(Infinity)).toBe(SIDEBAR_WIDTH.default);
    expect(clampSidebarWidth(true)).toBe(SIDEBAR_WIDTH.default);
  });

  it("默认值与 tokens.css 的 --sidebar-w 一致（268px）", () => {
    expect(DEFAULT_UI.sidebarWidth).toBe(268);
    expect(SIDEBAR_WIDTH.default).toBe(268);
  });
});
