/**
 * 页面内元素选择（00 §6.15㉝；03 §UI-16）。**取代 0.2.0 的选区浮标**（`content/float.js` 已删除）。
 *
 * 纪律（㉝ 原话「选择模式不得改变页面：只允许新增一层覆盖层（Shadow DOM 内），不得改页面 DOM、
 * 不得注入持久样式」）——本文件里**只允许**做这些页面改动：
 *   1. `document.documentElement.appendChild(host)`：一个空 div（`id="opennote-pick-host"`）；
 *   2. host 内挂一个 **`mode: "closed"`** 的 Shadow DOM，样式来自构建期注入的整份 tokens.css；
 *   3. 退出时 `host.remove()`。
 * 除了这三条，不碰页面已有节点的属性 / 样式 / 文本 / 类名，不写 `document.body.style.*`，
 * 不插 `<style>`，不动滚动位置。`verify.mjs` 的 V14 会机械校验这几条。
 *
 * 样式：`__OPENNOTE_TOKENS_CSS__` 在构建期被替换成 `src/styles/tokens.css` 的**整份内容**
 * （只把 `:root` 机械替换成 `:host`），所以这里没有任何手抄色值。
 *
 * 以 `files: ["content/picker.js"]` 注入（经典脚本，不能用 import/export）。
 */

