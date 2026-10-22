/**
 * 同步账本：`.opennote/sync.json`（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §3.7、§5.4 第 4 条）。
 *
 * ## 它与另外两样东西的分工（**三者职责不同，都要有**）
 *
 * | 记什么 | 存在哪 | 回答什么问题 |
 * | --- | --- | --- |
 * | 每路径的内容标识 + `rev` + `did` | **这里**（`.opennote/sync.json`） | 「**我**改没改」 |
 * | 游标 cursor | 远端 `_local/device-<deviceId>` | 「**我拉到哪了**」 |
 * | `did` ↔ `path` 映射 | **这里**（`bids`，见下） | 「这个 did 是本机哪个文件」 |
 *
 * 基线**不能**只放内存、也**不能**只放远端：它必须跟着笔记本目录走（换台机器拷过去，
 * 「我改没改」的判据也跟着走）。游标则**不能**只放本地 —— 它不跨端，重装就丢（G8）。
 * `deviceId` 更**绝不能**放这里（会让两台设备共用一个 `_local` 检查点，见 `device.ts`）。
 *
 * ## `did` ↔ `path` 为什么不存成 `did → path`
 *
 * 它**存成 `path → bid`**（bid = 账本本地的整数编号）。两边各有用处：
 *
 * - **`path → bid` 让 E2EE 或 provider 换实现时不必重加密**（改 did 方案不动账本）；
 * - **反查是本机的、一次性的**：启动时把所有 path 算一遍 did，建成 `did → path` 的内存表
 *   即可。它是**本机解密结果**，所以用内存表而不是再存一份持久反查表
 *   （多一份持久化的反查表 = 多一处会与事实不一致的地方）。
 *
 * 路径改名 → `bid` **保持不变**（`renamePath`）。这让「改名」在账本层面是可追踪的，
 * 而不是「旧的没了、来了个新的」。
 *
 * ## 为什么不用路径当键存 did
 *
 * 因为**路径会变**。用路径当键时，改名会让旧键消失、新键出现 —— 于是基线里那一条的
 * `remoteHash`/`rev` 就丢了，下一次同步会把「改名」误判成「删除 + 新增」。
 * `bid` 就是为了让「同一条内容换个名字」这件事在账本里**看得见**。
 * （E2EE 下改名必然换 did，这一层救不了 did —— 但至少账本知道那是同一条内容。）
 *
 * ## 落盘闸门
 *
 * 写之前过 `assertSafeLocalMetaPayload()`（`boundary.ts`）：**凭据材料与本机专属字段
 * 一律不许进笔记本目录**。这是红线 3 在账本这一处的机械化落点。
 */

import { assertSafeRelative, joinPath, META_DIR } from "../fs/paths";
import type { FileSystemBackend } from "../fs/types";
import type { ConflictKind } from "./conflicts";
import { assertSafeLocalMetaPayload } from "./boundary";
import type { CryptoMode } from "../../shared/contract";

/** 账本文件（`.opennote/sync.json`）。与 `.opennote/github.json`（旧的手动通道）**互相独立，绝不合并**。 */
export const SYNC_META_FILE = joinPath(META_DIR, "sync.json");

/** 账本 schema 版本；结构变了就 +1，并在 `readSyncLedger()` 里给旧版本一条迁移路径。 */
export const SYNC_LEDGER_VERSION = 1;

/** 一条路径的同步事实。 */
export interface SyncLedgerFile {
  /**
   * 同一条内容的**稳定本地编号**（bid = baseline id）。
   *
   * 改名/移动时**保持不变**，于是「同一条内容换个名字」在账本里是可追踪的。
   * 它**不是** did：did 是 provider 那一侧的概念（E2EE 下改名必然换 did）。
   */
  bid: number;
  /** 上次同步时**本地**那一版的内容标识（明文 sha256 / E2EE 的 `ehash`）。 */
  localHash: string | null;
  /** 上次同步时**远端**那一版的内容标识 —— 也就是 `put` 的 CAS 依据。 */
  remoteHash: string | null;
  /** provider 那一侧的修订标识（`opennote` = CouchDB `_rev`）。 */
  rev: string | null;
  /** 我们有没有把这一条写到本地。`false` = 只在账本里记账，同步永不触碰它。 */
  imported: boolean;
  /** 上次同步时间（毫秒）；诊断与控制台展示用。 */
  syncedAt: number;
  /**
   * **还没裁决**的冲突（引擎侧「只报不猜」的落地）。
   *
   * 为什么必须落在账本里（而不是只放在某一轮的返回值里）：
   * - 「远端这轮没变化」时引擎**不跑 planPull**（`remoteUnchanged`），冲突就会从列表里消失；
   * - 用户还没来得及裁决，界面已经看不到它了 —— 一条冲突不该因为"下一轮没事发生"而蒸发。
   *
   * 只要它还在，引擎就**不推也不删**这条路径；用户裁决（`resolution.ts`）或冲突自然消解
   * （本地/远端任一侧变成了别的版本）时，这个字段会被清掉。
   */
  pendingConflict?: {
    kind: ConflictKind;
    localId: string | null;
    remoteId: string | null;
    /** 第一次/最近一次发现它的时间（毫秒）。 */
    at: number;
  };
}

