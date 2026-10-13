/**
 * 共享夹具驱动：**同一批 JSON 用例喂给两份路径实现**
 * （`docs/执行-三端同步-密钥即身份-2026-10-13.md` §1.6、§10.1 F1、附录 A.1）。
 *
 * ## 夹具在单仓下的**收窄后职责**
 *
 * v7（分仓）时夹具是「防跨仓漂移的基础设施」，客户端仓与服务端仓各跑一遍。单仓之后
 * 客户端与服务端已经是**同一份 TS**，所以夹具只剩一个职责：
 *
 * > 压住 **`shared/paths.ts`（TS）** 与 **`_design/opennote` 的 `validate_doc_update`（JS）**
 * > 这一个接缝 —— 那份 JS 跑在 CouchDB 内部的引擎里，既不是 TS 也不能 import 任何东西。
 *
 * 这也是为什么**必须**有夹具：它是单仓下唯一无法靠类型系统消除的接缝。
 *
 * ## 谁读它
 *
 * | 读者 | 怎么用 |
 * | --- | --- |
 * | `shared/fixtures.test.ts` | 断言 `shared/paths.ts` 对每条用例的判定 == 期望 |
 * | `server/src/couch/design.test.ts` | 断言 `_design` 的 JS 对每条用例的判定 == 期望 |
 *
 * 两边都从**同一个文件**读，所以「改了一边忘了另一边」必然红。
 */

import type { CryptoMode } from "../contract";

export interface PathRuleCase {
  id: string;
  path: string;
  expect: "accept" | "reject";
  why: string;
}

export const PATH_RULES_FIXTURE = "shared/fixtures/path-rules.cases.json";

/** 一份 `/v1/*` 端点的请求/响应样本（§10.1 F2：作为**行为样本与文档**）。 */
export interface ApiFixture {
  endpoint: string;
  method: string;
  /** 说明这条样本要固定住哪个形状。 */
  why: string;
  request?: unknown;
  response: unknown;
}

export const API_FIXTURE_DIR = "shared/fixtures/api";

/** 夹具里出现过的 `cryptoMode`（诊断用：确保两种模式都被覆盖到）。 */
export const FIXTURE_CRYPTO_MODES: readonly CryptoMode[] = ["none", "user-key"];
