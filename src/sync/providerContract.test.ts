/**
 * `SyncProvider` 契约测试（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §10.1 A 的 C1–C14）。
 *
 * ## 这套用例的意义
 *
 * §10.1 A 要求「同一套 provider 契约测试对两个实现各跑一次」：`memory`（纯内存 fake，CI 必跑）
 * 与**真实 compose 栈**（慢测试）。所以这个文件里的每一条都是**契约**，
 * 而不是「memory 实现的行为描述」—— 换成 `opennote` provider 时它们必须照样绿。
 *
 * ## 有三条**无法**在内存 fake 上成立，已如实标注
 *
 * - **C3「两个 leaf 都在」**：那要靠 CouchDB 的 revision tree，内存 fake 的 `_rev` 是计数器，
 *   并发写只会 CAS 失败，不会留下两个 leaf。真实栈上再测（P2）。
 * - **C8「心跳」**：内存 fake 没有 SSE 通道。P3 在真实入口上测（U6）。
 * - **C7 的「不含内容」**：内存 fake 的订阅信号**本来**就不带内容（形状上更严格），
 *   这条在 fake 上是恒真，所以只能作为「形状断言」而不是「行为证明」。
 */
import { describe, expect, it } from "vitest";
import { SyncProviderError } from "./provider-types";
import { createMemoryProvider } from "./providers/memory";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** 造一个内容标识（内存 fake 只比相等，不校验哈希算法）。 */
function id(seed: string): string {
  return seed.padEnd(64, "0").slice(0, 64);
}

describe("C1/C14 · put 新建 → read 回读，字节完全相同", () => {
  it("写进去的字节与读出来的逐字节一致", async () => {
    const provider = createMemoryProvider();
    const bytes = enc("# 你好，笔记 📓\r\n第二行");
    const result = await provider.put({ did: "f:abc", bytes, hash: id("h1"), baseHash: null });
    expect("conflict" in result).toBe(false);

    const read = await provider.read("f:abc");
    expect(read).not.toBeNull();
    expect([...read!.bytes]).toEqual([...bytes]);
    expect(dec(read!.bytes)).toBe("# 你好，笔记 📓\r\n第二行");
    expect(read!.hash).toBe(id("h1"));
  });

  it("读一条不存在的返回 null（**不抛** —— 「不存在」是正常结果）", async () => {
    const provider = createMemoryProvider();
    expect(await provider.read("f:nope")).toBeNull();
  });
});

describe("C2 · put 带过期标识（CAS 对不上）→ conflict，且**返回当前值**", () => {
  it("对不上时返回当前 hash/rev，而不是只说一句「失败」", async () => {
    const provider = createMemoryProvider();
    await provider.put({ did: "f:a", bytes: enc("v1"), hash: id("v1"), baseHash: null });
    const result = await provider.put({ did: "f:a", bytes: enc("v2"), hash: id("v2"), baseHash: id("stale") });
    expect("conflict" in result).toBe(true);
    if (!("conflict" in result)) throw new Error("unreachable");
    expect(result.conflict.did).toBe("f:a");
    // 关键：当前值必须带回来，调用方要靠它做三方 diff。
    expect(result.conflict.current?.hash).toBe(id("v1"));
    expect(result.conflict.current?.rev).toBeTruthy();
  });

  it("`baseHash: null` 表示允许新建；远端已有内容时同样冲突", async () => {
    const provider = createMemoryProvider();
    await provider.put({ did: "f:a", bytes: enc("v1"), hash: id("v1"), baseHash: null });
    const result = await provider.put({ did: "f:a", bytes: enc("v2"), hash: id("v2"), baseHash: null });
    expect("conflict" in result).toBe(true);
  });

  it("cas 对得上时写入成功并换新 rev", async () => {
    const provider = createMemoryProvider();
    const first = await provider.put({ did: "f:a", bytes: enc("v1"), hash: id("v1"), baseHash: null });
    const second = await provider.put({ did: "f:a", bytes: enc("v2"), hash: id("v2"), baseHash: id("v1") });
    if (!("rev" in first) || !("rev" in second)) throw new Error("unreachable");
    expect(second.rev).not.toBe(first.rev);
  });
});

