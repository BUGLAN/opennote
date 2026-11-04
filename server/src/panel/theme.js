/*
 * 主题：在 <head> 里同步执行（不是模块），页面画出来之前就定好素笺 / 夜读，免得先白后黑闪一下。
 * 默认跟随系统；侧栏底部的切换会写进 localStorage（读不到就当没写过）。
 */
(function () {
  "use strict";
  var saved = null;
  try {
    saved = window.localStorage.getItem("opennote-panel-theme");
  } catch (error) {
    saved = null;
  }
  var dark = saved === "night" || (saved !== "paper" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "night" : "paper");
})();
