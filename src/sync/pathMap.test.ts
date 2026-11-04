/**
 * 加密笔记本的文件名对照表（`m:pathmap`）：会话层的行为。
 *
 * 引擎、加密、provider 都用真的（内存 provider），只有磁盘是内存里的。
 */

import { describe, expect, it } from "vitest";
import { PATH_MAP_DID } from "../../shared/contract";
import { deriveNotebookKey } from "./accountKey";
import { decodePathMap, derivePathMapKey, didForPath, encodePathMap, notebookKeysFrom, pathMapContentId } from "./crypto";
import { createMemoryCursorStore } from "./cursor";
import { createPathMapSync } from "./pathMap";
import { createMemoryProvider } from "./providers/memory";
import { createSyncSession } from "./session";
import { createSyncLedger } from "./state";
import type { LocalEntry, SyncFileBackend } from "./workspaceFiles";

const NOTEBOOK = "11111111-2222-4333-8444-555555555555";
const ENC_ROOT = Uint8Array.from({ length: 32 }, (_, index) => index);
const NOTEBOOK_KEY = deriveNotebookKey(ENC_ROOT, NOTEBOOK);
const PATH_MAP_KEY = derivePathMapKey(ENC_ROOT);
const didOf = (path: string) => didForPath(notebookKeysFrom(NOTEBOOK_KEY), path);

function memoryBackend(files: Record<string, string> = {}): SyncFileBackend & { snapshot(): Record<string, string> } {
  const store = new Map(Object.entries(files));
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
      return new TextEncoder().encode(value);
    },
    async write(path, bytes) {
      store.set(path, new TextDecoder().decode(bytes));
    },
    async remove(path) {
      store.delete(path);
    },
  };
}

type Provider = ReturnType<typeof createMemoryProvider>;

/** 一台设备：自己的磁盘、账本、游标（游标让增量同步真的生效）。 */
function device(provider: Provider, files: Record<string, string> = {}, options: { pathMapKey?: Uint8Array | null } = {}) {
  const backend = memoryBackend(files);
  const session = createSyncSession({
    config: { enabled: true, baseUrl: "memory://", notebookId: NOTEBOOK, cryptoMode: "user-key", accountRef: "a" },
    ledger: createSyncLedger({ baseUrl: "memory://", notebookId: NOTEBOOK, cryptoMode: "user-key", protocolVersion: 1 }),
    provider,
    backend,
    notebookId: NOTEBOOK,
    notebookKey: NOTEBOOK_KEY,
    cursorStore: createMemoryCursorStore(),
    ...(options.pathMapKey === null ? {} : { pathMapKey: options.pathMapKey ?? PATH_MAP_KEY }),
  });
  return { backend, session };
}

async function remoteMap(provider: Provider): Promise<string[]> {
  const record = await provider.read(PATH_MAP_DID);
  if (record === null) return [];
  return decodePathMap(PATH_MAP_KEY, NOTEBOOK, record.bytes).map((entry) => entry.path).sort();
}

