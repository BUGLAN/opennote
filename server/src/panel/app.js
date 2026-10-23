/*
 * 控制台外壳：主题、路由、取数、抽屉、对话框、搜索（`docs/执行-三端同步…` §4.6）。
 *
 * ## 这个文件负责什么，不负责什么
 *
 * | 层 | 文件 | 职责 |
 * | --- | --- | --- |
 * | 取数 | `api.js` | 凭据派生、会话、请求、错误码 |
 * | 视图 | `views.js` | 纯函数：数据 → HTML |
 * | 外壳 | 本文件 | 状态、路由、事件、主题、抽屉 |
 *
 * 分开的理由很实际：视图是纯函数就能随手加一页而不碰会话逻辑；
 * 取数层单独一个文件，改密码学注释时不会撞上界面代码。
 *
 * ## §10.1 M8 的两条闸门在这里怎么落地
 *
 * - **页面不渲染**：`NAV` 里管理页的条目只在 `session.isAdmin` 时**被生成**。
 *   普通账号的 DOM 里没有这些链接，也没有它们对应的 section。
 * - **API 403**：服务端每个 `/panel/api/admin/*` 自己拦。前端守卫只是少发一次
 *   注定失败的请求，**不是**安全边界。
 */

import * as api from "./api.js";

const { esc, fmtDateTime, fmtRelative } = window.VIEWS;
const V = window.VIEWS;
const ICON = window.ICON;

/* ============================================================================
   偏好（主题）
   ============================================================================ */

/**
 * 与产品**共用同一个 localStorage 键与同一套属性**（§4.6：控制台不是产品的一部分，
 * 但它必须看起来像同一个产品）。所以这里读的写的就是 `opennote.ui.v1`。
 */
const PREFS_KEY = "opennote.ui.v1";

const THEMES = ["paper", "celadon", "sepia", "night", "ink"];
const ACCENTS = ["seal", "indigo", "pine", "gamboge"];

const DEFAULT_PREFS = {
  theme: "paper",
  accent: "seal",
  appearance: "light",
  lightTheme: "paper",
  darkTheme: "night",
};

/**
 * 角色 → 页面清单。
 *
 * ★ `adminOnly` 的条目在普通账号下**根本不进入这个数组**，所以导航里不会有、
 *   路由表里也没有。这正是 §10.1 M8 说的「不渲染」。
 */
const NAV = [
  {
    group: "服务",
    items: [
      { id: "overview", label: "运行状态", icon: "activity", adminOnly: true },
      { id: "data", label: "同步台账", icon: "layers", adminOnly: true },
    ],
  },
  {
    group: "人员与设备",
    items: [
      { id: "accounts", label: "账号与访问", icon: "users", adminOnly: true },
      { id: "devices", label: "设备", icon: "devices", adminOnly: true },
      { id: "my-account", label: "我的账号", icon: "user", adminOnly: false },
      { id: "my-devices", label: "我的设备", icon: "devices", adminOnly: false },
    ],
  },
  {
    group: "运维",
    items: [
      { id: "issues", label: "冲突与异常", icon: "alert", adminOnly: true },
      { id: "logs", label: "同步日志", icon: "scroll", adminOnly: true },
      { id: "server", label: "服务端配置", icon: "settings", adminOnly: true },
    ],
  },
  {
    group: "参考",
    items: [{ id: "identity", label: "身份与授权", icon: "shield", adminOnly: false }],
  },
];

const state = {
  session: null,
  route: "overview",
  prefs: { ...DEFAULT_PREFS },
  filters: {},
  loading: false,
  drawerOpen: false,
};

/* ============================================================================
   小工具
   ============================================================================ */

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function show(node, visible) {
  if (node) node.hidden = !visible;
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
  } catch {
    /* 隐私模式下 localStorage 会抛 —— 主题记不住不该让页面崩。 */
  }
}

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    if (THEMES.includes(parsed.theme)) state.prefs.theme = parsed.theme;
    if (ACCENTS.includes(parsed.accent)) state.prefs.accent = parsed.accent;
    if (parsed.appearance === "dark" || parsed.appearance === "light") state.prefs.appearance = parsed.appearance;
    if (THEMES.includes(parsed.lightTheme)) state.prefs.lightTheme = parsed.lightTheme;
    if (THEMES.includes(parsed.darkTheme)) state.prefs.darkTheme = parsed.darkTheme;
  } catch {
    /* 坏 JSON 就当没存过。 */
  }
}

/** 应用主题：三个 data 属性 + 印章图。 */
function applyTheme() {
  const root = document.documentElement;
  const effective = state.prefs.appearance === "dark" ? state.prefs.darkTheme : state.prefs.lightTheme;
  root.setAttribute("data-theme", effective);
  root.setAttribute("data-accent", state.prefs.accent);
  root.setAttribute("data-appearance", state.prefs.appearance);

  const kind = state.prefs.appearance === "dark" ? "dark" : "light";
  const src = "/panel/assets/seal/" + state.prefs.accent + "-" + kind + ".png";
  for (const img of [$("#brand-seal"), $("#unlock-seal")]) {
    if (img) img.setAttribute("src", src);
  }
  const toggle = $("#appearance-btn");
  if (toggle) toggle.innerHTML = ICON(state.prefs.appearance === "dark" ? "sun" : "moon", 15);
}

function toggleAppearance() {
  state.prefs.appearance = state.prefs.appearance === "dark" ? "light" : "dark";
  savePrefs();
  applyTheme();
}

/* ============================================================================
   路由
   ============================================================================ */

