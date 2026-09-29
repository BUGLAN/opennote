/**
 * 设置面板「导入与接口」用的本地桥 IPC 客户端。
 *
 * 硬约束（契约 §5.2 / §11，Lead 冻结）：
 *   - **只讲 IPC**：绝不在页面里 `fetch http://127.0.0.1:…`，因此不需要放开
 *     CSP `connect-src 'self' file:`。桥状态一律经 `opennote:bridge:status` 读。
 *   - preload 方法名与 arity 冻结（0/1 参形态见下），这里逐字按冻结形态调用，
 *     不做「多传一个参数也无所谓」的兼容。
 *   - 类型只用 `src/desktop/bridge.ts` 里那一份，不定义第二套。
 */

import { desktopBridge, type BridgeStatus, type BridgeState, type OpennoteBridge } from "../desktop/bridge";

/** `opennote:bridge:*` 控制面。 */
type BridgeApi = OpennoteBridge["bridge"];

/**
 * `bridge.status()` 的渲染层视图。
 * **字段定义以 `src/desktop/bridge.ts` 的 `BridgeStatus` 为唯一来源**（契约字段与
 * 6 个可选实现细节字段都在那边）；这里只补桥另外给、但契约不要求的展示串。
 */
export interface BridgeStatusView extends BridgeStatus {
  /** 状态中文（桥给的，缺失时用 `BRIDGE_STATE_LABELS` 兜底）。 */
  stateLabel?: string;
  /** 未运行时的逐字占位「—」。 */
  addressText?: string;
  /** 是否正在监听（等价于 `state === "running"`）。 */
  running?: boolean;
  /**
   * ㊲：本会话桥的内存里是否还持有令牌明文（= 能不能反复复制）。
   * `undefined` 一律按 `false` 处理 —— 主进程没给这个字段时面板照「不可见」降级，
   * 绝不假装按钮可用。注意 `false` **不等于令牌失效**：令牌仍长期有效。
   */
  tokenVisible?: boolean;
}

/**
 * ㊲（00 号 §6.15）本会话的令牌明文缓存。
 *
 * 令牌是长期有效的**唯一凭据**，用户拿到它的唯一途径就是明文。只允许「显示一次」会把
 * 「长期有效」变成自相矛盾的承诺（误关一次面板就只能重新生成，而重新生成会让此前
 * 所有已配置的客户端失效）。所以明文在**本会话**里留在这个模块变量中：
 * 渲染进程内存，不写 localStorage、不落盘；面板重新挂载后仍能复制同一串。
 *
 * 应用重启后这里与桥的内存同时清空 —— 面板据 `status().tokenVisible` 如实降级。
 */
let sessionToken: string | null = null;

/** 记住 / 清除本会话明文（只在 `newToken` 成功后写入，或明确丢弃时传 `null`）。 */
export function rememberBridgeToken(token: string | null): void {
  sessionToken = typeof token === "string" && token !== "" ? token : null;
}

/** 本会话是否还拿得到明文（与 `status().tokenVisible` 一起决定按钮状态）。 */
export function peekBridgeToken(): string | null {
  return sessionToken;
}

/** 6 个状态的中文（逐字，契约 §5.2.2）。 */
export const BRIDGE_STATE_LABELS: Record<BridgeState, string> = {
  disabled: "未开启",
  stopped: "已停止",
  starting: "正在启动",
  running: "运行中",
  "port-busy": "端口被占用",
  failed: "启动失败",
};

/** 端口唯一事实：8787–8796（默认起始端口 + 10 个连续端口）。 */
export const BRIDGE_DEFAULT_PORT = 8787;
export const BRIDGE_PORT_MIN = 1024;
export const BRIDGE_PORT_MAX = 65535;
/** 地址行在未运行时的占位（UI-04/R3b 逐字「—」）。 */
export const BRIDGE_ADDRESS_PLACEHOLDER = "—";

/** `opn_••••••••••••1234`：只显示后 4 位，应用自己也拿不到明文。 */
export function maskToken(last4: string | null | undefined): string {
  if (!last4) return "opn_••••••••••••••••";
  return `opn_••••••••••••${last4}`;
}

/** 端口必须是整数且落在 1024–65535（0 不用、也不能是系统保留段）。 */
export function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= BRIDGE_PORT_MIN && value <= BRIDGE_PORT_MAX;
}

/** 解析端口输入框；非法返回 null（对应 UI 的「端口要在 1024 到 65535 之间。」）。 */
export function parsePort(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return isValidPort(value) ? value : null;
}

/** 桥状态的中文标签（优先用桥自己给的，缺失时用冻结表）。 */
export function stateLabelOf(status: BridgeStatusView | null): string {
  if (!status) return BRIDGE_STATE_LABELS.disabled;
  return status.stateLabel || BRIDGE_STATE_LABELS[status.state] || BRIDGE_STATE_LABELS.disabled;
}

