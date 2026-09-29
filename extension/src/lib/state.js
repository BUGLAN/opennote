/**
 * 连接状态机与视图文案（纯函数，可在 node 里断言）。
 *
 * 6 类必须能互相区分的状态（task-5 硬项 + 03 §UI-01）：
 *   已连接 / Opennote 未运行 / 未开启导入接口 / 端口或 token 不匹配 / 文件夹未授权 / 离线
 * 另有 `checking`（正在连接本地接口…）与 `restricted-page`（S5）。
 *
 * 判定纪律（Lead 裁定 + 02 §5.2.7 / §6.2）：
 *   1. `navigator.onLine === false` → 一律按离线处理，**绝不允许**显示成「已连接」；
 *   2. 有端口在监听但桥自己回 `IMP-4006` → `Opennote 未运行`（唯一「桥在跑、窗口不在场」的硬证据）；
 *   3. 没有任何端口在监听 → `本地接口未开启`（IMP-1001）；
 *   4. 有端口在监听但不是我们的桥 / 桥报 IMP-1003 → `端口被占用`；
 *   5. 403 `IMP-3001`（来源不是扩展/本机程序，㉞ 的判据改为按类型）→ `未配置令牌`，**绝不显示为已连接**；
 *   6. 401 `IMP-2002` → `未连接`（令牌错/失效）；401 `IMP-2001` → `未配置令牌`。
 *
 * 所有芯片文案逐字来自 03 §UI-01 的「中文文案（逐字）」表与
 * docs/import/mockups/01-extension-popup.html，不新增任何说法。
 */

import { userMessage } from "./errors.js";

/** 内部状态 id（同时作为 popup 根节点的 `data-state`，便于人工/自动断言）。 */
export const STATE = Object.freeze({
  CHECKING: "checking",
  CONNECTED: "connected",
  INTERFACE_OFF: "interface-off",
  NOT_RUNNING: "not-running",
  PORT_BUSY: "port-busy",
  NEEDS_PAIRING: "needs-pairing",
  TOKEN_INVALID: "token-invalid",
  DEVICE_OFFLINE: "device-offline",
  QUEUED_OFFLINE: "queued-offline",
  RESTRICTED_PAGE: "restricted-page",
  NO_WORKSPACE: "no-workspace",
  FOLDER_DENIED: "folder-denied",
  SUCCESS: "success",
  /** 交付回执 `status === "pending"`：应用侧「先进入收件箱」把它收进收件箱等人工确认（00 §6.14 ㉕）。 */
  INBOX_PENDING: "inbox-pending",
});

/** 芯片文案（逐字）。`is-on` / `is-busy` / `is-error` 对应 mockup 的三个修饰类。 */
export const CHIP = Object.freeze({
  [STATE.CHECKING]: { text: "正在连接本地接口…", cls: "is-busy" },
  [STATE.CONNECTED]: { text: "本地接口已开启", cls: "is-on" },
  [STATE.INTERFACE_OFF]: { text: "本地接口未开启", cls: "" },
  [STATE.NOT_RUNNING]: { text: "Opennote 未运行", cls: "is-error" },
  [STATE.PORT_BUSY]: { text: "端口被占用", cls: "is-error" },
  // ㉞ / 03 §UI-01 C07–C14：0.3.1 里「需要配对」改成「未配置令牌」（配对整体删除）
  [STATE.NEEDS_PAIRING]: { text: "未配置令牌", cls: "" },
  [STATE.TOKEN_INVALID]: { text: "未连接", cls: "is-error" },
  [STATE.DEVICE_OFFLINE]: { text: "未连接", cls: "is-error" },
  [STATE.NO_WORKSPACE]: { text: "本地接口已开启", cls: "is-on" },
  [STATE.FOLDER_DENIED]: { text: "本地接口已开启", cls: "is-on" },
});

