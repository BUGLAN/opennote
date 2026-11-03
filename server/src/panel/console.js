/*
 * 控制台：侧栏 + 七页（概览 / 活动日志 / 用户 + 详情抽屉 / 邀请 / 笔记本 / 设备 / 服务设置）。
 * 版式照 docs/sync/mockups/03-admin.html。路由是真路径（/admin/users/…），服务端对 /admin/* 都发同一份外壳。
 *
 * 每页的写法一样：先画「正在读取」，取数，再整页画出来；筛选 / 搜索只重画表格那一块，
 * 免得输入框在打字时被换掉、丢焦点。
 */

import { ApiError, del, get, patch, post } from "./api.js";
import {
  GB,
  ago,
  bar,
  busy,
  bytes,
  clock,
  confirm,
  copy,
  date,
  dateTime,
  debounce,
  deviceIcon,
  duration,
  errorSlot,
  h,
  icon,
  initial,
  linkBox,
  loading,
  modal,
  mount,
  number,
  platformLabel,
  segmented,
  toGb,
  toast,
  toastError,
  until,
} from "./dom.js";
import { githubMark } from "./public.js";

const NAV = [
  ["运行", [["概览", "/admin", "activity"], ["活动日志", "/admin/activity", "scroll"]]],
  ["人与数据", [["用户", "/admin/users", "users"], ["邀请", "/admin/invites", "mail"], ["笔记本", "/admin/notebooks", "book"], ["设备", "/admin/devices", "devices"]]],
  ["服务", [["服务设置", "/admin/settings", "settings"]]],
];

const CATEGORY_LABEL = { sync: "同步", conflict: "冲突", account: "账号", admin: "管理", error: "错误" };
const REGISTRATION_LABEL = { invite: "仅限邀请", open: "开放注册", closed: "关闭注册" };

/** 控制台的上下文：当前管理员、会话信息、导航与退出（由 app.js 给）。 */
let ctx = null;
let shell = null;
/** 侧栏「邀请」旁的数字。 */
let pendingInvites = 0;
/** 每页记住的筛选（切页回来还在）。 */
const memory = {
  users: { filter: "all", q: "" },
  notebooks: { filter: "all", q: "", sort: "size" },
  devices: { filter: "all", q: "" },
  activity: { category: null, q: "" },
  lastInvite: null,
};

export function renderConsole(root, context) {
  ctx = context;
  const side = h("nav", { class: "admin__side", attrs: { "aria-label": "控制台导航" } });
  const main = h("section", { class: "admin__main" });
  const overlay = h("div");
  shell = { side, main, overlay };
  mount(root, h("div", { class: "admin" }, side, main), overlay);
  refreshInviteCount();
  route();
}

/** 按当前地址画一页（app.js 在 popstate 时也调它）。 */
export function route() {
  if (!shell) return;
  const path = location.pathname.replace(/\/+$/, "") || "/admin";
  const params = new URLSearchParams(location.search);
  const userMatch = /^\/admin\/users\/([0-9a-f]{32})$/.exec(path);
  const section = userMatch ? "/admin/users" : path;
  drawSide(section);
  shell.main.className = "admin__main" + (section === "/admin/settings" ? " admin__main--narrow" : "");
  mount(shell.overlay);

  const pages = {
    "/admin": pageOverview,
    "/admin/activity": pageActivity,
    "/admin/users": pageUsers,
    "/admin/invites": pageInvites,
    "/admin/notebooks": pageNotebooks,
    "/admin/devices": pageDevices,
    "/admin/settings": pageSettings,
  };
  const page = pages[section];
  if (!page) {
    mount(shell.main, pageHead("找不到这一页", "地址可能写错了。"), h("a", { class: "btn", href: "/admin", onClick: navLink("/admin"), text: "回到概览" }));
    return;
  }
  document.title = titleOf(section) + " · Opennote 同步";
  run(page, params);
  if (userMatch) openUser(userMatch[1]);
}

function titleOf(section) {
  for (const [, items] of NAV) for (const [label, path] of items) if (path === section) return label;
  return "控制台";
}

/** 跑一页：出错时画一块可重试的错误，而不是一片空白。 */
async function run(page, params) {
  mount(shell.main, loading());
  try {
    await page(shell.main, params);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return; // app.js 会切回登录页
    mount(
      shell.main,
      h("div", { class: "callout callout--attn page-error" }, h("b", { text: "这一页没读出来" }), "：" + (error.message || String(error)) + " ", h("button", { type: "button", class: "link", text: "重试", onClick: () => route() })),
    );
  }
}

/** 页内链接：拦下点击走 pushState，保留中键 / Cmd 点击开新标签。 */
function navLink(path) {
  return (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) return;
    event.preventDefault();
    ctx.navigate(path);
  };
}

function a(path, label, cls) {
  return h("a", { class: cls || "link", href: path, onClick: navLink(path), text: label });
}

function drawSide(section) {
  const me = ctx.me;
  const themeButton = h("button", {
    type: "button",
    class: "link",
    text: document.documentElement.dataset.theme === "night" ? "素笺" : "夜读",
    onClick: () => {
      const next = document.documentElement.dataset.theme === "night" ? "paper" : "night";
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem("opennote-panel-theme", next);
      } catch {
        /* 存不了就只管这一次 */
      }
      themeButton.textContent = next === "night" ? "素笺" : "夜读";
    },
  });
  mount(
    shell.side,
    h("div", { class: "admin__brand" }, h("span", { class: "seal", text: "記" }), h("span", {}, "Opennote 同步", h("small", { text: location.host + " · 管理控制台" }))),
    NAV.map(([group, items]) => [
      h("div", { class: "admin__group", text: group }),
      items.map(([label, path, iconName]) =>
        h(
          "a",
          { class: "admin__nav" + (path === section ? " is-active" : ""), href: path, onClick: navLink(path), attrs: path === section ? { "aria-current": "page" } : {} },
          icon(iconName, 15),
          label,
          path === "/admin/invites" && pendingInvites > 0 ? h("span", { class: "count", text: String(pendingInvites) }) : null,
        ),
      ),
    ]),
    h(
      "div",
      { class: "admin__foot" },
      h("span", { text: "协议 " + ctx.session.protocolVersion }),
      h("span", { class: "email", text: me.email || me.displayName || "管理员" }),
      h("span", { class: "row" }, h("button", { type: "button", class: "link", text: "退出", onClick: () => ctx.signOut() }), "·", themeButton),
    ),
  );
}

async function refreshInviteCount() {
  try {
    const data = await get("/v1/admin/invites");
    pendingInvites = data.invites.filter((invite) => invite.state === "open").length;
    drawSide(currentSection());
  } catch {
    /* 侧栏数字取不到不影响页面 */
  }
}

function currentSection() {
  const path = location.pathname.replace(/\/+$/, "") || "/admin";
  return /^\/admin\/users\//.test(path) ? "/admin/users" : path;
}

function pageHead(title, subtitle, ...actions) {
  return h("div", { class: "page-head" }, h("div", { class: "grow" }, h("h1", { text: title }), subtitle ? h("p", {}, subtitle) : null), actions);
}

function panel(title, options, ...body) {
  return h(
    "div",
    { class: "panel" + (options && options.attn ? " panel--attn" : "") },
    title ? h("div", { class: "panel__head" }, h("h2", { text: title }), options && options.tag !== undefined ? options.tag : null, options && options.right ? [h("span", { class: "grow" }), options.right] : null) : null,
    body,
  );
}

