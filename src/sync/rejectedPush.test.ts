/**
 * 服务端 413（空间满了 / 单个文件太大）：只跳过那一条，其它照常推；内容没变就不重传。
 */
import { describe, expect, it } from "vitest";
import { idForPath } from "../../shared/paths";
import { createMemoryProvider } from "./providers/memory";
import { SyncProviderError, type SyncProvider } from "./provider-types";
import { QUOTA_RETRY_MS, createSyncSession } from "./session";
import { createSyncLedger } from "./state";
import type { LocalEntry, SyncFileBackend } from "./workspaceFiles";

const NOTEBOOK = "11111111-2222-4333-8444-555555555555";

function memoryBackend(files: Record<string, string>): SyncFileBackend & { set(path: string, value: string): void } {
  const store = new Map(Object.entries(files));
  return {
    set: (path, value) => store.set(path, value),
    async list(): Promise<LocalEntry[]> {
      return [...store.keys()].map((path) => ({ path, isDir: false }));
    },
    async read(path) {
      return new TextEncoder().encode(store.get(path)!);
    },
    async write(path, bytes) {
      store.set(path, new TextDecoder().decode(bytes));
    },
    async remove(path) {
      store.delete(path);
    },
  };
}

/** 往 `rejectPath` 写就抛 413；记下每条路径被 PUT 了几次。 */
function rejectingProvider(rejectPath: string, serverCode: "quota" | "too-large") {
  const inner = createMemoryProvider();
  const puts = new Map<string, number>();
  const rejectDid = idForPath(rejectPath);
  let rejecting = true;
  const provider: SyncProvider = {
    ...inner,
    async put(input) {
      puts.set(input.did, (puts.get(input.did) ?? 0) + 1);
      if (rejecting && input.did === rejectDid) {
        const message = serverCode === "quota" ? "空间已满：已用 9 B，配额 10 B，这个文件还要 5 B" : "文件超过上限（10 字节）";
        throw new SyncProviderError("quota", message, 413, serverCode);
      }
      return inner.put(input);
    },
  };
  return { provider, putsOf: (path: string) => puts.get(idForPath(path)) ?? 0, stopRejecting: () => (rejecting = false) };
}

function session(provider: SyncProvider, backend: SyncFileBackend, clock: { now: number }) {
  return createSyncSession({
    config: { enabled: true, baseUrl: "memory://", notebookId: NOTEBOOK, cryptoMode: "none", accountRef: "a" },
    ledger: createSyncLedger({ baseUrl: "memory://", notebookId: NOTEBOOK, cryptoMode: "none", protocolVersion: 1 }),
    provider,
    backend,
    notebookId: NOTEBOOK,
    now: () => clock.now,
  });
}

describe("服务端拒收的推送", () => {
  it("空间满了：被拒的那条记下来，其它照常推，这一轮不算失败", async () => {
    const { provider, putsOf } = rejectingProvider("大.md", "quota");
    const s = session(provider, memoryBackend({ "大.md": "big", "小.md": "s" }), { now: 0 });
    const result = await s.syncNow();
    expect(result!.pushed).toBe(1);
    expect(result!.rejectedPushes).toEqual([
      expect.objectContaining({ path: "大.md", reason: "quota", message: expect.stringContaining("空间已满") }),
    ]);
    expect(putsOf("小.md")).toBe(1);
  });

  it("空间满了：内容没变就先不重传，过了重试间隔再试；空间腾出来后推上去", async () => {
    const { provider, putsOf, stopRejecting } = rejectingProvider("大.md", "quota");
    const clock = { now: 0 };
    const s = session(provider, memoryBackend({ "大.md": "big" }), clock);
    await s.syncNow();
    expect(putsOf("大.md")).toBe(1);

    clock.now = QUOTA_RETRY_MS - 1;
    const again = await s.syncNow();
    expect(putsOf("大.md")).toBe(1); // 没重传
    expect(again!.rejectedPushes?.map((item) => item.path)).toEqual(["大.md"]); // 但仍如实报着

    stopRejecting();
    clock.now = QUOTA_RETRY_MS + 1;
    const later = await s.syncNow();
    expect(putsOf("大.md")).toBe(2);
    expect(later!.pushed).toBe(1);
    expect(later!.rejectedPushes).toEqual([]);
  });

  it("单个文件太大：内容不变就一直不重传；改了内容再试", async () => {
    const { provider, putsOf } = rejectingProvider("视频.mov", "too-large");
    const clock = { now: 0 };
    const backend = memoryBackend({ "视频.mov": "v1" });
    const s = session(provider, backend, clock);
    const first = await s.syncNow();
    expect(first!.rejectedPushes?.[0]?.reason).toBe("too-large");

    clock.now = QUOTA_RETRY_MS * 10;
    await s.syncNow();
    expect(putsOf("视频.mov")).toBe(1);

    backend.set("视频.mov", "v2");
    await s.syncNow();
    expect(putsOf("视频.mov")).toBe(2);
  });

  it("别的错误照旧让这一轮失败（不吞掉）", async () => {
    const inner = createMemoryProvider();
    const provider: SyncProvider = {
      ...inner,
      async put() {
        throw new SyncProviderError("server", "炸了", 500);
      },
    };
    const s = session(provider, memoryBackend({ "a.md": "a" }), { now: 0 });
    // runner 把失败收成状态（不抛）：这一轮没有结果，状态是出错。
    expect(await s.syncNow()).toBeNull();
    expect(s.status().phase).toBe("error");
  });
});
