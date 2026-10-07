/**
 * 「从 GitHub 仓库导入」：`planImport()`（纯函数：树 → 计划）与 `runImport()`（取字节 → 写盘 → 记哈希）。
 *
 * 这一组只打导入的成败点（每一条都对应一个真实后果）：
 * ① 只有笔记（`.md`/`.txt` 一族）与图片**落盘**，源码/配置/CI 只进基线账本（`imported:false`）——
 *    这就是「导入一个代码仓库不会把整个仓库抄下来」那条规则的落点；
 * ② 每一条跳过都要**能被数出来**（不是笔记 / 单文件太大 / 数量或体积到顶），界面按这几个数字如实汇报；
 * ③ 某个文件 `raw()` 失败**绝不能**被当成「导入成功」：基线里必须留 `imported:false`，
 *    否则下一次 `planPush` 会把它当成「用户在本地删了」，把远端那一份删掉；
 * ④ 基线的 `localHash` 是**真正写下去的那份字节**的 sha256（不是远端 sha，也不是原文猜测）。
 *
 * 全部用例跑在内存后端 + 假 `GithubApi` 上：无网络、无 DOM、无 OPFS、无定时器。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../clip/hash";
import { MemoryBackend } from "../clip/testing/memoryBackend";
import { GithubError, type GithubApi, type GithubTree, type GithubTreeEntry } from "./api";
import {
  describeGithubError,
  MAX_FILE_BYTES,
  planImport,
  runImport,
  type ImportPlan,
  type RunImportInput,
} from "./importRepo";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const bytesOf = (text: string): number => utf8(text).byteLength;

function blob(path: string, sha: string, size: number): GithubTreeEntry {
  return { path, type: "blob", sha, size };
}

function treeOf(entries: GithubTreeEntry[], truncated = false, sha = "tree-1"): GithubTree {
  return { sha, entries, truncated };
}

/**
 * 假 api：只实现 `raw()`，其余八个方法一旦被调用就抛错 ——
 * `runImport` 只该走 CDN 那条路（配额、令牌都不该在这里出现）。
 */
function rawApi(raw: (path: string, ref: string) => Promise<Uint8Array>): GithubApi {
  const unused = (name: string) => async (): Promise<never> => {
    throw new Error(`runImport 不该调用 ${name}()`);
  };
  return {
    repo: unused("repo"),
    tree: unused("tree"),
    raw,
    headSha: unused("headSha"),
    commitTree: unused("commitTree"),
    createBlob: unused("createBlob"),
    createTree: unused("createTree"),
    createCommit: unused("createCommit"),
    updateRef: unused("updateRef"),
  };
}

const TARGET = { owner: "BUGLAN", repo: "opennote", remote: "https://github.com/BUGLAN/opennote" };

