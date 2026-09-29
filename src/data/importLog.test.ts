import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBackend } from "../lib/clip/testing/memoryBackend";
import type { WorkspaceRecord } from "./workspaces";

let testBackend: MemoryBackend;

vi.mock("./workspaces", () => ({
  activeWorkspaceRecord: () => null,
  resolveBackend: async () => testBackend,
  setActiveWorkspace: () => undefined,
}));

import { closeWorkspace, openWorkspace } from "./library";
import {
  IMPORT_INDEX_FILE,
  IMPORT_LOG_FILE,
  INDEX_LIMIT,
  LOG_LIMIT,
  PREIMAGE_DIR,
  findImportLogEntry,
  forgetImport,
  lookupImportByContent,
  lookupImportByContentHash,
  lookupImportById,
  lookupLatestBySourceUrl,
  markImportUndone,
  preimageRef,
  prunePreimages,
  readImportIndex,
  readImportLog,
  readPreimage,
  recordImport,
  removePreimage,
  resetImportIndexCache,
  rememberImport,
  writePreimage,
  type ImportIndexEntry,
  type ImportLogEntry,
} from "./importLog";

const RECORD: WorkspaceRecord = {
  id: "test",
  name: "临时笔记本",
  kind: "node",
  location: "unused",
  addedAt: 1,
  lastOpenedAt: 1,
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function entry(importId: string, overrides: Partial<ImportIndexEntry> = {}): ImportIndexEntry {
  return {
    importId,
    path: `${importId}.md`,
    title: `标题 ${importId}`,
    sourceUrl: "https://example.com/a",
    site: "example.com",
    publishedAt: null,
    selection: false,
    sourceHash: "sha256:aaaaaaaaaaaaaaaa",
    bodyHash: `sha256:${importId.padEnd(16, "0").slice(0, 16)}`,
    contentHash: `sha256:${importId.padEnd(16, "1").slice(0, 16)}`,
    tags: ["剪藏"],
    client: "cli",
    at: "2026-09-29T21:04:11+08:00",
    action: "created",
    ...overrides,
  };
}

function logEntry(importId: string, overrides: Partial<ImportLogEntry> = {}): ImportLogEntry {
  return {
    importId,
    op: "created",
    path: `${importId}.md`,
    preimagePath: null,
    preimageBytes: 0,
    preimageSha256: null,
    revertible: true,
    at: "2026-09-29T21:04:11+08:00",
    undoneAt: null,
    ...overrides,
  };
}

beforeEach(async () => {
  testBackend = new MemoryBackend();
  resetImportIndexCache();
  await openWorkspace(RECORD, { silent: true });
});

describe("路径常量（契约 §3.3.4 / 00 号 §6.10①）", () => {
  it("前像是 .opennote/import-preimages/，**不是** history/", () => {
    expect(PREIMAGE_DIR).toBe(".opennote/import-preimages");
    expect(PREIMAGE_DIR.startsWith(".opennote/history")).toBe(false);
    expect(IMPORT_LOG_FILE).toBe(".opennote/import-log.json");
    expect(IMPORT_INDEX_FILE).toBe(".opennote/import-index.json");
    expect(LOG_LIMIT).toBe(500);
    expect(INDEX_LIMIT).toBe(2000);
  });
});

describe("前像（逐字节）", () => {
  it("writePreimage 落到 .opennote/import-preimages/<importId>.md，读回来逐字节相同", async () => {
    const payload = new Uint8Array([0, 1, 2, 250, 251, 252, 10, 13]);
    const token = await writePreimage("剪藏/技术/标题.md", payload, { importId: "0f1d6d9a-6c2f-4a7e-9d31-5b0f2a7c1e88" });
    expect(token).toBe(".opennote/import-preimages/0f1d6d9a-6c2f-4a7e-9d31-5b0f2a7c1e88.md");
    expect(testBackend.bytes(token)).toEqual(payload);
    expect(await readPreimage(token)).toEqual(payload);
  });

  it("没有 importId 时也能生成唯一 token，不覆盖别人的前像", async () => {
    const a = await writePreimage("a.md", bytes("A"));
    const b = await writePreimage("b.md", bytes("B"));
    expect(a.startsWith(`${PREIMAGE_DIR}/`)).toBe(true);
    expect(a).not.toBe(b);
    expect(decoder.decode((await readPreimage(a))!)).toBe("A");
    expect(decoder.decode((await readPreimage(b))!)).toBe("B");
  });

  it("readPreimage 只接受前像目录下的 token（拒绝任意路径读）", async () => {
    testBackend.seed("笔记.md", "# 秘密\n");
    expect(await readPreimage("笔记.md")).toBeNull();
    expect(await readPreimage(".opennote/history/whatever.md")).toBeNull();
    expect(await readPreimage("../escape.md")).toBeNull();
    expect(await readPreimage("")).toBeNull();
    expect(await readPreimage(".opennote/import-preimages/missing.md")).toBeNull();
  });

  it("removePreimage 只删前像目录内的文件", async () => {
    const token = await writePreimage("a.md", bytes("A"), { importId: "id-1" });
    testBackend.seed("笔记.md", "# 别删我\n");
    await removePreimage("笔记.md");
    expect(testBackend.text("笔记.md")).not.toBeNull();
    await removePreimage(token);
    await expect(testBackend.exists(token)).resolves.toBe(false);
    await removePreimage(null); // 静默
  });

  it("preimageRef 是 sha256:<16hex>", async () => {
    expect(await preimageRef(bytes("abc"))).toBe("sha256:ba7816bf8f01cfea");
  });

  it("未打开笔记本时写前像直接失败（不会静默丢弃用户数据）", async () => {
    await closeWorkspace();
    await expect(writePreimage("a.md", bytes("A"))).rejects.toThrow();
  });
});

describe("导入日志（500 条上限 + 前像同源清理）", () => {
  it("新条目在最前，同 importId 覆盖旧行", async () => {
    await recordImport({ importId: "a", op: "created", path: "a.md", at: "2026-09-29T10:00:00Z" });
    await recordImport({ importId: "b", op: "duplicate", path: "a.md", at: "2026-09-29T11:00:00Z" });
    const log = await readImportLog();
    expect(log.map((item) => item.importId)).toEqual(["b", "a"]);

    await recordImport({ importId: "a", op: "appended", path: "a.md", revertible: true, at: "2026-09-29T12:00:00Z" });
    const again = await readImportLog();
    expect(again.filter((item) => item.importId === "a")).toHaveLength(1);
    expect(again[0].importId).toBe("a");
    expect(again[0].op).toBe("appended");
  });

  it("日志文件是 .opennote/import-log.json，形状固定且不留临时文件", async () => {
    const token = await writePreimage("a.md", bytes("A"), { importId: "a" });
    await recordImport({
      importId: "a",
      op: "appended",
      path: "a.md",
      preimagePath: token,
      preimageBytes: 1,
      preimageSha256: "sha256:ba7816bf8f01cfea",
      revertible: true,
    });
    const raw = testBackend.text(IMPORT_LOG_FILE)!;
    const parsed = JSON.parse(raw) as { version: number; updatedAt: string; entries: unknown[] };
    expect(parsed.version).toBe(1);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(testBackend.paths().filter((path) => path.endsWith(".tmp"))).toEqual([]);
  });

  it("第 501 条写入时丢掉最旧的一条并删掉它的前像", async () => {
    const oldestPreimage = await writePreimage("old.md", bytes("OLD"), { importId: "oldest" });
    // 直接铺满日志（数组尾部 = 最旧）；不跑 501 次读改写。
    const seeded = Array.from({ length: LOG_LIMIT }, (_, index) => ({
      ...logEntry(`old${String(index).padStart(4, "0")}`),
      ...(index === LOG_LIMIT - 1
        ? { preimagePath: oldestPreimage, preimageBytes: 3, preimageSha256: "sha256:aa", revertible: true }
        : {}),
    }));
    testBackend.seed(IMPORT_LOG_FILE, `${JSON.stringify({ version: 1, updatedAt: "2026-09-29T10:00:00Z", entries: seeded }, null, 2)}\n`);

    await recordImport({ importId: "newest", op: "created", path: "newest.md" });
    const log = await readImportLog();
    expect(log).toHaveLength(LOG_LIMIT);
    expect(log[0].importId).toBe("newest");
    expect(log.some((item) => item.importId === "oldest")).toBe(false);
    await expect(testBackend.exists(oldestPreimage)).resolves.toBe(false);
  });

  it("被保留条目引用的前像不会被误删", async () => {
    const seeded = Array.from({ length: LOG_LIMIT }, (_, index) => logEntry(`old${String(index).padStart(4, "0")}`));
    testBackend.seed(IMPORT_LOG_FILE, `${JSON.stringify({ version: 1, updatedAt: "2026-09-29T10:00:00Z", entries: seeded }, null, 2)}\n`);

    // 带前像的这条是**最新**的（在保留区），所以它的前像必须还在（即使触发了 500 条裁剪）。
    const shared = await writePreimage("a.md", bytes("A"), { importId: "shared" });
    await recordImport({ importId: "shared", op: "appended", path: "a.md", preimagePath: shared, revertible: true });
    expect((await readImportLog())[0].importId).toBe("shared");
    await expect(testBackend.exists(shared)).resolves.toBe(true);
  });

  it("prunePreimages 在没超限时什么都不做", async () => {
    await recordImport({ importId: "a", op: "created", path: "a.md" });
    expect(await prunePreimages()).toBe(0);
    expect((await readImportLog())).toHaveLength(1);
  });

  it("markImportUndone 打标记但不删行；findImportLogEntry 能取回", async () => {
    await recordImport({ importId: "a", op: "appended", path: "a.md", revertible: true });
    const changed = await markImportUndone("a", "2026-09-29T22:00:00+08:00");
    expect(changed).toBe(true);
    const found = await findImportLogEntry("a");
    expect(found?.undoneAt).toBe("2026-09-29T22:00:00+08:00");
    expect(await markImportUndone("不存在")).toBe(false);
  });

  it("日志损坏时退化成空日志，不抛", async () => {
    testBackend.seed(IMPORT_LOG_FILE, "{ 这不是 JSON");
    expect(await readImportLog()).toEqual([]);
  });
});

describe("幂等索引（契约 §4.3）", () => {
  it("rememberImport 之后三种查找都能命中，且落盘的是 .opennote/import-index.json", async () => {
    await rememberImport(entry("aaaa1111"));
    expect((await lookupImportById("aaaa1111"))?.path).toBe("aaaa1111.md");
    expect((await lookupImportByContent("https://example.com/a", entry("aaaa1111").bodyHash))?.importId).toBe("aaaa1111");
    expect((await lookupLatestBySourceUrl("https://example.com/a"))?.importId).toBe("aaaa1111");
    expect((await lookupImportByContentHash(entry("aaaa1111").contentHash))?.importId).toBe("aaaa1111");
    expect(testBackend.text(IMPORT_INDEX_FILE)).not.toBeNull();
  });

  it("缓存丢掉后从磁盘重建（不依赖进程内状态）", async () => {
    await rememberImport(entry("aaaa1111"));
    resetImportIndexCache();
    expect((await lookupImportById("aaaa1111"))?.path).toBe("aaaa1111.md");
  });

  it("同一个 URL 的最新一次命中：lookupLatestBySourceUrl 返回最后写入的那条", async () => {
    await rememberImport(entry("aaaa1111", { path: "一.md", at: "2026-09-29T10:00:00Z" }));
    await rememberImport(entry("bbbb2222", { path: "一.md", at: "2026-09-29T12:00:00Z" }));
    expect((await lookupLatestBySourceUrl("https://example.com/a"))?.importId).toBe("bbbb2222");
  });

  it("url 为 null 时按空串建内容键（第 2 步可去重），但**不作为可追加的来源**", async () => {
    await rememberImport(entry("aaaa1111", { sourceUrl: null }));
    expect((await lookupImportByContent(null, entry("aaaa1111").bodyHash))?.importId).toBe("aaaa1111");
    // 契约 §4.1 推论 5 只把 url: null 定义成「同一个空来源」用于第 2 步；第 3/4 步要求
    // 「同 source.url」，null 没有可识别的来源，所以不给追加/收件箱目标（→ 第 6 步新建）。
    expect(await lookupLatestBySourceUrl(null)).toBeNull();
  });

  it("forgetImport 同时清掉 id / 内容 / url 三种键", async () => {
    await rememberImport(entry("aaaa1111"));
    await forgetImport("aaaa1111");
    expect(await lookupImportById("aaaa1111")).toBeNull();
    expect(await lookupImportByContent("https://example.com/a", entry("aaaa1111").bodyHash)).toBeNull();
    expect(await lookupLatestBySourceUrl("https://example.com/a")).toBeNull();
  });

  it(`索引上限 ${INDEX_LIMIT} 条：装满后再记一条会丢掉最旧的一条`, async () => {
    // 直接铺满磁盘索引（不去跑 2001 次读改写：那是 O(n²) 的测试脚手架，不是被测行为）。
    const seeded = Array.from({ length: INDEX_LIMIT }, (_, index) =>
      entry(`old${String(index).padStart(6, "0")}`, { at: `2026-09-29T10:00:00Z` }),
    );
    testBackend.seed(IMPORT_INDEX_FILE, `${JSON.stringify({ version: 1, updatedAt: "2026-09-29T10:00:00Z", entries: seeded }, null, 2)}\n`);
    resetImportIndexCache();
    expect(await readImportIndex()).toHaveLength(INDEX_LIMIT);

    await rememberImport(entry("newest000", { at: "2026-09-30T10:00:00Z" }));
    const all = await readImportIndex();
    expect(all).toHaveLength(INDEX_LIMIT);
    expect(all[0].importId).toBe("newest000");
    // 最旧的那条（数组尾部）被丢弃，且落盘的就是裁剪后的结果。
    expect(all.some((item) => item.importId === `old${String(INDEX_LIMIT - 1).padStart(6, "0")}`)).toBe(false);
    resetImportIndexCache();
    expect(await readImportIndex()).toHaveLength(INDEX_LIMIT);
    expect((await readImportIndex()).some((item) => item.importId === "newest000")).toBe(true);
  });

  it("索引损坏时退化成空并可从笔记 front-matter 重建（§4.3.3）", async () => {
    testBackend.seed(IMPORT_INDEX_FILE, "{ 坏掉的 JSON");
    resetImportIndexCache();
    expect(await readImportIndex()).toEqual([]);
  });

  it("未打开笔记本时 rememberImport 抛错（调用方据此回 IMP-W005）", async () => {
    await closeWorkspace();
    await expect(rememberImport(entry("aaaa1111"))).rejects.toThrow();
  });
});
