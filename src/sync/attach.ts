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
 * ### ② 缺账号密钥 ⇒ 返回 `null`（并说明原因），**不静默降级**
 *
 * 没有密钥就派生不出 `authToken`。这时**不能**「先连上试试」——
 * 那会发一个没有凭证的请求，而服务端只能回 401，用户看到的是「同步失败」，
 * 一个指向错误方向的报错（真因是「这台设备还没导入密钥」）。
 *
 * ### ③ E2EE 但拿不到 `notebookKey` ⇒ 抛，**不退回明文**
 *
 * 这是最要紧的一条：**退回明文意味着把本该加密的内容以明文发出去**，
 * 而且用户以为自己开着 E2EE。宁可同步完全不工作，也不能悄悄不加密。
 */

import type { FileSystemBackend } from "../fs/types";
import type { WorkspaceRecord } from "../data/workspaces";
import { decodeAccountKey, deriveFromAccountKey } from "./accountKey";
import { createSyncController, type SyncController } from "./controller";
import { createOpenNoteProvider } from "./providers/opennote";
import { resolveSend } from "./http";
import { createSyncSession, type SyncSession } from "./session";
import type { SyncOnceResult } from "./engine";
import { createSyncStream, type EventStreamLike } from "./stream";
import { createBackendSyncFiles } from "./backendFiles";
import type { SyncLedger } from "./state";

/** 接不上的原因（返回给 UI 显示 —— 不要只返回 `null` 让界面自己猜）。 */
export type AttachSkipReason =
  /** 配置里同步是关的（默认）。 */
  | "disabled"
  /** 配置半配好（缺 baseUrl / notebookId）—— 与 `normalizeSyncConfig` 的判定一致。 */
  | "incomplete"
  /** 这台设备还没有账号密钥。 */
  | "no-account-key";

export type AttachResult =
  | { ok: true; controller: SyncController; /** 建好的会话（provider/ledger 供冲突裁决用）。 */
      session: SyncSession }
  | { ok: false; reason: AttachSkipReason; message: string };

export interface AttachWorkspaceSyncOptions {
  record: WorkspaceRecord;
  backend: FileSystemBackend;
  ledger: SyncLedger;
  /** 本机保存的账号密钥文本（`keys.ts` 读出来的那一份）；没有就传 `null`。 */
  accountKeyText: string | null;
  /** 工作区根目录的 `.gitignore` 文本。 */
  gitignoreText?: string;
  /** 开一条 SSE 流（注入：网页/移动用 `EventSource`，桌面走主进程）。 */
  openEventStream?: (url: string) => EventStreamLike;
  /** 建流的开关（用户可能在设置里关掉实时）。默认开。 */
  realtime?: boolean;
  /** 每一轮同步成功都回调（账本落盘的挂点，见 runner.onSynced 的说明）。 */
  onSynced?: (result: SyncOnceResult) => void;
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
  /** 测试注入 provider（跳过真实网络）。 */
  provider?: ReturnType<typeof createOpenNoteProvider>;
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
  if (options.accountKeyText === null || options.accountKeyText === "") {
    return { ok: false, reason: "no-account-key", message: "这台设备还没有导入账号密钥" };
  }

  // 解不开的密钥在这里就当「没有」—— 与 `keys.ts` 的 `load()` 同一套判断。
  let material;
  try {
    material = decodeAccountKey(options.accountKeyText);
  } catch {
    return { ok: false, reason: "no-account-key", message: "本机保存的账号密钥已损坏，请重新导入" };
  }
  const { authToken } = deriveFromAccountKey(material);

  /*
   * ★ E2EE 但拿不到 notebookKey ⇒ **抛**，不退回明文（见模块头 ③）。
   *
   * 这是整个文件里唯一「宁可炸也不降级」的地方：退回明文意味着把本该加密的内容
   * 以明文发出去，而用户以为自己开着 E2EE。
   */
  let notebookKey: Uint8Array | undefined;
  if (config.cryptoMode === "user-key") {
    // 需要 `encRoot`：它只存在于「解开 wrappedEncRoot」之后。
    // 那一步在账号解锁流程里（`unlockEncRoot`），结果由调用方通过
    // `options.notebookKey` 之外的路径提供 —— 这里拿不到就**明确抛**。
    notebookKey = options.notebookKeyForNotebook?.(config.notebookId);
    if (!notebookKey) {
      throw new Error(
        "这个笔记本是加密的，但这台设备还没有它的密钥 —— 请先导入账号密钥并解锁；" +
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
      send: await resolveSend({ baseUrl: config.baseUrl, authToken }),
      ...(options.log === undefined ? {} : { log: options.log }),
    });

  const session = createSyncSession({
    config,
    ledger: options.ledger,
    provider,
    backend: createBackendSyncFiles({ backend: options.backend }),
    notebookId: config.notebookId,
    ...(options.gitignoreText === undefined ? {} : { gitignoreText: options.gitignoreText }),
    ...(notebookKey === undefined ? {} : { notebookKey }),
    ...(options.onSynced === undefined ? {} : { onSynced: options.onSynced }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.log === undefined ? {} : { log: options.log }),
  });

  const realtime = options.realtime !== false;
  const controller = createSyncController({
    runner: session.runner,
    openStream: (onSignal) => {
      if (!realtime || !options.openEventStream) return null;
      const stream = createSyncStream({
        // ★ 令牌走**查询串** —— `EventSource` 不能设置请求头（§4.7 第 529 行）。
        url: `${config.baseUrl}/v1/events?nb=${encodeURIComponent(config.notebookId)}&authToken=${encodeURIComponent(authToken)}`,
        onSignal,
        open: options.openEventStream,
        ...(options.log === undefined ? {} : { log: options.log }),
      });
      stream.start();
      return stream;
    },
    ...(options.log === undefined ? {} : { log: options.log }),
  });

  return { ok: true, controller, session };
}
