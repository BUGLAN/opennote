/*
 * 页面用的小工具：建 DOM、图标、格式化、提示条、对话框、复制。
 *
 * 建 DOM 一律走 h()，文本走 textContent —— 账号名、邮箱、笔记本名都是用户可控的字符串，
 * 拼 innerHTML 等于给它们开了一扇执行脚本的门。唯一的 innerHTML 是 icons.js 里写死的 SVG。
 */

/**
 * h("div", { class: "row", onClick: fn, dataset: {...}, attrs: {...} }, ...children)
 * children 可以是字符串 / 节点 / 数组 / null / false（后两者跳过）。
 */
export function h(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key === "attrs") for (const [name, attr] of Object.entries(value)) node.setAttribute(name, attr);
      else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key in node) node[key] = value;
      else node.setAttribute(key, value === true ? "" : String(value));
    }
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(node, child);
    else node.append(child instanceof Node ? child : String(child));
  }
}

/** 换掉一个容器的全部内容。 */
export function mount(container, ...children) {
  container.replaceChildren();
  append(container, children);
  return container;
}

/** icons.js 的 SVG（写死的字符串，不含任何外部输入）。 */
export function icon(name, size) {
  const span = document.createElement("span");
  span.className = "ico";
  span.innerHTML = window.ICON ? window.ICON(name, size || 15) : "";
  return span;
}

/** 进度条：宽度用 CSSOM 设（style="" 会被 CSP 拦掉，element.style 不会）。 */
export function bar(ratio, options) {
  const fill = h("i");
  fill.style.width = Math.max(0, Math.min(100, Math.round(ratio * 100))) + "%";
  const cls = (options && options.progress ? "progress" : "bar") + (options && options.attn ? (options.progress ? " progress--accent" : " bar--attn") : "");
  return h(options && options.progress ? "div" : "span", { class: cls }, fill);
}

/* ---------------------------------------------------------------- 格式化 */

export function bytes(value) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = value;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return (n >= 10 || unit === 0 ? Math.round(n) : n.toFixed(1)) + " " + units[unit];
}

export const GB = 1024 * 1024 * 1024;

/** GB 数（输入框用），保留到一位小数。 */
export function toGb(value) {
  return Math.round((value / GB) * 10) / 10;
}

export function number(value) {
  return Number(value || 0).toLocaleString("zh-CN");
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 「刚刚 / 3 分钟前 / 2 小时前 / 昨天 / 12 天前 / 4 个月前」。 */
export function ago(ms, now) {
  if (ms === null || ms === undefined) return "—";
  const diff = Math.max(0, now - ms);
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return Math.floor(diff / 60_000) + " 分钟前";
  if (ms >= startOfDay(now)) return Math.floor(diff / 3600_000) + " 小时前";
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
  if (days <= 1) return "昨天";
  if (days < 60) return days + " 天前";
  if (days < 365) return Math.floor(days / 30) + " 个月前";
  return Math.floor(days / 365) + " 年前";
}

/** 时间线上的时刻：今天「11:42」，昨天「昨天 23:10」，更早「10-28 09:12」。 */
export function clock(ms, now) {
  const d = new Date(ms);
  const time = pad(d.getHours()) + ":" + pad(d.getMinutes());
  if (ms >= startOfDay(now)) return time;
  if (ms >= startOfDay(now) - 86_400_000) return "昨天 " + time;
  return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + time;
}

export function date(ms) {
  const d = new Date(ms);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

export function dateTime(ms) {
  const d = new Date(ms);
  return date(ms) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

/** 到期时间：「已过期 / 23 小时后 / 明天过期 / 5 天后 / 不过期」。 */
export function until(ms, now) {
  if (ms === null || ms === undefined) return "不过期";
  const diff = ms - now;
  if (diff <= 0) return "已过期";
  if (diff < 3600_000) return Math.max(1, Math.round(diff / 60_000)) + " 分钟后过期";
  if (diff < 86_400_000) return Math.round(diff / 3600_000) + " 小时后过期";
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / 86_400_000);
  if (days <= 1) return "明天过期";
  return days + " 天后过期";
}

export function duration(seconds) {
  if (seconds < 3600) return Math.max(1, Math.round(seconds / 60)) + " 分钟";
  if (seconds < 86_400) return Math.round(seconds / 3600) + " 小时";
  return Math.floor(seconds / 86_400) + " 天";
}

/** 头像里的那个字。 */
export function initial(label) {
  const text = String(label || "?").trim();
  return (text[0] || "?").toUpperCase();
}

export const PLATFORM = { desktop: "桌面端", android: "Android", web: "网页端" };
export const OS = { macos: "macOS", windows: "Windows", linux: "Linux", android: "Android", ios: "iOS", other: "其它系统" };

export function platformLabel(device) {
  const parts = [OS[device.os], PLATFORM[device.platform]].filter(Boolean);
  if (device.os === "android" && device.platform === "android") parts.pop();
  return parts.length > 0 ? parts.join(" · ") : "未知平台";
}

export function deviceIcon(device) {
  if (device.platform === "android" || device.os === "android" || device.os === "ios") return "phone";
  if (device.platform === "web") return "globe";
  return "laptop";
}

/* -------------------------------------------------------------- 反馈 */

let toastBox = null;

export function toast(message, kind) {
  if (!toastBox) {
    toastBox = h("div", { class: "toasts", attrs: { role: "status", "aria-live": "polite" } });
    document.body.append(toastBox);
  }
  const node = h("div", { class: "toast" + (kind === "error" ? " toast--error" : ""), text: message });
  toastBox.append(node);
  setTimeout(() => node.remove(), kind === "error" ? 5200 : 2600);
}

/** 把接口错误变成一句提示（ApiError 的 message 本来就是给人看的）。 */
export function toastError(error) {
  toast((error && error.message) || "出错了", "error");
}

/**
 * 对话框。`body` 是节点；`actions` 是按钮（最后一个是主按钮）。
 * 返回 Promise：点了哪个按钮就 resolve 它的 value；按 Esc / 点背景 resolve(null)。
 * `onMount(buttons)` 在对话框挂上之后调（例如按输入启用确认按钮）。
 */
export function modal({ title, body, actions, onMount }) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const close = (value) => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      if (previous && previous.focus) previous.focus();
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === "Escape") close(null);
    };
    const buttons = actions.map((action) =>
      h("button", {
        type: "button",
        class: "btn" + (action.primary ? " btn--primary" : "") + (action.danger ? " btn--danger-solid" : ""),
        text: action.label,
        disabled: action.disabled || false,
        onClick: () => close(action.value),
      }),
    );
    const card = h(
      "div",
      { class: "modal__card", attrs: { role: "dialog", "aria-modal": "true", "aria-label": title } },
      h("div", { class: "modal__head", text: title }),
      h("div", { class: "modal__body" }, body),
      h("div", { class: "modal__foot" }, buttons),
    );
    const overlay = h("div", { class: "modal", onClick: (event) => event.target === overlay && close(null) }, card);
    document.addEventListener("keydown", onKey);
    document.body.append(overlay);
    const focusable = card.querySelector("input, select, textarea") || buttons[buttons.length - 1];
    if (focusable) focusable.focus();
    if (onMount) onMount(buttons);
  });
}

