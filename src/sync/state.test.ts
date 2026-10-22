/**
 * 同步账本（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §3.7、§5.4 第 4 条）。
 *
 * 账本里有三件**容易写错且后果很重**的事情：
 *   1. **凭据与本机专属字段绝不许落进 `.opennote/`** —— 一旦进去就会被导出、
 *      被 `.git` 带走、被同步到别的设备（红线 3）；
 *   2. **`bid` 在改名时必须保持不变** —— 否则「改名」在账本里表现成「删除 + 新增」，
 *      下一次同步会把它当成两条独立的事；
 *   3. **坏账本按「没有账本」处理** —— 带着可疑账本同步比重新开始危险得多。
 */
import { describe, expect, it, vi } from "vitest";
import type { EntryInfo, FileSystemBackend } from "../fs/types";
import { baseName, parentPath } from "../fs/paths";
import {
  SYNC_LEDGER_VERSION,
  SYNC_META_FILE,
  bidForPath,
  buildDidIndex,
  createSyncLedger,
  forgetPath,
  isSameRemote,
  readSyncLedger,
  renamePath,
  renamePrefix,
  stripBaseUrlSlashes,
  writeSyncLedger,
  type SyncLedger,
} from "./state";

/** 只够账本用的最小后端。 */
class MiniBackend implements FileSystemBackend {
  readonly kind = "node";
  readonly label = "模拟磁盘";
  readonly canWrite = true;
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>([""]);

  private mkdirParents(path: string): void {
    if (!path) return;
    this.dirs.add(path);
    this.mkdirParents(parentPath(path));
  }

  seed(path: string, text: string): void {
    this.mkdirParents(parentPath(path));
    this.files.set(path, text);
  }

  text(path: string): string | undefined {
    return this.files.get(path);
  }

  async mkdir(path: string): Promise<void> {
    this.mkdirParents(path);
  }

  async list(path: string): Promise<EntryInfo[]> {
    if (!this.dirs.has(path)) throw new Error(`ENOENT ${path}`);
    const dirs = [...this.dirs]
      .filter((candidate) => candidate && parentPath(candidate) === path)
      .map((candidate) => ({ name: baseName(candidate), kind: "directory" as const, size: 0, mtimeMs: 0 }));
    const files = [...this.files.keys()]
      .filter((candidate) => parentPath(candidate) === path)
      .map((candidate) => ({ name: baseName(candidate), kind: "file" as const, size: 0, mtimeMs: 0 }));
    return [...dirs, ...files];
  }

  async readText(path: string): Promise<string> {
    const text = this.files.get(path);
    if (text === undefined) throw new Error(`ENOENT ${path}`);
    return text;
  }

  async readBytes(path: string): Promise<Uint8Array> {
    return new TextEncoder().encode(await this.readText(path));
  }

  async writeText(path: string, text: string): Promise<void> {
    this.mkdirParents(parentPath(path));
    this.files.set(path, text);
  }

  async writeBytes(path: string, bytes: Uint8Array | Blob): Promise<void> {
    const data = bytes instanceof Blob ? new Uint8Array(await bytes.arrayBuffer()) : bytes;
    await this.writeText(path, new TextDecoder().decode(data));
  }

  async exists(path: string): Promise<boolean> {
    return this.dirs.has(path) || this.files.has(path);
  }

  async stat(path: string): Promise<{ size: number; mtimeMs: number } | null> {
    const text = this.files.get(path);
    return text === undefined ? null : { size: text.length, mtimeMs: 0 };
  }

  async move(from: string, to: string): Promise<void> {
    const text = this.files.get(from);
    if (text === undefined) throw new Error(`ENOENT ${from}`);
    this.files.delete(from);
    this.seed(to, text);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.dirs.delete(path);
  }
}

function newLedger(): SyncLedger {
  return createSyncLedger({
    baseUrl: "https://notes.example.com/",
    notebookId: "11111111-2222-4333-8444-555555555555",
    cryptoMode: "none",
    protocolVersion: 1,
  });
}

