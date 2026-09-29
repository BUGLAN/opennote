/**
 * 页内高亮采集（00 §6.14 ㉚）。
 *
 * 这个文件被 `chrome.scripting.executeScript({ func: highlightInPage })` 注入，
 * 函数体经 `toString()` 序列化后执行，因此必须**自包含**：
 *   - 只有 `highlightInPage` 一个顶层声明；
 *   - 不 import / require / eval，不引用模块作用域里的任何东西；
 *   - 只用页面里天然存在的 API（window / document / CSS Highlight API）。
 * `tests/self-contained.test.mjs` 会机械校验这三条。
 *
 * 它**不改页面 DOM**：视觉标记走 CSS Highlight API（`CSS.highlights`），刷新即消失，
 * 数据落在扩展的 `chrome.storage.local` 里（`opennote.highlights.v1`）。
 * 返回 `{ ok, text, selector, url, title, capturedAt, color }`。
 */
export function highlightInPage(options) {
  const opts = options || {};
  const COLOR = typeof opts.color === "string" ? opts.color : "";

  function cssPath(node) {
    if (!node) return "";
    const element = node.nodeType === 1 ? node : node.parentElement;
    if (!element || !element.tagName) return "";
    const parts = [];
    let current = element;
    let depth = 0;
    while (current && current.tagName && depth < 6) {
      const tag = current.tagName.toLowerCase();
      if (tag === "html" || tag === "body") break;
      let index = 1;
      let sibling = current;
      while (sibling && sibling.previousElementSibling) {
        sibling = sibling.previousElementSibling;
        if (sibling.tagName && sibling.tagName.toLowerCase() === tag) index += 1;
      }
      const id = current.id ? `#${current.id}` : "";
      parts.unshift(id ? `${tag}${id}` : `${tag}:nth-of-type(${index})`);
      if (id) break;
      current = current.parentElement;
      depth += 1;
    }
    return parts.join(" > ");
  }

  function mark(range) {
    // 可逆、零 DOM 改动：CSS Highlight API（Chrome 105+）
    try {
      const registry = window.CSS && window.CSS.highlights;
      const HighlightCtor = window.Highlight;
      if (!registry || typeof HighlightCtor !== "function" || typeof registry.set !== "function") return false;
      const highlight = new HighlightCtor(range.cloneRange());
      registry.set("opennote-highlight", highlight);
      return true;
    } catch (error) {
      return false;
    }
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return { ok: false, reason: "no-selection", text: "", selector: "", url: location.href, title: document.title };
  }

  const range = selection.getRangeAt(0);
  const text = String(selection.toString() || "")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\s*\n\s*/g, " ")
    .trim();

  if (!text) {
    return { ok: false, reason: "empty-text", text: "", selector: "", url: location.href, title: document.title };
  }

  const container = range.startContainer;
  const anchor = container && container.nodeType === 1 ? container : container && container.parentElement;
  const block = anchor && anchor.closest ? anchor.closest("p, li, blockquote, td, h1, h2, h3, h4, section, article, div") : null;

  return {
    ok: true,
    reason: "ok",
    text,
    selector: cssPath(block || anchor),
    url: location.href,
    title: document.title,
    color: COLOR,
    capturedAt: new Date().toISOString(),
    marked: mark(range),
  };
}
