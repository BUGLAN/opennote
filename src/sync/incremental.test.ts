/**
 * 增量同步的三块地基：**哈希缓存**、**`changes` 快路径**、**游标存储**。
 *
 * 这三条解决的是同一个用户体验问题：「我只改了一个字，为什么要等三秒」。
 * 它们各自都必须**可单独证伪**，否则一旦慢了，没人知道是哪一块退化了。
 *
 * 三条用例都刻意断言「**省掉了什么**」而不是「结果对不对」——
 * 结果对是别处用例的责任；这里要钉的是「它真的没干那些多余的事」。
 */
import { describe, expect, it } from "vitest";
import { idForPath, pathFromLegacyId } from "../../shared/paths";
import { buildPartialTree, PARTIAL_CHANGE_LIMIT, syncOnceIncremental, type EngineLocalFile, type SyncEngineDeps } from "./engine";
import { createSyncLedger, type SyncLedger } from "./state";
import { createMemoryProvider } from "./providers/memory";
import { createWorkspaceEngineDeps, type LocalEntry } from "./workspaceFiles";
import { createIgnoreRules } from "./ignore";
import { createHashCache, readHashCache, writeHashCache } from "./hashCache";
import { createMemoryCursorStore, createWebCursorStore } from "./cursor";
import type { FileSystemBackend } from "../fs/types";
import type { SyncProvider } from "./provider-types";

/* ============================================================================
   ① 哈希缓存：没变的文件**不重读**
   ============================================================================ */

