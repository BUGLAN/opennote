/**
 * The Electron preload bridge (see `electron/preload.cjs`). Everything is
 * optional: in a plain browser `window.opennote` is simply undefined and the
 * app falls back to the File System Access API or OPFS.
 */

export interface DesktopEntry {
  name: string;
  kind: "file" | "directory";
  size: number;
  mtimeMs: number;
}

/* ===================================================================== *
 * 导入信封与落盘结果（`opennote.import/v1`）
 *
 * 这一组类型是「通道 ↔ 渲染层」之间的**线上形状**，字段名逐字来自
 * `docs/import/02-接口契约-导入信封与通道.md`，并由 `00` §6.13 裁定。
 * 契约字段名不得改名——它们是客户端与应用唯一的握手依据。
 * 全仓只在这一处定义这些名字，其它模块一律 import，不得另立同名的第二份。
 * ===================================================================== */

/** 剪藏来源。`capturedAt` 必填且必须含时区；`selection` 只参与判定、不落盘。 */
export interface ImportSource {
  url: string | null;
  title?: string | null;
  site?: string | null;
  author?: string | null;
  publishedAt?: string | null;
  capturedAt: string;
  selection?: boolean;
}

/** 落点提示。`folder` 为空 = 工作区根目录；`notePath` 只对 append/overwrite 有效。 */
export interface ImportTarget {
  folder?: string | null;
  notePath?: string | null;
}

export interface ImportAsset {
  name: string;
  mime: string;
  dataBase64?: string;
  /** 通道级扩展：附件外置时的相对路径（收件箱条目）。 */
  file?: string;
}

export interface ImportClient {
  name: "chrome-extension" | "cli" | "mcp" | "share-target" | "manual" | "other";
  version: string;
}

/** L0 导入信封。未知字段一律忽略。 */
export interface ImportEnvelope {
  spec: "opennote.import/v1";
  importId: string;
  title: string;
  body: string | null;
  /** 通道级扩展：正文外置时的相对路径（收件箱条目）。 */
  bodyFile?: string;
  source: ImportSource;
  target?: ImportTarget;
  conflict?: "new" | "append" | "skip" | "overwrite";
  tags?: string[];
  assets?: ImportAsset[];
  client?: ImportClient;
  /** 收件箱条目附加字段。 */
  enqueuedAt?: string;
}

/** 前像凭据。`revertible: false` 时整块为 null。 */
export interface ImportPreimage {
  path: string;
  bytes: number;
  sha256: string;
}

/** API-02 回执（契约 §4.5 的 `ImportResult`）。 */
export interface ImportResult {
  status: "created" | "appended" | "deduped" | "duplicate" | "pending" | "skipped";
  importId: string;
  path: string | null;
  inboxId: string | null;
  deduped: boolean;
  dedupedBy: "importId" | "contentHash" | "sourceUrl" | null;
  /** 本次是否可逐字节回退。false 时 UI 只能承诺「移入回收站 / 看快照」。 */
  revertible: boolean;
  preimage: ImportPreimage | null;
  assets: string[];
  tags: string[];
  warnings: string[];
}

/** 契约 §6.1 的统一错误体。`detail` 不得含宿主机绝对路径、用户名、令牌。 */
export interface ImportErrorBody {
  code: string;
  message: string;
  userMessage: string;
  http: number;
  retryable: boolean;
  detail?: unknown;
}

/** 桥转交渲染层的落盘结果：**永不抛异常**，便于 IPC 序列化。 */
export type ImportOutcome =
  | { ok: true; result: ImportResult }
  | { ok: false; error: ImportErrorBody };

/** 「最近导入」记录（API-04）。 */
export interface ImportRecord {
  importId: string;
  path: string | null;
  title: string;
  client: string;
  action: string;
  at: string;
}

/** 收件箱条目状态机（5 态，逐字）。 */
export type InboxStatus = "pending" | "committing" | "committed" | "failed" | "discarded";

/**
 * 收件箱条目。`state.json` 只存 `{status,attempts,lastError,committedPath,updatedAt}`
 * 五个契约键；其余字段是渲染层从 `entry.json` 与目录名推导出来的视图字段。
 * `notePath`（UI 用的落点）与 `committedPath`（契约键的镜像）入库成功后必须一致。
 */
export interface InboxEntry {
  id: string;
  status: InboxStatus;
  attempts: number;
  lastError: string | null;
  committedPath: string | null;
  updatedAt: string;
  createdAt: number;
  title: string;
  sourceUrl: string;
  targetFolder: string | null;
  tags: string[];
  notePath: string | null;
  message: string | null;
  envelopePath: string;
}

/** 本地桥状态机的 6 个枚举（逐字）。 */
export type BridgeState = "disabled" | "stopped" | "starting" | "running" | "port-busy" | "failed";

