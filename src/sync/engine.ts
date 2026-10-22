/**
 * `SyncEngine` —— **一次同步**的编排（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §2.2、§4.2 红线 2、§6.1）。
 *
 * ## 它做什么、不做什么
 *
 * | 做 | 不做（明确交给别人） |
 * | --- | --- |
 * | 三方 diff（账本 + 本地现状 + 远端树） | **决定谁赢** —— 两边都改就**列出**，由用户裁决（§6.1 L2） |
 * | 按计划调 provider（`tree`/`changes`/`read`/`put`/`delete`/`checkpoint`） | 读写本地文件（由 `deps` 提供的回调做） |
 * | 记账本（`localHash`/`remoteHash`/`rev`） | 落盘账本、刷新 UI（由调用方做，见 `onApplied`） |
 * | 删除保护阈值、`truncated` 挂起 | 产生任何**同步语义**以外的协议（红线 2） |
 *
 * ## 红线 2 在这里怎么体现
 *
 * **引擎不产生任何版本语义**：`rev` 是 provider 给的、游标是 provider 给的、冲突判定靠
 * **标识比较**。它没有「自增版本号」、没有「谁赢的算法」、没有「检查点自建格式」。
 * 换句话说：把 provider 换成真 CouchDB 之后，**这个文件一个字都不用改**。
 *
 * ## 为什么 `resolveConflicts` 不是「自动合并」
 *
 * §6.1 明确裁决：**默认只报不猜**。自动合并（行级三方合并）只在「纯文本 + 用户显式点击」
 * 时才允许，**绝不默认开启、绝不后台自动执行**。所以引擎的默认行为是：把两边的标识都留下，
 * 交给上层弹对话框。本文件里没有任何「猜」的分支。
 *
 * ## E2EE 无关性
 *
 * 引擎只比较**标识字符串**：明文模式是内容 sha256，E2EE 是 `ehash`。
 * 所以 P4 上 E2EE 时，这个文件**不需要改动** —— 变的只是 `deps.hashOf` 与 `deps.didOf`。
 * 这也是「E2EE 放 P4 不会造成迁移」的结构性原因（§9 末段）。
 */

import { assertSafeRelative, isMarkdownPath } from "../fs/paths";
import { applyTruncationGuard, assertDeletionBudget, planPull, planPush, type BaselineLike } from "./diff";
import type { ConflictKind } from "./conflicts";
import type { SyncLedger } from "./state";
import {
  SyncProviderError,
  type ProviderReadResult,
  type ProviderTreeEntry,
  type SyncProvider,
} from "./provider-types";

/** 引擎读到的一条本地文件。 */
export interface EngineLocalFile {
  path: string;
  hash: string;
  bytes: number;
}

/**
 * 引擎的外部依赖。**就这么几个回调** —— 引擎不 import `library.ts`，也不 import 任何后端。
 *
 * 这条边界是有意的：`src/data/library.ts` 有 3500 行、牵着 React store 与一堆状态；
 * 引擎要是 import 它，就没法在 node 里跑纯用例了。
 */
export interface SyncEngineDeps {
  /** 扫本地文件（跳过同步范围之外的 —— 判定在 `ignore.ts`，引擎不重复实现）。 */
  listLocal: () => Promise<EngineLocalFile[]>;
  /** 算一条本地内容的内容标识（明文 sha256 / E2EE 的 `ehash`）。 */
  hashOf: (bytes: Uint8Array) => Promise<string>;
  /**
   * 算一条**已经落盘**的路径的内容标识 —— 与 `listLocal` 同一基准（磁盘上的原始字节）。
   *
   * 拉取落地后记基线必须用它，而不是 `hashOf(provider 给来的字节)`：
   * E2EE 下后者是密文的标识，与本地扫描（明文的标识）永远对不上，
   * 症状是「每拉下来的文件，下一轮都被当成『本地又改了』再推一遍」。
   * 明文模式下两者相同，所以这条只在 E2EE 才看得出差别 —— 也因此单测很容易漏。
   */
  hashOfLocal: (path: string) => Promise<string>;
  /** `path → did`。明文模式 = `idForPath`；E2EE = 用 `idKey` 算 HMAC。**引擎不反解 did。** */
  didOf: (path: string) => string;
  /**
   * **已知路径**（= 本地扫描结果 ∪ 账本里记着的路径）。
   *
   * 引擎靠它把「远端树里的 did」翻回本机路径。**为什么必须由调用方给**：
   * 只有调用方知道本地文件系统与账本里有什么；而 E2EE 下 did **不可逆**（HMAC），
   * 所以「反查」只能靠「把所有已知路径各算一次 did」。
   *
   * ⚠️ 这个回调的**存在本身**是一条纪律：引擎绝不会凭一个陌生的 did 去**猜**路径，
   * 更不会因此把文件写到盘上 —— 认不出来的 did 只如实报进 `unknownDids`，交给上层处置。
   */
  knownPaths: () => Promise<string[]>;
  /** 读本地一条的原始字节。 */
  readLocal: (path: string) => Promise<Uint8Array>;
  /** 把远端一条写到本地（**只写盘，不记账**，记账由引擎交给 `onApplied` 后的调用方）。 */
  writeLocal: (path: string, bytes: Uint8Array) => Promise<void>;
  /** 删本地一条（远端已确认删除）。 */
  removeLocal: (path: string) => Promise<void>;
  /** 日志（结构化字段，便于控制台统计）。 */
  log?: (kind: SyncLogEvent["kind"], detail: SyncLogEvent["detail"]) => void;
}

export interface SyncLogEvent {
  kind: "tree" | "changes" | "push" | "pull" | "delete" | "conflict" | "guard" | "checkpoint" | "error";
  detail: Record<string, string | number | boolean | null>;
}

