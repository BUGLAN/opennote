/**
 * JSON Canvas 1.0（https://jsoncanvas.org/spec/1.0.md，MIT）的领域类型。
 *
 * 一等公民节点：`text` / `file` / `link` / `group`（视图可建可改）；本库私有扩展
 * `html`（内嵌 HTML 卡，渲染走 `src/html/` 的沙箱）；其余类型（Obsidian 或别的
 * 客户端写入的 `embed`…）不解释、**原样保留** —— 「往返不丢数据」优先于「类型
 * 穷举」，别的客户端写入的新类型经过本库读一遍再存回去，一个字节都不能少。
 * （反过来，别家遇到 `html` 也只会当未知类型原样保留，互操作安全。）
 *
 * 解析与序列化的实现见 `./jsonCanvas.ts`；这里的 re-export 让消费方
 * （视图层 B 端）只 import 这一个文件就能拿到全部契约。
 */

/** 边吸附到节点的哪一侧。 */
export type CanvasNodeSide = "top" | "right" | "bottom" | "left";

/** 边端点的箭头形态（规范只定义 none / arrow 两种）。 */
export type CanvasEdgeEnd = "none" | "arrow";

/**
 * 已知类型节点的公共几何字段（规范要求 id + 矩形）。
 *
 * 索引签名与 `CanvasEdge` 同款：规范允许节点携带任意附加属性（`color`…），
 * 序列化按「已知字段在前、未知字段按插入序在后」输出，类型上必须容得下它们。
 */
export interface CanvasNodeBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 规范预设色（"1"-"6"）或别的工具写入的任意颜色串（hex）；缺省 = 无色。 */
  color?: string;
  [key: string]: unknown;
}

/** 文本卡片。 */
export interface CanvasTextNode extends CanvasNodeBase {
  type: "text";
  text: string;
}

/**
 * 文件卡片：`file` 是**工作区根相对 POSIX 路径**，即目标笔记的 id
 * （与 Obsidian 落盘行为一致）。反斜杠 / `./` 前缀等容错形态由 `../canvas/refs`
 * 的 `normalizeFileRef()` 收口，比较一律在规范化之后做。
 * `subpath`（以 `#` 开头）指向笔记内标题，可选。
 */
export interface CanvasFileNode extends CanvasNodeBase {
  type: "file";
  file: string;
  /** 笔记内定位（`#标题`）；Obsidian 同款形态。 */
  subpath?: string;
}

/** 网页卡片：`url` 必填（解析侧缺 url 的 link 节点整节点跳过）。 */
export interface CanvasLinkNode extends CanvasNodeBase {
  type: "link";
  url: string;
}

/** 分组框：虚线容器，`label` 可选；不建模子节点归属（MVP 容器语义）。 */
export interface CanvasGroupNode extends CanvasNodeBase {
  type: "group";
  label?: string;
}

/**
 * HTML 卡片（本库私有扩展）：`html` 是一篇内嵌的 HTML 文档/片段，卡内渲染走
 * `src/html/` 的沙箱（`HtmlFrame`，与 HTML 页面标签同一套隔离与外链闸门）。
 * 内容归画布所有 —— 不是对笔记本里某个 `.html` 页面的引用（引用走 `file` 卡）。
 */
export interface CanvasHtmlNode extends CanvasNodeBase {
  type: "html";
  html: string;
}

/**
 * 未知类型节点：`type` 保留原文（只要不是四种已知类型），全部字段按
 * 解析原样保留。**不继承 `CanvasNodeBase`** —— 结构上只要求 `id` 与 `type`：
 * 对不认识的类型强校验 x/y/width/height，缺了就只能整节点丢弃，与「全部字段
 * 原样保留」矛盾。几何字段若存在，自然躺在索引签名里跟着走。
 */
export interface CanvasUnknownNode {
  type: string;
  id: string;
  [key: string]: unknown;
}

export type CanvasNode =
  | CanvasTextNode
  | CanvasFileNode
  | CanvasLinkNode
  | CanvasGroupNode
  | CanvasHtmlNode
  | CanvasUnknownNode;

/**
 * 连线。`fromSide` / `toSide` / `label` / `color` / 箭头端可选；未知字段原样保留
 * （序列化时按原插入序排在已知字段之后）。
 *
 * ⚠️ 已知可选字段的**值**不做枚举清洗：`fromSide: "wibble"` 这类越界值会整体
 * 挪到「未知字段」的位置原样输出 —— 丢字节比宽进严出更糟。
 */
