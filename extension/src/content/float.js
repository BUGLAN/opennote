/**
 * UI-02 · 页面内选区浮标（在页面里注入，影子 DOM 隔离，不污染宿主页面的样式）。
 *
 * 注入方式：`content_scripts` 会要求 `<all_urls>` host permission，与 FR-54 的
 * 「只申请 activeTab + scripting」冲突，因此本脚本**按需注入**（用户点扩展图标 /
 * 右键菜单 / 快捷键授予 activeTab 之后）。注入一次即常驻该标签页，导航后需重新授予。
 *
 * 样式：`__OPENNOTE_TOKENS_CSS__` 在构建期被替换成 `src/styles/tokens.css` 的**整份内容**
 * （只把 `:root` 机械替换成 `:host`），因此浮标用的是同一套设计令牌，**没有任何手抄色值**；
 * 影子 DOM 保证了 `:host` 作用域不会改到宿主页面的变量。
 */

(() => {
  if (window.__opennoteClipFloatInjected) return;
  window.__opennoteClipFloatInjected = true;

  const TOKENS_CSS = "__OPENNOTE_TOKENS_CSS__";
  const FLOAT_CSS = `
:host{
  all: initial;
  position: fixed;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  z-index: 2147483647;
  contain: layout style;
  font-family: var(--font-ui);
}
.clip-float{
  position: absolute;
  display: inline-flex;
  align-items: center;
  gap: 0;
  height: 26px;
  padding: 0 4px 0 5px;
  border: none;
  border-radius: 99px;
  background: var(--ink);
  color: var(--paper);
  box-shadow: var(--shadow-3);
  font-family: var(--font-ui);
  font-size: var(--fs-sm);
  line-height: 1;
  pointer-events: auto;
  white-space: nowrap;
  animation: rise var(--dur-fast) var(--ease-out) both;
}
.clip-float[hidden]{display:none}
.clip-float__seal{
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 3px;
  background: var(--accent);
  color: var(--accent-ink);
  font-family: var(--font-serif);
  font-size: 9px;
  font-style: normal;
  line-height: 1;
  flex: none;
}
.clip-float__btn{
  padding: 0 7px;
  color: inherit;
  background: none;
  border: none;
  font: inherit;
  cursor: pointer;
  min-width: 52px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.clip-float:hover{background: color-mix(in srgb, var(--ink) 88%, var(--paper))}
.clip-float__sep{width:1px;height:12px;background:var(--rule-strong);opacity:.5;flex:none}
.clip-float__icon{
  padding: 0 5px;
  color: inherit;
  background: none;
  border: none;
  font: inherit;
  font-size: var(--fs-xs);
  cursor: pointer;
}
.clip-float__icon:hover{color: var(--accent-soft)}
.clip-float__btn:focus-visible,.clip-float__icon:focus-visible{outline:2px solid var(--paper);outline-offset:-2px;border-radius:3px}
.clip-float--danger{background: var(--accent);color: var(--accent-ink)}
.clip-float--danger .clip-float__seal{background: var(--accent-ink);color: var(--accent)}
.spinner{
  width: 12px;height: 12px;border-radius: 50%;
  border: 2px solid currentColor;border-top-color: transparent;
  animation: spin .8s linear infinite;flex: none;
}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion: reduce){
  .clip-float{animation-duration:.01ms !important}
  .spinner{animation-duration:.01ms !important;animation-iteration-count:1 !important}
}
`;

  const host = document.createElement("div");
  host.setAttribute("data-opennote-clip-float", "");
  host.style.cssText = "all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647";
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `${TOKENS_CSS}\n${FLOAT_CSS}`;
  shadow.appendChild(style);

  const pill = document.createElement("span");
  pill.className = "clip-float";
  pill.setAttribute("role", "toolbar");
  pill.setAttribute("aria-label", "剪藏动作");
  pill.hidden = true;
  pill.innerHTML =
    '<i class="clip-float__seal" aria-hidden="true">記</i>' +
    '<button class="clip-float__btn" type="button" tabindex="-1">剪藏</button>' +
    '<i class="clip-float__sep" aria-hidden="true"></i>' +
    '<button class="clip-float__icon" type="button" tabindex="-1" title="剪藏整页正文" aria-label="剪藏整页正文">整页</button>';
  shadow.appendChild(pill);

  const clipButton = pill.querySelector(".clip-float__btn");
  const pageButton = pill.querySelector(".clip-float__icon");
  let hideTimer = null;
  let busy = false;

  function clearTimer() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function reset() {
    clearTimer();
    pill.classList.remove("clip-float--danger");
    pill.hidden = true;
    busy = false;
    clipButton.innerHTML = "剪藏";
    clipButton.disabled = false;
    pageButton.disabled = false;
  }

  function selectionText() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return "";
    return String(selection.toString() || "").trim();
  }

  function place() {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return;
    const width = 132;
    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    let top = rect.top - 34;
    if (top < 8) top = rect.bottom + 8;
    pill.style.left = `${Math.round(left)}px`;
    pill.style.top = `${Math.round(top)}px`;
  }

  function show() {
    if (busy) return;
    clearTimer();
    pill.classList.remove("clip-float--danger");
    clipButton.innerHTML = "剪藏";
    place();
    pill.hidden = false;
    hideTimer = setTimeout(() => {
      if (!busy) pill.hidden = true;
    }, 4000);
  }

  function flash(text, danger) {
    clearTimer();
    busy = false;
    clipButton.textContent = text;
    pageButton.disabled = true;
    pill.classList.toggle("clip-float--danger", Boolean(danger));
    pill.hidden = false;
    hideTimer = setTimeout(() => {
      reset();
    }, danger ? 2400 : 1200);
  }

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (reply) => {
          void chrome.runtime.lastError;
          resolve(reply || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  async function run(mode) {
    if (busy) return;
    busy = true;
    clearTimer();
    pill.classList.remove("clip-float--danger");
    pill.hidden = false;
    place();
    clipButton.innerHTML = '<span class="spinner"></span>';
    pageButton.disabled = true;
    const reply = await send({ type: "clip-now", mode, from: "float" });
    if (reply && reply.status === "created") {
      flash("已剪藏", false);
      return;
    }
    if (reply && reply.status === "queued") {
      flash("已暂存", false);
      return;
    }
    flash((reply && reply.label) || "本地接口未开启", true);
    if (reply && reply.code) {
      // 03 §UI-02：失败时在 1 次点击后把 popup 打开并停在 UI-01 的错误态（一次性把用户送到能解决问题的地方）
      send({ type: "open-popup", code: reply.code });
    }
  }

  clipButton.addEventListener("click", () => run("selection"));
  pageButton.addEventListener("click", () => run("page"));

  document.addEventListener(
    "mouseup",
    () => {
      setTimeout(() => {
        if (selectionText()) show();
      }, 10);
    },
    true,
  );
  document.addEventListener(
    "keyup",
    (event) => {
      if (event.key === "Shift" || event.key.startsWith("Arrow")) {
        setTimeout(() => {
          if (selectionText()) show();
        }, 10);
      }
    },
    true,
  );
  document.addEventListener(
    "mousedown",
    (event) => {
      if (event.composedPath && event.composedPath().includes(host)) return;
      if (!busy) reset();
    },
    true,
  );
  document.addEventListener("scroll", () => {
    if (!busy && !pill.hidden) place();
  }, true);
  window.addEventListener("resize", () => {
    if (!busy && !pill.hidden) place();
  });
  document.addEventListener("selectionchange", () => {
    if (!busy && !selectionText()) pill.hidden = true;
  });

  // 右键菜单 / 快捷键路径的反馈：由 background 注入本脚本后发消息回来，
  // 于是「选中 → 剪藏」三条入口共用同一个可见的动作条（UI-02），不会静默失败。
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return undefined;
    if (message.type === "opennote:busy") {
      busy = true;
      clearTimer();
      pill.classList.remove("clip-float--danger");
      pill.hidden = false;
      clipButton.innerHTML = '<span class="spinner"></span>';
      pageButton.disabled = true;
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === "opennote:flash") {
      flash(String(message.text || ""), Boolean(message.danger));
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === "opennote:reset") {
      reset();
      sendResponse({ ok: true });
      return true;
    }
    return undefined;
  });

  window.__opennoteClipFloatReset = reset;
})();
