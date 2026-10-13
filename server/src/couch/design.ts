/**
 * 每库的固定文档生成：`_design/opennote`、`syncinfo`、`_security`（`docs/执行-三端同步…` §3.2、§3.6、§3.8、§4.5）。
 *
 * ## 这个文件里有一份**必须存在**的「第二实现」
 *
 * `validate_doc_update` 跑在 **CouchDB 内部的 JS 引擎**里：**既不是 TS，也不能 import
 * `shared/paths.ts`**。所以路径规则在服务端侧必然有两份实现：
 *
 * | 份数 | 在哪 | 靠什么保证一致 |
 * | --- | --- | --- |
 * | 1 | `shared/paths.ts`（TS，全部逻辑都在这里） | 类型系统 + 单仓共用 |
 * | 2 | **本文件的 `VALIDATE_DOC_UPDATE_SOURCE`（JS 字符串）** | `shared/fixtures/path-rules.cases.json` 双跑（§10.1 F1） |
 *
 * 这是单仓下**唯一**无法靠类型系统消除的接缝，所以夹具不是可选项（§1.6）。
 *
 * ### 为了让「双跑」能真的跑起来，JS 里有两个刻意的写法
 *
 * 1. **不用 `startsWith` / `includes` / 模板串**这类新旧引擎有差异的东西，只用
 *    `charAt` / `indexOf` / 正则——CouchDB 打包的 JS 引擎版本不由我们决定（U1/U2）。
 * 2. 规则写成一个**纯函数** `opennoteValidateDoc(newDoc, oldDoc, userCtx, secObj)`，
 *    并在末尾把它导出到 `module.exports` 之外还能被 `eval` 拿出来 —— 于是
 *    `server/src/design.test.ts` 可以 `new Function()` 取出它、用同一批用例跑一遍。
 *
 * ### 为什么需要第二道防线（§3.8）
 *
 * 它防的是「拿到 `sync` 的 CouchDB 凭据**绕过 Node 直接写库**」。所以它**不能**相信
 * 调用方已经校验过路径 —— 它自己再校验一遍，且**拒绝**而不是告警。
 *
 * ⚠️ **模式 B（E2EE）下它看不到明文路径**，只能校验 `did` 的形状与「`path`/`epath` 有其一」。
 * 这是 E2EE 的固有代价，如实写在文档里（§3.8 防线 1 的 ⚠️）。
 */

import type { CryptoMode } from "../../../shared/contract";

/** 设计文档的 id（CouchDB 里 `_design/` 前缀是保留的）。 */
export const DESIGN_DOC_ID = "_design/opennote";

/**
 * `validate_doc_update` 的源码（**JS 字符串**）。
 *
 * 缩进与注释都在这里；它最终会被塞进 `_design/opennote` 文档。
 * 改它必须同时跑 `server/src/design.test.ts`（用共享夹具双跑）。
 */
