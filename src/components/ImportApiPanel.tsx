/**
 * UI-04「设置 · 文件 → 导入与接口」。
 *
 * 逐字文案基准：`docs/import/03-UI设计规范-剪藏与导入.md`（UI-04 与 §6.1 文案表）
 * 与 `docs/import/mockups/03-settings-import-api.html`。中文全角，无 emoji。
 *
 * 硬约束：
 *   - 桥状态**只经 IPC 读**（`lib/importBridge.ts`），页面绝不 `fetch 127.0.0.1`，
 *     所以 CSP `connect-src 'self' file:` 不需要放宽。
 *   - 6 个状态中文逐字；地址占位逐字 `—`。
 *   - 冲突落法只渲染 `new`/`append`/`skip`/`inbox`，**没有 `overwrite`**。
 *   - 令牌明文只在这一个会话里出现一次（`freshToken`），此后只能重新生成。
 *   - 错误句用 `--accent`，禁用 `--ink-3`（对比度）。
 *   - 不新增 CSS：只用既有类名 + 既有 token 的内联样式。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { desktopBridge } from "../desktop/bridge";
import type { BridgeState, ImportRecord } from "../desktop/bridge";
import type { ImportConflictPreference } from "../data/types";
import { askConfirm } from "../lib/dialogs";
import {
  BRIDGE_ADDRESS_PLACEHOLDER,
  BRIDGE_DEFAULT_PORT,
  BRIDGE_PORT_COUNT,
  BRIDGE_PORT_MAX,
  BRIDGE_PORT_MIN,
  bridgeAvailable,
  copyText,
  fetchSessionToken,
  maskToken,
  openBridgeLog,
  parsePort,
  peekBridgeToken,
  readBridgeStatus,
  regenerateBridgeToken,
  rememberBridgeToken,
  removeBridgeOrigin,
  startBridge,
  stateLabelOf,
  stopBridge,
  type BridgeStatusView,
} from "../lib/importBridge";
import { cn, formatRelativeTime } from "../lib/utils";
import { Icon } from "./Icons";

export interface ImportApiPanelProps {
  /** 桌面版（Electron）环境。false → S9 禁用态。 */
  desktop: boolean;
  /** R1 导入方式。不给就按 ㉕ 的应用侧默认值 `先进入收件箱` 只读展示。 */
  importConflict?: ImportConflictPreference;
  onImportConflict?(value: ImportConflictPreference): void;
  /** R2 入库后提示。 */
  importNotify?: boolean;
  onImportNotify?(value: boolean): void;
  /**
   * ③ 剪藏配图：把正文里的**网络图片**下载到笔记本本地（默认开）。
   *
   * 为什么需要这个开关：桌面 CSP 是 `img-src 'self' file: data: blob:`，远程配图在界面里
   * 加载不了；而扩展侧 host_permissions 只有 127.0.0.1 的十条，跨站图拿不到字节 ——
   * 字节由主进程代下（`net.downloadImages`）。关掉后正文里保留原始网址。
   */
  downloadImages?: boolean;
  onDownloadImages?(value: boolean): void;
  /** R8 诊断日志开关（主进程侧经 `isLogEnabled()` 生效）。 */
  bridgeLog?: boolean;
  onBridgeLog?(value: boolean): void;
  /** 「打开收件箱」入口；P1 的收件箱面板挂上后再传。 */
  onOpenInbox?(): void;
}

/* ================================ 样式 ================================= */

const ROW: CSSProperties = { display: "flex", alignItems: "center", gap: "var(--s2)", flexWrap: "wrap" };
const HINT: CSSProperties = { margin: "6px 0 0", fontSize: "var(--fs-xs)", color: "var(--ink-3)", lineHeight: 1.6 };
const ERROR: CSSProperties = { margin: "6px 0 0", fontSize: "var(--fs-sm)", color: "var(--accent)" };
/** 兼容性提示：不是错误（桥工作正常），但用户必须知道后果 —— 所以用强调色 + 小字号。 */
const NOTICE: CSSProperties = { margin: "6px 0 0", fontSize: "var(--fs-xs)", color: "var(--accent)", lineHeight: 1.6 };
const MONO: CSSProperties = { fontFamily: "var(--font-mono)" };
const VALUE_BOX: CSSProperties = {
  flex: "1 1 200px",
  minWidth: 180,
  display: "flex",
  alignItems: "center",
  padding: "5px 10px",
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-sm)",
  background: "var(--code-bg)",
  fontSize: "var(--fs-sm)",
  overflowWrap: "anywhere",
  ...MONO,
};
const CHIP: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  height: 22,
  padding: "0 9px",
  borderRadius: 999,
  fontSize: "var(--fs-xs)",
  border: "1px solid transparent",
  whiteSpace: "nowrap",
};

