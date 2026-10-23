/*
 * 控制台的**视图层**（`docs/执行-三端同步…` §4.6、§4.7、§8.5、§10.1 M8）。
 *
 * ## 一个贯穿全文件的纪律
 *
 * 所有页面渲染都是**纯函数**：`render*(data)` → HTML 字符串。它们不取数、不写状态，
 * 也不知道 `isAdmin`。于是：
 *   - 空态 / 错误态 / 加载态都是调用方的事，不由视图偷偷兜底
 *   - 数据缺字段时页面会**显式显示「—」**，而不是悄悄少一行
 *   - 同一份视图既能用于真实数据，也能用于测试夹具
 *
 * ## 这个文件绝不显示的三种东西
 *
 * - 任何 `auth_hash` / `wrapped_enc_root`（服务端根本不下发，这里也不做假设）
 * - 任何「笔记正文」或明文路径（E2EE 下服务端没有；渲染出来就是假的）
 * - 任何「自动解决冲突」「一键重建」按钮（红线 2 / §4.5：裁决属于 CouchDB）
 */

(function () {
  "use strict";

  const ICON = window.ICON;

  /* ------------------------------------------------------------ 格式化 */

  function esc(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  const pad2 = (n) => (n < 10 ? "0" + n : String(n));

  function fmtDateTime(ms) {
    if (!ms) return "—";
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function fmtRelative(ms, now) {
    if (!ms) return "从未";
    const diff = (now || Date.now()) - ms;
    if (diff < 0) return "刚刚";
    if (diff < 60_000) return "刚刚";
    if (diff < 3_600_000) return Math.floor(diff / 60_000) + " 分钟前";
    if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + " 小时前";
    const days = Math.floor(diff / 86_400_000);
    if (days < 30) return days + " 天前";
    if (days < 365) return Math.floor(days / 30) + " 个月前";
    return Math.floor(days / 365) + " 年前";
  }

  function fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let v = n;
    let u = 0;
    while (v >= 1024 && u < units.length - 1) {
      v /= 1024;
      u += 1;
    }
    const digits = u === 0 ? 0 : v >= 100 ? 0 : 1;
    return v.toFixed(digits) + " " + units[u];
  }

  const fmtNum = (n) => Number(n || 0).toLocaleString("zh-CN");

  function fmtDuration(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const d = Math.floor(s / 86_400);
    const h = Math.floor((s % 86_400) / 3_600);
    const m = Math.floor((s % 3_600) / 60);
    if (d > 0) return `${d} 天 ${h} 小时`;
    if (h > 0) return `${h} 小时 ${m} 分`;
    return m + " 分钟";
  }

  const fmtDay = (day) => String(day).slice(5).replace("-", "/");

  /**
   * 截断标识：`前 head 位 … 后 tail 位`。
   *
   * ⚠️ `tail === 0` 要单独处理。`slice(-0)` 等于 `slice(0)` —— 返回**整个字符串**，
   * 于是「只留前 8 位」变成「前 8 位 + 全部 64 位」，表格里那一列被撑得离谱，
   * 而且看起来像数据错了（其实是显示错了）。邀请码的码哈希就是这么被印出来的。
   */
  function shortId(id, head = 8, tail = 4) {
    if (!id) return "—";
    if (tail <= 0) return id.length <= head ? id : id.slice(0, head) + "…";
    if (id.length <= head + tail + 1) return id;
    return id.slice(0, head) + "…" + id.slice(-tail);
  }

  function pct(part, total) {
    if (!total) return 0;
    return Math.max(0, Math.min(100, (part / total) * 100));
  }

  /**
   * 坐标轴的「漂亮上界」：1 / 2 / 5 × 10^k，并保证至少 4 格。
   *
   * 例：9 → 10，23 → 40（10 的 2 倍不够分 4 格？够，但 4 格下 40/4=10 更整齐），
   * 400 → 400，0 → 1。
   *
   * ★ 为什么不用固定量程：自托管的日常用量是个位数，固定 400 会把柱高压成 0 像素。
   */
  function niceCeil(value) {
    const safe = Math.max(1, value);
    const magnitude = Math.pow(10, Math.floor(Math.log10(safe)));
    for (const step of [1, 2, 5, 10]) {
      const candidate = step * magnitude;
      // 至少要能分 4 格，否则刻度会挤在一起（轴标签重叠比没标签更糟）。
      if (candidate >= safe && candidate / 4 >= 1) return Math.round(candidate);
    }
    return Math.round(10 * magnitude);
  }

  function platformLabel(platform) {
    if (platform === "desktop") return "桌面端";
    if (platform === "android") return "Android";
    if (platform === "web") return "网页端";
    return platform || "未知";
  }

  /* ------------------------------------------------------------ 组件 */

  function pageHead(spec) {
    return (
      '<div class="page-head">' +
      '<div class="page-head__main">' +
      '<div class="eyebrow"><span class="eyebrow__dot" aria-hidden="true"></span>' + esc(spec.eyebrow) + "</div>" +
      '<h1 class="page-title">' + esc(spec.title) + "</h1>" +
      (spec.lede ? '<p class="page-lede">' + spec.lede + "</p>" : "") +
      (spec.meta ? '<div class="page-meta">' + spec.meta + "</div>" : "") +
      "</div>" +
      (spec.actions ? '<div class="page-head__actions">' + spec.actions + "</div>" : "") +
      "</div>"
    );
  }

  function chip(label, kind) {
    return '<span class="chip' + (kind ? " chip--" + kind : "") + '">' + '<span class="chip__dot" aria-hidden="true"></span>' + esc(label) + "</span>";
  }

  /**
   * 用量条。
   *
   * ★ 用 SVG 的 `<rect width>` 而不是给 span 挂宽度（行内样式）：正式控制台的 CSP 是
   *   `style-src 'self'`，行内样式会被**直接丢弃** —— 那样每个账号的用量条都会变成满格。
   *   `width` 是几何属性，不在 CSP 的管辖范围内。
   */
  function meter(used, limit) {
    const ratio = pct(used, limit);
    const fill = ratio >= 95 ? "var(--danger)" : ratio >= 75 ? "var(--accent)" : "var(--ink-3)";
    return (
      '<div class="meter">' +
      '<svg class="meter__svg" viewBox="0 0 100 4" preserveAspectRatio="none" role="img" aria-label="用量 ' + ratio.toFixed(0) + '%">' +
      '<rect x="0" y="0" width="100" height="4" fill="var(--paper-4)"></rect>' +
      '<rect x="0" y="0" width="' + Math.max(0.5, ratio).toFixed(1) + '" height="4" fill="' + fill + '"></rect>' +
      "</svg>" +
      '<span class="meter__text">' + fmtBytes(used) + "</span>" +
      "</div>"
    );
  }

  function emptyState(spec) {
    return (
      '<div class="empty"><div class="empty__inner">' +
      '<div class="empty__seal" aria-hidden="true">記</div>' +
      '<h2 class="empty__title">' + esc(spec.title) + "</h2>" +
      '<p class="empty__lede">' + spec.lede + "</p>" +
      (spec.actions ? '<div class="empty__actions">' + spec.actions + "</div>" : "") +
      (spec.note ? '<p class="empty__note">' + spec.note + "</p>" : "") +
      "</div></div>"
    );
  }

  function skeletonCards(count) {
    const cell =
      '<div><div class="skeleton skeleton--line short"></div><div class="skeleton skeleton--value"></div><div class="skeleton skeleton--line u-skel-short"></div></div>';
    return '<div class="skeleton-cards">' + new Array(count || 4).fill(cell).join("") + "</div>";
  }

  function skeletonTable(rows) {
    const row =
      '<div class="skeleton-table__row"><div class="skeleton skeleton--cell"></div><div class="skeleton skeleton--cell short"></div><div class="skeleton skeleton--cell"></div><div class="skeleton skeleton--cell short"></div></div>';
    return '<div class="card skeleton-table">' + new Array(rows || 5).fill(row).join("") + "</div>";
  }

  /**
   * 错误态。
   *
   * ★ **绝不显示缓存数据**：运维页面看到旧数字比看不到更危险。
   *   所以这里只给状态码、一句人话、可复制的诊断信息，和一个重试按钮。
   */
  function errorPanel(spec) {
    return (
      '<div class="error-panel">' +
      '<div class="error-panel__eyebrow">' + ICON("alert", 12) + "请求失败 · " + esc(spec.status || "网络错误") + "</div>" +
      '<h2 class="error-panel__title">' + esc(spec.title || "服务端没有返回数据") + "</h2>" +
      '<p class="error-panel__msg">' +
      (spec.message || "这一页不会用缓存数据冒充成功 —— 运维页面看到旧数字比看不到更危险。") +
      "</p>" +
      (spec.detail ? '<code class="error-panel__code">' + esc(spec.detail) + "</code>" : "") +
      '<div class="error-panel__actions"><button class="btn btn--primary" type="button" data-retry>重试</button></div>' +
      "</div>"
    );
  }


  /* ============================================================ 运行状态 */

  /**
   * 近 30 天流量图：柱是拉取/推送（左轴），线是冲突（右轴）。
   *
   * ★ 冲突用**独立右轴**：它和流量差两个数量级，共用一条轴时冲突线会贴在底部
   *   变成一条看不见的直线 —— 而「冲突有没有在涨」恰恰是这一页要回答的问题。
   */
  function trafficChart(data) {
    const width = 720;
    const height = 190;
    const padLeft = 34;
    const padRight = 30;
    const padTop = 10;
    const padBottom = 22;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;
    const rows = data.length > 0 ? data : [];

    let max = 0;
    let conflictMax = 0;
    for (const d of rows) {
      max = Math.max(max, d.pushes + d.pulls);
      conflictMax = Math.max(conflictMax, d.conflicts);
    }
    /*
     * 空数据时**不画坐标轴**：一个 0~400 的空图会让人以为「有 400 的容量但今天没用」，
     * 而真实情况是「客户端还没上报过任何计数」。两者该长得不一样。
     */
    if (rows.length === 0) {
      return (
        '<div class="empty empty--inline"><div class="empty__inner">' +
        '<h3 class="empty__title">没有同步计数</h3>' +
        '<p class="empty__lede">还没有记录到同步活动。' +
        '这一块有<strong>两个来源</strong>：服务端在 <code>/v1</code> 数据面上自己数到的拉取/推送/冲突/错误，' +
        '以及客户端调用 <code>POST /v1/stats</code> 上报的按天计数（当前客户端尚未接入后者）。</p>' +
        '<p class="empty__note">两个来源都是空的，说明<strong>这台服务器还没有人同步过</strong> —— ' +
        '不是「图表坏了」。做一次同步再回来看。</p>' +
        "</div></div>"
      );
    }
    /*
     * ★ 纵轴量程必须**跟着数据走**，不能钉死成 400 的整数倍。
     *
     * 原型里写死 `ceil(max/400)*400`，在那份冻结的示例数据（每天几百次）上没问题；
     * 搬到真服务器上就露馅了：自托管的日常用量是**个位数到几十**，
     * 于是 9 次请求被画在 0~400 的轴上 —— 柱子高度不足 1 像素，看起来
     * 和「没有数据」一模一样，而卡片脚注明明写着「合计 9 次请求」。
     *
     * 现在取「刚好包住数据的漂亮刻度」：1 / 2 / 5 × 10^k，且至少分 4 格。
     */
    max = niceCeil(Math.max(1, max));
    conflictMax = niceCeil(Math.max(1, conflictMax));

    const barW = rows.length > 0 ? plotW / rows.length : plotW;
    const innerW = Math.max(2, barW - 3);

    const bars = rows
      .map((d, index) => {
        const x = padLeft + index * barW + (barW - innerW) / 2;
        const pushH = (d.pushes / max) * plotH;
        const pullH = (d.pulls / max) * plotH;
        const yPull = padTop + plotH - pullH;
        const yPush = yPull - pushH;
        return (
          '<g class="bar">' +
          '<rect x="' + x.toFixed(1) + '" y="' + yPull.toFixed(1) + '" width="' + innerW.toFixed(1) + '" height="' + Math.max(0.5, pullH).toFixed(1) + '" fill="var(--ink-3)" opacity="0.42" rx="1"></rect>' +
          '<rect x="' + x.toFixed(1) + '" y="' + yPush.toFixed(1) + '" width="' + innerW.toFixed(1) + '" height="' + Math.max(0.5, pushH).toFixed(1) + '" fill="var(--ink-2)" opacity="0.82" rx="1"></rect>' +
          "</g>"
        );
      })
      .join("");

    const points = rows
      .map((d, index) => {
        const x = padLeft + index * barW + barW / 2;
        const y = padTop + plotH - (d.conflicts / conflictMax) * plotH;
        return (index === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1);
      })
      .join(" ");

    const grid = [0, 0.25, 0.5, 0.75, 1]
      .map((ratio) => {
        const y = padTop + plotH * ratio;
        const value = Math.round(max * (1 - ratio));
        const conflicts = Math.round(conflictMax * (1 - ratio));
        return (
          '<line class="grid" x1="' + padLeft + '" y1="' + y.toFixed(1) + '" x2="' + (width - padRight) + '" y2="' + y.toFixed(1) + '"></line>' +
          '<text class="axis" x="' + (padLeft - 6) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end">' +
          (value >= 1000 ? (value / 1000).toFixed(1) + "k" : value) +
          "</text>" +
          '<text class="axis" x="' + (width - padRight + 6) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="start">' + conflicts + "</text>"
        );
      })
      .join("");

    const ticks = rows
      .map((d, index) => {
        if (index % Math.max(1, Math.floor(rows.length / 5)) !== 0 && index !== rows.length - 1) return "";
        const x = padLeft + index * barW + barW / 2;
        return '<text class="axis" x="' + x.toFixed(1) + '" y="' + (height - 6) + '" text-anchor="middle">' + fmtDay(d.day) + "</text>";
      })
      .join("");

    return (
      '<div class="chart">' +
      '<div class="chart__legend">' +
      '<span class="chart__legend-item"><span class="chart__swatch"></span>拉取</span>' +
      '<span class="chart__legend-item"><span class="chart__swatch chart__swatch--muted"></span>推送</span>' +
      '<span class="chart__legend-item"><span class="chart__swatch chart__swatch--accent"></span>冲突（右轴）</span>' +
      "</div>" +
      '<svg class="chart__svg" viewBox="0 0 ' + width + " " + height + '" role="img" aria-label="近 30 天每日拉取、推送与冲突计数">' +
      grid +
      bars +
      (rows.length > 1
        ? '<path d="' + points + '" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"></path>'
        : "") +
      ticks +
      "</svg></div>"
    );
  }

  function renderOverview(data, now) {
    const days = data.traffic.days;
    const total = data.traffic.total;
    const att = data.attention || [];

    const attentionBand =
      att.length === 0
        ? ""
        : '<div class="attention">' +
          '<div class="attention__head">' + ICON("alert", 13) + '<span class="attention__title">' + att.length + " 项需要处理</span>" +
          '<span class="attention__hint">按影响排序</span></div>' +
          att
            .map(
              (item) =>
                '<div class="attention__row attention__row--' + esc(item.tone || "quiet") + '">' +
                '<span class="attention__mark" aria-hidden="true"></span>' +
                '<span class="attention__text"><strong>' + esc(item.title) + "</strong>" +
                (item.detail ? '<span class="attention__detail">' + esc(item.detail) + "</span>" : "") +
                "</span>" +
                '<button class="link-btn" type="button" data-go="' + esc(item.action) + '">查看</button>' +
                "</div>",
            )
            .join("") +
          "</div>";

    const health = data.health;
    const healthOk = health.couchOk;
    const healthRows = [
      ["CouchDB", health.couchOk ? health.couchVersion || "已连接" : "连不上"],
      ["协议版本", "v" + health.protocolVersion],
      ["运行时长", fmtDuration(health.uptimeSeconds)],
      ["置备不一致", health.provisioningMismatch === 0 ? "无" : health.provisioningMismatch + " 个库"],
    ];

    return (
      '<div class="page">' +
      pageHead({
        eyebrow: "服务 · 运行状态",
        title: "同步服务运行状态",
        lede:
          "账号、笔记本、同步流量与冲突的同一张仪表盘。所有数字直接来自控制面 SQLite 与客户端上报的按天计数 —— 服务端看不到笔记正文，也不展示它。",
        meta:
          '<span class="mono">数据截至 ' + esc(fmtDateTime(data.generatedAt)) + "</span>" +
          '<span class="mono">uptime ' + esc(fmtDuration(health.uptimeSeconds)) + "</span>",
        actions:
          '<button class="btn" type="button" data-refresh>' + ICON("refresh", 13) + "刷新</button>",
      }) +
      attentionBand +
      /* 四个数字 */
      '<div class="ledger">' +
      '<div class="ledger__cell"><div class="ledger__label">账号</div><div class="ledger__value">' + fmtNum(data.accounts.total) + '<span class="ledger__unit">个</span></div><div class="ledger__sub">' + data.accounts.admins + " 位管理员 · " + data.accounts.disabled + " 个已禁用</div></div>" +
      '<div class="ledger__cell"><div class="ledger__label">笔记本</div><div class="ledger__value">' + fmtNum(data.notebooks.total) + '<span class="ledger__unit">个</span></div><div class="ledger__sub">合计 ' + fmtBytes(data.notebooks.bytesUsed) + "</div></div>" +
      '<div class="ledger__cell"><div class="ledger__label">设备</div><div class="ledger__value">' + fmtNum(data.devices.total) + '<span class="ledger__unit">台</span></div><div class="ledger__sub">' + (data.devices.total === 0 ? "客户端未上报" : data.devices.stale + " 台 30 天未同步") + "</div></div>" +
      '<div class="ledger__cell"><div class="ledger__label">近 30 天冲突</div><div class="ledger__value">' + fmtNum(total.conflicts) + '<span class="ledger__unit">次</span></div><div class="ledger__sub">拉取 ' + fmtNum(total.pulls) + " · 推送 " + fmtNum(total.pushes) + "</div></div>" +
      "</div>" +
      /* 图 + 健康 */
      '<div class="grid-2">' +
      '<div class="card"><div class="card__head"><span class="card__title">近 30 天同步流量</span><span class="card__meta">按天 · 服务端实测</span></div>' +
      '<div class="card__body">' + trafficChart(days) + "</div>" +
      '<div class="card__foot">合计 ' + fmtNum(total.pulls + total.pushes) + " 次请求 · 冲突 " + fmtNum(total.conflicts) + " 次 · 错误 " + fmtNum(total.errors) + " 次</div></div>" +
      '<div class="card"><div class="card__head"><span class="card__title">服务健康</span>' + chip(healthOk ? "全部正常" : "需要处理", healthOk ? "ok" : "danger") + "</div>" +
      '<div class="card__body card__body--flush"><dl class="service-row">' +
      healthRows
        .map(([k, v]) => "<div><dt>" + esc(k) + "</dt><dd>" + esc(v) + "</dd></div>")
        .join("") +
      "</dl></div>" +
      '<div class="card__foot">配置只读：改动走环境变量 + 重启，热更新会让「当前生效值」变得不可回答。</div></div>' +
      "</div>" +
      activityCard(data.recentEvents || []) +
      "</div>"
    );
  }

  /**
   * 「最近控制面动作」卡。
   *
   * 这是概览页上**唯一**来自审计表的内容，也是这一页最像「运维现场」的一块：
   * 它能回答「刚才谁动了什么」。数据全站可见（它是管理页），不需要额外权限。
   */
  function activityCard(events) {
    if (events.length === 0) {
      return (
        '<div class="card"><div class="card__head"><span class="card__title">最近控制面动作</span></div>' +
        '<div class="card__body"><p class="note">还没有记录到任何控制面动作。' +
        '注册、建库、发码、登录都会写进审计表 —— 这里是空的，说明这台服务器还没被用过。</p></div></div>'
      );
    }
    return (
      '<div class="card"><div class="card__head"><span class="card__title">最近控制面动作</span>' +
      '<span class="card__meta"><button class="btn btn--sm" type="button" data-go="logs">全部日志 ' + ICON("chevronRight", 11) + "</button></span></div>" +
      '<div class="card__body card__body--flush"><div class="activity">' +
      events
        .map((event) => {
          const [label] = actionLabel(event.action);
          return (
            '<button type="button" class="activity__row" data-open-event="' + esc(String(event.at)) + '">' +
            '<span class="activity__time">' + esc(fmtClock(event.at)) + "</span>" +
            '<span class="activity__action">' + esc(label) + "</span>" +
            '<span class="activity__target">' + esc(event.actorId ? shortId(event.actorId) : "系统 / CLI") +
            (event.detail ? " · " + esc(event.detail) : "") +
            "</span></button>"
          );
        })
        .join("") +
      "</div></div>" +
      '<div class="card__foot">审计只记「谁在什么时候做了什么」，不含正文与密钥材料。</div></div>'
    );
  }

  /** 时:分（概览的活动列表只需要这个精度）。 */
  function fmtClock(ms) {
    if (!ms) return "—";
    const d = new Date(ms);
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }


  /* ============================================================ 同步台账 */

  function provisioningCell(nb) {
    const p = nb.provisioning;
    if (!p) return '<span class="cell-sub">未核对</span>';
    if (p.designOk && p.syncInfoOk) return chip("就位", "ok");
    return chip("不一致", "danger");
  }

  function renderData(data, filters) {
    const q = (filters.q || "").toLowerCase();
    const crypto = filters.crypto || "all";
    const list = data.notebooks.filter((nb) => {
      if (crypto !== "all" && nb.cryptoMode !== crypto) return false;
      if (!q) return true;
      return (
        nb.name.toLowerCase().includes(q) ||
        (nb.ownerLabel || "").toLowerCase().includes(q) ||
        nb.ownerId.toLowerCase().includes(q) ||
        nb.id.toLowerCase().includes(q)
      );
    });

    const rows = list
      .map(
        (nb) =>
          '<tr class="is-clickable" data-open-notebook="' + esc(nb.id) + '" tabindex="0">' +
          '<td class="u-min-w-0"><div class="cell-main">' + esc(nb.name) + "</div>" +
          '<div class="cell-sub mono">' + esc(shortId(nb.id)) + "</div></td>" +
          "<td>" + esc(nb.ownerLabel || shortId(nb.ownerId)) + "</td>" +
          "<td>" + (nb.cryptoMode === "user-key" ? chip("E2EE", "quiet") : '<span class="cell-sub">明文</span>') + "</td>" +
          '<td class="mono">' + nb.memberCount + "</td>" +
          '<td class="mono u-nowrap">' + fmtBytes(nb.bytesUsed) + "</td>" +
          "<td>" + provisioningCell(nb) + "</td>" +
          '<td class="mono u-nowrap">' + esc(fmtDateTime(nb.createdAt)) + "</td>" +
          '<td class="cell-chevron">' + ICON("chevronRight", 13) + "</td>" +
          "</tr>",
      )
      .join("");

    const body =
      list.length === 0
        ? emptyState({
            title: "没有匹配的笔记本",
            lede: "换个关键词，或把筛选放宽。台账只列<strong>未被删除</strong>的库。",
            actions: '<button class="btn" type="button" data-clear-filters>清除筛选</button>',
          })
        : '<div class="card card--flush"><table class="table"><thead><tr>' +
          "<th>笔记本</th><th>所有者</th><th>加密</th><th>成员</th><th>占用</th><th>置备</th><th>创建于</th><th></th>" +
          "</tr></thead><tbody>" + rows + "</tbody></table></div>";

    return (
      '<div class="page">' +
      pageHead({
        eyebrow: "服务 · 同步台账",
        title: "同步台账",
        lede:
          "服务端能看到的全部同步事实：哪些笔记本在同步、谁在写、占了多少。这里<strong>不展示笔记内容</strong> —— 明文库服务端虽然读得到，但管理页不把它当成浏览入口。",
        meta: "<span>" + data.notebooks.length + " 个库</span>" +
          "<span>合计 " + fmtBytes(data.notebooks.reduce((a, nb) => a + nb.bytesUsed, 0)) + "</span>",
      }) +
      '<div class="toolbar">' +
      '<input class="field field--search" type="search" placeholder="搜索名称、所有者或 id" data-filter="q" value="' + esc(filters.q || "") + '" />' +
      '<div class="segmented" role="group" aria-label="加密方式">' +
      '<button type="button" class="' + (crypto === "all" ? "is-active" : "") + '" data-filter-choice="crypto:all">全部</button>' +
      '<button type="button" class="' + (crypto === "none" ? "is-active" : "") + '" data-filter-choice="crypto:none">明文</button>' +
      '<button type="button" class="' + (crypto === "user-key" ? "is-active" : "") + '" data-filter-choice="crypto:user-key">E2EE</button>' +
      "</div>" +
      '<span class="toolbar__label">' + list.length + " / " + data.notebooks.length + "</span>" +
      "</div>" +
      body +
      "</div>"
    );
  }


  /* ========================================================== 账号与访问 */

  function inviteState(invite, now) {
    if (invite.revokedAt) return { label: "已作废", kind: "quiet" };
    if (invite.expiresAt !== null && invite.expiresAt < now) return { label: "已过期", kind: "quiet" };
    if (invite.uses >= invite.maxUses) return { label: "已用尽", kind: "quiet" };
    return { label: "可用", kind: "ok" };
  }

  function renderAccounts(data, filters, now) {
    const q = (filters.q || "").toLowerCase();
    const status = filters.status || "all";
    const list = data.accounts.filter((row) => {
      if (status !== "all" && row.status !== status) return false;
      if (!q) return true;
      return (row.label || "").toLowerCase().includes(q) || row.accountId.toLowerCase().includes(q);
    });

    const inviteRows = data.invites
      .map((invite) => {
        const state = inviteState(invite, now);
        return (
          "<tr>" +
          '<td class="mono">' + esc(shortId(invite.codeHash, 8, 0)) + "…</td>" +
          "<td>" + chip(state.label, state.kind) + "</td>" +
          '<td class="mono u-nowrap">' + invite.uses + " / " + invite.maxUses + "</td>" +
          '<td class="mono u-nowrap">' + (invite.expiresAt === null ? "不过期" : esc(fmtDateTime(invite.expiresAt))) + "</td>" +
          "<td>" + esc(invite.creatorLabel || (invite.createdBy ? shortId(invite.createdBy) : "CLI（根信任）")) + "</td>" +
          "<td>" +
          (state.label === "可用"
            ? '<button class="btn btn--sm" type="button" data-revoke-invite="' + esc(invite.codeHash) + '">作废</button>'
            : '<span class="cell-sub">—</span>') +
          "</td></tr>"
        );
      })
      .join("");

    const accountRows = list
      .map((row) => {
        const isSelf = row.accountId === data.selfId;
        return (
          '<tr class="is-clickable" data-open-account="' + esc(row.accountId) + '" tabindex="0">' +
          '<td class="u-min-w-0"><div class="cell-main">' + esc(row.label || shortId(row.accountId)) +
          (isSelf ? ' <span class="cell-sub">（你）</span>' : "") +
          '<span class="cell-tag">' + (row.isAdmin ? "管理员" : "普通") + "</span></div>" +
          '<div class="cell-sub mono">' + esc(shortId(row.accountId)) + "</div></td>" +
          "<td>" + (row.status === "active" ? chip("正常", "ok") : chip("已禁用", "quiet")) + "</td>" +
          '<td class="mono">' + row.quota.notebooks + " / " + row.quota.notebooksLimit + "</td>" +
          "<td>" + meter(row.quota.bytesUsed, row.quota.bytesLimit) + "</td>" +
          '<td class="u-nowrap"><div class="cell-main u-fs-13">' + esc(fmtRelative(row.lastSeenAt, now)) + "</div>" +
          '<div class="cell-sub mono">' + esc(fmtDateTime(row.lastSeenAt)) + "</div></td>" +
          '<td class="cell-chevron">' + ICON("chevronRight", 13) + "</td>" +
          "</tr>"
        );
      })
      .join("");

    return (
      '<div class="page">' +
      pageHead({
        eyebrow: "人员与设备 · 访问",
        title: "账号与访问",
        lede:
          "没有用户名、没有口令 —— 一个账号就是一把密钥。管理员能做的只有三件事：禁用账号、删除账号、生成邀请码。",
        meta: "<span>" + data.accounts.length + " 个账号</span><span>" + data.accounts.filter((a) => a.isAdmin).length + " 位管理员</span>",
      }) +
      /* 能力边界：写死在页面上，因为它是「服务端做不到什么」的事实 */
      '<div class="banner banner--warn">' + ICON("alert", 14) +
      "<span><strong>三条能力边界：</strong>服务端无法补发任何人的密钥；要踢掉设备只能轮换密钥，且会波及该账号所有设备；管理员也无法重置任何人的密钥。</span></div>" +

      '<div class="card"><div class="card__head"><span class="card__title">注册邀请码</span>' +
      '<span class="card__meta">明文只在生成时出现一次</span>' +
      '<button class="btn btn--primary btn--sm" type="button" data-create-invite>' + ICON("plus", 13) + "生成</button></div>" +
      '<div class="card__body card__body--flush"><table class="table"><thead><tr>' +
      "<th>码哈希</th><th>状态</th><th>用量</th><th>有效期至</th><th>创建者</th><th></th>" +
      "</tr></thead><tbody>" +
      (inviteRows || '<tr><td colspan="6"><span class="cell-sub">还没有邀请码。生成一个才能让新成员注册。</span></td></tr>') +
      "</tbody></table></div>" +
      '<div class="card__foot">库里只存哈希 —— 事后连服务端也拿不回明文。CLI 发出的码 createdBy 为空。</div></div>' +

      '<div class="toolbar">' +
      '<input class="field field--search" type="search" placeholder="搜索标签或 accountId" data-filter="q" value="' + esc(filters.q || "") + '" />' +
      '<div class="segmented" role="group" aria-label="账号状态">' +
      '<button type="button" class="' + (status === "all" ? "is-active" : "") + '" data-filter-choice="status:all">全部</button>' +
      '<button type="button" class="' + (status === "active" ? "is-active" : "") + '" data-filter-choice="status:active">正常</button>' +
      '<button type="button" class="' + (status === "disabled" ? "is-active" : "") + '" data-filter-choice="status:disabled">已禁用</button>' +
      "</div>" +
      '<span class="toolbar__label">' + list.length + " 个账号</span>" +
      "</div>" +

      (list.length === 0
        ? emptyState({ title: "没有匹配的账号", lede: "换个关键词，或把状态筛选放宽。", actions: '<button class="btn" type="button" data-clear-filters>清除筛选</button>' })
        : '<div class="card card--flush"><table class="table"><thead><tr>' +
          "<th>账号</th><th>状态</th><th>笔记本</th><th>用量</th><th>最近活动</th><th></th>" +
          "</tr></thead><tbody>" + accountRows + "</tbody></table></div>") +
      "</div>"
    );
  }


  /* ================================================================ 设备 */

  function renderDevices(data, filters, now) {
    const q = (filters.q || "").toLowerCase();
    const platform = filters.platform || "all";
    const list = data.devices.filter((d) => {
      if (platform !== "all" && d.platform !== platform) return false;
      if (!q) return true;
      return (
        (d.name || "").toLowerCase().includes(q) ||
        (d.accountLabel || "").toLowerCase().includes(q) ||
        d.accountId.toLowerCase().includes(q)
      );
    });

    const rows = list
      .map((d) => {
        const stale = (d.lastSeenAt || d.createdAt) < now - 30 * 86_400_000;
        return (
          "<tr>" +
          '<td class="u-min-w-0"><div class="cell-main">' + esc(d.name || "未命名设备") + "</div>" +
          '<div class="cell-sub mono">' + esc(shortId(d.deviceId)) + "</div></td>" +
          "<td>" + esc(d.accountLabel || shortId(d.accountId)) + "</td>" +
          "<td>" + chip(platformLabel(d.platform), "quiet") + "</td>" +
          '<td class="u-nowrap"><div class="cell-main u-fs-13">' + esc(fmtRelative(d.lastSeenAt, now)) + "</div>" +
          (stale ? '<div class="cell-sub">30 天未同步</div>' : "") + "</td>" +
          '<td class="mono u-nowrap">' + esc(fmtDateTime(d.createdAt)) + "</td>" +
          "</tr>"
        );
      })
      .join("");

    return (
      '<div class="page">' +
      pageHead({
        eyebrow: "人员与设备 · 设备",
        title: "设备",
        lede:
          "设备账本，<strong>只读</strong>。一个账号密钥所有设备共用，所以没有「踢掉这一台」这个动作 —— 唯一的吊销手段是让那个账号轮换密钥。",
        meta:
          "<span>" + data.devices.length + " 台</span>" +
          "<span>" + data.devices.filter((d) => (d.lastSeenAt || d.createdAt) < now - 30 * 86_400_000).length + " 台 30 天未同步</span>",
      }) +
      '<div class="banner">' + ICON("info", 14) + "<span>" + esc(data.note) +
      " <strong>设备行由客户端每次同步时顺带登记</strong>（<code>PUT /v1/checkpoint</code> 带 <code>deviceId</code>），" +
      "所以只要同步跑过，这里就有记录；名称与平台客户端暂未上报，显示为「未命名设备」。</span></div>" +
      '<div class="toolbar">' +
      '<input class="field field--search" type="search" placeholder="搜索设备名、账号" data-filter="q" value="' + esc(filters.q || "") + '" />' +
      '<div class="segmented" role="group" aria-label="平台">' +
      ["all", "desktop", "android", "web"]
        .map(
          (value) =>
            '<button type="button" class="' + (platform === value ? "is-active" : "") + '" data-filter-choice="platform:' + value + '">' +
            (value === "all" ? "全部" : platformLabel(value)) +
            "</button>",
        )
        .join("") +
      "</div>" +
      '<span class="toolbar__label">' + list.length + " / " + data.devices.length + "</span>" +
      "</div>" +
      (list.length === 0
        ? emptyState({ title: "没有匹配的设备", lede: "设备行由客户端同步时顺带登记（检查点请求里带着 <code>deviceId</code>）。<strong>整张表为空</strong>说明这台服务器还没有设备跑过同步 —— 而不是「筛选把它藏起来了」。", actions: '<button class="btn" type="button" data-clear-filters>清除筛选</button>' })
        : '<div class="card card--flush"><table class="table"><thead><tr>' +
          "<th>设备</th><th>账号</th><th>平台</th><th>最近活动</th><th>登记于</th>" +
          "</tr></thead><tbody>" + rows + "</tbody></table></div>") +
      "</div>"
    );
  }


  /* ========================================================== 冲突与异常 */

  function renderIssues(overview, now) {
    const days = overview.traffic.days;
    const conflicts30 = overview.traffic.total.conflicts;
    const errors30 = overview.traffic.total.errors;

    /* 近 14 天：实线冲突、虚线错误。两者数量级接近，共用一条轴是对的。 */
    const recent = days.slice(-14);
    const width = 720;
    const height = 180;
    const padLeft = 34;
    const padRight = 16;
    const padTop = 12;
    const padBottom = 22;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;
    let max = 4;
    for (const d of recent) max = Math.max(max, d.conflicts, d.errors);
    max = Math.ceil(max / 4) * 4;
    const barW = recent.length > 0 ? plotW / recent.length : plotW;

    const line = (key, dashed) => {
      const pts = recent
        .map((d, index) => {
          const x = padLeft + index * barW + barW / 2;
          const y = padTop + plotH - (d[key] / max) * plotH;
          return (index === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1);
        })
        .join(" ");
      return '<path d="' + pts + '" fill="none" stroke="' + (dashed ? "var(--ink-2)" : "var(--accent)") + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"' + (dashed ? ' stroke-dasharray="4 3"' : "") + "></path>";
    };

    const grid = [0, 0.5, 1]
      .map((ratio) => {
        const y = padTop + plotH * ratio;
        return (
          '<line class="grid" x1="' + padLeft + '" y1="' + y.toFixed(1) + '" x2="' + (width - padRight) + '" y2="' + y.toFixed(1) + '"></line>' +
          '<text class="axis" x="' + (padLeft - 6) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end">' + Math.round(max * (1 - ratio)) + "</text>"
        );
      })
      .join("");

    const ticks = recent
      .map((d, index) => {
        if (index % 4 !== 0 && index !== recent.length - 1) return "";
        const x = padLeft + index * barW + barW / 2;
        return '<text class="axis" x="' + x.toFixed(1) + '" y="' + (height - 6) + '" text-anchor="middle">' + fmtDay(d.day) + "</text>";
      })
      .join("");

    /*
     * ★ 数据点标记。
     *
     * 折线只在**两天以上**时才画得出来（一个点连不成线）。第一版就是这样，
     * 于是「昨天有 1 次冲突」在图上完全看不见 —— 卡片上的数字是 1、图里却一片空白，
     * 而这一页的存在意义就是「让人一眼看到冲突在涨」。
     * 现在每个非零点都画一个圆点：单日数据也能看见，多点时也不改变折线的形状。
     */
    const dots = (key, color) =>
      recent
        .map((d, index) => {
          if (!d[key]) return "";
          const x = padLeft + index * barW + barW / 2;
          const y = padTop + plotH - (d[key] / max) * plotH;
          return '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="2.6" fill="' + color + '"></circle>';
        })
        .join("");

    const chart =
      '<div class="chart"><div class="chart__legend">' +
      '<span class="chart__legend-item"><span class="chart__swatch chart__swatch--accent"></span>冲突</span>' +
      '<span class="chart__legend-item"><span class="chart__swatch chart__swatch--muted"></span>错误（虚线）</span>' +
      "</div>" +
      '<svg class="chart__svg" viewBox="0 0 ' + width + " " + height + '" role="img" aria-label="近 14 天冲突与错误">' +
      grid +
      (recent.length > 1 ? line("conflicts", false) + line("errors", true) : "") +
      dots("errors", "var(--ink-2)") +
      dots("conflicts", "var(--accent)") +
      ticks +
      "</svg></div>";

    /*
     * 冲突热点由**服务端**算好下发（`conflictHotspots`）。
     *
     * 这里刻意不自己聚合：`client_stats` 是按账号存的，前端只看得到当前登录
     * 那个人 —— 而这一页问的是**全站**哪一端坏了。
     */
    const hotspots = overview.conflictHotspots || [];
    const hotspotRows = hotspots
      .slice(0, 8)
      .map(
        (row) =>
          "<tr>" +
          '<td class="u-min-w-0"><div class="cell-main">' + esc(row.label || shortId(row.accountId)) + "</div>" +
          '<div class="cell-sub mono">' + esc(shortId(row.accountId)) + "</div></td>" +
          '<td class="mono">' + fmtNum(row.conflicts) + "</td>" +
          '<td class="mono">' + fmtNum(row.errors) + "</td>" +
          '<td class="mono">' + (row.notebooks || 0) + "</td>" +
          "</tr>",
      )
      .join("");

    return (
      '<div class="page">' +
      pageHead({
        eyebrow: "运维 · 冲突与异常",
        title: "冲突与异常",
        lede:
          "服务端只记录<strong>计数</strong>，看不到冲突内容 —— 裁决属于 CouchDB。所以这一页不做「自动解决」，只把「哪里在持续变坏」摆出来，让人去查那一端的基线。",
        meta: "<span class='mono'>服务端实测 + 客户端上报</span>",
      }) +
      '<div class="banner">' + ICON("info", 14) +
      "<span><strong>怎么读这一页：</strong>偶发的冲突是正常的（两台设备同时改同一篇）。<strong>持续增长</strong>才是问题 —— 那通常意味着一端的同步基线坏了，会不断制造假冲突。<br><strong>数据来源：</strong>服务端在 <code>/v1</code> 数据面上自己数（<code>PUT /v1/file</code> 的 409 即一次冲突），不依赖客户端上报；客户端上报（<code>POST /v1/stats</code>）接入后与它合并展示，同一天取两者较大值。</span></div>" +

      '<div class="ledger">' +
      '<div class="ledger__cell"><div class="ledger__label">近 30 天冲突</div><div class="ledger__value">' + fmtNum(conflicts30) + '<span class="ledger__unit">次</span></div></div>' +
      '<div class="ledger__cell"><div class="ledger__label">近 30 天错误</div><div class="ledger__value">' + fmtNum(errors30) + '<span class="ledger__unit">次</span></div></div>' +
      '<div class="ledger__cell"><div class="ledger__label">置备不一致</div><div class="ledger__value">' + overview.health.provisioningMismatch + '<span class="ledger__unit">个库</span></div><div class="ledger__sub">需人工核对，不会自动重建</div></div>' +
      '<div class="ledger__cell"><div class="ledger__label">可自动解决</div><div class="ledger__value">0<span class="ledger__unit">项</span></div><div class="ledger__sub">设计如此：裁决属于 CouchDB</div></div>' +
      "</div>" +

      '<div class="card"><div class="card__head"><span class="card__title">近 14 天冲突与错误</span><span class="card__meta">按天 · 全部账号</span></div>' +
      '<div class="card__body">' + chart + "</div></div>" +

      '<div class="card"><div class="card__head"><span class="card__title">冲突热点</span><span class="card__meta">按影响排序</span></div>' +
      '<div class="card__body card__body--flush">' +
      (hotspotRows
        ? '<table class="table"><thead><tr><th>账号</th><th>冲突</th><th>错误</th><th>涉及库</th></tr></thead><tbody>' + hotspotRows + "</tbody></table>"
        : '<p class="note">近 30 天没有冲突或错误。服务端的计数是它自己数出来的（每一次 <code>PUT</code> / <code>DELETE</code> 都记账），所以「0」就真的是 0。</p>') +
      "</div></div>" +
      "</div>"
    );
  }

  /* ============================================================ 同步日志 */

  function actionLabel(action) {
    const map = {
      panel_login: ["控制台登录", "auth"],
      panel_step_up: ["二次验证", "auth"],
      panel_create_invite: ["生成邀请码", "invite"],
      panel_disable_account: ["禁用账号", "account"],
      panel_enable_account: ["启用账号", "account"],
      panel_delete_account: ["删除账号", "account"],
      panel_inspect_notebook: ["核对置备", "notebook"],
      create_account: ["注册账号", "account"],
      rotate_key: ["轮换密钥", "auth"],
      delete_account: ["删除账号", "account"],
      create_invite: ["生成邀请码", "invite"],
      revoke_invite: ["作废邀请码", "invite"],
      create_notebook: ["建笔记本", "notebook"],
      delete_notebook: ["删笔记本", "notebook"],
      cli_grant_admin: ["CLI 提权", "admin"],
      cli_revoke_admin: ["CLI 降权", "admin"],
    };
    return map[action] || [action, "other"];
  }

  function renderLogs(events, filters, now) {
    const q = (filters.q || "").toLowerCase();
    const category = filters.category || "all";
    const list = events.filter((e) => {
      const [label, cat] = actionLabel(e.action);
      if (category !== "all" && cat !== category) return false;
      if (!q) return true;
      return (
        label.toLowerCase().includes(q) ||
        e.action.toLowerCase().includes(q) ||
        (e.actorId || "").toLowerCase().includes(q) ||
        (e.target || "").toLowerCase().includes(q)
      );
    });

    const rows = list
      .map((e, index) => {
        const [label, cat] = actionLabel(e.action);
        return (
          '<tr class="is-clickable" data-open-log="' + index + '" tabindex="0">' +
          '<td class="mono u-nowrap">' + esc(fmtDateTime(e.at)) + "</td>" +
          "<td>" + esc(label) + "</td>" +
          "<td>" + (cat === "other" ? '<span class="cell-sub">其他</span>' : chip(cat, cat === "admin" || cat === "account" ? "quiet" : "quiet")) + "</td>" +
          "<td>" + esc(e.actorId ? shortId(e.actorId) : "系统 / CLI") + "</td>" +
          '<td class="mono">' + esc(e.target ? shortId(e.target) : "—") + "</td>" +
          '<td class="cell-chevron">' + ICON("chevronRight", 13) + "</td>" +
          "</tr>"
        );
      })
      .join("");

    return (
      '<div class="page">' +
      pageHead({
        eyebrow: "运维 · 同步日志",
        title: "同步日志",
        lede:
          "控制面的<strong>审计事件</strong>：谁在什么时候做了什么。它回答「谁动的」，不承担「逐篇同步流水」—— 那个粒度在服务端根本不存在（看不到笔记内容）。",
        meta: "<span>" + events.length + " 条最近事件</span>",
      }) +
      '<div class="toolbar">' +
      '<input class="field field--search" type="search" placeholder="搜索动作、操作者、对象" data-filter="q" value="' + esc(filters.q || "") + '" />' +
      '<div class="segmented" role="group" aria-label="类别">' +
      ["all", "account", "auth", "invite", "notebook", "admin"]
        .map(
          (value) =>
            '<button type="button" class="' + (category === value ? "is-active" : "") + '" data-filter-choice="category:' + value + '">' +
            ({ all: "全部", account: "账号", auth: "认证", invite: "邀请码", notebook: "笔记本", admin: "管理员" })[value] +
            "</button>",
        )
        .join("") +
      "</div>" +
      '<span class="toolbar__label">' + list.length + " / " + events.length + "</span>" +
      "</div>" +
      (list.length === 0
        ? emptyState({ title: "没有匹配的事件", lede: "换个关键词，或把类别筛选放宽。", actions: '<button class="btn" type="button" data-clear-filters>清除筛选</button>' })
        : '<div class="card card--flush"><table class="table"><thead><tr>' +
          "<th>时间</th><th>动作</th><th>类别</th><th>操作者</th><th>对象</th><th></th>" +
          "</tr></thead><tbody>" + rows + "</tbody></table></div>") +
      "</div>"
    );
  }


  /* ========================================================== 服务端配置 */

  function configRow(label, value, mono) {
    return (
      "<div><dt>" + esc(label) + "</dt>" +
      '<dd class="' + (mono ? "mono" : "") + '">' + esc(value) + "</dd></div>"
    );
  }

  function renderServer(data, health) {
    const c = data.config;
    const quarantined = health && !health.couchOk;

    return (
      '<div class="page">' +
      pageHead({
        eyebrow: "运维 · 服务端配置",
        title: "服务端配置",
        lede:
          "当前生效的配置（<strong>只读</strong>）。改动走环境变量 + 重启 —— 热更新会让「现在到底是什么值」变得不可回答，而那正是运维页面存在的理由。",
        meta: "<span>" + (data.readOnly ? "只读" : "可写") + "</span>",
      }) +
      (quarantined
        ? '<div class="banner banner--warn">' + ICON("alert", 14) + "<span><strong>CouchDB 现在连不上。</strong>下面这些配置仍然是真的，但任何依赖 CouchDB 的检查都会失败。</span></div>"
        : "") +

      '<div class="grid-2">' +
      '<div class="card"><div class="card__head"><span class="card__title">连接与地址</span></div>' +
      '<div class="card__body card__body--flush"><dl class="service-row">' +
      configRow("外部地址", c.externalBaseUrl, true) +
      configRow("CouchDB", c.couchUrl, true) +
      configRow("运行时账号", c.couchUser, true) +
      configRow("管理凭据", c.couchAdminUserConfigured ? "已配置（不下发）" : "未配置") +
      configRow("控制面库", c.sqlitePath, true) +
      "</dl></div></div>" +

      '<div class="card"><div class="card__head"><span class="card__title">协议与限额</span></div>' +
      '<div class="card__body card__body--flush"><dl class="service-row">' +
      configRow("协议版本", "v" + c.protocolVersionExpected) +
      configRow("单文件上限", fmtBytes(c.maxFileBytes)) +
      configRow("账号配额", fmtBytes(c.defaultAccountQuotaBytes) + " · " + c.defaultAccountQuotaNotebooks + " 个库") +
      configRow("账号限流", c.accountRequestsPerMinute + " 请求/分钟") +
      configRow("全局限流", c.globalRequestsPerMinute + " 请求/分钟") +
      configRow("日志级别", c.logLevel, true) +
      "</dl></div></div>" +
      "</div>" +

      '<div class="card"><div class="card__head"><span class="card__title">为什么没有「保存」按钮</span></div>' +
      '<div class="card__body"><p class="note">' + esc(data.note) + "</p>" +
      '<p class="note u-mt-10">这一页能做的是<strong>核对</strong>：把「现在生效的值」摆出来，和部署清单对上。真正的变更入口是服务器上的环境变量。' +
      "把它做成本页面里的开关，会引入一个很难查的状态：数据库里的值和进程里的值不一致。</p></div></div>" +
      "</div>"
    );
  }

  /* ========================================================== 身份与授权 */

  function chainStep(index, title, detail, artifact, tone) {
    return (
      '<div class="chain__step' + (tone ? " chain__step--" + tone : "") + '">' +
      '<div class="chain__index" aria-hidden="true">' + index + "</div>" +
      '<div class="chain__body"><div class="chain__title">' + esc(title) + "</div>" +
      '<div class="chain__detail">' + detail + "</div>" +
      (artifact ? '<code class="chain__artifact">' + esc(artifact) + "</code>" : "") +
      "</div></div>"
    );
  }

  function renderIdentity(me) {
    const isAdmin = Boolean(me && me.isAdmin);
    return (
      '<div class="page">' +
      pageHead({
        eyebrow: "参考 · 身份与授权",
        title: "控制台怎么验证你是管理员",
        lede:
          "没有管理员口令、没有用户名、没有会话表。<strong>一把账号密钥就是全部身份</strong> —— 管理员的判定只发生在注册那一刻，以及此后每一次请求的查表里。",
        meta: '<span class="mono">accounts.auth_hash → is_admin</span>' + chip(isAdmin ? "当前账号：管理员" : "当前账号：普通", isAdmin ? "ok" : "quiet"),
      }) +
      '<div class="banner banner--accent">' + ICON("shield", 14) +
      "<span><strong>先纠正一个常见误解：</strong>这里没有「管理员密码」这种东西。服务端也不存任何口令 —— <code>accounts</code> 表里只有 <code>auth_hash = sha256(authToken)</code>。所以「验证管理员」= 「验证你手里那把密钥对应的账号，注册时被写成了 is_admin=1」。</span></div>" +

      '<div class="grid-2">' +
      '<div class="card"><div class="card__head"><span class="card__title">登录链路</span><span class="card__meta">每次请求都走一遍</span></div>' +
      '<div class="card__body"><div class="chain">' +
      chainStep(1, "粘贴账号密钥", "浏览器里派生，密钥本身<strong>从不发给服务端</strong>。它在你机器上解出 accountId 与 accountKey。", "opennote-key-v1.…") +
      chainStep(2, "HKDF-SHA256 派生 authToken", 'salt = accountId 的 16 个字节，info = <code>opennote/v1/auth</code>。与客户端逐参数一致（有四端比对用例盯着）。', "authToken = HKDF(accountKey, …)") +
      chainStep(3, "服务端只存它的哈希", "库里 <code>auth_hash = sha256(authToken)</code>。反推不出令牌，所以不需要 Argon2id 这类慢 KDF。", "sha256(authToken) → 64 位十六进制") +
      chainStep(4, "唯一索引查表", "命中唯一索引 → 拿到那一行。没命中 401；<code>status != active</code> 403。", "SELECT … FROM accounts WHERE auth_hash = ?") +
      chainStep(5, "读 is_admin", "这一列是<strong>布尔事实</strong>，不是角色字符串，也不看任何请求体里的字段。", "row.is_admin === 1", isAdmin ? "ok" : "muted") +
      "</div></div>" +
      '<div class="card__foot">控制台把 authToken 塞进 <code>HttpOnly; SameSite=Lax</code> cookie，页面 JS 之后<strong>再也读不到它</strong>（XSS 也偷不走）。</div></div>' +

      '<div class="stack-14">' +
      '<div class="card"><div class="card__head"><span class="card__title">is_admin 从哪来</span></div><div class="card__body">' +
      '<p class="note u-mb-10">只有两条路能改它，都在 CLI 里：</p>' +
      '<div class="chain chain--flush">' +
      chainStep(1, "运维在服务器上跑 CLI", "直连数据库，不走 HTTP、不需要任何已有凭据。", "node dist/cli.js bootstrap-admin") +
      chainStep(2, "CLI 打印一次性引导码", "只写一行 <code>bootstrap_codes</code>（哈希 + 过期）。明文只在 stdout 出现一次，<strong>不写日志、不落盘</strong>。默认 30 分钟过期。", "boot_…（48 位十六进制）") +
      chainStep(3, "在客户端注册时带上它", "注册成功后 <code>is_admin = 1</code>。用邀请码（<code>inv_</code>）注册的账号一律 <code>is_admin = 0</code>。", "isAdmin = Boolean(input.bootstrapCode)") +
      "</div>" +
      '<div class="banner u-mt-12">' + ICON("info", 14) + "<span>已有账号要接管，用 <code>grant-admin</code> / <code>revoke-admin</code>。控制台里<strong>没有、也不该有</strong>「设为管理员」按钮 —— 那等于让任何一个被盗的管理员账号能无限造管理员。</span></div>" +
      "</div></div>" +

      '<div class="card"><div class="card__head"><span class="card__title">两条独立闸门</span><span class="card__meta">缺一不可</span></div>' +
      '<div class="card__body card__body--flush"><div class="drawer__list drawer__list--flush">' +
      '<div class="drawer__check"><span class="drawer__check-icon">' + ICON("check", 10) + '</span><span class="drawer__check-text"><strong>页面不渲染</strong><br><span class="tiny muted">管理页的导航项与 DOM 根本不生成</span></span><span class="drawer__check-state">已实现</span></div>' +
      '<div class="drawer__check"><span class="drawer__check-icon">' + ICON("check", 10) + '</span><span class="drawer__check-text"><strong>API 403</strong><br><span class="tiny muted">拒绝发生在<strong>读取之前</strong>，不泄露账号信息</span></span><span class="drawer__check-state">已实现</span></div>' +
      '<div class="drawer__check"><span class="drawer__check-icon">' + ICON("check", 10) + '</span><span class="drawer__check-text"><strong>二次验证</strong><br><span class="tiny muted">危险动作要求重新粘贴密钥，5 分钟有效</span></span><span class="drawer__check-state">已实现</span></div>' +
      "</div></div>" +
      '<div class="card__foot">把导航项用 CSS 藏起来不算「不渲染」—— 开发者工具一改就出来。必须先不生成。</div></div>' +

      '<div class="card"><div class="card__head"><span class="card__title">密钥丢了怎么办</span></div><div class="card__body"><div class="drawer__list drawer__list--flush">' +
      '<div class="drawer__check"><span class="drawer__check-icon is-missing">' + ICON("alert", 10) + '</span><span class="drawer__check-text"><strong>没有「找回密码」</strong> —— 没有密码，也没有服务端可补发的密钥</span><span class="drawer__check-state">设计如此</span></div>' +
      '<div class="drawer__check"><span class="drawer__check-icon">' + ICON("check", 10) + '</span><span class="drawer__check-text">还能从<strong>已有密钥的设备</strong>导出</span><span class="drawer__check-state">可行</span></div>' +
      '<div class="drawer__check"><span class="drawer__check-icon">' + ICON("check", 10) + '</span><span class="drawer__check-text">全丢了：CLI 重新打引导码 → 注册<strong>新账号</strong></span><span class="drawer__check-state">应急</span></div>' +
      '<div class="drawer__check"><span class="drawer__check-icon is-missing">' + ICON("ban", 10) + '</span><span class="drawer__check-text">管理员<strong>也无法</strong>重置任何人的密钥</span><span class="drawer__check-state">红线 3</span></div>' +
      "</div></div></div>" +
      "</div></div>" +
      "</div>"
    );
  }


  /* ------------------------------------------------------------ 导出 */

  window.VIEWS = {
    renderOverview,
    renderData,
    renderAccounts,
    renderDevices,
    renderIssues,
    renderLogs,
    renderServer,
    renderIdentity,
    pageHead,
    chip,
    meter,
    emptyState,
    skeletonCards,
    skeletonTable,
    errorPanel,
    fmtDateTime,
    fmtRelative,
    fmtBytes,
    fmtNum,
    fmtDuration,
    fmtDay,
    shortId,
    platformLabel,
    actionLabel,
    esc,
  };
})();
