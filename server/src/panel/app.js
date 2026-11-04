/*
 * 入口：按路径决定画哪一页。
 *
 * | 路径 | 画什么 |
 * | --- | --- |
 * | /join/<码> | 接受邀请 |
 * | /reset/<码> | 设置新密码 |
 * | /admin… | 零账号 → 初始化；没登录 → 登录；否则控制台 |
 *
 * 「是不是管理员」由 GET /v1/panel/session 回答：不是管理员时 me 为 null，页面一个控制台的 DOM 都不生成。
 * 真正的闸门在服务端（每个 /v1/admin/* 都先判 is_admin）。
 */

import { get, post, setUnauthorizedHandler } from "./api.js";
import { h, mount, loading, toast } from "./dom.js";
import { forgetCachedPage, renderConsole, route } from "./console.js";
import { renderAuthResult, renderJoin, renderLogin, renderReset, renderSetup } from "./public.js";

const root = document.getElementById("root");

function navigate(path) {
  if (path !== location.pathname + location.search) history.pushState(null, "", path);
  else forgetCachedPage(); // 再点一次当前页 = 刷新这一页
  // 滚回顶部放在 console.js 换页的那一刻：开 / 关用户详情不该把列表滚走。
  route();
}

async function bootAdmin() {
  mount(root, h("div", { class: "center-card" }, loading("正在连接服务器…")));
  let session;
  try {
    session = await get("/v1/panel/session");
  } catch (error) {
    mount(root, h("div", { class: "center-card" }, h("p", { class: "message", text: error.message }), h("button", { type: "button", class: "btn mt", text: "重试", onClick: bootAdmin })));
    return;
  }
  if (session.setupRequired) {
    document.title = "初始化 · Opennote 同步";
    if (location.pathname !== "/admin") history.replaceState(null, "", "/admin");
    return renderSetup(root, session, bootAdmin);
  }
  if (!session.me) {
    document.title = "登录 · Opennote 同步";
    return renderLogin(root, session, bootAdmin);
  }
  renderConsole(root, {
    me: session.me,
    session,
    navigate,
    signOut: async () => {
      try {
        await post("/v1/panel/logout");
      } catch {
        /* 退出失败也回到登录页：cookie 已经清不掉的话，下一次 session 会告诉我们 */
      }
      bootAdmin();
    },
  });
}

setUnauthorizedHandler(() => {
  toast("登录已过期，请重新登录", "error");
  bootAdmin();
});

window.addEventListener("popstate", () => {
  if (location.pathname.startsWith("/admin")) route();
});

const join = /^\/join\/([^/]+)\/?$/.exec(location.pathname);
const reset = /^\/reset\/([^/]+)\/?$/.exec(location.pathname);
if (location.pathname === "/auth/result") {
  document.title = "GitHub 登录 · Opennote 同步";
  renderAuthResult(root, new URLSearchParams(location.search));
} else if (join) {
  document.title = "接受邀请 · Opennote 同步";
  renderJoin(root, decodeURIComponent(join[1]));
} else if (reset) {
  document.title = "设置密码 · Opennote 同步";
  renderReset(root, decodeURIComponent(reset[1]));
} else {
  bootAdmin();
}
