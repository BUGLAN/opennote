/*
 * 公开分享页（/s/<id>）的唯一一段脚本：把「分享于」的 UTC 时间换成读者本地时间。
 * 页面不依赖它 —— 脚本不跑也照样能读（显示的是 UTC）。
 */
(function () {
  "use strict";
  var nodes = document.querySelectorAll("time[datetime]");
  for (var index = 0; index < nodes.length; index += 1) {
    var node = nodes[index];
    var date = new Date(node.getAttribute("datetime"));
    if (isNaN(date.getTime())) continue;
    try {
      node.textContent = date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
      node.title = date.toISOString();
    } catch (error) {
      /* 留着 UTC 那一份 */
    }
  }
})();
