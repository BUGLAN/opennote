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
import { syncOnce, type SyncEngineDeps, type SyncOnceResult } from "./engine";
import { createIgnoreRules, type IgnoreRules } from "./ignore";
import { createSyncRunner, type SyncRunner, type SyncStatus } from "./runner";
import type { SyncProvider } from "./provider-types";
import type { SyncLedger } from "./state";
import type { WorkspaceSyncConfig } from "../data/workspaces";
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
  /** 工作区根目录的 notebookId（E2EE 的 AAD 要用）。 */
  notebookId: string;
  onStatus?: (status: SyncStatus) => void;
  onApplied?: (paths: string[]) => void;
  now?: () => number;
  maxFiles?: number;
  log?: (line: string) => void;
  localWriteDebounceMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface SyncSession {
  readonly deps: SyncEngineDeps;
  readonly runner: SyncRunner;
  /** 手动同步一次（`enabled: false` 时直接返回 `null`）。 */
  syncNow(): Promise<SyncOnceResult | null>;
  status(): SyncStatus;
  dispose(): void;
}

/** 账本里记着的全部路径 —— 引擎靠它把远端 did 翻回本机路径（见模块头 ①）。 */
export function knownPathsOf(ledger: SyncLedger): string[] {
  return Object.keys(ledger.files);
}

export function createSyncSession(options: SyncSessionOptions): SyncSession {
  const rules: IgnoreRules = createIgnoreRules(options.gitignoreText ?? "");

  const deps = createWorkspaceEngineDeps({
    backend: options.backend,
    rules,
    cryptoMode: options.config.cryptoMode,
    // `notebookId` 是内容 AAD 的一半 —— 两种模式都给（明文模式不用它，但形状一致）。
    notebookId: options.notebookId,
    ...(options.notebookKey === undefined ? {} : { notebookKey: options.notebookKey }),
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
      return Array.from(new Set([...local, ...knownPathsOf(options.ledger)]));
    },
    ...(options.log === undefined ? {} : { log: undefined }),
  });

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
      return syncOnce({
        provider: options.provider,
        ledger: options.ledger,
        deps,
        ...(options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    },
    ...(options.onStatus === undefined ? {} : { onStatus: options.onStatus }),
    ...(options.onApplied === undefined ? {} : { onApplied: options.onApplied }),
    ...(options.localWriteDebounceMs === undefined ? {} : { localWriteDebounceMs: options.localWriteDebounceMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.log === undefined ? {} : { log: options.log }),
  });

  return {
    deps,
    runner,
    async syncNow() {
      if (!options.config.enabled) return null;
      return runner.request("manual");
    },
    status: () => runner.status(),
    dispose: () => runner.dispose(),
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
