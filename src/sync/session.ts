/**
 * 一次同步会话：把已经建好的零件拼成一个「能用的东西」
 * （`docs/执行-三端同步-密钥即身份-2026-10-13.md` §5.3、§5.4）。
 *
 * ## 它只做**拼接**，不做决策
 *
 * 前面每一块都刻意只做一件事，并且都能单独测：
 *
 * | 零件 | 负责 | 不负责 |
 * | --- | --- | --- |
 * | `workspaceFiles.ts` | 忽略过滤 + 哈希 + did | 不知道远端 |
 * | `opennote.ts` | `/v1/*` 的读写 | 不知道本地文件 |
 * | `engine.ts` | 三方 diff 与计划 | 不 import 文件系统 |
 * | `runner.ts` | 单飞 / 状态 / 去抖 | 不知道同步的内容 |
 *
 * 所以这个文件里**不该有判断逻辑** —— 一旦它开始「顺手处理一下」某种情况，
 * 那件事就同时离开了它原来那个能被单独测的地方。
 *
 * ## 两个容易写错的地方
 *
 * ### ① `knownPaths` 必须来自**账本**，不能只用本地扫描结果
 *
 * 引擎靠 `knownPaths` 把远端树里的 did 翻回本机路径（E2EE 下 did 不可逆，
 * 只能「把所有已知路径各算一次 did」）。如果只给本地**当前存在**的文件，
 * 那么「本地删了、远端还在」的那些路径就查不出来 —— 于是远端那条永远拉不下来，
 * 而症状是「另一台设备上删过的文件在这台设备上又出现了」。
 *
 * ### ② 关掉的同步**不许偷偷跑**
 *
 * `config.enabled === false` 时 `syncNow()` 直接返回 `null`，**不建 provider、不发请求**。
 * §5.1 把同步定成**旁路**；一个「配置说关、实际在跑」的实现会往用户没同意的地址发数据。
 */

import type { CryptoMode } from "../../shared/contract";
import { hasPendingLocalChanges, syncOnce, syncOnceIncremental, type SyncEngineDeps, type SyncOnceInput, type SyncOnceResult } from "./engine";
import { createPathMapSync, type PathMapSync } from "./pathMap";
import { createIgnoreRules, type IgnoreRules } from "./ignore";
import { createSyncRunner, type SyncProgress, type SyncRunner, type SyncStatus } from "./runner";
import type { SyncProvider } from "./provider-types";
import type { SyncLedger } from "./state";
import type { WorkspaceSyncConfig } from "../data/workspaces";
import type { HashCache } from "./hashCache";
import type { CursorStore } from "./cursor";
import { createWorkspaceEngineDeps, openRemoteBytes, selectSyncableEntries, type SyncFileBackend } from "./workspaceFiles";
import type { EngineLocalFile } from "./engine";