function routeFromHash() {
  const raw = (location.hash || "").replace(/^#\/?/, "");
  return raw || "overview";
}

function allPages() {
  return NAV.flatMap((group) => group.items);
}

function pageMeta(id) {
  return allPages().find((page) => page.id === id) || null;
}

/** 当前会话能不能看这一页。普通账号连元数据都拿不到管理页。 */
function canView(id) {
  const page = pageMeta(id);
  if (!page) return false;
  return !page.adminOnly || Boolean(state.session && state.session.isAdmin);
}

function renderNav() {
  const nav = $("#nav");
  if (!nav) return;
  const current = state.route;
  nav.innerHTML = NAV.map((group) => {
    /* ★ 越权条目**根本不进 DOM**：不是渲染出来后用 CSS 隐藏。 */
    const items = group.items.filter((page) => canView(page.id));
    if (items.length === 0) return "";
    return (
      '<div class="nav__section">' + esc(group.group) + "</div>" +
      items
        .map(
          (page) =>
            '<a class="nav__item' + (page.id === current ? " is-active" : "") + '" href="#/' + page.id + '"' +
            (page.id === current ? ' aria-current="page"' : "") + ">" +
            '<span class="nav__icon">' + ICON(page.icon, 15) + "</span>" +
            '<span class="nav__text">' + esc(page.label) + "</span>" +
            "</a>",
        )
        .join("")
    );
  }).join("");
}

/* ============================================================================
   渲染
   ============================================================================ */

let lastRoute = null;

function setMain(html) {
  const main = $("#main");
  const scroll = main.scrollTop;
  main.innerHTML = html;
  if (lastRoute !== state.route) main.scrollTop = 0;
  else main.scrollTop = scroll;
  lastRoute = state.route;
  renderNav();
}

function renderLoading() {
  setMain(
    '<div class="page">' +
      V.pageHead({ eyebrow: "加载中", title: "正在读取…", lede: "这一页的数据还没有回来。" }) +
      V.skeletonCards(4) +
      V.skeletonTable(5) +
      "</div>",
  );
}

function renderError(pageId, error) {
  setMain(
    '<div class="page">' +
      V.pageHead({ eyebrow: "请求失败", title: pageMeta(pageId)?.label || "这一页", lede: "服务端没有返回这一页的数据。" }) +
      V.errorPanel({
        status: error.status ? "HTTP " + error.status : "网络错误",
        title: error.message || "请求失败",
        detail: "GET /panel/api/" + (pageId === "overview" ? "admin/overview" : pageId) + "\n" + (error.code || "unknown"),
      }) +
      "</div>",
  );
}

/**
 * 取数并渲染当前页。
 *
 * ★ 管理页的数据一律来自 `/panel/api/admin/*`。前端**不缓存**上一份成功的响应：
 *   错误态里显示旧数字比显示「读不到」危险得多（运维会照着旧数字做决定）。
 */
async function render() {
  const id = state.route;
  const page = pageMeta(id);

  /* 路由守卫：手敲 URL 或点旧书签时会走到这里。 */
  if (!page || !canView(id)) {
    setMain(
      '<div class="page">' +
        V.pageHead({
          eyebrow: "受限页面",
          title: page ? page.label : "这个页面不存在",
          lede: page
            ? "这个区块只对管理员开放。下面是<strong>普通账号</strong>会看到的版本 —— 没有任何账号数据被渲染。"
            : "路由里没有这一页。",
        }) +
        V.emptyState({
          title: page ? "这一页需要管理员身份" : "这个页面不存在",
          lede: page
            ? "你的账号可以正常同步、也能在客户端里管理自己的笔记本，但「" + esc(page.label) + "」只对管理员开放。"
            : "地址可能拼错了，或者这个页面已经被删掉。",
          actions: page
            ? '<button class="btn" type="button" data-go="identity">看看身份是怎么验证的</button>'
            : '<button class="btn btn--primary" type="button" data-go="overview">回到运行状态</button>',
        }) +
        "</div>",
    );
    return;
  }

  if (state.loading) return;
  state.loading = true;
  renderLoading();
  try {
    const now = Date.now();
    const filters = state.filters[id] || {};

    if (id === "overview") {
      setMain(V.renderOverview(await api.getOverview(), now));
    } else if (id === "data") {
      const data = await api.getNotebooks();
      /*
       * ★ 列表一取回来就**填进缓存**：抽屉里的动作（`data-open-notebook` 之后的
       *   `data-check-notebook`）要靠它把 id 变回行数据。不填的话第一次点开抽屉
       *   会再打一次接口，而「重新核对置备」按钮在抽屉里时会因为缓存空而**完全没有反应**
       *   （`withAccount` 找不到行就静默 return —— 这类静默是最难查的）。
       */
      cache.notebooks = data.notebooks;
      setMain(V.renderData(data, filters));
    } else if (id === "accounts") {
      const [accounts, invites] = await Promise.all([api.getAdminAccounts(), api.getInvites()]);
      cache.accounts = accounts.accounts;
      setMain(V.renderAccounts({ ...accounts, invites: invites.invites, selfId: state.session.accountId }, filters, now));
    } else if (id === "devices") {
      setMain(V.renderDevices(await api.getDevices(), filters, now));
    } else if (id === "issues") {
      /* 热点与流量都在 overview 里，不用再单独打 /stats（那是「我的」视角）。 */
      const overview = await api.getOverview();
      setMain(V.renderIssues(overview, now));
    } else if (id === "logs") {
      const audit = await api.getAudit(200);
      setMain(V.renderLogs(audit.events, filters, now));
    } else if (id === "server") {
      const [config, overview] = await Promise.all([api.getConfig(), api.getOverview()]);
      setMain(V.renderServer(config, overview.health));
    } else if (id === "identity") {
      setMain(V.renderIdentity(state.session));
    } else if (id === "my-account") {
      setMain(await renderMyAccount());
    } else if (id === "my-devices") {
      setMain(await renderMyDevices(now));
    }
  } catch (error) {
    if (error && error.code === "unauthorized") {
      await signOutLocal();
      return;
    }
    renderError(id, error);
  } finally {
    state.loading = false;
  }
  bindBulkActions();
}

function bindBulkActions() {
  /* 事件统一走 document 委托（CSP 下不能写 onclick，动态内容也省得反复绑定）。 */
}


/* ============================================================================
   个人页（普通账号也看得到）
   ============================================================================ */

async function renderMyAccount() {
  const data = await api.getAccount();
  const rows = [
    ["账号 ID", '<span class="mono">' + esc(data.accountId) + "</span>"],
    ["标签", esc(data.label || "—")],
    ["管理员", data.isAdmin ? "是" : "否"],
    ["状态", data.status === "active" ? V.chip("正常", "ok") : V.chip("已禁用", "quiet")],
    ["创建于", esc(V.fmtDateTime(data.createdAt))],
    ["最近活动", esc(V.fmtRelative(data.lastSeenAt, Date.now()))],
    ["笔记本", data.quota.notebooks + " / " + data.quota.notebooksLimit],
  ];
  return (
    '<div class="page">' +
    V.pageHead({ eyebrow: "我的账号", title: "我的账号", lede: "这台账号的密钥就是你的一切。服务端没有你的密钥副本。" }) +
    '<div class="card"><div class="card__body card__body--flush"><dl class="service-row service-row--wide">' +
    rows.map(([k, v]) => "<div><dt>" + esc(k) + "</dt><dd>" + v + "</dd></div>").join("") +
    "</dl></div></div>" +
    '<div class="card"><div class="card__head"><span class="card__title">三条能力边界</span></div><div class="card__body">' +
    '<div class="drawer__list drawer__list--flush">' +
    (data.capabilityNotes || []).map((note) => '<div class="drawer__check"><span class="drawer__check-icon is-missing">' + ICON("alert", 10) + '</span><span class="drawer__check-text">' + esc(note) + "</span></div>").join("") +
    "</div></div></div>" +
    "</div>"
  );
}

async function renderMyDevices(now) {
  const data = await api.getMyDevices();
  const rows = data.devices
    .map(
      (d) =>
        "<tr>" +
        '<td class="u-min-w-0"><div class="cell-main">' + esc(d.name || "未命名设备") + "</div>" +
        '<div class="cell-sub mono">' + esc(V.shortId(d.deviceId)) + "</div></td>" +
        "<td>" + V.chip(V.platformLabel(d.platform), "quiet") + "</td>" +
        '<td class="u-nowrap">' + esc(V.fmtRelative(d.lastSeenAt, now)) + "</td>" +
        "</tr>",
    )
    .join("");
  return (
    '<div class="page">' +
    V.pageHead({ eyebrow: "我的设备", title: "我的设备", lede: "只读账本 —— 一个密钥所有设备共用，所以没有「踢掉这一台」。" }) +
    '<div class="banner">' + ICON("info", 14) + "<span>" + esc(data.note) + "</span></div>" +
    (data.devices.length === 0
      ? V.emptyState({ title: "还没有登记过设备", lede: "客户端同步时会顺带登记（检查点请求里带着 deviceId）。做一次同步再回来看。" })
      : '<div class="card card--flush"><table class="table"><thead><tr><th>设备</th><th>平台</th><th>最近活动</th></tr></thead><tbody>' + rows + "</tbody></table></div>") +
    "</div>"
  );
}

/* ============================================================================
   主题面板 / 账户菜单
   ============================================================================ */

function renderAccountMenu() {
  const menu = $("#account-menu");
  if (!menu || !state.session) return;
  menu.innerHTML =
    '<div class="menu__head"><div class="menu__name">' + esc(state.session.label || V.shortId(state.session.accountId)) + "</div>" +
    '<div class="menu__meta mono">' + esc(V.shortId(state.session.accountId)) + "</div></div>" +
    '<button class="menu__item" type="button" data-go="my-account">' + ICON("user", 14) + "我的账号</button>" +
    '<button class="menu__item" type="button" data-go="identity">' + ICON("shield", 14) + "身份与授权</button>" +
    '<div class="menu__sep"></div>' +
    '<button class="menu__item" type="button" data-logout>' + ICON("ban", 14) + "退出控制台</button>";
}

function renderSessionChip() {
  const btn = $("#account-btn");
  if (!btn || !state.session) return;
  const initial = (state.session.label || "?").slice(0, 1);
  btn.innerHTML =
    '<span class="avatar" aria-hidden="true">' + esc(initial) + "</span>" +
    '<span class="account-btn__label">' + esc(state.session.label || V.shortId(state.session.accountId)) + "</span>" +
    (state.session.isAdmin
      ? '<span class="role-flag role-flag--admin" title="管理员：is_admin = 1">管理员</span>'
      : '<span class="role-flag" title="普通账号：is_admin = 0">普通</span>') +
    '<span id="account-caret">' + ICON("chevronDown", 12) + "</span>";
}

/* ============================================================================
   二次验证（step-up）
   ============================================================================ */

let dialogResolve = null;

function openDialog(spec) {
  const dialog = $("#dialog");
  dialog.innerHTML =
    '<div class="dialog__head"><div class="dialog__head-main">' +
    (spec.eyebrow ? '<div class="drawer__eyebrow">' + ICON(spec.icon || "info", 12) + esc(spec.eyebrow) + "</div>" : "") +
    '<h2 class="dialog__title" id="dialog-title">' + esc(spec.title) + "</h2></div>" +
    '<button class="icon-btn" type="button" data-dialog-close aria-label="关闭">' + ICON("x", 15) + "</button></div>" +
    '<div class="dialog__body">' + spec.body + "</div>" +
    '<div class="dialog__foot">' + spec.foot + "</div>";
  dialog.showModal();
}

/**
 * 关闭对话框并告诉等待方「怎么关的」。
 *
 * ★ 顺序不能反：必须先取走并 resolve，再 `dialog.close()`。
 *   因为 `close` 会**同步**触发原生 close 事件，而那个监听器会把 dialogResolve
 *   当成「用户按了 Esc」解析成 false —— 先 close 再 resolve 的话，
 *   「取消」会永远压过「确认」，二次验证永远过不去。
 */
function closeDialog(result) {
  const dialog = $("#dialog");
  const resolve = dialogResolve;
  dialogResolve = null;
  if (dialog.open) dialog.close();
  if (resolve) resolve(result);
}

/**
 * 危险操作前的二次验证。**真调服务端**（`POST /panel/api/session/verify`）。
 *
 * ## 为什么让人重新粘一次密钥
 *
 * 会话 cookie 的有效期内，任何能碰到这台浏览器的人都能执行危险动作 ——
 * 「后果三行」是提醒，不是验证。重新提供密钥是唯一能证明「是你本人」的动作。
 *
 * ## 为什么不在内存里静默重算
 *
 * 那等于没有验证：内存里的东西攻击者一样能拿到。必须让人**重新提供**一次
 * （从密码管理器里，而不是从我们自己的变量里）。
 */
function requestStepUp(spec) {
  return new Promise((resolve) => {
    dialogResolve = resolve;
    openDialog({
      eyebrow: "二次验证 · " + (spec.purpose || "危险操作"),
      icon: "key",
      title: "这一步需要重新验证",
      body:
        '<p class="dialog__message">你的控制台会话还有效，但<strong>' + esc(spec.purpose || "这个操作") +
        "</strong>不能只靠一个可能没锁屏的浏览器。请重新粘贴一次账号密钥 —— 它只在本机派生成令牌，服务端不会收到密钥本身。</p>" +
        '<div class="dialog__field"><label for="step-up-key">账号密钥</label>' +
        '<textarea class="field" id="step-up-key" rows="3" spellcheck="false" autocomplete="off" placeholder="opennote-key-v1.…" data-autofocus></textarea>' +
        '<span class="note">密钥不会离开这个页面。验证通过后 5 分钟内有效，只对这一次操作生效。</span></div>' +
        '<p class="dialog__error" id="step-up-error" hidden></p>' +
        '<div class="dialog__rows">' +
        '<div class="dialog__row"><dt>为什么</dt><dd>会话有效期内，任何能碰到这台浏览器的人都能执行危险动作</dd></div>' +
        '<div class="dialog__row"><dt>验证后</dt><dd>签发 5 分钟有效的 step-up 标记，只对这一次操作有效</dd></div>' +
        '<div class="dialog__row"><dt>不通过</dt><dd>API 返回 403 <code>step-up-required</code>，什么都不改</dd></div>' +
        "</div>",
      foot:
        '<span class="spacer"></span>' +
        '<button class="btn" type="button" data-dialog-close>取消</button>' +
        '<button class="btn btn--primary btn--danger" type="button" data-step-up-confirm>验证并' + esc(spec.actionLabel || "继续") + "</button>",
    });
  });
}

/**
 * 执行一个危险动作：先二次验证，再调用。
 *
 * 验证失败**不重试**动作，也不提示「再试一次」—— 失败意味着「不知道是不是你」，
 * 此时正确的行为是什么都不做。
 */
async function withStepUp(spec, action) {
  const verified = await requestStepUp(spec);
  if (!verified) return { ok: false, reason: "cancelled" };
  try {
    const result = await action();
    return { ok: true, result };
  } catch (error) {
    if (error && error.code === "step-up-required") {
      toast("服务端没有认可这次验证：可能已超过 5 分钟。请重新验证。", "danger");
      return { ok: false, reason: "expired" };
    }
    toast(error.message || "操作失败", "danger");
    return { ok: false, reason: "error", error };
  }
}


/* ============================================================================
   抽屉
   ============================================================================ */

function openDrawer(html) {
  const drawer = $("#drawer");
  const scrim = $("#scrim");
  const content = $("#drawer-content");
  content.innerHTML = html;
  drawer.classList.add("is-open");
  drawer.setAttribute("aria-hidden", "false");
  scrim.hidden = false;
  state.drawerOpen = true;
  document.body.style.overflow = "hidden";
  /* 焦点移进抽屉，但**不落在关闭按钮上**（程序化聚焦会画出焦点环）。 */
  drawer.focus({ preventScroll: true });
}

function closeDrawer() {
  const drawer = $("#drawer");
  const scrim = $("#scrim");
  drawer.classList.remove("is-open");
  drawer.setAttribute("aria-hidden", "true");
  scrim.hidden = true;
  state.drawerOpen = false;
  document.body.style.overflow = "";
  const content = $("#drawer-content");
  window.setTimeout(() => {
    if (!drawer.classList.contains("is-open")) content.innerHTML = "";
  }, 260);
}

function drawerShell(spec) {
  return (
    '<div class="drawer__head"><div class="drawer__head-main">' +
    '<div class="drawer__eyebrow">' + ICON(spec.icon || "info", 12) + esc(spec.eyebrow || "") + "</div>" +
    '<h2 class="drawer__title">' + esc(spec.title) + "</h2>" +
    (spec.sub ? '<div class="drawer__sub mono">' + esc(spec.sub) + "</div>" : "") +
    "</div>" +
    '<button class="icon-btn" type="button" data-close-drawer aria-label="关闭详情">' + ICON("x", 15) + "</button></div>" +
    '<div class="drawer__body">' + spec.body + "</div>" +
    (spec.foot ? '<div class="drawer__foot">' + spec.foot + "</div>" : "")
  );
}

function openAccountDrawer(account) {
  const isSelf = state.session && account.accountId === state.session.accountId;
  const rows = [
    ["accountId", '<span class="mono">' + esc(account.accountId) + "</span>"],
    ["状态", account.status === "active" ? V.chip("正常", "ok") : V.chip("已禁用", "quiet")],
    ["角色", account.isAdmin ? "管理员（is_admin = 1）" : "普通（is_admin = 0）"],
    ["创建于", esc(V.fmtDateTime(account.createdAt))],
    ["最近活动", esc(V.fmtRelative(account.lastSeenAt, Date.now()))],
    ["配额", V.fmtBytes(account.quota.bytesUsed) + " / " + V.fmtBytes(account.quota.bytesLimit)],
    ["笔记本", account.quota.notebooks + " / " + account.quota.notebooksLimit],
  ];

  const foot = isSelf
    ? '<span class="note">这是你自己的账号。删除或禁用自己会让你失去管理入口。</span>'
    : (account.status === "active"
        ? '<button class="btn" type="button" data-toggle-account="' + esc(account.accountId) + '">禁用账号</button>'
        : '<button class="btn" type="button" data-toggle-account="' + esc(account.accountId) + '">启用账号</button>') +
      '<button class="btn btn--danger" type="button" data-delete-account="' + esc(account.accountId) + '">删除账号</button>';

  openDrawer(
    drawerShell({
      icon: "user",
      eyebrow: "账号 · " + (account.isAdmin ? "管理员" : "普通账号"),
      title: account.label || V.shortId(account.accountId),
      sub: V.shortId(account.accountId),
      body:
        '<dl class="service-row">' +
        rows.map(([k, v]) => "<div><dt>" + esc(k) + "</dt><dd>" + v + "</dd></div>").join("") +
        "</dl>" +
        '<div class="banner u-mt-12">' + ICON("alert", 14) +
        "<span>服务端无法补发这个人的密钥。要让他失去访问权，只有<strong>禁用</strong>或<strong>删除</strong>；" +
        "要换密钥，只能他自己在已登录的设备上轮换。</span></div>",
      foot,
    }),
  );
}

function openNotebookDrawer(nb) {
  const p = nb.provisioning;
  const checks = [
    { ok: p ? p.designOk : null, label: "_design/opennote 就位", hint: p && !p.designOk ? "被手工删过，不会自动重建" : "" },
    { ok: p ? p.syncInfoOk : null, label: "syncinfo 存在", hint: "" },
    { ok: p && p.revsLimit === "1000", label: "revs_limit = 1000", hint: p ? "当前 " + (p.revsLimit || "—") : "" },
  ];

  openDrawer(
    drawerShell({
      icon: "layers",
      eyebrow: "笔记本 · " + (nb.cryptoMode === "user-key" ? "端到端加密" : "明文"),
      title: nb.name,
      sub: V.shortId(nb.id),
      body:
        '<dl class="service-row">' +
        "<div><dt>所有者</dt><dd>" + esc(nb.ownerLabel || V.shortId(nb.ownerId)) + "</dd></div>" +
        "<div><dt>成员</dt><dd>" + nb.memberCount + " 位</dd></div>" +
        "<div><dt>加密</dt><dd>" + (nb.cryptoMode === "user-key" ? "端到端（服务端只见密文）" : "明文") + "</dd></div>" +
        "<div><dt>占用</dt><dd>" + V.fmtBytes(nb.bytesUsed) + "</dd></div>" +
        "<div><dt>创建于</dt><dd>" + esc(V.fmtDateTime(nb.createdAt)) + "</dd></div>" +
        "</dl>" +
        '<div class="drawer__section-title">置备核对</div>' +
        '<div class="drawer__list drawer__list--flush">' +
        checks
          .map(
            (c) =>
              '<div class="drawer__check"><span class="drawer__check-icon' + (c.ok ? "" : " is-missing") + '">' +
              ICON(c.ok ? "check" : "alert", 10) + "</span>" +
              '<span class="drawer__check-text">' + esc(c.label) + (c.hint ? '<br><span class="tiny muted">' + esc(c.hint) + "</span>" : "") + "</span>" +
              '<span class="drawer__check-state">' + (c.ok === null ? "未核对" : c.ok ? "通过" : "不一致") + "</span></div>",
          )
          .join("") +
        "</div>" +
        '<p class="note">核对是<strong>只读</strong>的：它会查 CouchDB 并记录结果，但绝不自动重建 —— ' +
        "「_design 是怎么没的」比「把它加回来」更值得先回答。</p>",
      foot: '<button class="btn" type="button" data-check-notebook="' + esc(nb.id) + '">' + ICON("shield", 13) + "重新核对置备</button>",
    }),
  );
}

function openLogDrawer(event) {
  const [label, category] = V.actionLabel(event.action);
  openDrawer(
    drawerShell({
      icon: "scroll",
      eyebrow: "同步日志 · " + category,
      title: label,
      sub: V.fmtDateTime(event.at),
      body:
        '<dl class="service-row">' +
        '<div><dt>动作</dt><dd class="mono">' + esc(event.action) + "</dd></div>" +
        "<div><dt>时间</dt><dd>" + esc(V.fmtDateTime(event.at)) + " · " + esc(V.fmtRelative(event.at, Date.now())) + "</dd></div>" +
        '<div><dt>操作者</dt><dd class="mono">' + esc(event.actorId || "系统 / CLI") + "</dd></div>" +
        '<div><dt>对象</dt><dd class="mono">' + esc(event.target || "—") + "</dd></div>" +
        "<div><dt>来源 IP</dt><dd>" + esc(event.ip || "未记录") + "</dd></div>" +
        "</dl>" +
        '<div class="drawer__section-title">原始记录</div>' +
        '<pre class="code-block">' + esc(JSON.stringify(event, null, 2)) + "</pre>" +
        '<p class="note">审计表**永不包含**正文或密钥材料。它只用于回答「谁在什么时候做了什么」，不承担回放能力。</p>',
    }),
  );
}

/* ============================================================================
   危险动作
   ============================================================================ */

function toast(message, tone) {
  const root = $("#toasts");
  if (!root) return;
  const node = document.createElement("div");
  node.className = "toast" + (tone === "danger" ? " toast--danger" : "");
  node.innerHTML = '<span class="toast__icon">' + ICON(tone === "danger" ? "alert" : "check", 13) + "</span><span>" + esc(message) + "</span>";
  root.appendChild(node);
  window.setTimeout(() => {
    node.classList.add("is-leaving");
    window.setTimeout(() => node.remove(), 200);
  }, 2600);
}

async function deleteAccountFlow(account) {
  const ok = await confirmDialog({
    eyebrow: "不可撤销 · 删除账号",
    icon: "alert",
    title: "删除「" + (account.label || V.shortId(account.accountId)) + "」？",
    message: "账号会被永久删除。它<strong>独占</strong>的笔记本连同 CouchDB 库一起真删；有共享成员的笔记本会<strong>移交</strong>给其他成员。",
    rows: [
      { k: "独占库", v: "数据库被真正删除，无法恢复" },
      { k: "共享库", v: "所有权移交给最早加入的其他成员" },
      { k: "设备", v: "设备账本行一并清理" },
      { k: "密钥", v: "服务端本来就没有密钥副本，无法补发" },
    ],
    confirmLabel: "永久删除账号",
    danger: true,
  });
  if (!ok) return;

  const outcome = await withStepUp({ purpose: "删除账号", actionLabel: "删除" }, () => api.deleteAccount(account.accountId));
  if (outcome.ok) {
    closeDrawer();
    toast("已删除账号", "danger");
    scheduleRefresh();
  }
}

async function toggleAccountFlow(account) {
  const next = account.status === "active" ? "disabled" : "active";
  const ok = await confirmDialog({
    eyebrow: next === "disabled" ? "禁用账号" : "启用账号",
    icon: "alert",
    title: (next === "disabled" ? "禁用" : "启用") + "「" + (account.label || V.shortId(account.accountId)) + "」？",
    message: next === "disabled"
      ? "禁用会立刻让这个人所有的令牌失效：客户端同步失败、控制台 401。数据不会删除。"
      : "启用后这个人可以立刻恢复同步。",
    rows: [
      { k: "影响", v: next === "disabled" ? "该账号所有设备立即无法同步" : "恢复访问" },
      { k: "数据", v: "不删除任何笔记或库" },
      { k: "可撤销", v: "可以，随时再启用" },
    ],
    confirmLabel: next === "disabled" ? "禁用" : "启用",
    danger: next === "disabled",
  });
  if (!ok) return;
  try {
    await api.setAccountStatus(account.accountId, next);
    closeDrawer();
    toast(next === "disabled" ? "已禁用账号" : "已启用账号", next === "disabled" ? "danger" : undefined);
    scheduleRefresh();
  } catch (error) {
    toast(error.message || "操作失败", "danger");
  }
}

function confirmDialog(spec) {
  return new Promise((resolve) => {
    dialogResolve = resolve;
    openDialog({
      eyebrow: spec.eyebrow || "需要确认",
      icon: spec.icon || "alert",
      title: spec.title,
      body:
        '<p class="dialog__message">' + spec.message + "</p>" +
        (spec.rows
          ? '<dl class="dialog__rows">' +
            spec.rows.map((row) => '<div class="dialog__row"><dt>' + esc(row.k) + "</dt><dd>" + row.v + "</dd></div>").join("") +
            "</dl>"
          : "") +
        (spec.note ? '<p class="dialog__note">' + spec.note + "</p>" : ""),
      foot:
        '<span class="spacer"></span>' +
        '<button class="btn" type="button" data-dialog-close>' + esc(spec.cancelLabel || "取消") + "</button>" +
        '<button class="btn ' + (spec.danger ? "btn--primary btn--danger" : "btn--primary") + '" type="button" data-dialog-confirm data-autofocus>' +
        esc(spec.confirmLabel || "确认") + "</button>",
    });
  });
}

/* ============================================================================
   邀请码
   ============================================================================ */

function openInviteDialog() {
  dialogResolve = null;
  openDialog({
    eyebrow: "账号与访问 · 邀请码",
    icon: "plus",
    title: "生成注册邀请码",
    body:
      '<p class="dialog__message">邀请码是注册的唯一入口（没有公开注册）。<strong>明文只出现这一次</strong>，库里只存哈希。</p>' +
      '<div class="dialog__field"><label for="invite-uses">可用次数</label>' +
      '<input class="field" id="invite-uses" type="number" min="1" max="1000" value="1" />' +
      '<span class="note">1–1000，默认 1（一次性）</span></div>' +
      '<div class="dialog__field"><label for="invite-days">有效天数</label>' +
      '<input class="field" id="invite-days" type="number" min="1" max="365" value="7" />' +
      '<span class="note">1–365，默认 7 天</span></div>' +
      '<p class="dialog__error" id="invite-error" hidden></p>',
    foot:
      '<span class="spacer"></span>' +
      '<button class="btn" type="button" data-dialog-close>取消</button>' +
      '<button class="btn btn--primary" type="button" data-generate-invite>生成邀请码</button>',
  });
}

async function generateInvite() {
  const uses = Number($("#invite-uses").value) || 1;
  const days = Number($("#invite-days").value) || 7;
  const errorBox = $("#invite-error");
  try {
    const result = await api.createInvite({ maxUses: uses, days });
    /* 明文只在这里出现一次 —— 关闭对话框就再也拿不回来了。 */
    openDialog({
      eyebrow: "邀请码 · 只显示这一次",
      icon: "key",
      title: "请现在复制",
      body:
        '<p class="dialog__message">关闭这个对话框后，<strong>服务端也拿不回明文</strong>。</p>' +
        '<div class="dialog__field"><label for="invite-code">邀请码</label>' +
        '<textarea class="field field--mono" id="invite-code" rows="2" readonly>' + esc(result.code) + "</textarea></div>" +
        '<p class="dialog__note">可用 ' + result.maxUses + " 次 · 有效期至 " + esc(V.fmtDateTime(result.expiresAt)) + "</p>",
      foot:
        '<button class="btn" type="button" data-copy-invite>复制邀请码</button>' +
        '<span class="spacer"></span>' +
        '<button class="btn btn--primary" type="button" data-dialog-close>我已保存</button>',
    });
    scheduleRefresh();
  } catch (error) {
    if (errorBox) {
      errorBox.hidden = false;
      errorBox.textContent = error.message || "生成失败";
    }
  }
}

function scheduleRefresh() {
  window.setTimeout(() => {
    if (!state.drawerOpen) render();
  }, 200);
}


/* ============================================================================
   搜索（Ctrl/Cmd K）
   ============================================================================ */

const palette = { open: false, index: 0, results: [] };

function paletteSources() {
  const items = [];
  for (const page of allPages()) {
    if (!canView(page.id)) continue;
    items.push({ kind: "页面", label: page.label, action: () => go(page.id) });
  }
  return items;
}

function openPalette() {
  const root = $("#palette");
  if (!root) return;
  palette.open = true;
  palette.index = 0;
  root.hidden = false;
  const input = $("#palette-input");
  input.value = "";
  input.focus();
  renderPaletteResults();
}

function closePalette() {
  const root = $("#palette");
  palette.open = false;
  if (root) root.hidden = true;
}

function renderPaletteResults() {
  const root = $("#palette-list");
  if (!root) return;
  const q = ($("#palette-input").value || "").trim().toLowerCase();
  const base = paletteSources();
  const results = q ? base.filter((item) => item.label.toLowerCase().includes(q)) : base;
  palette.results = results.slice(0, 12);
  const countEl = $("#palette-count");
  if (countEl) countEl.textContent = palette.results.length + " 项";
  root.innerHTML = palette.results.length
    ? palette.results
        .map(
          (item, index) =>
            '<button class="palette__item' + (index === palette.index ? " is-active" : "") + '" type="button" data-palette-index="' + index + '">' +
            '<span class="palette__kind">' + esc(item.kind) + "</span>" +
            '<span class="palette__label">' + esc(item.label) + "</span></button>",
        )
        .join("")
    : '<div class="palette__empty">没有匹配的条目</div>';
}

function runPalette(index) {
  const item = palette.results[index];
  if (!item) return;
  closePalette();
  item.action();
}

/* ============================================================================
   会话
   ============================================================================ */

async function enter() {
  const errorBox = $("#unlock-error");
  show(errorBox, false);
  try {
    const me = await api.signIn($("#key").value);
    state.session = me;
    $("#key").value = "";
    await bootIntoApp();
  } catch (error) {
    if (errorBox) {
      errorBox.hidden = false;
      errorBox.textContent = error.message || String(error);
    }
  }
}

async function signOutLocal() {
  state.session = null;
  show($("#app"), false);
  show($("#unlock"), true);
  $("#main").innerHTML = "";
  $("#nav").innerHTML = "";
}

async function logout() {
  await api.signOut();
  await signOutLocal();
}

function go(id) {
  if (state.route === id) {
    render();
    return;
  }
  location.hash = "#/" + id;
}

async function bootIntoApp() {
  show($("#unlock"), false);
  show($("#app"), true);
  renderSessionChip();
  renderAccountMenu();
  /*
   * 只写**文本那一格**，不要写整个 .env-chip ——
   * 它的第一个子元素是那个绿点（.env-chip__dot），textContent 会把它冲掉，
   * 于是「环境正常」的视觉提示静默消失。
   */
  const envText = $("#env-chip-text");
  if (envText) envText.textContent = location.host;

  if (!canView(state.route)) state.route = state.session.isAdmin ? "overview" : "my-account";
  await render();
}

/* ============================================================================
   事件
   ============================================================================ */

function bindEvents() {
  $("#appearance-btn").addEventListener("click", toggleAppearance);
  $("#account-btn").addEventListener("click", () => {
    const menu = $("#account-menu");
    const open = menu.hidden;
    menu.hidden = !open;
    $("#account-btn").setAttribute("aria-expanded", String(open));
  });
  $("#search-trigger").addEventListener("click", openPalette);
  $("#enter").addEventListener("click", enter);
  $("#keyfile").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    $("#key").value = await file.text();
  });
  $("#palette-input").addEventListener("input", () => {
    palette.index = 0;
    renderPaletteResults();
  });

  $("#scrim").addEventListener("click", closeDrawer);

  /* 对话框：背景点击 = 取消；close 事件 = 用户按了 Esc。 */
  $("#dialog").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeDialog(false);
  });
  $("#dialog").addEventListener("close", () => {
    /*
     * ★ 迟到的 close 事件不能解析新的等待方。
     *
     * 原生 close 是**异步**派发的：上一轮对话框关闭后、「确认删除 → 立刻打开
     * 二次验证」之间，那个 close 会到达并把**新**对话框的 dialogResolve 解析成
     * false。表现是「二次验证明明填对了，却总说未通过」。
     *
     * 判据：迟到时新对话框已经 open —— 此时不该解析。
     */
    if ($("#dialog").open) return;
    if (dialogResolve) {
      const resolve = dialogResolve;
      dialogResolve = null;
      resolve(false);
    }
  });

  /* ---- 全局点击委托（CSP 下没有内联 onclick） ---- */
  document.addEventListener("click", (event) => {
    const target = event.target;

    if (target.closest("[data-dialog-close]")) {
      closeDialog(false);
      return;
    }
    if (target.closest("[data-dialog-confirm]")) {
      closeDialog(true);
      return;
    }
    if (target.closest("[data-fill-demo-key]")) return;

    /* 二次验证的两个按钮。 */
    if (target.closest("[data-step-up-confirm]")) {
      handleStepUpConfirm();
      return;
    }

    if (target.closest("[data-close-drawer]")) {
      closeDrawer();
      return;
    }
    if (target.closest("[data-refresh]")) {
      render();
      return;
    }
    if (target.closest("[data-retry]")) {
      render();
      return;
    }
    if (target.closest("[data-logout]")) {
      logout();
      return;
    }
    if (target.closest("[data-generate-invite]")) {
      generateInvite();
      return;
    }
    if (target.closest("[data-create-invite]")) {
      openInviteDialog();
      return;
    }
    if (target.closest("[data-copy-invite]")) {
      const box = $("#invite-code");
      if (box) {
        box.select();
        navigator.clipboard?.writeText(box.value).then(
          () => toast("已复制"),
          () => toast("复制失败：请手动选中", "danger"),
        );
      }
      return;
    }

    /* 筛选 pill。 */
    const choice = target.closest("[data-filter-choice]");
    if (choice) {
      const [key, value] = choice.getAttribute("data-filter-choice").split(":");
      setFilter(key, value);
      render();
      return;
    }
    if (target.closest("[data-clear-filters]")) {
      state.filters[state.route] = {};
      render();
      return;
    }

    /* 行内跳转。 */
    const goBtn = target.closest("[data-go]");
    if (goBtn) {
      go(goBtn.getAttribute("data-go"));
      return;
    }

    const accountRow = target.closest("[data-open-account]");
    if (accountRow) {
      const id = accountRow.getAttribute("data-open-account");
      openAccountById(id);
      return;
    }
    const nbRow = target.closest("[data-open-notebook]");
    if (nbRow) {
      openNotebookById(nbRow.getAttribute("data-open-notebook"));
      return;
    }
    const logRow = target.closest("[data-open-log]");
    if (logRow) {
      openLogByIndex(Number(logRow.getAttribute("data-open-log")));
      return;
    }
    /*
     * 概览页「最近控制面动作」的每一行：按时间戳找回那条审计事件。
     *
     * ⚠️ 这一段**必须与上面平级**：它原来被写在 `data-open-log` 的 if 块**里面**
     * （`return` 之后的死代码），于是概览页的活动卡点了没反应 —— 而「点了没反应」
     * 在浏览器里既没有报错、也没有 404，是最难查的一类。
     */
    const eventRow = target.closest("[data-open-event]");
    if (eventRow) {
      openEventByAt(Number(eventRow.getAttribute("data-open-event")));
      return;
    }

    /* 抽屉里的危险动作。 */
    const toggleBtn = target.closest("[data-toggle-account]");
    if (toggleBtn) {
      const id = toggleBtn.getAttribute("data-toggle-account");
      withAccount(id, (account) => toggleAccountFlow(account));
      return;
    }
    const deleteBtn = target.closest("[data-delete-account]");
    if (deleteBtn) {
      const id = deleteBtn.getAttribute("data-delete-account");
      withAccount(id, (account) => deleteAccountFlow(account));
      return;
    }
    const checkBtn = target.closest("[data-check-notebook]");
    if (checkBtn) {
      inspectNotebookFlow(checkBtn.getAttribute("data-check-notebook"));
      return;
    }
    const revokeBtn = target.closest("[data-revoke-invite]");
    if (revokeBtn) {
      revokeInviteFlow(revokeBtn.getAttribute("data-revoke-invite"));
      return;
    }
    const paletteItem = target.closest("[data-palette-index]");
    if (paletteItem) {
      runPalette(Number(paletteItem.getAttribute("data-palette-index")));
      return;
    }

    /* 点空白处收起菜单。 */
    if (!target.closest("#account-menu") && !target.closest("#account-btn")) {
      const menu = $("#account-menu");
      if (menu && !menu.hidden) {
        menu.hidden = true;
        $("#account-btn").setAttribute("aria-expanded", "false");
      }
    }
  });

  document.addEventListener("input", (event) => {
    const field = event.target.closest("[data-filter]");
    if (!field) return;
    setFilter(field.getAttribute("data-filter"), field.value);
    const cursor = field.selectionStart;
    render().then(() => {
      const restored = $('[data-filter="' + field.getAttribute("data-filter") + '"]');
      if (restored && restored.focus) {
        restored.focus({ preventScroll: true });
        if (typeof cursor === "number") restored.setSelectionRange?.(cursor, cursor);
      }
    });
  });

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      palette.open ? closePalette() : openPalette();
      return;
    }
    if (event.key === "Escape") {
      if (palette.open) {
        closePalette();
        return;
      }
      if (state.drawerOpen) closeDrawer();
      return;
    }
    if (!palette.open) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      palette.index = Math.min(palette.results.length - 1, palette.index + 1);
      renderPaletteResults();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      palette.index = Math.max(0, palette.index - 1);
      renderPaletteResults();
    } else if (event.key === "Enter") {
      event.preventDefault();
      runPalette(palette.index);
    }
  });

  window.addEventListener("hashchange", () => {
    state.route = routeFromHash();
    state.filters[state.route] = state.filters[state.route] || {};
    render();
  });
}