/** 一个把「读了几次」记下来的内存后端（只实现同步用到的那几个方法）。 */
function countingBackend(files: Map<string, { bytes: Uint8Array; mtimeMs: number }>) {
  const reads: string[] = [];
  return {
    reads,
    backend: {
      kind: "node" as const,
      label: "test",
      canWrite: true,
      async list(): Promise<LocalEntry[]> {
        return [...files.entries()].map(([path, file]) => ({
          path,
          isDir: false,
          size: file.bytes.byteLength,
          mtimeMs: file.mtimeMs,
        }));
      },
      async read(path: string) {
        reads.push(path);
        const file = files.get(path);
        if (!file) throw new Error(`没有这个文件：${path}`);
        return file.bytes;
      },
      async write() {},
      async remove() {},
      async stat(path: string) {
        const file = files.get(path);
        return file ? { size: file.bytes.byteLength, mtimeMs: file.mtimeMs } : null;
      },
    },
  };
}

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("哈希缓存：没变的文件不重读，变了的才重算", () => {
  it("第一次全读；第二次（内容与 mtime 都没变）**一个文件都不读**", async () => {
    const files = new Map([
      ["a.md", { bytes: enc("# a"), mtimeMs: 1000 }],
      ["b.md", { bytes: enc("# b"), mtimeMs: 1000 }],
    ]);
    const { backend, reads } = countingBackend(files);
    const cache = createHashCache("none");
    const deps = createWorkspaceEngineDeps({
      backend,
      rules: createIgnoreRules(""),
      cryptoMode: "none",
      notebookId: "nb",
      knownPaths: async () => [],
      hashCache: cache,
    });

    const first = await deps.listLocal();
    expect(reads).toHaveLength(2);
    expect(first.map((f) => f.path).sort()).toEqual(["a.md", "b.md"]);

    reads.length = 0;
    const second = await deps.listLocal();
    // ★ 这就是「改一个字不再扫全库」：一个字节都没读。
    expect(reads).toHaveLength(0);
    expect(second).toEqual(first);
  });

  it("只改了一个文件 ⇒ 只重读那一个", async () => {
    const files = new Map([
      ["a.md", { bytes: enc("# a"), mtimeMs: 1000 }],
      ["b.md", { bytes: enc("# b"), mtimeMs: 1000 }],
      ["c.md", { bytes: enc("# c"), mtimeMs: 1000 }],
    ]);
    const { backend, reads } = countingBackend(files);
    const cache = createHashCache("none");
    const deps = createWorkspaceEngineDeps({
      backend,
      rules: createIgnoreRules(""),
      cryptoMode: "none",
      notebookId: "nb",
      knownPaths: async () => [],
      hashCache: cache,
    });
    await deps.listLocal();

    // 用户改了 b.md（内容变、mtime 也变）。
    files.set("b.md", { bytes: enc("# b 改过了"), mtimeMs: 2000 });
    reads.length = 0;
    const next = await deps.listLocal();

    expect(reads).toEqual(["b.md"]);
    expect(next.find((f) => f.path === "b.md")!.hash).not.toBe(
      next.find((f) => f.path === "a.md")!.hash,
    );
  });

  it("拉取落地后（hashOfLocal）会把缓存写成磁盘上的事实 —— 下一轮不会重读它", async () => {
    const files = new Map<string, { bytes: Uint8Array; mtimeMs: number }>();
    const { backend, reads } = countingBackend(files);
    const cache = createHashCache("none");
    const deps = createWorkspaceEngineDeps({
      backend,
      rules: createIgnoreRules(""),
      cryptoMode: "none",
      notebookId: "nb",
      knownPaths: async () => [],
      hashCache: cache,
    });

    files.set("from-remote.md", { bytes: enc("# 远端来的"), mtimeMs: 3000 });
    await deps.hashOfLocal("from-remote.md");
    expect(cache.entries["from-remote.md"]).toBeDefined();

    reads.length = 0;
    await deps.listLocal();
    expect(reads).toHaveLength(0);
  });

  it("缓存落到盘上再读回来，判据仍然成立（`.opennote/hash-cache.json` 的真实往返）", async () => {
    const store = new Map<string, string>();
    const fsBackend = {
      kind: "node" as const,
      label: "test",
      canWrite: true,
      async list() {
        return [];
      },
      async readText(rel: string) {
        const text = store.get(rel);
        if (text === undefined) throw new Error("ENOENT");
        return text;
      },
      async readBytes() {
        return new Uint8Array();
      },
      async writeText(rel: string, text: string) {
        store.set(rel, text);
      },
      async writeBytes() {},
      async mkdir() {},
      async remove(rel: string) {
        store.delete(rel);
      },
      async move() {},
      async exists(rel: string) {
        return store.has(rel);
      },
      async stat() {
        return null;
      },
    } satisfies FileSystemBackend;

    const cache = createHashCache("none");
    cache.entries["notes/a.md"] = { size: 5, mtimeMs: 1000, hash: "deadbeef" };
    await writeHashCache(fsBackend, cache);

    const readBack = await readHashCache(fsBackend, "none");
    expect(readBack?.entries["notes/a.md"]).toEqual({ size: 5, mtimeMs: 1000, hash: "deadbeef" });

    // 换了加密模式 ⇒ 旧缓存**必须作废**（两种模式的哈希不是一个东西）。
    expect(await readHashCache(fsBackend, "user-key")).toBeNull();

    // 不存在的路径被剪掉（防止缓存只增不减）。
    await writeHashCache(fsBackend, cache, { keep: [] });
    expect((await readHashCache(fsBackend, "none"))?.entries).toEqual({});
  });
});

/* ============================================================================
   ② changes 快路径：远端没变就**不列树**
   ============================================================================ */