/** 状态芯片配色：运行中=实心强调色点 + --accent-soft 底；关闭=空心 --ink-3 点；
 *  启动中=--ink-3 点 + pulse；错误=强调色点 + --accent-line 描边。
 *  （不靠红绿灯三色，S1 的说明句已逐字要求。） */
function chipVisual(state: BridgeState | null): { box: CSSProperties; dot: CSSProperties } {
  const dot: CSSProperties = { width: 7, height: 7, borderRadius: 999, flex: "none", background: "var(--accent)" };
  switch (state) {
    case "running":
      return { box: { ...CHIP, background: "var(--accent-soft)", color: "var(--accent)" }, dot: { ...dot } };
    case "starting":
      return {
        box: { ...CHIP, color: "var(--ink-3)", borderColor: "var(--rule)" },
        dot: { ...dot, background: "var(--ink-3)", animation: "pulse 1.8s var(--ease) infinite" },
      };
    case "port-busy":
    case "failed":
      return {
        box: { ...CHIP, color: "var(--accent)", borderColor: "var(--accent-line)" },
        dot: { ...dot },
      };
    default:
      return {
        box: { ...CHIP, color: "var(--ink-3)", borderColor: "var(--rule)" },
        dot: { ...dot, background: "transparent", border: "1.5px solid var(--ink-3)" },
      };
  }
}

/** 状态芯片：只出现契约里那 6 个中文，读取过程中不猜（用灰字「读取中…」占位）。 */
function StatusChip({ state }: { state: BridgeState | null }) {
  if (!state) return <span style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)" }}>读取中…</span>;
  const visual = chipVisual(state);
  return (
    <span role="status" aria-live="polite" style={visual.box}>
      <i style={visual.dot} />
      {stateLabelOf({ state } as BridgeStatusView)}
    </span>
  );
}

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="setting">
      <div className="setting__label">
        {label}
        {hint ? <small>{hint}</small> : null}
      </div>
      <div className="setting__control">{children}</div>
    </div>
  );
}

/* =============================== 文案 ================================= */

/**
 * R1 的四个选项名 = `03` 号 UI-04 逐字（`R1 选项` 行）。
 * ㉕ 之后「（推荐）」在**收件箱**上：0.3.0 的 `DEFAULT_UI.importConflict` 已是 `"inbox"`，
 * 标签继续把 `new` 叫「推荐」会让面板同时出现两个互相矛盾的推荐。
 * 改这里必须同步 `03` 号——`scripts/bridge-smoke.cjs` 有一条交叉断言钉住这层咬合。
 */
const CONFLICT_LABELS: Record<ImportConflictPreference, string> = {
  new: "直接入库",
  append: "追加到已有笔记",
  skip: "跳过重复内容",
  inbox: "先进入收件箱（推荐）",
};

/**
 * ㉕（00 号 §6.14）：0.3.0 起应用侧默认值 = `"inbox"`（收件箱为主入口）。
 * 面板缺省时必须按这个值高亮与解释，否则界面会显示一个**与真实行为不符**的选中项。
 */
const IMPORT_MODE_DEFAULT: ImportConflictPreference = "inbox";

const CONFLICT_NOTES: Record<ImportConflictPreference, string> = {
  new: "收到就写成 .md 文件，并在应用内提示，可以随时撤销。",
  append: "来源相同的已有笔记就追加到末尾，不新建文件。",
  skip: "来源已经导入过就跳过，不写入任何内容。",
  inbox: "外部导入先落到 .opennote/inbox/，由你在收件箱里逐条确认后再入库。",
};

/**
 * R1 的推荐说明（㉕）。四个选项名与逐选项说明句沿用 `03` 号 UI-04 的冻结文案，
 * 「推荐」二字已经由 `inbox` 的标签承担，所以这句**解释「推荐意味着什么」**，
 * 不再重复喊一次推荐，避免与标签叠字。
 */
const R1_RECOMMEND =
  "推荐：剪藏先暂存到收件箱，你确认之后才写进笔记本，避免外部工具直接改动笔记。";

const R3_HINT =
  "只监听本机 127.0.0.1，只提供导入，不提供读取和删除。任何网页都可能尝试访问本机端口，所以请勿在不可信的网页上暴露令牌。";

