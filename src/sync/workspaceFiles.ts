/**
 * 把「一个工作区的文件」适配成引擎要的那几个回调
 * （`docs/执行-三端同步-密钥即身份-2026-10-13.md` §3.11 红线 8、§3.9、§5.3）。
 *
 * ## 为什么要有这一层
 *
 * `engine.ts` 刻意只依赖**几个回调**，不 import `library.ts`（那有 3500 行、
 * 牵着 React store 与一堆状态），所以引擎能在 node 里跑纯用例。
 * 那么「真实文件系统 + 忽略规则 + 加密模式」这三件事总要有人拼起来 —— 就是这个文件。
 *
 * ## 它守的三条
 *
 * ### ① **同步范围 = 忽略规则，不多不少**（红线 8）
 *
 * §3.11 红线 8 的原话是同步范围**只**由忽略规则决定。
 * 所以 `listLocal()` 是**唯一**的入口，而它一定会过 `shouldSkipEntry()` ——
 * 没有第二条「顺手也同步一下」的路径。
 *
 * ### ② **内置集先判，命中就直接排除，不再看 `.gitignore`**（§3.11）
 *
 * 这是 §3.11 明确的一条：「如果用户在 `.gitignore` 里写 `!/.git/`，
 * **必须被拒绝** —— 同步 `.git/` 会跨设备搬 `objects`/`index`，**把仓库搞坏**」。
 * 判定顺序由 `ignore.ts` 的 `shouldSkipEntry()` 保证，这里**不许**自己再实现一遍。
 *
 * ### ③ 明文与 E2EE 的差别**只在这一层**
 *
 * - 明文：`hash = sha256(bytes)`，`did = idForPath(path)`（可逆，服务端看得到路径）
 * - E2EE：`hash = HMAC(macKey, sha256(bytes))`，`did = HMAC(idKey, NFC(path))`（不可逆）
 *
 * 引擎**不知道**自己在哪种模式下 —— 它只拿到 `hashOf` 与 `didOf` 两个回调。
 * 这是刻意的：加密模式不该渗透进同步算法。
 */

import { sha256 } from "@noble/hashes/sha2.js";
import type { CryptoMode } from "../../shared/contract";
import { normalizeNfc, normalizePath } from "../../shared/paths";
import { decryptContent, didForPath, didForPlainPath, ehashOf, encryptContent, notebookKeysFrom, openContent, type NotebookKeys } from "./crypto";
import type { EngineLocalFile, SyncEngineDeps } from "./engine";
import { shouldSkipEntry, type IgnoreRules } from "./ignore";
import { toHex } from "./accountKey";

/** 一条待判定/读取的本地条目（`isDir` 用来让目录规则生效）。 */
export interface LocalEntry {
  /** 工作区**相对**路径。 */
  path: string;
  isDir: boolean;
}

/**
 * 这一层需要的文件系统能力。
 *
 * 刻意做成「列出全部条目」而不是「递归遍历」：遍历是各后端自己的事
 * （node 用 `readdir`、FSA 用 handle、OPFS 用另一套），
 * 而**同步相关的逻辑只有过滤与哈希** —— 那才是这里值得测的部分。
 */