/** S11 芯片：`离线，已暂存 {n} 条`。 */
export function queuedChip(pendingCount) {
  return { text: `离线，已暂存 ${Number(pendingCount) || 0} 条`, cls: "is-busy" };
}

export function chipFor(state, ctx = {}) {
  if (state === STATE.QUEUED_OFFLINE) return queuedChip(ctx.pendingCount);
  // 成功态、进收件箱、以及「已连接 + 落点错误」都保持真实连接态芯片。
  if (state === STATE.SUCCESS || state === STATE.INBOX_PENDING) return CHIP[STATE.CONNECTED];
  return CHIP[state] || CHIP[STATE.CHECKING];
}

/** 错误码 → 状态（提交失败后的落点，02 §6.2 的「客户端应如何反应」列）。 */
export function stateForCode(code) {
  switch (code) {
    case "IMP-1001":
    case "IMP-1004":
      return STATE.INTERFACE_OFF;
    case "IMP-4006":
      return STATE.NOT_RUNNING;
    case "IMP-1003":
      return STATE.PORT_BUSY;
    case "IMP-2001":
    case "IMP-3001":
      return STATE.NEEDS_PAIRING;
    case "IMP-2002":
    case "IMP-2003":
      return STATE.TOKEN_INVALID;
    case "IMP-4007":
      return STATE.NO_WORKSPACE;
    case "IMP-4008":
    case "IMP-4009":
      return STATE.FOLDER_DENIED;
    default:
      return STATE.CONNECTED;
  }
}

/**
 * 主判定：把一次探测结果 + 本地证据收敛成一个状态 id。
 * @param {object} input
 * @param {object} input.probe `discover()` 的返回值（可为 null = 还没探测）
 * @param {boolean} input.online `navigator.onLine`
 * @param {string|null} input.token 本地缓存的令牌
 * @param {number} input.pendingCount 离线暂存条数
 * @param {string|null} input.authCode 令牌校验（GET /v1/workspace）拿到的鉴权错误码
 * @param {number|null} input.lastOkPort 上次成功的端口（证据，不参与硬判定）
 */
export function decideState(input) {
  const {
    probe = null,
    online = true,
    token = null,
    pendingCount = 0,
    authCode = null,
  } = input || {};

  // 1. 设备离线：按 Lead 裁定一律不显示「已连接」。
  if (online === false) {
    return pendingCount > 0 ? STATE.QUEUED_OFFLINE : STATE.DEVICE_OFFLINE;
  }
  if (!probe) return STATE.CHECKING;

  // 2. 桥在跑但窗口不在场（硬证据）。
  if (probe.noWindow) return STATE.NOT_RUNNING;

  // 3. 命中桥。
  if (probe.hit) {
    if (authCode === "IMP-2001" || authCode === "IMP-3001") return STATE.NEEDS_PAIRING;
    if (authCode === "IMP-2002") return STATE.TOKEN_INVALID;
    if (!token) return STATE.NEEDS_PAIRING;
    return STATE.CONNECTED;
  }

  // 4. 来源不是扩展/本机程序（403 IMP-3001，㉞）：只能如实说「未配置令牌」，不能说已连接。
  if (probe.originRejected) return STATE.NEEDS_PAIRING;

  // 5. 桥自己报告端口全占。
  if (probe.portBusy) return STATE.PORT_BUSY;

  // 6. 有端口在监听但不是我们的桥（别的程序占着）。
  if (probe.sawListener) return STATE.PORT_BUSY;

  // 7. 没有任何端口在监听 → 本地接口未开启（IMP-1001）。
  return STATE.INTERFACE_OFF;
}

/**
 * 视图模型：把状态翻译成「芯片 + 正文块 + 动作」，文案全部逐字取自 03/mockup。
 * 返回结构刻意保持纯数据，popup 只负责贴 DOM，node 测试可以直接断言字符串。
 */
