/**
 * 本地内容哈希缓存（`.opennote/hash-cache.json`）。
 *
 * ## 为什么需要它
 *
 * 每一次同步都要回答一个问题：「本地哪些文件改了？」
 * 判据是内容哈希（`sync/diff.ts` 的注释解释了为什么不能用 mtime）。
 * 而算哈希 = **把文件整个读一遍**。500 篇笔记时这是一次几秒的活；
 * 3000 篇 + 一堆图片时，用户每敲一次键（自动保存 → 去抖 1.2s → 同步）
 * 都要把整个笔记本读一遍 —— 那是纯粹的浪费，而且是**同步慢的主因之一**。
 *
 * 于是这里记一份 `path → { size, mtimeMs, hash }`：
 * **只有当 size 或 mtime 变了才重读那个文件**。没变就直接复用哈希。
 *
 * ## 它**不是**真源，丢了也不会错
 *
 * 缓存随时可以整个删掉：删了以后每个文件重算一次哈希，结果**与有缓存时逐字节相同**。
 * 所以它不进 `.opennote/sync.json`（那是账本，语义是「上次同步的事实」），
 * 单独一个文件，坏了就当没有。
 *
 * ## 为什么可以按 size + mtime 判「没变」
 *
 * 这是**性能与严格性**的权衡，如实写在这里：
 * - 严格做法是每次全读全算（正确但慢）；
 * - 这里用 `(size, mtimeMs)` 做「应该没变」的快速判据。
 *
 * 漏判的窗口：**同一秒内、同样大小的两次不同写入**。现实里几乎不可能
 * （编辑器保存会改 mtime；而 mtime 的精度在 NTFS/ext4 上是 100ns 级）。
 * 一旦 mtime 变了，缓存立刻失效并重算，所以不会长期错下去。
 *
 * ## 与「排除本机专属字段」那条纪律的关系
 *
 * `boundary.ts` 禁止 `deviceId` / `did → path` 映射进 `.opennote/`。
 * 这个缓存里只有**路径 + 大小 + mtime + 哈希**，没有凭据、没有设备身份，
 * 拷到另一台设备上也只是「猜缓存命中」——而 mtime 一变就自动失效，
 * 最坏情况是多算一次哈希，不会导致漏同步。所以它落在这里是安全的。
 */

import { assertSafeRelative, joinPath, META_DIR } from "../fs/paths";
import type { FileSystemBackend } from "../fs/types";

/** 缓存文件（`.opennote/hash-cache.json`）。 */
export const HASH_CACHE_FILE = joinPath(META_DIR, "hash-cache.json");

/** 结构版本；改了字段就 +1，旧版本按「没有缓存」处理。 */
export const HASH_CACHE_VERSION = 1;

export interface HashCacheEntry {
  /** 字节数（与 `FileSystemBackend.stat()` 的 `size` 同源）。 */
  size: number;
  /** 修改时间（毫秒）。 */
  mtimeMs: number;
  /** 内容标识（明文 sha256；E2EE 是 ehash —— 两种模式**不能混用同一份缓存**）。 */
  hash: string;
}

export interface HashCache {
  version: number;
  /**
   * 这份缓存属于哪种加密模式。
   *
   * 为什么必须记：同一个笔记本目录在两种模式下的「哈希」是不同的东西
   * （明文 `sha256(bytes)`，E2EE `HMAC(macKey, sha256(bytes))`）。
   * 换模式后沿用旧缓存 = 拿一堆对不上的标识去比对，症状是「全都算改了」。
   */
  cryptoMode: "none" | "user-key";
  entries: Record<string, HashCacheEntry>;
}

export function createHashCache(cryptoMode: "none" | "user-key"): HashCache {
  return { version: HASH_CACHE_VERSION, cryptoMode, entries: {} };
}

/**
 * 读缓存。文件不存在 / 读不动 / 不是合法 JSON / 版本或模式不符 → `null`（= 没有缓存）。
 *
 * **不抛**：缓存是纯优化，「没有」是一次完全正常的状态。
 */
export async function readHashCache(
  backend: FileSystemBackend,
  cryptoMode: "none" | "user-key",
): Promise<HashCache | null> {
  try {
    if (!(await backend.exists(HASH_CACHE_FILE))) return null;
    const raw = await backend.readText(HASH_CACHE_FILE);
    const parsed = JSON.parse(raw) as Partial<HashCache>;
    if (parsed.version !== HASH_CACHE_VERSION) return null;
    if (parsed.cryptoMode !== cryptoMode) return null;
    if (!parsed.entries || typeof parsed.entries !== "object") return null;
    const entries: Record<string, HashCacheEntry> = {};
    for (const [path, entry] of Object.entries(parsed.entries)) {
      if (!entry || typeof entry !== "object") continue;
      const { size, mtimeMs, hash } = entry as Partial<HashCacheEntry>;
      if (typeof size !== "number" || typeof mtimeMs !== "number" || typeof hash !== "string") continue;
      try {
        assertSafeRelative(path);
      } catch {
        continue; // 被手工改过的越界路径：丢掉这一条，不要让它参与后续写盘判断
      }
      entries[path] = { size, mtimeMs, hash };
    }
    return { version: HASH_CACHE_VERSION, cryptoMode, entries };
  } catch {
    return null;
  }
}

/**
 * 写缓存（原子写在 backend 层由各实现负责；这里只保证形状）。
 *
 * 落盘前过一遍 `assertSafeRelative`：缓存里的路径会被拿去判「本地这一条改没改」，
 * 一个越界路径不该有机会留在盘上。
 */
export async function writeHashCache(
  backend: FileSystemBackend,
  cache: HashCache,
  options: { keep?: Iterable<string> } = {},
): Promise<void> {
  const keep = options.keep === undefined ? null : new Set(options.keep);
  const entries: Record<string, HashCacheEntry> = {};
  for (const [path, entry] of Object.entries(cache.entries)) {
    if (keep !== null && !keep.has(path)) continue; // 剪掉已经不存在的路径，防无限长大
    assertSafeRelative(path);
    entries[path] = entry;
  }
  await backend.mkdir(META_DIR).catch(() => undefined);
  await backend.writeText(
    HASH_CACHE_FILE,
    `${JSON.stringify({ version: HASH_CACHE_VERSION, cryptoMode: cache.cryptoMode, entries }, null, 0)}\n`,
  );
}