/** 桥状态（`opennote:bridge:status` 的返回）。 */
export interface BridgeStatus {
  state: BridgeState;
  port: number | null;
  endpoint: string | null;
  tokenLast4: string | null;
  tokenSet: boolean;
  origins: string[];
  logPath: string | null;
  inboxWatch: "watch" | "poll" | "off";
  /** 实现细节：没有 dataDir 时令牌不落盘，重启后需重新生成。 */
  tokenPersisted?: boolean;
  /** 实际绑定的地址，形如 `127.0.0.1:8787`；未运行时为 `null`。 */
  address?: string | null;
  /** 上一次启动失败的原因（已脱敏）。 */
  error?: string | null;
  /** 最近一次被拒绝的来源（UI-04/R8 的拒绝记录行）。 */
  lastRejectedOrigin?: string | null;
  /** 用户偏好的起始端口。 */
  startPort?: number | null;
  /** 端口探测范围 `[起, 止]`（闭区间），与 `bridge.cjs` 的 `status()` 逐字一致。 */
  portRange?: [number, number] | null;
  /**
   * 最近一次配对结果。`at` 允许字符串（ISO）或毫秒数——`bridge.cjs` 两种都可能给；
   * `origin` 为 `null` 表示未记录来源。`rotated` 为真时 UI **必须**提示其它客户端需重新配置。
   */
  lastPairing?: { at: string | number; origin: string | null; rotated: boolean } | null;
}

/** 撤销一次导入的结果。`mode` 如实反映实际用的回退手段。 */
export interface ImportUndoResult {
  ok: boolean;
  /** 契约要求回带落点；L2 的撤销只回 `ok`/`mode`/`message`，故这里可选。 */
  path?: string | null;
  /** `preimage` 逐字节还原；`trash` 降级为移入回收站；`snapshot` 只能看快照；`none` 什么都没做成。 */
  mode: "preimage" | "trash" | "snapshot" | "none";
  message?: string;
}

/** 入库完成后主进程广播的通知（`opennote:import:notice`）。 */
export interface ImportNotice {
  importId: string;
  path: string | null;
  action: "created" | "appended";
  revertible: boolean;
  title: string;
  client: string;
  at: string;
}

/** 收件箱变更通知（`opennote:inbox:changed`）。 */
export interface InboxChanged {
  root: string;
  pending: number;
}

/** 本地桥转交来的信封（`opennote:import:receipt`）。 */
export interface ImportReceiptRequest {
  reqId: string;
  /** 信封原文（JSON 字符串）。渲染层负责解析与校验。 */
  envelope: string;
  client: { clientName: string; clientVersion: string };
}

/** 主进程转交的导入/收件箱操作（`opennote:import:request`）。 */
export interface ImportRelayRequest {
  reqId: string;
  op: "recent" | "undo" | "log" | "inboxList" | "inboxCommit" | "inboxDiscard";
  args?: { limit?: number; importId?: string; id?: string };
}

/**
 * 转交回执的通用形状。信封那条路返回 `ImportOutcome`（结果必是 `ImportResult`）；
 * 其余操作用途不同（列表、撤销结果、void），所以这里放宽到 `unknown`——
 * 比强行断言成一个不匹配的类型更诚实。
 */
export type ImportReply =
  | { ok: true; result: unknown }
  | { ok: false; error: ImportErrorBody };