describe("往返与形状", () => {
  it("写下去再读回来是同一条账本（baseUrl 去掉尾部斜杠）", async () => {
    const backend = new MiniBackend();
    const ledger = newLedger();
    expect(ledger.remote.baseUrl).toBe("https://notes.example.com");
    bidForPath(ledger, "notes/a.md");
    ledger.files["notes/a.md"] = {
      bid: ledger.bids["notes/a.md"]!,
      localHash: "a".repeat(64),
      remoteHash: "b".repeat(64),
      rev: "3-abc",
      imported: true,
      syncedAt: 1,
    };
    await writeSyncLedger(backend, ledger);

    const read = await readSyncLedger(backend);
    expect(read).toEqual(ledger);
    expect(backend.text(SYNC_META_FILE)).toContain(`"version": ${SYNC_LEDGER_VERSION}`);
  });

  it("没有账本 → null（「还没开始同步」是正常状态，不是错误）", async () => {
    const backend = new MiniBackend();
    expect(await readSyncLedger(backend)).toBeNull();
  });

  it("坏 JSON / 版本不认识 / 结构不对 → 按「没有账本」处理，**不猜着修**", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const bad of [
      "{ 这不是 JSON",
      JSON.stringify({ version: 99, remote: {}, bids: {}, files: {} }),
      JSON.stringify({ version: 1, bids: {}, files: {} }),
      JSON.stringify({ version: 1, remote: { baseUrl: "x", notebookId: "y", cryptoMode: "??" }, bids: {}, files: {} }),
      JSON.stringify({ version: 1, remote: { baseUrl: "x", notebookId: "y", cryptoMode: "none" } }),
    ]) {
      const backend = new MiniBackend();
      backend.seed(SYNC_META_FILE, bad);
      expect(await readSyncLedger(backend)).toBeNull();
    }
  });
});

describe("落盘闸门（红线 3 + §5.4 第 4 条）", () => {
  it("凭据材料不许进账本 —— 抛，而不是写下去", async () => {
    const backend = new MiniBackend();
    const ledger = newLedger() as SyncLedger & { accountKey?: string };
    ledger.accountKey = "绝不该落盘";
    await expect(writeSyncLedger(backend, ledger)).rejects.toThrow(/不许落进笔记本目录/);
    // 一个字节都没写。
    expect(backend.text(SYNC_META_FILE)).toBeUndefined();
  });

  it("`deviceId` 与 did 映射也不许进账本（跨端会让两台设备共用一个检查点）", async () => {
    const backend = new MiniBackend();
    const withDevice = newLedger() as SyncLedger & { deviceId?: string };
    withDevice.deviceId = "a".repeat(32);
    await expect(writeSyncLedger(backend, withDevice)).rejects.toThrow(/本机专属/);

    const withMap = newLedger() as SyncLedger & { didMap?: Record<string, string> };
    withMap.didMap = { "f:abc": "notes/a.md" };
    await expect(writeSyncLedger(backend, withMap)).rejects.toThrow(/本机专属/);
  });

  it("账本里出现越界路径时也拒绝落盘（防手改出一个它下一次会替我们写盘的路径）", async () => {
    const backend = new MiniBackend();
    const ledger = newLedger();
    ledger.files["../../etc/passwd"] = { bid: 1, localHash: null, remoteHash: null, rev: null, imported: true, syncedAt: 0 };
    await expect(writeSyncLedger(backend, ledger)).rejects.toThrow(/越界/);
  });

  it("正常账本照常落盘（别把闸门做成什么都拦）", async () => {
    const backend = new MiniBackend();
    await expect(writeSyncLedger(backend, newLedger())).resolves.toBeUndefined();
    expect(backend.text(SYNC_META_FILE)).toBeTruthy();
  });
});

