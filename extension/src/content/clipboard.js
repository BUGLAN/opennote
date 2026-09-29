/**
 * 剪贴板降级路径的页面侧实现（自包含，供 `chrome.scripting.executeScript({func})` 注入）。
 *
 * 为什么不申请 `clipboardWrite` 权限：降级路径①「复制 Markdown 到剪贴板」优先用
 * popup 里的 `navigator.clipboard.writeText`（有用户手势）；失败时退到在**页面**里
 * `execCommand("copy")`（页面自己允许，不需要扩展权限）。两条都失败时 popup 会给出
 * 可见的文本域让用户手动复制——**不允许静默失败**。
 *
 * 与 extract-page.js 同样只有一个顶层声明（自包含不变量）。
 */

export function copyInPage(text) {
  try {
    const value = String(text == null ? "" : text);
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "readonly");
    area.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, value.length);
    const ok = document.execCommand("copy");
    area.remove();
    return Boolean(ok);
  } catch {
    return false;
  }
}
