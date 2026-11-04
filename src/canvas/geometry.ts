/**
 * 画布几何的纯函数：分组容器的「谁在框里」、框选打包的包围盒、从连线桩拖到
 * 空白处建卡的落点。视图层（CanvasView）只负责把 React Flow 的运行时节点
 * 换算成 `CanvasRect` 喂进来，判定规则集中在这里，好测。
 */
import type { CanvasNodeSide } from "./types";

export interface CanvasRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** b 是否**完整**落在 a 里（贴边算在里面）。 */
function contains(a: CanvasRect, b: CanvasRect): boolean {
  return b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height;
}

/**
 * 分组的子节点 = 几何上完整落在分组框里的节点（与 Obsidian 同一判据：
 * 规范不建模归属，框住就是子节点）。嵌套分组的孙节点同样完整落在外层框里，
 * 天然一并收进来；多个分组同时拖动时取并集，不会重复位移。
 *
 * `exclude` 是本来就在被拖动的节点（选区）：React Flow 自己会移动它们，
 * 再收进来就移两遍。
 */
export function groupChildren(
  rects: readonly CanvasRect[],
  groupIds: ReadonlySet<string>,
  exclude: ReadonlySet<string>,
): Set<string> {
  const groups = rects.filter((rect) => groupIds.has(rect.id));
  const children = new Set<string>();
  for (const rect of rects) {
    if (exclude.has(rect.id) || groupIds.has(rect.id)) continue;
    if (groups.some((group) => contains(group, rect))) children.add(rect.id);
  }
  return children;
}

/** 打包成分组时框与内容的留白：上边多留一截给分组名。 */
export const GROUP_PADDING = { top: 48, side: 32, bottom: 32 };

/** 一组矩形的包围盒外扩 `GROUP_PADDING`（新分组的几何）；空输入返回 null。 */
export function groupBoundsAround(rects: readonly CanvasRect[]): { x: number; y: number; width: number; height: number } | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  return {
    x: Math.round(minX - GROUP_PADDING.side),
    y: Math.round(minY - GROUP_PADDING.top),
    width: Math.round(maxX - minX + GROUP_PADDING.side * 2),
    height: Math.round(maxY - minY + GROUP_PADDING.top + GROUP_PADDING.bottom),
  };
}

const OPPOSITE: Record<CanvasNodeSide, CanvasNodeSide> = { top: "bottom", right: "left", bottom: "top", left: "right" };

export function oppositeSide(side: CanvasNodeSide): CanvasNodeSide {
  return OPPOSITE[side];
}

/**
 * 从某侧连线桩拖到空白处松手：新卡以「对侧」迎向来线，那一侧的中点落在松手点上
 * （从右桩拖出 → 新卡左边中点在指针处，卡片向右展开）。返回新卡左上角与它的吸附侧。
 */
export function placeForConnectionDrop(
  fromSide: CanvasNodeSide,
  point: { x: number; y: number },
  size: { width: number; height: number },
): { x: number; y: number; toSide: CanvasNodeSide } {
  const toSide = oppositeSide(fromSide);
  const { width, height } = size;
  const at = (x: number, y: number) => ({ x: Math.round(x), y: Math.round(y), toSide });
  if (toSide === "left") return at(point.x, point.y - height / 2);
  if (toSide === "right") return at(point.x - width, point.y - height / 2);
  if (toSide === "top") return at(point.x - width / 2, point.y);
  return at(point.x - width / 2, point.y - height);
}

/** 粘贴进来的纯文本该建什么卡：单独一行 http(s) 网址 → 网页卡，其余 → 文本卡。 */
export function classifyPastedText(text: string): { kind: "link"; url: string } | { kind: "text"; text: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/^https?:\/\/\S+$/i.test(trimmed)) return { kind: "link", url: trimmed };
  return { kind: "text", text: text.replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, "") };
}