export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: CanvasNodeSide;
  toNode: string;
  toSide?: CanvasNodeSide;
  label?: string;
  color?: string;
  fromEnd?: CanvasEdgeEnd;
  toEnd?: CanvasEdgeEnd;
  [key: string]: unknown;
}

/** 一份画布文档。顶层 `nodes` / `edges` 缺失视为空数组。 */
export interface CanvasDocument {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/** 解析时的非致命问题（单节点/边被跳过）与致命问题（整篇读不出）共用这一形状。 */
export interface CanvasParseError {
  message: string;
  /** 致命的 JSON 语法错误才有：1 基行号（从报错的 position 换算）。 */
  line?: number;
  /**
   * 问题定位到哪一项（如 `nodes[3]` / `edges[1]` / `nodes`）。
   * **缺省 = 整篇级错误**（JSON 语法错 / 根不是对象）—— 引用跟随改写靠这条
   * 判据决定「跳过不动」（见 library.ts 的 rewriteCanvasRefs）。
   */
  ref?: string;
}

export interface CanvasParseResult {
  doc: CanvasDocument;
  errors: CanvasParseError[];
}

/* --------------------------------------------------------------- 预设色 */

/**
 * 规范的六个预设色（落盘串 "1"-"6"）。具体色值是**视觉决策**，归 canvas.css 的
 * `--canvas-c-1..6` 令牌（深浅主题各一组）；这里只有名单本身 —— 菜单渲染、
 * 预设判定共用，不允许出现第二份色值表。
 */
export const CANVAS_COLOR_PRESETS = ["1", "2", "3", "4", "5", "6"] as const;

export type CanvasColorPreset = (typeof CANVAS_COLOR_PRESETS)[number];

export function isCanvasColorPreset(value: unknown): value is CanvasColorPreset {
  return typeof value === "string" && (CANVAS_COLOR_PRESETS as readonly string[]).includes(value);
}

/**
 * 画布侧消费的笔记拖拽 MIME（与侧栏源侧共享的契约，一字不改）：
 * data 为笔记 id（工作区相对路径）纯字符串。
 */
export const CANVAS_NOTE_DRAG_MIME = "application/x-opennote-note";

/* --------------------------------------------------------------- 判别辅助 */

/**
 * `CanvasUnknownNode.type` 是 `string`，TS 无法靠判别联合自动收窄
 * （`node.type === "text"` 之后 `CanvasUnknownNode & { type: "text" }` 仍留在
 * 分支里），所以消费方一律走这些守卫，不要手写 `===` 收窄。
 */
export function isCanvasTextNode(node: CanvasNode): node is CanvasTextNode {
  return node.type === "text";
}

export function isCanvasFileNode(node: CanvasNode): node is CanvasFileNode {
  return node.type === "file";
}

export function isCanvasLinkNode(node: CanvasNode): node is CanvasLinkNode {
  return node.type === "link";
}

export function isCanvasGroupNode(node: CanvasNode): node is CanvasGroupNode {
  return node.type === "group";
}

export function isCanvasHtmlNode(node: CanvasNode): node is CanvasHtmlNode {
  return node.type === "html";
}

export function isCanvasUnknownNode(node: CanvasNode): node is CanvasUnknownNode {
  return (
    node.type !== "text" && node.type !== "file" && node.type !== "link" && node.type !== "group" && node.type !== "html"
  );
}

/* --------------------------------------------------------- 箭头端缺省语义 */

/**
 * 边端点的**渲染语义**：规范缺省 fromEnd=none、toEnd=arrow；只有显式写出的
 * 合法值能改变它（越界值不当箭头用，见 CanvasEdge 注释）。
 */
export function effectiveEdgeEnds(edge: CanvasEdge): { fromEnd: CanvasEdgeEnd; toEnd: CanvasEdgeEnd } {
  return {
    fromEnd: edge.fromEnd === "arrow" ? "arrow" : "none",
    toEnd: edge.toEnd === "none" ? "none" : "arrow",
  };
}

/**
 * 按规范缺省语义写一个箭头端：**等于缺省值时删字段**（fromEnd 缺省 none、
 * toEnd 缺省 arrow），落盘只写偏离缺省的端 —— 与 Obsidian 的落盘形态一致。
 */
export function withEdgeEnd(edge: CanvasEdge, end: "fromEnd" | "toEnd", value: CanvasEdgeEnd): CanvasEdge {
  const next: CanvasEdge = { ...edge };
  const isDefault = end === "fromEnd" ? value === "none" : value === "arrow";
  if (isDefault) delete next[end];
  else next[end] = value;
  return next;
}

/* --------------------------------------------------- 解析/序列化（实现在隔壁） */

export { parseCanvas, serializeCanvas } from "./jsonCanvas";