/** 引擎交给上层的一条冲突（**只报不猜**）。 */
export interface EngineConflict {
  path: string;
  kind: ConflictKind;
  localId: string | null;
  remoteId: string | null;
}

export interface SyncOnceResult {
  /** 本地改了、远端没改 → 已推上去。 */
  pushed: number;
  /** 本地删了 → 已在远端留下墓碑。 */
  remoteDeleted: number;
  /** 远端改了、本地没改 → 已拉到本地。 */
  pulled: number;
  /** `put` 时 CAS 对不上（远端在我们列树之后前进了）→ 列为冲突。 */
  pushConflicts: EngineConflict[];
  /** 三方 diff 判出的冲突（两边都改且内容不同）→ **不动**，列出。 */
  conflicts: EngineConflict[];
  /** 已删本地 + 远端墓碑的条数。 */
  deleted: number;
  /** 因 `truncated`（树没列全）而**挂起**的删除。**绝不静默丢弃。** */
  suspendedDeletes: string[];
  /**
   * 远端树**仍然没取全**（翻页到头也没拿到 `truncated: false`）。
   *
   * 正常应当是 `false`：`fetchWholeTree()` 会一直翻页。为 `true` 说明
   * 服务端分页异常（`startKey` 不前进 / 超过 `TREE_MAX_PAGES`），
   * 此时删除被挂起，UI **必须**把这件事说出来 —— 否则用户看到的是
   * 「同步成功，但删掉的笔记又回来了」。
   */
  treeTruncated: boolean;
  /** 删除保护拦下的条数（>0 表示这次一条都没删，并把原因放在 `deletionGuardMessage`）。 */
  blockedDeletes: number;
  deletionGuardMessage: string | null;
  /** 远端说游标过期 ⇒ 这次走的是全树比对（`planPush`/`planPull` 本来就是全树比对）。 */
  resynced: boolean;
  /** 引擎更新后的账本（调用方负责落盘）。 */
  ledger: SyncLedger;
  /** 本次同步里**本地发生了变化的路径** → 交给 `applyExternalPaths()` 刷 UI。 */
  appliedPaths: string[];
  /**
   * 远端树里**认不出**的 did（本机映射里没有它）。
   *
   * 引擎**不猜路径**、更不会因此写盘。E2EE 下这是「新设备还没重建 `did ↔ path` 映射」
   * 的信号：上层应当做一次全树解密重建（§10.2「新设备导入账号密钥」那一行）。
   * 明文模式下它基本不会出现（did 可逆）。
   */
  unknownDids: string[];
  /** 交到远端的检查点（`_local/device-<deviceId>`）；`null` 表示这次没提。 */
  checkpoint: string | null;
}

export interface SyncOnceInput {
  provider: SyncProvider;
  ledger: SyncLedger;
  deps: SyncEngineDeps;
  /**
   * **每一页**列树的最大条数（不是「本次同步最多看多少条」）。
   *
   * ⚠️ 语义在 P0 修复里改过：以前它是「列一次树的上限」，而引擎**只列一次**
   * ⇒ 远端超过该值（服务端默认 500）时，后面的文档**永远不会被看到**。
   * 现在它是分页大小，引擎会一直翻到 `truncated === false`。
   */
  maxFiles?: number;
  /**
   * 同时在飞的请求数。默认 8。
   *
   * 每篇笔记是一个独立 HTTP 请求，串行下一次往返（实测本机到远端 p50 ≈ 190ms）
   * 就是吞吐上限；并发 8 实测快 5.4 倍。但**不能无限开**：
   * 服务端按账号限流（`ACCOUNT_REQUESTS_PER_MINUTE`，默认 120/分钟），
   * 并发太高只会把请求堆成 429。
   */
  concurrency?: number;
  /**
   * **远端自上轮以来没有任何变化**（调用方已经用 `changes({since})` 问过，结果为空）。
   *
   * 为真时引擎**完全不列树**、也**不做拉取计划** —— 只把本地改动推上去。
   * 这是增量同步省下来的那一步：远端没动时，一次同步只剩「本地扫描 + 可能的推送」。
   *
   * ⚠️ 它必须由**真的查过 `changes` 且结果为空**的调用方给（`syncOnceIncremental`），
   * 不能凭「我上次刚同步过」猜 —— 猜错的方向是**漏拉**，那是数据丢失。
   */
  remoteUnchanged?: boolean;
  /** `remoteUnchanged` 时可以顺带把已有游标直接当检查点，省掉一次列树。 */
  cursorHint?: string | null;
  /**
   * **变更驱动**：只拿这一批「远端变了的路径」去比对，不列整棵树。
   *
   * `hash === null` = 远端**显式**删了它（`changes` 里的 `op: delete`）。
   * 传了它之后，引擎会拿账本里「没变的那些」拼出一棵**等价于整树**的树
   * （见 `buildPartialTree`），于是 `planPull` 一行都不用改 ——
   * 删除推断只可能落在「远端明确说删了」的那些路径上（§6.4 规则 7）。
   *
   * 拿不到完整信息时（did 反查不出路径 / 缺内容标识 / 变更太多）**不要**用它，
   * 让调用方退回 `fetchWholeTree()`。
   */
  partialRemote?: { path: string; hash: string | null }[];
  /** 当前时间（测试可注入，让账本里的 `syncedAt` 确定）。 */
  now?: () => number;
  /**
   * 逐文件进度（规划完成后 total 才确定；推/拉/删每完成一项回调一次）。
   * 给 UI 画进度条用 —— 第一轮全量同步几百个文件，没有它界面就是黑箱。
   */
  onProgress?: (progress: { done: number; total: number }) => void;
}

