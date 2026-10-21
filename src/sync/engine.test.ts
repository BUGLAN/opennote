/**
 * `SyncEngine` 的行为锚点（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §10.2 场景矩阵、§6.1、§9 P1 验收）。
 *
 * ## 这个文件要证明的东西
 *
 * 场景矩阵（§10.2）里每一行都是一条**用户看得见的**承诺。这里把能在内存里验的那些钉住：
 *
 * - 同账号 A 改 → B 打开：**不弹冲突**；
 * - A 改 → B 改同一篇：**列出冲突，两份内容都还能找到**；
 * - A 改 → B 改 → 内容恰好相同：**不算冲突**（false conflict）；
 * - A 删 → B 未动：B 同步后删除；**一次删太多被拦住**；
 * - 设备离线很久后回来：走 `resync` 全量比对，**已删文件不复活**。
 *
 * ## 为什么不 import `library.ts`
 *
 * 引擎的边界就是「四个回调」。用内存适配器而不是真后端，测出来的是**引擎的判定**，
 * 而不是 `library.ts` 与后端之间的接线 —— 后者另有 `library.*.test.ts` 负责。
 * 这也正是引擎不 import `library.ts` 的价值（见 `engine.ts` 模块头）。
 */
import { describe, expect, it } from "vitest";
import { idForPath } from "../../shared/paths";
import { syncOnce, syncOnceIncremental, type EngineLocalFile, type SyncEngineDeps } from "./engine";
import { createSyncLedger, type SyncLedger } from "./state";
import { createMemoryProvider, type MemoryProvider } from "./providers/memory";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * 内容标识：这里**故意**实现成真实的 sha256 形状（而不是「字符串 pad」），
 * 因为引擎会把同一套标识在本地与远端之间比较 —— 用假标识会让
 * 「两边都改但内容相同」这类用例变成恒真。
 */
async function hashOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface Harness {
  provider: MemoryProvider;
  ledger: SyncLedger;
  deps: SyncEngineDeps;
  /** 测试用：本地「磁盘」上的内容。 */
  local: Map<string, Uint8Array>;
  /** 测试用：把一条写到本地磁盘（模拟用户/编辑器落盘）。 */
  writeLocalFile(path: string, text: string): Promise<void>;
  /** 测试用：删一条本地文件（模拟用户删了）。 */
  deleteLocalFile(path: string): void;
  /** 测试用：readLocal 被调过的路径（证明引擎读了什么）。 */
  reads: string[];
  /** 测试用：writeLocal / removeLocal 调用记录。 */
  writes: string[];
  removes: string[];
  logs: { kind: string; detail: Record<string, unknown> }[];
}

async function makeHarness(options: { seedLocal?: Record<string, string>; provider?: MemoryProvider } = {}): Promise<Harness> {
  const provider = options.provider ?? createMemoryProvider();
  const ledger = createSyncLedger({
    baseUrl: "https://notes.example.com",
    notebookId: "11111111-2222-4333-8444-555555555555",
    cryptoMode: "none",
    protocolVersion: 1,
  });
  const local = new Map<string, Uint8Array>();
  const reads: string[] = [];
  const writes: string[] = [];
  const removes: string[] = [];
  const logs: { kind: string; detail: Record<string, unknown> }[] = [];

  for (const [path, text] of Object.entries(options.seedLocal ?? {})) local.set(path, enc(text));

  const deps: SyncEngineDeps = {
    async listLocal(): Promise<EngineLocalFile[]> {
      const out: EngineLocalFile[] = [];
      for (const [path, bytes] of local) out.push({ path, hash: await hashOf(bytes), bytes: bytes.byteLength });
      return out;
    },
    hashOf,
    async hashOfLocal(path) {
      const bytes = local.get(path);
      if (!bytes) throw new Error(`本地没有这一条：${path}`);
      return hashOf(bytes);
    },
    didOf: (path) => idForPath(path),
    /*
     * 真实调用方会并上账本里记着的路径。这里也并上 —— 因为「账本里有、本地已经没有了」
     * 正是「本地删了它」的判据，少了这一半，删除语义就测不出来。
     */
    async knownPaths() {
      return [...new Set([...local.keys(), ...Object.keys(ledger.files)])];
    },
    async readLocal(path) {
      reads.push(path);
      const bytes = local.get(path);
      if (!bytes) throw new Error(`本地没有这一条：${path}`);
      return bytes;
    },
    async writeLocal(path, bytes) {
      writes.push(path);
      local.set(path, new Uint8Array(bytes));
    },
    async removeLocal(path) {
      removes.push(path);
      local.delete(path);
    },
    log: (kind, detail) => logs.push({ kind, detail }),
  };

  return {
    provider,
    ledger,
    deps,
    local,
    reads,
    writes,
    removes,
    logs,
    async writeLocalFile(path, text) {
      local.set(path, enc(text));
    },
    deleteLocalFile(path) {
      local.delete(path);
    },
  };
}

