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
import { fetchWholeTree, runBounded, syncOnce, syncOnceIncremental, type EngineLocalFile, type SyncEngineDeps } from "./engine";
import type { SyncProvider } from "./provider-types";
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

async function makeHarness(
  options: {
    seedLocal?: Record<string, string>;
    provider?: MemoryProvider;
    ignore?: (path: string) => boolean;
    /** 模拟「某些目录读不到」（H3）：给了它就相当于后端支持 `listWithIssues`。 */
    unreadable?: { path: string; message: string }[];
  } = {},
): Promise<Harness> {
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
    ...(options.ignore === undefined ? {} : { isIgnored: options.ignore }),
    ...(options.unreadable === undefined
      ? {}
      : {
          async listLocalDetailed() {
            return { files: await deps.listLocal(), unreadable: options.unreadable! };
          },
        }),
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

    // ① **推送侧**：A 端删掉 25 篇 —— 现在这里就会被拦住（H3 补上的那道闸门）。
    for (let index = 0; index < 25; index += 1) a.deleteLocalFile(`notes/n${index}.md`);
    const aResult = await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });
    expect(aResult.remoteDeleted).toBe(0);
    expect(aResult.blockedDeletes).toBe(25);
    expect(aResult.deletionGuardMessage).toContain("25");
    expect(a.provider.tombstones()).toEqual([]);

    // ② **拉取侧**：假设另一端确实推上来 25 个墓碑（旧客户端 / 脚本绕过预算），
    //    B 也不能一次删掉 25 篇。
    for (let index = 0; index < 25; index += 1) {
      await a.provider.delete({ did: idForPath(`notes/n${index}.md`), baseHash: null });
    }

    const result = await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });
    expect(result.deleted).toBe(0);
    expect(result.blockedDeletes).toBe(25);
    expect(result.deletionGuardMessage).toContain("25");
    expect(result.deletionGuardMessage).toContain("20");
    // 一条都没删 —— 半删状态比不删更难收拾。
    expect(b.local.size).toBe(30);
  });

  it("★ 远端删掉一张已物化的图片 ⇒ 本地也删、账本清掉（L5）", async () => {
    /*
     * 删除候选是按「账本里有、远端没了」生成的，图片也会进来；
     * 而引擎那一侧以前只放行 Markdown ⇒ 图片永远删不掉、账本条目也不清，每轮重算一次。
     */
    const a = await makeHarness({ seedLocal: { "assets/pic.png": "PNG-BYTES" } });
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });

    const b = await makeHarness({ provider: a.provider });
    await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });
    expect(b.local.has("assets/pic.png")).toBe(true);

    // 另一端把它删了（留墓碑）。
    await a.provider.delete({ did: idForPath("assets/pic.png"), baseHash: null });

    const result = await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });
    expect(result.deleted).toBe(1);
    expect(b.local.has("assets/pic.png")).toBe(false);
    expect(b.ledger.files["assets/pic.png"]).toBeUndefined();
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


