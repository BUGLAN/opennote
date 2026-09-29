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

/** 生成 6 位配对码（120 秒、一次性、与端口绑定）。 */
export function createPairCode(): Promise<{ code: string; expiresAt: number } | null> {
  return call<{ code: string; expiresAt: number } | null>((api) => api.newPairCode(), null);
}

/** 移除一个受信任来源。 */
export function removeBridgeOrigin(origin: string): Promise<BridgeStatusView | null> {
  return call<BridgeStatusView | null>((api) => api.removeOrigin({ origin }) as Promise<BridgeStatusView>, null);
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

/** 「剩余 118 秒」；已过期返回 null。 */
export function pairCodeSecondsLeft(expiresAt: number, now: number): number | null {
  const left = Math.ceil((expiresAt - now) / 1000);
  return left > 0 ? left : null;
}

/**
 * 把 `lastPairing.at` 归一成毫秒数。类型允许 `string | number`（ISO 串或毫秒），
 * 所以面板做时间比较前必须过这一道——直接 `Number('2026-…')` 会得到 `NaN`，
 * 会让「配对成功」永远检测不到。
 */
export function pairingStampMs(at: string | number | null | undefined): number {
  if (typeof at === "number" && Number.isFinite(at)) return at;
  if (typeof at === "string" && at !== "") {
    const parsed = Date.parse(at);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}