export interface SyncSessionOptions {
  config: WorkspaceSyncConfig;
  /** 已建好的账本（`createSyncLedger(...)` 的产物）。 */
  ledger: SyncLedger;
  /** 远端读写（测试注入 memory provider）。 */
  provider: SyncProvider;
  backend: SyncFileBackend;
  /** 工作区根目录的 `.gitignore` 文本（没有就传 `""`）。 */
  gitignoreText?: string;
  /** E2EE 时必须给。 */
  notebookKey?: Uint8Array;
  /**
   * E2EE 的文件名对照表密钥（`derivePathMapKey(encRoot)`，见 `pathMap.ts`）。
   *
   * 给了才会读写 `m:pathmap`；不给时全新设备认不出远端的加密文件（只报 `unknownDids`）。
   * 明文笔记本不用它（did 本身可逆）。
   */
  pathMapKey?: Uint8Array;
  /** 工作区根目录的 notebookId（E2EE 的 AAD 要用）。 */
  notebookId: string;
  /**
   * 本地哈希缓存（可选，见 `hashCache.ts`）。传入同一个对象，原地更新，调用方负责落盘。
   * 给了之后「没变的文件」不再重读重算哈希。
   */
  hashCache?: HashCache;
  /**
   * 增量同步的游标（见 `cursor.ts`）。不给就每轮都全树比对（正确、但慢）。
   */
  cursorStore?: CursorStore;
  /**
   * 游标存在哪个键上。默认 = `notebookId`。
   *
   * ★ 调用方**应当**给一个「笔记本 + 工作区」的组合键：同一个笔记本可以有多个
   * 工作区（换了文件夹 / 从别处拷一份），共用一个游标会让后一个直接「继承」前一个的进度。
   */
  cursorKey?: string;
  onStatus?: (status: SyncStatus) => void;
  onApplied?: (paths: string[]) => void;
  /** 每一轮成功都回调（含纯推送）—— 账本落盘的挂点，见 runner 的说明。 */
  onSynced?: (result: SyncOnceResult) => void;
  now?: () => number;
  /** 每页列树的条数（引擎会翻页取完，直到 `truncated === false`）。 */
  maxFiles?: number;
  /** 同时在飞的请求数（默认 4）。速率由传输层的限速器控制，见 `SyncOnceInput.concurrency`。 */
  concurrency?: number;
  log?: (line: string) => void;
  localWriteDebounceMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface SyncSession {
  readonly deps: SyncEngineDeps;
  readonly runner: SyncRunner;
  /**
   * 远端读写（与引擎用的同一个实例）。
   *
   * 暴露它只有一个正当用途：**冲突裁决（L3 收尾）**——「采用远端」要 `read`，
   * 「保留本地」要 `put`。拿它做别的（绕过引擎直接搬数据）等于把三方 diff 甩开。
   */
  readonly provider: SyncProvider;
  /** 账本（引擎原地更新同一对象；裁决动作也要更新它，所以一并交出）。 */
  readonly ledger: SyncLedger;
  /** 手动同步一次（`enabled: false` 时直接返回 `null`）。 */
  syncNow(): Promise<SyncOnceResult | null>;
  /** 本地有没有还没推上去的改动（只扫本地，不发请求；`enabled: false` 时恒为 false）。 */
  hasLocalChanges(): Promise<boolean>;
  status(): SyncStatus;
  dispose(): void;
}

/** 账本里记着的全部路径 —— 引擎靠它把远端 did 翻回本机路径（见模块头 ①）。 */
export function knownPathsOf(ledger: SyncLedger): string[] {
  return Object.keys(ledger.files);
}

export function createSyncSession(options: SyncSessionOptions): SyncSession {
  const rules: IgnoreRules = createIgnoreRules(options.gitignoreText ?? "");
  /** 加密笔记本的文件名对照表（明文笔记本 / 没给密钥时为 null）。在 `deps` 之后才建，因为它要用 `deps.didOf`。 */
  let pathMap: PathMapSync | null = null;

  const deps = createWorkspaceEngineDeps({
    backend: options.backend,
    rules,
    cryptoMode: options.config.cryptoMode,
    // `notebookId` 是内容 AAD 的一半 —— 两种模式都给（明文模式不用它，但形状一致）。
    notebookId: options.notebookId,
    ...(options.notebookKey === undefined ? {} : { notebookKey: options.notebookKey }),
    ...(options.hashCache === undefined ? {} : { hashCache: options.hashCache }),
    /*
     * ★ 必须是**本地扫描结果 ∪ 账本里记着的路径**（引擎那边的原话）。
     *
     * 我第一版只给了账本里的路径 —— 那在「账本为空但本地已有文件」时会出问题：
     * 用户把笔记目录整个拷过来（或换了台设备重新导入），账本是空的，
     * 于是远端树里的 did **一个都翻不回路径** ⇒ 引擎把它们当成「远端新增」，
     * 于是**把本地已有的同名文件当成需要拉取的**（覆盖掉本地内容）。
     *
     * 本地那一半走 `selectSyncableEntries`，与 `listLocal` 用**同一套**忽略规则 ——
     * 否则被忽略的路径会混进来，而「忽略 = 该路径在引擎里双向不存在」（红线 8）。
     */
    knownPaths: async () => {
      const local = selectSyncableEntries(await options.backend.list(), rules).map((entry) => entry.path);
      // 再并上对照表里的路径：全新设备靠它把别的设备建的加密文件认出来（`pathMap.ts`）。
      return Array.from(new Set([...local, ...knownPathsOf(options.ledger), ...(pathMap?.paths() ?? [])]));
    },
    ...(options.log === undefined
      ? {}
      : {
          /*
           * ★ 引擎的日志是**结构化**的（`(kind, detail)`），而会话的 `log` 是给人看的一行文本。
           * 这里必须做一次适配：直接写 `{ log: options.log }` 虽然能通过类型检查
           * （参数更少是合法的），但引擎每记一条只会把 `kind` 传进去、`detail` 全丢 ——
           * 诊断面板里只剩孤零零的 `tree` / `push`，比没有更难查（L2）。
           */
          log: (kind, detail) => options.log?.(`[sync] ${kind} ${JSON.stringify(detail)}`),
        }),
  });

  if (options.config.cryptoMode === "user-key" && options.pathMapKey !== undefined) {
    pathMap = createPathMapSync({
      provider: options.provider,
      pathMapKey: options.pathMapKey,
      notebookId: options.notebookId,
      didOf: deps.didOf,
      ...(options.log === undefined ? {} : { log: options.log }),
    });
  }
  /** 上一轮还认不出来的 did：下一轮开头先重读对照表，学到了就走一次全树（增量的游标已经越过它们了）。 */
  let pendingUnknown = new Set<string>();
  /** 刚学到的路径里，有没有能认出 `unknown` 里某条 did 的。 */
  const resolvesAny = (learned: string[], unknown: Set<string>): boolean =>
    unknown.size > 0 && learned.some((path) => unknown.has(deps.didOf(path)));

  /*
   * 引擎的逐文件进度 → runner（由它发布带进度的 syncing 状态给 UI）。
   * runner 在下面才创建，这里先用可重绑定的引用接住。
   */
  let reportProgress: ((progress: SyncProgress) => void) | undefined;
  const runner = createSyncRunner({
    syncOnce: async () => {
      /*
       * ★ 关掉的同步不许跑（模块头 ②）。
       *
       * 注意这个判断在 `syncOnce` 里**再做一次**，而不是只在 `syncNow()` 里做 ——
       * 因为 `runner` 还会被去抖与信号触发，那些路径不经过 `syncNow()`。
       */
      if (!options.config.enabled) {
        throw new Error("同步是关闭的");
      }
      /*
       * ★ 走**增量**：先问远端「自上轮以来变了吗」。
       *
       * 游标来自站点存储（`cursor.ts`：它是设备属性，不能跟着笔记本目录走）。
       * 没有游标 ⇒ `since = null` ⇒ 引擎自动退化成全树比对（正确性优先）。
       */
      const cursorKey = options.cursorKey ?? options.notebookId;
      const since = options.cursorStore?.load(cursorKey) ?? null;
      const base: SyncOnceInput = {
        provider: options.provider,
        ledger: options.ledger,
        deps,
        onProgress: (progress) => reportProgress?.(progress),
        ...(options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles }),
        ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
        ...(options.now === undefined ? {} : { now: options.now }),
      };
      /*
       * ★ 加密笔记本的对照表（`pathMap.ts`）：
       * ① 会话第一轮、或上一轮还有认不出的 did ⇒ 先重读表；学到了能认出它们的路径就走全树
       *    （增量游标已经越过那些 did，只看变更是再也见不到它们的）；
       * ② 这一轮仍有认不出的 ⇒ 再读一次表（别的设备可能刚写完），学到了就立刻补一次全树；
       * ③ 收尾把本机账本里的路径并进表、去掉这一轮删掉的。
       */
      let forceFull = false;
      if (pathMap !== null && (!pathMap.loaded || pendingUnknown.size > 0)) {
        forceFull = resolvesAny(await pathMap.refresh(), pendingUnknown);
      }
      let result = forceFull ? await syncOnce(base) : await syncOnceIncremental({ ...base, since });
      if (pathMap !== null && result.unknownDids.length > 0) {
        if (resolvesAny(await pathMap.refresh(), new Set(result.unknownDids))) {
          result = mergeRounds(result, await syncOnce(base));
        }
      }
      pendingUnknown = new Set(result.unknownDids);
      if (pathMap !== null) {
        await pathMap.publish(Object.keys(options.ledger.files), [...(result.deletedPaths ?? []), ...(result.remoteDeletedPaths ?? [])]);
      }
      // 只有真的拿到了游标才推进；拿不到就保持旧值 —— 下一轮会再问一次（安全方向）。
      if (result.checkpoint !== null) options.cursorStore?.save(cursorKey, result.checkpoint);
      return result;
    },
    ...(options.onStatus === undefined ? {} : { onStatus: options.onStatus }),
    ...(options.onApplied === undefined ? {} : { onApplied: options.onApplied }),
    ...(options.onSynced === undefined ? {} : { onSynced: options.onSynced }),
    ...(options.localWriteDebounceMs === undefined ? {} : { localWriteDebounceMs: options.localWriteDebounceMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.log === undefined ? {} : { log: options.log }),
  });

  reportProgress = (progress) => runner.reportProgress(progress);

  return {
    deps,
    runner,
    provider: options.provider,
    ledger: options.ledger,
    async syncNow() {
      if (!options.config.enabled) return null;
      return runner.request("manual");
    },
    async hasLocalChanges() {
      if (!options.config.enabled) return false;
      return hasPendingLocalChanges(options.ledger, deps);
    },
    status: () => runner.status(),
    dispose: () => runner.dispose(),
  };
}

/**
 * 把同一轮里的两次引擎运行合成一份结果（第二次是学到对照表之后补的全树）。
 *
 * 计数与明细相加（两次做的事都真实发生了）；「现在是什么状态」的字段取第二次 ——
 * 它是在第一次之后、拿着更全的路径跑的，账本、检查点、冲突、认不出的 did 都以它为准。
 */
export function mergeRounds(first: SyncOnceResult, second: SyncOnceResult): SyncOnceResult {
  const concat = (a?: string[], b?: string[]): string[] => Array.from(new Set([...(a ?? []), ...(b ?? [])]));
  const pushConflicts = new Map(first.pushConflicts.map((conflict) => [conflict.path, conflict]));
  for (const conflict of second.pushConflicts) pushConflicts.set(conflict.path, conflict);
  return {
    ...second,
    pushed: first.pushed + second.pushed,
    remoteDeleted: first.remoteDeleted + second.remoteDeleted,
    pulled: first.pulled + second.pulled,
    deleted: first.deleted + second.deleted,
    pushConflicts: [...pushConflicts.values()],
    resynced: first.resynced || second.resynced,
    pushedPaths: concat(first.pushedPaths, second.pushedPaths),
    pulledPaths: concat(first.pulledPaths, second.pulledPaths),
    deletedPaths: concat(first.deletedPaths, second.deletedPaths),
    remoteDeletedPaths: concat(first.remoteDeletedPaths, second.remoteDeletedPaths),
    appliedPaths: concat(first.appliedPaths, second.appliedPaths),
  };
}

/**
 * 拉取落地时要写进本地的字节。
 *
 * E2EE 下远端给的是密文，必须先解开再写盘 —— 而**解开这一步只有客户端能做**
 * （红线 3：`server/` 里没有任何解密函数）。明文模式下远端给的就是原文。
 *
 * 这个函数是给上层「拉取 → 写盘」那段用的；引擎本身拿到的是**已解开**的字节，
 * 因为它不该知道加密模式（`workspaceFiles.ts` 的模块头）。
 */
export function bytesToWrite(options: {
  cryptoMode: CryptoMode;
  notebookKey?: Uint8Array;
  notebookId: string;
  did: string;
  path: string;
  remoteBytes: Uint8Array;
}): Uint8Array {
  const { remoteBytes, ...rest } = options;
  return openRemoteBytes({ ...rest, bytes: remoteBytes });
}

/** 一个空的本地条目（`listLocal` 的返回形状），给上层做类型对齐用。 */
export type { EngineLocalFile };