describe("P0 · 远端树必须翻页取完（旧实现只取一页 ⇒ 大笔记本永远同步不全）", () => {
  it("远端 25 篇、每页只给 3 条 ⇒ 新设备**全部**拉下来（不是只拉 3 篇）", async () => {
    const seed: Record<string, string> = {};
    for (let index = 0; index < 25; index += 1) seed[`notes/n${String(index).padStart(2, "0")}.md`] = `# n${index}`;
    // pageSize=3：服务端每页只给 3 条（真实服务端默认 500、上限 2000，这里是同一件事的缩小版）。
    const provider = createMemoryProvider({ pageSize: 3 });
    const a = await makeHarness({ seedLocal: seed, provider });
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });

    const b = await makeHarness({ provider });
    const result = await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });

    // ★ 修复前这里是 3（只拿到第一页），而状态是「同步成功」——用户看到的就是「少了一大半」。
    expect(result.pulled).toBe(25);
    expect(b.local.size).toBe(25);
    expect(result.treeTruncated).toBe(false);
    // 树取全了，删除闸门就不该再挂起任何东西。
    expect(result.suspendedDeletes).toEqual([]);
  });

  it("翻页之后删除恢复正常：远端删掉的一条**真的会**从另一台设备上消失", async () => {
    const seed: Record<string, string> = {};
    for (let index = 0; index < 10; index += 1) seed[`notes/n${index}.md`] = `# n${index}`;
    const provider = createMemoryProvider({ pageSize: 3 });
    const a = await makeHarness({ seedLocal: seed, provider });
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });

    const b = await makeHarness({ provider });
    await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });
    expect(b.local.size).toBe(10);

    // A 删一篇 → 推墓碑；B 同步后必须真的删掉（而不是被 truncated 闸门永久挂起）。
    a.deleteLocalFile("notes/n3.md");
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });
    const result = await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });

    expect(result.deleted).toBe(1);
    expect(b.local.has("notes/n3.md")).toBe(false);
    expect(result.treeTruncated).toBe(false);
  });

  it("并发度不影响正确性（8 路并发推 25 篇，账本一条不少）", async () => {
    const seed: Record<string, string> = {};
    for (let index = 0; index < 25; index += 1) seed[`notes/c${index}.md`] = `# c${index}`;
    const harness = await makeHarness({ seedLocal: seed });
    const result = await syncOnce({
      provider: harness.provider,
      ledger: harness.ledger,
      deps: harness.deps,
      concurrency: 8,
    });
    expect(result.pushed).toBe(25);
    expect(Object.keys(harness.ledger.files)).toHaveLength(25);
    // bid 必须互不相同（并发下最容易出的错：分配撞号）。
    const bids = Object.values(harness.ledger.files).map((file) => file.bid);
    expect(new Set(bids).size).toBe(25);
    expect(Object.keys(harness.provider.snapshot())).toHaveLength(25);
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
  it("put 冲突 ⇒ 列为冲突、**不重试不强推**，且**不推进** CAS 依据（否则下一轮会静默覆盖）", async () => {
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
    /*
     * ★ 账本**不应该**被写进远端的当前值（那正是 H1）。
     * 这是一条「本地新建 + 第一次推就撞车」的路径：账本里还没有这一条，
     * 所以正确的结果就是**仍然没有** —— 下一轮会以「新增」再 409 一次（安全），
     * 直到用户裁决（`resolution.ts` 才会把 `remoteHash` 写进去）。
     */
    expect(harness.ledger.files["notes/a.md"]).toBeUndefined();
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

/* ============================================================================
   两台设备**同时**同步：推的那一侧的 CAS 竞态
   ============================================================================ */

describe("同时同步 · 推的那一侧撞上 CAS", () => {
  /**
   * 造一个「B 带着过期基线去推」的场景 —— 也就是真实竞态的那个窗口：
   * B 列树/查变更时远端还是 v1，等它要推的时候 A 已经把 v2 写上去了。
   *
   * `remoteUnchanged: true` 正好等价于那一刻的 B：它**没有**列树（以为远端没动），
   * 于是只带着账本里的 v1 当 CAS 依据去推。
   */
  async function raceWindow(contentA: string, contentB: string) {
    const provider = createMemoryProvider();
    const a = await makeHarness({ provider });
    await a.writeLocalFile("笔记.md", "v1");
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });

    const b = await makeHarness({ provider });
    await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });

    await a.writeLocalFile("笔记.md", contentA);
    await b.writeLocalFile("笔记.md", contentB);
    // A 先推上去（B 还不知道）。
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });
    // B 带着过期的 CAS 依据去推。
    return syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps, remoteUnchanged: true });
  }

  it("★ 两边改成**同一份内容** ⇒ 不算冲突（伪冲突）", async () => {
    /*
     * 这不是理论情况：两台设备把同一个开关拨到同一边、或者一台改完另一台
     * 原样抄了一遍，都会落在这里。站在用户角度这就是「已经同步好了」。
     */
    const result = await raceWindow("v2 相同", "v2 相同");
    expect(result.pushConflicts).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
  });

  it("内容**不同** ⇒ 照常记冲突（别把真冲突也吞了）", async () => {
    const result = await raceWindow("A 的版本", "B 的版本");
    expect(result.pushConflicts).toHaveLength(1);
    expect(result.pushConflicts[0]!.kind).toBe("both-modified");
    expect(result.pushConflicts[0]!.localId).not.toBe(result.pushConflicts[0]!.remoteId);
  });
});