/**
 * R4 令牌区说明（0.3.1 ㉞㊱ + ㊲）。
 *
 * **只讲不随状态变化的事实**：令牌长期有效、只在本机使用、不会被上传。
 * 「现在能不能复制明文」是**随状态变化**的事实，只能由下面那一条真实状态句来说 ——
 * 2026-09 的用户实测缺陷就是这么来的：这块静态说明写着「明文在本会话内可以反复复制」，
 * 而同一屏的另一块写着「令牌已不可见」，**同一时刻两个相反的结论**。
 *
 * 同一族缺陷：`bridgeStatusPayload`（字段被逐字段重建时静默丢掉）、`getWorkspaceInfo`、
 * `isLogEnabled` —— 都是**同一个事实被复制成多处**，任何一处漂移都会让用户看到矛盾。
 * 所以这里的规矩是：**一个事实只有一个产地**。
 */
const R4_HINT =
  "令牌长期有效，只在你在 Opennote 里点「重新生成」时才失效。令牌只在本机使用，Opennote 不会把它上传到任何地方。";

/**
 * ㊴ 要求的**代价披露句**（逐字；Lead 已同步到 `02`/`03`）。
 *
 * 注意：这句在 ㊴ 之前写的是「任何能读到**剪贴板或扩展存储**的程序都能拿到这串令牌」——
 * 那时明文只在内存里，所以没提磁盘。㊴ 把明文**写进了 `bridge.json`**：暴露面**多了一个
 * 文件**，于是原句**变成了假话**（它会让用户以为明文不落盘）。改法按 Lead 的要求：
 *   ① 先说清**好处**（用户正是为「随时能复制」选的这个方案）→
 *   ② 明说**文件位置**（不含糊说「本机」）→
 *   ③ 把**新增的暴露面**（那个文件本身）说出来 →
 *   ④ 保留「拿到它不等于能读笔记」那一半，否则用户会高估风险。
 * **用户选了简单方案，不等于我们可以少说一句代价。**
 */
const TOKEN_COST_HINT =
  "在新客户端里粘贴一次即可，长期有效、不用再配对。令牌明文就保存在本机 Opennote 数据目录的 bridge.json 里，所以任何时候都能复制。任何能读到这个文件、剪贴板或扩展存储的程序，都能拿到这串令牌并获得导入能力；桥只提供导入，不提供读取和删除。";

/**
 * 没有数据目录时（`status.tokenPersisted === false`，只可能出现在纯内存的自测/宿主场景：
 * 生产里 `main.cjs` 一定给 `userData`）：**上面那句就不成立了** —— 明文没落盘，
 * 关掉应用令牌就没了，客户端还得重新配置。宁可换一句真话，也不让界面说谎。
 */
const TOKEN_NO_DISK_HINT =
  "本次运行没有可写的本机数据目录，令牌只留在内存里：关掉 Opennote 之后令牌就没了，客户端需要重新配置。任何能读到剪贴板或扩展存储的程序都能拿到这串令牌并获得导入能力；桥只提供导入，不提供读取和删除。";

/**
 * ㊴ 状态句 A（**有令牌、明文在盘上**）：用户要的就是「随时能复制」，所以就这么说，不绕弯。
 */
const R4_READY = "明文保存在本机，任何时候都能复制。";

/**
 * ㊴ 状态句 B（**还没有令牌**）：引导到那一个动作上。
 */
const R4_NO_TOKEN = "还没有访问令牌。点「重新生成」生成一个，再复制到客户端。";

/**
 * ㊴ 状态句 C（**只剩这一种「复制」拿不到明文的情况**）：`bridge.json` 是**旧版本**写的
 * （只有 `sha256` + `last4`，明文不可能凭空长出来），或外部塞了个哈希进来。
 *
 * ㊲ 时代有三态（重启过 / 界面没取到 / 桥还持有），㊴ 把前两种**删掉了**：明文落盘后重启
 * 不影响复制。保留这一态是因为它**仍然可达**，而且不写它就只能画一个点不动的复制按钮 ——
 * 那正是本项目一路在打的死按钮缺陷。它**不含**「已不可见」「本会话内」，讲的是原因与出路。
 */
const R4_LEGACY =
  "这个令牌是旧版本生成的，明文没有保存在本机。需要明文请点「重新生成」拿一串新的。";

const FIREWALL_NOTE = "首次开启时系统可能会弹出防火墙提示，允许本机访问即可。";

