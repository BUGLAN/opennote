/**
 * JSON Canvas 1.0 的解析与序列化（`parseCanvas` / `serializeCanvas`，契约见
 * `./types.ts）。两条硬纪律：
 *
 * 1. **`parseCanvas` 对任何输入都不抛异常** —— 画布是磁盘上的普通文件，别的
 *    工具写坏的版本必须能被打开（哪怕只读到一篇空文档 + 一条带行号的错误）。
 * 2. **往返幂等**：`serializeCanvas(parseCanvas(serializeCanvas(doc))) ===
 *    serializeCanvas(doc)` —— 序列化输出的字段序是唯一范式（node:
 *    id,type,x,y,width,height,类型字段,未知字段按原插入序；edge:
 *    id,fromNode,fromSide,toNode,toSide,label,color,fromEnd,toEnd,未知字段），
 *    `JSON.parse` 又按文档序还原对象键序，于是第二次序列化逐字节复现第一次。
 */
import type {
  CanvasDocument,
  CanvasEdge,
  CanvasEdgeEnd,
  CanvasFileNode,
  CanvasGroupNode,
  CanvasHtmlNode,
  CanvasLinkNode,
  CanvasNode,
  CanvasNodeSide,
  CanvasParseError,
  CanvasParseResult,
  CanvasTextNode,
  CanvasUnknownNode,
} from "./types";
import { isCanvasFileNode, isCanvasGroupNode, isCanvasHtmlNode, isCanvasLinkNode, isCanvasTextNode } from "./types";

const SIDES: readonly string[] = ["top", "right", "bottom", "left"];
const ENDS: readonly string[] = ["none", "arrow"];

function isSide(value: unknown): value is CanvasNodeSide {
  return typeof value === "string" && (SIDES as string[]).includes(value);
}