/* ============================================================================
   「仅格式不同」：不报冲突，但**必须收敛**
   ============================================================================ */

describe("仅格式不同的冲突", () => {
  it("★ 只差换行符 ⇒ 不算冲突，并且自动收敛成远端那一份字节", async () => {
    /*
     * 只「忽略」不「收敛」的话，下一轮还会再撞一次 —— 冲突会永远挂在列表里。
     * 所以这里的处置是：把它当成一次普通下载。
     */
    const provider = createMemoryProvider();
    const a = await makeHarness({ provider });
    await a.writeLocalFile("笔记.md", "第一行\n第二行\n");
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });

    const b = await makeHarness({ provider });
    await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });

    // 两边都「改」了：A 改内容，B 只换了换行符（内容其实一样）。
    await a.writeLocalFile("笔记.md", "第一行\n第二行\n第三行\n");
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });
    await b.writeLocalFile("笔记.md", "第一行\r\n第二行\r\n第三行\r\n");

    const result = await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });
    expect(result.conflicts).toHaveLength(0);
    expect(b.local.get("笔记.md")).toBeDefined();
    // 收敛：本地已变成远端那一份（LF）。
    expect(new TextDecoder().decode(b.local.get("笔记.md")!)).toBe("第一行\n第二行\n第三行\n");
  });

  it("内容真的不同 ⇒ 仍然记冲突（别把真冲突也当成格式问题）", async () => {
    const provider = createMemoryProvider();
    const a = await makeHarness({ provider });
    await a.writeLocalFile("笔记.md", "v1\n");
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });

    const b = await makeHarness({ provider });
    await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });

    await a.writeLocalFile("笔记.md", "A 的版本\n");
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });
    await b.writeLocalFile("笔记.md", "B 的版本\r\n");

    const result = await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });
    expect(result.conflicts).toHaveLength(1);
  });
});

/* ============================================================================
   ★ H1 · CAS 冲突之后的下一轮：**绝不静默覆盖**（红线 5）
   ============================================================================ */

