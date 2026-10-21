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
import { SyncProviderError, type SyncProvider } from "./provider-types";

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
  /** 本次同步的最大文件数（与扫描的 `maxFiles` 一致）。 */
  maxFiles?: number;
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

  const tree = await provider.tree({ limit: input.maxFiles });
  log("tree", { entries: tree.entries.length, truncated: tree.truncated });

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
  const pullPlan = planPull(baselineView, remoteTree, localFiles);

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

  for (const file of [...pushAdded, ...pushModified]) {
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
      continue;
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
  }

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
  for (const path of pushPlan.deleted) {
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
      continue;
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
  }

  /* ------------------------------------------------------------------ 拉取 */

  for (const item of pullPlan.download) {
    const did = deps.didOf(item.path);
    const read = await provider.read(did);
    if (read === null) {
      /*
       * 列树时还在、读的时候没了（另一端刚删）→ 不算错：留给**下一次同步**按
       * 「远端删除」处理。这里**不猜**（§6.1）。
       */
      log("pull", { path: item.path, vanished: true });
      continue;
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
    const after = await provider.tree({ limit: 1 });
    if (after.cursor !== null) {
      await provider.checkpoint(after.cursor);
      checkpoint = after.cursor;
      log("checkpoint", { cursor: after.cursor });
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
  let changes;
  try {
    changes = await provider.changes({ since: input.since ?? null });
  } catch (error) {
    if (error instanceof SyncProviderError && error.code === "not-found") {
      // provider 不支持增量（或库刚建）：退回全树同步。
      log("changes", { unsupported: true });
      return syncOnce(input);
    }
    throw error;
  }
  log("changes", { count: changes.changes.length, resync: changes.resync === true });

  if (changes.resync === true) {
    const result = await syncOnce(input);
    return { ...result, resynced: true };
  }
  if (changes.changes.length === 0) {
    // 远端一个变更都没有 → 不必列树。但**本地改动仍然要推**，所以还是要跑一次
    // （否则「离线编辑 30 分钟 → 恢复」这条场景里，本地改动会一直不上去）。
    return syncOnce(input);
  }
  return syncOnce(input);
}
