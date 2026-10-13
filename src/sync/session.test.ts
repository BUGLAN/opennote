/**
 * 同步会话的集成用例（`docs/执行-三端同步…` §5.3、§5.4、§5.1、§10.1）。
 *
 * ## 这是第一组**端到端**的用例
 *
 * 前面每一块都只测了自己那一件事。这里把它们拼起来，跑**真的**一轮同步
 * （内存后端 + memory provider），于是那些「各自都对、拼起来不对」的问题才有地方暴露 ——
 * 例如 `knownPaths` 忘了带上账本里的路径（见下）。
 */
import { describe, expect, it, vi } from "vitest";
import { createSyncLedger } from "./state";
import { createMemoryProvider } from "./providers/memory";
import { createSyncSession, knownPathsOf } from "./session";
import type { LocalEntry, SyncFileBackend } from "./workspaceFiles";

const NOTEBOOK = "11111111-2222-4333-8444-555555555555";

/** 内存文件系统。 */
function memoryBackend(files: Record<string, string> = {}): SyncFileBackend & { snapshot(): Record<string, string> } {
  const store = new Map(Object.entries(files));
  const encoder = new TextEncoder();
  return {
    snapshot: () => Object.fromEntries(store),
    async list(): Promise<LocalEntry[]> {
      const out: LocalEntry[] = [];
      for (const path of store.keys()) {
        const parts = path.split("/");
        for (let index = 1; index < parts.length; index += 1) out.push({ path: parts.slice(0, index).join("/"), isDir: true });
        out.push({ path, isDir: false });
      }
      return out;
    },
    async read(path) {
      const value = store.get(path);
      if (value === undefined) throw new Error(`没有这个文件：${path}`);
      return encoder.encode(value);
    },
    async write(path, bytes) {
      store.set(path, new TextDecoder().decode(bytes));
    },
    async remove(path) {
      store.delete(path);
    },
  };
}

function ledger() {
  return createSyncLedger({ baseUrl: "memory://", notebookId: NOTEBOOK, cryptoMode: "none", protocolVersion: 1 });
}

function sessionFor(backend: SyncFileBackend, provider: ReturnType<typeof createMemoryProvider>, overrides: Record<string, unknown> = {}) {
  return createSyncSession({
    config: { enabled: true, baseUrl: "memory://", notebookId: NOTEBOOK, cryptoMode: "none", accountRef: "a" },
    ledger: ledger(),
    provider,
    backend,
    notebookId: NOTEBOOK,
    ...overrides,
  });
}

/* ============================================================================
   ★ 端到端
   ============================================================================ */

describe("★ 端到端：本地改了推上去，另一台设备拉下来", () => {
  it("推：本地文件出现在远端树里", async () => {
    const provider = createMemoryProvider();
    const backend = memoryBackend({ "notes/a.md": "# A" });
    const session = sessionFor(backend, provider);

    const result = await session.syncNow();
    expect(result).not.toBeNull();
    expect(result!.pushed).toBe(1);
    const tree = await provider.tree();
    expect(tree.entries.map((entry) => entry.did)).toHaveLength(1);
  });

  it("★ 拉：另一台设备（**空的**后端 + **自己的**账本）把内容拉下来", async () => {
    const provider = createMemoryProvider();
    // ── 设备 1：写一条并推上去 ──
    const device1 = memoryBackend({ "notes/a.md": "# 来自设备 1" });
    await sessionFor(device1, provider).syncNow();

    // ── 设备 2：空后端、自己的账本 ──
    const device2 = memoryBackend({});
    const result = await sessionFor(device2, provider).syncNow();
    expect(result!.pulled).toBe(1);
    expect(device2.snapshot()).toEqual({ "notes/a.md": "# 来自设备 1" });
  });

  it("★ 本地删除会推到远端（留下墓碑，不是静默消失）", async () => {
    const provider = createMemoryProvider();
    const backend = memoryBackend({ "notes/a.md": "# A" });
    const session = sessionFor(backend, provider);
    await session.syncNow();

    await backend.remove("notes/a.md");
    const result = await session.syncNow();
    expect(result!.remoteDeleted).toBe(1);
    // 远端树里没有了。
    expect((await provider.tree()).entries).toHaveLength(0);
  });

  it("忽略的文件**不进远端**（红线 8：同步范围 = 忽略规则）", async () => {
    const provider = createMemoryProvider();
    const backend = memoryBackend({ "notes/a.md": "# A", ".git/config": "[core]", "build/out.js": "x" });
    const session = sessionFor(backend, provider, { gitignoreText: "build/" });
    await session.syncNow();
    // 只有 notes/a.md 上去了。
    expect((await provider.tree()).entries).toHaveLength(1);
  });
});

/* ============================================================================
   ★ 两个账号互相看不到（§10.1）
   ============================================================================ */