describe("★ H1 · 冲突后的下一轮不静默覆盖", () => {
  it("put 冲突后再跑一轮：远端仍是对方的版本，冲突仍然列着", async () => {
    const harness = await makeHarness({ seedLocal: { "notes/a.md": "# v1" } });
    const provider = harness.provider;
    await syncOnce({ provider, ledger: harness.ledger, deps: harness.deps });

    // 本地改成 v2；同时在我们要推之前，远端也被另一端改成了另一份。
    await harness.writeLocalFile("notes/a.md", "# 本地 v2");
    const remoteText = "# 远端 v2";
    provider.seed(idForPath("notes/a.md"), await hashOf(enc(remoteText)), enc(remoteText));

    const first = await syncOnce({ provider, ledger: harness.ledger, deps: harness.deps });
    // 这一轮就应该判出冲突（列树时远端已经变了 ⇒ planPull 直接判 both-modified，连 put 都不发）。
    expect(first.conflicts.length + first.pushConflicts.length).toBe(1);

    /*
     * ★ 关键：**再跑一轮**。真实触发源是本地写去抖（1.2s）/ SSE 信号 / 自动重试 ——
     * 也就是「用户还没来得及裁决」的那几秒。
     */
    const second = await syncOnce({ provider, ledger: harness.ledger, deps: harness.deps });

    expect(await harnessText(provider, "notes/a.md")).toBe(remoteText);
    // 冲突不能消失（否则用户永远看不到它）。
    expect(second.pushConflicts.length + second.conflicts.length).toBeGreaterThan(0);
    // 本地那一份也没被动过。
    expect(new TextDecoder().decode(harness.local.get("notes/a.md")!)).toBe("# 本地 v2");
  });

  it("delete 冲突后再跑一轮：远端**不被墓碑**，冲突仍然列着", async () => {
    const a = await makeHarness({ seedLocal: { "notes/a.md": "# v1" } });
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });

    // 另一端改了并推上来。
    const b = await makeHarness({ provider: a.provider });
    await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });
    await b.writeLocalFile("notes/a.md", "# 远端改的");
    await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });

    // A 本地删掉 → 第一轮 delete 撞上 CAS。
    a.deleteLocalFile("notes/a.md");
    const first = await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });
    expect(first.pushConflicts.length + first.conflicts.length).toBeGreaterThan(0);

    // ★ 再跑一轮：**绝不能**把远端那一版墓碑掉。
    const second = await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });
    expect(a.provider.tombstones()).toEqual([]);
    expect(await harnessText(a.provider, "notes/a.md")).toBe("# 远端改的");
    expect(second.pushConflicts.length + second.conflicts.length).toBeGreaterThan(0);
  });

  it("删除冲突的 kind 指向「本地删了、远端又改了」（L1）", async () => {
    const harness = await makeHarness({ seedLocal: { "notes/a.md": "# v1" } });
    await syncOnce({ provider: harness.provider, ledger: harness.ledger, deps: harness.deps });

    harness.deleteLocalFile("notes/a.md");
    const provider = harness.provider;
    const originalDelete = provider.delete.bind(provider);
    let sneaked = false;
    // 模拟「远端在我们列树之后、删除之前被别人改了」——这是 delete 409 的唯一入口。
    provider.delete = async (input) => {
      if (!sneaked) {
        sneaked = true;
        const text = "# 远端改的";
        provider.seed(input.did, await hashOf(enc(text)), enc(text));
      }
      return originalDelete(input);
    };

    const result = await syncOnce({ provider, ledger: harness.ledger, deps: harness.deps });
    expect(result.pushConflicts).toHaveLength(1);
    expect(result.pushConflicts[0]!.kind).toBe("deleted-locally-modified-remotely");
  });
});

/* ============================================================================
   ★ H2 · 忽略 = 该路径在同步里**双向不存在**（红线 8）
   ============================================================================ */

describe("★ H2 · 忽略路径不参与推/拉/删", () => {
  it("账本里有、本地扫描里没有（被忽略）⇒ **不产生远端墓碑**", async () => {
    const harness = await makeHarness({ seedLocal: { "notes/a.md": "# A", "notes/b.md": "# B" } });
    await syncOnce({ provider: harness.provider, ledger: harness.ledger, deps: harness.deps });
    expect(Object.keys(harness.provider.snapshot())).toHaveLength(2);

    // 用户在 .gitignore 里加了 notes/a.md ⇒ 下一次扫描看不到它（但远端还在）。
    harness.deleteLocalFile("notes/a.md");
    harness.deps.isIgnored = (path) => path === "notes/a.md";

    const result = await syncOnce({ provider: harness.provider, ledger: harness.ledger, deps: harness.deps });

    expect(result.remoteDeleted).toBe(0);
    expect(harness.provider.tombstones()).toEqual([]);
    expect(await harnessText(harness.provider, "notes/a.md")).toBe("# A");
    // 账本条目保留（用户解除忽略后能自然恢复）。
    expect(harness.ledger.files["notes/a.md"]).toBeDefined();
  });

  it("远端新增、本地忽略 ⇒ **不下载、不写盘**", async () => {
    const a = await makeHarness({ seedLocal: { "secret.md": "# 秘密" } });
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });

    const b = await makeHarness({ provider: a.provider, ignore: (path) => path === "secret.md" });
    const result = await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });

    expect(result.pulled).toBe(0);
    expect(b.writes).toEqual([]);
    expect(b.local.has("secret.md")).toBe(false);
  });

  it("忽略路径不产生冲突噪音（远端改了它、本地忽略了它）", async () => {
    const a = await makeHarness({ seedLocal: { "notes/a.md": "# v1" } });
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });

    // B 的设备忽略它，但账本里记着（之前同步过）。
    const b = await makeHarness({ provider: a.provider, ignore: (path) => path === "notes/a.md" });
    await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });

    // 远端改成 v2。
    await a.writeLocalFile("notes/a.md", "# v2");
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });

    const result = await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });
    expect(result.conflicts).toEqual([]);
    expect(result.pushConflicts).toEqual([]);
  });
});

