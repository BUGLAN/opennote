/**
 * 笔记本置备（**幂等**）与置备状态核对（`docs/执行-三端同步…` §4.5、§3.2）。
 *
 * ## 五步，且**任一步失败就回滚**
 *
 * ```
 * 创建笔记本：
 *   1. 生成 notebookId = uuid, dbName = 'nb-' + uuid（去连字符）
 *   2. INSERT notebooks(...) + INSERT memberships(owner)      ← 在 SQLite 事务里
 *   3. CouchDB 置备（admin 凭据，**仅此一次**）：
 *      a. PUT /{dbName}                    建库（409 = 已存在则跳过）
 *      b. PUT /{dbName}/_security          只留 sync 服务账号
 *      c. PUT /{dbName}/_design/opennote   views.by_path + validate_doc_update
 *      d. PUT /{dbName}/_revs_limit        → 1000
 *      e. PUT /{dbName}/syncinfo           { protocolVersion, cryptoMode, createdAt }
 *   4. 回滚：第 3 步任一步失败 → 删库 + 删 notebooks 行（**不留半个笔记本**）
 * ```
 *
 * 「不留半个笔记本」为什么重要：一个「SQLite 里有行、CouchDB 里没有库」的笔记本会让
 * 所有同步请求 500，而且**看起来**像数据丢了。宁可从未创建过。
 *
 * ## 幂等（重入安全）
 *
 * 置备可能被重跑（部署脚本、迁移）。所以每一步都设计成**可重复执行**：
 * 建库遇 409 视为成功；`_security`/`_revs_limit`/`syncinfo` 是全覆盖写；
 * `_design` 只在**不存在**时建（见下）。
 *
 * ## ⚠️ 一条反直觉但刻意的决定：`_design` 被手工删掉后**不自动重建**
 *
 * §4.5 的验收原文：「手工删掉 `_design` 后控制台应能**发现不一致并提示**
 * （**不自动重建**——会掩盖人为误删）」。
 *
 * 所以置备与核对是**两个**动作：
 *   - `provisionNotebook()`：只在**首次创建**时跑，建 `_design`；
 *   - `inspectNotebook()`：**只读**，报告每一项是否就位，**绝不写**。
 *
 * 把这两件事混起来（「每次同步顺手补一下 `_design`」）会把一次人为误删变成静默自愈，
 * 而那正是「第二道防线被悄悄拿走」最危险的样子。
 */

import type { CryptoMode } from "../../shared/contract";
import type { CouchClient } from "./couch/client";
import { DESIGN_DOC_ID, buildDesignDoc, buildSecurityDoc, buildSyncInfo } from "./couch/design";

/** §3.10：`_revs_limit` 保持默认 1000 —— 调小会让三方合并失去共同祖先。 */
export const DEFAULT_REVS_LIMIT = 1000;

export interface ProvisionInput {
  /** 走 **admin** 凭据（§4.5：只有建库/改 `_design` 用它）。 */
  couch: CouchClient;
  dbName: string;
  /** `_security` 里唯一允许的成员名（`sync` 的运行时账号）。 */
  syncUser: string;
  protocolVersion: number;
  cryptoMode: CryptoMode;
  maxFileBytes: number;
  /** 覆盖时间戳（测试用）。 */
  createdAt?: string;
}

export interface ProvisionResult {
  /** 这一次真的建了库（false = 已经存在，幂等跳过）。 */
  databaseCreated: boolean;
  /** 这一次真的建了 `_design`（false = 已经存在）。 */
  designCreated: boolean;
}

export class ProvisioningError extends Error {
  constructor(
    message: string,
    /** 失败发生在哪一步（回滚日志与运维排查用）。 */
    readonly step: string,
    /** 触发回滚的原始错误。 */
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ProvisioningError";
  }
}

/**
 * 跑置备的五步。**失败时把已经建出来的东西删掉**（删库），然后抛出带 `step` 的错误。
 *
 * 注意：**SQLite 那两行（notebooks / memberships）由调用方在事务里负责回滚** ——
 * 这个函数不碰 SQLite，于是「回滚」这件事在两层上各自完整、互不猜测。
 */
export async function provisionNotebook(input: ProvisionInput): Promise<ProvisionResult> {
  const { couch, dbName } = input;
  let step = "create-database";
  let databaseCreated = false;

  try {
    databaseCreated = await couch.createDatabase(dbName);

    step = "security";
    await couch.putSecurity(dbName, buildSecurityDoc({ syncUser: input.syncUser }));

    step = "design";
    const design = buildDesignDoc({ maxBytes: input.maxFileBytes });
    const { created } = await couch.putDesignDoc(dbName, "opennote", design);
    // `_design` 已存在时**不覆盖**（§4.5 验收：不自动重建）。
    // 但首次创建必须真的建出来，否则第二道防线根本没上车。
    if (!created) {
      const existing = await couch.getDoc(dbName, DESIGN_DOC_ID);
      if (!existing) throw new Error("putDesignDoc 说已存在，但读回来是 null");
    }

    step = "revs-limit";
    await couch.putRevsLimit(dbName, DEFAULT_REVS_LIMIT);

    step = "syncinfo";
    const syncInfo = buildSyncInfo({
      protocolVersion: input.protocolVersion,
      cryptoMode: input.cryptoMode,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    });
    const write = await couch.putDoc(dbName, { _id: "syncinfo", ...syncInfo }, { baseRev: null });
    if ("conflict" in write) {
      // `syncinfo` 已存在：**不覆盖**（协议/加密模式是既成事实，覆盖会让旧客户端悄悄失配）。
      const current = write.current;
      if (!current) throw new Error("syncinfo 冲突但读不到当前值");
    }

    return { databaseCreated, designCreated: created };
  } catch (error) {
    /*
     * 回滚：**只在这一次真的建了库时**删。如果库本来就在（重入），删掉它会毁掉
     * 一个正在用的笔记本 —— 那比「置备不完整」严重得多。
     */
    if (databaseCreated) {
      try {
        await couch.deleteDatabase(dbName);
      } catch (rollbackError) {
        // 回滚失败要如实说出来（不能吞）：它会留下一个半成品库，需要人工处理。
        throw new ProvisioningError(
          `置备在「${step}」失败，且**回滚删库也失败**：${String(rollbackError)}。` +
            `数据库 ${dbName} 可能残留，需要人工检查。`,
          step,
          error,
        );
      }
    }
    throw new ProvisioningError(`置备在「${step}」失败${databaseCreated ? "（已回滚删库）" : "（库非本次创建，未回滚）"}：${String(error)}`, step, error);
  }
}