function setFilter(key, value) {
  if (!state.filters[state.route]) state.filters[state.route] = {};
  state.filters[state.route][key] = value;
}

/* ============================================================================
   几个需要缓存列表才能打开抽屉的动作
   ============================================================================ */

let cache = { accounts: [], notebooks: [], events: [] };

async function openAccountById(id) {
  const found = cache.accounts.find((row) => row.accountId === id);
  if (found) {
    openAccountDrawer(found);
    return;
  }
  const data = await api.getAdminAccounts();
  cache.accounts = data.accounts;
  const account = cache.accounts.find((row) => row.accountId === id);
  if (account) openAccountDrawer(account);
  else toast("这个账号已经不在列表里了，刷新看看", "danger");
}

/**
 * 按 id 执行一个动作 —— **缓存里没有就去取一次**。
 *
 * ★ 这里刻意不做成「缓存没有就静默 return」：那会让抽屉底部的按钮
 *   在某些路径下完全没反应（用户只会以为「按钮坏了」）。宁可多打一次接口。
 */
async function withAccount(id, fn) {
  let account = cache.accounts.find((row) => row.accountId === id);
  if (!account) {
    try {
      const data = await api.getAdminAccounts();
      cache.accounts = data.accounts;
      account = cache.accounts.find((row) => row.accountId === id);
    } catch (error) {
      toast(error.message || "读取账号失败", "danger");
      return;
    }
  }
  if (!account) return toast("这个账号已经不在列表里了，刷新看看", "danger");
  fn(account);
}