/** 「GitHub @x · 密码」这一格。 */
function loginMethodsText(methods) {
  const parts = [];
  if (methods.github) parts.push(h("span", {}, githubMark(), " @" + methods.github));
  if (methods.password) parts.push(h("span", { class: "muted", text: "密码" }));
  if (parts.length === 0) return h("span", { class: "muted", text: "还没设密码" });
  return h("span", {}, parts.flatMap((part, index) => (index === 0 ? [part] : [h("span", { class: "muted", text: " · " }), part])));
}

function accountName(account) {
  return account.displayName || account.email || "账号 " + account.accountId.slice(0, 8);
}

function quotaRatio(quota) {
  return quota.bytesLimit > 0 ? quota.bytesUsed / quota.bytesLimit : 0;
}

/* ================================================================ 概览 */

async function pageOverview(main) {
  const data = await get("/v1/admin/overview");
  const { now } = data;
  const s = data.server;

  const attention = data.attention.map((item) => {
    if (item.kind === "quota") {
      const ratio = Math.round((item.bytesUsed / item.bytesLimit) * 100);
      return h(
        "div",
        { class: "list__row" },
        h("span", { class: "ring" }),
        h("div", { class: "grow" }, (item.email || item.label) + " 的空间快用完了", h("small", { text: bytes(item.bytesUsed) + " / " + bytes(item.bytesLimit) + "（" + ratio + "%）" })),
        h("button", { type: "button", class: "btn btn--sm", text: "调整配额", onClick: () => ctx.navigate("/admin/users/" + item.accountId) }),
      );
    }
    return h(
      "div",
      { class: "list__row" },
      h("span", { class: "ring" }),
      h("div", { class: "grow" }, "1 个邀请" + (until(item.expiresAt, now) === "明天过期" ? "明天过期" : " " + until(item.expiresAt, now)), h("small", { text: item.email ? "发给 " + item.email + "，还没有接受" : "通用链接，还没用完" })),
      h("button", { type: "button", class: "btn btn--sm", text: "查看", onClick: () => ctx.navigate("/admin/invites") }),
    );
  });

  const n = data.noteworthy;
  const noteworthy = [
    n.staleDevices > 0
      ? h(
          "div",
          { class: "list__row" },
          icon("clock"),
          h("div", { class: "grow" }, n.staleDevices + " 台设备超过 " + n.staleDays + " 天没同步", h("small", { text: "还登录着；不再用的话可以在设备页移除" })),
          h("button", { type: "button", class: "btn btn--ghost btn--sm", text: "看看", onClick: () => ctx.navigate("/admin/devices?filter=stale") }),
        )
      : null,
    n.conflictsThisWeek > 0
      ? h("div", { class: "list__row" }, icon("rotate"), h("div", { class: "grow" }, "本周 " + n.conflictsThisWeek + " 次写入冲突", h("small", { text: "冲突由客户端裁决，这里只看数量" })), h("button", { type: "button", class: "btn btn--ghost btn--sm", text: "看看", onClick: () => ctx.navigate("/admin/activity?category=conflict") }))
      : null,
    n.errorsThisWeek > 0
      ? h("div", { class: "list__row" }, icon("alert"), h("div", { class: "grow" }, "本周 " + n.errorsThisWeek + " 次请求在存储那一侧出错", h("small", { text: "多半是 CouchDB 连不上或超时" })), h("button", { type: "button", class: "btn btn--ghost btn--sm", text: "看看", onClick: () => ctx.navigate("/admin/activity?category=error") }))
      : null,
  ].filter(Boolean);

  mount(
    main,
    pageHead(
      "概览",
      (s.couchVersion ? "服务运行正常" : "CouchDB 现在连不上，同步请求会失败") + " · 已运行 " + duration(s.uptimeSeconds),
      h("button", { type: "button", class: "btn btn--primary", text: "邀请用户", onClick: () => ctx.navigate("/admin/invites") }),
    ),
    h(
      "div",
      { class: "stats" },
      stat("用户", number(data.users.total), data.users.pendingInvites > 0 ? data.users.pendingInvites + " 个待接受邀请" : data.users.admins + " 个管理员"),
      stat("设备", number(data.devices.total), data.devices.online + " 台此刻在线"),
      stat("存储", bytes(data.storage.usedBytes), data.storage.diskFreeBytes !== null ? "磁盘剩余 " + bytes(data.storage.diskFreeBytes) : data.storage.notebooks + " 个笔记本"),
      stat("今日同步", number(data.today.changes), "次文件变更"),
    ),
    h(
      "div",
      { class: "grid2" },
      h(
        "div",
        {},
        panel(
          "需要你处理",
          { tag: attention.length > 0 ? h("span", { class: "tag tag--accent", text: String(attention.length) }) : null, attn: attention.length > 0 },
          attention.length > 0 ? h("div", { class: "list list--flush" }, attention) : h("div", { class: "list__empty" }, "没有要处理的事。"),
        ),
        panel("值得留意", null, noteworthy.length > 0 ? h("div", { class: "list list--flush" }, noteworthy) : h("div", { class: "list__empty" }, "一切正常：没有长期不同步的设备，本周没有冲突和出错。")),
        panel(
          "运行状态",
          null,
          h(
            "div",
            { class: "panel__body" },
            h(
              "dl",
              { class: "kv" },
              h("dt", { text: "协议版本" }),
              h("dd", { text: String(s.protocolVersion) }),
              h("dt", { text: "CouchDB" }),
              h("dd", { class: s.couchVersion ? null : "accent", text: s.couchVersion ? "正常 · " + s.couchVersion : "连不上" }),
              h("dt", { text: "控制面数据库" }),
              h("dd", { text: bytes(s.databaseBytes) }),
              h("dt", { text: "单个文件上限" }),
              h("dd", { text: bytes(s.maxFileBytes) }),
              h("dt", { text: "对外地址" }),
              h("dd", { class: "mono break", text: s.externalBaseUrl }),
            ),
          ),
        ),
      ),
      panel("最近活动", { right: a("/admin/activity", "全部 →") }, feed(data.recent, now, "还没有活动。")),
    ),
  );
}

function stat(label, value, sub) {
  return h("div", { class: "stat" }, h("small", { text: label }), h("b", { text: value }), h("span", { text: sub }));
}

function feed(entries, now, emptyText, withTags) {
  if (entries.length === 0) return h("div", { class: "list__empty", text: emptyText });
  return h(
    "div",
    { class: "feed" },
    entries.map((entry) =>
      h(
        "div",
        { class: "feed__row" },
        h("time", { attrs: { datetime: new Date(entry.at).toISOString(), title: dateTime(entry.at) }, text: clock(entry.at, now) }),
        h("div", { class: "grow" }, h("b", { text: entry.actor }), " · " + entry.text),
        withTags ? h("span", { class: "tag" + (entry.category === "conflict" || entry.category === "error" ? " tag--accent" : ""), text: CATEGORY_LABEL[entry.category] }) : null,
      ),
    ),
  );
}

/* ============================================================ 活动日志 */

