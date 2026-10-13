/**
 * **纯内存**的 `SyncProvider` fake（`docs/执行-三端同步…` §10.1 A、§4.10）。
 *
 * ## 它为什么重要
 *
 * §10.1 A 要求「同一套 provider 契约测试对两个实现各跑一次」：`memory`（CI 必跑）
 * 与真实 compose 栈（慢测试）。所以这份 fake **就是那套契约测试的被测对象之一**，
 * 不是随手写的测试替身 —— 它必须**如实**模拟真 provider 的语义，包括：
 *
 * - `put` 的 CAS：`baseHash` 对不上 → 返回 `conflict` + **当前值**（不是抛异常）；
 * - 逻辑删除：`delete` 之后 `read` 返回 `null`，但 `changes` 里**仍然报一条 `op: "delete"`**
 *   （墓碑活得比 update 久 —— 丢掉一个 delete 会让文件**复活**，§6.4 规则 3）；
 * - `tree` 的 `truncated`：`limit` 截断时**必须**置真（这是「禁止推断删除」的开关）；
 * - `cursor` 是**不透明字符串**（不是数字），且**幂等**：同一 cursor 重复拉结果相同；
 * - `changes` 是**部分有序**的：官方明确顺序不保证，所以这里也**不保证**，
 *   调用方必须按幂等 dirty 信号处理（§4.7 设计点 5）。
 *
 * ## 它**不**模拟的东西（如实列出，别让用例产生虚假信心）
 *
 * - 真正的并发（JS 单线程，两次并发写不会交错到一半）；
 * - CouchDB 的 **revision tree 多 leaf**：这里 `_rev` 是单调计数器，并发写直接 CAS 失败
 *   —— 真实 CouchDB 会**两个 leaf 都留着**（§6.1 L1）。所以「两个 leaf 都在」这条断言
 *   只能在真实栈上测（§10.1 C3 标了这一点）。
 * - `_local` 文档「不参与复制、不进 `_changes`」的性质：这里检查点单独一个 map，
 *   效果等价，但不是同一套机制。
 */

import { pathFromLegacyId } from "../../../shared/paths";
import type { CryptoMode } from "../../../shared/contract";
import {
  SyncProviderError,
  type ProviderChanges,
  type ProviderDeleteInput,
  type ProviderPutInput,
  type ProviderPutResult,
  type ProviderReadResult,
  type ProviderSubscription,
  type ProviderTree,
  type SyncProvider,
} from "../provider-types";

interface FakeDoc {
  rev: string;
  hash: string;
  bytes: Uint8Array;
  deleted: boolean;
}

/** 第 n 个版本的 rev（形状像 CouchDB 的 `N-xxxx`，但**语义上只是计数器**）。 */
function revFor(sequence: number, seed: string): string {
  return `${sequence}-${seed.padEnd(8, "0").slice(0, 8)}`;
}

export interface MemoryProviderOptions {
  name?: string;
  cryptoMode?: CryptoMode;
  /** 列树时默认的分页上限；超过就置 `truncated`。 */
  pageSize?: number;
  /** 设成真时所有方法都抛 `network` 错误（测退避与「不阻塞编辑」）。 */
  offline?: boolean;
}

export interface MemoryProvider extends SyncProvider {
  /** 测试用：直接把一条写进远端（模拟「另一端写的」），不走 CAS。 */
  seed(did: string, hash: string, bytes: Uint8Array): void;
  /** 测试用：当前全部 did → hash（诊断与断言）。 */
  snapshot(): Record<string, string>;
  /** 测试用：已逻辑删除的 did 集合（墓碑）。 */
  tombstones(): string[];
  /** 测试用：游标（= 变更序号）。 */
  currentCursor(): string;
  /** 测试用：切离线。 */
  setOffline(value: boolean): void;
  /** 测试用：收到过几次 checkpoint 调用（证明检查点真的提交了）。 */
  checkpoints(): (string | null)[];
}

/**
 * 造一个内存 provider。
 *
 * `changedSince(cursor)` 的实现故意保持**与 CouchDB 不同的顺序**（用 Map 插入序而非
 * 「先按 seq 排序」），因为契约只承诺「部分有序」—— 用例不该依赖顺序。
 */