export interface SyncLedgerRemote {
  /** 同步服务地址（不含尾部斜杠）。 */
  baseUrl: string;
  notebookId: string;
  /** 这个笔记本在远端的加密模式（模式不匹配就拒绝同步，§3.2）。 */
  cryptoMode: CryptoMode;
  /** 上次见到的协议版本（运行期闸门用，§11.3 第 2 条纪律）。 */
  protocolVersion: number;
}

export interface SyncLedger {
  version: number;
  remote: SyncLedgerRemote;
  /** 下发 bid 的计数器；只增不减。 */
  nextBid: number;
  /** `path → 该路径当前那一版的 bid`。 */
  bids: Record<string, number>;
  /** `path → 同步事实`。 */
  files: Record<string, SyncLedgerFile>;
}

export interface CreateLedgerInput {
  baseUrl: string;
  notebookId: string;
  cryptoMode: CryptoMode;
  protocolVersion: number;
}

/** 服务地址的**规范形式**：去掉首尾空白与尾部斜杠。 */
export function stripBaseUrlSlashes(value: string): string {
  return String(value).trim().replace(/\/+$/, "");
}

/**
 * 账本记的远端身份，与当前配置**是不是同一个**。
 *
 * ## 为什么是一条独立的、可测的判定（而不是 appSync 里的一串 `&&`）
 *
 * 判错的代价不对称：判「是同一个」错了，最多多比一轮；判「不是」错了，会**丢掉基线**
 * 然后全量重推 —— 用户看到的是「每次打开应用都同步好几分钟」（真机事故）。
 * 而 baseUrl 有不只一种等价写法（尾部斜杠、首尾空白），逐字比较必然踩。
 */
export function isSameRemote(
  recorded: { baseUrl: string; notebookId: string; cryptoMode: CryptoMode },
  current: { baseUrl: string; notebookId: string; cryptoMode: CryptoMode },
): boolean {
  return (
    stripBaseUrlSlashes(recorded.baseUrl) === stripBaseUrlSlashes(current.baseUrl) &&
    recorded.notebookId === current.notebookId &&
    recorded.cryptoMode === current.cryptoMode
  );
}

export function createSyncLedger(input: CreateLedgerInput): SyncLedger {
  return {
    version: SYNC_LEDGER_VERSION,
    remote: {
      baseUrl: stripBaseUrlSlashes(input.baseUrl),
      notebookId: input.notebookId,
      cryptoMode: input.cryptoMode,
      protocolVersion: input.protocolVersion,
    },
    nextBid: 1,
    bids: {},
    files: {},
  };
}

/**
 * 读账本。文件不存在 / 读不动 / 不是合法 JSON / 版本不认识 → `null`。
 *
 * **不抛**：没有账本 = 「这个笔记本还没开始同步」，是一次正常状态，不是错误。
 * 结构不对时按「没有账本」处理（`null`）而不是猜着修 —— 带着可疑账本同步比重新开始更危险。
 */
export async function readSyncLedger(target: FileSystemBackend): Promise<SyncLedger | null> {
  let raw: string;
  try {
    if (!(await target.exists(SYNC_META_FILE))) return null;
    raw = await target.readText(SYNC_META_FILE);
  } catch (error) {
    console.warn("[opennote] 读不到同步账本", error);
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SyncLedger>;
    if (parsed.version !== SYNC_LEDGER_VERSION) return null;
    if (!parsed.remote || typeof parsed.remote !== "object") return null;
    const remote = parsed.remote as Partial<SyncLedgerRemote>;
    if (typeof remote.baseUrl !== "string" || typeof remote.notebookId !== "string") return null;
    if (remote.cryptoMode !== "none" && remote.cryptoMode !== "user-key") return null;
    if (!parsed.bids || typeof parsed.bids !== "object") return null;
    if (!parsed.files || typeof parsed.files !== "object") return null;
    return {
      version: SYNC_LEDGER_VERSION,
      remote: {
        baseUrl: remote.baseUrl,
        notebookId: remote.notebookId,
        cryptoMode: remote.cryptoMode,
        protocolVersion: typeof remote.protocolVersion === "number" ? remote.protocolVersion : 0,
      },
      nextBid: typeof parsed.nextBid === "number" && parsed.nextBid > 0 ? parsed.nextBid : 1,
      bids: parsed.bids as Record<string, number>,
      files: parsed.files as Record<string, SyncLedgerFile>,
    };
  } catch (error) {
    console.warn("[opennote] 同步账本不是合法 JSON，按「还没开始同步」处理", error);
    return null;
  }
}

