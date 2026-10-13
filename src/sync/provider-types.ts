/**
 * `SyncProvider` —— 同步引擎与「远端到底是什么」之间的**唯一接缝**
 * （`docs/执行-三端同步-密钥即身份-2026-10-13.md` §1.6、§2.3、§4.7、§10.1 A）。
 *
 * ## 为什么要有这层接口
 *
 * 三件事各有各的理由，但都指向同一个形状：
 *
 * 1. **契约测试要跑两个实现**（§10.1 A）：`memory`（纯内存 fake，CI 必跑）与
 *    `opennote`（真实 `/v1/*`，慢测试要起 compose）。没有这层接口，同一套用例没法复用。
 * 2. **引擎不该知道 CouchDB 的存在**（红线 2）：`_rev` CAS、leaf 冲突保留、`_local` 检查点、
 *    单调 cursor **全部来自 CouchDB**，但那是 `opennote` provider 的**实现细节**。
 *    引擎只看到「一个不透明 cursor」与「一个内容标识」，于是它不会被诱去重造那些语义。
 * 3. **它是「适配层契约」，不是复制协议**（§1.7 明确不引入自研复制协议）。
 *
 * ## 三个刻意的设计约束（每一条都对应一个已知的坑）
 *
 * ### ① `did` 而不是 `path`
 *
 * 方法签名里全是 `did`。明文模式下 `did = "f:" + base64url(nfc(path))`（可逆，但引擎**不反解**）；
 * E2EE 下 `did = "h:" + HMAC(idKey, path)`（**不可逆**）。所以引擎从设计上就看不到明文路径
 * —— 这正是「服务端在 E2EE 下不知道路径」（§2.2、§4.7 设计点 2）在客户端这一侧的对称要求。
 * `did → path` 的映射由**上层**（`SyncEngine` 的调用方）持有，因为它是**本机解密结果**。
 *
 * ### ② `cursor` 是不透明字符串
 *
 * CouchDB 2.0 起 update sequence 可以是**任意 JSON**（§4.7 设计点 4）。契约按字符串设计，
 * **provider 之外任何人都不许解析它、比较它、或假设它单调可加**。
 *
 * ### ③ `put` 用内容标识做 CAS，不用 ETag
 *
 * 语义比自定 ETag 清楚（§4.7 设计点 3）：对不上返回 `409` + **当前值**
 * （不是「失败」两个字 —— 调用方需要当前值才能做三方 diff）。
 *
 * ## `opennote` provider 内部的映射（写在这里，免得以后有人以为 Node 在做语义）
 *
 * | provider 方法 | `/v1/*` 调用 | Node 内部再转成 |
 * | --- | --- | --- |
 * | `tree()` | `GET /v1/tree` | view `by_path`（模式 A）/ `_all_docs`（模式 B） |
 * | `changes()` | `GET /v1/changes` | `_changes` |
 * | `read()` | `GET /v1/file` | `GET /{db}/{did}/blob` |
 * | `put()` | `PUT /v1/file` + `If-Match` | `PUT /{db}/{did}?rev=<baseRev>` |
 * | `delete()` | `DELETE /v1/file` + `If-Match` | `DELETE /{db}/{did}?rev=…` |
 * | `checkpoint()` | `PUT /v1/checkpoint` | `PUT /{db}/_local/device-<id>` |
 *
 * 注意 `_local/device-<id>`：**`_local` 文档不参与复制、不出现在 `_changes` 里**
 * —— 正好是检查点该有的性质（§3.7）。而本地基线记的是**每路径的 hash + rev + did**
 * （判断「我改没改」）。**两者职责不同，都要有**（§3.7）。
 */

import type { CryptoMode, Role } from "../../shared/contract";

/** 远端树里的一条（紧凑投影，**不含正文**）。 */
export interface ProviderTreeEntry {
  did: string;
  /**
   * **明文模式**下这一条的工作区相对路径。
   *
   * 为什么需要它：**新设备**（或刚打开同步的笔记本）本地没有任何路径，
   * 而 `did → path` 反查只能靠「把所有已知路径各算一次 did」。明文模式下
   * `did = "f:" + base64url(path)` **是可逆的**，所以 provider 直接把 `path` 带回来
   * 最省事也最不容易错（§3.3 表里「模式 A：服务端能看到路径」那一行）。
   *
   * ⚠️ **E2EE 下必须缺省**：模式 B 的 `did` 是 HMAC，服务端**看不到明文路径**，
   * 也**不许**试图解密（红线 3）。那时新设备只能靠「全树解密」重建映射（§2.2）。
   */
  path?: string;
  /** 内容标识：明文模式是内容 sha256；E2EE 是 `ehash`。两者都只暴露「相等/不等」。 */
  hash: string;
  /** 密文大小 / 明文大小（**服务端在 E2EE 下能看到大小**，如实记录，§3.4）。 */
  size?: number;
  /** provider 自己的修订标识（`opennote` = CouchDB `_rev`）。回填进基线，`put` 时回传。 */
  rev: string;
}

