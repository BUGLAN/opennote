/**
 * 冲突裁决（L3 收尾，`docs/执行-三端同步-密钥即身份-2026-10-13.md` §6.1）。
 *
 * ## 只做用户点过头的两件事
 *
 * 引擎（L2）对「两边都改」**只报不猜**；这里把用户在对话框里点的那一下变成收尾动作：
 *
 * | 动作 | 做什么 | 红线约束怎么守 |
 * | --- | --- | --- |
 * | 采用远端 | `provider.read` → `writeLocal` → 基线对齐远端 | 与引擎拉取同一条路径（`writeLocal` 会解密），绝不把密文写盘 |
 * | 采用远端（远端已删） | `removeLocal` → 账本去掉这一条 | 与引擎「远端删了 → 删本地」同一形状 |
 * | 保留本地 | `provider.put`（CAS 基准 = 当前远端哈希）→ 基线对齐这次写入 | 是**用户显式选择**的覆盖（界面上写明「用我的版本覆盖远端」），不是静默默认 |
 * | 保留本地（本地已删） | `provider.delete`（同样以当前远端为 CAS 基准）→ 账本去掉这一条 | 同上：用户点的就是「按我这边，删掉远端」 |
 *
 * ## 两个出口都必须真的能走通
 *
 * 引擎遇到冲突会在账本记下 `pendingConflict`，并**挡住**这条路径的推/删（H1）。
 * 所以这里任何一个出口「如实失败」都等于把这条路径永久卡死 —— 再同步多少轮也解不开。
 * 删除类冲突（一边已经没有这一条）因此不是报错，而是按用户选的那一边**执行删除**。
 * 成功之后 `pendingConflict` 一定被清掉（整条重写或整条去掉）。
 *
 * 裁决之后**必须再同步一轮**（调用方负责）：这一轮把另一端也带到收敛状态，
 * 并把墓碑/检查点补齐 —— 这两个函数自己不做「同步」，它们只改本地这一侧的事实。
 */

import type { SyncSession } from "./session";
import { decodeText, isSameUpToFormatting } from "./textDiff";

export interface ResolutionOutcome {
  path: string;
  ok: boolean;
  /** 失败时的可读原因（对话框直接显示）。 */
  error?: string;
}

function allocateBid(session: SyncSession, path: string): number {
  const existing = session.ledger.bids[path];
  if (typeof existing === "number") return existing;
  const bid = session.ledger.nextBid;
  session.ledger.nextBid += 1;
  session.ledger.bids[path] = bid;
  return bid;
}


/** 冲突两边的可读版本（界面画 diff 用）。 */
export interface ConflictPreview {
  path: string;
  /** 本机那一份；不是合法文本（图片等）就是 `null`。 */
  local: string | null;
  /** 远端那一份（已是**明文**：E2EE 下由 `deps.decodeRemote` 解密）。 */
  remote: string | null;
  /** 两边是否仅格式不同（BOM / 换行符 / 末尾空行）。 */
  formattingOnly: boolean;
}

/**
 * 读出一份冲突的**两边正文**。只读，不改任何状态。
 *
 * 为什么要单独一个函数：`resolveConflict*` 是「写」的另一半，而界面在用户**还没决定**
 * 之前需要先看见两份内容。把「读」与「写」混在一起，就会出现「点一下对比顺手覆盖了」这种事故。
 */
