/**
 * 正文栏宽（`--measure`）的手动拖拽支持。
 *
 * 这个模块只放**纯计算**：读取设置、解析 CSS 长度、夹取边界、把指针位移换算成宽度。
 * 指针与 DOM 逻辑在 `components/ContentWidthHandles.tsx`，这样单测不需要浏览器
 * （本仓库的 vitest 跑在 node 环境，量不出布局）。
 *
 * 三条约定：
 *  1. 拖拽改变的是**正文栏的宽度**（`.cm-content` / `.reading` 的 `max-width`），不是
 *     编辑器外壳的宽度。正文始终水平居中，所以指针移动 1px、左右两侧各让 1px，
 *     总宽度变化 2px。
 *  2. 最小值 = 当前「设置 · 栏宽」预设换算出来的宽度 —— 拖拽只能把正文栏调宽，双击
 *     拖拽条清掉自定义值即可回到预设。改预设时也会清掉自定义值，两套入口不打架。
 *  3. 最大值同时受**编辑器可用宽度**（减去两侧安全边距）与**视口宽度**约束：正文栏
 *     不能顶到侧栏 / 大纲或屏幕边缘，拖拽条本身也永远留得住。
 */

/**
 * 正文栏与编辑器可用区边缘之间至少留出的空白（px，两侧各一份）。
 *
 * 28 = 16（拖拽条命中区，见 `ContentWidthHandles` 与 app.css 的 `.content-resize__handle`）
 * + 10（`.cm-scroller` 的竖直滚动条）+ 2（留给描边的余量）。
 * 少了这一截，拖到最宽时把手会盖住滚动条，用户想拖滚动条反而拖动了正文宽度。
 */
export const CONTENT_WIDTH_SAFE_EDGE = 28;

/** 正文栏与视口边缘之间的安全边距（px，两侧各一份）。 */
export const CONTENT_WIDTH_VIEWPORT_MARGIN = 32;

/** 键盘微调步长：普通 16px，按住 Shift 64px（和侧栏把手同一套手感）。 */
export const CONTENT_WIDTH_STEP = 16;
export const CONTENT_WIDTH_STEP_COARSE = 64;

/** 可用范围小于这个值就不显示拖拽条（拖了也看不出变化）。 */
export const CONTENT_WIDTH_MIN_RANGE = 4;

/** `--measure` 缺失时的兜底：46rem，与 tokens.css 的默认值一致。 */
const FALLBACK_MEASURE_REM = 46;

/** 持久化值的合理区间：挡住手改 localStorage 的 0 / 负数 / 1e9。 */
const STORED_MIN = 240;
const STORED_MAX = 20_000;

export type ContentWidthSide = "left" | "right";

export interface ContentWidthBounds {
  /** 可拖到的最窄值（= 当前栏宽预设）。 */
  min: number;
  /** 可拖到的最宽值（编辑器可用宽度 / 视口宽度减去安全边距）。 */
  max: number;
}

/**
 * 把 localStorage 里读到的任意值规范成「合法像素宽度」或 `null`（= 未设置）。
 *
 * 只认有限正数（数字或数字字符串）；`null` / `""` / `"abc"` / `NaN` / `Infinity` 一律
 * 当未设置。上下界只是防手改的兜底，真正的布局夹取在 `contentWidthBounds()` 里做。
 */
export function normalizeContentWidth(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const width = Number(value);
  if (!Number.isFinite(width) || width <= 0) return null;
  return Math.min(STORED_MAX, Math.max(STORED_MIN, Math.round(width)));
}

/**
 * 把 `--measure` 的计算值解析成像素。
 *
 * 支持 `46rem` / `736px` / `100%` 三种（tokens.css 的四个栏宽预设只会产出这三种）。
 * 解析不了就退回 46rem —— 宁可回到默认宽度，也不要让一个坏值把正文栏算成 0。
 */
export function resolveMeasureWidth(measure: string, rootFontSize: number, containerWidth: number): number {
  const root = Number.isFinite(rootFontSize) && rootFontSize > 0 ? rootFontSize : 16;
  const match = /^(-?\d+(?:\.\d+)?)(px|rem|em|%)?$/.exec(measure.trim());
  if (!match) return FALLBACK_MEASURE_REM * root;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return FALLBACK_MEASURE_REM * root;
  switch (match[2]) {
    case "%":
      return (Math.max(0, containerWidth) * value) / 100;
    case "px":
      return value;
    case "rem":
    case "em":
      return value * root;
    default:
      return FALLBACK_MEASURE_REM * root;
  }
}

/**
 * 计算当前布局下正文栏的可拖范围。
 *
 * `presetWidth` 是当前栏宽预设的像素值（= 最小值）；`containerWidth` 是编辑器滚动区
 * 的 clientWidth（已经扣掉竖直滚动条）；`viewportWidth` 是 `window.innerWidth`。
 * 两者取更严格的那个，再各减去两侧安全边距。
 */
export function contentWidthBounds(input: {
  presetWidth: number;
  containerWidth: number;
  viewportWidth: number;
}): ContentWidthBounds {
  const containerMax = input.containerWidth - CONTENT_WIDTH_SAFE_EDGE * 2;
  const viewportMax = input.viewportWidth - CONTENT_WIDTH_VIEWPORT_MARGIN * 2;
  const max = Math.max(0, Math.floor(Math.min(containerMax, viewportMax)));
  // 预设本身已经比可用区宽（窄窗口 / 宽栏预设）时，最小值也夹到 max：
  // 此时范围为空，组件会直接隐藏拖拽条，而不是让它一点拖动就跳。
  const min = Math.min(Math.max(0, Math.round(input.presetWidth)), max);
  return { min, max: Math.max(min, max) };
}

/** 把任意宽度夹进 `[min, max]`；非数字退回 min。 */
export function clampContentWidth(value: number, bounds: ContentWidthBounds): number {
  if (!Number.isFinite(value)) return bounds.min;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
}

/**
 * 把「指针相对按下点的水平位移」换算成正文栏宽度。
 *
 * 正文居中：右把手往右拖 `dx`、左右两侧各向外 `dx`，总宽度增加 `2dx`；
 * 左把手往左拖同理（`outward = -dx`）。到边界时返回夹取后的值，把手自然停住。
 */
export function contentWidthFromDrag(
  startWidth: number,
  deltaX: number,
  side: ContentWidthSide,
  bounds: ContentWidthBounds,
): number {
  const outward = side === "right" ? deltaX : -deltaX;
  return clampContentWidth(startWidth + outward * 2, bounds);
}

/**
 * 键盘方向键换算。← / → 的语义与「移动分隔条」一致：
 * 右把手按 → 变宽、左把手按 ← 变宽；另一侧反向。
 */
export function contentWidthForKey(
  currentWidth: number,
  key: "ArrowLeft" | "ArrowRight",
  side: ContentWidthSide,
  bounds: ContentWidthBounds,
  coarse = false,
): number {
  const step = coarse ? CONTENT_WIDTH_STEP_COARSE : CONTENT_WIDTH_STEP;
  const outward = key === "ArrowRight" ? 1 : -1;
  const delta = side === "right" ? outward : -outward;
  return clampContentWidth(currentWidth + delta * step, bounds);
}
