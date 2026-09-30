/**
 * 元素选择（`选择页面元素`）的**失败原因文案单一来源**（task-21 / Lead 裁定）。
 *
 * 背景：0.3.1 之前四种完全不同的原因共用一句假话（「只有普通网页支持」），
 * 用户实测在知乎普通 https 文章上被这句假话误导，真错误（`chrome.scripting` 的异常）被吞掉。
 * 现在每种原因各有判据、各有可执行的下一步；`injection_failed` 还必须带上真实原文。
 *
 * 判据（与 `background.js startPick()` 一一对应）：
 * - `no_url`：连活动标签页都拿不到（`chrome.tabs.query` 返回空）
 * - `restricted_scheme`：URL 读得到且命中受限 scheme（chrome:// / 扩展商店 / file: / PDF…）
 * - `injection_failed`：`chrome.scripting.executeScript` 抛错或返回空结果 —— **不能选**的唯一证据
 * - `extraction_failed`：注进去了，但这一页读不出正文（抽取结果为空）
 */
export const PICK_FAIL_COPY = Object.freeze({
  no_url: "读不到这个标签页的地址。请点一下扩展图标（或刷新页面）后再试。",
  restricted_scheme: "这个页面不能选择元素：只有普通网页（http 或 https）支持。换个普通网页再试。",
  injection_failed: "没能在这个页面里装上选择器（注入失败）。这不是页面类型的问题。",
  extraction_failed: "没能从这个页面读到正文。请刷新后重试，或改用「选择当前元素」直接点选。",
});

/** 四种原因必须产生**四种不同**的文案（`verify.mjs` V16 与单测都按这条断言）。 */
export const PICK_FAIL_REASONS = Object.freeze(Object.keys(PICK_FAIL_COPY));

/** 取某个原因的人话；未知原因绝不静默 —— 退回到一句如实的中性说明。 */
export function pickFailCopy(reason) {
  return PICK_FAIL_COPY[reason] || "没能进入元素选择模式。";
}