/**
 * 写账本。**落盘前先过边界闸门**（凭据 / `deviceId` / did 映射一律不许进来）。
 *
 * 抛而不是警告：这些东西一旦写进笔记本目录，就会被导出、被 `.git` 带走、被同步出去，
 * 事后很难收回来。
 */
export async function writeSyncLedger(target: FileSystemBackend, ledger: SyncLedger): Promise<void> {
  assertSafeLocalMetaPayload(ledger, "同步账本 .opennote/sync.json");
  for (const path of Object.keys(ledger.files)) {
    // 账本里的路径也必须是合法的相对路径（防有人手工改出一个越界路径，下一次同步替它写盘）。
    assertSafeRelative(path);
  }
  await target.mkdir(META_DIR).catch(() => undefined);
  await target.writeText(SYNC_META_FILE, `${JSON.stringify(ledger, null, 2)}\n`);
}

/* ------------------------------------------------------------- bid 的分配 */

/**
 * 取这条路径的 bid；没有就分配一个（**同一路径的 bid 一旦分配就固定**）。
 *
 * 改名的正确用法：`const bid = bidForPath(ledger, oldPath); removePath(ledger, oldPath);
 * setPath(ledger, newPath, bid)`（见 `renamePath`）。
 */
export function bidForPath(ledger: SyncLedger, path: string): number {
  const existing = ledger.bids[path];
  if (typeof existing === "number") return existing;
  const bid = ledger.nextBid;
  ledger.nextBid += 1;
  ledger.bids[path] = bid;
  return bid;
}

/** 把一条路径挪到另一个名字上，**bid 保持不变**（改名/移动）。 */
export function renamePath(ledger: SyncLedger, from: string, to: string): void {
  const bid = ledger.bids[from];
  const file = ledger.files[from];
  delete ledger.bids[from];
  delete ledger.files[from];
  if (bid !== undefined) ledger.bids[to] = bid;
  if (file !== undefined) ledger.files[to] = file;
}

/** 从账本里彻底去掉一条（用户真的删了它，且删除已被远端确认）。 */
export function forgetPath(ledger: SyncLedger, path: string): void {
  delete ledger.bids[path];
  delete ledger.files[path];
}

/** 目录改名/删除：把所有落在它下面的路径一并挪动（`bid` 各自保留）。 */
export function renamePrefix(ledger: SyncLedger, fromPrefix: string, toPrefix: string): void {
  const prefix = fromPrefix.endsWith("/") ? fromPrefix : `${fromPrefix}/`;
  const target = toPrefix.endsWith("/") ? toPrefix : `${toPrefix}/`;
  for (const path of Object.keys(ledger.bids)) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    renamePath(ledger, path, `${target}${rest}`);
  }
}

/* --------------------------------------------------------- did ↔ path 反查 */

/**
 * 把 `path → bid` 投影成 provider 需要的 `path → did`，并给出 `did → path` 反查表。
 *
 * `didOf(path)` 由调用方给（明文模式 = `idForPath`；E2EE = 用 `idKey` 算 HMAC）。
 * **引擎不反解 did** —— 反查表是这里现算的，所以它天然只含本机认识的路径，
 * 不会因为服务端多给了一个 did 就把一个陌生路径写到盘上。
 */
export function buildDidIndex(
  ledger: SyncLedger,
  didOf: (path: string) => string,
): { byPath: Map<string, string>; byDid: Map<string, string> } {
  const byPath = new Map<string, string>();
  const byDid = new Map<string, string>();
  for (const path of Object.keys(ledger.bids)) {
    const did = didOf(path);
    byPath.set(path, did);
    // did 碰撞（理论上 HMAC 撞了）：保留先来的，并如实告警而不是静默覆盖。
    if (byDid.has(did) && byDid.get(did) !== path) {
      console.warn("[opennote] did 碰撞：两个路径算出同一个标识", byDid.get(did), path);
      continue;
    }
    byDid.set(did, path);
  }
  return { byPath, byDid };
}