export async function previewConflict(session: SyncSession, path: string): Promise<ConflictPreview> {
  const did = session.deps.didOf(path);
  /*
   * ★ 两边都取**明文**（M8）：E2EE 下 `readLocal` 是密文、`provider.read` 也是密文，
   * 直接解码必然失败 ⇒ 预览两边都空，界面还会误导成「本机这一份读不出来（可能已被删）」。
   */
  const readPlain = session.deps.readLocalPlain ?? session.deps.readLocal;
  const [localBytes, remote] = await Promise.all([
    readPlain(path).catch(() => null),
    session.provider.read(did).catch(() => null),
  ]);
  const local = localBytes === null ? null : decodeText(localBytes);
  const remoteText = remote === null
    ? null
    : decodeText(session.deps.decodeRemote === undefined ? remote.bytes : session.deps.decodeRemote(did, remote.bytes));
  return {
    path,
    local,
    remote: remoteText,
    // 只有两边都是合法文本才谈得上「仅格式不同」。
    formattingOnly: local !== null && remoteText !== null && isSameUpToFormatting(local, remoteText),
  };
}
/** 「采用远端」：远端那一份覆盖本地，基线对齐远端（与引擎拉取同一形状）。 */
export async function resolveConflictWithRemote(session: SyncSession, path: string): Promise<ResolutionOutcome> {
  const did = session.deps.didOf(path);
  const remote = await session.provider.read(did);
  if (remote === null) {
    /*
     * 远端已经删了（冲突类型「远端已删 · 本地改过」）。用户选「用远端」= 接受这次删除：
     * 删掉本地、账本去掉这一条（与引擎的拉取删除同一形状，`bid` 保留）。
     * 以前这里「如实失败」—— 而引擎因为 `pendingConflict` 挡着这条路径，
     * 「立即同步」也不会再处理它，用户就永远解不开。
     */
    await session.deps.removeLocal(path);
    delete session.ledger.files[path];
    return { path, ok: true };
  }
  // 与引擎拉取同一约定：writeLocal 负责 E2EE 解密；基线用 hashOfLocal（磁盘字节）。
  await session.deps.writeLocal(path, remote.bytes);
  session.ledger.files[path] = {
    bid: allocateBid(session, path),
    localHash: await session.deps.hashOfLocal(path),
    remoteHash: remote.hash,
    rev: remote.rev,
    imported: true,
    syncedAt: Date.now(),
  };
  return { path, ok: true };
}

/** 「保留本地」：本地那一份以显式覆盖写上远端（CAS 基准 = 当前远端哈希）。 */
export async function resolveConflictWithLocal(session: SyncSession, path: string): Promise<ResolutionOutcome> {
  const locals = await session.deps.listLocal();
  const file = locals.find((item) => item.path === path);
  const did = session.deps.didOf(path);
  if (!file) return resolveDeletedLocally(session, path, did);
  const bytes = await session.deps.readLocal(path);
  let result = await session.provider.put({
    did,
    bytes,
    hash: file.hash,
    baseHash: session.ledger.files[path]?.remoteHash ?? null,
  });
  if ("conflict" in result && result.conflict.current) {
    /*
     * 账本里的 CAS 基准是**上次同步时**的远端 —— 冲突挂在账上往往意味着它已经旧了。
     * 用户点的是「用我的版本覆盖远端」，这是一个**明确的覆盖决定**：
     * 以服务端刚刚返回的当前值为基准重试一次（L1 的 revision tree 不丢 leaf，
     * 输掉的那一版仍在远端历史里），而不是把用户再踢回去点一次。
     */
    result = await session.provider.put({ did, bytes, hash: file.hash, baseHash: result.conflict.current.hash });
  }
  if ("conflict" in result) {
    return { path, ok: false, error: "远端在我们读取之后又变了。请「立即同步」一次拿到最新状态再试。" };
  }
  session.ledger.files[path] = {
    bid: allocateBid(session, path),
    localHash: file.hash,
    remoteHash: result.hash,
    rev: result.rev,
    imported: true,
    syncedAt: Date.now(),
  };
  return { path, ok: true };
}

/**
 * 「保留本地」而本地已经删了（冲突类型「本地已删 · 远端改过」）：用户的意思是**把远端也删掉**。
 *
 * CAS 与 `resolveConflictWithLocal` 同一套：先用账本里的基准，撞了就以服务端当前值重试一次。
 * 走 `provider.delete`（逻辑删除、留墓碑），另一端下一轮按「远端删除」收敛。
 */
async function resolveDeletedLocally(session: SyncSession, path: string, did: string): Promise<ResolutionOutcome> {
  let result = await session.provider.delete({ did, baseHash: session.ledger.files[path]?.remoteHash ?? null });
  if ("conflict" in result && result.conflict.current) {
    result = await session.provider.delete({ did, baseHash: result.conflict.current.hash });
  }
  if ("conflict" in result) {
    return { path, ok: false, error: "远端在我们读取之后又变了。请「立即同步」一次拿到最新状态再试。" };
  }
  // 两边都没有了（`gone` 也算：别人已经删过）⇒ 账本去掉这一条，下一轮空转。
  delete session.ledger.files[path];
  return { path, ok: true };
}