describe("文件名对照表随同步走", () => {
  it("第一台设备推完就写好表；全新设备靠它把文件拉下来", async () => {
    const provider = createMemoryProvider();
    await device(provider, { "a.md": "A", "目录/b.md": "B" }).session.syncNow();
    expect(await remoteMap(provider)).toEqual(["a.md", "目录/b.md"]);

    const fresh = device(provider);
    const result = await fresh.session.syncNow();
    expect(result!.unknownDids).toEqual([]);
    expect(result!.pulled).toBe(2);
    expect(fresh.backend.snapshot()).toEqual({ "a.md": "A", "目录/b.md": "B" });
  });

  it("表里不带明文：远端那条记录里搜不到文件名", async () => {
    const provider = createMemoryProvider();
    await device(provider, { "客户名单.md": "x" }).session.syncNow();
    const record = await provider.read(PATH_MAP_DID);
    expect(record).not.toBeNull();
    expect(new TextDecoder().decode(record!.bytes)).not.toContain("客户名单");
  });

  it("对照表这条记录本身不算「认不出来的 did」，也不会被拉成文件", async () => {
    const provider = createMemoryProvider();
    const a = device(provider, { "a.md": "A" });
    await a.session.syncNow();
    const again = await a.session.syncNow();
    expect(again!.unknownDids).toEqual([]);
    expect(Object.keys(a.backend.snapshot())).toEqual(["a.md"]);
  });

  it("表来晚了（建文件的设备当时还是旧版）⇒ 先报认不出，表到了之后下一轮补拉", async () => {
    const provider = createMemoryProvider();
    // 旧版：推了文件，但不写表。
    const old = device(provider, { "旧.md": "old" }, { pathMapKey: null });
    await old.session.syncNow();

    const b = device(provider);
    const first = await b.session.syncNow();
    expect(first!.unknownDids).toHaveLength(1);
    expect(b.backend.snapshot()).toEqual({});

    // 那台设备升级后同步一次：把自己账本里的路径写进表。
    const upgraded = device(provider, { "旧.md": "old" });
    await upgraded.session.syncNow();
    expect(await remoteMap(provider)).toEqual(["旧.md"]);

    // B 的游标早已越过那条文件；只靠增量是永远见不到它的 —— 必须重读表、走一次全树。
    const second = await b.session.syncNow();
    expect(second!.unknownDids).toEqual([]);
    expect(second!.pulled).toBe(1);
    expect(b.backend.snapshot()).toEqual({ "旧.md": "old" });
  });

  it("同一轮里刚认不出、表恰好已经更新 ⇒ 立刻补一次全树，计数合在一起", async () => {
    const provider = createMemoryProvider();
    const a = device(provider, { "a.md": "A" });
    const b = device(provider);
    await b.session.syncNow(); // B 先读过一次（那时表还是空的）

    await a.session.syncNow(); // A 推文件、写表
    const result = await b.session.syncNow();
    expect(result!.pulled).toBe(1);
    expect(result!.unknownDids).toEqual([]);
    expect(b.backend.snapshot()).toEqual({ "a.md": "A" });
  });

  it("删除与改名：表跟着去掉旧路径；另一台设备照样收得到新名字", async () => {
    const provider = createMemoryProvider();
    const a = device(provider, { "a.md": "A", "b.md": "B" });
    await a.session.syncNow();
    const b = device(provider);
    await b.session.syncNow();

    await a.backend.remove("a.md");
    await a.backend.remove("b.md");
    await a.backend.write("b2.md", new TextEncoder().encode("B"));
    await a.session.syncNow();
    expect(await remoteMap(provider)).toEqual(["b2.md"]);

    await b.session.syncNow();
    expect(b.backend.snapshot()).toEqual({ "b2.md": "B" });
  });

  it("两台设备同时改表（CAS 撞车）⇒ 重读后合并，谁的路径都不丢", async () => {
    const provider = createMemoryProvider();
    const one = createPathMapSync({ provider, pathMapKey: PATH_MAP_KEY, notebookId: NOTEBOOK, didOf });
    const two = createPathMapSync({ provider, pathMapKey: PATH_MAP_KEY, notebookId: NOTEBOOK, didOf });
    await one.refresh();
    await two.refresh();
    await one.publish(["一.md"], []);
    await two.publish(["二.md"], []); // two 的 baseHash 已过期 ⇒ 撞车 ⇒ 重读合并
    expect(await remoteMap(provider)).toEqual(["一.md", "二.md"]);
  });

  it("没变化就不写（不为每一轮同步多发一次 PUT）", async () => {
    const provider = createMemoryProvider();
    const map = createPathMapSync({ provider, pathMapKey: PATH_MAP_KEY, notebookId: NOTEBOOK, didOf });
    await map.publish(["a.md"], []);
    const before = (await provider.read(PATH_MAP_DID))!.rev;
    await map.publish(["a.md"], []);
    expect((await provider.read(PATH_MAP_DID))!.rev).toBe(before);
  });

  it("表解不开（别的钥匙写的）⇒ 当空表用，而且绝不覆盖它", async () => {
    const provider = createMemoryProvider();
    const foreign = encodePathMap(derivePathMapKey(new Uint8Array(32).fill(9)), NOTEBOOK, [{ did: didOf("x.md"), path: "x.md" }]);
    await provider.put({ did: PATH_MAP_DID, bytes: foreign, hash: pathMapContentId(foreign), baseHash: null });
    const before = (await provider.read(PATH_MAP_DID))!.hash;

    const logs: string[] = [];
    const map = createPathMapSync({ provider, pathMapKey: PATH_MAP_KEY, notebookId: NOTEBOOK, didOf, log: (line) => logs.push(line) });
    await map.refresh();
    expect(map.paths()).toEqual([]);
    await map.publish(["a.md"], []);
    expect((await provider.read(PATH_MAP_DID))!.hash).toBe(before);
    expect(logs.join("\n")).toContain("解不开");
  });

  it("表里的坏条目（越界路径 / did 对不上）被丢掉，不会写到库外", async () => {
    const provider = createMemoryProvider();
    const bytes = encodePathMap(PATH_MAP_KEY, NOTEBOOK, [
      { did: didOf("ok.md"), path: "ok.md" },
      { did: didOf("../逃出去.md"), path: "../逃出去.md" },
      { did: didOf("别的.md"), path: "对不上.md" },
    ]);
    await provider.put({ did: PATH_MAP_DID, bytes, hash: pathMapContentId(bytes), baseHash: null });
    const map = createPathMapSync({ provider, pathMapKey: PATH_MAP_KEY, notebookId: NOTEBOOK, didOf });
    await map.refresh();
    expect(map.paths()).toEqual(["ok.md"]);
  });

  it("明文笔记本不碰对照表", async () => {
    const provider = createMemoryProvider();
    const backend = memoryBackend({ "a.md": "A" });
    await createSyncSession({
      config: { enabled: true, baseUrl: "memory://", notebookId: NOTEBOOK, cryptoMode: "none", accountRef: "a" },
      ledger: createSyncLedger({ baseUrl: "memory://", notebookId: NOTEBOOK, cryptoMode: "none", protocolVersion: 1 }),
      provider,
      backend,
      notebookId: NOTEBOOK,
      pathMapKey: PATH_MAP_KEY,
    }).syncNow();
    expect(await provider.read(PATH_MAP_DID)).toBeNull();
  });
});