export interface ProviderTree {
  /**
   * 本次列树到达的游标（**不透明字符串**）。
   *
   * ⚠️ 它是「**列树**这一步的进度」，不是「我拉到哪了」—— 后者是检查点（`checkpoint()`）。
   */
  cursor: string | null;
  /**
   * **树没列全**（分页没取完 / 远端明确说 truncated）。
   *
   * 这是「禁止推断删除」的开关（§6.4 规则 1、§4.7 设计点 6）：为真时
   * **只做新增与更新，全部删除一律挂起**。少取一页就被当成「远端删了」是这套设计里
   * 最严重的误删来源，所以这个字段是**必填**的、不是可选。
   */
  truncated: boolean;
  entries: ProviderTreeEntry[];
}

export interface ProviderChange {
  did: string;
  op: "add" | "update" | "delete";
}

export interface ProviderChanges {
  /** 拉到哪个游标了（**不透明字符串**）。 */
  cursor: string | null;
  /**
   * 游标已经过期（远端日志回溯不到那么早）⇒ 客户端退化成**全树比对**。
   * 这是 Joplin 的 `resyncRequired` 语义（§6.4 规则 2）。
   */
  resync?: boolean;
  changes: ProviderChange[];
}

/** 读取一条的字节；不存在时返回 `null`（不抛 —— 「不存在」是正常结果，不是异常）。 */
export interface ProviderReadResult {
  bytes: Uint8Array;
  hash: string;
  rev: string;
}

export interface ProviderPutInput {
  did: string;
  bytes: Uint8Array;
  /** 写完之后这一版的**内容标识**（由调用方算好：明文 sha256 / E2EE 的 `ehash`）。 */
  hash: string;
  /**
   * CAS：远端当前的内容标识。`null` = 允许新建（本地认为远端还没有这一条）。
   *
   * 对不上时 provider **必须**返回 `conflict` + 当前值，**不得**静默覆盖。
   */
  baseHash: string | null;
}

export interface ProviderPutResult {
  hash: string;
  rev: string;
}

export interface ProviderConflict {
  did: string;
  /** 远端当前那一版的标识与修订（调用方据此做三方 diff）。 */
  current: { hash: string; rev: string } | null;
}

export interface ProviderDeleteInput {
  did: string;
  baseHash: string | null;
}

/**
 * 远端订阅的句柄。**只发「来拉了」的信号，不发内容**（§4.7 设计点 5）。
 *
 * 官方依据：`_changes` 是**部分有序**的，官方明确顺序不保证一致并要求客户端**幂等**。
 * 所以收到变更要当**幂等的 dirty 信号**，而不是「按顺序应用事件」。
 */
export interface ProviderSubscription {
  close(): void;
}

/**
 * 同步 provider（`docs/执行-三端同步…` §10.1 A 的契约测试就是照这一份写的）。
 *
 * **所有方法都可能失败**（网络、401、409、配额…）。`put` / `delete` 的「对不上」
 * 走**返回值**（`conflict`）而不是抛异常 —— 因为那是**正常业务结果**，调用方必须处理它
 * 才能做三方 diff；把它做成异常只会诱使有人写一个宽泛的 `catch` 把它吞掉。
 */
export interface SyncProvider {
  /** provider 自己的名字（日志与错误文案用）。 */
  readonly name: string;

  /** 这个笔记本在远端的加密模式（模式不匹配就拒绝同步，§3.2）。 */
  readonly cryptoMode: CryptoMode;

  /** 列树（紧凑投影，不含正文）。 */
  tree(options?: { limit?: number; startKey?: string }): Promise<ProviderTree>;

  /** 增量变更。`since` 为 `null` = 从头拉。 */
  changes(options?: { since?: string | null }): Promise<ProviderChanges>;

  /** 读一条的原始字节。跟不上的标识由 `hash` 回传（调用方用它更新基线）。 */
  read(did: string): Promise<ProviderReadResult | null>;

  /** 写一条（CAS，见 `ProviderPutInput.baseHash`）。 */
  put(input: ProviderPutInput): Promise<ProviderPutResult | { conflict: ProviderConflict }>;

  /** 逻辑删除一条（**墓碑**；`deleted` 优先于「树里没有」，§6.4 规则 3）。 */
  delete(input: ProviderDeleteInput): Promise<{ rev: string } | { conflict: ProviderConflict } | { gone: true }>;

  /** 提交检查点（远端 `_local/device-<id>`）；**不是**本地基线。 */
  checkpoint(cursor: string | null): Promise<void>;

  /**
   * 订阅变更信号（可选 —— `memory` fake 与不支持 SSE 的宿主可以不实现）。
   *
   * `onSignal` 只带一个「有变化」的提示，**不带内容**；收到之后要走一次 `changes()`。
   */
  subscribe?(onSignal: (hint: { cursor: string | null; dids: string[] }) => void): ProviderSubscription;
}

/** 笔记本的远端元信息（`syncinfo`），协议与加密模式的双重闸门（§3.2）。 */
export interface ProviderNotebookInfo {
  notebookId: string;
  name: string;
  role: Role;
  cryptoMode: CryptoMode;
  protocolVersion: number;
}

/** provider 抛出的错误：带一个稳定的**机器可读 code**，让上层不必匹配文案。 */
export class SyncProviderError extends Error {
  constructor(
    readonly code:
      | "unauthorized"
      | "rotated"
      | "forbidden"
      | "not-found"
      | "conflict"
      | "quota"
      | "protocol"
      | "crypto-mode"
      | "network"
      | "server",
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "SyncProviderError";
  }
}
