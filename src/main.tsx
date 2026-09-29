import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

/* Self-hosted typefaces — no CDN round-trip on first paint. */
import "@fontsource-variable/fraunces/full.css";
import "@fontsource-variable/newsreader/opsz.css";
import "@fontsource-variable/newsreader/opsz-italic.css";
import "@fontsource-variable/figtree/index.css";
import "@fontsource-variable/figtree/wght-italic.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import "@fontsource-variable/jetbrains-mono/wght-italic.css";
import "katex/dist/katex.min.css";

import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/prose.css";
import "./styles/editor.css";
import "./styles/app.css";

import App from "./App";
import { applySystemThemeOnFirstVisit, applyUi, getUi, storageBlockedReason } from "./data/ui";

declare global {
  interface Window {
    /** index.html's boot safety net stops waiting once React has rendered. */
    __opennoteMounted?: () => void;
    /** Set by index.html when even reading `localStorage` throws (blocked site data). */
    __opennoteStorageBlocked?: string;
  }
}

// First visit: follow the operating system instead of forcing a light page.
applySystemThemeOnFirstVisit();
applyUi(getUi());

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from index.html");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Past this point a stuck splash is not "the module never ran" anymore.
window.__opennoteMounted?.();

notifyStorageBlocked();

/**
 * Blocked site data is not fatal — the notes live in OPFS or in a folder on
 * disk, only the settings stop persisting. Say it once, without blocking the UI.
 */
function notifyStorageBlocked(): void {
  const reason = storageBlockedReason() ?? window.__opennoteStorageBlocked ?? null;
  if (!reason || document.getElementById("storage-notice")) return;

  const notice = document.createElement("div");
  notice.id = "storage-notice";
  notice.className = "storage-notice";
  notice.setAttribute("role", "status");

  const text = document.createElement("p");
  text.className = "storage-notice__text";
  text.textContent = `浏览器禁止了站点数据（${reason}），主题、侧栏等设置本次不会被保存；笔记正文仍会写入你选择的笔记本文件夹。`;

  const close = document.createElement("button");
  close.type = "button";
  close.className = "storage-notice__close";
  close.textContent = "知道了";
  close.addEventListener("click", () => notice.remove());

  notice.append(text, close);
  document.body.appendChild(notice);
}
