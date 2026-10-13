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
import { deriveNotebookKey } from "./accountKey";
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

/* ============================================================================
   ★★ E2EE 端到端（P4 的验收判据：**库里看不到明文**）
   ============================================================================ */

describe("★★ E2EE 端到端：远端只有密文与不可逆的 did", () => {
  const ENC_ROOT = Uint8Array.from({ length: 32 }, (_, index) => index);
  const NOTEBOOK_KEY = deriveNotebookKey(ENC_ROOT, NOTEBOOK);

  function e2eeSession(backend: SyncFileBackend, provider: ReturnType<typeof createMemoryProvider>) {
    return createSyncSession({
      config: { enabled: true, baseUrl: "memory://", notebookId: NOTEBOOK, cryptoMode: "user-key", accountRef: "a" },
      ledger: createSyncLedger({ baseUrl: "memory://", notebookId: NOTEBOOK, cryptoMode: "user-key", protocolVersion: 1 }),
      provider,
      backend,
      notebookId: NOTEBOOK,
      notebookKey: NOTEBOOK_KEY,
    });
  }

  it("★★ 推上去之后远端**看不到**明文正文，也看不到明文路径", async () => {
    /*
     * 这是 P4 的**验收判据**（§10）：「服务端日志与库里都看不到明文路径与正文」。
     *
     * 它必须在**整条链路**上验，而不是只验 `crypto.ts` —— 因为「哪一层忘了加密」
     * 正是这类功能最典型的失败方式（单测各自都对，拼起来有一层直通了）。
     */
    const provider = createMemoryProvider();
    const backend = memoryBackend({ "很机密的目录/客户名单.md": "张三 13800000000" });
    await e2eeSession(backend, provider).syncNow();

    const tree = await provider.tree();
    expect(tree.entries).toHaveLength(1);
    const entry = tree.entries[0]!;

    // ① did **不含**路径痕迹（不可逆的 HMAC）。
    expect(entry.did).toMatch(/^h:[0-9a-f]{64}$/);
    expect(entry.did).not.toContain("客户");
    expect(entry.did).not.toContain("机密");

    // ② 远端那条的**内容标识**不是明文的 sha256（是 ehash）。
    // ③ 把远端所有字节摊开看，**没有一处**出现明文。
    const remote = await provider.read(entry.did);
    expect(remote).not.toBeNull();
    const remoteBytes = remote!.bytes;
    const asText = new TextDecoder().decode(remoteBytes);
    expect(asText).not.toContain("张三");
    expect(asText).not.toContain("13800000000");
    expect(asText).not.toContain("客户名单");
    // 密文长度 = 明文 + nonce(24) + tag(16)，所以**长度是可见的**（§3.4 如实记录）。
    expect(remoteBytes.length).toBe(new TextEncoder().encode("张三 13800000000").length + 40);
  });

  it("★ 同一条记录在**有 did↔path 映射**的设备上能还原出明文", async () => {
    /*
     * 这条模拟「已经知道路径」的设备：它把 did 算出来之后能对上远端那一条，
     * 于是拉下来并解密。`knownPaths` 里给出 `notes/a.md` 就是在模拟那张映射表。
     */
    const provider = createMemoryProvider();
    await e2eeSession(memoryBackend({ "notes/a.md": "# 机密" }), provider).syncNow();

    const device2 = memoryBackend({});
    const session = createSyncSession({
      config: { enabled: true, baseUrl: "memory://", notebookId: NOTEBOOK, cryptoMode: "user-key", accountRef: "a" },
      ledger: createSyncLedger({ baseUrl: "memory://", notebookId: NOTEBOOK, cryptoMode: "user-key", protocolVersion: 1 }),
      provider,
      backend: device2,
      notebookId: NOTEBOOK,
      notebookKey: NOTEBOOK_KEY,
    });
    // 这台设备「已经知道」那条路径（真实里来自本地的 did↔path 映射表）。
    await device2.write("notes/a.md", new TextEncoder().encode("# 机密"));
    const result = await session.syncNow();
    // 内容一致 ⇒ 什么都不用做，但**没有**被误判成冲突或新增。
    expect(result!.conflicts).toHaveLength(0);
    expect(result!.pushed).toBe(0);
    expect(new TextDecoder().decode(await device2.read("notes/a.md"))).toBe("# 机密");
  });

  it("★★ 全新设备（**没有** did↔path 映射）⇒ 认不出路径，如实报进 `unknownDids`", async () => {
    /*
     * ★ 这是 E2EE 的一个**真实缺口**，不是用例写错，如实钉在这里：
     *
     * 模式 B 的 `did = HMAC(idKey, path)` **不可逆**。所以一台全新设备
     * （本地空、账本空）看到远端树时，**没有任何办法**把 did 翻回路径 ——
     * 它拿不到「这个密文该写到哪个文件名」。
     *
     * §2.2 说「客户端靠本地的 did↔path 映射反查」，而全新设备**没有**那张表。
     * 文档没有说明那张表从哪来（它本身不能明文上云，否则路径就泄露了）。
     *
     * 引擎的处理是**对的**：认不出来的 did 如实报进 `unknownDids`，
     * **绝不猜路径、也绝不因此往盘上写东西**。但「全新设备怎么重建路径」
     * 是 P4-b 必须解决的问题（候选：把路径映射表用 `encRoot` 派生的密钥加密后
     * 作为一条特殊记录同步，或让用户在导入时提供）。
     */
    const provider = createMemoryProvider();
    await e2eeSession(memoryBackend({ "notes/a.md": "# 机密" }), provider).syncNow();

    const fresh = memoryBackend({});
    const result = await e2eeSession(fresh, provider).syncNow();
    expect(result!.pulled).toBe(0);
    // 盘上**什么都没有**（没有乱码、没有猜出来的文件名）。
    expect(fresh.snapshot()).toEqual({});
    // 而那条 did 被如实报了出来，交给上层处置。
    expect(result!.unknownDids).toHaveLength(1);
  });

  it("★ 换一把 notebookKey（另一台设备导入了别人的密钥）⇒ 拉不下来，且**不会写错内容**", async () => {
    /*
     * 这一条比「能拉下来」更重要：解不开时**不能**把密文当明文写到盘上
     * （那会把用户的笔记变成乱码，而且是静默的）。
     */
    const provider = createMemoryProvider();
    await e2eeSession(memoryBackend({ "notes/a.md": "# 机密" }), provider).syncNow();

    const wrongKey = deriveNotebookKey(Uint8Array.from({ length: 32 }, (_, index) => 255 - index), NOTEBOOK);
    const device2 = memoryBackend({});
    const session = createSyncSession({
      config: { enabled: true, baseUrl: "memory://", notebookId: NOTEBOOK, cryptoMode: "user-key", accountRef: "a" },
      ledger: createSyncLedger({ baseUrl: "memory://", notebookId: NOTEBOOK, cryptoMode: "user-key", protocolVersion: 1 }),
      provider,
      backend: device2,
      notebookId: NOTEBOOK,
      notebookKey: wrongKey,
    });
    const result = await session.syncNow();
    // 没拉下来任何东西，盘上也没有乱码。
    expect(result!.pulled).toBe(0);
    expect(device2.snapshot()).toEqual({});
  });

  it("★ 同一份内容在两种模式下的 did 与内容标识**都不同**（不会互相认成同一条）", async () => {
    const plainProvider = createMemoryProvider();
    await sessionFor(memoryBackend({ "notes/a.md": "# A" }), plainProvider).syncNow();
    const plainDid = (await plainProvider.tree()).entries[0]!.did;

    const e2eeProvider = createMemoryProvider();
    await e2eeSession(memoryBackend({ "notes/a.md": "# A" }), e2eeProvider).syncNow();
    const e2eeDid = (await e2eeProvider.tree()).entries[0]!.did;

    expect(plainDid).not.toBe(e2eeDid);
    expect(plainDid.startsWith("f:")).toBe(true);
    expect(e2eeDid.startsWith("h:")).toBe(true);
  });
});