/** 拿 `window.opennote.bridge`；非桌面版或 preload 还没接上时返回 null。 */
export function bridgeApi(): BridgeApi | null {
  const desktop = desktopBridge();
  if (!desktop) return null;
  const api = desktop.bridge as BridgeApi | undefined;
  if (!api || typeof api.status !== "function") return null;
  if (typeof api.start !== "function" || typeof api.stop !== "function") return null;
  return api;
}

/** 桌面版是否具备桥控制面（决定面板是「可控」还是 S9 禁用态）。 */
export function bridgeAvailable(): boolean {
  return bridgeApi() !== null;
}

async function call<T>(fn: (api: BridgeApi) => Promise<T>, fallback: T): Promise<T> {
  const api = bridgeApi();
  if (!api) return fallback;
  try {
    return await fn(api);
  } catch {
    return fallback;
  }
}

/** 读桥状态。返回 null = 非桌面版 / preload 未就绪 / IPC 失败。 */
export function readBridgeStatus(): Promise<BridgeStatusView | null> {
  return call<BridgeStatusView | null>((api) => api.status() as Promise<BridgeStatusView>, null);
}

/** 开始监听（幂等）。`port` 为「起始端口」，桥从它开始顺序尝试 10 个连续端口。 */
export function startBridge(port?: number): Promise<BridgeStatusView | null> {
  // preload 的冻结 arity 是 1（`start({port?})`），所以永远只传一个对象参数。
  return call<BridgeStatusView | null>(
    (api) => api.start(isValidPort(port) ? { port } : {}) as Promise<BridgeStatusView>,
    null,
  );
}

/** 关闭监听：桥侧 `server.close()` + 断开全部 keep-alive 连接。 */
export function stopBridge(): Promise<BridgeStatusView | null> {
  return call<BridgeStatusView | null>((api) => api.stop() as Promise<BridgeStatusView>, null);
}

/** 生成 / 轮换访问令牌。**唯一一次**返回明文，服务端只存 sha256。 */
export function regenerateBridgeToken(origin?: string): Promise<{ token: string; last4: string } | null> {
  // 同样按冻结 arity 1（`newToken({origin?})`）调用。
  return call<{ token: string; last4: string } | null>(
    (api) => api.newToken(origin ? { origin } : {}) as Promise<{ token: string; last4: string }>,
    null,
  );
}

/**
 * 移除一个历史遗留来源。
 *
 * 0.3.1（㉞）起来源**按类型**判断（扩展 / 本机回环 / `file://`），这份列表不再参与放行，
 * 只用于清理 0.3.1 之前 `bridge.json` 里剩下的条目 —— 所以入口还在，但没有「授权」语义了。
 */
export function removeBridgeOrigin(origin: string): Promise<BridgeStatusView | null> {
  return call<BridgeStatusView | null>((api) => api.removeOrigin({ origin }) as Promise<BridgeStatusView>, null);
}

/**
 * ㊲③ 只读明文频道（Lead 冻结）：`bridge.token()`，arity 0，返回 `{ token: string | null }`。
 *
 * 用最小声明而不是写死在 `OpennoteBridge` 里，是为了让面板在「preload 还没接上这条频道」
 * 的构建里也能编译、也能跑 —— 读不到就按「不可见」如实降级，而不是整个文件编译不过。
 * 频道由 Lead 在 preload/main 侧接线，面板只消费。
 */
interface TokenChannelApi {
  token?(): Promise<{ token: string | null }>;
}

/**
 * ㊲③ 向主进程**只读**要回本会话的令牌明文；拿不到返回 `null`。
 *
 * **绝不轮换令牌** —— 这是它与 `regenerateBridgeToken()`（重新生成、旧令牌立刻作废）
 * 的本质区别。用途：整窗重载后主进程还持有明文、而界面手里没有，
 * 于是「复制令牌」会变成一个点不动的按钮（假开关 / 死按钮）。
 *
 * 返回 `null` 的两种情况都按同一套降级处理：本会话确实不再持有明文（应用重启过），
 * 或 preload 还没接上这条频道。
 */
export async function fetchSessionToken(): Promise<string | null> {
  const api = bridgeApi();
  if (!api) return null;
  const read = (api as BridgeApi & TokenChannelApi).token;
  if (typeof read !== "function") return null;
  try {
    const res = await read.call(api);
    const token = res && typeof res === "object" ? res.token : null;
    return typeof token === "string" && token !== "" ? token : null;
  } catch {
    return null;
  }
}

/** 用系统文件管理器打开 bridge.log（未配置日志目录时为 no-op）。 */
export function openBridgeLog(): Promise<boolean> {
  return call<boolean>(async (api) => {
    await api.openLog();
    return true;
  }, false);
}

/**
 * 复制到剪贴板。桌面版是 `file://`（安全上下文），`navigator.clipboard` 可用；
 * 老环境退回临时 textarea + execCommand，失败返回 false（UI 显示「复制失败」）。
 */
export async function copyText(text: string): Promise<boolean> {
  if (text === "") return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 退回下面那条路径 */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}