function isEdgeEnd(value: unknown): value is CanvasEdgeEnd {
  return typeof value === "string" && (ENDS as string[]).includes(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * JSON 语法错误的 1 基行号，三层取值：
 *   ① 新版 V8 的报错直接带 `line L column C` —— 用它；
 *   ② 旧版 V8 带 `position N` —— 换算成「前 N 个字符里有几个换行」；
 *   ③ 都没有（`Unexpected token 'X', "…snippet…" is not valid JSON` 这类只有
 *      上下文片段的）—— 自写一个 O(n) 语法扫描器定位首个非法 token 的行。
 * `line` 只是排查线索，不是判定依据（致命与否看 `ref` 缺省），所以扫描器只需
 * 「接受一切合法 JSON + 对常见语病给出正确行号」，不追求与 V8 的报错点逐字符一致。
 */
function syntaxErrorLine(text: string, error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const lineMatch = /line (\d+)/i.exec(message);
  if (lineMatch) {
    const direct = Number(lineMatch[1]);
    if (Number.isFinite(direct) && direct > 0) return direct;
  }
  const position = /position (\d+)/i.exec(message);
  if (position) {
    const index = Number(position[1]);
    if (Number.isFinite(index) && index >= 0) {
      let line = 1;
      for (let i = 0; i < Math.min(index, text.length); i += 1) {
        if (text.charCodeAt(i) === 10) line += 1;
      }
      return line;
    }
  }
  return scanJsonLine(text);
}

/**
 * 轻量 JSON 语法扫描（只为行号服务，不替代 `JSON.parse` 的判定）：
 * 显式栈跟踪 `{[` 嵌套与「下一个合法 token 类别」，遇到不该出现的字符就返回
 * 当前行；扫完仍合法（截断/极端语病）返回 `undefined` 交给上层缺省。
 */
function scanJsonLine(text: string): number | undefined {
  type Expect = "value" | "key" | "colon" | "comma-or-close" | "end";
  const n = text.length;
  let i = 0;
  let line = 1;
  let expect: Expect = "value";
  let afterComma = false;
  const stack: ("{" | "[")[] = [];
  while (i < n) {
    const ch = text[i]!;
    if (ch === "\n") {
      line += 1;
      i += 1;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      i += 1;
      continue;
    }
    if (expect === "end") return line; // 根值结束之后还有内容
    if (ch === '"') {
      // 字符串只在 value / key 位置合法；出现在别处 = 缺逗号/缺冒号一类的语病。
      if (expect !== "value" && expect !== "key") return line;
      i += 1;
      let closed = false;
      while (i < n) {
        const c = text[i]!;
        if (c === "\n") return line; // 字符串不允许裸换行
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === '"') {
          closed = true;
          i += 1;
          break;
        }
        i += 1;
      }
      if (!closed) return line;
      afterComma = false;
      // 字符串结束后：对象里它是 key（等冒号），否则是 value（等逗号/关闭）。
      const inObjectKey: boolean = stack[stack.length - 1] === "{" && expect === "key";
      expect = inObjectKey ? "colon" : "comma-or-close";
      continue;
    }
    if (ch === "{" || ch === "[") {
      if (expect === "comma-or-close" || expect === "colon" || expect === "key") return line;
      stack.push(ch as "{" | "[");
      expect = ch === "{" ? "key" : "value";
      afterComma = false;
      i += 1;
      continue;
    }
    if (ch === "}" || ch === "]") {
      const opener = ch === "}" ? "{" : "[";
      if (stack[stack.length - 1] !== opener) return line;
      // 关闭规则是**非对称**的：} 只在 key（空对象）/ 逗号后（成员结束）合法，
      // value 位置（{"a":}）非法；] 在 value（空数组）/ 逗号后合法。
      if (expect !== "comma-or-close" && expect !== (ch === "}" ? "key" : "value")) return line;
      if (afterComma) return line; // 尾随逗号：[1,] / {"a":1,}
      stack.pop();
      afterComma = false;
      expect = stack.length ? "comma-or-close" : "end";
      i += 1;
      continue;
    }
    if (ch === ":") {
      if (expect !== "colon") return line;
      expect = "value";
      afterComma = false;
      i += 1;
      continue;
    }
    if (ch === ",") {
      if (expect !== "comma-or-close") return line;
      expect = stack[stack.length - 1] === "{" ? "key" : "value";
      afterComma = true;
      i += 1;
      continue;
    }
    if (expect !== "value") return line; // 字面量/数字出现在非法位置
    if (ch === "t" || ch === "f" || ch === "n") {
      const word = ch === "t" ? "true" : ch === "f" ? "false" : "null";
      if (text.startsWith(word, i)) i += word.length;
      else return line;
    } else if (ch === "-" || (ch >= "0" && ch <= "9")) {
      i += 1;
      while (i < n && /[-+.eE0-9]/.test(text[i]!)) i += 1;
    } else {
      return line;
    }
    afterComma = false;
    expect = "comma-or-close";
  }
  return undefined;
}

/**
 * 单个节点 → 领域对象。
 *
 * 已知类型（text/file/link/group/html）缺任何一个必填字段（id / x / y / width /
 * height，text 另需 `text`、file 另需 `file`、link 另需非空 `url`、html 另需
 * `html`（允许空串 = 新建的空白卡）；group 无额外必填字段）都返回 `null`
 * （调用方记 error 并跳过该项，不毁整篇）；未知类型只要求 `id` 与 `type` 是
 * 非空字符串，其余字段原样带走（见 `CanvasUnknownNode` 的注释）。
 */
function parseNode(raw: Record<string, unknown>): CanvasNode | null {
  const { id, type } = raw;
  if (!isNonEmptyString(id) || !isNonEmptyString(type)) return null;
  if (type === "text" || type === "file" || type === "link" || type === "group" || type === "html") {
    const { x, y, width, height } = raw;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) return null;
    if (type === "text") {
      if (typeof raw.text !== "string") return null;
      // 展开保留未知字段；随后的具名赋值不会移动既有键的位置（只覆写值），
      // 所以解析产物保持了源文档的键序 —— 序列化侧的字段序稳定靠这个。
      return { ...raw, id, type, x, y, width, height, text: raw.text } as CanvasTextNode;
    }
    if (type === "file") {
      if (typeof raw.file !== "string") return null;
      return { ...raw, id, type, x, y, width, height, file: raw.file } as CanvasFileNode;
    }
    if (type === "link") {
      if (!isNonEmptyString(raw.url)) return null;
      return { ...raw, id, type, x, y, width, height, url: raw.url } as CanvasLinkNode;
    }
    if (type === "html") {
      // 空串合法：新建的空白 HTML 卡就是空内容（与 text 卡同一取舍）。
      if (typeof raw.html !== "string") return null;
      return { ...raw, id, type, x, y, width, height, html: raw.html } as CanvasHtmlNode;
    }
    return { ...raw, id, type, x, y, width, height } as CanvasGroupNode;
  }
  return { ...raw, id, type } as CanvasUnknownNode;
}

/** 单条边 → 领域对象；缺 id / fromNode / toNode（非空字符串）返回 `null`。 */
function parseEdge(raw: Record<string, unknown>): CanvasEdge | null {
  const { id, fromNode, toNode } = raw;
  if (!isNonEmptyString(id) || !isNonEmptyString(fromNode) || !isNonEmptyString(toNode)) return null;
  return { ...raw, id, fromNode, toNode } as CanvasEdge;
}

/**
 * 解析一份画布文本。任何输入都不抛异常：
 * - JSON 语法错 → 空 doc + 带 `line` 的 error（`ref` 缺省 = 整篇级）；
 * - 根不是对象 → 空 doc + 整篇级 error；
 * - `nodes` / `edges` 顶层缺失视为空数组（规范允许省略），类型不对则记
 *   `ref: "nodes"` / `ref: "edges"` 的整篇级 error 并按空数组处理；
 * - 单个节点/边缺必填字段 → 跳过该项并记带 `ref` 的 error，其余照常。
 */