/**
 * 跑**一次**同步。
 *
 * 顺序刻意是「先算完全部计划 → 再动远端」：
 * 1. `listLocal` + `tree` 两次读取；
 * 2. `planPull`（避免做会白做的推送）；
 * 3. 执行推送、拉取、删除；
 * 4. 提交检查点。
 *
 * 任一步抛异常都**不会**留下半个账本 —— 账本是最后整体返回的，调用方拿不到返回值就不会落盘。
 * 但**已经写下去的远端数据不会回滚**（那是 CouchDB 的 revision tree 的职责：多一个
 * leaf 不算丢数据，§6.1 L1）。这一点如实记下：引擎不假装自己有事务。
 */
export async function syncOnce(input: SyncOnceInput): Promise<SyncOnceResult> {
  const { provider, deps } = input;
  const now = input.now ?? (() => Date.now());
  const ledger = input.ledger;
  const log = deps.log ?? (() => undefined);

  const localFiles = await deps.listLocal();
  const localByPath = new Map(localFiles.map((file) => [file.path, file]));

  /*
   * ★★ P0：列树**必须翻页取完**（这条以前是缺的，是最严重的多设备缺陷）。
   *
   * 服务端 `/v1/tree` 有分页上限（`clampLimit`，默认 500、最大 2000），超出时
   * 返回 `truncated: true`。旧实现只列**一页**就把结果当成整棵树，于是：
   *   - 远端文档数 > 一页时，新设备只拿到前 500 条，**剩下的永远不会来**
   *     （下一轮列树还是同一条页首，判「没变化」，于是永远不下载）；
   *   - `truncated` 还会让 `applyTruncationGuard()` **挂起全部删除**，
   *     所以「删除不传播」是恒定的，不是偶发。
   *
   * 实测（555 篇的笔记本、全新空目录、只改这一处）：修复前 `pulled: 499`，
   * 修复后 `pulled: 555`。所以这不是「优化」，是**正确性**。
   */
  const remoteUnchanged = input.remoteUnchanged === true;
  /*
   * 三条路，从最省到最稳：
   * 1. 远端一条都没变 → 不列树（`remoteUnchanged`）；
   * 2. 变了但不多、而且都认得出 → 只按变更比对（`partialRemote`）；
   * 3. 其余情况 → 老老实实翻页列整棵树。
   */
  const partial = input.remoteUnchanged === true || input.partialRemote === undefined
    ? null
    : buildPartialTree(input.partialRemote, ledger, deps.didOf);
  const tree = remoteUnchanged
    ? { entries: [] as ProviderTreeEntry[], truncated: false, cursor: input.cursorHint ?? null }
    : partial !== null
      ? partial
      : await fetchWholeTree(provider, input.maxFiles);
  log("tree", {
    entries: tree.entries.length,
    truncated: tree.truncated,
    skipped: remoteUnchanged,
    partial: partial !== null,
  });

  /*
   * ## `did → path` 的反查表**必须**由「已知路径 ∪ 本地扫描结果」现算
   *
   * 第一版这里犯了错：只拿 `ledger.bids` 建表。**新设备**（或刚加了同步的笔记本）账本
   * 是空的，于是远端树里每一个 did 都反查不到 → 退化成「远端全是新增、本地也全是新增」
   * → 两边各写一份、互不可见。测试当场抓到了（`pulled` 期望 1 实得 0）。
   *
   * 正确的来源是**调用方知道的全部路径**（`deps.knownPaths()`，它自己会并上账本）
   * 加上**本次本地扫描结果**。E2EE 下 did 不可逆（HMAC），所以「反查」本质上就是
   * 「把所有已知路径各算一次 did」—— 没有别的办法，也不该有别的东西。
   */
  const knownPaths = await deps.knownPaths();
  const didIndex = new Map<string, string>();
  for (const path of knownPaths) {
    const did = deps.didOf(path);
    if (!didIndex.has(did)) didIndex.set(did, path);
  }
  for (const file of localFiles) {
    const did = deps.didOf(file.path);
    if (!didIndex.has(did)) didIndex.set(did, file.path);
  }

  /*
   * 远端树按 **path** 参与 diff。`did → path` 有**两个**来源，按可靠性排序：
   *
   * 1. **本机已知路径**（`knownPaths ∪ 本地扫描`）—— 靠「把已知路径各算一次 did」反查。
   *    这是唯一在 E2EE 下也成立的办法。
   * 2. **provider 带回来的 `path`**（仅明文模式）—— 新设备/刚开同步时本机一个路径都没有，
   *    只靠第 1 条会把整棵树判成「认不出来」→ 两边各写一份、互不可见。
   *    明文模式下 `did` 是可逆的，所以服务端本来就看得见路径（§3.3），带回来没有额外泄露。
   *
   * 拿到的明文路径**必须过 `assertSafeRelative`**：它来自网络，不能因为「provider 说它安全」
   * 就直接拿去写盘（防一个被攻破/写错的服务端把文件写到库外）。
   *
   * `truncated` **必须**一路带下去（§6.4 规则 1）。
   */
  const unknownDids: string[] = [];
  const remoteEntries: { path: string; hash: string }[] = [];
  const rejectedPaths: string[] = [];
  for (const entry of tree.entries) {
    let path = didIndex.get(entry.did);
    if (path === undefined && entry.path !== undefined) {
      try {
        path = assertSafeRelative(entry.path);
      } catch {
        rejectedPaths.push(entry.path);
        continue;
      }
    }
    if (path === undefined) {
      // 认不出来的 did：**不猜路径**，如实报出（E2EE 下这是「本机映射还没重建」的信号）。
      unknownDids.push(entry.did);
      continue;
    }
    remoteEntries.push({ path, hash: entry.hash });
  }
  if (unknownDids.length > 0) log("tree", { unknownDids: unknownDids.length });
  if (rejectedPaths.length > 0) log("tree", { rejectedPaths: rejectedPaths.length });
  const remoteTree = { truncated: tree.truncated, entries: remoteEntries };
  const treeEntryByPath = new Map(remoteTree.entries.map((entry) => [entry.path, entry]));

  /*
   * 账本结构上已经满足 `BaselineLike`（`localHash` / `remoteHash` / `imported` 三个字段名相同，
   * 只是多带了 `bid` / `rev` / `syncedAt`）。这里做一次显式窄化，好处是 diff 那一层
   * **看不到** bid/rev —— 它只该关心「谁改没改」，不该有机会去动账本的其它字段。
   */
  const baselineView: BaselineLike = { files: ledger.files };
  const pushPlan = planPush(baselineView, localFiles);
  /*
   * ★ 远端没变时**不跑 `planPull`**。
   *
   * 为什么不是「拿空树去跑」：`planPull` 把「树里没有」解释成「远端删了它」，
   * 空树会让它把账本里每一条都判成待删 —— 那是灾难。所以这里直接给一个空计划。
   */
  const pullPlan = remoteUnchanged
    ? ({
        download: [] as { path: string; sha: string }[],
        removeLocal: [] as string[],
        conflicts: [] as { path: string; reason: "both-modified" | "deleted-locally-modified-remotely" | "deleted-remotely-modified-locally" }[],
      } as ReturnType<typeof planPull>)
    : planPull(baselineView, remoteTree, localFiles);

  const conflicts: EngineConflict[] = [];
  const pushConflicts: EngineConflict[] = [];
  const appliedPaths: string[] = [];
  let pushed = 0;
  let pulled = 0;
  /** 远端墓碑（本地删了 → 推上去）。 */
  let remoteDeleted = 0;
  /** 远端删了 → 删本地。 */
  let deleted = 0;

  /*
   * ## 与 `diff.ts` 的职责交界（一处容易混的地方，写清楚）
   *
   * `planPush` 的 `modified` 包含「两边都改了」的那些路径（它只看「本地变了没」）。
   * 而「两边都改」的正确处置是**列出、不推**（§6.2）。所以先把 `planPull` 判出的冲突路径
   * 从推送清单里摘掉 —— 否则引擎会把用户还没裁决的本地版本**直接覆盖到远端**。
   */
  const conflictedPaths = new Set(pullPlan.conflicts.map((item) => item.path));
  const pushAdded = pushPlan.added.filter((file) => !conflictedPaths.has(file.path));
  const pushModified = pushPlan.modified.filter((file) => !conflictedPaths.has(file.path));

  /*
   * 进度条：规划完成后总数即确定（推 + 拉 + 两类删除）。
   * 冲突路径**不计入**（它们不会被引擎动）。
   */
  const onProgress = input.onProgress;
  let progressDone = 0;
  const progressTotal =
    pushAdded.length +
    pushModified.length +
    pushPlan.deleted.length +
    pullPlan.download.length +
    pullPlan.removeLocal.length;
  const tick = (): void => onProgress?.({ done: progressDone, total: progressTotal });
  tick();

  for (const item of pullPlan.conflicts) {
    const local = localByPath.get(item.path);
    const remote = treeEntryByPath.get(item.path);
    conflicts.push({
      path: item.path,
      kind: item.reason,
      localId: local?.hash ?? null,
      remoteId: remote?.hash ?? null,
    });
    log("conflict", { path: item.path, reason: item.reason });
  }

  /* ------------------------------------------------------------------ 推送 */

  /*
   * ★ P1：**有界并发**推送。旧实现是 `for … await` —— 一次只有一个请求在飞，
   * 吞吐被单次往返（实测 p50 ≈ 190ms）钉死在 ~5 篇/秒。并发 8 实测 ~28 请求/秒。
   * 上限刻意压得比较低：服务端按账号限流，堆太多请求只会换来一片 429。
   */
  const concurrency = Math.max(1, Math.floor(input.concurrency ?? DEFAULT_SYNC_CONCURRENCY));
  await runBounded([...pushAdded, ...pushModified], concurrency, async (file) => {
    const did = deps.didOf(file.path);
    const known = ledger.files[file.path];
    const bytes = await deps.readLocal(file.path);
    const result = await provider.put({
      did,
      bytes,
      hash: file.hash,
      // CAS 依据 = 上次同步时**远端**那一版；`null` 表示本地认为远端还没有这一条。
      baseHash: known?.remoteHash ?? null,
    });
    if ("conflict" in result) {
      /*
       * 远端在我们列树之后前进了。**不重试、不强推**（§6.1 L1：leaf 不丢，让用户裁决）。
       * 把它并进冲突账本，并把账本的 `remoteHash` 更新成远端的当前值 ——
       * 否则下一次同步会拿一个过期的 CAS 依据再撞一次，陷入死循环。
       */
      const remoteEntry = result.conflict.current;
      const existing = ledger.files[file.path];
      ledger.files[file.path] = {
        bid: ledger.bids[file.path] ?? allocateBid(ledger, file.path),
        localHash: existing?.localHash ?? null,
        remoteHash: remoteEntry?.hash ?? null,
        rev: remoteEntry?.rev ?? null,
        imported: existing?.imported ?? true,
        syncedAt: now(),
      };
      pushConflicts.push({
        path: file.path,
        kind: "both-modified",
        localId: file.hash,
        remoteId: remoteEntry?.hash ?? null,
      });
      log("push", { path: file.path, conflict: true });
      return;
    }
    const bid = ledger.bids[file.path] ?? allocateBid(ledger, file.path);
    ledger.files[file.path] = {
      bid,
      localHash: file.hash,
      remoteHash: result.hash,
      rev: result.rev,
      imported: true,
      syncedAt: now(),
    };
    pushed += 1;
    progressDone += 1;
    tick();
    log("push", { path: file.path, bytes: file.bytes });
  });

  /* --------------------------------------- 推送删除（本地删了 → 远端墓碑） */

  /*
   * ⚠️ 这一轮原先**漏了**（测试当场抓到：A 删掉文件推上去之后，B 端什么都不知道）。
   *
   * `planPush().deleted` 的判据是「**账本里有**（`imported: true`，即我们物化过它）、
   * **本地扫描里没有**」—— 所以它只可能是「用户删了我们管着的这一条」，不可能是
   * 「没导入过的远端条目」（那些 `imported: false`，被 `planPush` 明确跳过）。
   * 把它转成远端墓碑既安全又**必须**：不发这个墓碑，另一端永远不会知道文件被删了
   * —— §6.4 规则 3 说的正是「丢掉一个 delete 会让文件复活」。
   *
   * 走 `provider.delete()`（**逻辑**删除、留墓碑），不是物理删。CAS 用账本里的
   * `remoteHash`：远端在我们列树之后被别人改过 → 返回冲突 → 不删，交用户裁决。
   */
  await runBounded(pushPlan.deleted, concurrency, async (path) => {
    const did = deps.didOf(path);
    const known = ledger.files[path];
    const result = await provider.delete({ did, baseHash: known?.remoteHash ?? null });
    if ("conflict" in result) {
      const current = result.conflict.current;
      if (known) ledger.files[path] = { ...known, remoteHash: current?.hash ?? known.remoteHash, rev: current?.rev ?? known.rev };
      pushConflicts.push({
        path,
        kind: "deleted-remotely-modified-locally",
        localId: null,
        remoteId: current?.hash ?? null,
      });
      log("delete", { path, conflict: true });
      return;
    }
    /*
     * 删成功之后**保留账本那一条**，只把 `localHash` 置空。
     *
     * 为什么不整条清掉：远端墓碑活得比 update 久（§6.4 规则 3），本地也该能回答
     * 「这条我们管过、现在没了」。留着一条 `localHash: null` 的记录代价极小，
     * 而清掉会让「删除」在本地完全没有痕迹。
     */
    const bid = ledger.bids[path] ?? allocateBid(ledger, path);
    ledger.files[path] = {
      bid,
      localHash: null,
      remoteHash: known?.remoteHash ?? null,
      rev: known?.rev ?? null,
      imported: true,
      syncedAt: now(),
    };
    remoteDeleted += 1;
    progressDone += 1;
    tick();
    log("delete", { path, remote: true });
  });

  /* ------------------------------------------------------------------ 拉取 */

  /*
   * ★ P1：拉取同样改为**有界并发**（与推送同一个理由：每篇一个请求，串行被往返钉死）。
   *
   * `deps.writeLocal` 与账本更新都在各 worker 内完成；账本写入是**同步**的，
   * 所以不会有两个 worker 交错改同一条。
   */
  /** 把一条拉取结果落到本地并记账（单条与批量两条路径共用这一份）。 */
  const applyPulled = async (item: { path: string; sha: string }, read: ProviderReadResult | null): Promise<void> => {
    if (read === null) {
      /*
       * 列树时还在、读的时候没了（另一端刚删）→ 不算错：留给**下一次同步**按
       * 「远端删除」处理。这里**不猜**（§6.1）。
       */
      log("pull", { path: item.path, vanished: true });
      return;
    }
    await deps.writeLocal(item.path, read.bytes);
    /*
     * ★ 基线以**磁盘上的字节**为准（`hashOfLocal`，与 `listLocal` 同一基准）。
     *   E2EE 下 `read.bytes` 是密文：直接 `hashOf(read.bytes)` 记出来的基线
     *   与下一次本地扫描永远对不上 —— 每一个拉下来的文件都会被重推一遍。
     *   见 `SyncEngineDeps.hashOfLocal` 的说明。
     */
    const hash = await deps.hashOfLocal(item.path);
    const bid = ledger.bids[item.path] ?? allocateBid(ledger, item.path);
    ledger.files[item.path] = {
      bid,
      localHash: hash,
      remoteHash: item.sha,
      rev: read.rev,
      imported: true,
      syncedAt: now(),
    };
    appliedPaths.push(item.path);
    pulled += 1;
    progressDone += 1;
    tick();
    log("pull", { path: item.path, bytes: read.bytes.byteLength });
  };

  /*
   * ★ **批量取**：provider 支持 `readMany` 时，把 50 条合成一个请求。
   *
   * 为什么值得：请求数 = 文件数时，吞吐被**往返延迟**钉死（实测 555 篇要 555 次往返）。
   * 批量之后 555 篇 = 12 个请求 —— 首次全量从十几秒降到几秒量级，
   * 而且限流压力也小了一个数量级。
   *
   * 为什么要有退路：老服务端没有这个端点（404）、或单条超限（413）。
   * 那时**逐条退回**，绝不让整轮同步失败 —— 批量只是优化。
   */
  if (typeof provider.readMany === "function" && pullPlan.download.length > 1) {
    const chunks: typeof pullPlan.download[] = [];
    for (let index = 0; index < pullPlan.download.length; index += PULL_BATCH_SIZE) {
      chunks.push(pullPlan.download.slice(index, index + PULL_BATCH_SIZE));
    }
    await runBounded(chunks, concurrency, async (items) => {
      const dids = items.map((item) => deps.didOf(item.path));
      let results: Map<string, ProviderReadResult>;
      try {
        results = await provider.readMany!(dids);
      } catch (error) {
        log("pull", { batchFailed: true, reason: error instanceof Error ? error.message : String(error) });
        results = new Map();
        for (const did of dids) {
          const single = await provider.read(did);
          if (single !== null) results.set(did, single);
        }
      }
      for (let index = 0; index < items.length; index += 1) {
        await applyPulled(items[index]!, results.get(dids[index]!) ?? null);
      }
    });
  } else {
    await runBounded(pullPlan.download, concurrency, async (item) => {
      await applyPulled(item, await provider.read(deps.didOf(item.path)));
    });
  }

  /* -------------------------------------------------------------- 删除（拉取侧） */

  const guarded = applyTruncationGuard(pullPlan, tree.truncated);
  const totalKnown = Object.values(ledger.files).filter((file) => file.imported).length;
  let blockedDeletes = 0;
  let deletionGuardMessage: string | null = null;

  if (guarded.removeLocal.length > 0) {
    const budgetMessage = assertDeletionBudget(totalKnown, guarded.removeLocal.length);
    if (budgetMessage !== null) {
      // 一条都不删（不是「删一部分」）—— 半删状态比不删更难收拾。
      blockedDeletes = guarded.removeLocal.length;
      deletionGuardMessage = budgetMessage;
      log("guard", { blockedDeletes, totalKnown });
    } else {
      for (const path of guarded.removeLocal) {
        /*
         * 只删**我们物化过的笔记/图片**。`planPull` 已经用 `isMaterializable` 过滤过
         * 远端条目的下载，但删除这一侧还要再判一次：目录、附件目录这类不该被「远端没有」
         * 推断成删除。
         */
        if (!isMarkdownPath(path)) continue;
        try {
          await deps.removeLocal(path);
          const existing = ledger.files[path];
          if (existing) delete ledger.files[path];
          appliedPaths.push(path);
          deleted += 1;
          progressDone += 1;
          tick();
          log("delete", { path });
        } catch (error) {
          console.warn("[opennote] 同步：删本地这一条失败", path, error);
        }
      }
    }
  }

  /* ---------------------------------------------------------------- 检查点 */

  /*
   * 检查点：**必须重新取一次当前游标**，不能用 `tree.cursor`。
   *
   * `tree.cursor` 是「列树那一刻」的序号，早于我们刚刚做的写入；直接拿它当检查点等于
   * 告诉远端「我读到这里为止」，而实际上我们**已经产生了**后面的写入 ——
   * 下一次 `changes(since: 那个 cursor)` 会把我们自己的写当成「别人的变更」再拉一遍。
   * （第一版就是这么写的，测试断言 `checkpoints()` 期望新游标、实得旧游标时抓到。）
   *
   * 重新 `tree({ limit: 1 })` 取一次是最省事的做法：它只读一条，且 provider 保证
   * 返回「此刻」的游标。真实 `/v1/tree` 上是同一件事（服务端返回当前 `last_seq`）。
   */
  let checkpoint: string | null = null;
  try {
    /*
     * 远端没变、而且这一轮**什么都没写上去** ⇒ `cursorHint` 就是最新游标，
     * 直接用它，省掉一次列树。写了一点点的话它已经过期，只能重新问一次。
     */
    if (input.cursorHint && pushed === 0 && remoteDeleted === 0) {
      checkpoint = input.cursorHint;
      await provider.checkpoint(checkpoint);
      log("checkpoint", { cursor: checkpoint, reused: true });
    } else {
      const after = await provider.tree({ limit: 1 });
      if (after.cursor !== null) {
        await provider.checkpoint(after.cursor);
        checkpoint = after.cursor;
        log("checkpoint", { cursor: after.cursor });
      }
    }
  } catch (error) {
    // 检查点失败不该让整次同步失败：数据已经同步完了，游标下次再提。
    console.warn("[opennote] 同步：提交检查点失败", error);
    log("checkpoint", { failed: true });
  }

  return {
    pushed,
    remoteDeleted,
    pulled,
    pushConflicts,
    conflicts,
    deleted,
    suspendedDeletes: guarded.suspendedDeletes,
    treeTruncated: tree.truncated,
    blockedDeletes,
    deletionGuardMessage,
    resynced: false,
    ledger,
    appliedPaths,
    unknownDids,
    checkpoint,
  };
}