(() => {
  if (window.__opennotePickerActive) return;
  window.__opennotePickerActive = true;

  const TOKENS_CSS = "__OPENNOTE_TOKENS_CSS__";
  const HOST_ID = "opennote-pick-host";

  const previous = document.getElementById(HOST_ID);
  if (previous) previous.remove();

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.setAttribute("aria-hidden", "true");
  // 主题镜像（① 夜版帧证据的根因修复）：影子根**看不见**影子树外面的祖先属性选择器，
  // 而注入的令牌里夜版/强调色/字体预设正是写成 `:host([data-theme="night"])` 这类选择器的。
  // 所以把**页面根上的那几个属性**照搬到我们自己的宿主元素上（只写我们创建的节点，
  // 不动页面已有节点 —— ㉝ 的「不得改页面 DOM」仍然成立）。页面没设就一个都不加。
  for (const name of ["data-theme", "data-accent", "data-font", "data-width"]) {
    const value = document.documentElement.getAttribute(name);
    if (value) host.setAttribute(name, value);
  }
  host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `${TOKENS_CSS}
:host{position:fixed;inset:0;pointer-events:none;z-index:2147483647}
.op-mask{position:fixed;inset:0;background:color-mix(in srgb, var(--paper) 22%, transparent);pointer-events:none}
.op-box{position:fixed;display:none;outline:2px solid var(--accent);box-shadow:0 0 0 1px var(--paper),0 0 0 100vmax color-mix(in srgb, var(--paper) 56%, transparent);border-radius:2px;pointer-events:none;transition:none}
.op-tag{position:fixed;display:none;background:var(--ink);color:var(--paper);border-radius:var(--radius-sm);font-family:var(--font-ui);font-size:var(--fs-xs);padding:var(--s1) var(--s2);box-shadow:var(--shadow-2);pointer-events:none;white-space:nowrap;font-variant-numeric:tabular-nums;transition:none}
.op-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--ink);color:var(--paper);border-radius:var(--radius);font-family:var(--font-ui);font-size:var(--fs-sm);padding:var(--s2) var(--s3);box-shadow:var(--shadow-2);pointer-events:auto;display:none;gap:var(--s3);align-items:center}
.op-toast button{background:none;border:none;color:var(--accent-soft);font:inherit;cursor:pointer;padding:0}
`;
  const mask = document.createElement("div");
  mask.className = "op-mask";
  const box = document.createElement("div");
  box.className = "op-box";
  const tag = document.createElement("div");
  tag.className = "op-tag";
  const toast = document.createElement("div");
  toast.className = "op-toast";
  toast.setAttribute("role", "status");
  const toastText = document.createElement("span");
  toastText.textContent = "已选好这一块。点扩展图标看预览。";
  const toastClose = document.createElement("button");
  toastClose.type = "button";
  toastClose.textContent = "知道了";
  toast.appendChild(toastText);
  toast.appendChild(toastClose);
  shadow.appendChild(style);
  shadow.appendChild(mask);
  shadow.appendChild(box);
  shadow.appendChild(tag);
  shadow.appendChild(toast);
  document.documentElement.appendChild(host);

  let current = null;

  /** 唯一的选择器：`tag:nth-of-type(n)` 逐级拼到 `body`，最长 300 字符（02 §2.4 的 selector 上限）。 */
  function selectorOf(element) {
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
      const parent = node.parentElement;
      if (!parent) break;
      const sameTag = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
      const index = sameTag.indexOf(node) + 1;
      parts.unshift(sameTag.length > 1 ? `${node.tagName.toLowerCase()}:nth-of-type(${index})` : node.tagName.toLowerCase());
      node = parent;
    }
    const selector = parts.join(" > ");
    return selector.length > 300 ? selector.slice(selector.length - 300).replace(/^[^ >]*[ >]?/, "") : selector;
  }

  function hide() {
    current = null;
    box.style.display = "none";
    tag.style.display = "none";
  }

  function show(element) {
    const rect = element.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    // S8：尺寸为 0 的元素**不跳过**（用户可能就是要那块隐藏内容），轮廓退化成 2px 小边
    box.style.display = "block";
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${Math.max(1, width)}px`;
    box.style.height = `${Math.max(1, height)}px`;
    tag.style.display = "block";
    // C01：`{标签名} · {宽} × {高}`，整数 CSS 像素、不写单位
    tag.textContent = `${element.tagName.toLowerCase()} · ${width} × ${height}`;
    const labelWidth = 160;
    const below = rect.top < 28;
    tag.style.left = `${Math.max(4, rect.left)}px`;
    tag.style.top = below ? `${rect.top + 4}px` : `${rect.top - 26}px`;
    if (rect.left + labelWidth > window.innerWidth) tag.style.left = `${Math.max(4, window.innerWidth - labelWidth)}px`;
  }

  function cleanup() {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onScroll);
    hide();
    host.remove();
    delete window.__opennotePickerActive;
    delete window.__opennotePickerCancel;
  }

  function targetOf(event) {
    const node = event.target;
    if (!node || node.nodeType !== 1) return null;
    // S3 / C09：`html` 视为不可选（等价整页，由「整页正文」承担）
    if (node === document.documentElement) return null;
    if (node.id === HOST_ID) return null;
    return node;
  }

  function onMove(event) {
    const node = targetOf(event);
    if (!node) {
      hide();
      return;
    }
    current = node;
    show(node);
  }

  function onScroll() {
    if (current && current.isConnected) show(current);
  }

  function onKey(event) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    // S5：Esc 取消，不写入任何选择结果
    cleanup();
    try {
      chrome.runtime.sendMessage({ type: "opennote:pick-cancelled" });
    } catch {
      /* 扩展被卸载时静默 */
    }
  }

  function onClick(event) {
    // ㉝：三件套缺一不可，否则会点掉链接 / 提交表单 / 触发页面自己的快捷键
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const node = targetOf(event);
    if (!node) {
      // C09：点 `html` 不产生选择，回 popup 时用「整页请用「整页正文」。」兜底说明
      send({ picked: false, reason: "html-or-empty" }, false);
      return;
    }
    const payload = {
      picked: true,
      tagName: node.tagName.toLowerCase(),
      selector: selectorOf(node),
      rect: (() => {
        const rect = node.getBoundingClientRect();
        return { width: Math.round(rect.width), height: Math.round(rect.height) };
      })(),
      isIframe: node.tagName === "IFRAME",
    };
    // S4：先让后台抽内容并存下来；它再试打开 popup，打不开就让我们用同一条影子根显示一次性提示条
    send(payload, true);
  }

  /** 摘掉所有监听（不再吃页面事件），但先留着覆盖层，等后台告诉我们要不要显示提示条。 */
  function detach() {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onScroll);
    hide();
  }

  /** C07：`已选好这一块。点扩展图标看预览。`（8 秒后自动消失，可点「知道了」关闭）。 */
  function showToast() {
    detach();
    toast.style.display = "flex";
    const timer = setTimeout(() => cleanup(), 8000);
    toastClose.addEventListener("click", () => {
      clearTimeout(timer);
      cleanup();
    });
  }

  function send(message, waitForReply) {
    const onReply = (reply) => {
      if (waitForReply && reply && reply.needToast) showToast();
      else cleanup();
    };
    try {
      chrome.runtime.sendMessage({ type: "opennote:element-picked", ...message }, onReply);
    } catch {
      cleanup();
    }
  }

  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", onScroll, { capture: true, passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  window.__opennotePickerCancel = () => {
    cleanup();
  };
})();
