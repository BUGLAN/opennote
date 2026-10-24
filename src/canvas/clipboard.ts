/**
 * 画布的模块级剪贴板（跨画布粘贴可用）+ 选区收集/副本生成的纯函数。
 *
 * 剪贴板存**契约节点与边的深拷贝**（序列化前的领域对象，不是 React Flow 的
 * 运行时形状）：模块级单例意味着「在 A 画布复制、切到 B 画布粘贴」天然成立，
 * 不需要把剪贴板提升到应用状态。
 */
import type { CanvasDocument, CanvasEdge, CanvasNode } from "./types";

/** 剪贴板载荷：一组节点 + 连接这些节点的边。 */
export interface CanvasClipboard {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

let storage: CanvasClipboard | null = null;

/** 深拷贝写入（之后视图层的任何改动都碰不到剪贴板里的内容）。 */
export function setClipboard(payload: CanvasClipboard): void {
  storage = { nodes: payload.nodes.map((node) => clone(node)), edges: payload.edges.map((edge) => clone(edge)) };
}

/** 读出的是**副本**；空剪贴板返回 null。 */
export function getClipboard(): CanvasClipboard | null {
  if (!storage) return null;
  return { nodes: storage.nodes.map((node) => clone(node)), edges: storage.edges.map((edge) => clone(edge)) };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 从文档里收集选区：选中的节点 + 「两端都在选中节点集合里」的边（无论边自身
 * 是否被选中 —— 框选一组卡片时它们之间的连线理应跟着走）；被单独选中的边，
 * 只要两端节点都在载荷里，也一并带上。
 */
export function collectSelection(
  doc: CanvasDocument,
  selectedNodeIds: ReadonlySet<string>,
  selectedEdgeIds: ReadonlySet<string>,
): CanvasClipboard {
  const nodes = doc.nodes.filter((node) => selectedNodeIds.has(node.id));
  const inPayload = new Set(nodes.map((node) => node.id));
  const edges = doc.edges.filter(
    (edge) =>
      inPayload.has(edge.fromNode) &&
      inPayload.has(edge.toNode) &&
      (selectedEdgeIds.has(edge.id) || selectedNodeIds.has(edge.fromNode) || selectedNodeIds.has(edge.toNode)),
  );
  return { nodes: nodes.map((node) => clone(node)), edges: edges.map((edge) => clone(edge)) };
}

export interface ClipboardIdGen {
  newNodeId(taken: ReadonlySet<string>): string;
  newEdgeId(taken: ReadonlySet<string>): string;
}

export interface MaterializedClipboard {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/**
 * 把剪贴板载荷落成可插入文档的副本：全部节点/边换新 id（旧 id → 新 id 的映射
 * 同步改写边的端点引用），坐标整体平移 `offset`。id 生成器由调用方注入 ——
 * 视图传 ids.ts 的随机生成器，测试传确定序列。
 */
export function materializeClipboard(
  payload: CanvasClipboard,
  takenIds: Iterable<string>,
  gen: ClipboardIdGen,
  offset: { x: number; y: number },
): MaterializedClipboard {
  const taken = new Set(takenIds);
  const idMap = new Map<string, string>();
  const nodes: CanvasNode[] = payload.nodes.map((node) => {
    const id = gen.newNodeId(taken);
    taken.add(id);
    idMap.set(node.id, id);
    return {
      ...clone(node),
      id,
      x: round2(Number(node.x) + offset.x),
      y: round2(Number(node.y) + offset.y),
    } as CanvasNode;
  });
  // 端点没被一起复制的边（收集时已按两端在场过滤，这里是防御）直接丢弃。
  const edges: CanvasEdge[] = [];
  for (const edge of payload.edges) {
    const fromNode = idMap.get(edge.fromNode);
    const toNode = idMap.get(edge.toNode);
    if (!fromNode || !toNode) continue;
    const id = gen.newEdgeId(taken);
    taken.add(id);
    edges.push({ ...clone(edge), id, fromNode, toNode });
  }
  return { nodes, edges };
}

/** 与视图层拖动落定同一舍入：两位小数，浮点误差不进序列化。 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 载荷的包围盒（粘贴时对齐视口中心用）；空载荷返回 null。 */
export function clipboardBounds(payload: CanvasClipboard): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (payload.nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of payload.nodes) {
    const width = typeof node.width === "number" && Number.isFinite(node.width) ? node.width : 0;
    const height = typeof node.height === "number" && Number.isFinite(node.height) ? node.height : 0;
    minX = Math.min(minX, Number(node.x));
    minY = Math.min(minY, Number(node.y));
    maxX = Math.max(maxX, Number(node.x) + width);
    maxY = Math.max(maxY, Number(node.y) + height);
  }
  return { minX, minY, maxX, maxY };
}