/** 分配一个新的 bid（`state.ts` 的分配逻辑在这里用一次，保持 `nextBid` 单调）。 */
function allocateBid(ledger: SyncLedger, path: string): number {
  const bid = ledger.nextBid;
  ledger.nextBid += 1;
  ledger.bids[path] = bid;
  return bid;
}

/**
 * 增量同步（`changes()` 驱动）：先看远端有没有变，再决定要不要列树。
 *
 * `changes()` 返回 `resync: true`（游标过期）时**退化成一次全树同步** —— 这正是
 * Joplin 的 `resyncRequired` 语义（§6.4 规则 2），也是这里唯一「降级」的地方。
 *
 * ⚠️ **不要把 `changes()` 当事件流**：它是**部分有序**的，官方明确顺序不保证并要求客户端
 * **幂等**（§4.7 设计点 5）。所以这里只拿它回答一个问题：「远端动过没有」。
 * 动了 → 走一次全树比对（`planPush`/`planPull` 本来就是全树比对，天然幂等）。
 */
export async function syncOnceIncremental(input: SyncOnceInput & { since?: string | null }): Promise<SyncOnceResult> {
  const { provider, deps } = input;
  const log = deps.log ?? (() => undefined);
  const since = input.since ?? null;

  /*
   * 没有游标（第一次同步 / 重装 / 缓存被清）⇒ 只能全树。
   * 这条路是**正确性优先**的：宁可多列一次树，也不能凭空的「我记得同步过」去跳过。
   */
  if (since === null) return syncOnce(input);

  let changes;
  try {
    changes = await provider.changes({ since });
  } catch (error) {
    /*
     * `changes` 挂了就退回全树 —— 它是**优化**，不该让同步失败。
     * 但「密钥被轮换 / 被禁用」是另一回事：那必须往上抛，让状态栏说准
     * （§1.5 代价 2 的指定文案）。所以只有这一类继续抛。
     */
    if (error instanceof SyncProviderError && (error.code === "rotated" || error.code === "forbidden")) throw error;
    log("changes", { failed: true });
    return syncOnce(input);
  }
  log("changes", { count: changes.changes.length, resync: changes.resync === true });

  if (changes.resync === true) {
    // 游标过期（远端流水被裁剪）⇒ 退化成全树比对（§6.4 规则 2）。
    const result = await syncOnce(input);
    return { ...result, resynced: true };
  }

  if (changes.changes.length === 0) {
    /*
     * ★ 远端一个变更都没有 ⇒ **不列树、不做拉取计划**，只把本地改动推上去。
     *
     * 这是「改一个字也要把 500 篇的树拉一遍」的终点：远端没动时，一次同步只剩
     * 「本地扫描（有哈希缓存，只读改了的那一个）+ 可能的推送」。
     *
     * 注意这里**不能**顺手跳过同步：本地改动仍然要推（否则「离线编辑 30 分钟 →
     * 恢复」这条场景里，本地改动会一直上不去）。
     */
    const result = await syncOnce({ ...input, remoteUnchanged: true, cursorHint: changes.cursor });
    return { ...result, resynced: false };
  }

  /*
   * ★ **变更驱动**：远端只动了几条时，不再整树比对。
   *
   * 把「变了的 did」翻成路径（明文模式下服务端直接带回来，E2EE 下靠本机反查表），
   * 再让 `buildPartialTree()` 用它拼出一棵与整树等价的树 —— `planPull()` 一行不改，
   * 而删除只可能来自远端**显式**的墓碑（§6.4 规则 7）。
   *
   * 任何一步拿不准（这一页没装完 / 认不出 did / 缺内容标识）都退回整树：
   * 方向永远是「宁可多拉一遍，不可漏拉一条」。
   */
  if (changes.truncated !== true) {
    const partial = await resolveChangedPaths(changes.changes, deps);
    if (partial !== null) {
      const result = await syncOnce({ ...input, partialRemote: partial, cursorHint: changes.cursor });
      return { ...result, resynced: false };
    }
    log("changes", { partialUnavailable: true });
  } else {
    log("changes", { truncated: true });
  }

  return syncOnce(input);
}

