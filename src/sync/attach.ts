/**
 * 把一个**工作区记录**接上同步（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §5.3、§5.1、§5.5）。
 *
 * ## 这是「界面」与「同步」之间**唯一**的一道缝
 *
 * `App.tsx` / `library.ts` 不该知道 provider 怎么建、密钥怎么派生、
 * `knownPaths` 从哪来 —— 它只该问一个问题：**「把这个工作区接上同步」**。
 * 所以这一层把 `WorkspaceSyncConfig` + 账号密钥 + 后端 + 账本
 * 变成一个可以 `start()/stop()/resume()` 的对象。
 *
 * ## ★ 三处「宁可什么都不做」的地方
 *
 * ### ① `enabled === false` ⇒ 返回 `null`，**一个请求都不发**
 *
 * §5.1 把同步定成**旁路**。一个「配置说关、实际在跑」的实现会往用户没同意的
 * 地址发数据，所以这里连 provider 都**不建**（建了就有可能被别处顺手用上）。
 *
 * ### ② 没登录 ⇒ 返回 `signed-out`（并说明原因），**不静默降级**
 *
 * 没有会话令牌时**不能**「先连上试试」—— 那会发一个没有凭证的请求，服务端只能回 401，
 * 用户看到的是「同步失败」，一个指向错误方向的报错（真因是「这台设备还没登录」）。
 *
 * ### ③ E2EE 但拿不到 `notebookKey` ⇒ 抛，**不退回明文**
 *
 * 这是最要紧的一条：**退回明文意味着把本该加密的内容以明文发出去**，
 * 而且用户以为自己开着 E2EE。宁可同步完全不工作，也不能悄悄不加密。
 */

import type { FileSystemBackend } from "../fs/types";
import type { WorkspaceRecord } from "../data/workspaces";
import { createSyncController, type SyncController } from "./controller";
import { createOpenNoteProvider } from "./providers/opennote";
import { resolveSend } from "./http";
import { createSyncSession, type SyncSession } from "./session";
import type { SyncOnceResult } from "./engine";
import { createSyncStream, type EventStreamLike } from "./stream";
import { createBackendSyncFiles } from "./backendFiles";
import { createIgnoreRules, shouldSkipEntry } from "./ignore";
import { getDeviceId } from "./device";
import type { SyncLedger } from "./state";
import type { HashCache } from "./hashCache";
import type { CursorStore } from "./cursor";

/** 接不上的原因（返回给 UI 显示 —— 不要只返回 `null` 让界面自己猜）。 */
/**
 * 造一个「本机游标」读取函数，给 `stream` 连上时比对用。
 *
 * 两条纪律都在这一个函数里（所以它值得被单独测）：
 *
 * 1. **按工作区分键**（`cursorKey` 由调用方拼成「笔记本 + 工作区」）。
 *    共用一个键会让第二个工作区直接继承第一个的进度，然后一条都不拉。
 * 2. **账本为空时不认这个游标**。「游标和服务端一致」只说明远端没动过，
 *    不说明本机有文件 —— 全新 / 被清空的工作区必须老老实实同步一轮。
 */
export function knownCursorFor(
  ledger: SyncLedger,
  cursorStore: CursorStore | undefined,
  cursorKey: string,
): (() => string | null) | undefined {
  if (cursorStore === undefined) return undefined;
  return () => {
    if (Object.keys(ledger.files).length === 0) return null;
    return cursorStore.load(cursorKey);
  };
}
export type AttachSkipReason =
  /** 配置里同步是关的（默认）。 */
  | "disabled"
  /** 配置半配好（缺 baseUrl / notebookId）—— 与 `normalizeSyncConfig` 的判定一致。 */
  | "incomplete"
  /** 这台设备还没有登录同步账号。 */
  | "signed-out"
  /** 加密笔记本，但这台设备还没解锁加密口令。 */
  | "locked"
  /** 这个笔记本绑的是另一台服务器（不是这台设备登录的那台）。 */
  | "other-server";

export type AttachResult =
  | { ok: true; controller: SyncController; /** 建好的会话（provider/ledger 供冲突裁决用）。 */
      session: SyncSession }
  | { ok: false; reason: AttachSkipReason; message: string };