export function createMemoryProvider(options: MemoryProviderOptions = {}): MemoryProvider {
  const name = options.name ?? "memory";
  const pageSize = options.pageSize ?? 1000;
  const docs = new Map<string, FakeDoc>();
  /** 变更日志：`{seq, did}`。**删除也进日志**（墓碑活得比 update 久）。 */
  let log: { seq: number; did: string }[] = [];
  let sequence = 0;
  let offline = options.offline ?? false;
  let checkpointCalls: (string | null)[] = [];
  /** 已被 compaction 回收掉的序号下限：低于它的 since 视为**游标过期**，要求 resync。 */
  let purgeFloor = 0;

  function fail(): never {
    throw new SyncProviderError("network", `${name}：离线`, null);
  }

  function bump(did: string): string {
    sequence += 1;
    log.push({ seq: sequence, did });
    return revFor(sequence, String(sequence));
  }

  function cursorToSeq(cursor: string | null): number | null {
    if (cursor === null) return 0;
    const parsed = Number.parseInt(cursor, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const provider: MemoryProvider = {
    name,
    cryptoMode: options.cryptoMode ?? "none",

    async tree(treeOptions = {}): Promise<ProviderTree> {
      if (offline) fail();
      const limit = Math.min(treeOptions.limit ?? pageSize, pageSize);
      // 只列**没被逻辑删除**的（墓碑不算「树里有」—— 删除由 changes 显式告知）。
      const live = [...docs.entries()]
        .filter(([, doc]) => !doc.deleted)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
      const start = treeOptions.startKey;
      const from = start ? live.findIndex(([did]) => did >= start) : 0;
      const slice = live.slice(from < 0 ? live.length : from, (from < 0 ? live.length : from) + limit);
      const truncated = (from < 0 ? 0 : from) + slice.length < live.length;
      return {
        // 列树的游标 = 当前变更序号（「你列树时看到的是这个时刻的状态」）。
        cursor: String(sequence),
        truncated,
        entries: slice.map(([did, doc]) => ({
          did,
          hash: doc.hash,
          size: doc.bytes.byteLength,
          rev: doc.rev,
          // 明文模式下把路径带回去（让新设备也能反查出路径）；E2EE 下**必须**缺省。
          ...(pathByDid(did) !== null ? { path: pathByDid(did)! } : {}),
        })),
      };
    },

    async changes(changeOptions = {}): Promise<ProviderChanges> {
      if (offline) fail();
      const since = cursorToSeq(changeOptions.since ?? null);
      if (since === null || since < purgeFloor) {
        // 游标过期：**要求 resync**（§6.4 规则 2），而不是假装「没有变更」。
        return { cursor: String(sequence), resync: true, changes: [] };
      }
      // 同一 did 在窗口内出现多次时**只报最后一次**：变更信号是幂等的 dirty 提示，
      // 不是「按顺序重放的事件流」（§4.7 设计点 5）。
      const latest = new Map<string, ProviderChanges["changes"][number]>();
      for (const item of log) {
        if (item.seq <= since) continue;
        const doc = docs.get(item.did);
        const op: "add" | "update" | "delete" = !doc || doc.deleted ? "delete" : latest.has(item.did) ? "update" : "add";
        latest.set(item.did, { did: item.did, op });
      }
      return { cursor: String(sequence), changes: [...latest.values()] };
    },

    async read(did: string): Promise<ProviderReadResult | null> {
      if (offline) fail();
      const doc = docs.get(did);
      if (!doc || doc.deleted) return null;
      return { bytes: doc.bytes, hash: doc.hash, rev: doc.rev };
    },

    async put(input: ProviderPutInput): Promise<ProviderPutResult | { conflict: { did: string; current: { hash: string; rev: string } | null } }> {
      if (offline) fail();
      const doc = docs.get(input.did);
      const currentHash = doc && !doc.deleted ? doc.hash : null;
      if (input.baseHash !== currentHash) {
        // CAS 对不上 → 返回**当前值**（调用方要靠它做三方 diff，不能只给「失败」两个字）。
        return {
          conflict: {
            did: input.did,
            current: doc && !doc.deleted ? { hash: doc.hash, rev: doc.rev } : null,
          },
        };
      }
      const rev = bump(input.did);
      docs.set(input.did, { rev, hash: input.hash, bytes: new Uint8Array(input.bytes), deleted: false });
      return { hash: input.hash, rev };
    },

    async delete(input: ProviderDeleteInput) {
      if (offline) fail();
      const doc = docs.get(input.did);
      if (!doc || doc.deleted) return { gone: true as const };
      if (input.baseHash !== null && input.baseHash !== doc.hash) {
        return { conflict: { did: input.did, current: { hash: doc.hash, rev: doc.rev } } };
      }
      // 逻辑删除：**保留墓碑**，并且**进变更日志**（否则另一端永远不知道它被删了 → 复活）。
      const rev = bump(input.did);
      docs.set(input.did, { ...doc, rev, deleted: true });
      return { rev };
    },

    async checkpoint(cursor: string | null): Promise<void> {
      if (offline) fail();
      checkpointCalls.push(cursor);
    },

    subscribe(onSignal): ProviderSubscription {
      // 内存 fake 的订阅：seed/put/delete 之后同步触发一次（没有真实推送通道）。
      listeners.add(onSignal);
      return { close: () => listeners.delete(onSignal) };
    },

    seed(did, hash, bytes) {
      const rev = bump(did);
      docs.set(did, { rev, hash, bytes: new Uint8Array(bytes), deleted: false });
      notify(did);
    },

    snapshot() {
      const out: Record<string, string> = {};
      for (const [did, doc] of docs) if (!doc.deleted) out[did] = doc.hash;
      return out;
    },

    tombstones() {
      return [...docs.entries()].filter(([, doc]) => doc.deleted).map(([did]) => did);
    },

    currentCursor() {
      return String(sequence);
    },

    setOffline(value) {
      offline = value;
    },

    checkpoints() {
      return [...checkpointCalls];
    },
  };

  const listeners = new Set<(hint: { cursor: string | null; dids: string[] }) => void>();
  function notify(did: string): void {
    for (const listener of [...listeners]) listener({ cursor: String(sequence), dids: [did] });
  }

  // 测试用：把变更日志压到某个序号以上（模拟 compaction 回收旧变更 → 游标过期）。
  (provider as unknown as { purgeBefore(seq: number): void }).purgeBefore = (seq: number) => {
    purgeFloor = seq;
    log = log.filter((item) => item.seq > seq);
  };

  return provider;
}

/**
 * 从 did 反解路径 —— **只在明文模式（`crypto_mode = 'none'`）下成立**。
 *
 * `f:` 前缀的 did 是 `"f:" + base64url(path)`，可逆。`h:`（E2EE）是 HMAC，**不可逆**，
 * 于是这里返回 `null`，树里也就不带 `path` —— 与「服务端在 E2EE 下看不到路径」一致。
 */
function pathByDid(did: string): string | null {
  if (!did.startsWith("f:")) return null;
  try {
    return pathFromLegacyId(did);
  } catch {
    return null;
  }
}
