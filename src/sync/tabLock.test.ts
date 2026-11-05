import { afterEach, describe, expect, it, vi } from "vitest";
import type { BroadcastChannelLike, LockManagerLike } from "./tabLock";

/**
 * 一个行为与浏览器一致的最小 LockManager：排他、先来先得、`ifAvailable` 拿不到给 null、
 * 排队中 `signal` 中止 ⇒ reject。所有「标签页」共用这一个实例，就像同一个浏览器。
 */
function fakeLocks(): LockManagerLike & { holders(name: string): number } {
  const held = new Set<string>();
  const queues = new Map<string, (() => void)[]>();
  const grant = (name: string, callback: (lock: unknown) => Promise<void> | void): Promise<void> => {
    held.add(name);
    return Promise.resolve(callback({ name })).finally(() => {
      held.delete(name);
      const next = queues.get(name)?.shift();
      if (next) next();
    });
  };
  return {
    holders: (name) => (held.has(name) ? 1 : 0),
    request(name, options, callback) {
      if (!held.has(name)) return grant(name, callback);
      if (options.ifAvailable) return Promise.resolve(callback(null));
      return new Promise<void>((resolve, reject) => {
        const entry = () => {
          grant(name, callback).then(resolve, reject);
        };
        const queue = queues.get(name) ?? [];
        queue.push(entry);
        queues.set(name, queue);
        options.signal?.addEventListener("abort", () => {
          const list = queues.get(name) ?? [];
          const index = list.indexOf(entry);
          if (index >= 0) list.splice(index, 1);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    },
  };
}

/** 同名频道之间互相投递（不投给自己），与 BroadcastChannel 一致。 */
function fakeChannels(): (name: string) => BroadcastChannelLike {
  const all = new Set<BroadcastChannelLike & { name: string }>();
  return (name) => {
    const channel: BroadcastChannelLike & { name: string } = {
      name,
      onmessage: null,
      postMessage(message) {
        for (const other of all) {
          if (other !== channel && other.name === name) queueMicrotask(() => other.onmessage?.({ data: message }));
        }
      },
      close() {
        all.delete(channel);
      },
    };
    all.add(channel);
    return channel;
  };
}

/** 每个「标签页」是一份独立加载的模块，共用同一个 LockManager / 频道总线。 */
async function tab(locks: LockManagerLike | null, createChannel: ((name: string) => BroadcastChannelLike) | null) {
  vi.resetModules();
  const mod = await import("./tabLock");
  mod.setTabLockEnvForTests({ locks, createChannel });
  return mod;
}

afterEach(() => {
  vi.resetModules();
});

describe("同一笔记本只让一个标签页同步（issue #3）", () => {
  it("锁名按「存储类型 + 位置」区分笔记本", async () => {
    const a = await tab(fakeLocks(), null);
    expect(a.syncLockKey({ kind: "opfs", location: "我的笔记" })).toBe("opennote:sync:opfs:我的笔记");
    expect(a.syncLockKey({ kind: "opfs", location: "x" })).not.toBe(a.syncLockKey({ kind: "fsa", location: "x" }));
  });

  it("第一个标签页拿到锁，第二个看到 busy；不同笔记本互不影响", async () => {
    const locks = fakeLocks();
    const a = await tab(locks, null);
    const b = await tab(locks, null);

    const first = await a.tryAcquireSyncLock("k1");
    expect(first.kind).toBe("held");
    expect((await b.tryAcquireSyncLock("k1")).kind).toBe("busy");
    expect((await b.tryAcquireSyncLock("k2")).kind).toBe("held");
  });

  it("持锁的标签页关掉（释放）后，排队的那个立刻接手", async () => {
    const locks = fakeLocks();
    const a = await tab(locks, null);
    const b = await tab(locks, null);

    const first = await a.tryAcquireSyncLock("k");
    if (first.kind !== "held") throw new Error("expected held");
    const waiting = b.waitForSyncLock("k", new AbortController().signal);
    let taken = false;
    void waiting.then(() => {
      taken = true;
    });
    await Promise.resolve();
    expect(taken).toBe(false);

    first.lock.release();
    const lock = await waiting;
    expect(lock?.key).toBe("k");
    expect(locks.holders("k")).toBe(1);
    // 现在轮到第一个看到 busy。
    expect((await a.tryAcquireSyncLock("k")).kind).toBe("busy");
  });

  it("排队可以取消（切走笔记本）：取消后 resolve null，不会再拿到锁", async () => {
    const locks = fakeLocks();
    const a = await tab(locks, null);
    const b = await tab(locks, null);

    const first = await a.tryAcquireSyncLock("k");
    if (first.kind !== "held") throw new Error("expected held");
    const abort = new AbortController();
    const waiting = b.waitForSyncLock("k", abort.signal);
    abort.abort();
    await expect(waiting).resolves.toBeNull();

    first.lock.release();
    await Promise.resolve();
    expect(locks.holders("k")).toBe(0);
  });

  it("release 可以重复调用", async () => {
    const locks = fakeLocks();
    const a = await tab(locks, null);
    const first = await a.tryAcquireSyncLock("k");
    if (first.kind !== "held") throw new Error("expected held");
    first.lock.release();
    first.lock.release();
    await Promise.resolve();
    expect(locks.holders("k")).toBe(0);
  });

  it("没有 Web Locks 时退回原来的行为（unsupported，不阻塞同步）", async () => {
    const a = await tab(null, null);
    expect(a.supportsTabLocks()).toBe(false);
    expect((await a.tryAcquireSyncLock("k")).kind).toBe("unsupported");
  });

  it("Web Locks 自己抛错时也按 unsupported 处理", async () => {
    const broken: LockManagerLike = {
      request: () => Promise.reject(new DOMException("denied", "SecurityError")),
    };
    const a = await tab(broken, null);
    expect((await a.tryAcquireSyncLock("k")).kind).toBe("unsupported");
  });

  it("没拿到锁的标签页的本地改动经 BroadcastChannel 通知到持锁的那个", async () => {
    const bus = fakeChannels();
    const holder = await tab(fakeLocks(), bus);
    const follower = await tab(fakeLocks(), bus);

    const received: string[] = [];
    const off = holder.onRemoteTabLocalWrite((key) => received.push(key));
    follower.announceLocalWrite("opennote:sync:opfs:a");
    await vi.waitFor(() => expect(received).toEqual(["opennote:sync:opfs:a"]));

    off();
    follower.announceLocalWrite("opennote:sync:opfs:a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toHaveLength(1);
  });

  it("没有 BroadcastChannel 时通知静默失败，不抛错", async () => {
    const a = await tab(fakeLocks(), null);
    expect(() => a.announceLocalWrite("k")).not.toThrow();
    const off = a.onRemoteTabLocalWrite(() => {});
    expect(() => off()).not.toThrow();
  });
});