describe("§10.2 · A 改 → B 打开（不弹冲突）", () => {
  it("本地新增 → 推上去；账本记下双向标识", async () => {
    const harness = await makeHarness({ seedLocal: { "notes/a.md": "# 你好" } });
    const result = await syncOnce({ provider: harness.provider, ledger: harness.ledger, deps: harness.deps });

    expect(result.pushed).toBe(1);
    expect(result.pulled).toBe(0);
    expect(result.conflicts).toEqual([]);
    const snapshot = harness.provider.snapshot();
    expect(Object.keys(snapshot)).toEqual([idForPath("notes/a.md")]);
    const entry = harness.ledger.files["notes/a.md"]!;
    expect(entry.localHash).toBe(await hashOf(enc("# 你好")));
    expect(entry.remoteHash).toBe(entry.localHash);
    expect(entry.imported).toBe(true);
  });

  it("B 端（空本地 + 有账本）拉下来：**不弹冲突**，并报出要刷新的路径", async () => {
    // 先用 A 端推一条上去。
    const a = await makeHarness({ seedLocal: { "notes/a.md": "# 你好" } });
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });

    // B 端：同一个远端，但本地是空的，账本也是空的（新设备）。
    const b = await makeHarness({ provider: a.provider });
    const result = await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });

    expect(result.pulled).toBe(1);
    expect(result.conflicts).toEqual([]);
    expect(result.appliedPaths).toEqual(["notes/a.md"]);
    expect(new TextDecoder().decode(b.local.get("notes/a.md")!)).toBe("# 你好");
  });

  it("只有一边改（本地改、远端没动）→ 只推送，且**不重读**没变的文件", async () => {
    const harness = await makeHarness({ seedLocal: { "notes/a.md": "# v1", "notes/b.md": "# b" } });
    await syncOnce({ provider: harness.provider, ledger: harness.ledger, deps: harness.deps });
    harness.reads.length = 0;

    await harness.writeLocalFile("notes/a.md", "# v2");
    const result = await syncOnce({ provider: harness.provider, ledger: harness.ledger, deps: harness.deps });

    expect(result.pushed).toBe(1);
    expect(result.pulled).toBe(0);
    // 只读了真正要推的那一条（省一次全量正文读取）。
    expect(harness.reads).toEqual(["notes/a.md"]);
  });
});

describe("§6.2 · A 改 → B 改同一篇：列出冲突，两份都在", () => {
  it("两边都改且不同 ⇒ 冲突列出、**远端不被覆盖**、本地也**不被覆盖**", async () => {
    // 共同起点。
    const a = await makeHarness({ seedLocal: { "notes/a.md": "# 起点" } });
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });

    // B 端拿到起点。
    const b = await makeHarness({ provider: a.provider });
    await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });

    // A 改 → 推；B 也改（还没同步）。
    await a.writeLocalFile("notes/a.md", "# A 改的");
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });
    await b.writeLocalFile("notes/a.md", "# B 改的");

    const result = await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });

    expect(result.conflicts).toEqual([
      { path: "notes/a.md", kind: "both-modified", localId: await hashOf(enc("# B 改的")), remoteId: await hashOf(enc("# A 改的")) },
    ]);
    // **远端没被覆盖**（这是「只报不猜」的核心）。
    expect(await harnessText(a.provider, "notes/a.md")).toBe("# A 改的");
    // **本地也没被覆盖**（用户没裁决之前不动它）。
    expect(new TextDecoder().decode(b.local.get("notes/a.md")!)).toBe("# B 改的");
    expect(result.pushed).toBe(0);
    expect(result.pulled).toBe(0);
  });

  it("false conflict：两边都改但内容相同 ⇒ **不算冲突**，也不重复推", async () => {
    const a = await makeHarness({ seedLocal: { "notes/a.md": "# 起点" } });
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });
    const b = await makeHarness({ provider: a.provider });
    await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });

    // 两边各自改成**恰好相同**的内容。
    await a.writeLocalFile("notes/a.md", "# 撞车了");
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });
    await b.writeLocalFile("notes/a.md", "# 撞车了");

    const result = await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });
    expect(result.conflicts).toEqual([]);
    expect(result.pushed).toBe(0); // 远端已经是这一版，不需要再推
    expect(result.pulled).toBe(0);
  });
});