/** 开启确认必须包含的四点（`00` §6.8⑤ / `03` 文案表 R3 开启确认）。 */
function enableConfirmMessage(port: number): string {
  return [
    `① 开启后，本机上知道令牌的程序可以通过 http://127.0.0.1:${port} 往当前笔记本写入。`,
    "② 只监听本机回环，局域网里的其它设备无法访问。",
    "③ 网页未经允许无法调用。",
    "④ 但你在本机运行的其它程序只要拿到令牌，就能写入。",
  ].join("\n");
}

/* ============================== 面板 =================================== */

export function ImportApiPanel({
  desktop,
  importConflict,
  onImportConflict,
  importNotify,
  onImportNotify,
  downloadImages,
  onDownloadImages,
  bridgeLog,
  onBridgeLog,
  onOpenInbox,
}: ImportApiPanelProps) {
  const [status, setStatus] = useState<BridgeStatusView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [working, setWorking] = useState<null | "start" | "stop" | "token" | "log" | "port">(null);
  /**
   * ㊲：本次会话的令牌明文。面板重新挂载时用模块缓存恢复（应用重启则两边都空），
   * 所以「复制」按钮的可点性由 `copyable` 决定，而不是只由「这一帧刚生成过」决定。
   */
  const [freshToken, setFreshToken] = useState<string | null>(() => peekBridgeToken());
  const [copied, setCopied] = useState<null | "address" | "token">(null);
  const [portText, setPortText] = useState(String(BRIDGE_DEFAULT_PORT));
  const [errorText, setErrorText] = useState<string | null>(null);
  const [surface, setSurface] = useState<string | null>(null);
  const [recent, setRecent] = useState<ImportRecord[] | null>(null);
  const copyTimer = useRef<number | null>(null);

  const ipcReady = desktop && bridgeAvailable();

  const refresh = useCallback(async () => {
    const next = await readBridgeStatus();
    if (next) {
      setStatus(next);
      setPortText(String(next.portRange?.[0] ?? next.startPort ?? next.port ?? BRIDGE_DEFAULT_PORT));
    }
    setLoaded(true);
    return next;
  }, []);

  // 打开面板读一次；不做轮询（桥状态只在用户操作里变）。
  useEffect(() => {
    if (!ipcReady) {
      setLoaded(true);
      return;
    }
    let alive = true;
    void (async () => {
      const next = await refresh();
      /*
       * **自动恢复失败时也要把桥给的原因说出来。**
       *
       * 用户什么都没点（应用启动时按偏好自动恢复监听），此时整屏只有一个「启动失败」芯片，
       * `status.error` 里那句可执行的诊断被丢掉 —— 真实故障现场就是这么发生的：
       * 桥因为系统保留端口段（`EACCES`）起不来，而面板一声不吭，用户只能去猜。
       * 只在这两个失败态上补，且只在本来就没有更具体的话时才写。
       */
      if (next && (next.state === "failed" || next.state === "port-busy") && next.error) {
        setErrorText((current) => current ?? next.error ?? null);
      }
      // ㊴ 明文与哈希一起落在 userData/bridge.json 里，所以「复制」**任何时候**都该能取到明文；
      // 取不到只剩一种可能：bridge.json 是旧版本写的（只有哈希，没有明文）。
      // 桥说「明文在」时再试一次（IPC 刚就绪可能空响应一次），确实取不到就走旧令牌那句如实说明
      // —— 绝不留一个点了没反应的按钮。
      const attempts = next?.tokenVisible === true ? 2 : 1;
      for (let i = 0; i < attempts; i += 1) {
        const plain = await fetchSessionToken();
        if (!alive) return;
        if (plain) {
          rememberBridgeToken(plain);
          setFreshToken(plain);
          return;
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [ipcReady, refresh]);

  // 最近导入（P1 的 R6 只有这一行空态；接口还没接好就整块不渲染，不猜）。
  useEffect(() => {
    if (!ipcReady) return;
    const api = desktopBridge()?.import;
    if (!api || typeof api.recent !== "function") return;
    let alive = true;
    api
      .recent({ limit: 5 })
      .then((rows) => {
        if (alive) setRecent(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (alive) setRecent(null);
      });
    return () => {
      alive = false;
    };
  }, [ipcReady]);

  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);

  const state: BridgeState | null = status ? status.state : null;
  const running = status?.state === "running";
  const busy = working !== null;
  // R1 当前值：props 优先，缺省按 ㉕ 的应用侧默认值（收件箱），不得退回 `new`。
  const mode = importConflict ?? IMPORT_MODE_DEFAULT;
  /**
   * ㊲ 现在能不能复制明文：界面这一帧生成的（`freshToken`）优先，
   * 其次是本会话的模块缓存（面板重新挂载后仍拿得到同一串）。
   * 应用重启后两者都空 → 按钮必须禁用，并显示如实说明。
   */
  const copyable = freshToken ?? peekBridgeToken();
  const endpoint = running ? status?.endpoint || `http://127.0.0.1:${status?.port}` : BRIDGE_ADDRESS_PLACEHOLDER;
  // `portRange` 是闭区间元组 `[起, 止]`（与 bridge.cjs 的运行时形状逐字一致）。
  const rangeStart = status?.portRange?.[0] ?? status?.startPort ?? BRIDGE_DEFAULT_PORT;
  const rangeEnd = status?.portRange?.[1] ?? rangeStart + 9;
  /**
   * 冻结默认段的闭区间上界（8787–8796）。
   * 与 `rangeStart`/`rangeEnd` 是**两件事**：那两个跟随用户选的起始端口，这个是产品冻结的
   * 「旧客户端只认这一段」的范围 —— 桥绑到它外面时必须如实告诉用户后果（见下面的提示行）。
   */
  const defaultRangeEnd = BRIDGE_DEFAULT_PORT + BRIDGE_PORT_COUNT - 1;
  const outsideDefaultRange =
    running && typeof status?.port === "number" && (status.port < BRIDGE_DEFAULT_PORT || status.port > defaultRangeEnd);

  const flashCopied = useCallback((which: "address" | "token") => {
    setCopied(which);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(null), 1600);
  }, []);

  const doStart = useCallback(
    async (port?: number) => {
      setWorking("start");
      setErrorText(null);
      setSurface(null);
      try {
        const next = await startBridge(port);
        if (!next) {
          setErrorText("本地接口启动失败，请重试。");
          return false;
        }
        setStatus(next);
        setPortText(String(next.portRange?.[0] ?? next.startPort ?? port ?? BRIDGE_DEFAULT_PORT));
        if (next.state === "running") {
          // ㊴：开启接口**不再丢弃明文** —— 明文就在 bridge.json 里，任何时候都能再复制一次。
          return true;
        }
        setErrorText(next.error || null);
        return false;
      } finally {
        setWorking(null);
      }
    },
    [],
  );

  const askEnable = useCallback(async (port: number) => {
    return askConfirm({
      title: "开启本地导入接口？",
      message: enableConfirmMessage(port),
      note: FIREWALL_NOTE,
      confirmLabel: "开启",
      cancelLabel: "取消",
    });
  }, []);

  const handleToggle = useCallback(
    async (next: boolean) => {
      setErrorText(null);
      setSurface(null);
      if (!next) {
        setWorking("stop");
        try {
          const stopped = await stopBridge();
          if (stopped) setStatus(stopped);
          else setErrorText("本地接口关闭失败，请重试。");
        } finally {
          setWorking(null);
        }
        return;
      }
      const requested = parsePort(portText) ?? status?.startPort ?? BRIDGE_DEFAULT_PORT;
      // 首次开启：先确认风险，再生成令牌（㊴：明文与哈希一起落盘、随时可复制），最后才监听。
      if (!status?.tokenSet) {
        if (!(await askEnable(requested))) return;
        setWorking("token");
        try {
          const created = await regenerateBridgeToken();
          if (!created) {
            setErrorText("生成访问令牌失败，请重试。");
            return;
          }
          setFreshToken(created.token);
          rememberBridgeToken(created.token);
          await refresh();
        } finally {
          setWorking(null);
        }
        return;
      }
      if (!(await askEnable(requested))) return;
      await doStart(parsePort(portText) ?? undefined);
    },
    [askEnable, doStart, portText, refresh, status?.startPort, status?.tokenSet],
  );

  const handleRegenerate = useCallback(async () => {
    const ok = await askConfirm({
      title: "重新生成访问令牌？",
      message: "旧的令牌会立刻失效，正在使用它的剪藏工具需要重新配置。",
      confirmLabel: "重新生成",
      cancelLabel: "取消",
      danger: true,
    });
    if (!ok) return;
    setWorking("token");
    setErrorText(null);
    try {
      const created = await regenerateBridgeToken();
      if (!created) {
        setErrorText("生成访问令牌失败，请重试。");
        return;
      }
      // ㊲：换新明文（旧令牌同时作废），界面与模块缓存一起更新。
      setFreshToken(created.token);
      rememberBridgeToken(created.token);
      setSurface(null);
      await refresh();
    } finally {
      setWorking(null);
    }
  }, [refresh]);

  const handleCopy = useCallback(
    async (which: "address" | "token", text: string | null) => {
      if (!text) return;
      const ok = await copyText(text);
      if (!ok) {
        setErrorText("复制失败，请手动选中后复制。");
        return;
      }
      setErrorText(null);
      flashCopied(which);
    },
    [flashCopied],
  );

  const handleChangePort = useCallback(async () => {
    const parsed = parsePort(portText);
    if (parsed === null) {
      setErrorText(`端口要在 ${BRIDGE_PORT_MIN} 到 ${BRIDGE_PORT_MAX} 之间。`);
      return;
    }
    setWorking("port");
    try {
      if (running) {
        const stopped = await stopBridge();
        if (stopped) setStatus(stopped);
      }
      setWorking(null);
      await doStart(parsed);
    } finally {
      setWorking(null);
    }
  }, [doStart, portText, running]);

  const handleOpenLog = useCallback(async () => {
    setWorking("log");
    setErrorText(null);
    try {
      const ok = await openBridgeLog();
      if (!ok) setErrorText("日志文件还不可用（请先开启本地接口并导入一次）。");
    } finally {
      setWorking(null);
    }
  }, []);

  const handleRemoveOrigin = useCallback(async (origin: string) => {
    const ok = await askConfirm({
      title: "移除这个来源？",
      message: `移除后，来自 ${origin} 的请求会被拒绝，直到它重新配对。`,
      confirmLabel: "移除",
      cancelLabel: "取消",
      danger: true,
    });
    if (!ok) return;
    const next = await removeBridgeOrigin(origin);
    if (next) setStatus(next);
  }, []);

  const origins = status?.origins ?? [];
  const lastRejected = status?.lastRejectedOrigin ?? null;
  const header = useMemo(() => <div className="tree__group">导入与接口</div>, []);

  // S9：网页版没有本地接口——如实说明，不给假的开关。
  if (!ipcReady) {
    return (
      <>
        {header}
        <div className="setting">
          <div className="setting__label">
            本地接口
            <small>只有桌面版提供</small>
          </div>
          <div className="setting__control">
            <div style={ROW}>
              <label className="switch">
                <input type="checkbox" checked={false} disabled onChange={() => undefined} />
                开启本地导入接口
              </label>
              <StatusChip state="disabled" />
            </div>
            <p style={HINT}>本地接口只在桌面版提供。网页版的笔记存在浏览器里，外部程序无法直接写入。</p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {header}

      <SettingRow label="导入方式" hint="外部导入如何进入笔记本">
        <div className="segmented">
          {(Object.keys(CONFLICT_LABELS) as ImportConflictPreference[]).map((value) => (
            <button
              key={value}
              type="button"
              className={cn(mode === value && "is-active")}
              disabled={!onImportConflict}
              onClick={() => onImportConflict?.(value)}
            >
              {CONFLICT_LABELS[value]}
            </button>
          ))}
        </div>
        <p className="setting__meta">{CONFLICT_NOTES[mode]}</p>
        <p className="setting__meta">{R1_RECOMMEND}</p>
      </SettingRow>

      <SettingRow label="入库后提示" hint="入库成功时显示可撤销提示">
        <label className="switch">
          <input
            type="checkbox"
            checked={importNotify ?? true}
            disabled={!onImportNotify}
            onChange={(event) => onImportNotify?.(event.target.checked)}
          />
          显示可撤销提示
        </label>
      </SettingRow>

      <SettingRow label="剪藏配图" hint="网页剪藏时把正文里的网络图片存进笔记本（桌面端）">
        <label className="switch">
          <input
            type="checkbox"
            checked={downloadImages ?? true}
            disabled={!onDownloadImages}
            onChange={(event) => onDownloadImages?.(event.target.checked)}
          />
          下载网络图片到本地
        </label>
        {downloadImages === false ? (
          <p style={HINT}>
            关掉后正文里保留原始网址。桌面端 CSP 不放行远程图片，那些图在界面上不会显示；
            浏览器版笔记本则取决于网站是否允许跨站加载。
          </p>
        ) : null}
      </SettingRow>

      <SettingRow label="本地接口" hint="桌面版提供的本机导入通道，默认关闭">
        <div style={ROW}>
          <label className="switch">
            <input
              type="checkbox"
              checked={running}
              disabled={busy || state === "starting"}
              onChange={(event) => void handleToggle(event.target.checked)}
            />
            开启本地导入接口
          </label>
          <StatusChip state={state} />
          {state === "starting" ? (
            <span style={{ ...HINT, margin: 0 }}>正在启动本地接口…</span>
          ) : null}
          {state === "stopped" ? (
            <span style={{ ...HINT, margin: 0 }}>本次会话已关闭</span>
          ) : null}
          {state === "disabled" ? <span style={{ ...HINT, margin: 0 }}>本地接口已关闭</span> : null}
        </div>

        <div style={{ ...ROW, marginTop: "var(--s2)" }}>
          <span style={{ fontSize: "var(--fs-sm)", color: "var(--ink-3)" }}>地址</span>
          <span
            role="group"
            aria-label="本地接口地址"
            style={{ ...VALUE_BOX, color: running ? "var(--ink)" : "var(--ink-3)" }}
          >
            {endpoint}
          </span>
          <button
            type="button"
            className="btn"
            disabled={!running || busy}
            onClick={() => void handleCopy("address", status?.endpoint ?? null)}
          >
            <Icon name="copy" size={14} />
            {copied === "address" ? "已复制" : "复制地址"}
          </button>
        </div>

        <div style={{ ...ROW, marginTop: "var(--s2)" }}>
          <span style={{ fontSize: "var(--fs-sm)", color: "var(--ink-3)" }}>端口</span>
          <input
            className="field"
            style={{ width: 88, textAlign: "center", ...MONO }}
            value={portText}
            inputMode="numeric"
            aria-label="端口"
            disabled={busy}
            onChange={(event) => setPortText(event.target.value.replace(/[^\d]/g, "").slice(0, 5))}
          />
          <button type="button" className="btn" disabled={busy} onClick={() => void handleChangePort()}>
            <Icon name="rotate" size={14} />
            {working === "port" || working === "start" ? "正在启动…" : "换一个端口"}
          </button>
          <span style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)" }}>
            范围 {rangeStart}–{rangeEnd}
          </span>
        </div>

        {outsideDefaultRange ? (
          <p style={NOTICE} role="note">
            当前端口 {status?.port} 不在默认段 {BRIDGE_DEFAULT_PORT}–{defaultRangeEnd} 内：浏览器剪藏扩展
            无法自动发现它（旧版客户端同理）。请把端口改回这一段，或更新扩展后在扩展里填写上面的地址。
          </p>
        ) : null}

        <p style={HINT}>{R3_HINT}</p>
        {errorText ? (
          <p style={ERROR} role="alert">
            {errorText}
          </p>
        ) : null}
      </SettingRow>

      {/*
        唯一的令牌区块（task-22 合并 R4 + R4b；㊴ 起明文落盘、随时可复制）。
        合并前这里是两块：R4「访问令牌」与 R4b「复制令牌」，各有一个掩码框和一个复制按钮 ——
        于是同一时刻会出现两个相反的结论（R4 说「可以反复复制」，R4b 说「令牌已不可见」）。
        **一个事实只有一个产地**：下面这三条状态句互斥，同一份 HTML 里只会出现一条。
      */}
      <SettingRow label="访问令牌" hint="剪藏工具用它证明身份">
        <div style={ROW}>
          <span role="group" aria-label="访问令牌" style={{ ...VALUE_BOX, color: copyable ? "var(--ink)" : "var(--ink-2)" }}>
            {copyable ?? maskToken(status?.tokenLast4)}
          </span>
          <button
            type="button"
            className="btn"
            disabled={!copyable || busy}
            title={
              copyable
                ? "复制后粘贴到客户端即可；明文保存在本机，任何时候都能复制。"
                : "明文没有保存在本机（这个令牌是旧版本生成的），需要明文请点「重新生成」"
            }
            onClick={() => void handleCopy("token", copyable)}
          >
            <Icon name="copy" size={14} />
            {copied === "token" ? "已复制" : "复制"}
          </button>
          <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void handleRegenerate()}>
            <Icon name="rotate" size={14} />
            重新生成
          </button>
        </div>
        {/*
          ㊴ 只剩两态（+ 一种「旧版文件」的可达降级）：有明文 = 随时可复制；没令牌 = 去生成。
          ㊲ 的「重启后不可见」「界面没取到」两种已经删掉 —— 明文落盘后它们不可能发生。
        */}
        {copyable ? <p style={{ ...ERROR, color: "var(--ink)" }}>{R4_READY}</p> : null}
        {!copyable && status?.tokenSet === true ? <p style={HINT}>{R4_LEGACY}</p> : null}
        {!copyable && status?.tokenSet !== true ? <p style={HINT}>{R4_NO_TOKEN}</p> : null}
        {copyable && !running ? (
          <div style={{ ...ROW, marginTop: "var(--s2)" }}>
            <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void doStart(parsePort(portText) ?? undefined)}>
              <Icon name="check" size={14} />
              我已保存，开启接口
            </button>
          </div>
        ) : null}
        {surface ? (
          <p style={ERROR} role="alert">
            {surface}
          </p>
        ) : null}
        <p style={HINT}>{R4_HINT}</p>
        {/* 披露句必须与事实同时变化：没有数据目录时那句「保存在 bridge.json 里」就不成立。 */}
        <p style={HINT}>{status?.tokenPersisted === false ? TOKEN_NO_DISK_HINT : TOKEN_COST_HINT}</p>
      </SettingRow>

      {/*
        历史来源记录：**来源清理**，与令牌是两件事，所以独立成块（不折进令牌区块）。
        仅在非空时渲染 —— 空块只会让人以为「这里本来该有东西」。
      */}
      {origins.length > 0 ? (
        <SettingRow label="历史来源记录" hint="0.3.1 之前的来源条目">
          <div style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)" }}>
            现在来源按类型判断，下面这些条目已不生效，可以清理。
          </div>
          {origins.map((origin) => (
            <div key={origin} style={{ ...ROW, marginTop: 4 }}>
              <span style={{ ...VALUE_BOX, flex: "1 1 auto", fontSize: "var(--fs-xs)" }}>{origin}</span>
              <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void handleRemoveOrigin(origin)}>
                移除
              </button>
            </div>
          ))}
        </SettingRow>
      ) : null}

      {recent !== null ? (
        <SettingRow label="最近导入" hint="最近 5 次外部导入">
          {recent.length === 0 ? (
            <p className="setting__meta">还没有从外部导入过内容。</p>
          ) : (
            <div>
              {recent.slice(0, 5).map((record) => (
                <div key={record.importId} style={{ ...ROW, marginTop: 4 }}>
                  <span style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)", flex: "none" }}>{record.client}</span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: "var(--fs-sm)",
                    }}
                  >
                    {record.title}
                  </span>
                  <span style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)", flex: "none" }}>
                    {formatRelativeTime(Date.parse(record.at) || Date.now())}
                  </span>
                </div>
              ))}
            </div>
          )}
          {onOpenInbox ? (
            <div style={{ ...ROW, marginTop: "var(--s2)" }}>
              <button type="button" className="btn btn--ghost" onClick={onOpenInbox}>
                <Icon name="panelRight" size={14} />
                打开收件箱
              </button>
            </div>
          ) : null}
        </SettingRow>
      ) : null}

      <SettingRow label="AI 助手" hint="让 Codex / Claude Code 直接导入（P1）">
        <div style={ROW}>
          <button type="button" className="btn" disabled>
            复制 Skill 安装命令
          </button>
          <button type="button" className="btn" disabled>
            复制 MCP 配置
          </button>
        </div>
        <p className="setting__meta">Skill 与 MCP 在 P1 提供；现在可以先用命令行 opennote clip 导入。</p>
      </SettingRow>

      <SettingRow label="诊断日志" hint="只写在本机，可随时关闭">
        <label className="switch">
          <input
            type="checkbox"
            checked={bridgeLog ?? true}
            disabled={!onBridgeLog}
            onChange={(event) => onBridgeLog?.(event.target.checked)}
          />
          记录本地接口日志
        </label>
        {lastRejected ? <p style={HINT}>已拒绝一个来源不明的请求：{lastRejected}。</p> : null}
        <div style={{ ...ROW, marginTop: "var(--s2)" }}>
          <button type="button" className="btn btn--ghost" disabled={busy || !status?.logPath} onClick={() => void handleOpenLog()}>
            <Icon name="file" size={14} />
            查看日志
          </button>
          <span style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)" }}>
            {status?.logPath ? "日志只包含事件名与来源，不含令牌与正文。" : "还没有日志文件。"}
          </span>
        </div>
      </SettingRow>

      {!loaded ? <p className="dialog__note">正在读取本地接口状态…</p> : null}
    </>
  );
}

export default ImportApiPanel;