export const VALIDATE_DOC_UPDATE_SOURCE = String.raw`function (newDoc, oldDoc, userCtx, secObj) {
  // tombstone 放行：删除不该被路径规则挡住（否则墓碑建不出来，文件会在另一端复活）。
  if (newDoc._deleted) return;
  // 保留 id（_design / _local）放行：它们是 CouchDB 自己的东西。
  if (newDoc._id.charAt(0) === '_') return;
  /*
   * 服务端自己的**元数据文档**放行（syncinfo）。
   *
   * ★ 这条是**真机跑出来的**：假 CouchDB 不执行 validate_doc_update，所以单测看不见 ——
   * 一直到起了真 CouchDB 3.3.3 建第一个笔记本时才炸：
   *
   *   置备在「syncinfo」失败（已回滚删库）：CouchError: CouchDB 403：bad id prefix
   *
   * 也就是**我自己的校验规则拒绝了我自己的元数据文档**：syncinfo 既不以 _ 开头，
   * 也不是 f: / h: 前缀。这属于「校验器必须放行服务端自身的保留文档」——
   * 一个不写下来就会再犯的坑。
   *
   * ⚠️ 本段在 String.raw 模板字符串里，注释里**不能出现反引号** ——
   * 那会提前结束模板字符串（这个坑我在这个文件里踩过两次了）。
   */
  if (newDoc._id === 'syncinfo') return;

  // 只接受三种前缀：f:（模式 A 明文路径）、h:（模式 B HMAC）、m:（元记录）。
  // 别的一律拒绝。
  //
  // m: 是给「路径映射表」（m:pathmap）用的：模式 B 的 did 不可逆，
  // 而 did↔path 映射按设计只存在本地，所以全新设备需要这张表才能把 did 翻回文件名。
  // 它不是文件内容，但服务端不需要知道这一点 —— 它看到的仍然只是一条
  // 不透明 id 的密文记录（那张表是用 encRoot 派生的密钥加密的，服务端没有 encRoot）。
  var prefix = newDoc._id.slice(0, 2);
  if (prefix !== 'f:' && prefix !== 'h:' && prefix !== 'm:') throw({ forbidden: 'bad id prefix' });

  if (newDoc.path !== undefined && newDoc.path !== null) {
    // ---- 模式 A：有明文 path，按 shared/paths.ts 的规则严格校验 ----
    if (typeof newDoc.path !== 'string' || newDoc.path.length === 0) throw({ forbidden: 'bad path' });
    if (newDoc.path.indexOf('\u0000') >= 0) throw({ forbidden: 'path has NUL' });
    if (newDoc.path.charAt(0) === '/' || newDoc.path.charAt(0) === '\\') throw({ forbidden: 'unsafe path' });
    if (/^[a-zA-Z]:/.test(newDoc.path)) throw({ forbidden: 'unsafe path' });
    // 按「路径段」匹配，不要用 indexOf('..') —— 那会误伤 a..b.md（§3.11 的边界表）。
    if (/(^|\/)\.\.?(\/|$)/.test(newDoc.path)) throw({ forbidden: 'unsafe path' });
    if (/(^|\/)\.(opennote|git)(\/|$)/.test(newDoc.path)) throw({ forbidden: 'reserved path' });
    // NTFS 备用数据流：段内冒号（D36，与 assertSafeRelative 同一条）。
    var segments = newDoc.path.split('/');
    for (var i = 0; i < segments.length; i++) {
      if (segments[i].indexOf(':') >= 0) throw({ forbidden: 'path segment has colon' });
    }
  } else if (typeof newDoc.epath !== 'string' || newDoc.epath.length === 0) {
    // 两者必有一个：既没有明文 path，也没有密文 epath。
    throw({ forbidden: 'missing path/epath' });
  }

  // 内容标识也必须有其一：明文模式给 hash，E2EE 给 ehash。
  if (typeof newDoc.hash !== 'string' && typeof newDoc.ehash !== 'string') {
    throw({ forbidden: 'missing hash/ehash' });
  }

  // 大小上限由部署方在写入 _design 时把下面这个占位替换成数字（见 buildDesignDoc）。
  // ⚠️ 占位必须是一个**独一无二的标识符**：第一版写成裸的 MAX_BYTES 并靠
  // String.replace("MAX_BYTES", …) 替换 —— 代码里它是个标识符、不是字符串字面量，
  // 替换其实**没生效**，于是编译出来的 JS 引用了一个未定义全局：任何带 size 的写入
  // 都会 ReferenceError（本例测当场抓到）。用带哨兵前缀的名字，并加断言防回退。
  var declared = newDoc.size;
  if (typeof declared !== 'number') declared = newDoc.esize;
  if (typeof declared === 'number' && declared > __OPENNOTE_MAX_BYTES__) throw({ forbidden: 'too large' });
}`;

/** `validate_doc_update` 里那个大小上限占位符。**唯一产地**。 */
export const MAX_BYTES_PLACEHOLDER = "__OPENNOTE_MAX_BYTES__";

/** `by_path` view 的 map 函数（**仅模式 A 可用** —— 模式 B 的 key 必须是明文 path）。 */
export const BY_PATH_MAP_SOURCE = String.raw`function (doc) {
  if (doc.path && !doc.deleted) emit(doc.path, { hash: doc.hash, size: doc.size });
}`;

export interface DesignDocOptions {
  /** 单文件上限（字节）。会被写进 `validate_doc_update`。 */
  maxBytes: number;
}