describe("C4 · 逻辑删除 + 墓碑", () => {
  it("delete 之后 read 返回 null，但 changes 里仍然报一条 delete", async () => {
    const provider = createMemoryProvider();
    await provider.put({ did: "f:a", bytes: enc("v1"), hash: id("v1"), baseHash: null });
    const cursorBefore = (await provider.changes({ since: null })).cursor;
    await provider.delete({ did: "f:a", baseHash: id("v1") });

    expect(await provider.read("f:a")).toBeNull();
    const changes = await provider.changes({ since: cursorBefore });
    expect(changes.changes).toEqual([{ did: "f:a", op: "delete" }]);
  });

  it("墓碑**留着**（丢掉一个 delete 会让文件在另一端复活，§6.4 规则 3）", async () => {
    const provider = createMemoryProvider();
    await provider.put({ did: "f:a", bytes: enc("v1"), hash: id("v1"), baseHash: null });
    await provider.delete({ did: "f:a", baseHash: id("v1") });
    expect(provider.tombstones()).toEqual(["f:a"]);
    // 而且它**不在树上**（树只列活着的）。
    const tree = await provider.tree();
    expect(tree.entries.map((entry) => entry.did)).toEqual([]);
  });

  it("重复删除返回 gone（幂等，不是错误）", async () => {
    const provider = createMemoryProvider();
    await provider.put({ did: "f:a", bytes: enc("v1"), hash: id("v1"), baseHash: null });
    await provider.delete({ did: "f:a", baseHash: id("v1") });
    const again = await provider.delete({ did: "f:a", baseHash: id("v1") });
    expect(again).toEqual({ gone: true });
  });
});

describe("C5/C6 · changes 的 cursor 与幂等", () => {
  it("cursor 是**不透明字符串**，且第二次只返回变化项", async () => {
    const provider = createMemoryProvider();
    provider.seed("f:a", id("a1"), enc("a"));
    const first = await provider.changes({ since: null });
    expect(typeof first.cursor).toBe("string");
    expect(first.changes.map((item) => item.did)).toEqual(["f:a"]);

    provider.seed("f:b", id("b1"), enc("b"));
    const second = await provider.changes({ since: first.cursor });
    expect(second.changes.map((item) => item.did)).toEqual(["f:b"]);
    // 没有任何新变更时返回空。
    const third = await provider.changes({ since: second.cursor });
    expect(third.changes).toEqual([]);
  });

  it("C6 · 重复调用同一 cursor 结果**相同**（幂等）", async () => {
    const provider = createMemoryProvider();
    provider.seed("f:a", id("a1"), enc("a"));
    const cursor = (await provider.changes({ since: null })).cursor;
    provider.seed("f:b", id("b1"), enc("b"));
    const once = await provider.changes({ since: cursor });
    const twice = await provider.changes({ since: cursor });
    expect(twice.changes).toEqual(once.changes);
    expect(twice.cursor).toBe(once.cursor);
  });

  it("同一 did 在窗口内多次变化只报一条（信号是幂等 dirty 提示，不是事件流，§4.7 设计点 5）", async () => {
    const provider = createMemoryProvider();
    const start = (await provider.changes({ since: null })).cursor;
    provider.seed("f:a", id("a1"), enc("a"));
    provider.seed("f:a", id("a2"), enc("a2"));
    provider.seed("f:a", id("a3"), enc("a3"));
    const changes = await provider.changes({ since: start });
    expect(changes.changes).toHaveLength(1);
    expect(changes.changes[0]!.did).toBe("f:a");
  });

  it("§6.4 规则 2 · 游标过期 ⇒ `resync: true`，而不是假装「没有变更」", async () => {
    const provider = createMemoryProvider();
    provider.seed("f:a", id("a1"), enc("a"));
    const old = (await provider.changes({ since: null })).cursor;
    provider.seed("f:b", id("b1"), enc("b"));
    /*
     * compaction 把**客户端那个游标以内**的变更全部回收掉：所以「可回溯的下限」
     * 必须**严格大于**客户端手上的 cursor。差一个数就测不出东西来（第一版就踩了：
     * 下限取成 `old` 时 `since < floor` 为假，于是返回了正常结果而不是 resync）。
     */
    (provider as unknown as { purgeBefore(seq: number): void }).purgeBefore(Number(old) + 1);
    const changes = await provider.changes({ since: old });
    expect(changes.resync).toBe(true);
  });
});

describe("C7 · subscribe 只发信号，不含内容", () => {
  it("另一端写入后收到信号；载荷形状里**没有** bytes/content 字段", async () => {
    const provider = createMemoryProvider();
    const signals: { cursor: string | null; dids: string[] }[] = [];
    const subscription = provider.subscribe!((hint) => signals.push(hint));
    provider.seed("f:a", id("a1"), enc("秘密内容"));
    subscription.close();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.dids).toEqual(["f:a"]);
    // 「不含内容」是形状断言（fake 本来就只发信号，所以这条在 fake 上恒真，见文件头）。
    expect(JSON.stringify(signals[0])).not.toContain("秘密内容");
  });

  it("close() 之后不再收到信号", async () => {
    const provider = createMemoryProvider();
    const signals: unknown[] = [];
    const subscription = provider.subscribe!((hint) => signals.push(hint));
    subscription.close();
    provider.seed("f:a", id("a1"), enc("a"));
    expect(signals).toHaveLength(0);
  });
});

