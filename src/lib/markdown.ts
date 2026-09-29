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
