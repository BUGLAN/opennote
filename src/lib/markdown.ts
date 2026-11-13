import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
  typographer: false,
});

/** Render markdown to HTML with the exact same pipeline used for export. */
export function renderMarkdown(source: string): string {
  return sanitizeHtml(md.render(source));
}

export function renderInline(source: string): string {
  return sanitizeHtml(md.renderInline(source));
}

export function sanitizeHtml(html: string): string {
  if (typeof window === "undefined" || typeof DOMPurify.sanitize !== "function") return html;
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ["target", "rel", "align", "colspan", "rowspan", "data-asset"],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|data|blob|asset):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  });
}

export { md as markdownIt };

/**
 * `renderMarkdown()` 的输出里，图片与链接的目标会被 markdown-it 的 `normalizeLink`
 * **百分号编码**：`![x](assets/计算机启动过程/a.png)` → `src="assets/%E8%AE%A1.../a.png"`。
 *
 * 拿 `<img src>` 去读磁盘之前必须解回来 —— 否则就是「编辑器里能显示的图（它读的是 Markdown
 * 原文），换成渲染出来的 HTML 之后变成裂图」（0.4.0 用户实测：只读阅读视图里的本机图片全丢）。
 * 解不动的**原样返回**（不是每个含 `%` 的字符串都是合法编码）。
 */
export function decodeMarkdownHref(value: string): string {
  const raw = String(value || "");
  if (!raw.includes("%")) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