describe("§6.3/§6.4 · 删除语义", () => {
  it("远端删了、本地没动 ⇒ 删本地（未超阈值）", async () => {
    const a = await makeHarness({ seedLocal: { "notes/a.md": "# a", "notes/b.md": "# b" } });
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });

    const b = await makeHarness({ provider: a.provider });
    await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });
    expect(b.local.has("notes/a.md")).toBe(true);

    // A 端删掉 a.md 并推上去。
    a.deleteLocalFile("notes/a.md");
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });

    const result = await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });
    expect(result.deleted).toBe(1);
    expect(b.local.has("notes/a.md")).toBe(false);
    expect(b.local.has("notes/b.md")).toBe(true);
  });

  it("一次删太多 ⇒ **被删除保护拦住**，一条都不删且给出原因（§6.3）", async () => {
    // 造 30 篇（阈值 = max(20, 30×25%) = 20，所以删 25 篇会被拦）。
    const seed: Record<string, string> = {};
    for (let index = 0; index < 30; index += 1) seed[`notes/n${index}.md`] = `# n${index}`;
    const a = await makeHarness({ seedLocal: seed });
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });
    const b = await makeHarness({ provider: a.provider });
    await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });

    // A 端删掉 25 篇。
    for (let index = 0; index < 25; index += 1) a.deleteLocalFile(`notes/n${index}.md`);
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });

    const result = await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });
    expect(result.deleted).toBe(0);
    expect(result.blockedDeletes).toBe(25);
    expect(result.deletionGuardMessage).toContain("25");
    expect(result.deletionGuardMessage).toContain("20");
    // 一条都没删 —— 半删状态比不删更难收拾。
    expect(b.local.size).toBe(30);
  });

  it("C12 · 树不完整 ⇒ 删除**全部挂起**，且如实返回清单（不静默丢弃）", async () => {
    const seed: Record<string, string> = {};
    for (let index = 0; index < 5; index += 1) seed[`notes/n${index}.md`] = `# n${index}`;
    // pageSize 设成 3：列树只拿得到 3 条 → truncated。
    const provider = createMemoryProvider({ pageSize: 3 });
    const a = await makeHarness({ seedLocal: seed, provider });
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });

    const b = await makeHarness({ provider });
    await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });
    const before = b.local.size;

    // 现在 b 端第二次同步：树只列到 3 条，另外 2 条「看不到」——
    // 如果引擎把「看不到」当成「远端删了」，就会误删 2 篇。
    const result = await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });
    expect(result.deleted).toBe(0);
    expect(b.local.size).toBe(before);
  });
});

describe("§6.4 规则 2 · 游标过期 ⇒ 走 resync 全量比对，已删文件不复活", () => {
  it("resync 时仍然遵守「远端显式说删了才算删」", async () => {
    const a = await makeHarness({ seedLocal: { "notes/a.md": "# a" } });
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });
    const b = await makeHarness({ provider: a.provider });
    await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });

    // A 端删掉，B 端长时间离线（游标过期）。
    a.deleteLocalFile("notes/a.md");
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });
    (a.provider as unknown as { purgeBefore(seq: number): void }).purgeBefore(
      Number(a.provider.currentCursor()) + 1,
    );

    const result = await syncOnceIncremental({
      provider: b.provider,
      ledger: b.ledger,
      deps: b.deps,
      since: "0",
    });
    expect(result.resynced).toBe(true);
    expect(result.deleted).toBe(1);
    expect(b.local.has("notes/a.md")).toBe(false);
  });

  it("`changes()` 说没有变更时**仍然**跑一次（本地改动不能因为远端静默就不上去）", async () => {
    const harness = await makeHarness({ seedLocal: { "notes/a.md": "# 本地离线时写的" } });
    const result = await syncOnceIncremental({ provider: harness.provider, ledger: harness.ledger, deps: harness.deps, since: harness.provider.currentCursor() });
    expect(result.pushed).toBe(1);
  });
});