describe("bid：改名不换身份", () => {
  it("同一路径反复取 bid 拿到同一个值", () => {
    const ledger = newLedger();
    const first = bidForPath(ledger, "notes/a.md");
    expect(bidForPath(ledger, "notes/a.md")).toBe(first);
    expect(bidForPath(ledger, "notes/b.md")).not.toBe(first);
  });

  it("renamePath 让 bid **保持不变**（这正是 bid 存在的理由）", () => {
    const ledger = newLedger();
    const bid = bidForPath(ledger, "notes/old.md");
    ledger.files["notes/old.md"] = { bid, localHash: "l", remoteHash: "r", rev: "1-a", imported: true, syncedAt: 1 };

    renamePath(ledger, "notes/old.md", "notes/new.md");

    expect(ledger.bids["notes/old.md"]).toBeUndefined();
    expect(ledger.bids["notes/new.md"]).toBe(bid);
    expect(ledger.files["notes/new.md"]?.bid).toBe(bid);
    expect(ledger.files["notes/new.md"]?.rev).toBe("1-a");
    expect(ledger.files["notes/old.md"]).toBeUndefined();
  });

  it("renamePrefix 把整棵子树挪过去，各自的 bid 都保留", () => {
    const ledger = newLedger();
    const a = bidForPath(ledger, "old/a.md");
    const b = bidForPath(ledger, "old/sub/b.md");
    bidForPath(ledger, "other/c.md");

    renamePrefix(ledger, "old", "new");

    expect(ledger.bids["new/a.md"]).toBe(a);
    expect(ledger.bids["new/sub/b.md"]).toBe(b);
    expect(ledger.bids["other/c.md"]).toBeDefined();
    expect(ledger.bids["old/a.md"]).toBeUndefined();
  });

  it("forgetPath 把 bid 与事实一起清掉（真正删干净时用）", () => {
    const ledger = newLedger();
    bidForPath(ledger, "notes/a.md");
    ledger.files["notes/a.md"] = { bid: 1, localHash: null, remoteHash: null, rev: null, imported: true, syncedAt: 0 };
    forgetPath(ledger, "notes/a.md");
    expect(ledger.bids["notes/a.md"]).toBeUndefined();
    expect(ledger.files["notes/a.md"]).toBeUndefined();
  });

  it("nextBid 只增不减 —— 删掉再新建不会拿到同一个编号", () => {
    const ledger = newLedger();
    const first = bidForPath(ledger, "a.md");
    forgetPath(ledger, "a.md");
    const second = bidForPath(ledger, "a.md");
    expect(second).not.toBe(first);
    expect(second).toBeGreaterThan(first);
  });
});

describe("did ↔ path 反查（本机解密结果，不进持久化）", () => {
  it("按已知路径现算 did，并给出反查表", () => {
    const ledger = newLedger();
    bidForPath(ledger, "notes/a.md");
    bidForPath(ledger, "notes/b.md");
    const { byPath, byDid } = buildDidIndex(ledger, (path) => `f:${path}`);
    expect(byPath.get("notes/a.md")).toBe("f:notes/a.md");
    expect(byDid.get("f:notes/a.md")).toBe("notes/a.md");
  });

  it("did 碰撞时保留先来的并**告警**，不静默覆盖", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ledger = newLedger();
    bidForPath(ledger, "notes/a.md");
    bidForPath(ledger, "notes/b.md");
    // 故意让两个路径算出同一个 did（真实世界里只有 HMAC 撞了才会这样）。
    const { byDid } = buildDidIndex(ledger, () => "f:same");
    expect(byDid.size).toBe(1);
    expect(warn).toHaveBeenCalled();
  });
});
/* ============================================================================
   远端身份的判定（2026-10-22 的真机事故）
   ============================================================================ */

describe("★ 远端身份：尾部斜杠**不是**另一台服务器", () => {
  const remote = { baseUrl: "http://45.202.241.98:8787", notebookId: "nb-1", cryptoMode: "none" as const };

  it("带不带尾部斜杠/首尾空白 ⇒ 同一个（否则每次打开应用都会全量重推）", () => {
    /*
     * 事故现场：存储里是 `http://host:8787/`，账本里是 `http://host:8787`（createSyncLedger
     * 会剥斜杠）。逐字比较 ⇒ 判成「换了服务器」⇒ 丢账本 ⇒ 880 篇全推一遍，
     * 每次打开应用 2~3 分钟。
     */
    for (const baseUrl of ["http://45.202.241.98:8787", "http://45.202.241.98:8787/", "  http://45.202.241.98:8787//  "]) {
      expect(isSameRemote(remote, { ...remote, baseUrl }), baseUrl).toBe(true);
    }
  });

  it("换了笔记本 / 换了加密模式 ⇒ 确实不是同一个（该重建账本）", () => {
    expect(isSameRemote(remote, { ...remote, notebookId: "nb-2" })).toBe(false);
    expect(isSameRemote(remote, { ...remote, cryptoMode: "user-key" })).toBe(false);
    expect(isSameRemote(remote, { ...remote, baseUrl: "http://other.example.com:8787" })).toBe(false);
  });

  it("路径要保留（子路径部署不能被「去斜杠」抹掉）", () => {
    expect(stripBaseUrlSlashes("https://a.com/opennote/")).toBe("https://a.com/opennote");
    expect(isSameRemote({ ...remote, baseUrl: "https://a.com/opennote/" }, { ...remote, baseUrl: "https://a.com/opennote" })).toBe(true);
    expect(isSameRemote({ ...remote, baseUrl: "https://a.com/opennote" }, { ...remote, baseUrl: "https://a.com/other" })).toBe(false);
  });
});