export interface SyncFileBackend {
  /** 列出工作区里**全部**条目（含被忽略的；过滤是本层的事）。 */
  list(): Promise<LocalEntry[]>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface WorkspaceEngineOptions {
  backend: SyncFileBackend;
  /** 已经编译好的忽略规则（`createIgnoreRules(gitignoreText)`）。 */
  rules: IgnoreRules;
  cryptoMode: CryptoMode;
  /** E2EE 时必须给：本笔记本的密钥（`deriveNotebookKey(encRoot, notebookId)`）。 */
  notebookKey?: Uint8Array;
  /**
   * 笔记本 id。**E2EE 时必须给** —— 它是内容 AAD 的一半（§3.9 第 1 条），
   * 少了它就没法加密/解密（而不是「可以先不绑」）。
   */
  notebookId: string;
  /** 账本里记着的路径（引擎靠它把远端 did 翻回本机路径）。 */
  knownPaths: () => Promise<string[]>;
  log?: SyncEngineDeps["log"];
}

/** 规范化 + 过滤：给出「这个工作区里**该同步**的文件」。 */
export function selectSyncableEntries(entries: LocalEntry[], rules: IgnoreRules): LocalEntry[] {
  const out: LocalEntry[] = [];
  for (const entry of entries) {
    // 路径先规范化，再交给忽略判定 —— 否则 `.git/./config` 这类写法会绕过内置集。
    const normalized = normalizePath(entry.path);
    if (normalized === "") continue;
    if (shouldSkipEntry(rules, normalized, entry.isDir)) continue;
    // 目录本身不进「该同步的文件」列表（同步的是内容）。
    if (entry.isDir) continue;
    out.push({ path: normalized, isDir: false });
  }
  return out;
}

/**
 * 造出引擎要的那几个回调。
 *
 * 返回值**就是** `SyncEngineDeps`，可以直接喂给 `syncOnce()`。
 */
export function createWorkspaceEngineDeps(options: WorkspaceEngineOptions): SyncEngineDeps {
  const e2ee = options.cryptoMode === "user-key";
  if (e2ee && !options.notebookKey) {
    // 早失败：到写盘那一刻才报「密钥没给」会让用户以为同步成功了。
    throw new Error("E2EE 模式必须提供 notebookKey");
  }
  if (e2ee && !options.notebookId) {
    // 同理：`notebookId` 是内容 AAD 的一半，少了它加密是**做不了**的（不是「可以先不绑」）。
    throw new Error("E2EE 模式必须提供 notebookId（内容 AAD 要用）");
  }
  const keys: NotebookKeys | null = options.notebookKey ? notebookKeysFrom(options.notebookKey) : null;

  /** 内容标识：明文 `sha256`，E2EE `ehash`（HMAC —— 服务端看不出两篇是否相同，§3.9 第 2 条）。 */
  const hashOf = async (bytes: Uint8Array): Promise<string> => {
    if (keys) return ehashOf(keys, bytes);
    return toHex(sha256(bytes));
  };

  /** `path → did`。两种模式用**同一套**路径规范化（见 `crypto.ts` 的说明）。 */
  const didOf = (path: string): string => {
    if (keys) return didForPath(keys, path);
    return didForPlainPath(path);
  };

  return {
    async listLocal(): Promise<EngineLocalFile[]> {
      const entries = await options.backend.list();
      const syncable = selectSyncableEntries(entries, options.rules);
      const out: EngineLocalFile[] = [];
      for (const entry of syncable) {
        const bytes = await options.backend.read(entry.path);
        out.push({ path: entry.path, hash: await hashOf(bytes), bytes: bytes.length });
      }
      return out;
    },
    hashOf,
    didOf,
    knownPaths: options.knownPaths,
    /*
     * ★★ `readLocal` / `writeLocal` 在 E2EE 下**必须**加解密。
     *
     * 这里是整条链路上最容易漏的一层，而且漏了**不会有任何报错**：
     * 引擎只管「读一条、发出去」，它不知道也不该知道加解密
     * （那正是它只依赖 `hashOf`/`didOf` 两个回调的原因）。
     *
     * 所以如果这一层直通，`did` 与 `ehash` 都是密文模式的（看起来完全正确），
     * 而**正文以明文发了出去**。`session.test.ts` 里那条
     * 「远端看不到明文正文」的用例就是专门咬这个的 —— 它第一次跑就红了。
     */
    readLocal: async (path) => {
      const normalized = normalizeNfc(normalizePath(path));
      const raw = await options.backend.read(normalized);
      if (!keys) return raw;
      return encryptContent(keys, didOf(normalized), options.notebookId, raw);
    },
    writeLocal: async (path, bytes) => {
      const normalized = normalizeNfc(normalizePath(path));
      if (!keys) {
        await options.backend.write(normalized, bytes);
        return;
      }
      // 解不开就**抛**（绝不要把密文当明文写到盘上 —— 那会把笔记静默变成乱码）。
      const plain = decryptContent(keys, didOf(normalized), options.notebookId, bytes);
      await options.backend.write(normalized, plain);
    },
    removeLocal: (path) => options.backend.remove(normalizeNfc(normalizePath(path))),
    ...(options.log === undefined ? {} : { log: options.log }),
  };
}

/**
 * 解密一条远端内容（E2EE 时用；明文模式下远端来的就是原文）。
 *
 * 放在这里而不是引擎里：引擎**不知道**模式，也不该知道。
 */
export function openRemoteBytes(options: { cryptoMode: CryptoMode; notebookKey?: Uint8Array; notebookId: string; did: string; path: string; bytes: Uint8Array }): Uint8Array {
  if (options.cryptoMode !== "user-key") return options.bytes;
  if (!options.notebookKey) throw new Error("E2EE 模式必须提供 notebookKey");
  return openContent(notebookKeysFrom(options.notebookKey), options.notebookId, options.did, options.path, options.bytes);
}
