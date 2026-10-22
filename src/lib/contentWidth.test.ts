import { describe, expect, it } from "vitest";
import {
  CONTENT_WIDTH_SAFE_EDGE,
  clampContentWidth,
  contentWidthBounds,
  contentWidthForKey,
  contentWidthFromDrag,
  normalizeContentWidth,
  resolveMeasureWidth,
} from "./contentWidth";

/**
 * 正文宽度拖拽的**纯计算**护栏（指针行为在 `components/ContentWidthHandles.tsx`，
 * 几何要真浏览器；单测只守「边界与换算」这些能写死的契约）。
 *
 * 最容易被改坏的两条：
 *  1. 拖动换算：正文居中 ⇒ 指针移动 `dx`、总宽变化 `2dx`。写成 `dx` 会让手感
 *     只有一半速，且左右两个把手的速度看起来不一致（第一眼就是「拖不动」）。
 *  2. 持久化兜底：手改 localStorage / 旧版本残留可能塞进 `"" / "abc" / true`，
 *     一律当「没设置」，不能变成 0 或 NaN 写进 CSS。
 */
describe("normalizeContentWidth", () => {
  it("合法的数字与数字字符串原样取整", () => {
    expect(normalizeContentWidth(880)).toBe(880);
    expect(normalizeContentWidth(880.4)).toBe(880);
    expect(normalizeContentWidth("912")).toBe(912);
  });

  it("坏值一律当「没设置」（null），不能变成 0 / NaN", () => {
    expect(normalizeContentWidth(null)).toBeNull();
    expect(normalizeContentWidth(undefined)).toBeNull();
    expect(normalizeContentWidth("")).toBeNull();
    expect(normalizeContentWidth("   ")).toBeNull();
    expect(normalizeContentWidth("abc")).toBeNull();
    expect(normalizeContentWidth(Number.NaN)).toBeNull();
    expect(normalizeContentWidth(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeContentWidth(true)).toBeNull();
    expect(normalizeContentWidth(0)).toBeNull();
    expect(normalizeContentWidth(-100)).toBeNull();
  });

  it("离谱的大值夹到上限（手改 localStorage 不能把正文撑到无限宽）", () => {
    expect(normalizeContentWidth(1e9)).toBe(20_000);
  });
});

describe("resolveMeasureWidth", () => {
  it("rem / px / % 三种预设都能算成像素", () => {
    expect(resolveMeasureWidth("46rem", 16, 1200)).toBe(736);
    expect(resolveMeasureWidth("46rem", 18, 1200)).toBe(828);
    expect(resolveMeasureWidth("736px", 16, 1200)).toBe(736);
    expect(resolveMeasureWidth("100%", 16, 1200)).toBe(1200);
  });

  it("解析不了 / 非正值退回默认 46rem，不让坏值把正文算成 0", () => {
    expect(resolveMeasureWidth("", 16, 1200)).toBe(736);
    expect(resolveMeasureWidth("auto", 16, 1200)).toBe(736);
    expect(resolveMeasureWidth("0px", 16, 1200)).toBe(736);
  });
});

describe("contentWidthBounds", () => {
  it("最小值 = 当前栏宽预设，最大值 = 可用宽度与视口宽度里更小的那个减去安全边距", () => {
    const bounds = contentWidthBounds({ presetWidth: 736, containerWidth: 1200, viewportWidth: 1440 });
    expect(bounds.min).toBe(736);
    expect(bounds.max).toBe(1200 - CONTENT_WIDTH_SAFE_EDGE * 2);
  });

  it("窗口比容器更窄时按视口算（拖拽条不能贴到屏幕边缘之外）", () => {
    const bounds = contentWidthBounds({ presetWidth: 400, containerWidth: 1200, viewportWidth: 900 });
    expect(bounds.max).toBe(900 - 32 * 2);
  });

  it("预设已经比可用宽度还宽（窄窗 / 满幅）时，min 也夹到 max，范围为空", () => {
    const bounds = contentWidthBounds({ presetWidth: 1400, containerWidth: 800, viewportWidth: 800 });
    expect(bounds.min).toBe(bounds.max);
    expect(bounds.max - bounds.min).toBeLessThan(4);
  });
});

describe("contentWidthFromDrag / contentWidthForKey", () => {
  const bounds = { min: 700, max: 1100 };

  it("右把手往右拖 dx ⇒ 总宽 +2dx（正文居中，两侧各让 dx）", () => {
    expect(contentWidthFromDrag(700, 50, "right", bounds)).toBe(800);
    expect(contentWidthFromDrag(700, -50, "right", bounds)).toBe(700);
  });

  it("左把手往左拖 dx ⇒ 总宽 +2dx；往右拖变窄", () => {
    expect(contentWidthFromDrag(900, -50, "left", bounds)).toBe(1000);
    expect(contentWidthFromDrag(900, 50, "left", bounds)).toBe(800);
  });

  it("到边界就停住（拖出窗口也不会越界）", () => {
    expect(contentWidthFromDrag(700, -9999, "right", bounds)).toBe(700);
    expect(contentWidthFromDrag(700, 9999, "right", bounds)).toBe(1100);
  });

  it("键盘：右把手 → 变宽、← 变窄；左把手方向相反；Shift 走大步", () => {
    expect(contentWidthForKey(800, "ArrowRight", "right", bounds)).toBe(816);
    expect(contentWidthForKey(800, "ArrowLeft", "right", bounds)).toBe(784);
    expect(contentWidthForKey(800, "ArrowLeft", "left", bounds)).toBe(816);
    expect(contentWidthForKey(800, "ArrowRight", "left", bounds)).toBe(784);
    expect(contentWidthForKey(800, "ArrowRight", "right", bounds, true)).toBe(864);
  });

  it("clamp：非数字退回最小值", () => {
    expect(clampContentWidth(Number.NaN, bounds)).toBe(700);
  });
});