export function planFor(state, ctx = {}) {
  const { pendingCount = 0, folderLabel = "根目录", noteTitle = "", code = null, serverMessage = null } = ctx;
  const chip = chipFor(state, { pendingCount });
  const plan = {
    state,
    chip,
    block: null,
    primary: { label: "剪藏到 Opennote", disabled: false, busy: false },
    actions: [],
    pairingInput: false,
    preview: true,
    rows: true,
    segments: true,
  };

  switch (state) {
    case STATE.CHECKING:
      plan.preview = false;
      plan.primary = { label: "正在读取页面…", disabled: true, busy: false };
      plan.skeleton = true;
      break;

    case STATE.CONNECTED:
    case STATE.SUCCESS:
      break;

    case STATE.INTERFACE_OFF:
      plan.block = {
        kind: "error",
        message: userMessage("IMP-1001", null),
        next: "已保留你填的标题与标签。",
        code: "IMP-1001",
      };
      plan.actions = [
        { id: "retry", label: "重试", primary: true },
        { id: "open-settings", label: "打开 Opennote 设置", primary: false },
      ];
      plan.primary = { label: "剪藏到 Opennote", disabled: true, busy: false };
      break;

    case STATE.NOT_RUNNING:
      plan.block = {
        kind: "error",
        message: userMessage("IMP-4006", serverMessage),
        next: "连接被拒说明本机没有在监听，不是令牌问题。",
        code: "IMP-4006",
      };
      plan.actions = [
        { id: "retry", label: "重试", primary: true },
        { id: "queue", label: "先暂存这页", primary: false },
      ];
      plan.primary = { label: "剪藏到 Opennote", disabled: true, busy: false };
      break;

    case STATE.PORT_BUSY:
      plan.block = {
        kind: "error",
        message: userMessage("IMP-1003", serverMessage),
        next: null,
        code: "IMP-1003",
      };
      plan.actions = [
        { id: "retry", label: "重试", primary: true },
        { id: "open-settings", label: "打开 Opennote 设置", primary: false },
      ];
      plan.primary = { label: "剪藏到 Opennote", disabled: true, busy: false };
      break;

    case STATE.NEEDS_PAIRING:
      // ㉞：配对这个概念没了。这个状态现在只表示「这台客户端还没有配置访问令牌」——
      // 用户要做的动作是**把 Opennote 里的长期令牌粘进来**，不是去配一个 6 位码。
      plan.block = {
        kind: "token",
        message: userMessage("IMP-2001", serverMessage),
        next: null,
        code: "IMP-2001",
      };
      plan.tokenInput = true;
      plan.actions = [{ id: "open-settings", label: "打开 Opennote 设置", primary: false }];
      plan.primary = { label: "剪藏到 Opennote", disabled: true, busy: false };
      break;

    case STATE.TOKEN_INVALID:
      plan.block = {
        kind: "token",
        message: userMessage("IMP-2002", serverMessage),
        next: null,
        code: "IMP-2002",
      };
      plan.tokenInput = true;
      plan.actions = [{ id: "open-settings", label: "打开 Opennote 设置", primary: false }];
      plan.primary = { label: "剪藏到 Opennote", disabled: true, busy: false };
      break;

    case STATE.DEVICE_OFFLINE:
      plan.block = {
        kind: "error",
        message: userMessage("IMP-1001", null),
        next: "已保留你填的标题与标签。",
        code: "IMP-1001",
      };
      plan.actions = [
        { id: "retry", label: "重试", primary: true },
        { id: "queue", label: "先暂存这页", primary: false },
      ];
      plan.primary = { label: "暂存在插件里", disabled: false, busy: false };
      break;

    case STATE.QUEUED_OFFLINE:
      plan.block = {
        kind: "queued",
        message: "Opennote 没有在运行，内容已暂存在插件里，打开 Opennote 后会自动补投。",
        next: "打开 Opennote 后会自动补投。",
        code: null,
      };
      plan.primary = { label: "暂存在插件里", disabled: false, busy: false };
      break;

    case STATE.NO_WORKSPACE:
      // 芯片必须反映真实连接态（已连接），落点类问题用独立错误块。
      plan.block = {
        kind: "error",
        message: userMessage("IMP-4007", serverMessage),
        next: null,
        code: "IMP-4007",
      };
      plan.actions = [
        { id: "retry", label: "重试", primary: true },
        { id: "open-settings", label: "打开 Opennote 设置", primary: false },
      ];
      plan.primary = { label: "剪藏到 Opennote", disabled: true, busy: false };
      break;

    case STATE.FOLDER_DENIED:
      plan.block = {
        kind: "error",
        message: userMessage(code === "IMP-4008" ? "IMP-4008" : "IMP-4009", serverMessage),
        next: null,
        code: code === "IMP-4008" ? "IMP-4008" : "IMP-4009",
      };
      plan.actions = [
        { id: "retry", label: "重试", primary: true },
        { id: "open-settings", label: "打开 Opennote 设置", primary: false },
      ];
      plan.primary = { label: "剪藏到 Opennote", disabled: true, busy: false };
      break;

    case STATE.RESTRICTED_PAGE:
      plan.segments = false;
      plan.preview = false;
      plan.rows = false;
      plan.empty = {
        title: "这个页面不允许插件读取内容。",
        text: "换个普通网页再试。",
      };
      plan.actions = [
        { id: "open-options", label: "插件设置", primary: false },
        { id: "open-opennote", label: "打开 Opennote", primary: false },
      ];
      plan.primary = null;
      break;

    default:
      break;
  }

  // 成功态由 popup 单独填充（`已剪藏到「{目录}」。` + 次行最终笔记标题）。
  if (state === STATE.SUCCESS) {
    plan.ok = {
      message: `已剪藏到「${folderLabel}」。`,
      detail: noteTitle ? `${noteTitle}.md` : null,
    };
    plan.preview = false;
    plan.rows = false;
    plan.segments = false;
    plan.primary = null;
    plan.actions = [
      { id: "open-note", label: "打开这篇笔记", primary: false },
      { id: "again", label: "再剪一段", primary: false },
    ];
  }

  // 进收件箱（00 §6.14 ㉘；逐字见 03 §UI-01 C60 / S23）：应用侧「先进入收件箱」命中时回执是 pending
  // —— 这不是失败，也不是「已经写进笔记」；文案逐字冻结为 `已进入收件箱等待确认：{标题}。`
  // 次行是 `在 Opennote 的「导入收件箱」里确认。`；**不提供**「打开收件箱」按钮（本轮没有深链）。
  if (state === STATE.INBOX_PENDING) {
    plan.ok = {
      message: `已进入收件箱等待确认：${noteTitle || "未命名笔记"}。`,
      detail: "在 Opennote 的「导入收件箱」里确认。",
    };
    plan.preview = false;
    plan.rows = false;
    plan.segments = false;
    plan.primary = null;
    plan.actions = [
      { id: "open-opennote", label: "打开 Opennote", primary: false },
      { id: "again", label: "再剪一段", primary: false },
    ];
  }

  // C 三区（00 §6.14 ㉘：「正文 / 高亮 / 属性」）——哪些区可用由状态决定，
  // 例如受限页面与成功态整块隐藏。
  plan.templatePicker = plan.segments;
  plan.highlightsAvailable = plan.segments;
  plan.sourceSwitch = plan.segments;
  plan.propertyPanel = plan.segments;

  return plan;
}

/**
 * 「提交中」视图（S7）：主按钮 `正在剪藏…` + `aria-busy="true"`，
 * L3/L4 降到 60% 不透明度并停止响应。
 */
export function busyPlan(baseState, ctx = {}) {
  const plan = planFor(baseState, ctx);
  plan.busy = true;
  plan.primary = { label: "正在剪藏…", disabled: true, busy: true };
  plan.actions = [];
  return plan;
}