async function pageActivity(main, params) {
  const state = memory.activity;
  if (params.has("category")) state.category = params.get("category") || null;
  const list = h("div");
  const search = h("input", { class: "field", type: "search", placeholder: "搜索人、笔记本或动作", value: state.q });
  const filterSlot = h("div");
  let entries = [];
  let nextOffset = null;
  let now = Date.now();

  const query = (offset, limit) => {
    const qs = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    if (state.category) qs.set("category", state.category);
    if (state.q.trim()) qs.set("q", state.q.trim());
    return get("/v1/admin/activity?" + qs.toString());
  };

  const draw = () => {
    mount(
      list,
      feed(entries, now, state.q || state.category ? "没有符合条件的记录。" : "还没有活动。", true),
      nextOffset !== null ? h("div", { class: "feed__more" }, h("button", { type: "button", class: "btn btn--sm", text: "再看更早的", onClick: (event) => busy(event.currentTarget, loadMore) })) : null,
    );
  };
  const load = async () => {
    mount(list, loading());
    const data = await query(0, 100);
    entries = data.entries;
    nextOffset = data.nextOffset;
    now = data.now;
    draw();
  };
  const loadMore = async () => {
    const data = await query(nextOffset, 100);
    entries = entries.concat(data.entries);
    nextOffset = data.nextOffset;
    draw();
  };
  const drawFilter = () =>
    mount(
      filterSlot,
      segmented(
        [[null, "全部"], ["sync", "同步"], ["conflict", "冲突"], ["account", "账号与设备"], ["admin", "管理操作"], ["error", "错误"]],
        state.category,
        (value) => {
          state.category = value;
          drawFilter();
          load().catch(toastError);
        },
      ),
    );
  search.addEventListener(
    "input",
    debounce(() => {
      state.q = search.value;
      load().catch(toastError);
    }, 250),
  );

  const exportCsv = async () => {
    const rows = [];
    let offset = 0;
    for (;;) {
      const data = await query(offset, 500);
      rows.push(...data.entries);
      if (data.nextOffset === null || rows.length >= 5000) break;
      offset = data.nextOffset;
    }
    downloadCsv(rows);
  };

  drawFilter();
  mount(
    main,
    pageHead("活动日志", "只记录「谁、什么时候、做了什么」，不记录笔记内容。同步按「人 · 笔记本 · 天」汇总。", h("button", { type: "button", class: "btn", onClick: (event) => busy(event.currentTarget, exportCsv).catch(toastError) }, icon("download", 14), "导出 CSV")),
    panel(null, null, h("div", { class: "toolbar" }, search, filterSlot), list),
  );
  await load();
}