/** 确认框。`requireText` 给了就要对方逐字输入（删除账号用）。 */
export function confirm({ title, message, confirmText, danger, requireText, note }) {
  const field = requireText ? h("input", { class: "field", attrs: { autocomplete: "off", spellcheck: "false", placeholder: requireText } }) : null;
  const body = h(
    "div",
    { class: "stack" },
    h("p", { class: "message", text: message }),
    note ? h("p", { class: "hint", text: note }) : null,
    field ? h("label", { class: "lab" }, "输入 " + requireText + " 确认", field) : null,
  );
  return modal({
    title,
    body,
    actions: [
      { label: "取消", value: false },
      { label: confirmText || "确定", value: true, primary: !danger, danger: !!danger, disabled: !!requireText },
    ],
    // 要逐字输入的：输对了才能点确认。
    onMount: (buttons) => field && field.addEventListener("input", () => (buttons[buttons.length - 1].disabled = field.value.trim() !== requireText)),
  }).then((value) => value === true);
}

export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制");
  } catch {
    // 非 https 下没有 clipboard API：退回选中，让人自己按复制。
    const area = h("textarea", { class: "field", value: text, readOnly: true });
    document.body.append(area);
    area.select();
    const ok = document.execCommand && document.execCommand("copy");
    area.remove();
    toast(ok ? "已复制" : "复制不了，请手动选中复制", ok ? undefined : "error");
  }
}

/** 一行「链接 + 复制」。 */
export function linkBox(url, note) {
  return h(
    "div",
    { class: "callout" },
    h("div", { class: "row" }, h("span", { class: "mono grow break", text: url }), h("button", { type: "button", class: "btn btn--sm", onClick: () => copy(url) }, icon("copy", 13), "复制")),
    note ? h("div", { class: "note", text: note }) : null,
  );
}

/** 表单上的错误提示位：set(message) / set(null)。 */
export function errorSlot() {
  const node = h("p", { class: "form-error", attrs: { role: "alert" }, hidden: true });
  return {
    node,
    set(message) {
      node.textContent = message || "";
      node.hidden = !message;
    },
  };
}

/** 提交时把按钮变成转圈、禁用，结束后还原。 */
export async function busy(button, task) {
  const label = button.textContent;
  button.disabled = true;
  button.replaceChildren(h("span", { class: "spinner" }), label);
  try {
    return await task();
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

export function loading(text) {
  return h("div", { class: "page-loading" }, h("span", { class: "spinner" }), text || "正在读取…");
}

export function segmented(options, active, onChange) {
  return h(
    "div",
    { class: "segmented", attrs: { role: "tablist" } },
    options.map(([value, label]) =>
      h("button", {
        type: "button",
        class: value === active ? "is-active" : null,
        attrs: { role: "tab", "aria-selected": String(value === active) },
        text: label,
        onClick: () => onChange(value),
      }),
    ),
  );
}

/** 输入停下来再触发（搜索框）。 */
export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