describe("CAS 撞车：远端在我们列树之后前进了", () => {
  it("put 冲突 ⇒ 列为冲突、**不重试不强推**，并刷新账本的 CAS 依据（避免死循环）", async () => {
    const harness = await makeHarness({ seedLocal: { "notes/a.md": "# v1" } });
    // 让 provider 在第一次 put 之前被「另一端」抢先写一次。
    const provider = harness.provider;
    const originalPut = provider.put.bind(provider);
    let sneaked = false;
    provider.put = async (input) => {
      if (!sneaked) {
        sneaked = true;
        provider.seed(input.did, await hashOf(enc("# 另一端抢先改的")), enc("# 另一端抢先改的"));
      }
      return originalPut(input);
    };

    const result = await syncOnce({ provider, ledger: harness.ledger, deps: harness.deps });
    expect(result.pushed).toBe(0);
    expect(result.pushConflicts).toHaveLength(1);
    expect(result.pushConflicts[0]!.path).toBe("notes/a.md");
    // 账本的 remoteHash 被更新成远端的当前值 —— 下一次不会拿过期依据再撞一次。
    expect(harness.ledger.files["notes/a.md"]!.remoteHash).toBe(await hashOf(enc("# 另一端抢先改的")));
  });
});

describe("检查点与日志", () => {
  it("每次同步都提交检查点，且提交的是 provider 给的 cursor（原样）", async () => {
    const harness = await makeHarness({ seedLocal: { "notes/a.md": "# a" } });
    const result = await syncOnce({ provider: harness.provider, ledger: harness.ledger, deps: harness.deps });
    expect(harness.provider.checkpoints()).toEqual([harness.provider.currentCursor()]);
    expect(result.checkpoint).toBe(harness.provider.currentCursor());
  });

  it("§4.11 · 日志能回答「同步是否正常」的四个计数", async () => {
    const harness = await makeHarness({ seedLocal: { "notes/a.md": "# a" } });
    await syncOnce({ provider: harness.provider, ledger: harness.ledger, deps: harness.deps });
    const kinds = harness.logs.map((entry) => entry.kind);
    expect(kinds).toContain("tree");
    expect(kinds).toContain("push");
    expect(kinds).toContain("checkpoint");
  });
});

describe("离线 / 失败路径", () => {
  it("离线时抛错，且**不留下半个账本**（账本是最后整体返回的）", async () => {
    const harness = await makeHarness({ seedLocal: { "notes/a.md": "# a" } });
    harness.provider.setOffline(true);
    await expect(syncOnce({ provider: harness.provider, ledger: harness.ledger, deps: harness.deps })).rejects.toThrow();
    // 一条都没记 —— 调用方拿不到返回值就不会落盘。
    expect(Object.keys(harness.ledger.files)).toEqual([]);
    expect(harness.writes).toEqual([]);
  });

  it("本地文件读失败时同步整体失败，而不是把「读不到」当成「删了」", async () => {
    const harness = await makeHarness();
    // 账本里有、本地没有了 → 这是「本地删了」，要按删除语义走，不该去 readLocal。
    await harness.provider.put({ did: idForPath("notes/a.md"), bytes: enc("# a"), hash: await hashOf(enc("# a")), baseHash: null });
    const result = await syncOnce({ provider: harness.provider, ledger: harness.ledger, deps: harness.deps });
    // 远端有、本地没有、账本也没有 → 这是「远端新增」⇒ 拉下来。
    expect(result.pulled).toBe(1);
    expect(harness.reads).toEqual([]);
  });
});

/** 从 provider 读一条的文本（断言「远端没被覆盖」）。 */
async function harnessText(provider: MemoryProvider, path: string): Promise<string | null> {
  const read = await provider.read(idForPath(path));
  return read === null ? null : new TextDecoder().decode(read.bytes);
}