async function openNotebookById(id) {
  let nb = cache.notebooks.find((row) => row.id === id);
  if (!nb) {
    try {
      const data = await api.getNotebooks();
      cache.notebooks = data.notebooks;
      nb = cache.notebooks.find((row) => row.id === id);
    } catch (error) {
      toast(error.message || "读取笔记本失败", "danger");
      return;
    }
  }
  if (nb) openNotebookDrawer(nb);
  else toast("这个笔记本已经不在了", "danger");
}

/**
 * 按时间戳打开一条审计事件（概览页的活动卡用）。
 *
 * 概览只拿 6 条，日志页拿 200 条 —— 所以这里重新取一次再按 at 匹配。
 * 不复用概览那份数据：那样点第 7 条之后的记录会静默失效。
 */
async function openEventByAt(at) {
  try {
    const data = await api.getAudit(200);
    const event = data.events.find((row) => Number(row.at) === at);
    if (event) openLogDrawer(event);
    else toast("这条记录已经不在最近 200 条里了", "danger");
  } catch (error) {
    toast(error.message || "读取失败", "danger");
  }
}

async function openLogByIndex(index) {
  const data = await api.getAudit(200);
  const event = data.events[index];
  if (event) openLogDrawer(event);
}

async function inspectNotebookFlow(id) {
  const button = $('[data-check-notebook="' + id + '"]');
  if (button) {
    button.disabled = true;
    button.textContent = "核对中…";
  }
  try {
    const result = await api.inspectNotebook(id);
    const report = result.inspection;
    toast(report.healthy ? "核对通过：置备就位" : "核对完成：发现 " + report.problems.length + " 个问题", report.healthy ? undefined : "danger");
    closeDrawer();
    render();
  } catch (error) {
    toast(error.message || "核对失败", "danger");
    if (button) {
      button.disabled = false;
      button.textContent = "重新核对置备";
    }
  }
}