/** 把占位替换成实际数字。**唯一入口** —— 两处调用都要走它，避免只改一处。 */
function withMaxBytes(source: string, maxBytes: number): string {
  const resolved = Math.max(1, Math.floor(maxBytes));
  if (!source.includes(MAX_BYTES_PLACEHOLDER)) {
    /*
     * 占位不见了：说明有人改过源码结构（或改了占位名）。**抛错而不是放过** ——
     * 放过的后果是 `validate_doc_update` 里留着一个未定义标识符，
     * 于是 CouchDB 侧任何带 size 的写入都 500，而本地测试可能根本发现不了。
     */
    throw new Error(`validate_doc_update 里找不到大小上限占位符 ${MAX_BYTES_PLACEHOLDER}（有人改过源码结构？）`);
  }
  return source.split(MAX_BYTES_PLACEHOLDER).join(String(resolved));
}

/**
 * 造 `_design/opennote` 文档内容。
 *
 * ⚠️ **不写 `_id`/`_rev`**：`_id` 由 `PUT /{db}/_design/opennote` 的路径决定，
 * `_rev` 由 CouchDB 给（更新时必须带旧的 `_rev`，否则 409 —— 那是正常的 CAS 语义）。
 */
export function buildDesignDoc(options: DesignDocOptions): {
  views: Record<string, { map: string }>;
  validate_doc_update: string;
  language: "javascript";
} {
  return {
    language: "javascript",
    views: { by_path: { map: BY_PATH_MAP_SOURCE } },
    validate_doc_update: withMaxBytes(VALIDATE_DOC_UPDATE_SOURCE, options.maxBytes),
  };
}

/**
 * 把 `validate_doc_update` 的源码变成**可以在 Node 里调用的函数**（测试与夹具双跑用）。
 *
 * 用 `new Function` 而不是 `eval`：`eval` 会继承当前作用域、拿到一堆不该给它的东西，
 * 而这段代码本来就该在一个**干净作用域**里跑（与 CouchDB 内部引擎一致 —— 那里也没有
 * Node 的作用域）。参数名与 CouchDB 调用约定逐字一致。
 *
 * ⚠️ 只在**测试与夹具双跑**里用。生产路径上这份代码是交给 CouchDB 执行的。
 */
export function compileValidateDocUpdate(maxBytes: number): (newDoc: Record<string, unknown>) => void {
  const source = withMaxBytes(VALIDATE_DOC_UPDATE_SOURCE, maxBytes);
  // eslint-disable-next-line no-new-func
  const factory = new Function(`return (${source})`) as () => (
    newDoc: Record<string, unknown>,
    oldDoc: unknown,
    userCtx: unknown,
    secObj: unknown,
  ) => void;
  const validate = factory();
  return (newDoc) => validate(newDoc, null, { name: "sync", roles: [] }, {});
}

/** 每库的 `syncinfo` 文档（§3.2）：协议与加密模式的**双重闸门**。 */
export function buildSyncInfo(options: { protocolVersion: number; cryptoMode: CryptoMode; createdAt?: string }): {
  protocolVersion: number;
  cryptoMode: CryptoMode;
  createdAt: string;
} {
  return {
    protocolVersion: options.protocolVersion,
    cryptoMode: options.cryptoMode,
    createdAt: options.createdAt ?? new Date().toISOString(),
  };
}

/**
 * `_security` 文档：**只留 `sync` 的服务账号**（§3.2、§4.4 纪律 1）。
 *
 * ⚠️ **不要**把每账号 ACL 镜像进来 —— 那会立刻产生「两份真相」。
 * 授权的唯一真源是 SQLite 的 `memberships`。这里的角色是**纵深防御**：
 * 万一 `sync` 的 CouchDB 凭据泄露，攻击者拿到的也不会比 `sync` 本来能拿的更多。
 */
export function buildSecurityDoc(options: { syncUser: string }): {
  admins: { names: string[]; roles: string[] };
  members: { names: string[]; roles: string[] };
} {
  return {
    // admins 留空：建库/改 _design 走 admin 凭据（只在置备时用，§4.5）。
    admins: { names: [], roles: [] },
    members: { names: [options.syncUser], roles: [] },
  };
}

/** 库名：`nb-` + 去连字符的 uuid（**不透明、不可枚举**，§3.1）。 */
export function databaseNameFor(notebookId: string): string {
  return `nb-${notebookId.replace(/-/g, "")}`;
}
