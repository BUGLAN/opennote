/**
 * 页面内桥（postMessage）—— 扩展侧的协议常量与「哪个标签页是 Opennote 网页版」的判定。
 *
 * 为什么需要这条通道（契约 02 §5.7 / FR-39）：网页版的 CSP 是 `default-src 'self'` +
 * `connect-src 'self'`，页面**不能** fetch `127.0.0.1` 的本地接口；桌面版才有本地桥。
 * 于是「网页版正在浏览器里开着」时，唯一能把信封送进笔记本的办法，是让扩展的内容脚本
 * 与那个页面直接对话（`window.postMessage`）。
 *
 * 两条纪律：
 *   1. **`postMessage(data, targetOrigin)` 必须显式给 origin**（契约硬红线：绝不 `"*"`）；
 *   2. 候选判定是**启发式**（标签页标题里有没有 Opennote），**握手才是唯一真相**：
 *      页面回 `ready` 才算数，回不来就如实说，不假装成功。
 *
 * 这里的常量是**唯一事实源**。注入脚本（`content/inpage-bridge.js`）因为内容脚本不能用
 * ESM `import`，会在文件头重复一份字面量 —— `verify.mjs` 的 V21 逐字比对两处，漂了当场红。
 */

export const INPAGE_PREFIX = "opennote:inpage:";
export const INPAGE_VERSION = 1;
export const INPAGE_HELLO = "opennote:inpage:hello";
export const INPAGE_READY = "opennote:inpage:ready";
export const INPAGE_IMPORT = "opennote:inpage:import";
export const INPAGE_RESULT = "opennote:inpage:result";
export const INPAGE_EVENT = "opennote:inpage:event";

/** 单条消息上限 1 MiB（契约 §5.7）：超过就**不发**，如实告诉用户还有哪两条路可走。 */
export const INPAGE_MAX_BYTES = 1024 * 1024;
/** 握手答复时限（契约 §5.7：等 `ready` 300 ms）。 */
export const INPAGE_READY_MS = 300;
/** 入库答复时限（契约 §5.7：5 s —— 页面可能正在渲染大文档）。 */
export const INPAGE_RESULT_MS = 5000;

/** 标题里出现它才算候选（网页版自己那份 `<title>` 里就带着 Opennote）。 */
export const INPAGE_TITLE_MARK = "opennote";

/** 受限 scheme：这些页面里根本没有网页版笔记本可言。 */
const NON_HTTP_RE = /^(chrome|edge|brave|about|devtools|view-source|file|chrome-extension|moz-extension|data|blob):/i;

/** `http(s)` 才算候选（`file://` 上的本地构建也读不到扩展消息，直接排除）。 */
export function isHttpUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url) && !NON_HTTP_RE.test(url);
}

/** 标签页的显示名（`new URL(url).host`，形如 `笔记站的主机名`）。 */
export function webHostOf(url) {
  try {
    return new URL(String(url)).host || null;
  } catch {
    return null;
  }
}

/** 标签页的 origin（申请可选主机权限、以及 postMessage 的目标都用它）。 */
export function webOriginOf(url) {
  try {
    const parsed = new URL(String(url));
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

/**
 * 一个标签页够不够格当候选。
 *
 * @param {{id?:number,url?:string,title?:string,active?:boolean,index?:number}} tab
 * @param {{excludeTabId?:number|null, blocked?:Set<string>|string[]}} options
 *   `excludeTabId` = 正在被剪的那个页面本身（把笔记本页剪进笔记本没有意义）；
 *   `blocked` = 本会话里握手失败过的 `tabId`（不再白试第二次）。
 */
export function isWebCandidate(tab, options = {}) {
  if (!tab || typeof tab.id !== "number") return false;
  if (!isHttpUrl(tab.url)) return false;
  if (options.excludeTabId !== null && options.excludeTabId !== undefined && tab.id === options.excludeTabId) return false;
  const blocked = options.blocked instanceof Set ? options.blocked : new Set(options.blocked || []);
  if (blocked.has(tab.id)) return false;
  const title = String(tab.title || "").toLowerCase();
  const url = String(tab.url || "").toLowerCase();
  return title.includes(INPAGE_TITLE_MARK) || url.includes(INPAGE_TITLE_MARK);
}

/**
 * 从全部标签页里挑**一个**候选（popup 上只放一个按钮，多标签页不做选择器）。
 *
 * 排序：URL 里带 `opennote` 的优先（比标题更像真的）→ 活动标签页优先 → 标签页顺序。
 * 挑错了的代价是用户点一下看到一句真话（握手不通过），并且该标签页本会话不再出现。
 */
export function pickWebCandidate(tabs, options = {}) {
  const list = (Array.isArray(tabs) ? tabs : []).filter((tab) => isWebCandidate(tab, options));
  const score = (tab) => {
    const url = String(tab.url || "").toLowerCase();
    return (url.includes(INPAGE_TITLE_MARK) ? 0 : 1) * 10 + (tab.active ? 0 : 1);
  };
  list.sort((a, b) => score(a) - score(b) || (a.index ?? 0) - (b.index ?? 0));
  const best = list[0];
  if (!best) return null;
  const origin = webOriginOf(best.url);
  const host = webHostOf(best.url);
  if (!origin || !host) return null;
  return { tabId: best.id, url: best.url, title: best.title || "", origin, host };
}

/** 信封的字节数（按 UTF-8；`postMessage` 会整份复制，大对象会同时卡住两个页面）。 */
export function inpageBytes(data) {
  try {
    return new TextEncoder().encode(JSON.stringify(data)).byteLength;
  } catch {
    return null;
  }
}