describe("★ §10.1 · 两个账号各自同步成功且互相看不到", () => {
  it("两个独立的 provider（= 两个笔记本库）互不影响", async () => {
    /*
     * 服务端侧的隔离（M1–M3：非成员拿到与「不存在」逐字相同的 404）
     * 已经在真机上验过。这里验的是**客户端这一侧**：
     * 两套会话各自只看到自己那个 provider 里的东西。
     */
    const providerA = createMemoryProvider({ name: "A" });
    const providerB = createMemoryProvider({ name: "B" });
    const backendA = memoryBackend({ "notes/a.md": "A 的秘密" });
    const backendB = memoryBackend({ "notes/b.md": "B 的秘密" });

    await sessionFor(backendA, providerA).syncNow();
    await sessionFor(backendB, providerB).syncNow();

    expect((await providerA.tree()).entries).toHaveLength(1);
    expect((await providerB.tree()).entries).toHaveLength(1);
    // A 那边没有 B 的任何痕迹。
    const treeA = await providerA.tree();
    expect(treeA.entries.map((entry) => entry.did)).not.toEqual((await providerB.tree()).entries.map((entry) => entry.did));
  });
});

/* ============================================================================
   ★ 关掉的同步不许跑
   ============================================================================ */

describe("★ §5.1 · 同步是**旁路**：关掉就一次请求都不发", () => {
  it("`enabled: false` ⇒ `syncNow()` 返回 null，且 provider **完全没被碰过**", async () => {
    /*
     * 一个「配置说关、实际在跑」的实现会往用户没同意的地址发数据 ——
     * 所以这里断言的是「provider 一次都没被调用」，不是「返回了 null」。
     */
    const provider = createMemoryProvider();
    const spy = vi.spyOn(provider, "tree");
    const backend = memoryBackend({ "notes/a.md": "# A" });
    const session = sessionFor(backend, provider, {
      config: { enabled: false, baseUrl: "memory://", notebookId: NOTEBOOK, cryptoMode: "none", accountRef: "a" },
    });

    expect(await session.syncNow()).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(backend.snapshot()).toEqual({ "notes/a.md": "# A" });
  });

  it("★ 去抖触发的路径也要判 `enabled`（它不经过 `syncNow()`）", async () => {
    /*
     * `runner` 会被去抖与信号触发，那些路径**不经过** `syncNow()`。
     * 只在 `syncNow()` 里判 `enabled` 会留下一个「关掉了但去抖仍在跑」的洞。
     */
    const provider = createMemoryProvider();
    const spy = vi.spyOn(provider, "tree");
    const timers: (() => void)[] = [];
    const session = sessionFor(memoryBackend({ "notes/a.md": "# A" }), provider, {
      config: { enabled: false, baseUrl: "memory://", notebookId: NOTEBOOK, cryptoMode: "none", accountRef: "a" },
      setTimeoutFn: (fn: () => void) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimeoutFn: () => undefined,
    });

    session.runner.scheduleAfterLocalWrite();
    timers.forEach((fn) => fn());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spy).not.toHaveBeenCalled();
  });
});

/* ============================================================================
   ★ knownPaths 必须带账本里的路径
   ============================================================================ */

describe("★ `knownPaths` 必须来自**账本**，不能只用本地扫描结果", () => {
  it("账本里记着的路径会出现在 `knownPaths()` 里", async () => {
    /*
     * 引擎靠它把远端树里的 did 翻回本机路径（E2EE 下 did 不可逆，
     * 只能「把所有已知路径各算一次 did」）。
     *
     * 如果只给本地**当前存在**的文件，那么「本地删了、远端还在」的那些路径查不出来 ——
     * 于是远端那条永远拉不下来，症状是「另一台设备上删过的文件在这台设备上又出现了」。
     */
    const shared = ledger();
    shared.files["notes/已被删掉的.md"] = { bid: 1, hash: "x", syncedAt: 0, size: 0 } as never;
    const backend = memoryBackend({ "notes/还在的.md": "# A" });
    const provider = createMemoryProvider();
    const session = createSyncSession({
      config: { enabled: true, baseUrl: "memory://", notebookId: NOTEBOOK, cryptoMode: "none", accountRef: "a" },
      ledger: shared,
      provider,
      backend,
      notebookId: NOTEBOOK,
    });

    const paths = await session.deps.knownPaths();
    expect(paths).toContain("notes/已被删掉的.md");
    expect(paths).toContain("notes/还在的.md");
    // 而 `listLocal` 只看本地**当前**存在的。
    expect((await session.deps.listLocal()).map((item) => item.path)).toEqual(["notes/还在的.md"]);
    expect(knownPathsOf(shared)).toContain("notes/已被删掉的.md");
  });
});