export interface AttachWorkspaceSyncOptions {
  record: WorkspaceRecord;
  backend: FileSystemBackend;
  ledger: SyncLedger;
  /** 设备会话令牌（`ons_…`，`account.ts` 登录换来的）；没登录就传 `null`。 */
  authToken: string | null;
  /** 工作区根目录的 `.gitignore` 文本。 */
  gitignoreText?: string;
  /**
   * 本地哈希缓存（见 `hashCache.ts`）。给了之后「没变的文件」不再重读重算哈希。
   * 传入同一个对象，引擎原地更新它，由调用方负责落盘。
   */
  hashCache?: HashCache;
  /** 增量同步游标（见 `cursor.ts`）；不给就每轮全树比对。 */
  cursorStore?: CursorStore;
  /** 开一条 SSE 流（注入：网页/移动用 `EventSource`，桌面走主进程）。 */
  openEventStream?: (url: string) => EventStreamLike;
  /** 建流的开关（用户可能在设置里关掉实时）。默认开。 */
  realtime?: boolean;
  /**
   * 拉取落地之后要刷新的**路径**（§5.4 第 2 条：按路径刷新，不要整库重扫）。
   *
   * ⚠️ 这个口子**必须接**：桌面端主进程的 watcher 会把「应用自己经 IPC 写过的路径」
   * 在 1.5 秒窗口内过滤掉（`SELF_WRITE_WINDOW_MS`），而远端拉取落盘走的正是同一条 IPC
   * —— 不接它，拉下来的笔记在界面上**永远不会出现**（实测：磁盘 500 篇、侧栏 1 篇）。
   */
  onApplied?: (paths: string[]) => void;
  /** 每一轮同步成功都回调（账本落盘的挂点，见 runner.onSynced 的说明）。 */
  onSynced?: (result: SyncOnceResult) => void;
  /** 实时状态（含 syncing 阶段的逐文件进度）。不接的话 UI 看到的永远是接上那一刻的快照。 */
  onStatus?: (status: import("./runner").SyncStatus) => void;
  /** 同步进行中的逐文件进度（状态对象里也带；二者选一即可，这里全透传）。 */
  onProgress?: (progress: { done: number; total: number }) => void;
  now?: () => number;
  log?: (line: string) => void;
  /**
   * 取某个笔记本的 `notebookKey`（E2EE 时必须给）。
   *
   * 它来自「解开 `wrappedEncRoot` 之后派生」：`deriveNotebookKey(encRoot, notebookId)`。
   * 解锁是账号级的一次性动作（§1.5 流程②），所以这里只**取**结果，不做解锁 ——
   * 否则每次接一个工作区都要重新解一遍包裹。
   */
  notebookKeyForNotebook?: (notebookId: string) => Uint8Array | undefined;
  /**
   * 加密笔记本的文件名对照表密钥（`derivePathMapKey(encRoot)`）。给了，全新设备才认得出
   * 别的设备建的加密文件（见 `pathMap.ts`）。明文笔记本忽略它。
   */
  pathMapKey?: Uint8Array;
  /** 测试注入 provider（跳过真实网络）。 */
  provider?: ReturnType<typeof createOpenNoteProvider>;
  /**
   * 设备标识（检查点 `_local/device-<id>` 的键）。
   *
   * 默认取 `getDeviceId()`（站点存储里的稳定值）；测试里注入固定值，
   * 免得依赖 `localStorage`（它在 Node 环境下不存在，会退回一个临时值）。
   */
  deviceId?: string;
}

/**
 * 把一个工作区接上同步。
 *
 * 返回 `{ ok: false, reason }` 而不是 `null`：**界面需要知道「为什么没接上」**
 * 才能给出对的话（「同步是关的」与「这台设备还没导入密钥」是完全不同的两件事，
 * 而后者用户能自己解决）。
 */