export interface OpennoteBridge {
  isElectron: true;
  platform: string;
  version: string;
  fs: {
    list(root: string, relPath: string): Promise<DesktopEntry[]>;
    readText(root: string, relPath: string): Promise<string>;
    readBytes(root: string, relPath: string): Promise<Uint8Array>;
    writeText(root: string, relPath: string, text: string): Promise<void>;
    writeBytes(root: string, relPath: string, data: Uint8Array): Promise<void>;
    mkdir(root: string, relPath: string): Promise<void>;
    remove(root: string, relPath: string, options?: { recursive?: boolean }): Promise<void>;
    move(root: string, from: string, to: string): Promise<void>;
    exists(root: string, relPath: string): Promise<boolean>;
    stat(root: string, relPath: string): Promise<{ size: number; mtimeMs: number } | null>;
    /**
     * Re-authorise a workspace root for this session. The main process only
     * accepts roots it already trusts (picked through the native dialog, or
     * listed in its persisted recent-workspaces.json); everything else resolves
     * to `false`. Every `fs` call for an unauthorised root is rejected with
     * 「未授权的工作区目录」.
     */
    authorizeRoot(root: string): Promise<boolean>;
    /** Start watching an authorised workspace for external changes (debounced). */
    watchWorkspace(root: string): Promise<boolean>;
    /** Stop watching a workspace. */
    unwatchWorkspace(root: string): Promise<boolean>;
    /** Subscribe to debounced workspace-change events; returns an unsubscribe function. */
    onWorkspaceChanged(callback: (root: string) => void): () => void;
  };
  dialog: {
    pickFolder(): Promise<string | null>;
    pickSaveFile(options: { defaultName: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
    saveFile(absolutePath: string, data: Uint8Array | string): Promise<boolean>;
  };
  shell: {
    showItemInFolder(absolutePath: string): Promise<void>;
    openExternal(url: string): Promise<void>;
  };
  app: {
    getRecentWorkspaces(): Promise<string[]>;
    /** Only roots the main process already trusts can be added (see fs.authorizeRoot). */
    addRecentWorkspace(absolutePath: string): Promise<void>;
    /**
     * The main process is closing the window and asks the renderer to flush
     * pending writes. Call `flushDone()` when finished (or immediately when
     * there is nothing to flush); the main process gives up after ~1500ms
     * anyway, so a missing handler never blocks the close.
     */
    onFlushRequest(callback: () => void): () => void;
    /** Tell the main process the flush finished (idempotent). */
    flushDone(): void;
  };
  window: {
    /** Overlay colours for the frameless title bar (false on macOS). */
    setTitleBarOverlay(colors: { color: string; symbolColor: string }): Promise<boolean>;
  };
  /**
   * 本地桥的控制面（`opennote:bridge:*`）。设置面板**只经 IPC 读状态**——
   * 绝不为了它放开 CSP `connect-src`，页面也不会去 fetch 本地 HTTP。
   * arity 与频道名由 `scripts/ipc-safety-check.cjs` 冻结：一律只追加。
   */
  bridge: {
    status(): Promise<BridgeStatus>;
    start(options?: { port?: number }): Promise<BridgeStatus>;
    stop(): Promise<BridgeStatus>;
    /** 唯一一次返回令牌明文；服务端只存 sha256。 */
    newToken(options?: { origin?: string }): Promise<{ token: string; last4: string }>;
    newPairCode(): Promise<{ code: string; expiresAt: number }>;
    removeOrigin(options: { origin: string }): Promise<BridgeStatus>;
    openLog(): Promise<void>;
    /**
     * R8「记录本地接口日志」。**必须在启动时推一次**（主进程默认 `true`），
     * 否则用户上次关掉的开关会在重启后失效。关掉后既有日志不删除，只是不再增长。
     */
    setLogEnabled(options: { enabled: boolean }): Promise<{ enabled: boolean }>;
  };
  /** 导入相关的只读查询与撤销（`opennote:import:*`、`opennote:inbox:*`）。 */
  import: {
    recent(options?: { limit?: number }): Promise<ImportRecord[]>;
    undo(options: { importId: string }): Promise<ImportUndoResult>;
    log(options?: { limit?: number }): Promise<unknown[]>;
    inboxList(): Promise<InboxEntry[]>;
    inboxCommit(options: { id: string }): Promise<ImportResult>;
    inboxDiscard(options: { id: string }): Promise<void>;
    /**
     * 回执一次主进程转交（信封或收件箱操作）。必须与 `reqId` 一一对应。
     * 传 `ImportOutcome` 而不是抛异常：主进程侧 `ipcMain.handle` 会把异常
     * 退化成字符串，`code`/`http` 会丢，桥就没法把 `IMP-4008` 映射成 422。
     */
    replyToImport(reqId: string, outcome: ImportReply): void;
  };
  onMenu(callback: (command: string) => void): () => void;
  /** 入库完成后主进程的通知；`deduped`/`duplicate`/`skipped` 不发通知。 */
  onImportNotice(callback: (notice: ImportNotice) => void): () => void;
  /** 收件箱目录变化（独立 watcher，去抖 450ms）；浏览器后端下不可用。 */
  onInboxChanged(callback: (changed: InboxChanged) => void): () => void;
  /**
   * 本地桥转交来的信封。回调必须用 `import.replyToImport(reqId, outcome)`
   * 回执——桥在等这个回执才能写出 HTTP 响应。
   */
  onImportReceipt(callback: (request: ImportReceiptRequest) => void): () => void;
  /** 主进程转交的导入/收件箱操作（`recent`/`undo`/`log`/收件箱三件套）。 */
  onImportRequest(callback: (request: ImportRelayRequest) => void): () => void;
}

export function desktopBridge(): OpennoteBridge | null {
  if (typeof window === "undefined") return null;
  const value = (window as unknown as { opennote?: OpennoteBridge }).opennote;
  return value?.isElectron ? value : null;
}

export function isDesktop(): boolean {
  return desktopBridge() !== null;
}
