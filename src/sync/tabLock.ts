/**
 * 网页端「同一笔记本只让一个标签页同步」（issue #3）。
 *
 * ## 为什么要有
 *
 * 同一个浏览器里，多个标签页打开同一个笔记本时，读写的是**同一份**本地文件和同一份同步账本
 * （`.opennote/sync.json`）。各自跑同步的话：两边重复上传；账本被后写的一方覆盖成旧状态，
 * 下一轮冒出「假冲突」要用户处理。
 *
 * ## 做法
 *
 * - 用 Web Locks（`navigator.locks.request`）按「笔记本 + 存储位置」取一把**排他锁**，
 *   拿到锁的标签页才建同步会话（`appSync.attachCurrent`）。
 * - 没拿到的标签页排队等这把锁：持锁的标签页关掉（或切走这个笔记本），浏览器立刻把锁交给
 *   排在前面的那个，它随即接上同步。
 * - 没拿到锁的标签页本地写入照常（编辑、导入），只是不发起同步；它经 BroadcastChannel
 *   告诉持锁的标签页「有本地改动」，由那边核对后推送。
 *
 * ## 不适用的环境
 *
 * 桌面版（一个笔记本一个窗口，主进程管同步）与 Android（单 WebView）不走这里；
 * 浏览器没有 Web Locks 时退回原来的行为（不阻塞同步）。
 */

/** `navigator.locks` 里用到的那一小块（测试注入假实现）。 */
export interface LockManagerLike {
  request(
    name: string,
    options: { mode?: "exclusive"; ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => Promise<void> | void,
  ): Promise<unknown>;
}

export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface TabLockEnv {
  locks: LockManagerLike | null;
  createChannel: ((name: string) => BroadcastChannelLike) | null;
}

/** 持有中的锁：`release()` 之后浏览器把它交给下一个排队的标签页。 */
export interface HeldSyncLock {
  readonly key: string;
  release(): void;
}

function defaultEnv(): TabLockEnv {
  let locks: LockManagerLike | null = null;
  try {
    const candidate = (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks;
    if (candidate && typeof candidate.request === "function") locks = candidate;
  } catch {
    locks = null;
  }
  const Channel = (globalThis as { BroadcastChannel?: new (name: string) => BroadcastChannelLike }).BroadcastChannel;
  return { locks, createChannel: typeof Channel === "function" ? (name) => new Channel(name) : null };
}

let env: TabLockEnv | null = null;
function currentEnv(): TabLockEnv {
  env ??= defaultEnv();
  return env;
}

/** 测试用：换掉 `navigator.locks` / `BroadcastChannel`。传 null 恢复默认。 */
export function setTabLockEnvForTests(next: TabLockEnv | null): void {
  env = next;
}

/** 锁名：笔记本的存储类型 + 位置（同一份本地文件 ⇒ 同一把锁，与登记里的 id 无关）。 */
export function syncLockKey(record: { kind: string; location: string }): string {
  return `opennote:sync:${record.kind}:${record.location}`;
}

export function supportsTabLocks(): boolean {
  return currentEnv().locks !== null;
}

/**
 * 拿锁并一直持有，直到 `release()`。`ifAvailable` 时拿不到就立刻返回 null；
 * 否则排队，`signal` 中止时 reject（`AbortError`）。
 */
function hold(key: string, options: { ifAvailable?: boolean; signal?: AbortSignal }): Promise<HeldSyncLock | null> {
  const locks = currentEnv().locks;
  if (!locks) return Promise.resolve(null);
  return new Promise<HeldSyncLock | null>((resolve, reject) => {
    let settled = false;
    locks
      .request(key, { mode: "exclusive", ...options }, (lock) => {
        if (!lock) {
          settled = true;
          resolve(null);
          return;
        }
        // 回调返回的 Promise 不结束，锁就不放；`release()` 让它结束。
        return new Promise<void>((done) => {
          let released = false;
          settled = true;
          resolve({
            key,
            release: () => {
              if (released) return;
              released = true;
              done();
            },
          });
        });
      })
      .catch((error: unknown) => {
        if (!settled) reject(error);
      });
  });
}

export type TryAcquireResult = { kind: "held"; lock: HeldSyncLock } | { kind: "busy" } | { kind: "unsupported" };

/** 立即试一次：拿到 / 被别的标签页占着 / 这个环境没有 Web Locks。永不抛错。 */
export async function tryAcquireSyncLock(key: string): Promise<TryAcquireResult> {
  if (!supportsTabLocks()) return { kind: "unsupported" };
  try {
    const lock = await hold(key, { ifAvailable: true });
    return lock ? { kind: "held", lock } : { kind: "busy" };
  } catch {
    // Web Locks 自己出错（例如受限上下文）：退回原来的行为，不阻塞同步。
    return { kind: "unsupported" };
  }
}

/** 排队等锁；拿到时 resolve。`signal` 中止 ⇒ resolve null（不抛）。 */
export async function waitForSyncLock(key: string, signal: AbortSignal): Promise<HeldSyncLock | null> {
  try {
    return await hold(key, { signal });
  } catch {
    return null;
  }
}

/* ------------------------------------------------- 本地改动通知（BroadcastChannel） */

const CHANNEL = "opennote:sync:local-writes";

interface LocalWriteMessage {
  type: "local-write";
  key: string;
}

let channel: BroadcastChannelLike | null = null;
const listeners = new Set<(key: string) => void>();

function ensureChannel(): BroadcastChannelLike | null {
  if (channel) return channel;
  const create = currentEnv().createChannel;
  if (!create) return null;
  try {
    channel = create(CHANNEL);
  } catch {
    return null;
  }
  channel.onmessage = (event) => {
    const data = event.data as Partial<LocalWriteMessage> | null;
    if (!data || data.type !== "local-write" || typeof data.key !== "string") return;
    for (const listener of [...listeners]) listener(data.key);
  };
  return channel;
}

/** 没拿到锁的标签页：告诉持锁的那个「这个笔记本有本地改动」。 */
export function announceLocalWrite(key: string): void {
  try {
    ensureChannel()?.postMessage({ type: "local-write", key } satisfies LocalWriteMessage);
  } catch {
    /* 通知失败不影响本地写入；持锁的标签页回到前台时也会自己核对。 */
  }
}

/** 持锁的标签页：收别的标签页的本地改动通知。返回退订函数。 */
export function onRemoteTabLocalWrite(listener: (key: string) => void): () => void {
  listeners.add(listener);
  ensureChannel();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && channel) {
      channel.close();
      channel = null;
    }
  };
}