export async function attachWorkspaceSync(options: AttachWorkspaceSyncOptions): Promise<AttachResult> {
  const config = options.record.sync;

  if (!config || config.enabled === false) {
    return { ok: false, reason: "disabled", message: "这个笔记本没有开启同步" };
  }
  if (config.baseUrl === "" || config.notebookId === "") {
    return { ok: false, reason: "incomplete", message: "同步配置不完整（缺服务地址或笔记本 id）" };
  }
  if (options.authToken === null || options.authToken === "") {
    return { ok: false, reason: "signed-out", message: "这台设备还没有登录同步账号" };
  }
  const authToken = options.authToken;

  let notebookKey: Uint8Array | undefined;
  if (config.cryptoMode === "user-key") {
    // 需要 `encRoot`：它只存在于「解开 wrappedEncRoot」之后。
    // 那一步在账号解锁流程里（`unlockEncRoot`），结果由调用方通过
    // `options.notebookKey` 之外的路径提供 —— 这里拿不到就**明确抛**。
    notebookKey = options.notebookKeyForNotebook?.(config.notebookId);
    if (!notebookKey) {
      throw new Error(
        "这个笔记本是加密的，但这台设备还没有解锁加密口令 —— 请先在「设置 → 同步」里解锁；" +
          "（**不会**退回明文同步）",
      );
    }
  }

  const provider =
    options.provider ??
    createOpenNoteProvider({
      baseUrl: config.baseUrl,
      notebookId: config.notebookId,
      authToken,
      cryptoMode: config.cryptoMode,
      /*
       * ★ 必须把设备标识传下去（M9）：不传 `deviceId` 时 provider 的 `checkpoint()` 会
       * **直接 return**（`_local/device-` 是畸形 id，宁可不写），于是 `PUT /v1/checkpoint`
       * 从不发生、服务端的设备清单/断点诊断永远为空 —— 而且不会有任何报错。
       */
      deviceId: options.deviceId ?? getDeviceId(),
      send: await resolveSend({ baseUrl: config.baseUrl, authToken }),
      ...(options.log === undefined ? {} : { log: options.log }),
    });

  /*
   * 游标（增量同步的 `since`）。两件事都在这里定：
   * ① **按工作区**分开存（不是按笔记本 —— 同一笔记本可以有多个工作区）；
   * ② **账本为空时不认它**（空工作区不能因为旧游标就跳过同步）。
   * 细节见下面的两条注释。
   */
  const cursorStore = options.cursorStore;
  const cursorKey = `${config.notebookId}|${options.record.location}`;
  const knownCursor = knownCursorFor(options.ledger, cursorStore, cursorKey);
  const scanRules = createIgnoreRules(options.gitignoreText ?? "");
  const session = createSyncSession({
    config,
    ledger: options.ledger,
    provider,
    backend: createBackendSyncFiles({
      backend: options.backend,
      // 与会话里引擎用的是同一份 `.gitignore` + 内置集：被忽略的目录整棵不扫。
      skipDir: (path) => shouldSkipEntry(scanRules, path, true),
    }),
    notebookId: config.notebookId,
    ...(options.gitignoreText === undefined ? {} : { gitignoreText: options.gitignoreText }),
    ...(options.hashCache === undefined ? {} : { hashCache: options.hashCache }),
    ...(options.cursorStore === undefined ? {} : { cursorStore: options.cursorStore }),
    cursorKey,
    ...(notebookKey === undefined ? {} : { notebookKey }),
    ...(config.cryptoMode === "user-key" && options.pathMapKey !== undefined ? { pathMapKey: options.pathMapKey } : {}),
    ...(options.onSynced === undefined ? {} : { onSynced: options.onSynced }),
    ...(options.onStatus === undefined ? {} : { onStatus: options.onStatus }),
    ...(options.onApplied === undefined ? {} : { onApplied: options.onApplied }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.log === undefined ? {} : { log: options.log }),
  });

  const realtime = options.realtime !== false;
  const controller = createSyncController({
    runner: session.runner,
    openStream: (onSignal, onUpToDate) => {
      if (!realtime || !options.openEventStream) return null;
      const stream = createSyncStream({
        // ★ 令牌走**查询串** —— `EventSource` 不能设置请求头（§4.7 第 529 行）。
        //   基址先剥尾斜杠：`http://host/` + `/v1/events` 会拼出 `//v1/events`，
        //   桌面端主进程的 assertSafeRelPath 直接拒绝（症状：实时流永远连不上、
        //   日志刷「relPath 不能以 // 开头」）。HttpTransport 拼请求早有同款处理。
        url: `${config.baseUrl.replace(/\/+$/, "")}/v1/events?nb=${encodeURIComponent(config.notebookId)}&authToken=${encodeURIComponent(authToken)}`,
        onSignal,
        onUpToDate,
        open: options.openEventStream,
        ...(knownCursor === undefined ? {} : { knownCursor }),
        ...(options.log === undefined ? {} : { log: options.log }),
      });
      stream.start();
      return stream;
    },
    hasLocalChanges: () => session.hasLocalChanges(),
    ...(options.log === undefined ? {} : { log: options.log }),
  });

  return { ok: true, controller, session };
}