/* ============================================================================
   分页与并发（P0/P1 修复的落点）
   ============================================================================ */

/** 一页列树最多取多少条。服务端 `clampLimit` 的上限是 2000。 */
export const TREE_PAGE_SIZE = 1000;

/**
 * 翻页上限（防御无限循环）。
 *
 * 1000 条/页 × 50 页 = 5 万条 —— 远超单个笔记本的合理规模（本项目护栏
 * `MAX_SYNC_ENTRIES` 是 2 万）。真的撞到这里说明服务端没有前进（`startKey`
 * 语义被改坏），此时**如实报 truncated**，让删除推断继续被挂起，而不是假装取全了。
 */
export const TREE_MAX_PAGES = 50;

/**
 * **把整棵远端树取完**（按 `startKey` 翻页直到 `truncated === false`）。
 *
 * 为什么必须在这里做、而不是在 provider 里做：provider 的注释写得很清楚
 * （`providers/opennote.ts` 模块头 ③）—— `truncated` 是「禁止推断删除」的信号，
 * provider 若偷偷循环取完就把这个信号抹掉了。**取完并如实上报最终结论**是调用方的职责。
 *
 * 去重按 `did`：服务端 `startkey` 是**闭区间**，下一页的第一条就是上一页的最后一条。
 */
