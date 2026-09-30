import { renderMarkdown } from "../lib/markdown";

export interface Preview {
  html: string;
  empty: boolean;
}

/**
 * 实时预览的渲染入口。
 *
 * **唯一来源**是应用的 `src/lib/markdown.ts`（同一个 markdown-it 配置、同一个 DOMPurify
 * 白名单、同一套 `sanitizeHtml`）—— 页面不造第二条渲染管线。用户要的"保证渲染的效果"
 * 就落在这一个 import 上；改渲染规则必须去改 `src/lib/markdown.ts`，不是在这里打补丁。
 */
export function renderPreview(source: string): Preview {
  return { html: renderMarkdown(source), empty: source.trim() === "" };
}