export function parseCanvas(text: string): CanvasParseResult {
  const doc: CanvasDocument = { nodes: [], edges: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const line = syntaxErrorLine(text, error);
    const message = error instanceof Error ? error.message : String(error);
    return { doc, errors: line === undefined ? [{ message }] : [{ message, line }] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { doc, errors: [{ message: "画布根节点必须是 JSON 对象" }] };
  }
  const root = parsed as Record<string, unknown>;
  const errors: CanvasParseError[] = [];

  const nodes = root.nodes;
  if (nodes === undefined) {
    // 缺失 = 空数组，不算错误（与规范一致）。
  } else if (Array.isArray(nodes)) {
    nodes.forEach((item, index) => {
      const ref = `nodes[${index}]`;
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        errors.push({ message: "节点必须是 JSON 对象，已跳过", ref });
        return;
      }
      const node = parseNode(item as Record<string, unknown>);
      if (node) doc.nodes.push(node);
      else errors.push({ message: "节点缺少必填字段（id/type/x/y/width/height 或类型字段），已跳过", ref });
    });
  } else {
    errors.push({ message: "nodes 必须是数组，已按空数组处理", ref: "nodes" });
  }

  const edges = root.edges;
  if (edges === undefined) {
    // 同上：缺失 = 空数组。
  } else if (Array.isArray(edges)) {
    edges.forEach((item, index) => {
      const ref = `edges[${index}]`;
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        errors.push({ message: "连线必须是 JSON 对象，已跳过", ref });
        return;
      }
      const edge = parseEdge(item as Record<string, unknown>);
      if (edge) doc.edges.push(edge);
      else errors.push({ message: "连线缺少必填字段（id/fromNode/toNode），已跳过", ref });
    });
  } else {
    errors.push({ message: "edges 必须是数组，已按空数组处理", ref: "edges" });
  }

  return { doc, errors };
}

/* ---------------------------------------------------------------- 序列化 */

/**
 * 节点 → 按范式字段序重建的普通对象。
 *
 * 已知类型：`id,type,x,y,width,height,类型字段` 固定在前（group 的 `label`、
 * link 的 `url`、html 的 `html` 排在几何之后；label 非字符串时退到未知字段区），
 * 其余未知字段按源对象插入序排在后面；未知类型：整体原样输出（保持源键序，
 * 一个字段都不动）。
 */
function serializeNode(node: CanvasNode): Record<string, unknown> {
  const raw = node as Record<string, unknown>;
  const known =
    isCanvasTextNode(node) ||
    isCanvasFileNode(node) ||
    isCanvasLinkNode(node) ||
    isCanvasGroupNode(node) ||
    isCanvasHtmlNode(node);
  if (!known) return { ...raw };
  const out: Record<string, unknown> = {
    id: raw.id,
    type: raw.type,
    x: raw.x,
    y: raw.y,
    width: raw.width,
    height: raw.height,
  };
  if (isCanvasTextNode(node)) out.text = raw.text;
  else if (isCanvasFileNode(node)) out.file = raw.file;
  else if (isCanvasLinkNode(node)) out.url = raw.url;
  else if (isCanvasHtmlNode(node)) out.html = raw.html;
  else if (typeof raw.label === "string") out.label = raw.label;
  const emitted = new Set(Object.keys(out));
  for (const [key, value] of Object.entries(raw)) {
    if (!emitted.has(key)) out[key] = value;
  }
  return out;
}

/**
 * 边 → 按范式字段序重建的普通对象。
 *
 * 已知可选字段只在**类型正确**时占自己的槽位：`fromSide`/`toSide` 必须是四个
 * 方向之一、`label`/`color` 必须是字符串、`fromEnd`/`toEnd` 必须是
 * none/arrow 之一；类型不对的值整体落到未知字段区原样输出
 * （不丢字节，也不再冒充合法方向）。
 */
function serializeEdge(edge: CanvasEdge): Record<string, unknown> {
  const raw = edge as Record<string, unknown>;
  const out: Record<string, unknown> = { id: raw.id, fromNode: raw.fromNode };
  if (isSide(raw.fromSide)) out.fromSide = raw.fromSide;
  out.toNode = raw.toNode;
  if (isSide(raw.toSide)) out.toSide = raw.toSide;
  if (typeof raw.label === "string") out.label = raw.label;
  if (typeof raw.color === "string") out.color = raw.color;
  if (isEdgeEnd(raw.fromEnd)) out.fromEnd = raw.fromEnd;
  if (isEdgeEnd(raw.toEnd)) out.toEnd = raw.toEnd;
  const emitted = new Set(Object.keys(out));
  for (const [key, value] of Object.entries(raw)) {
    if (!emitted.has(key)) out[key] = value;
  }
  return out;
}

/**
 * 序列化一份画布文档：`nodes` 在前、`edges` 在后，两空格缩进，结尾恰好一个
 * `\n`（与 Obsidian 落盘形态一致，diff 友好）。
 *
 * 不做校验 —— 校验是 `parseCanvas` 的职责；对内存里拼出的非法文档
 * （text 不是字符串之类）按原样输出，读回来时自然会被解析器拦下。
 */
export function serializeCanvas(doc: CanvasDocument): string {
  const payload = {
    nodes: doc.nodes.map(serializeNode),
    edges: doc.edges.map(serializeEdge),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}
