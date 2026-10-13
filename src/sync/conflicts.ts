/**
 * 冲突账本：**只报不猜**（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §6.1、§6.2、红线 5）。
 *
 * ## 为什么要有这个模块
 *
 * 「绝不静默覆盖」是红线 5。但「不覆盖」不能只是一句口号 —— 它需要**一份清单**：
 * 有东西被搁置了、搁置了什么、用户在哪里看到它、裁决之后怎么收尾。这个模块就是那份清单。
 *
 * ## 三层冲突模型里它是哪一层
 *
 * | 层 | 机制 | 位置 |
 * | --- | --- | --- |
 * | L1 协议层 | CouchDB revision tree：并发写产生多个 leaf，**不丢弃**；`_rev` 对不上 → 409 | CouchDB |
 * | **L2 决策层** | 三方 diff（基线 + 本地 + 远端）→ 两边都改就**列出不覆盖** | **本模块** |
 * | L3 收尾层 | 用户裁决后写合并结果为新 revision，落败 leaf 标 `_deleted` | 客户端驱动 |
 *
 * **Node 不参与裁决**（§4.2 红线 2）；E2EE 下它也只有密文，做不到。所以账本只在客户端。
 *
 * ## 判定表（§6.2）里哪些进冲突
 *
 * | 本地 | 远端 | 内容 | 动作 |
 * | --- | --- | --- | --- |
 * | 改了 | 改了 | **相同** | **判为已同步**，不进冲突（false conflict，Unison 术语） |
 * | 改了 | 改了 | 不同 | → 冲突 `both-modified` |
 * | 已删 | 改了 | —— | → 冲突 `deleted-locally-modified-remotely` |
 * | 改了 | 已删 | —— | → 冲突 `deleted-remotely-modified-locally` |
 *
 * ## 身份判据：`ehash`
 *
 * 「两边都改但内容相同」这条在明文模式下可以直接比字节；**E2EE 下必须靠 `ehash`** ——
 * 而 `ehash` 必须是 `HMAC(macKey, sha256(plaintext))`，不能直接送 `sha256(plaintext)`：
 * 后者会让服务端也能做同样的等价性判断（泄露「这两篇内容一样」，§3.9 第 3 条）。
 * 本模块只关心「两个标识串相不相同」，**不碰明文也不碰密钥**，所以明文/密文两种模式共用它。
 *
 * ## 不放进这里的东西
 *
 * **并入的落败版本内容本身不进账本** —— 它进 `.opennote/history/`（隐藏前像，`library.ts`
 * 已有的 `stashPreImage`）。账本只记「哪条路径、什么原因、两边各自的标识」，因此它**很小**、
 * 可以安全地整体持久化，也不会把正文重复存一份。
 */

import { isHiddenPath } from "../fs/paths";

/** 冲突的种类（与 §6.2 判定表一一对应）。 */
export type ConflictKind = "both-modified" | "deleted-locally-modified-remotely" | "deleted-remotely-modified-locally";

export interface ConflictEntry {
  /** 工作区相对路径 —— 冲突是**按路径**报的，用户看到的就是他认识的那个文件名。 */
  path: string;
  kind: ConflictKind;
  /** 本地这一版的标识（明文模式 = 内容 sha256；E2EE = `ehash`）；本地不存在时为 `null`。 */
  localId: string | null;
  /** 远端这一版的标识；远端已删时为 `null`。 */
  remoteId: string | null;
  /** 第一次发现它的时间（毫秒）。 */
  detectedAt: number;
}

/** 给 UI 用的可读原因（控制台与桌面端共用同一句话，不要各写一份）。 */
export const CONFLICT_REASON_TEXT: Record<ConflictKind, string> = {
  "both-modified": "两边都改了这一篇，内容不同",
  "deleted-locally-modified-remotely": "本地删了它，远端又改了它",
  "deleted-remotely-modified-locally": "远端删了它，本地又改了它",
};

const entries = new Map<string, ConflictEntry>();

/** 同一路径的同一原因，重复报告不该刷屏 —— 但**内容变了就是新的一回事**，要覆盖。 */
function sameIdentity(previous: ConflictEntry, next: ConflictEntry): boolean {
  return previous.kind === next.kind && previous.localId === next.localId && previous.remoteId === next.remoteId;
}

/**
 * 记一条冲突。
 *
 * - 同一路径的同一版本重复报告 → **不重置** `detectedAt`（否则 UI 上的「发现于」会一直跳）；
 * - 同一路径版本变了 → 覆盖（这才是当前要裁决的那一份）。
 *
 * 返回 `true` = 账本发生了变化（调用方据此决定要不要推 UI）。
 */
export function recordConflict(
  entry: Omit<ConflictEntry, "detectedAt"> & { detectedAt?: number },
): boolean {
  const next: ConflictEntry = { ...entry, detectedAt: entry.detectedAt ?? Date.now() };
  const previous = entries.get(next.path);
  if (previous && sameIdentity(previous, next)) return false;
  entries.set(next.path, next);
  return true;
}

/**
 * 「两边都改了但内容相同」→ **判为已同步**，并且把之前误报的冲突撤掉。
 *
 * 这条来自 rclone bisync 的官方定义，二次依据是 Unison 手册的 **false conflict**。
 * 少了它，每次同步都会冒出一批「其实一样」的假冲突，用户很快就不看那个列表了。
 */
export function clearConflictIfIdentical(path: string, localId: string | null, remoteId: string | null): boolean {
  if (localId === null || remoteId === null || localId !== remoteId) return false;
  return resolveConflict(path);
}

/** 用户裁决完（或路径消失）→ 从账本里划掉。返回是否真的划过。 */
export function resolveConflict(path: string): boolean {
  return entries.delete(path);
}

/** 全部待裁决冲突，按路径稳定排序（UI 两次渲染的顺序必须一致）。 */
export function listConflicts(): ConflictEntry[] {
  return [...entries.values()].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

export function getConflict(path: string): ConflictEntry | undefined {
  return entries.get(path);
}

export function conflictCount(): number {
  return entries.size;
}

/** 改名/移动：冲突是路径键，必须跟着换（与 `library.ts` 的 `remapKeyed` 同一条纪律）。 */
export function remapConflict(replace: (path: string) => string): void {
  for (const [key, value] of [...entries]) {
    const next = replace(key);
    if (next === key) continue;
    entries.delete(key);
    // 目标路径已经有冲突时不覆盖：让它自然被下一次判定修正，而不是在这里猜谁更新。
    if (!entries.has(next)) entries.set(next, { ...value, path: next });
  }
}

/** 清空（切换/关闭笔记本：同一路径在另一个笔记本是另一篇笔记，不得跨库携带）。 */
export function clearConflicts(): void {
  entries.clear();
}

/**
 * 诊断用：账本里**不该**出现隐藏路径。
 *
 * `.opennote/` 一族的路径是同步范围之外的（§3.11），永远不该有冲突 —— 出现就说明有人
 * 绕过了忽略判定，把一个“双向不存在”的路径喂进了同步。返回违规路径而不是抛，
 * 因为这条的调用方是诊断与测试。
 */
export function conflictsOnHiddenPaths(): string[] {
  return listConflicts()
    .map((entry) => entry.path)
    .filter((path) => isHiddenPath(path));
}

/** 测试用：把时间固定下来，断言 `detectedAt` 不跳。 */
export function recordConflictForTests(entry: Omit<ConflictEntry, "detectedAt"> & { detectedAt?: number }): boolean {
  return recordConflict(entry);
}