async function revokeInviteFlow(codeHash) {
  const ok = await confirmDialog({
    eyebrow: "作废邀请码",
    icon: "ban",
    title: "作废这张邀请码？",
    message: "作废之后这个码无法再注册。已经用它注册的账号不受影响。",
    rows: [
      { k: "影响", v: "这个码不能再被使用" },
      { k: "已有账号", v: "不受影响" },
      { k: "可撤销", v: "不可 —— 需要重新生成一个" },
    ],
    confirmLabel: "作废",
    danger: true,
  });
  if (!ok) return;
  try {
    await api.revokeInviteByHash(codeHash);
    toast("已作废这张邀请码");
    scheduleRefresh();
  } catch (error) {
    toast(error.message || "作废失败", "danger");
  }
}

/* ============================================================================
   启动
   ============================================================================ */

async function boot() {
  loadPrefs();
  applyTheme();
  state.route = routeFromHash();
  bindEvents();

  /* 先问「我是谁」：401 表示没登录，那就停在解锁页。 */
  try {
    const me = await api.fetchMe();
    state.session = me;
    await bootIntoApp();
  } catch {
    show($("#unlock"), true);
    show($("#app"), false);
  }
}

/**
 * 二次验证的确认按钮。
 *
 * 真的调服务端（`POST /panel/api/session/verify`）—— 服务端会核两件事：
 * 这个令牌对应**当前会话的账号**，且账号仍然 active。
 */
async function handleStepUpConfirm() {
  const field = $("#step-up-key");
  const errorBox = $("#step-up-error");
  const value = field ? field.value.trim() : "";
  if (!value) {
    if (errorBox) {
      errorBox.hidden = false;
      errorBox.textContent = "请先粘贴账号密钥。";
    }
    return;
  }
  const button = $("[data-step-up-confirm]");
  if (button) {
    button.disabled = true;
    button.textContent = "验证中…";
  }
  try {
    await api.verifyForKey(value);
    closeDialog(true);
  } catch (error) {
    if (errorBox) {
      errorBox.hidden = false;
      errorBox.textContent = error.message || "验证失败";
    }
    if (button) {
      button.disabled = false;
      button.textContent = "重试验证";
    }
  }
}

boot();

