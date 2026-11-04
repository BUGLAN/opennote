/**
 * 加密笔记本的「文件名对照表」（`m:pathmap`）随同步走。
 *
 * ## 为什么要它
 *
 * 模式 B（端到端加密）的 `did = HMAC(idKey, path)` 不可逆。一台**全新设备**（本地空、账本空）
 * 看到远端树时，没有任何办法把 did 翻回文件名 —— 引擎只能如实报 `unknownDids`，一个文件都拉不下来。
 *
 * 解法（`crypto.ts` 的 `encodePathMap` 一节）：把 `did ↔ path` 表用 `encRoot` 派生的密钥加密，
 * 作为一条普通记录 `m:pathmap` 同步。服务端只看到一条不透明 id 的密文；有 `encRoot` 的设备
 * 解开它就有了路径。
 *
 * ## 这个模块只做三件事
 *
 * 1. `refresh()`：读远端那张表、解开、逐条校验（路径必须安全、did 必须与路径对得上）；
 * 2. `paths()`：交出表里的路径 —— 会话把它们并进引擎的 `knownPaths`，引擎就能反查 did；
 * 3. `publish(live, removed)`：把本机知道的路径并进表、去掉本机确认删了的，**有变化才写**。
 *    写用 CAS（`baseHash`），撞了就重读、重新合并、再写 —— 多台设备同时改表不会互相覆盖。
 *
 * ## 失败的方向
 *
 * - 表解不开（密钥不对 / 被别的笔记本的表顶替）⇒ 当作空表用，并且**本轮不再写它**：
 *   拿一把错的钥匙覆盖掉别人的表，会让所有设备一起失明。
 * - 写表失败（网络 / 只读成员）⇒ 只记日志，不让整轮同步失败：表只是加速「认路」，
 *   文件本身已经推上去了。
 */

import { PATH_MAP_DID } from "../../shared/contract";
import { decodePathMap, encodePathMap, pathMapContentId, type PathMapEntry } from "./crypto";
import { assertSafeRelative } from "../fs/paths";
import type { SyncProvider } from "./provider-types";

/** CAS 撞车后最多重试几次（每次都会重读远端、重新合并）。 */
export const PATH_MAP_PUT_ATTEMPTS = 3;

export interface PathMapSync {
  /** 读过远端那张表没有（会话第一轮要先读一次）。 */
  readonly loaded: boolean;
  /** 表里（校验过的）全部路径。 */
  paths(): string[];
  /** 重读远端那张表。返回这次**新学到**的路径。 */
  refresh(): Promise<string[]>;
  /**
   * 把 `live` 并进表、把 `removed` 从表里去掉；内容没变就不发请求。
   * `removed` 里同时也在 `live` 的路径以 `live` 为准（本机又建回来了）。
   */
  publish(live: string[], removed: string[]): Promise<void>;
}

export interface PathMapSyncOptions {
  provider: SyncProvider;
  /** `derivePathMapKey(encRoot)`。 */
  pathMapKey: Uint8Array;
  notebookId: string;
  /** 与引擎同一个 `didOf`（E2EE 的 HMAC）。 */
  didOf: (path: string) => string;
  log?: (line: string) => void;
}

export function createPathMapSync(options: PathMapSyncOptions): PathMapSync {
  const { provider, pathMapKey, notebookId, didOf } = options;
  const log = options.log ?? (() => undefined);

  /** did → path（已校验）。 */
  let entries = new Map<string, string>();
  /** 远端那条记录的内容标识；`null` = 远端还没有这张表。 */
  let remoteHash: string | null = null;
  let loaded = false;
  /** 远端的表解不开 ⇒ 本会话不再写它（见模块头「失败的方向」）。 */
  let unreadable = false;

  const decodeEntries = (raw: PathMapEntry[]): Map<string, string> => {
    const out = new Map<string, string>();
    let dropped = 0;
    for (const entry of raw) {
      let path: string;
      try {
        // 来自网络：哪怕解密成功也照样过一遍安全校验，绝不把文件写到库外。
        path = assertSafeRelative(entry.path);
      } catch {
        dropped += 1;
        continue;
      }
      // did 必须与路径对得上：对不上说明规范化规则变过，或者这条本来就是坏的。
      if (didOf(path) !== entry.did) {
        dropped += 1;
        continue;
      }
      out.set(entry.did, path);
    }
    if (dropped > 0) log(`[sync] pathmap 丢掉 ${dropped} 条对不上的记录`);
    return out;
  };

  const load = async (): Promise<void> => {
    const remote = await provider.read(PATH_MAP_DID);
    loaded = true;
    if (remote === null) {
      remoteHash = null;
      return;
    }
    remoteHash = remote.hash;
    try {
      entries = decodeEntries(decodePathMap(pathMapKey, notebookId, remote.bytes));
      unreadable = false;
    } catch (error) {
      unreadable = true;
      log(`[sync] pathmap 解不开，本轮不写它：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const sameAs = (next: Map<string, string>): boolean => {
    if (next.size !== entries.size) return false;
    for (const [did, path] of next) if (entries.get(did) !== path) return false;
    return true;
  };

  const merged = (live: string[], removed: string[]): Map<string, string> => {
    const next = new Map(entries);
    const liveSet = new Set(live);
    for (const path of removed) if (!liveSet.has(path)) next.delete(didOf(path));
    for (const path of live) next.set(didOf(path), path);
    return next;
  };

  return {
    get loaded() {
      return loaded;
    },
    paths: () => [...entries.values()],
    async refresh() {
      const before = new Set(entries.values());
      await load();
      return [...entries.values()].filter((path) => !before.has(path));
    },
    async publish(live, removed) {
      try {
        if (!loaded) await load();
        for (let attempt = 0; attempt < PATH_MAP_PUT_ATTEMPTS; attempt += 1) {
          if (unreadable) return;
          const next = merged(live, removed);
          if (sameAs(next) && remoteHash !== null) return;
          if (next.size === 0 && remoteHash === null) return; // 没有可写的，也不建一张空表
          const bytes = encodePathMap(
            pathMapKey,
            notebookId,
            [...next].map(([did, path]) => ({ did, path })),
          );
          const hash = pathMapContentId(bytes);
          const result = await provider.put({ did: PATH_MAP_DID, bytes, hash, baseHash: remoteHash });
          if ("conflict" in result) {
            // 别的设备刚改过表：重读、在它的基础上重新合并，再写。
            await load();
            continue;
          }
          entries = next;
          remoteHash = result.hash;
          return;
        }
        log(`[sync] pathmap 连续 ${PATH_MAP_PUT_ATTEMPTS} 次撞车，下一轮再写`);
      } catch (error) {
        log(`[sync] pathmap 没写上：${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