function downloadCsv(entries) {
  // 以 = + - @ 开头的格子会被表格软件当公式执行：前面垫一个 '。
  const cell = (value) => {
    let text = String(value ?? "");
    if (/^[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  const lines = [["时间", "类别", "谁", "做了什么", "IP"].map(cell).join(",")];
  for (const entry of entries) lines.push([dateTime(entry.at), CATEGORY_LABEL[entry.category], entry.actor, entry.text, entry.ip || ""].map(cell).join(","));
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = h("a", { href: url, download: "opennote-activity-" + date(Date.now()) + ".csv" });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ================================================================ 用户 */

let usersRedraw = null;

async function pageUsers(main) {
  const state = memory.users;
  const [data, settings] = await Promise.all([get("/v1/admin/accounts"), get("/v1/admin/settings")]);
  const accounts = data.accounts;
  const now = Date.now();
  const tableSlot = h("div", { class: "table-wrap" });
  const filterSlot = h("div");
  const search = h("input", { class: "field", type: "search", placeholder: "搜索邮箱或名字", value: state.q });

  const counts = { all: accounts.length, admin: accounts.filter((x) => x.isAdmin).length, disabled: accounts.filter((x) => x.status === "disabled").length };
  const drawFilter = () =>
    mount(
      filterSlot,
      segmented(
        [["all", "全部 " + counts.all], ["admin", "管理员 " + counts.admin], ["disabled", "已停用 " + counts.disabled]],
        state.filter,
        (value) => {
          state.filter = value;
          drawFilter();
          drawTable();
        },
      ),
    );
  const drawTable = () => {
    const q = state.q.trim().toLowerCase();
    const rows = accounts
      .filter((x) => (state.filter === "admin" ? x.isAdmin : state.filter === "disabled" ? x.status === "disabled" : true))
      .filter((x) => !q || ((x.email || "") + " " + (x.displayName || "")).toLowerCase().includes(q));
    mount(
      tableSlot,
      h(
        "table",
        { class: "t" },
        h("thead", {}, h("tr", {}, ["用户", "角色", "登录方式", "笔记本", "设备", "空间", "最近同步", ""].map((label, index) => h("th", { class: index === 3 || index === 4 ? "num" : null, text: label })))),
        h(
          "tbody",
          {},
          rows.length === 0
            ? h("tr", {}, h("td", { class: "t-empty", attrs: { colspan: "8" }, text: q ? "没有符合条件的用户。" : "还没有用户。" }))
            : rows.map((x) => {
                const ratio = quotaRatio(x.quota);
                const attn = ratio >= 0.9;
                const open = () => ctx.navigate("/admin/users/" + x.accountId);
                return h(
                  "tr",
                  { class: "is-clickable" + (x.status === "disabled" ? " is-dim" : ""), onClick: open },
                  h(
                    "td",
                    {},
                    h(
                      "span",
                      { class: "who" },
                      h("span", { class: "avatar", text: initial(x.displayName || x.email) }),
                      x.email || "（没有邮箱）",
                      x.accountId === ctx.me.accountId ? h("small", { class: "inline", text: "（你）" }) : x.displayName ? h("small", { class: "inline", text: x.displayName }) : null,
                    ),
                  ),
                  h("td", {}, x.status === "disabled" ? h("span", { class: "tag", text: "已停用" }) : h("span", { class: x.isAdmin ? "tag" : "tag tag--solid", text: x.isAdmin ? "管理员" : "成员" })),
                  h("td", { class: "nowrap" }, loginMethodsText(x.loginMethods)),
                  h("td", { class: "num", text: String(x.notebookCount) }),
                  h("td", { class: "num", text: String(x.deviceCount) }),
                  h("td", { class: "nowrap" }, bar(ratio, { attn }), h("span", { class: attn ? "accent" : "muted", text: bytes(x.quota.bytesUsed) + " / " + bytes(x.quota.bytesLimit) })),
                  h("td", { class: x.lastSyncAt ? null : "muted", text: ago(x.lastSyncAt, now) }),
                  h("td", { class: "act" }, h("button", { type: "button", class: attn ? "btn btn--sm" : "btn btn--ghost btn--sm", text: "管理", onClick: (event) => (event.stopPropagation(), open()) })),
                );
              }),
        ),
      ),
    );
  };
  search.addEventListener("input", () => {
    state.q = search.value;
    drawTable();
  });
  usersRedraw = () => pageUsers(main).catch(toastError);

  drawFilter();
  drawTable();
  mount(
    main,
    pageHead(
      "用户",
      accounts.length + " 个账号 · 默认配额 " + bytes(settings.defaultQuotaBytes) + " / 人 · " + REGISTRATION_LABEL[settings.registration],
      h("button", { type: "button", class: "btn btn--primary", text: "邀请用户", onClick: () => ctx.navigate("/admin/invites") }),
    ),
    panel(null, null, h("div", { class: "toolbar" }, search, filterSlot), tableSlot),
  );
}

/* ------------------------------------------------------------ 用户详情 */

async function openUser(accountId) {
  const close = () => ctx.navigate("/admin/users");
  const body = h("div", { class: "drawer__body" }, loading());
  const head = h("div", { class: "drawer__head" });
  const foot = h("div", { class: "drawer__foot" });
  const drawer = h("aside", { class: "drawer", attrs: { role: "dialog", "aria-label": "用户详情" } }, head, body, foot);
  const onKey = (event) => {
    if (event.key === "Escape" && !document.querySelector(".modal")) close();
  };
  document.addEventListener("keydown", onKey);
  const observer = new MutationObserver(() => {
    if (!drawer.isConnected) {
      document.removeEventListener("keydown", onKey);
      observer.disconnect();
    }
  });
  mount(shell.overlay, h("div", { class: "scrim", onClick: close }), drawer);
  observer.observe(shell.overlay, { childList: true });

  const draw = async () => {
    let data;
    try {
      data = await get("/v1/admin/accounts/" + accountId);
    } catch (error) {
      mount(head, h("b", { class: "grow", text: "用户详情" }), closeButton(close));
      mount(body, h("div", { class: "callout callout--attn", text: error.status === 404 ? "这个账号不存在（可能刚被删掉）。" : error.message }));
      mount(foot);
      return;
    }
    const x = data.account;
    const now = data.now;
    const reload = async () => {
      await draw();
      if (usersRedraw) usersRedraw();
    };
    mount(
      head,
      h("span", { class: "avatar avatar--lg", text: initial(x.displayName || x.email) }),
      h("div", { class: "grow" }, h("b", { text: accountName(x) }), h("div", { class: "muted", text: [x.email, x.status === "disabled" ? "已停用" : x.isAdmin ? "管理员" : "成员", date(x.createdAt) + " 加入"].filter(Boolean).join(" · ") })),
      closeButton(close),
    );
    mount(body, ...userSections(data, now, reload));
    mount(
      foot,
      data.isSelf
        ? h("span", { class: "hint", text: "这是你自己的账号：不能在这里删除或停用。" })
        : h("button", {
            type: "button",
            class: "btn btn--danger btn--sm",
            text: "删除账号和全部数据…",
            onClick: async () => {
              const ok = await confirm({
                title: "删除 " + accountName(x) + "？",
                message: "账号、它的设备、它独占的笔记本（连同服务器上的库）都会被删掉，不能恢复。共享给别人的笔记本会移交给其他成员。",
                note: "对方本机上的笔记文件不受影响。",
                requireText: x.email || x.accountId,
                confirmText: "删除",
                danger: true,
              });
              if (!ok) return;
              try {
                const result = await del("/v1/admin/accounts/" + x.accountId);
                toast("已删除" + (result.databasesDeleted ? "，清掉 " + result.databasesDeleted + " 个库" : ""));
                ctx.navigate("/admin/users");
                if (usersRedraw) usersRedraw();
              } catch (error) {
                toastError(error);
              }
            },
          }),
    );
  };
  await draw();
}

function closeButton(onClick) {
  return h("button", { type: "button", class: "icon-btn", attrs: { "aria-label": "关闭" }, onClick }, icon("x", 16));
}

function userSections(data, now, reload) {
  const x = data.account;
  const ratio = quotaRatio(x.quota);
  const sections = [];

  if (x.status === "disabled") {
    sections.push(h("div", { class: "callout callout--attn", text: "账号已停用：它所有设备的请求都会被拒绝。重新启用后立刻恢复，不用重新登录。" }));
  } else if (ratio >= 0.9) {
    sections.push(h("div", { class: "callout callout--attn", text: "空间已用 " + Math.round(ratio * 100) + "%。" }));
  }

  /* 空间配额 */
  const gb = h("input", { class: "field field--num", type: "number", min: "0", step: "0.5", value: String(toGb(x.quota.bytesLimit)), attrs: { "aria-label": "配额（GB）" } });
  const saveQuota = (quotaBytes) => async () => {
    try {
      await patch("/v1/admin/accounts/" + x.accountId, { quotaBytes });
      toast(quotaBytes === null ? "已恢复为默认配额" : "配额已改为 " + bytes(quotaBytes));
      await reload();
    } catch (error) {
      toastError(error);
    }
  };
  sections.push(
    h(
      "div",
      {},
      h("p", { class: "section-h", text: "空间配额" }),
      bar(ratio, { progress: true, attn: ratio >= 0.9 }),
      h(
        "div",
        { class: "row mt" },
        h("span", { class: "setting__meta grow", text: bytes(x.quota.bytesUsed) + " / " + bytes(x.quota.bytesLimit) }),
        gb,
        h("span", { class: "setting__meta", text: "GB" }),
        h("button", {
          type: "button",
          class: "btn btn--sm btn--primary",
          text: "保存",
          onClick: (event) => {
            const value = Number(gb.value);
            if (!Number.isFinite(value) || value < 0) return toast("配额要是一个不小于 0 的数", "error");
            busy(event.currentTarget, saveQuota(Math.round(value * GB)));
          },
        }),
      ),
      h("p", { class: "hint mt" }, "配额现在只用来显示和提醒，超出不会拦截上传。", h("button", { type: "button", class: "link", text: "恢复默认配额", onClick: (event) => busy(event.currentTarget, saveQuota(null)) })),
    ),
  );

  /* 笔记本 */
  const roleLabel = { owner: "拥有", editor: "可编辑", viewer: "只读" };
  sections.push(
    h(
      "div",
      {},
      h("p", { class: "section-h", text: "笔记本（" + data.notebooks.length + "）" }),
      h(
        "div",
        { class: "list" },
        data.notebooks.length === 0
          ? h("div", { class: "list__empty", text: "还没有同步任何笔记本。" })
          : data.notebooks.map((nb) =>
              h(
                "div",
                { class: "list__row" },
                nb.cryptoMode === "user-key" ? icon("lock") : icon("book"),
                h("div", { class: "grow" }, nb.name, h("small", { text: bytes(nb.bytesUsed) + " · " + roleLabel[nb.role] + (nb.cryptoMode === "user-key" ? " · 内容对服务器不可见" : "") })),
                h("span", { class: nb.cryptoMode === "user-key" ? "tag tag--accent" : "tag tag--solid", text: nb.cryptoMode === "user-key" ? "加密" : "明文" }),
              ),
            ),
      ),
    ),
  );

  /* 设备 */
  sections.push(
    h(
      "div",
      {},
      h("p", { class: "section-h", text: "设备（" + data.devices.filter((d) => d.signedIn).length + "）" }),
      h(
        "div",
        { class: "list" },
        data.devices.length === 0
          ? h("div", { class: "list__empty", text: "还没有登录过任何设备。" })
          : data.devices.map((device) =>
              h(
                "div",
                { class: "list__row" },
                icon(deviceIcon(device)),
                h("div", { class: "grow" + (device.signedIn ? "" : " muted") }, device.name || "未命名设备", h("small", { text: platformLabel(device) + " · " + (device.signedIn ? (device.online ? "在线" : ago(device.lastSeenAt, now)) : signedOutText(device, now)) })),
                device.signedIn ? h("button", { type: "button", class: "btn btn--ghost btn--sm", text: "移除", onClick: () => removeDevice(device, reload) }) : null,
              ),
            ),
      ),
    ),
  );

  /* 登录方式与账号动作 */
  const resetButton = h("button", { type: "button", class: "btn btn--sm", text: x.loginMethods.password ? "发送重置密码链接" : "发送设置密码链接", onClick: () => issueReset(x) });
  const adminButton = h("button", {
    type: "button",
    class: "btn btn--sm",
    text: x.isAdmin ? "取消管理员" : "设为管理员",
    disabled: data.isSelf && x.isAdmin,
    title: data.isSelf && x.isAdmin ? "不能取消自己的管理员身份" : null,
    onClick: async (event) => {
      if (!x.isAdmin) {
        const ok = await confirm({ title: "把 " + accountName(x) + " 设为管理员？", message: "管理员能登录控制台，看到所有账号、笔记本和设备，也能删除它们。", confirmText: "设为管理员" });
        if (!ok) return;
      }
      busy(event.currentTarget, async () => {
        try {
          await patch("/v1/admin/accounts/" + x.accountId, { isAdmin: !x.isAdmin });
          toast(x.isAdmin ? "已取消管理员" : "已设为管理员");
          await reload();
        } catch (error) {
          toastError(error);
        }
      });
    },
  });
  const statusButton = h("button", {
    type: "button",
    class: "btn btn--sm",
    text: x.status === "disabled" ? "重新启用" : "停用账号",
    disabled: data.isSelf,
    title: data.isSelf ? "不能停用自己" : null,
    onClick: async (event) => {
      const disabling = x.status !== "disabled";
      if (disabling) {
        const ok = await confirm({ title: "停用 " + accountName(x) + "？", message: "它所有设备的同步请求都会被拒绝，数据保留。随时可以重新启用。", confirmText: "停用" });
        if (!ok) return;
      }
      busy(event.currentTarget, async () => {
        try {
          await post("/v1/admin/accounts/" + x.accountId + "/status", { status: disabling ? "disabled" : "active" });
          toast(disabling ? "已停用" : "已重新启用");
          await reload();
        } catch (error) {
          toastError(error);
        }
      });
    },
  });
  sections.push(
    h(
      "div",
      {},
      h("p", { class: "section-h", text: "登录方式" }),
      h(
        "div",
        { class: "list" },
        x.loginMethods.github
          ? h(
              "div",
              { class: "list__row" },
              h("span", { class: "ico" }, githubMark()),
              h("div", { class: "grow" }, "GitHub @" + x.loginMethods.github, h("small", { text: x.loginMethods.password ? "也可以用密码登录" : "这是它唯一的登录方式" })),
              h("button", {
                type: "button",
                class: "btn btn--ghost btn--sm",
                text: "解绑",
                onClick: async () => {
                  const ok = await confirm({
                    title: "解绑 GitHub @" + x.loginMethods.github + "？",
                    message: x.loginMethods.password ? "解绑后对方只能用邮箱密码登录，已登录的设备不受影响。" : "这是对方唯一的登录方式。解绑后请给对方发一个设置密码链接，否则以后登录不了（已登录的设备不受影响）。",
                    confirmText: "解绑",
                    danger: true,
                  });
                  if (!ok) return;
                  try {
                    await del("/v1/admin/accounts/" + x.accountId + "/github");
                    toast("已解绑");
                    await reload();
                  } catch (error) {
                    toastError(error);
                  }
                },
              }),
            )
          : null,
        h("div", { class: "list__row" }, icon("mail"), h("div", { class: "grow" }, "邮箱密码", h("small", { text: x.loginMethods.password ? "已设置" : "还没设置：发一个设置密码链接给对方" }))),
      ),
      h("p", { class: "section-h mt-lg", text: "账号" }),
      h("div", { class: "row" }, resetButton, adminButton, statusButton),
      h("p", { class: "note", text: "重置密码不影响端到端加密的笔记本 —— 那把钥匙只在对方自己的设备上。" }),
    ),
  );

  /* 最近活动 */
  sections.push(h("div", {}, h("p", { class: "section-h", text: "最近活动" }), h("div", { class: "list" }, feed(data.recent, now, "最近 30 天没有活动。"))));
  return sections;
}

async function issueReset(account) {
  const ok = await confirm({
    title: "给 " + accountName(account) + " 生成设置密码链接？",
    message: "对方用这个链接设新密码之后，之前登录的设备会全部下线，需要用新密码重新登录。",
    note: "服务器不发邮件：链接生成后由你转交给对方。",
    confirmText: "生成链接",
  });
  if (!ok) return;
  try {
    const created = await post("/v1/admin/accounts/" + account.accountId + "/password-reset");
    await modal({
      title: "设置密码链接",
      body: h("div", { class: "stack" }, linkBox(created.url, "24 小时内有效，只能用一次。这个链接只显示这一次。")),
      actions: [{ label: "好了", value: true, primary: true }],
    });
  } catch (error) {
    toastError(error);
  }
}

/** 没有有效会话的设备：被移除的，和因为退出 / 改密码 / 重置密码而下线的，说法不同。 */
function signedOutText(device, now) {
  return device.revokedAt !== null ? "已移除 · " + ago(device.revokedAt, now) : "已登出 · 需重新登录";
}

async function removeDevice(device, after) {
  const ok = await confirm({
    title: "移除「" + (device.name || "未命名设备") + "」？",
    message: "这台设备会被登出，下次联网时提示「需要重新登录」。本机上的笔记文件不受影响。",
    confirmText: "移除",
    danger: true,
  });
  if (!ok) return;
  try {
    await del("/v1/admin/devices/" + device.deviceId);
    toast("已移除");
    await after();
  } catch (error) {
    toastError(error);
  }
}

/* ================================================================ 邀请 */

const EXPIRY = [
  [7 * 86_400, "7 天内有效"],
  [86_400, "24 小时内有效"],
  [30 * 86_400, "30 天内有效"],
];
const USES = [
  [1, "用 1 次"],
  [5, "可用 5 次"],
  [20, "可用 20 次"],
];

function select(options, value) {
  return h(
    "select",
    { class: "field field--auto" },
    options.map(([optionValue, label]) => h("option", { value: String(optionValue), selected: String(optionValue) === String(value), text: label })),
  );
}

async function pageInvites(main) {
  const [data, settings] = await Promise.all([get("/v1/admin/invites"), get("/v1/admin/settings")]);
  const now = Date.now();
  const open = data.invites.filter((invite) => invite.state === "open");
  const done = data.invites.filter((invite) => invite.state !== "open").slice(0, 30);
  pendingInvites = open.length;
  drawSide("/admin/invites");

  const quotaOptions = [[0, "默认配额（" + bytes(settings.defaultQuotaBytes) + "）"], ...[1, 5, 10, 50].map((n) => [n * GB, bytes(n * GB)])];
  const email = h("input", { class: "field field--grow", type: "email", placeholder: "对方的邮箱（可选，留空就是通用链接）" });
  const expiry = select(EXPIRY, 7 * 86_400);
  const role = select([["member", "成员"], ["admin", "管理员"]], "member");
  const quota = select(quotaOptions, 0);
  const uses = select(USES, 1);
  const syncUses = () => {
    uses.disabled = email.value.trim() !== "";
    if (uses.disabled) uses.value = "1";
  };
  email.addEventListener("input", syncUses);
  const error = errorSlot();
  const result = h("div");
  const drawResult = () => mount(result, memory.lastInvite ? linkBox(memory.lastInvite.url, "把链接发给对方：对方在网页上设一个密码，再用客户端登录。服务器不发邮件。这个链接只显示这一次。") : null);
  drawResult();
  const submit = h("button", { type: "submit", class: "btn btn--primary", text: "生成邀请链接" });
  const form = h(
    "form",
    {
      class: "panel__body stack",
      onSubmit: (event) => {
        event.preventDefault();
        error.set(null);
        busy(submit, async () => {
          try {
            const created = await post("/v1/admin/invites", {
              email: email.value.trim() || undefined,
              grantAdmin: role.value === "admin",
              quotaBytes: Number(quota.value) > 0 ? Number(quota.value) : undefined,
              expiresInSeconds: Number(expiry.value),
              maxUses: Number(uses.value),
            });
            memory.lastInvite = created;
            await pageInvites(main);
          } catch (failure) {
            error.set(failure.message);
          }
        });
      },
    },
    h("div", { class: "row" }, email, expiry, role, quota, uses, submit),
    error.node,
    result,
  );

  const roleText = (invite) => (invite.grantAdmin ? "管理员" : "成员") + " · " + bytes(invite.quotaBytes ?? settings.defaultQuotaBytes);
  const stateText = { used: "已接受", expired: "已过期", revoked: "已作废" };
  mount(
    main,
    pageHead("邀请", ["当前注册方式：" + REGISTRATION_LABEL[settings.registration] + " · ", a("/admin/settings", "更改")]),
    settings.registration === "closed" ? h("div", { class: "callout callout--attn", text: "现在是「关闭注册」：已发出的邀请链接也用不了，打开注册之后才能接受。" }) : null,
    panel("新邀请", null, form),
    panel(
      "未使用的邀请",
      { tag: h("span", { class: "tag", text: String(open.length) }) },
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          { class: "t" },
          h("thead", {}, h("tr", {}, ["发给", "角色 / 配额", "创建", "有效期", ""].map((label) => h("th", { text: label })))),
          h(
            "tbody",
            {},
            open.length === 0
              ? h("tr", {}, h("td", { class: "t-empty", attrs: { colspan: "5" }, text: "没有未使用的邀请。" }))
              : open.map((invite) => {
                  const soon = invite.expiresAt !== null && invite.expiresAt - now < 86_400_000;
                  return h(
                    "tr",
                    {},
                    h("td", { class: invite.email ? null : "muted", text: invite.email || "通用链接（可用 " + invite.maxUses + " 次，已用 " + invite.uses + " 次）" }),
                    h("td", { text: roleText(invite) }),
                    h("td", { text: (invite.creatorLabel || "命令行") + " · " + ago(invite.createdAt, now) }),
                    h("td", { class: soon ? "accent" : null, text: until(invite.expiresAt, now) }),
                    h(
                      "td",
                      { class: "act" },
                      h("button", {
                        type: "button",
                        class: "btn btn--ghost btn--sm",
                        text: "延长 7 天",
                        onClick: (event) =>
                          busy(event.currentTarget, async () => {
                            try {
                              await patch("/v1/admin/invites/" + invite.id, { extendSeconds: 7 * 86_400 });
                              toast("已延长");
                              await pageInvites(main);
                            } catch (failure) {
                              toastError(failure);
                            }
                          }),
                      }),
                      h("button", {
                        type: "button",
                        class: "btn btn--ghost btn--sm",
                        text: "作废",
                        onClick: async () => {
                          const ok = await confirm({ title: "作废这个邀请？", message: "链接立刻失效。已经用它建好的账号不受影响。", confirmText: "作废", danger: true });
                          if (!ok) return;
                          try {
                            await del("/v1/admin/invites/" + invite.id);
                            toast("已作废");
                            await pageInvites(main);
                          } catch (failure) {
                            toastError(failure);
                          }
                        },
                      }),
                    ),
                  );
                }),
          ),
        ),
      ),
    ),
    h("p", { class: "note", text: "链接只在生成时显示一次（服务器只存它的指纹）。找不到原链接了，就作废它再发一个。" }),
    done.length > 0
      ? panel(
          "已结束",
          null,
          h(
            "div",
            { class: "table-wrap" },
            h(
              "table",
              { class: "t" },
              h(
                "tbody",
                {},
                done.map((invite) =>
                  h(
                    "tr",
                    {},
                    h("td", { text: invite.acceptedByLabel || invite.email || "通用链接" }),
                    h("td", { class: "muted", text: roleText(invite) }),
                    h("td", { class: "muted", text: stateText[invite.state] + " · " + date(invite.createdAt) + " 发出" }),
                  ),
                ),
              ),
            ),
          ),
        )
      : null,
  );
  syncUses();
}

/* ============================================================== 笔记本 */

async function pageNotebooks(main) {
  const state = memory.notebooks;
  const data = await get("/v1/admin/notebooks");
  const now = data.now;
  const notebooks = data.notebooks;
  const tableSlot = h("div", { class: "table-wrap" });
  const filterSlot = h("div");
  const search = h("input", { class: "field", type: "search", placeholder: "搜索笔记本或所有者", value: state.q });
  const sort = select([["size", "按大小"], ["recent", "按最近改动"], ["created", "按创建时间"]], state.sort);
  const encrypted = notebooks.filter((nb) => nb.cryptoMode === "user-key").length;
  const total = notebooks.reduce((sum, nb) => sum + nb.bytesUsed, 0);

  const drawFilter = () =>
    mount(
      filterSlot,
      segmented([["all", "全部"], ["plain", "明文"], ["encrypted", "加密"]], state.filter, (value) => {
        state.filter = value;
        drawFilter();
        drawTable();
      }),
    );
  const drawTable = () => {
    const q = state.q.trim().toLowerCase();
    const rows = notebooks
      .filter((nb) => (state.filter === "plain" ? nb.cryptoMode === "none" : state.filter === "encrypted" ? nb.cryptoMode === "user-key" : true))
      .filter((nb) => !q || (nb.name + " " + (nb.ownerLabel || "")).toLowerCase().includes(q))
      .sort((x, y) => (state.sort === "recent" ? (y.lastChangeAt ?? 0) - (x.lastChangeAt ?? 0) : state.sort === "created" ? y.createdAt - x.createdAt : y.bytesUsed - x.bytesUsed));
    mount(
      tableSlot,
      h(
        "table",
        { class: "t" },
        h("thead", {}, h("tr", {}, [["笔记本"], ["所有者"], ["类型"], ["大小", "num"], ["最近改动"], ["创建"]].map(([label, cls]) => h("th", { class: cls || null, text: label })))),
        h(
          "tbody",
          {},
          rows.length === 0
            ? h("tr", {}, h("td", { class: "t-empty", attrs: { colspan: "6" }, text: q || state.filter !== "all" ? "没有符合条件的笔记本。" : "还没有人同步笔记本。" }))
            : rows.map((nb) =>
                h(
                  "tr",
                  {},
                  h("td", {}, nb.name, h("small", { text: (nb.memberCount > 1 ? "共享给 " + (nb.memberCount - 1) + " 人 · " : "") + "id " + nb.id.slice(0, 8) })),
                  h("td", {}, a("/admin/users/" + nb.ownerId, nb.ownerLabel || "账号 " + nb.ownerId.slice(0, 8))),
                  h("td", {}, h("span", { class: nb.cryptoMode === "user-key" ? "tag tag--accent" : "tag tag--solid", text: nb.cryptoMode === "user-key" ? "端到端加密" : "明文" })),
                  h("td", { class: "num", text: bytes(nb.bytesUsed) }),
                  h("td", { class: nb.lastChangeAt ? null : "muted", text: ago(nb.lastChangeAt, now) }),
                  h("td", { class: "muted", text: date(nb.createdAt) }),
                ),
              ),
        ),
      ),
    );
  };
  search.addEventListener("input", () => {
    state.q = search.value;
    drawTable();
  });
  sort.addEventListener("change", () => {
    state.sort = sort.value;
    drawTable();
  });
  drawFilter();
  drawTable();
  mount(
    main,
    pageHead("笔记本", notebooks.length + " 个 · 共 " + bytes(total) + (encrypted > 0 ? " · 其中 " + encrypted + " 个端到端加密" : "")),
    panel(null, null, h("div", { class: "toolbar" }, search, filterSlot, h("span", { class: "grow" }), sort), tableSlot),
    h("p", { class: "note", text: "端到端加密的笔记本，服务器只存密文：这里的大小是密文的大小，内容服务器看不到。" }),
  );
}

/* ================================================================ 设备 */

async function pageDevices(main, params) {
  const state = memory.devices;
  if (params.has("filter")) state.filter = params.get("filter");
  const data = await get("/v1/admin/devices");
  const now = data.now;
  const devices = data.devices;
  const staleCutoff = now - data.staleDays * 86_400_000;
  const isStale = (device) => device.signedIn && (device.lastSeenAt ?? device.createdAt) < staleCutoff;
  const signedIn = devices.filter((device) => device.signedIn);
  const counts = {
    all: signedIn.length,
    online: devices.filter((device) => device.online).length,
    stale: devices.filter(isStale).length,
    removed: devices.length - signedIn.length,
  };
  const tableSlot = h("div", { class: "table-wrap" });
  const filterSlot = h("div");
  const search = h("input", { class: "field", type: "search", placeholder: "搜索设备或用户", value: state.q });
  const reload = () => pageDevices(main, new URLSearchParams()).catch(toastError);

  const drawFilter = () =>
    mount(
      filterSlot,
      segmented(
        [["all", "登录中 " + counts.all], ["online", "在线 " + counts.online], ["stale", data.staleDays + " 天未同步 " + counts.stale], ["removed", "已登出 " + counts.removed]],
        state.filter,
        (value) => {
          state.filter = value;
          drawFilter();
          drawTable();
        },
      ),
    );
  const drawTable = () => {
    const q = state.q.trim().toLowerCase();
    const rows = devices
      .filter((device) => (state.filter === "online" ? device.online : state.filter === "stale" ? isStale(device) : state.filter === "removed" ? !device.signedIn : device.signedIn))
      .filter((device) => !q || ((device.name || "") + " " + (device.accountLabel || "")).toLowerCase().includes(q));
    mount(
      tableSlot,
      h(
        "table",
        { class: "t" },
        h("thead", {}, h("tr", {}, ["设备", "用户", "平台", "客户端", "最近同步", ""].map((label) => h("th", { text: label })))),
        h(
          "tbody",
          {},
          rows.length === 0
            ? h("tr", {}, h("td", { class: "t-empty", attrs: { colspan: "6" }, text: "没有符合条件的设备。" }))
            : rows.map((device) =>
                h(
                  "tr",
                  { class: device.signedIn ? null : "is-dim" },
                  h("td", {}, h("span", { class: "row" }, icon(deviceIcon(device)), device.name || "未命名设备")),
                  h("td", {}, a("/admin/users/" + device.accountId, device.accountLabel || "账号 " + device.accountId.slice(0, 8))),
                  h("td", { text: platformLabel(device) }),
                  h("td", { class: device.clientVersion ? "mono" : "muted", text: device.clientVersion || "—" }),
                  h("td", { class: isStale(device) ? "muted" : null }, device.online ? [h("span", { class: "dot dot--on" }), "在线"] : device.signedIn ? ago(device.lastSeenAt, now) : signedOutText(device, now)),
                  h("td", { class: "act" }, device.signedIn ? h("button", { type: "button", class: "btn btn--ghost btn--sm", text: "移除", onClick: () => removeDevice(device, reload) }) : null),
                ),
              ),
        ),
      ),
    );
  };
  search.addEventListener("input", () => {
    state.q = search.value;
    drawTable();
  });

  const prune = h("button", {
    type: "button",
    class: "btn",
    text: "移除所有 " + data.staleDays + " 天未同步的（" + counts.stale + "）",
    disabled: counts.stale === 0,
    onClick: async () => {
      const ok = await confirm({
        title: "移除 " + counts.stale + " 台设备？",
        message: "超过 " + data.staleDays + " 天没同步、但还登录着的设备都会被登出。它们再联网时需要重新登录，本机文件不受影响。",
        confirmText: "全部移除",
        danger: true,
      });
      if (!ok) return;
      try {
        const result = await post("/v1/admin/devices/prune", { inactiveDays: data.staleDays });
        toast("已移除 " + result.removed + " 台");
        await reload();
      } catch (error) {
        toastError(error);
      }
    },
  });

  drawFilter();
  drawTable();
  mount(
    main,
    pageHead("设备", signedIn.length + " 台登录中 · " + counts.online + " 台在线（5 分钟内同步过）", prune),
    panel(null, null, h("div", { class: "toolbar" }, search, filterSlot), tableSlot),
    h("p", { class: "note", text: "「移除」= 吊销这台设备的登录；它下次联网会看到「需要重新登录」。设备名、平台和版本由客户端登录时上报。" }),
  );
}

/* ============================================================ 服务设置 */

async function pageSettings(main) {
  const [settings, accountsData] = await Promise.all([get("/v1/admin/settings"), get("/v1/admin/accounts")]);
  const draft = {
    registration: settings.registration,
    defaultQuotaBytes: settings.defaultQuotaBytes,
    passwordLogin: settings.passwordLogin,
    githubEnabled: settings.githubEnabled,
    githubClientId: settings.githubClientId,
    githubClientSecret: "",
    githubPolicy: settings.githubPolicy,
    githubOrgs: [...settings.githubOrgs],
  };
  const admins = accountsData.accounts.filter((x) => x.isAdmin);
  const save = h("button", { type: "button", class: "btn btn--primary", text: "保存", disabled: true });
  const error = errorSlot();
  const changed = () => {
    const patchBody = {};
    if (draft.registration !== settings.registration) patchBody.registration = draft.registration;
    if (draft.defaultQuotaBytes !== settings.defaultQuotaBytes) patchBody.defaultQuotaBytes = draft.defaultQuotaBytes;
    for (const key of ["passwordLogin", "githubEnabled", "githubClientId", "githubPolicy"]) if (draft[key] !== settings[key]) patchBody[key] = draft[key];
    if (draft.githubClientSecret.trim() !== "") patchBody.githubClientSecret = draft.githubClientSecret;
    if (draft.githubOrgs.join(",") !== settings.githubOrgs.join(",")) patchBody.githubOrgs = draft.githubOrgs;
    return patchBody;
  };
  const sync = () => (save.disabled = Object.keys(changed()).length === 0);

  const registrationMeta = {
    invite: "只有拿到邀请链接的人能建账号。",
    open: "任何知道服务器地址的人都能在客户端里注册。",
    closed: "已有账号照常使用；不能新增，连邀请链接也暂停。",
  };
  const regSlot = h("div");
  const regMeta = h("div", { class: "setting__meta" });
  const drawReg = () => {
    mount(
      regSlot,
      segmented(Object.entries(REGISTRATION_LABEL), draft.registration, (value) => {
        draft.registration = value;
        drawReg();
        sync();
      }),
    );
    regMeta.textContent = registrationMeta[draft.registration];
  };
  drawReg();

  const quota = h("input", { class: "field field--num", type: "number", min: "0", step: "0.5", value: String(toGb(settings.defaultQuotaBytes)), attrs: { "aria-label": "默认配额（GB）" } });
  quota.addEventListener("input", () => {
    const value = Number(quota.value);
    draft.defaultQuotaBytes = Number.isFinite(value) && value >= 0 ? Math.round(value * GB) : settings.defaultQuotaBytes;
    sync();
  });

  const passwordSwitch = h("input", { type: "checkbox", checked: draft.passwordLogin });
  passwordSwitch.addEventListener("change", () => {
    draft.passwordLogin = passwordSwitch.checked;
    sync();
  });
  const githubSwitch = h("input", { type: "checkbox", checked: draft.githubEnabled });
  githubSwitch.addEventListener("change", () => {
    draft.githubEnabled = githubSwitch.checked;
    sync();
  });
  const clientId = h("input", { class: "field mono", value: draft.githubClientId, attrs: { autocomplete: "off", spellcheck: "false" } });
  clientId.addEventListener("input", () => {
    draft.githubClientId = clientId.value.trim();
    sync();
  });
  const clientSecret = h("input", { class: "field", type: "password", placeholder: settings.githubClientSecretSet ? "••••••••（不修改）" : "", attrs: { autocomplete: "new-password" } });
  clientSecret.addEventListener("input", () => {
    draft.githubClientSecret = clientSecret.value;
    sync();
  });
  const callback = ctx.session.externalBaseUrl + "/auth/github/callback";
  const policySlot = h("div");
  const orgSlot = h("div");
  const drawPolicy = () => {
    mount(
      policySlot,
      segmented([["invited", "只有已邀请 / 已绑定的"], ["org", "指定组织的成员自动加入"]], draft.githubPolicy, (value) => {
        draft.githubPolicy = value;
        drawPolicy();
        sync();
      }),
    );
    const orgInput = h("input", { class: "field", placeholder: "组织名，回车添加", attrs: { spellcheck: "false" } });
    orgInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const org = orgInput.value.trim().toLowerCase();
      if (!/^[a-z0-9-]{1,39}$/.test(org)) return toast("组织名只能有字母、数字和连字符", "error");
      if (!draft.githubOrgs.includes(org)) draft.githubOrgs.push(org);
      drawPolicy();
      sync();
    });
    mount(
      orgSlot,
      draft.githubPolicy === "org"
        ? h(
            "div",
            { class: "tags-input" },
            draft.githubOrgs.map((org) =>
              h("span", { class: "tag" }, org, " ", h("button", { type: "button", class: "link", attrs: { "aria-label": "移除 " + org }, text: "×", onClick: () => { draft.githubOrgs = draft.githubOrgs.filter((item) => item !== org); drawPolicy(); sync(); } })),
            ),
            orgInput,
          )
        : null,
    );
  };
  drawPolicy();

  save.addEventListener("click", () =>
    busy(save, async () => {
      error.set(null);
      try {
        await patch("/v1/admin/settings", changed());
        toast("已保存，立即生效");
        await pageSettings(main);
      } catch (failure) {
        error.set(failure.message);
      }
    }),
  );

  const setting = (label, sub, ...control) => h("div", { class: "setting" }, h("div", { class: "setting__label" }, label, sub ? h("small", { text: sub }) : null), h("div", { class: "setting__control" }, control));
  mount(
    main,
    pageHead("服务设置", "改动立即生效，不需要重启容器", save),
    error.node,
    panel(
      "基本",
      null,
      h(
        "div",
        { class: "panel__body" },
        setting("对外地址", null, h("span", { class: "mono break", text: ctx.session.externalBaseUrl }), h("div", { class: "setting__meta", text: "客户端和邀请链接都用这个地址。它来自环境变量 EXTERNAL_BASE_URL，改它要改部署配置并重启。" })),
        setting("谁可以注册", null, regSlot, regMeta),
      ),
    ),
    panel(
      "登录方式",
      null,
      h(
        "div",
        { class: "panel__body" },
        setting(
          "邮箱和密码",
          null,
          h("label", { class: "switch" }, passwordSwitch, "允许"),
          h("div", { class: "setting__meta", text: "关掉后只能用 GitHub 登录（要先把 GitHub 配好）；已有的密码保留，重新打开即可恢复。" }),
        ),
        setting(
          "GitHub",
          "OAuth App",
          h("label", { class: "switch" }, githubSwitch, "允许用 GitHub 登录"),
          h("label", { class: "lab" }, "Client ID", clientId),
          h("label", { class: "lab" }, "Client Secret", clientSecret, h("span", { class: "hint", text: settings.githubClientSecretSet ? "已设置。只写不读；留空表示不修改。" : "还没设置。" })),
          h("div", { class: "lab" }, "回调地址（填到 GitHub 的 OAuth App 里）", h("div", { class: "row" }, h("span", { class: "mono grow break", text: callback }), h("button", { type: "button", class: "btn btn--sm", onClick: () => copy(callback) }, icon("copy", 13), "复制"))),
          h(
            "div",
            { class: "row" },
            h("a", { class: "link", href: "https://github.com/settings/applications/new", target: "_blank", rel: "noopener noreferrer", text: "在 GitHub 新建 OAuth App →" }),
            h("span", { class: "grow" }),
            settings.githubAvailable ? h("a", { class: "btn btn--sm", href: "/auth/github?mode=panel", text: "测试登录" }) : h("span", { class: "hint", text: "保存并配好之后可以测试登录" }),
          ),
        ),
        setting(
          "谁能用 GitHub 登录",
          null,
          policySlot,
          orgSlot,
          h("div", { class: "setting__meta", text: "第一项：GitHub 账号要先通过邀请链接加入，或由用户在客户端里绑定。第二项：组织成员第一次登录就自动建账号（仍受「谁可以注册」限制）。" }),
        ),
      ),
    ),
    panel(
      "新用户默认值",
      null,
      h(
        "div",
        { class: "panel__body" },
        setting("空间配额", "账号没单独设置时用它", h("div", { class: "row" }, quota, h("span", { class: "setting__meta", text: "GB / 人 · 改了之后，没单独设置过的账号一起跟着变" }))),
        setting("单个文件上限", null, h("span", { class: "setting__meta", text: bytes(ctx.session.maxFileBytes) + " · 来自环境变量 MAX_FILE_BYTES" })),
      ),
    ),
    panel(
      "管理员",
      null,
      h(
        "div",
        { class: "panel__body" },
        setting(
          "管理员账号",
          null,
          h("div", { class: "row" }, admins.map((x) => a("/admin/users/" + x.accountId, x.email || accountName(x), "tag"))),
          h("div", { class: "setting__meta" }, "要增加管理员：在", a("/admin/users", "用户"), "里打开对方，点「设为管理员」；或者发邀请时把身份选成「管理员」。"),
        ),
      ),
    ),
  );
}