export async function fetchWholeTree(
  provider: SyncProvider,
  pageSize: number | undefined,
): Promise<{ entries: ProviderTreeEntry[]; truncated: boolean; cursor: string | null }> {
  const limit = Math.min(Math.max(pageSize ?? TREE_PAGE_SIZE, 1), 2000);
  const byDid = new Map<string, ProviderTreeEntry>();
  let cursor: string | null = null;
  let startKey: string | undefined;

  for (let page = 0; page < TREE_MAX_PAGES; page += 1) {
    const tree = await provider.tree({ limit, ...(startKey === undefined ? {} : { startKey }) });
    cursor = tree.cursor;
    for (const entry of tree.entries) byDid.set(entry.did, entry);

    if (!tree.truncated) return { entries: [...byDid.values()], truncated: false, cursor };

    const last = tree.entries.at(-1);
    // 空页却说 truncated：服务端状态可疑，如实报「没取全」，让删除继续被挂起。
    if (!last) return { entries: [...byDid.values()], truncated: true, cursor };
    // 没前进（startkey 语义被改坏）：同上，宁可挂起删除也不猜。
    if (startKey === last.did) return { entries: [...byDid.values()], truncated: true, cursor };
    startKey = last.did;
  }

  return { entries: [...byDid.values()], truncated: true, cursor };
}