/** 置备核对结果（**只读**，控制台据此提示不一致）。 */
export interface NotebookInspection {
  databaseExists: boolean;
  designExists: boolean;
  /** `_design` 里是否真的有 `by_path` 与 `validate_doc_update`（只有前者不够）。 */
  designComplete: boolean;
  revsLimit: number | null;
  revsLimitOk: boolean;
  syncInfoExists: boolean;
  /** `syncinfo` 里的协议版本/加密模式（与期望不一致时控制台要提示）。 */
  syncInfo: { protocolVersion: number | null; cryptoMode: string | null };
  /** 全部就位。 */
  healthy: boolean;
  /** 需要人工处理的问题（**已翻译成人话**，控制台直接显示）。 */
  problems: string[];
}

/**
 * **只读**核对一个库的置备状态。
 *
 * 这个函数**绝不写任何东西** —— 理由见模块头（「不自动重建」）。
 * 它把「哪里不一致」翻译成人话，好让控制台直接显示而不是让运维去猜。
 */
export async function inspectNotebook(
  couch: CouchClient,
  dbName: string,
  expected: { protocolVersion: number; cryptoMode: CryptoMode; revsLimit?: number },
): Promise<NotebookInspection> {
  const problems: string[] = [];
  const expectedRevsLimit = expected.revsLimit ?? DEFAULT_REVS_LIMIT;

  const databaseExists = await couch.databaseExists(dbName);
  if (!databaseExists) {
    return {
      databaseExists: false,
      designExists: false,
      designComplete: false,
      revsLimit: null,
      revsLimitOk: false,
      syncInfoExists: false,
      syncInfo: { protocolVersion: null, cryptoMode: null },
      healthy: false,
      problems: [`库 ${dbName} 不存在（笔记数据可能已经丢失，或这个笔记本从未成功置备过）`],
    };
  }

  const design = await couch.getDoc(dbName, DESIGN_DOC_ID);
  const designExists = design !== null;
  const views = (design?.views ?? {}) as Record<string, unknown>;
  const designComplete = designExists && typeof views.by_path === "object" && typeof design?.validate_doc_update === "string";
  if (!designExists) {
    problems.push("_design/opennote 不存在 —— 第二道防线（validate_doc_update）与列树 view 都没上车；**不会自动重建**，请人工确认是谁删的");
  } else if (!designComplete) {
    problems.push("_design/opennote 存在但不完整（缺 by_path 或 validate_doc_update）—— 同样不会自动重建");
  }

  const revsLimit = await couch.getRevsLimit(dbName);
  const revsLimitOk = revsLimit === expectedRevsLimit;
  if (!revsLimitOk) {
    // 只提示，不修：调小 _revs_limit 会让三方合并失去共同祖先（§3.10），不该被静默改回去。
    problems.push(`_revs_limit 是 ${revsLimit ?? "未知"}，期望 ${expectedRevsLimit}（调小会让三方合并失去共同祖先）`);
  }

  const syncInfoDoc = await couch.getDoc(dbName, "syncinfo");
  const syncInfoExists = syncInfoDoc !== null;
  const actualProtocol = typeof syncInfoDoc?.protocolVersion === "number" ? (syncInfoDoc.protocolVersion as number) : null;
  const actualMode = typeof syncInfoDoc?.cryptoMode === "string" ? (syncInfoDoc.cryptoMode as string) : null;
  if (!syncInfoExists) {
    problems.push("syncinfo 不存在 —— 客户端无法用它做协议/加密模式的双重闸门");
  } else {
    if (actualProtocol !== expected.protocolVersion) {
      problems.push(`syncinfo.protocolVersion 是 ${actualProtocol ?? "未知"}，期望 ${expected.protocolVersion}`);
    }
    if (actualMode !== expected.cryptoMode) {
      problems.push(`syncinfo.cryptoMode 是 ${actualMode ?? "未知"}，期望 ${expected.cryptoMode}`);
    }
  }

  return {
    databaseExists,
    designExists,
    designComplete,
    revsLimit,
    revsLimitOk,
    syncInfoExists,
    syncInfo: { protocolVersion: actualProtocol, cryptoMode: actualMode },
    healthy: problems.length === 0,
    problems,
  };
}