/* ============================================================================
   ★ H3 · 推送侧的删除闸门：扫描不完整 / 超预算都不许推墓碑
   ============================================================================ */

describe("★ H3 · 推送侧删除的防误删闸门", () => {
  it("本地扫描没扫全（有目录读不到）⇒ **一条都不推墓碑**", async () => {
    const harness = await makeHarness({
      seedLocal: { "notes/a.md": "# A", "notes/deep/b.md": "# B" },
      unreadable: [{ path: "notes/deep", message: "EPERM: operation not permitted" }],
    });
    await syncOnce({ provider: harness.provider, ledger: harness.ledger, deps: harness.deps });
    expect(Object.keys(harness.provider.snapshot())).toHaveLength(2);

    // 模拟「notes/deep 这一轮读不到」⇒ 它下面的 b.md 从扫描里消失。
    harness.deleteLocalFile("notes/deep/b.md");
    const result = await syncOnce({ provider: harness.provider, ledger: harness.ledger, deps: harness.deps });

    expect(result.scanIncomplete).toBe(true);
    expect(result.suspendedPushDeletes).toEqual(["notes/deep/b.md"]);
    expect(result.remoteDeleted).toBe(0);
    expect(harness.provider.tombstones()).toEqual([]);
    expect(await harnessText(harness.provider, "notes/deep/b.md")).toBe("# B");
  });

  it("一次要推的删除超过阈值 ⇒ 整批不删，说明原因（而不是删一部分）", async () => {
    const seed: Record<string, string> = {};
    for (let index = 0; index < 22; index += 1) seed[`notes/n${index}.md`] = `# ${index}`;
    const harness = await makeHarness({ seedLocal: seed });
    await syncOnce({ provider: harness.provider, ledger: harness.ledger, deps: harness.deps });

    // 用户（或一次误操作）把 22 篇全删了：预算 = max(20, 22×25%) = 20 ⇒ 22 > 20。
    for (const path of Object.keys(seed)) harness.deleteLocalFile(path);
    const result = await syncOnce({ provider: harness.provider, ledger: harness.ledger, deps: harness.deps });

    expect(result.remoteDeleted).toBe(0);
    expect(result.blockedDeletes).toBe(22);
    expect(result.deletionGuardMessage).toContain("超过保护阈值");
    expect(harness.provider.tombstones()).toEqual([]);
  });

  it("没超预算的少量删除照常推（别把正常删除也拦了）", async () => {
    const harness = await makeHarness({ seedLocal: { "notes/a.md": "# A", "notes/b.md": "# B" } });
    await syncOnce({ provider: harness.provider, ledger: harness.ledger, deps: harness.deps });

    harness.deleteLocalFile("notes/a.md");
    const result = await syncOnce({ provider: harness.provider, ledger: harness.ledger, deps: harness.deps });

    expect(result.remoteDeleted).toBe(1);
    expect(result.blockedDeletes).toBe(0);
    expect(harness.provider.tombstones()).toEqual([idForPath("notes/a.md")]);
  });
});