describe("C9/C11 · 形状与上限（provider 不重复实现路径规则）", () => {
  it("C9 · 非法路径的拒绝发生在**上层**（`shared/paths.ts`），provider 只搬 did", async () => {
    /*
     * 契约事实：provider 的入参是 `did`，**看不见明文路径**。所以「拒绝 ../x」这件事
     * 不可能在 provider 里做 —— 它是 `assertSafeRelative()` 的职责（§3.8 防线 1）。
     * 这条用例的存在是为了**钉住这个分工**：谁都不许把路径规则塞进 provider。
     */
    const provider = createMemoryProvider();
    const result = await provider.put({ did: "f:不是明文路径", bytes: enc("x"), hash: id("x"), baseHash: null });
    expect("conflict" in result).toBe(false);
    // 能读回来 —— 说明 provider 确实只把 did 当不透明字符串。
    expect(await provider.read("f:不是明文路径")).not.toBeNull();
  });

  it("C11 · 超过上限的拒绝发生在**上层**（`contract.ts` 的 MAX_FILE_BYTES / Node）", async () => {
    // 同上：provider 不做大小校验（那是契约层与 Node 的职责）。
    const provider = createMemoryProvider();
    const big = new Uint8Array(1024);
    const result = await provider.put({ did: "f:big", bytes: big, hash: id("big"), baseHash: null });
    expect("conflict" in result).toBe(false);
  });
});

describe("C12 · 分页取树只取到一页 ⇒ truncated 为真", () => {
  it("条目数超过 pageSize 时置 truncated（这是「禁止推断删除」的开关）", async () => {
    const provider = createMemoryProvider({ pageSize: 3 });
    for (let index = 0; index < 5; index += 1) provider.seed(`f:${index}`, id(`h${index}`), enc(`v${index}`));
    const tree = await provider.tree();
    expect(tree.entries).toHaveLength(3);
    expect(tree.truncated).toBe(true);
  });

  it("取得完时不置 truncated（别把正常情况也标成不完整）", async () => {
    const provider = createMemoryProvider({ pageSize: 10 });
    provider.seed("f:a", id("a"), enc("a"));
    const tree = await provider.tree();
    expect(tree.truncated).toBe(false);
  });

  it("startKey 分页：第二页接着第一页，且最后一页 truncated 为假", async () => {
    const provider = createMemoryProvider({ pageSize: 2 });
    for (const did of ["f:a", "f:b", "f:c"]) provider.seed(did, id(did), enc(did));
    const first = await provider.tree({ startKey: "f:a" });
    expect(first.entries.map((entry) => entry.did)).toEqual(["f:a", "f:b"]);
    expect(first.truncated).toBe(true);
    const second = await provider.tree({ startKey: "f:c" });
    expect(second.entries.map((entry) => entry.did)).toEqual(["f:c"]);
    expect(second.truncated).toBe(false);
  });
});

describe("离线 / 错误形状", () => {
  it("离线时抛 SyncProviderError('network')，**不**返回空结果假装成功", async () => {
    const provider = createMemoryProvider({ offline: true });
    await expect(provider.tree()).rejects.toBeInstanceOf(SyncProviderError);
    await expect(provider.read("f:a")).rejects.toThrow(/离线/);
  });

  it("恢复在线后照常工作（`setOffline` 只影响之后）", async () => {
    const provider = createMemoryProvider({ offline: true });
    provider.setOffline(false);
    await expect(provider.tree()).resolves.toBeTruthy();
  });
});

describe("checkpoint · 提交的是「我到哪了」，与账本职责不同", () => {
  it("checkpoint 收到的就是调用方给的 cursor（原样，不解析）", async () => {
    const provider = createMemoryProvider();
    await provider.checkpoint("7-g1AAAA");
    await provider.checkpoint(null);
    expect(provider.checkpoints()).toEqual(["7-g1AAAA", null]);
  });
});

describe("C3 等三条需要真实栈的用例（**故意留空并标注**）", () => {
  it.todo("C3 并发两次 put 同一 did：一个成功一个 409，**两个 leaf 都在**（要 CouchDB revision tree）");
  it.todo("C8 subscribe 空转 2× 心跳：至少收到 2 次 heartbeat（要真实 SSE 通道）");
  it.todo("C13 路径规则用例表双跑：Node TS 与 `_design` JS 判定一致（要 P2 的 _design）");
});