function importInput(
  plan: ImportPlan,
  backend: MemoryBackend,
  api: GithubApi,
  extra: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): RunImportInput {
  return {
    api,
    ref: "main",
    headSha: "head-1",
    treeSha: "tree-1",
    plan,
    target: TARGET,
    backend,
    signal: extra.signal,
    onProgress: extra.onProgress,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("planImport · 树 → 导入计划（纯函数）", () => {
  it("笔记与图片排进 materialize，源码/配置只进基线账本并计进 skippedNotNotes", () => {
    // 故意把条目打乱：物化顺序必须是**按路径排好**的（进度可复现），不是树里的顺序
    const tree = treeOf([
      blob("README.md", "sha-readme", 12),
      blob("src/main.ts", "sha-ts", 500),
      blob("assets/pic.png", "sha-png", 1024),
      blob(".github/workflows/ci.yml", "sha-ci", 300),
      blob("draft.txt", "sha-txt", 7),
    ]);
    const plan = planImport(tree);

    // `localeCompare` 顺序：assets → draft → README（大写字母排在后面）
    expect(plan.materialize).toEqual([
      { path: "assets/pic.png", sha: "sha-png", size: 1024 },
      { path: "draft.txt", sha: "sha-txt", size: 7 },
      { path: "README.md", sha: "sha-readme", size: 12 },
    ]);

    // 每个 blob 都在账本里有且只有一条，没物化的那两条也要在（同步时靠它判断「远端改没改」）
    expect(Object.keys(plan.files).sort()).toEqual([
      ".github/workflows/ci.yml",
      "README.md",
      "assets/pic.png",
      "draft.txt",
      "src/main.ts",
    ]);
    expect(Object.keys(plan.files)).toHaveLength(tree.entries.length);
    expect(plan.files["src/main.ts"]).toEqual({ remoteSha: "sha-ts", localHash: null, imported: false });
    expect(plan.files[".github/workflows/ci.yml"]).toEqual({ remoteSha: "sha-ci", localHash: null, imported: false });
    // 计划阶段一律 `imported:false`：写没写成功要等 runImport 真正落盘之后才知道
    expect(plan.files["README.md"]).toEqual({ remoteSha: "sha-readme", localHash: null, imported: false });

    expect({
      skippedNotNotes: plan.skippedNotNotes,
      skippedTooLarge: plan.skippedTooLarge,
      skippedOverLimit: plan.skippedOverLimit,
      truncated: plan.truncated,
    }).toEqual({ skippedNotNotes: 2, skippedTooLarge: 0, skippedOverLimit: 0, truncated: false });
  });

  it("单文件超上限 → skippedTooLarge（正好等于上限的不算超）", () => {
    const plan = planImport(
      treeOf([blob("big.md", "sha-big", 21), blob("edge.md", "sha-edge", 20), blob("src/app.ts", "sha-app", 1)]),
      { maxFileBytes: 20 },
    );
    expect(plan.materialize).toEqual([{ path: "edge.md", sha: "sha-edge", size: 20 }]);
    expect(plan.skippedTooLarge).toBe(1);
    expect(plan.skippedNotNotes).toBe(1); // src/app.ts 先按「不是笔记」记账
    expect(plan.skippedOverLimit).toBe(0);
    expect(plan.files["big.md"]).toEqual({ remoteSha: "sha-big", localHash: null, imported: false });

    // 不传 options 时用的是导出的默认上限（20 MB 那张图能进来，多一个字节就不行）
    const byDefault = planImport(treeOf([blob("huge.png", "sha-huge", MAX_FILE_BYTES + 1)]));
    expect(byDefault.skippedTooLarge).toBe(1);
    expect(byDefault.materialize).toEqual([]);
    const atLimit = planImport(treeOf([blob("huge.png", "sha-huge", MAX_FILE_BYTES)]));
    expect(atLimit.materialize).toEqual([{ path: "huge.png", sha: "sha-huge", size: MAX_FILE_BYTES }]);
  });

  it("数量到顶（maxFiles）之后剩下的计进 skippedOverLimit，不静默丢文件", () => {
    const tree = treeOf([blob("a.md", "sha-a", 1), blob("b.md", "sha-b", 1), blob("c.md", "sha-c", 1)]);
    const capped = planImport(tree, { maxFiles: 2 });
    expect(capped.materialize.map((item) => item.path)).toEqual(["a.md", "b.md"]);
    expect(capped.skippedOverLimit).toBe(1);
    expect(capped.files["c.md"]).toEqual({ remoteSha: "sha-c", localHash: null, imported: false });

    // 正好等于上限时不该多算一条
    const exact = planImport(tree, { maxFiles: 3 });
    expect(exact.materialize.map((item) => item.path)).toEqual(["a.md", "b.md", "c.md"]);
    expect(exact.skippedOverLimit).toBe(0);
  });

  it("体积到顶（maxBytes）按已接受的累计算：装不下的跳过，后面的小文件还能进来", () => {
    const plan = planImport(
      treeOf([blob("a.md", "sha-a", 60), blob("b.md", "sha-b", 60), blob("c.md", "sha-c", 10)]),
      { maxBytes: 100 },
    );
    // a(60) 进来 → b 会超（120 > 100）跳过 → c 仍装得下（70 ≤ 100）
    expect(plan.materialize).toEqual([
      { path: "a.md", sha: "sha-a", size: 60 },
      { path: "c.md", sha: "sha-c", size: 10 },
    ]);
    expect(plan.skippedOverLimit).toBe(1);
    expect(plan.files["b.md"]).toEqual({ remoteSha: "sha-b", localHash: null, imported: false });
  });

  it("同一路径只记一条（先到的为准）；空路径不记账；truncated 如实往上带", () => {
    const plan = planImport(
      treeOf([blob("a.md", "sha-1", 5), blob("a.md", "sha-2", 5), blob("", "sha-empty", 3)], true, "tree-x"),
    );
    expect(plan.materialize).toEqual([{ path: "a.md", sha: "sha-1", size: 5 }]);
    expect(Object.keys(plan.files)).toEqual(["a.md"]);
    expect(plan.files["a.md"]).toEqual({ remoteSha: "sha-1", localHash: null, imported: false });
    expect([plan.skippedNotNotes, plan.skippedTooLarge, plan.skippedOverLimit]).toEqual([0, 0, 0]);
    expect(plan.truncated).toBe(true);
    expect(planImport(treeOf([blob("a.md", "sha-1", 5)])).truncated).toBe(false);
  });
});

describe("runImport · 取字节、写盘、记哈希", () => {
  it("md/txt 写成文本、图片写成字节；localHash 是写下去那份字节的 sha256；基线带上四个身份字段", async () => {
    const noteText = "# 标题\n\n正文\n";
    const plainText = "纯文本笔记（.txt 也算笔记）";
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const dataByPath: Record<string, Uint8Array> = {
      "notes/a.md": utf8(noteText),
      "notes/b.txt": utf8(plainText),
      "assets/pic.png": imageBytes,
    };
    const plan = planImport(
      treeOf([
        blob("notes/a.md", "sha-a", bytesOf(noteText)),
        blob("notes/b.txt", "sha-b", bytesOf(plainText)),
        blob("assets/pic.png", "sha-pic", imageBytes.byteLength),
      ]),
    );
    const backend = new MemoryBackend();
    const rawCalls: { path: string; ref: string }[] = [];
    const api = rawApi(async (path, ref) => {
      rawCalls.push({ path, ref });
      const data = dataByPath[path];
      if (!data) throw new Error(`用例没有准备 ${path} 的字节`);
      return data;
    });
    const progress: { done: number; total: number }[] = [];

    const report = await runImport(
      importInput(plan, backend, api, { onProgress: (done, total) => progress.push({ done, total }) }),
    );

    // 写盘走的是哪条路：笔记 writeText、图片 writeBytes（不是「一律当字节写」）
    expect(backend.text("notes/a.md")).toBe(noteText);
    expect(backend.text("notes/b.txt")).toBe(plainText);
    expect(backend.bytes("assets/pic.png")).toEqual(imageBytes);
    expect(backend.calls).toContain("writeText:notes/a.md");
    expect(backend.calls).toContain("writeText:notes/b.txt");
    expect(backend.calls).toContain("writeBytes:assets/pic.png");
    expect(backend.calls).not.toContain("writeBytes:notes/a.md");
    expect(backend.calls).not.toContain("writeText:assets/pic.png");

    // localHash：写下去的那份字节的 sha256（64 位小写十六进制）
    expect(report.baseline.files["notes/a.md"]).toEqual({
      remoteSha: "sha-a",
      localHash: await sha256Hex(utf8(noteText)),
      imported: true,
    });
    expect(report.baseline.files["notes/a.md"].localHash).toBe(await sha256Hex(backend.bytes("notes/a.md")!));
    expect(report.baseline.files["assets/pic.png"]).toEqual({
      remoteSha: "sha-pic",
      localHash: await sha256Hex(imageBytes),
      imported: true,
    });
    expect(report.baseline.files["notes/b.txt"].localHash).toMatch(/^[0-9a-f]{64}$/);

    // 报告里的三个数字
    expect({ written: report.written, failed: report.failed, bytes: report.bytes }).toEqual({
      written: 3,
      failed: 0,
      bytes: bytesOf(noteText) + bytesOf(plainText) + imageBytes.byteLength,
    });

    // 进度：done 从 1 单调走到总数，total 恒定
    expect(progress.map((item) => item.done)).toEqual([1, 2, 3]);
    expect(progress.map((item) => item.total)).toEqual([3, 3, 3]);

    // 取字节走的是 raw(path, ref="main")，且每个要物化的文件都取了一次
    expect(rawCalls.map((call) => call.ref)).toEqual(["main", "main", "main"]);
    expect(rawCalls.map((call) => call.path).sort()).toEqual(["assets/pic.png", "notes/a.md", "notes/b.txt"]);

    // 基线身份：owner / repo / ref / remote / headSha / treeSha 一个都不能少
    expect(report.baseline).toMatchObject({
      version: 1,
      owner: "BUGLAN",
      repo: "opennote",
      ref: "main",
      remote: "https://github.com/BUGLAN/opennote",
      headSha: "head-1",
      treeSha: "tree-1",
    });
    expect(report.baseline.importedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("某个文件 raw() 失败：算进 failed、本地不写、基线留 imported:false（下次同步不会误删远端）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const goodText = "好的那一篇";
    const plan = planImport(
      treeOf([
        blob("notes/good.md", "sha-good", bytesOf(goodText)),
        blob("notes/bad.md", "sha-bad", 32),
        blob("assets/pic.png", "sha-pic", 4),
      ]),
    );
    const backend = new MemoryBackend();
    const api = rawApi(async (path) => {
      // 子模块 / LFS 指针 / 超大文件都会走到这里（CDN 拿不到）
      if (path === "notes/bad.md") throw new GithubError("GH-404", "仓库或文件不存在。", 404);
      if (path === "assets/pic.png") return new Uint8Array([1, 2, 3, 4]);
      return utf8(goodText);
    });
    const progress: number[] = [];

    const report = await runImport(importInput(plan, backend, api, { onProgress: (done) => progress.push(done) }));

    expect({ written: report.written, failed: report.failed, bytes: report.bytes }).toEqual({
      written: 2,
      failed: 1,
      bytes: bytesOf(goodText) + 4,
    });
    // 关键：失败的那一条绝不能标成 imported:true —— 否则 planPush 会把它读成「用户在本地删了」
    expect(report.baseline.files["notes/bad.md"]).toEqual({ remoteSha: "sha-bad", localHash: null, imported: false });
    expect(await backend.exists("notes/bad.md")).toBe(false);
    expect(backend.paths()).toEqual(["assets/pic.png", "notes/good.md"]);
    expect(report.baseline.files["notes/good.md"]).toEqual({
      remoteSha: "sha-good",
      localHash: await sha256Hex(utf8(goodText)),
      imported: true,
    });
    // 失败的那一份也走 finally：进度不会卡在中间
    expect(progress).toEqual([1, 2, 3]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toContain("notes/bad.md");
  });

  it("signal 已中止 → 一个文件都不写、不算失败，但**进度照常推进**（界面要说得出「已取消 N/M」）", async () => {
    const plan = planImport(treeOf([blob("notes/a.md", "sha-a", 2), blob("notes/b.md", "sha-b", 2)]));
    const backend = new MemoryBackend();
    const controller = new AbortController();
    controller.abort();
    const progress: number[] = [];

    const report = await runImport(
      importInput(plan, backend, rawApi(async () => utf8("x")), {
        signal: controller.signal,
        onProgress: (done) => progress.push(done),
      }),
    );

    expect({ written: report.written, failed: report.failed, aborted: report.aborted, bytes: report.bytes }).toEqual({
      written: 0,
      failed: 0,
      aborted: 2,
      bytes: 0,
    });
    expect(backend.paths()).toEqual([]);
    expect(report.baseline.files["notes/a.md"]).toEqual({ remoteSha: "sha-a", localHash: null, imported: false });
    // 取消不是「什么都没发生」：两条都推到了终态，进度回调必须走完（曾经的实现在 try 之前 return，进度一次都不回调）
    expect(progress).toEqual([1, 2]);
  });
});

describe("describeGithubError · 一句人话", () => {
  it("GithubError 说 userMessage；普通 Error 说 message；不是 Error 的说兜底句", () => {
    expect(describeGithubError(new GithubError("GH-404", "仓库或文件不存在。", 404))).toBe("仓库或文件不存在。");
    expect(describeGithubError(new Error("boom"))).toBe("boom");
    expect(describeGithubError(new Error(""))).toBe("连不上 GitHub，请检查网络后重试。");
    expect(describeGithubError("不是 Error")).toBe("连不上 GitHub，请检查网络后重试。");
  });
});