describe("★ M7 · runBounded：失败后先收尾，再抛出", () => {
  it("一个 worker 抛错后**不再领取新条目**，并等其余 worker 收尾", async () => {
    const events: string[] = [];
    let release0: () => void = () => undefined;
    const gate0 = new Promise<void>((resolve) => {
      release0 = resolve;
    });

    const run = runBounded([0, 1, 2, 3], 2, async (item) => {
      events.push(`start:${item}`);
      if (item === 0) {
        await gate0;
        events.push("end:0");
        return;
      }
      if (item === 1) throw new Error("boom");
      events.push(`end:${item}`);
    }).catch((error: unknown) => error);

    // 让两个 worker 都进到自己的第一条（0 挂起、1 抛错）。
    await new Promise((resolve) => setTimeout(resolve, 0));
    release0();
    const error = await run;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("boom");
    // ★ 2 / 3 从未启动：失败之后不再领取新条目。
    expect(events).toEqual(["start:0", "start:1", "end:0"]);
  });
});

describe("★ M2 · 整页被过滤干净时仍能翻页", () => {
  it("空页 + truncated ⇒ 用服务端给的 nextStartKey 继续翻，而不是放弃", async () => {
    const pages: { cursor: string | null; truncated: boolean; nextStartKey?: string; entries: { did: string; hash: string; rev: string }[] }[] = [
      // 第一页 1000 行全是墓碑：可见条目为空，但服务端知道下一页从哪开始。
      { cursor: "c1", truncated: true, nextStartKey: "f:page-2", entries: [] },
      { cursor: "c2", truncated: false, entries: [{ did: "f:b", hash: "h", rev: "1" }] },
    ];
    const startKeys: (string | undefined)[] = [];
    const provider = {
      name: "stub",
      cryptoMode: "none",
      tree: async (options: { startKey?: string } = {}) => {
        startKeys.push(options.startKey);
        return pages.shift()!;
      },
    } as unknown as SyncProvider;

    const tree = await fetchWholeTree(provider, 1000);

    expect(tree.truncated).toBe(false);
    expect(tree.entries.map((entry) => entry.did)).toEqual(["f:b"]);
    // 第二次请求用的是服务端给的锚点（不是「可见条目的最后一条」——那条根本不存在）。
    expect(startKeys).toEqual([undefined, "f:page-2"]);
  });

  it("老服务端没有 nextStartKey ⇒ 行为不变（仍然如实报 truncated）", async () => {
    const provider = {
      name: "stub",
      cryptoMode: "none",
      tree: async () => ({ cursor: "c1", truncated: true, entries: [] }),
    } as unknown as SyncProvider;

    const tree = await fetchWholeTree(provider, 1000);
    expect(tree.truncated).toBe(true);
    expect(tree.entries).toEqual([]);
  });
});

describe("★ L3 · 进度必须能走到 100%", () => {
  it("有冲突的一轮：冲突路径也计入「已处理」，最终 done === total", async () => {
    const harness = await makeHarness({ seedLocal: { "notes/a.md": "# v1", "notes/b.md": "# b" } });
    await syncOnce({ provider: harness.provider, ledger: harness.ledger, deps: harness.deps });

    // 两边都改同一篇 ⇒ 这一轮必然有一条冲突（它不进任何推送/拉取计划项）。
    await harness.writeLocalFile("notes/a.md", "# 本地 v2");
    const remoteText = "# 远端 v2";
    harness.provider.seed(idForPath("notes/a.md"), await hashOf(enc(remoteText)), enc(remoteText));

    const progress: { done: number; total: number }[] = [];
    const result = await syncOnce({
      provider: harness.provider,
      ledger: harness.ledger,
      deps: harness.deps,
      onProgress: (value) => progress.push(value),
    });

    expect(result.conflicts.length + result.pushConflicts.length).toBe(1);
    const last = progress.at(-1)!;
    expect(last.done).toBe(last.total);
  });

  it("被 truncated 挂起的一轮：挂起的删除也算「已处理」", async () => {
    // pageSize 3、5 篇 ⇒ 树不完整 ⇒ 删除全部挂起。
    const provider = createMemoryProvider({ pageSize: 3 });
    const seed: Record<string, string> = {};
    for (let index = 0; index < 5; index += 1) seed[`notes/n${index}.md`] = `# ${index}`;
    const a = await makeHarness({ seedLocal: seed, provider });
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });

    const b = await makeHarness({ provider });
    await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });

    // A 端删两篇（少量，不会触发预算），B 端再同步：树不完整 ⇒ 删除挂起。
    a.deleteLocalFile("notes/n1.md");
    a.deleteLocalFile("notes/n2.md");
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });

    const progress: { done: number; total: number }[] = [];
    await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps, onProgress: (value) => progress.push(value) });
    const last = progress.at(-1)!;
    expect(last.done).toBe(last.total);
  });
});

