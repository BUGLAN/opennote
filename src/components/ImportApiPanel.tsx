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
  BRIDGE_PORT_MAX,
  BRIDGE_PORT_MIN,
  bridgeAvailable,
  copyText,
  createPairCode,
  maskToken,
  openBridgeLog,
  pairCodeSecondsLeft,
  pairingStampMs,
  parsePort,
  readBridgeStatus,
  regenerateBridgeToken,
  removeBridgeOrigin,
  startBridge,
  stateLabelOf,
  stopBridge,
  type BridgeStatusView,
} from "../lib/importBridge";
import { notify } from "../lib/toast";
import { cn, formatRelativeTime } from "../lib/utils";
import { Icon } from "./Icons";

export interface ImportApiPanelProps {
  /** 桌面版（Electron）环境。false → S9 禁用态。 */
  desktop: boolean;
  /** R1 导入方式。不给就只读展示默认值 `直接入库（推荐）`。 */
  importConflict?: ImportConflictPreference;
  onImportConflict?(value: ImportConflictPreference): void;
  /** R2 入库后提示。 */
  importNotify?: boolean;
  onImportNotify?(value: boolean): void;
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

const CONFLICT_LABELS: Record<ImportConflictPreference, string> = {
  new: "直接入库（推荐）",
  append: "追加到已有笔记",
  skip: "跳过重复内容",
  inbox: "先进入收件箱",
};

const CONFLICT_NOTES: Record<ImportConflictPreference, string> = {
  new: "收到就写成 .md 文件，并在应用内提示，可以随时撤销。",
  append: "来源相同的已有笔记就追加到末尾，不新建文件。",
  skip: "来源已经导入过就跳过，不写入任何内容。",
  inbox: "外部导入先落到 .opennote/inbox/，由你在收件箱里逐条确认后再入库。",
};

const R3_HINT =
  "只监听本机 127.0.0.1，只提供导入，不提供读取和删除。任何网页都可能尝试访问本机端口，所以请勿在不可信的网页上暴露令牌。";

const R4_HINT = "令牌只在本机使用，Opennote 不会把它上传到任何地方。重新生成后，旧的令牌立刻失效。";

const R4B_HINT =
  "在插件里输入这 6 位配对码即可，不必粘贴令牌。配对码 120 秒有效、一次性、连续失败 5 次即作废；过期后点「配对新客户端」重新生成。";

const ROTATED_WARNING = "已为该客户端生成新令牌，其它已配置的客户端需要重新配置。";

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
  bridgeLog,
  onBridgeLog,
  onOpenInbox,
}: ImportApiPanelProps) {
  const [status, setStatus] = useState<BridgeStatusView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [working, setWorking] = useState<null | "start" | "stop" | "token" | "pair" | "log" | "port">(null);
  /** S7：本次会话里刚生成的令牌明文，只活在这里，刷新即消失。 */
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [pair, setPair] = useState<{ code: string; expiresAt: number } | null>(null);
  const [pairExpired, setPairExpired] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState<null | "address" | "token" | "pair">(null);
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

  // 打开面板读一次；不做轮询（桥状态只在用户操作与配对窗口里变）。
  useEffect(() => {
    if (!ipcReady) {
      setLoaded(true);
      return;
    }
    void refresh();
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

  // 配对码倒计时 + 配对结果观察（120 秒窗口内才有轮询，且只走 IPC）。
  useEffect(() => {
    if (!pair || !ipcReady) return;
    const created = pair.expiresAt - 120_000;
    const timer = window.setInterval(() => {
      const stamp = Date.now();
      setNow(stamp);
      void readBridgeStatus().then((next) => {
        if (!next) return;
        const paired = next.lastPairing;
        if (paired && pairingStampMs(paired.at) >= created) {
          setStatus(next);
          setPair(null);
          setPairExpired(false);
          notify("已配对 1 个客户端。");
          if (paired.rotated) {
            setSurface(ROTATED_WARNING);
            notify(ROTATED_WARNING, { kind: "danger", duration: 6000 });
          }
          return;
        }
        if (pairCodeSecondsLeft(pair.expiresAt, stamp) === null) {
          setPair(null);
          setPairExpired(true);
        }
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [pair, ipcReady]);

  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);

  const state: BridgeState | null = status ? status.state : null;
  const running = status?.state === "running";
  const busy = working !== null;
  const endpoint = running ? status?.endpoint || `http://127.0.0.1:${status?.port}` : BRIDGE_ADDRESS_PLACEHOLDER;
  // `portRange` 是闭区间元组 `[起, 止]`（与 bridge.cjs 的运行时形状逐字一致）。
  const rangeStart = status?.portRange?.[0] ?? status?.startPort ?? BRIDGE_DEFAULT_PORT;
  const rangeEnd = status?.portRange?.[1] ?? rangeStart + 9;
  const secondsLeft = pair ? pairCodeSecondsLeft(pair.expiresAt, now) : null;

  const flashCopied = useCallback((which: "address" | "token" | "pair") => {
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
          setFreshToken(null);
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
      // 首次开启：先确认风险，再生成令牌（明文只展示这一次），最后才监听。
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
      setFreshToken(created.token);
      setSurface(null);
      await refresh();
    } finally {
      setWorking(null);
    }
  }, [refresh]);

  const handleCopy = useCallback(
    async (which: "address" | "token" | "pair", text: string | null) => {
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

  const handleNewPairCode = useCallback(async () => {
    setWorking("pair");
    setErrorText(null);
    setSurface(null);
    try {
      const created = await createPairCode();
      if (!created) {
        setErrorText("生成配对码失败，请重试。");
        return;
      }
      setPair({ code: created.code, expiresAt: created.expiresAt });
      setPairExpired(false);
      setNow(Date.now());
    } finally {
      setWorking(null);
    }
  }, []);

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
              className={cn((importConflict ?? "new") === value && "is-active")}
              disabled={!onImportConflict}
              onClick={() => onImportConflict?.(value)}
            >
              {CONFLICT_LABELS[value]}
            </button>
          ))}
        </div>
        <p className="setting__meta">{CONFLICT_NOTES[importConflict ?? "new"]}</p>
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

        <p style={HINT}>{R3_HINT}</p>
        {errorText ? (
          <p style={ERROR} role="alert">
            {errorText}
          </p>
        ) : null}
      </SettingRow>

      <SettingRow label="访问令牌" hint="剪藏工具用它证明身份">
        <div style={ROW}>
          <span role="group" aria-label="访问令牌" style={{ ...VALUE_BOX, color: freshToken ? "var(--ink)" : "var(--ink-2)" }}>
            {freshToken ?? maskToken(status?.tokenLast4)}
          </span>
          <button
            type="button"
            className="btn"
            disabled={!freshToken || busy}
            title={freshToken ? "复制后请妥善保存；关闭本面板后无法再次显示。" : "令牌只在生成那一刻完整显示一次"}
            onClick={() => void handleCopy("token", freshToken)}
          >
            <Icon name="copy" size={14} />
            {copied === "token" ? "已复制" : "复制"}
          </button>
          <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void handleRegenerate()}>
            <Icon name="rotate" size={14} />
            重新生成
          </button>
        </div>
        {freshToken ? (
          <>
            <p style={{ ...ERROR, color: "var(--ink)" }}>这串令牌只显示这一次，请先复制保存。</p>
            <div style={{ ...ROW, marginTop: "var(--s2)" }}>
              <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void doStart(parsePort(portText) ?? undefined)}>
                <Icon name="check" size={14} />
                我已保存，开启接口
              </button>
            </div>
          </>
        ) : null}
        <p style={HINT}>{R4_HINT}</p>
      </SettingRow>

      <SettingRow label="配对新客户端" hint="比手抄 47 字符令牌省事">
        <div style={ROW}>
          <span style={{ ...VALUE_BOX, fontSize: 17, letterSpacing: "0.3em" }}>
            {pair && secondsLeft !== null ? pair.code : "—"}
          </span>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void handleNewPairCode()}>
            <Icon name="link" size={14} />
            {working === "pair" ? "正在生成…" : "配对新客户端"}
          </button>
          {pair && secondsLeft !== null ? (
            <span style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)" }}>剩余 {secondsLeft} 秒</span>
          ) : null}
          {pairExpired ? (
            <span style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)" }}>配对码已过期，重新生成。</span>
          ) : null}
        </div>
        {surface ? (
          <p style={ERROR} role="alert">
            {surface}
          </p>
        ) : null}
        <p style={HINT}>{R4B_HINT}</p>
        {origins.length > 0 ? (
          <div style={{ marginTop: "var(--s2)" }}>
            <div style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)" }}>已信任的来源</div>
            {origins.map((origin) => (
              <div key={origin} style={{ ...ROW, marginTop: 4 }}>
                <span style={{ ...VALUE_BOX, flex: "1 1 auto", fontSize: "var(--fs-xs)" }}>{origin}</span>
                <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void handleRemoveOrigin(origin)}>
                  移除
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </SettingRow>

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