/** 默认并发度（见 `SyncOnceInput.concurrency` 的说明：8 是实测的性价比点）。 */
export const DEFAULT_SYNC_CONCURRENCY = 8;

/**
 * 一次批量取多少条正文（见 `/v1/files`）。
 *
 * 50 是折中：再大就会让单条响应被 base64 撑到几 MB（大附件场景），
 * 而再小就回到了「请求数接近文件数」。
 */
export const PULL_BATCH_SIZE = 50;

/**
 * 变更超过这个条数，就不走「变更驱动」而直接列整树。
 *
 * 理由很实在：逐条比对要 1 次 `changes` + N 条下载，而整树是 1~2 个分页请求；
 * 变更很多时**整树反而更便宜**，而且没有「拼树」这一层推理。
 */
export const PARTIAL_CHANGE_LIMIT = 200;
/**
 * 由「远端变了的路径」拼出一棵**与整树等价**的树。
 *
 * ## 它凭什么等价
 *
 * 账本里记着每条路径上次同步时的 `remoteHash` —— 那正是「如果它没变，现在应该是什么」。
 * 所以：**账本里没进变更集的那些，用账本的 `remoteHash` 填回去**，
 * 变更集里的那几条用新值（或干脆不放，表示远端删了）。
 * 拼出来的树喂给 `planPull()`，判据与整树比对**逐条一致**，而代价只有变更条数量级。
 *
 * 这么做还有一个比「省流量」更重要的好处：
 * **删除只可能来自「远端显式说它删了」**（`changes` 的 `op: delete`），
 * 而不是「我列的树里没有它」—— 后者正是最危险的误删来源（§6.4 规则 7）。
 *
 * ## 什么时候**不能**用（返回 `null`，调用方退回整树）
 *
 * 只要有一条信息不全，就必须整树。宁可慢一次，不可漏一条：
 * 1. 账本里有 `imported && remoteHash === null` 的条目 —— 拼树时必须给它一个
 *    「没变」的标识，而它的远端标识**不是字符串**。硬塞一个假值会让
 *    `planPull` 判成「远端删了」→ **删本地文件**。这一条是硬风险，直接放弃。
 * 2. 变更集为空（调用方不该走到这里）或过大（> 200 条时逐条比对不如整树）。
 */