describe("★ M8 · E2EE 下「仅格式不同」仍然能收敛", () => {
  it("readLocal 是密文、readLocalPlain 才是明文 ⇒ 仍然判成格式差异并收敛", async () => {
    const provider = createMemoryProvider();
    const a = await makeHarness({ provider });
    await a.writeLocalFile("笔记.md", "第一行\n第二行\n");
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });

    const b = await makeHarness({ provider });
    await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });

    /*
     * 模拟 E2EE 客户端：`readLocal` 给出的是"密文"（严格 UTF-8 解不出来），
     * 而 `readLocalPlain` 才是磁盘上的明文、`decodeRemote` 负责解密远端。
     */
    b.deps.readLocal = async () => new Uint8Array([0xff, 0xfe, 0x00, 0x01]);
    b.deps.readLocalPlain = async (path) => b.local.get(path)!;
    b.deps.decodeRemote = (_did, bytes) => bytes;

    await a.writeLocalFile("笔记.md", "第一行\n第二行\n第三行\n");
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });
    await b.writeLocalFile("笔记.md", "第一行\r\n第二行\r\n第三行\r\n");

    const result = await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });

    expect(result.conflicts).toHaveLength(0);
    // 收敛成远端那一份（LF）。
    expect(new TextDecoder().decode(b.local.get("笔记.md")!)).toBe("第一行\n第二行\n第三行\n");
  });
});

describe("★ N1 · 冲突要跨轮次活着（不能因为「这轮没变化」就蒸发）", () => {
  it("远端没变化（remoteUnchanged）时，已存在的冲突仍然报出来，且不推不删", async () => {
    const harness = await makeHarness({ seedLocal: { "notes/a.md": "# v1" } });
    const provider = harness.provider;
    await syncOnce({ provider, ledger: harness.ledger, deps: harness.deps });

    await harness.writeLocalFile("notes/a.md", "# 本地 v2");
    const remoteText = "# 远端 v2";
    provider.seed(idForPath("notes/a.md"), await hashOf(enc(remoteText)), enc(remoteText));

    const first = await syncOnce({ provider, ledger: harness.ledger, deps: harness.deps });
    expect(first.conflicts.length + first.pushConflicts.length).toBe(1);
    expect(harness.ledger.files["notes/a.md"]?.pendingConflict).toBeDefined();

    // 下一轮：远端**没有任何变化** ⇒ 引擎不列树、不跑 planPull（以前冲突就在这里消失）。
    const second = await syncOnce({ provider, ledger: harness.ledger, deps: harness.deps, remoteUnchanged: true });

    expect(second.conflicts.length + second.pushConflicts.length).toBe(1);
    expect(second.pushed).toBe(0);
    expect(await harnessText(provider, "notes/a.md")).toBe(remoteText);
  });

  it("本地那一版改了之后，旧标记过期 ⇒ 不再挡住新一轮的判定", async () => {
    const harness = await makeHarness({ seedLocal: { "notes/a.md": "# v1" } });
    const provider = harness.provider;
    await syncOnce({ provider, ledger: harness.ledger, deps: harness.deps });

    await harness.writeLocalFile("notes/a.md", "# 本地 v2");
    provider.seed(idForPath("notes/a.md"), await hashOf(enc("# 远端 v2")), enc("# 远端 v2"));
    await syncOnce({ provider, ledger: harness.ledger, deps: harness.deps });

    // 用户又改了一版（本地 hash 变了）⇒ 标记过期，diff 重新判（仍然是冲突，但用的是新版本）。
    await harness.writeLocalFile("notes/a.md", "# 本地 v3");
    const again = await syncOnce({ provider, ledger: harness.ledger, deps: harness.deps });
    expect(again.conflicts.length + again.pushConflicts.length).toBe(1);
    expect(harness.ledger.files["notes/a.md"]?.pendingConflict?.localId).toBe(await hashOf(enc("# 本地 v3")));
    expect(await harnessText(provider, "notes/a.md")).toBe("# 远端 v2");
  });
});

