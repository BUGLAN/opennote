/**
 * 画布内搜索的纯匹配逻辑（UI 在 CanvasView）。
 *
 * 匹配面：文本卡文字、文件卡标题/路径、网页卡 url、分组 label、HTML 卡纯文本、
 * 边标签。文件卡标题经视图注入的 `noteTitle` 取（getNoteInfo 的产物），这里不碰库；
 * HTML 卡用 `htmlPlainText`（认文字不认标记，与笔记本搜索同一口径）。
 */
import type { CanvasDocument } from "./types";
import { isCanvasFileNode, isCanvasGroupNode, isCanvasHtmlNode, isCanvasLinkNode, isCanvasTextNode } from "./types";
import { htmlPlainText } from "../html/bundle";

export interface CanvasSearchMatch {
  /** 命中的节点/边 id（跳转用）。 */
  id: string;
  kind: "node" | "edge";
  /** 菜单里给人看的上下文（截断过的命中片段）。 */
  label: string;
}

const SNIPPET_LIMIT = 48;

function snippet(haystack: string, needle: string): string {
  const at = haystack.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return haystack.slice(0, SNIPPET_LIMIT);
  const start = Math.max(0, at - 12);
  return (start > 0 ? "…" : "") + haystack.slice(start, start + SNIPPET_LIMIT);
}

function hit(haystack: string | undefined, needle: string): boolean {
  return typeof haystack === "string" && haystack.toLowerCase().includes(needle);
}

/**
 * 大小写不敏感的子串匹配，按文档顺序返回命中（节点在前、边在后 —— 与序列化
 * 顺序一致，Enter 循环的「下一处」由此稳定）。空查询返回空数组。
 */
export function searchCanvas(
  doc: CanvasDocument,
  query: string,
  noteTitle: (noteId: string) => string | null,
): CanvasSearchMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: CanvasSearchMatch[] = [];
  for (const node of doc.nodes) {
    if (isCanvasTextNode(node)) {
      if (hit(node.text, needle)) matches.push({ id: node.id, kind: "node", label: snippet(node.text, needle) });
    } else if (isCanvasFileNode(node)) {
      const title = noteTitle(node.file) ?? "";
      if (hit(title, needle) || hit(node.file, needle)) {
        matches.push({ id: node.id, kind: "node", label: snippet(title || node.file, needle) });
      }
    } else if (isCanvasLinkNode(node)) {
      if (hit(node.url, needle)) matches.push({ id: node.id, kind: "node", label: snippet(node.url, needle) });
    } else if (isCanvasGroupNode(node)) {
      if (hit(node.label, needle)) matches.push({ id: node.id, kind: "node", label: snippet(node.label ?? "", needle) });
    } else if (isCanvasHtmlNode(node)) {
      const text = htmlPlainText(node.html);
      if (hit(text, needle)) matches.push({ id: node.id, kind: "node", label: snippet(text, needle) });
    }
  }
  for (const edge of doc.edges) {
    if (hit(edge.label, needle)) matches.push({ id: edge.id, kind: "edge", label: snippet(edge.label ?? "", needle) });
  }
  return matches;
}
