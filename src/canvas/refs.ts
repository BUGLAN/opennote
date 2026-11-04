/**
 * 画布引用的解析与反向定位（纯函数，不碰文件系统与库状态）。
 *
 * `file` 卡片里的路径由**别的工具**写入，形态不可控（反斜杠、`./` 前缀、
 * 绝对样式的前导 `/`…），所以一切比较都在 `normalizeFileRef()` 规范化之后做 ——
 * 与笔记 id（`normalizePath` 的产物）同一方言，才能「卡片 ↔ 笔记」对上号。
 */
import { normalizePath } from "../fs/paths";
import { parseCanvas } from "./jsonCanvas";
import type { CanvasDocument, CanvasFileNode } from "./types";
import { isCanvasFileNode } from "./types";

/**
 * 把 file 卡片里的引用规范成工作区根相对 POSIX 路径：
 * 反斜杠 → `/`、丢 `./` 与空段、解析 `..`、剥前导 `/`（`normalizePath` 的
 * 全部规则，这里只是给它一个**语义入口** —— 「卡片引用」与「别的什么路径」
 * 各自叫什么名字，读代码的人一眼能分清）。
 */
export function normalizeFileRef(ref: string): string {
  return normalizePath(ref);
}

/** 一份画布里的全部文件卡片（未知类型节点天然不参与引用语义）。 */
export function fileNodesIn(doc: CanvasDocument): CanvasFileNode[] {
  return doc.nodes.filter(isCanvasFileNode);
}

/** 反向定位的命中项：哪个画布的哪个节点引用了目标。 */
export interface CanvasRefHit {
  canvasId: string;
  nodeId: string;
}

/**
 * 哪些画布的哪些文件卡片引用了 `noteId`。
 *
 * 传入「画布清单」（id + 磁盘原文），返回命中清单 —— 纯函数，库层
 * （`library.ts` 的同名导出）负责把当前工作区的画布喂进来。
 * 致命解析失败的画布自然产出空文档、不会命中任何引用，无需特判。
 */
export function canvasesReferencing(noteId: string, canvases: readonly { id: string; content: string }[]): CanvasRefHit[] {
  const target = normalizeFileRef(noteId);
  if (!target) return [];
  const hits: CanvasRefHit[] = [];
  for (const canvas of canvases) {
    const { doc } = parseCanvas(canvas.content);
    for (const node of fileNodesIn(doc)) {
      if (normalizeFileRef(node.file) === target) hits.push({ canvasId: canvas.id, nodeId: node.id });
    }
  }
  return hits;
}

/** 引用改写的结果：`changed=false` 时 `doc` 就是原对象（零拷贝，调用方免判等）。 */
export interface CanvasRewrite {
  doc: CanvasDocument;
  changed: boolean;
}

/**
 * 把 `file` 等于 `from`（规范化后比较）的文件卡片改写成 `to`。
 *
 * `prefix: true` 时额外匹配 `from/` 开头的引用 —— **只在移动目录时用**：
 * 移动 `旧夹/` 到 `新夹/` 后，指向 `旧夹/x.md` 的卡片也该跟着到 `新夹/x.md`。
 * 文件级的改名/移动绝不开前缀匹配：名为 `a.md` 的文件与路径段 `a.md/`
 * （把 `.md` 文件名当目录用）互不相干，开了就是误改写。
 */
export function rewriteFileRefs(doc: CanvasDocument, from: string, to: string, options: { prefix?: boolean } = {}): CanvasRewrite {
  const target = normalizeFileRef(from);
  if (!target || target === normalizeFileRef(to)) return { doc, changed: false };
  // 前缀命中要**保留后缀**：移动 `旧夹/` → `新家/夹/` 时，`旧夹/x.md` 的新路径
  // 是 `新家/夹/x.md`（`to + 原路径去掉前缀的那一段`），不是光秃秃的 `to`。
  const rewriteTo = (ref: string): string | null => {
    const normalized = normalizeFileRef(ref);
    if (normalized === target) return to;
    if (options.prefix && normalized.startsWith(`${target}/`)) {
      return `${to}${normalized.slice(target.length)}`;
    }
    return null;
  };
  let changed = false;
  const nodes = doc.nodes.map((node) => {
    if (!isCanvasFileNode(node)) return node;
    const nextFile = rewriteTo(node.file);
    if (nextFile === null) return node;
    changed = true;
    return { ...node, file: nextFile };
  });
  return changed ? { doc: { ...doc, nodes }, changed } : { doc, changed };
}
