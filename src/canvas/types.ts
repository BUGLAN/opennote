/**
 * JSON Canvas 1.0（https://jsoncanvas.org/spec/1.0.md，MIT）的领域类型。
 *
 * 只建模数据层需要的部分：`text` / `file` 两种节点是一等公民（`file` 卡片指向
 * 工作区里的另一篇笔记），其余类型（Obsidian 落盘的 `link` / `group`…）不解释、
 * **原样保留** —— 「往返不丢数据」优先于「类型穷举」，别的客户端写入的新类型
 * 经过本库读一遍再存回去，一个字节都不能少。
 *
 * 解析与序列化的实现见 `./jsonCanvas.ts`；这里的 re-export 让消费方
 * （视图层 B 端）只 import 这一个文件就能拿到全部契约。
 */

/** 边吸附到节点的哪一侧。 */
export type CanvasNodeSide = "top" | "right" | "bottom" | "left";

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
 */
export interface CanvasFileNode extends CanvasNodeBase {
  type: "file";
  file: string;
}

/**
 * 未知类型节点：`type` 保留原文（只要不是 `"text"` / `"file"`），全部字段按
 * 解析原样保留。**不继承 `CanvasNodeBase`** —— 结构上只要求 `id` 与 `type`：
 * 对不认识的类型强校验 x/y/width/height，缺了就只能整节点丢弃，与「全部字段
 * 原样保留」矛盾。几何字段若存在，自然躺在索引签名里跟着走。
 */
export interface CanvasUnknownNode {
  type: string;
  id: string;
  [key: string]: unknown;
}

export type CanvasNode = CanvasTextNode | CanvasFileNode | CanvasUnknownNode;

/**
 * 连线。`fromSide` / `toSide` / `label` 可选；未知字段原样保留
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

/* ------------------------------------------------------------------ 判别辅助 */

/**
 * `CanvasUnknownNode.type` 是 `string`，TS 无法靠判别联合自动收窄
 * （`node.type === "text"` 之后 `CanvasUnknownNode & { type: "text" }` 仍留在
 * 分支里），所以消费方一律走这三个守卫，不要手写 `===` 收窄。
 */
export function isCanvasTextNode(node: CanvasNode): node is CanvasTextNode {
  return node.type === "text";
}

export function isCanvasFileNode(node: CanvasNode): node is CanvasFileNode {
  return node.type === "file";
}

export function isCanvasUnknownNode(node: CanvasNode): node is CanvasUnknownNode {
  return node.type !== "text" && node.type !== "file";
}

/* --------------------------------------------------- 解析/序列化（实现在隔壁） */

export { parseCanvas, serializeCanvas } from "./jsonCanvas";