/**
 * 把 `changes` 里的 did 翻成**本机路径**，得到 `buildPartialTree()` 要的输入。
 *
 * 翻不出来就返回 `null`（调用方退回整树）。三种翻不出来的情况都必须放弃：
 * 1. `did` 既不在本机已知路径里、服务端也没带 `path`（E2EE 下常见）；
 * 2. 是更新但**没有内容标识** —— 那就无从判断「内容到底变没变」，
 *    硬拉一遍会把「只是 rev 变了」的文件也下载下来（每次别人同步都会触发）；
 * 3. 同一条路径在同一批里出现两次且标识不一致（远端重放过）—— 不猜，整树。
 */
export async function resolveChangedPaths(
  changes: { did: string; op: "add" | "update" | "delete"; path?: string; hash?: string }[],
  deps: SyncEngineDeps,
): Promise<{ path: string; hash: string | null }[] | null> {
  const knownPaths = await deps.knownPaths();
  const byDid = new Map<string, string>();
  for (const path of knownPaths) {
    const did = deps.didOf(path);
    if (!byDid.has(did)) byDid.set(did, path);
  }

  const seen = new Map<string, string | null>();
  for (const change of changes) {
    const path = change.path ?? byDid.get(change.did);
    if (path === undefined) return null;
    const hash = change.op === "delete" ? null : change.hash;
    if (change.op !== "delete" && hash === undefined) return null;
    const value = hash === undefined ? null : hash;
    if (seen.has(path)) {
      if (seen.get(path) !== value) return null; // 同一路径两个不同结论：不猜
      continue;
    }
    seen.set(path, value);
  }
  return [...seen.entries()].map(([path, hash]) => ({ path, hash }));
}
export function buildPartialTree(
  changed: { path: string; hash: string | null }[],
  ledger: SyncLedger,
  didOf: (path: string) => string,
): { entries: ProviderTreeEntry[]; truncated: boolean; cursor: string | null } | null {
  if (changed.length === 0 || changed.length > PARTIAL_CHANGE_LIMIT) return null;
  // 变更集里出现「远端标识不是字符串」的条目 ⇒ 拼树不成立（见模块头第 1 条）。
  for (const file of Object.values(ledger.files)) {
    if (file.imported && file.remoteHash === null) return null;
  }

  const changedByPath = new Map<string, string | null>();
  for (const item of changed) changedByPath.set(item.path, item.hash);

  const entries: ProviderTreeEntry[] = [];
  for (const [path, file] of Object.entries(ledger.files)) {
    if (!file.imported) continue; // 只记账的条目：同步永不触碰它（与 planPull 的判据一致）
    if (file.remoteHash === null) continue;
    if (changedByPath.has(path)) continue;
    // ★ `path` 必须带上：引擎稍后要把它从 did 反查回路径，而反查表只含「已知路径 ∪ 本地扫描」。
    //   新建/清空过的设备上那张表可能是空的 —— 那时没有 `path` 的条目会被当成 unknownDids 丢掉。
    entries.push({ did: didOf(path), path, hash: file.remoteHash, rev: file.rev ?? "" });
  }
  for (const [path, hash] of changedByPath) {
    if (hash === null) continue; // 远端删了 ⇒ 不进树 ⇒ planPull 走「远端删除」分支
    const known = ledger.files[path];
    // 只在账本里记账、从未物化过的路径：保持原语义，永远不因它落地。
    if (known !== undefined && !known.imported) continue;
    entries.push({ did: didOf(path), path, hash, rev: "" });
  }
  return { entries, truncated: false, cursor: null };
}

/**
 * **有界并发**跑一批条目：同一时刻最多 `limit` 个 worker 在飞，每条只被处理一次。
 *
 * 为什么不用 `Promise.all(items.map())`：那会把整批同时发出去。500 篇笔记
 * 一次性打 500 个请求，撞上服务端的账号限流（120/分钟）只会换来一片 429。
 *
 * 为什么安全：JS 单线程 + 每个 worker 的「读账本 → 写账本」之间**没有 await**
 * （写账本发生在响应回来之后的同步代码里），所以不会有两个 worker 同时改同一条。
 */
export async function runBounded<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        await worker(items[index]!, index);
      }
    }),
  );
}