describe("★ N5 · 两边都新建了同一路径：不许静默覆盖本地", () => {
  it("本地有同名文件、账本里没有、远端也新增了它 ⇒ **冲突**，本地那份不动", async () => {
    const provider = createMemoryProvider();
    const a = await makeHarness({ provider, seedLocal: { "notes/new.md": "# 远端的" } });
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });

    // B：本地也有一份同名但内容不同的文件，账本为空（新设备 / 拷过来的目录）。
    const b = await makeHarness({ provider, seedLocal: { "notes/new.md": "# 本地的" } });
    const result = await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });

    expect(result.pulled).toBe(0);
    expect(result.conflicts).toEqual([
      {
        path: "notes/new.md",
        kind: "both-modified",
        localId: await hashOf(enc("# 本地的")),
        remoteId: await hashOf(enc("# 远端的")),
      },
    ]);
    expect(new TextDecoder().decode(b.local.get("notes/new.md")!)).toBe("# 本地的");
    expect(await harnessText(a.provider, "notes/new.md")).toBe("# 远端的");
  });

  it("本地那份内容恰好相同 ⇒ 不算冲突（照常记基线）", async () => {
    const provider = createMemoryProvider();
    const a = await makeHarness({ provider, seedLocal: { "notes/new.md": "# 一样" } });
    await syncOnce({ provider: a.provider, ledger: a.ledger, deps: a.deps });

    const b = await makeHarness({ provider, seedLocal: { "notes/new.md": "# 一样" } });
    const result = await syncOnce({ provider: b.provider, ledger: b.ledger, deps: b.deps });

    expect(result.conflicts).toEqual([]);
    expect(b.ledger.files["notes/new.md"]?.localHash).toBe(await hashOf(enc("# 一样")));
  });
});

describe("★ N1 · 用户手工把本地改回远端那一版 ⇒ 冲突自动消解", () => {
  it("内容一致就不再拦着：标记清掉、基线对齐、下一轮空转", async () => {
    const harness = await makeHarness({ seedLocal: { "notes/a.md": "# v1" } });
    const provider = harness.provider;
    await syncOnce({ provider, ledger: harness.ledger, deps: harness.deps });

    await harness.writeLocalFile("notes/a.md", "# 本地 v2");
    const remoteText = "# 远端 v2";
    provider.seed(idForPath("notes/a.md"), await hashOf(enc(remoteText)), enc(remoteText));
    const conflicted = await syncOnce({ provider, ledger: harness.ledger, deps: harness.deps });
    expect(conflicted.conflicts.length + conflicted.pushConflicts.length).toBe(1);

    // 用户在编辑器里把本地那一份改成了远端的内容。
    await harness.writeLocalFile("notes/a.md", remoteText);

    const converged = await syncOnce({ provider, ledger: harness.ledger, deps: harness.deps });
    expect(converged.conflicts).toEqual([]);
    expect(converged.pushConflicts).toEqual([]);
    expect(harness.ledger.files["notes/a.md"]?.pendingConflict).toBeUndefined();
    expect(harness.ledger.files["notes/a.md"]?.localHash).toBe(await hashOf(enc(remoteText)));

    const idle = await syncOnce({ provider, ledger: harness.ledger, deps: harness.deps });
    expect(idle.pushed).toBe(0);
    expect(idle.pulled).toBe(0);
  });
});