function makeDeps(local: Map<string, Uint8Array>): SyncEngineDeps {
  const hashOf = async (bytes: Uint8Array) => {
    const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  return {
    async listLocal(): Promise<EngineLocalFile[]> {
      const out: EngineLocalFile[] = [];
      for (const [path, bytes] of local) out.push({ path, hash: await hashOf(bytes), bytes: bytes.byteLength });
      return out;
    },
    hashOf,
    async hashOfLocal(path) {
      const bytes = local.get(path);
      if (!bytes) throw new Error("missing " + path);
      return hashOf(bytes);
    },
    didOf: (path) => idForPath(path),
    async knownPaths() {
      return [...local.keys()];
    },
    async readLocal(path) {
      const bytes = local.get(path);
      if (!bytes) throw new Error("missing " + path);
      return bytes;
    },
    async writeLocal(path, bytes) {
      local.set(path, new Uint8Array(bytes));
    },
    async removeLocal(path) {
      local.delete(path);
    },
  };
}

/** 数「列了几次树」的 provider（其余原样转发给内存 provider）。 */
function countingProvider(inner: SyncProvider): SyncProvider & { treeCalls: () => number } {
  let calls = 0;
  return {
    name: inner.name,
    cryptoMode: inner.cryptoMode,
    async tree(options) {
      calls += 1;
      return inner.tree(options);
    },
    changes: (options) => inner.changes(options),
    read: (did) => inner.read(did),
    put: (input) => inner.put(input),
    delete: (input) => inner.delete(input),
    checkpoint: (cursor) => inner.checkpoint(cursor),
    treeCalls: () => calls,
  };
}

describe("changes 快路径：远端没变就不列树，本地改动照样推上去", () => {
  it("远端无变更 ⇒ 一次 tree 都不调，但本地新写的笔记仍然推上去了", async () => {
    const remote = createMemoryProvider();
    const provider = countingProvider(remote);
    const ledger: SyncLedger = createSyncLedger({
      baseUrl: "https://example.com",
      notebookId: "nb",
      cryptoMode: "none",
      protocolVersion: 1,
    });
    const local = new Map<string, Uint8Array>();

    // 先把游标对齐到「现在」（模拟上一轮同步结束后记为 0 变更）。
    const cursor = remote.currentCursor();
    const result = await syncOnceIncremental({
      provider,
      ledger,
      deps: makeDeps(local),
      since: cursor,
    });

    expect(provider.treeCalls()).toBe(0); // ★ 关键：没有列树
    expect(result.pushed).toBe(0);

    // 本地新增一篇：远端仍然没变，但这一篇必须上去。
    local.set("notes/new.md", enc("# 新写的"));
    const second = await syncOnceIncremental({ provider, ledger, deps: makeDeps(local), since: cursor });
    expect(second.pushed).toBe(1);
    expect(Object.keys(remote.snapshot())).toContain(idForPath("notes/new.md"));
  });

  it("远端有变更 ⇒ 老老实实列树并把东西拉下来（快路径不能吞掉变更）", async () => {
    const remote = createMemoryProvider();
    const provider = countingProvider(remote);
    const ledger: SyncLedger = createSyncLedger({
      baseUrl: "https://example.com",
      notebookId: "nb",
      cryptoMode: "none",
      protocolVersion: 1,
    });
    const local = new Map<string, Uint8Array>();
    const cursor = remote.currentCursor();

    // 另一端写了一篇（远端游标前进）。
    const bytes = enc("# 另一端写的");
    const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    remote.seed(idForPath("notes/remote.md"), hash, bytes);

    const result = await syncOnceIncremental({ provider, ledger, deps: makeDeps(local), since: cursor });
    expect(provider.treeCalls()).toBeGreaterThan(0);
    expect(result.pulled).toBe(1);
    expect(local.has("notes/remote.md")).toBe(true);
  });

  it("没有游标（第一次同步）⇒ 必须列树（宁可慢，不可漏）", async () => {
    const remote = createMemoryProvider();
    const provider = countingProvider(remote);
    const ledger = createSyncLedger({
      baseUrl: "https://example.com",
      notebookId: "nb",
      cryptoMode: "none",
      protocolVersion: 1,
    });
    await syncOnceIncremental({ provider, ledger, deps: makeDeps(new Map()), since: null });
    expect(provider.treeCalls()).toBeGreaterThan(0);
  });
});

/* ============================================================================
   ③ 游标存储：每设备一份，丢了只影响快慢
   ============================================================================ */

describe("游标存储", () => {
  it("按笔记本分别保存，清掉后回到 null（= 退化成全树）", () => {
    const store = createMemoryCursorStore();
    expect(store.load("nb-1")).toBeNull();
    store.save("nb-1", "5-g1AAAA");
    store.save("nb-2", "7-g1AAAB");
    expect(store.load("nb-1")).toBe("5-g1AAAA");
    expect(store.load("nb-2")).toBe("7-g1AAAB");
    store.clear("nb-1");
    expect(store.load("nb-1")).toBeNull();
  });

  it("站点存储被禁用时**不抛**，退回内存（本次运行内仍然是增量的）", () => {
    const broken = {
      getItem(): string | null {
        throw new Error("SecurityError");
      },
      setItem(): void {
        throw new Error("SecurityError");
      },
      removeItem(): void {
        throw new Error("SecurityError");
      },
    };
    const reasons: string[] = [];
    const store = createWebCursorStore(broken, { onUnavailable: (reason) => reasons.push(reason) });
    expect(() => store.save("nb", "1-x")).not.toThrow();
    expect(store.load("nb")).toBe("1-x");
    expect(reasons.length).toBe(1);
  });

  it("键里带 notebookId，换笔记本不会拿到别人的游标", () => {
    const map = new Map<string, string>();
    const store = createWebCursorStore({
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => void map.set(key, value),
      removeItem: (key) => void map.delete(key),
    });
    store.save("nb-a", "1-a");
    store.save("nb-b", "1-b");
    expect(store.load("nb-a")).toBe("1-a");
    expect(store.load("nb-b")).toBe("1-b");
    expect([...map.keys()].every((key) => key.startsWith("opennote.sync.cursor.v1."))).toBe(true);
  });
});

describe("批量取（/v1/files）：一个请求拿多条", () => {
  it("引擎在有 readMany 时**只发批量请求**，条数与内容都对", async () => {
    const remote = createMemoryProvider();
    const ledger = createSyncLedger({
      baseUrl: "https://example.com",
      notebookId: "nb",
      cryptoMode: "none",
      protocolVersion: 1,
    });
    // 远端放 12 篇。
    const enc2 = (text: string) => new TextEncoder().encode(text);
    const hashOf = async (bytes: Uint8Array) => {
      const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    };
    for (let index = 0; index < 12; index += 1) {
      const bytes = enc2("# n" + index);
      remote.seed(idForPath("notes/n" + index + ".md"), await hashOf(bytes), bytes);
    }

    let singleReads = 0;
    let batches = 0;
    let batchedDids = 0;
    const provider: SyncProvider = {
      name: "counting",
      cryptoMode: "none",
      tree: (options) => remote.tree(options),
      changes: (options) => remote.changes(options),
      read: async (did) => {
        singleReads += 1;
        return remote.read(did);
      },
      readMany: async (dids) => {
        batches += 1;
        batchedDids += dids.length;
        const out = new Map<string, { bytes: Uint8Array; hash: string; rev: string }>();
        for (const did of dids) {
          const result = await remote.read(did);
          if (result !== null) out.set(did, result);
        }
        return out;
      },
      put: (input) => remote.put(input),
      delete: (input) => remote.delete(input),
      checkpoint: (cursor) => remote.checkpoint(cursor),
    };

    const local = new Map<string, Uint8Array>();
    const result = await syncOnceIncremental({
      provider,
      ledger,
      deps: makeDeps(local),
      since: null,
    });

    expect(result.pulled).toBe(12);
    expect(local.size).toBe(12);
    // ★ 12 篇只发了一个批量请求，一条都没走单条路径。
    expect(batches).toBe(1);
    expect(batchedDids).toBe(12);
    expect(singleReads).toBe(0);
  });

  it("批量接口失败时**自动退回逐条**（不让整轮同步失败）", async () => {
    const remote = createMemoryProvider();
    const ledger = createSyncLedger({
      baseUrl: "https://example.com",
      notebookId: "nb",
      cryptoMode: "none",
      protocolVersion: 1,
    });
    const enc2 = (text: string) => new TextEncoder().encode(text);
    const hashOf = async (bytes: Uint8Array) => {
      const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    };
    for (let index = 0; index < 3; index += 1) {
      const bytes = enc2("# m" + index);
      remote.seed(idForPath("notes/m" + index + ".md"), await hashOf(bytes), bytes);
    }

    let singleReads = 0;
    const provider: SyncProvider = {
      name: "old-server",
      cryptoMode: "none",
      tree: (options) => remote.tree(options),
      changes: (options) => remote.changes(options),
      read: async (did) => {
        singleReads += 1;
        return remote.read(did);
      },
      // 模拟老服务端：没有这个端点。
      readMany: async () => {
        throw new Error("404 not found");
      },
      put: (input) => remote.put(input),
      delete: (input) => remote.delete(input),
      checkpoint: (cursor) => remote.checkpoint(cursor),
    };

    const local = new Map<string, Uint8Array>();
    const result = await syncOnceIncremental({ provider, ledger, deps: makeDeps(local), since: null });
    expect(result.pulled).toBe(3);
    expect(local.size).toBe(3);
    expect(singleReads).toBe(3);
  });
});

/* ============================================================================
   ④ 变更驱动：远端只动了几条时，不再整树比对
   ============================================================================ */

/** 把内存 provider 的 `changes` 补成「线上真实形状」（带 path + 内容标识），并统计列树次数。 */
function liveShapeProvider(inner: SyncProvider, options: { truncated?: boolean } = {}): SyncProvider & { treeCalls: () => number } {
  let calls = 0;
  return {
    name: "live-shape",
    cryptoMode: inner.cryptoMode,
    async tree(treeOptions) {
      calls += 1;
      return inner.tree(treeOptions);
    },
    async changes(changeOptions) {
      const page = await inner.changes(changeOptions);
      const snapshot = (inner as unknown as { snapshot?: () => Record<string, string> }).snapshot?.() ?? {};
      return {
        ...page,
        truncated: options.truncated === true,
        changes: page.changes.map((change) => {
          const hash = snapshot[change.did];
          const path = change.op === "delete" ? undefined : pathFromLegacyId(change.did);
          return {
            ...change,
            ...(hash === undefined ? {} : { hash }),
            ...(path === undefined ? {} : { path }),
          };
        }),
      };
    },
    read: (did) => inner.read(did),
    put: (input) => inner.put(input),
    delete: (input) => inner.delete(input),
    checkpoint: (cursor) => inner.checkpoint(cursor),
    treeCalls: () => calls,
  };
}

describe("变更驱动：只按 changes 干活，不列整树", () => {
  it("远端改了一篇 ⇒ **不列树**，只把那一条拉下来", async () => {
    const remote = createMemoryProvider();
    const provider = liveShapeProvider(remote);
    const ledger = createSyncLedger({
      baseUrl: "https://example.com",
      notebookId: "nb",
      cryptoMode: "none",
      protocolVersion: 1,
    });
    const local = new Map<string, Uint8Array>();

    // 第一轮：全树（没有游标）。
    await syncOnceIncremental({ provider, ledger, deps: makeDeps(local), since: null });
    const cursor = remote.currentCursor();
    expect(provider.treeCalls()).toBeGreaterThan(0);

    // 另一端改了一篇（远端游标前进）。
    const bytes = enc("# 改过了");
    const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    remote.seed(idForPath("notes/a.md"), hash, bytes);

    provider.treeCalls(); // 归零前的读数
    const before = provider.treeCalls();
    const result = await syncOnceIncremental({ provider, ledger, deps: makeDeps(local), since: cursor });

    // ★ 关键断言：**一次 tree 都没调**。
    expect(provider.treeCalls()).toBe(before);
    expect(result.pulled).toBe(1);
    expect(new TextDecoder().decode(local.get("notes/a.md")!)).toBe("# 改过了");
  });

  it("远端删了一篇 ⇒ 本地跟着删，而且**不列树**", async () => {
    const remote = createMemoryProvider();
    const provider = liveShapeProvider(remote);
    const ledger = createSyncLedger({
      baseUrl: "https://example.com",
      notebookId: "nb",
      cryptoMode: "none",
      protocolVersion: 1,
    });
    const local = new Map<string, Uint8Array>();
    const bytes = enc("# 要删的");
    const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    remote.seed(idForPath("notes/gone.md"), hash, bytes);

    await syncOnceIncremental({ provider, ledger, deps: makeDeps(local), since: null });
    expect(local.has("notes/gone.md")).toBe(true);
    const cursor = remote.currentCursor();

    await remote.delete({ did: idForPath("notes/gone.md"), baseHash: hash });

    const before = provider.treeCalls();
    const result = await syncOnceIncremental({ provider, ledger, deps: makeDeps(local), since: cursor });
    expect(provider.treeCalls()).toBe(before);
    expect(result.deleted).toBe(1);
    expect(local.has("notes/gone.md")).toBe(false);
  });

  it("`changes` 说这一页没装完 ⇒ **必须**退回整树（不能只按这一页办事）", async () => {
    const remote = createMemoryProvider();
    const provider = liveShapeProvider(remote, { truncated: true });
    const ledger = createSyncLedger({
      baseUrl: "https://example.com",
      notebookId: "nb",
      cryptoMode: "none",
      protocolVersion: 1,
    });
    const local = new Map<string, Uint8Array>();
    await syncOnceIncremental({ provider, ledger, deps: makeDeps(local), since: null });
    const cursor = remote.currentCursor();

    const bytes = enc("# 新写的");
    const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    remote.seed(idForPath("notes/x.md"), hash, bytes);

    const before = provider.treeCalls();
    await syncOnceIncremental({ provider, ledger, deps: makeDeps(local), since: cursor });
    expect(provider.treeCalls()).toBeGreaterThan(before);
  });

  it("认不出 did 的路径（E2EE 那种情况）⇒ 退回整树，不猜", async () => {
    const remote = createMemoryProvider();
    const ledger = createSyncLedger({
      baseUrl: "https://example.com",
      notebookId: "nb",
      cryptoMode: "none",
      protocolVersion: 1,
    });
    // 故意让 provider 的 changes 不带 path、且 did 也不在本机已知路径里。
    let treeCalls = 0;
    const provider: SyncProvider = {
      name: "no-path",
      cryptoMode: "none",
      tree: (o) => {
        treeCalls += 1;
        return remote.tree(o);
      },
      changes: async () => ({ cursor: remote.currentCursor(), truncated: false, changes: [{ did: "h:unknown", op: "update" as const, hash: "a".repeat(64) }] }),
      read: (did) => remote.read(did),
      put: (input) => remote.put(input),
      delete: (input) => remote.delete(input),
      checkpoint: (cursor) => remote.checkpoint(cursor),
    };
    const local = new Map<string, Uint8Array>();
    await syncOnceIncremental({ provider, ledger, deps: makeDeps(local), since: "1" });
    // 认不出 ⇒ 走整树（tree 至少被调一次）。
    expect(treeCalls).toBeGreaterThan(0);
  });
});

describe("buildPartialTree：什么时候**不能**拼树", () => {
  it("账本里有「物化过但没有远端标识」的条目 ⇒ 返回 null（否则会把本地文件当成远端删了）", () => {
    const ledger = createSyncLedger({
      baseUrl: "https://example.com",
      notebookId: "nb",
      cryptoMode: "none",
      protocolVersion: 1,
    });
    ledger.files["notes/a.md"] = {
      bid: 1,
      localHash: "x",
      remoteHash: null, // ← 正是这个状态让「拼树」不成立
      rev: null,
      imported: true,
      syncedAt: 0,
    };
    const tree = buildPartialTree([{ path: "notes/b.md", hash: "b".repeat(64) }], ledger, idForPath);
    expect(tree).toBeNull();
  });

  it("变更太多 ⇒ 返回 null（整树反而更便宜）", () => {
    const ledger = createSyncLedger({
      baseUrl: "https://example.com",
      notebookId: "nb",
      cryptoMode: "none",
      protocolVersion: 1,
    });
    const changed = Array.from({ length: PARTIAL_CHANGE_LIMIT + 1 }, (_, index) => ({
      path: "notes/n" + index + ".md",
      hash: "a".repeat(64),
    }));
    expect(buildPartialTree(changed, ledger, idForPath)).toBeNull();
  });

  it("拼出来的树里，没变的条目沿用账本的远端标识（这样 planPull 才不会误判删除）", () => {
    const ledger = createSyncLedger({
      baseUrl: "https://example.com",
      notebookId: "nb",
      cryptoMode: "none",
      protocolVersion: 1,
    });
    ledger.files["notes/keep.md"] = {
      bid: 1,
      localHash: "l1",
      remoteHash: "r1",
      rev: "1-a",
      imported: true,
      syncedAt: 0,
    };
    const tree = buildPartialTree([{ path: "notes/changed.md", hash: "r2" }], ledger, idForPath);
    expect(tree).not.toBeNull();
    const byPath = new Map(tree!.entries.map((entry) => [entry.did, entry.hash]));
    expect(byPath.get(idForPath("notes/keep.md"))).toBe("r1");
    expect(byPath.get(idForPath("notes/changed.md"))).toBe("r2");
  });
});
