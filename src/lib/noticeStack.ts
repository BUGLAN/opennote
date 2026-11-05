/**
 * 顶部提示条的公共容器（`#notice-stack`）。
 *
 * 「站点数据被禁用」（`main.tsx`，React 之外直接挂 DOM）和「浏览器笔记本可能被清掉」
 * （`StoragePersistenceNotice`，React portal）两种提示可能同时出现。它们都放进这一个
 * 固定定位的竖向容器里依次排开，而不是各自 `position: fixed` 叠在同一个位置上。
 *
 * 容器挂在 `document.body` 上、不归 React 管：React 只往里 portal 自己的那一条，
 * `main.tsx` 只往里 append 自己的那一条，互不碰对方的节点。
 */
export function noticeStack(): HTMLElement {
  const existing = document.getElementById("notice-stack");
  if (existing) return existing;
  const stack = document.createElement("div");
  stack.id = "notice-stack";
  stack.className = "notice-stack";
  document.body.appendChild(stack);
  return stack;
}
