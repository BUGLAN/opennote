/**
 * 本地笔记本 ↔ GitHub 仓库的双向同步（`planPush` / `planPull` / `collectLocalFiles` / `pushChanges` / `pullChanges`）。
 *
 * 这一组打的是「判据只有一个来源（基线）」这条纪律的四个后果：
 * ① 推送只碰 `imported:true` 的文件与本地新建的文件 —— 基线里那些只记账的源码/配置，
 *    即使本地没有，也**绝不**算「用户删了」（否则一次同步会把仓库里我们没导入的东西删光）；
 * ② 拉取按四个象限分派：远端新增 / 远端改本地没动 → 下载；远端删本地没动 → 删本地；
 *    两边都改 → 冲突，**一个字节都不动**，只在结果里列出来；
 * ③ 推送是「一次提交」：headSha → createBlob → createTree（删除用 `sha:null`）→
 *    createCommit（`parents:[head]`）→ updateRef → 回读 `tree(commitSha)`；
 *    远端在我们读完之后前进过就抛 GH-STALE，且**一个写操作都不做**（绝不静默强推）；
 * ④ 基线的 `remoteSha` 一律从**远端读回来**，不靠本地推算（猜错一个 sha，下次拉取会判成「远端改了」）。
 *
 * 全部用例跑在内存后端 + 假 `GithubApi`（普通对象字面量，带调用记录）上：无网络、无 DOM、无定时器。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../clip/hash";
import { MemoryBackend } from "../clip/testing/memoryBackend";
import { GithubError, type GithubApi, type GithubTree, type GithubTreeEntry } from "./api";
import { makeBaseline, type GithubBaseline, type GithubBaselineFile } from "./baseline";
import { collectLocalFiles, planPull, planPush, pullChanges, pushChanges, pushIsEmpty, type LocalFile } from "./sync";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const bytesOf = (text: string): number => utf8(text).byteLength;

function blob(path: string, sha: string, size = 1): GithubTreeEntry {
  return { path, type: "blob", sha, size };
}

function treeOf(entries: GithubTreeEntry[], sha = "tree-1", truncated = false): GithubTree {
  return { sha, entries, truncated };
}

function baselineOf(
  files: Record<string, GithubBaselineFile>,
  overrides: { headSha?: string; treeSha?: string; ref?: string } = {},
): GithubBaseline {
  return makeBaseline({
    owner: "BUGLAN",
    repo: "opennote",
    ref: overrides.ref ?? "main",
    remote: "https://github.com/BUGLAN/opennote",
    headSha: overrides.headSha ?? "head-1",
    treeSha: overrides.treeSha ?? "base-tree-1",
    files,
  });
}

interface FakeApiOptions {
  head?: string;
  /** 按传进来的 ref / commit sha 分派文件树；没准备的那个会抛错（调用点写错就当场暴露）。 */
  trees?: Record<string, GithubTree>;
  commitTreeSha?: string;
  blobShas?: string[];
  createdTreeSha?: string;
  commitSha?: string;
  raw?: Record<string, Uint8Array>;
  rawFails?: string[];
  /** `createBlob` 抛错：用来验证「失败都发生在动引用之前」。 */
  failBlob?: boolean;
}

/**
 * 假 `GithubApi`：记录每一次调用的**顺序与载荷**，测试直接断言它们。
 * `log` 只记方法名，用来断言「阶段顺序」；其余字段记结构化载荷。
 */
function fakeApi(options: FakeApiOptions = {}) {
  const rec = {
    log: [] as string[],
    headSha: [] as string[],
    tree: [] as string[],
    raw: [] as { path: string; ref: string }[],
    commitTree: [] as string[],
    createBlob: [] as { text: string; bytes: number }[],
    createTree: [] as { baseTree: string; entries: { path: string; sha: string | null }[] }[],
    createCommit: [] as { message: string; tree: string; parents: string[] }[],
    updateRef: [] as { ref: string; sha: string }[],
  };
  const decoder = new TextDecoder();

  const api: GithubApi = {
    repo: async () => {
      throw new Error("假 api：这套用例不该调用 repo()");
    },
    headSha: async (ref) => {
      rec.log.push("headSha");
      rec.headSha.push(ref);
      return options.head ?? "head-1";
    },
    tree: async (ref) => {
      rec.log.push("tree");
      rec.tree.push(ref);
      const found = options.trees?.[ref];
      if (!found) throw new Error(`假 api：没有为 ${ref} 准备文件树`);
      return found;
    },
    raw: async (path, ref) => {
      rec.log.push("raw");
      rec.raw.push({ path, ref });
      if (options.rawFails?.includes(path)) {
        throw new GithubError("GH-404", "仓库或文件不存在，或者它是私有仓库（私有仓库需要访问令牌）。", 404);
      }
      const bytes = options.raw?.[path];
      if (!bytes) throw new Error(`假 api：没有为 ${path} 准备字节`);
      return bytes;
    },
    commitTree: async (sha) => {
      rec.log.push("commitTree");
      rec.commitTree.push(sha);
      return options.commitTreeSha ?? "commit-tree-1";
    },
    createBlob: async (bytes) => {
      rec.log.push("createBlob");
      const index = rec.createBlob.length;
      rec.createBlob.push({ text: decoder.decode(bytes), bytes: bytes.byteLength });
      if (options.failBlob) throw new Error("boom");
      return options.blobShas?.[index] ?? `blob-${index + 1}`;
    },
    createTree: async (input) => {
      rec.log.push("createTree");
      rec.createTree.push({
        baseTree: input.baseTree,
        entries: input.entries.map((entry) => ({ path: entry.path, sha: entry.sha })),
      });
      return options.createdTreeSha ?? "new-tree-1";
    },
    createCommit: async (input) => {
      rec.log.push("createCommit");
      rec.createCommit.push({ message: input.message, tree: input.tree, parents: [...input.parents] });
      return options.commitSha ?? "commit-1";
    },
    updateRef: async (ref, sha) => {
      rec.log.push("updateRef");
      rec.updateRef.push({ ref, sha });
    },
  };
  return { api, rec };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("planPush · 推送计划", () => {
  it("新增 / 修改 / 删除各归各位", async () => {
    const baseline = baselineOf({
      "notes/keep.md": { remoteSha: "r-keep", localHash: await sha256Hex("没动过"), imported: true },
      "notes/edit.md": { remoteSha: "r-edit", localHash: await sha256Hex("老内容"), imported: true },
      "notes/gone.md": { remoteSha: "r-gone", localHash: await sha256Hex("本地删了"), imported: true },
    });
    const local: LocalFile[] = [
      { path: "notes/keep.md", hash: await sha256Hex("没动过"), bytes: bytesOf("没动过") },
      { path: "notes/edit.md", hash: await sha256Hex("改过的内容"), bytes: bytesOf("改过的内容") },
      { path: "notes/brand-new.md", hash: await sha256Hex("本地新写的"), bytes: bytesOf("本地新写的") },
    ];

    const plan = planPush(baseline, local);

    expect(plan.added).toEqual([{ path: "notes/brand-new.md", hash: await sha256Hex("本地新写的"), bytes: bytesOf("本地新写的") }]);
    expect(plan.modified).toEqual([{ path: "notes/edit.md", hash: await sha256Hex("改过的内容"), bytes: bytesOf("改过的内容") }]);
    expect(plan.deleted).toEqual(["notes/gone.md"]);
    expect(pushIsEmpty(plan)).toBe(false);
  });

  it("关键：基线里 imported:false 的条目本地没有，也绝不算「用户删了」", async () => {
    // 导入一个代码仓库之后：源码/配置只在基线里记账，本地根本没有落地
    const baseline = baselineOf({
      "notes/a.md": { remoteSha: "r-a", localHash: await sha256Hex("一样的内容"), imported: true },
      "src/main.ts": { remoteSha: "r-src", localHash: null, imported: false },
      ".github/workflows/ci.yml": { remoteSha: "r-ci", localHash: null, imported: false },
      "package.json": { remoteSha: "r-pkg", localHash: null, imported: false },
    });

    const plan = planPush(baseline, [{ path: "notes/a.md", hash: await sha256Hex("一样的内容"), bytes: bytesOf("一样的内容") }]);
    expect(plan).toEqual({ added: [], modified: [], deleted: [] });
    expect(pushIsEmpty(plan)).toBe(true);

    // 连本地那一篇笔记也删掉：只有 imported:true 的那条算「用户删了」
    const afterLocalDelete = planPush(baseline, []);
    expect(afterLocalDelete.deleted).toEqual(["notes/a.md"]);
    expect(afterLocalDelete.deleted).not.toContain("src/main.ts");
    expect(afterLocalDelete.deleted).not.toContain(".github/workflows/ci.yml");
    expect(afterLocalDelete.deleted).not.toContain("package.json");
  });

  it("本地哈希与基线 localHash 相同 → 不算修改；本地新文件才算 added", async () => {
    const sameHash = await sha256Hex("一个字都没改");
    const baseline = baselineOf({
      "notes/same.md": { remoteSha: "r-same", localHash: sameHash, imported: true },
    });
    const plan = planPush(baseline, [
      { path: "notes/same.md", hash: sameHash, bytes: bytesOf("一个字都没改") },
      { path: "notes/新文件.md", hash: await sha256Hex("刚建的"), bytes: bytesOf("刚建的") },
    ]);

    expect(plan.modified).toEqual([]);
    expect(plan.added).toEqual([{ path: "notes/新文件.md", hash: await sha256Hex("刚建的"), bytes: bytesOf("刚建的") }]);
    expect(plan.deleted).toEqual([]);
  });
});

describe("planPull · 拉取计划（四个象限）", () => {
  it("远端新增 → download", () => {
    const plan = planPull(baselineOf({}), treeOf([blob("notes/new.md", "r-new")]), []);
    expect(plan).toEqual({ download: [{ path: "notes/new.md", sha: "r-new" }], removeLocal: [], conflicts: [] });
  });

  it("远端改了、本地没动 → download；远端没变则一个都不动", async () => {
    const content = "老内容";
    const localHash = await sha256Hex(content);
    const baseline = baselineOf({ "notes/a.md": { remoteSha: "r-old", localHash, imported: true } });
    const local: LocalFile[] = [{ path: "notes/a.md", hash: localHash, bytes: bytesOf(content) }];

    expect(planPull(baseline, treeOf([blob("notes/a.md", "r-new")]), local)).toEqual({
      download: [{ path: "notes/a.md", sha: "r-new" }],
      removeLocal: [],
      conflicts: [],
    });
    // 远端 sha 与基线一致 → 什么都不用做
    expect(planPull(baseline, treeOf([blob("notes/a.md", "r-old")]), local)).toEqual({
      download: [],
      removeLocal: [],
      conflicts: [],
    });
  });

  it("远端改了、本地也改了 → both-modified 冲突（不下载）", async () => {
    const baseline = baselineOf({
      "notes/a.md": { remoteSha: "r-old", localHash: await sha256Hex("老内容"), imported: true },
    });
    const local: LocalFile[] = [
      { path: "notes/a.md", hash: await sha256Hex("本地改过"), bytes: bytesOf("本地改过") },
    ];

    expect(planPull(baseline, treeOf([blob("notes/a.md", "r-new")]), local)).toEqual({
      download: [],
      removeLocal: [],
      conflicts: [{ path: "notes/a.md", reason: "both-modified" }],
    });
  });

  it("远端删了、本地没动 → removeLocal", async () => {
    const localHash = await sha256Hex("原样");
    const baseline = baselineOf({ "notes/a.md": { remoteSha: "r-old", localHash, imported: true } });
    const local: LocalFile[] = [{ path: "notes/a.md", hash: localHash, bytes: bytesOf("原样") }];

    expect(planPull(baseline, treeOf([]), local)).toEqual({
      download: [],
      removeLocal: ["notes/a.md"],
      conflicts: [],
    });
  });

  it("远端删了、本地改过 → deleted-remotely-modified-locally 冲突（不删本地）", async () => {
    const baseline = baselineOf({
      "notes/a.md": { remoteSha: "r-old", localHash: await sha256Hex("老内容"), imported: true },
    });
    const local: LocalFile[] = [
      { path: "notes/a.md", hash: await sha256Hex("本地改过"), bytes: bytesOf("本地改过") },
    ];

    expect(planPull(baseline, treeOf([]), local)).toEqual({
      download: [],
      removeLocal: [],
      conflicts: [{ path: "notes/a.md", reason: "deleted-remotely-modified-locally" }],
    });
  });

  it("基线里 imported:false 的源码/配置远端改了 → **绝不**进 download（不落地就不会被推回去）", () => {
    // 曾经的实现写成 `if (!known || !known.imported) download`，于是远端一改就把仓库源码写进笔记本，
    // 下一次推送又把它当新笔记推回去。判据现在与导入共用一份（`isMaterializable()`）。
    const baseline = baselineOf({ "src/main.ts": { remoteSha: "r-old", localHash: null, imported: false } });

    expect(planPull(baseline, treeOf([blob("src/main.ts", "r-new")]), [])).toEqual({
      download: [],
      removeLocal: [],
      conflicts: [],
    });
  });

  it("上次因上限/失败没物化的**笔记**远端改了 → 仍然会进 download（给它一次重试机会）", () => {
    const baseline = baselineOf({ "notes/big.md": { remoteSha: "r-old", localHash: null, imported: false } });

    expect(planPull(baseline, treeOf([blob("notes/big.md", "r-new")]), [])).toEqual({
      download: [{ path: "notes/big.md", sha: "r-new" }],
      removeLocal: [],
      conflicts: [],
    });
  });

  it("本地删了 + 远端改了 → deleted-locally-modified-remotely（不是笼统的 both-modified）", () => {
    const baseline = baselineOf({ "notes/a.md": { remoteSha: "r-old", localHash: "h-old", imported: true } });

    expect(planPull(baseline, treeOf([blob("notes/a.md", "r-new")]), [])).toEqual({
      download: [],
      removeLocal: [],
      conflicts: [{ path: "notes/a.md", reason: "deleted-locally-modified-remotely" }],
    });
  });
});

describe("collectLocalFiles · 本地扫描", () => {
  it("跳过 .opennote/、.git、隐藏路径与 node_modules/dist/release；其余带回 sha256 与字节数", async () => {
    const noteText = "# 中文笔记\n";
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const backend = new MemoryBackend();
    // 该收的
    backend.seed("README.md", "根目录的说明");
    backend.seed("notes/中文笔记.md", noteText);
    backend.seed("sub/dir/b.txt", "嵌套的纯文本");
    backend.seedBytes("assets/pic.png", png);
    // 该跳过的：状态目录、git 目录、隐藏文件、依赖与产物目录（含嵌套的 node_modules）
    backend.seed(".opennote/github.json", "{}");
    backend.seed(".git/config", "[core]");
    backend.seed(".github/workflows/ci.yml", "on: push");
    backend.seed(".hidden.md", "隐藏笔记");
    backend.seed("notes/.secret.md", "目录里的隐藏文件");
    backend.seed("node_modules/pkg/index.js", "module.exports = {}");
    backend.seed("dist/app.js", "built");
    backend.seed("release/app.exe", "binary");
    backend.seed("sub/node_modules/x.md", "嵌套依赖");

    const local = await collectLocalFiles(backend);
    const byPath = [...local].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    expect(byPath).toEqual([
      { path: "README.md", hash: await sha256Hex("根目录的说明"), bytes: bytesOf("根目录的说明") },
      { path: "assets/pic.png", hash: await sha256Hex(png), bytes: png.byteLength },
      { path: "notes/中文笔记.md", hash: await sha256Hex(noteText), bytes: bytesOf(noteText) },
      { path: "sub/dir/b.txt", hash: await sha256Hex("嵌套的纯文本"), bytes: bytesOf("嵌套的纯文本") },
    ]);
    expect(byPath[2].hash).toMatch(/^[0-9a-f]{64}$/);
    const paths = local.map((file) => file.path);
    for (const skipped of [
      ".opennote/github.json",
      ".git/config",
      ".github/workflows/ci.yml",
      ".hidden.md",
      "notes/.secret.md",
      "node_modules/pkg/index.js",
      "dist/app.js",
      "release/app.exe",
      "sub/node_modules/x.md",
    ]) {
      expect(paths, skipped).not.toContain(skipped);
    }
  });

  it("maxFiles 封顶，只取扫描顺序里的前几个", async () => {
    const backend = new MemoryBackend();
    backend.seed("a.md", "A");
    backend.seed("b.md", "B");
    backend.seed("c.md", "C");

    const local = await collectLocalFiles(backend, { maxFiles: 2 });
    expect(local.map((file) => file.path)).toEqual(["a.md", "b.md"]);
    expect(local[0]).toEqual({ path: "a.md", hash: await sha256Hex("A"), bytes: 1 });
  });
});

describe("pushChanges · 一次提交推完", () => {
  it("顺序与载荷：headSha → createBlob（只发新增/修改）→ createTree（删除 sha:null + baseTree）→ createCommit(parents:[head]) → updateRef", async () => {
    const keepText = "没动过";
    const editText = "本地改过的新内容";
    const newText = "本地新写的";
    const oldEditText = "旧内容";
    const backend = new MemoryBackend();
    backend.seed("notes/keep.md", keepText);
    backend.seed("notes/edit.md", editText);
    backend.seed("notes/new.md", newText);
    backend.seed(".opennote/github.json", '{"version":1}'); // 状态文件不是仓库内容
    const baseline = baselineOf({
      "notes/keep.md": { remoteSha: "r-keep", localHash: await sha256Hex(keepText), imported: true },
      "notes/edit.md": { remoteSha: "r-edit", localHash: await sha256Hex(oldEditText), imported: true },
      "notes/gone.md": { remoteSha: "r-gone", localHash: await sha256Hex("本地删了"), imported: true },
      "src/main.ts": { remoteSha: "r-src", localHash: null, imported: false },
    });
    const { api, rec } = fakeApi({
      head: "head-1",
      /*
       * 故意准备一棵「与新 blob 不一致」的树：**推送路径根本不该去读它**。
       * 基线的 `remoteSha` 取自 `createBlob()` 的返回值（GitHub 对我们刚上传的那份字节给出的
       * 权威 blob sha）—— 事后回读一旦失败就会**在 `updateRef` 之后**抛错（远端已经前进、基线没更新），
       * 所以那条路被删掉了，`tree()` 也不该在这次推送里出现。
       */
      trees: {
        "commit-1": treeOf([blob("notes/keep.md", "r-keep-1"), blob("notes/edit.md", "r-edit-1"), blob("notes/new.md", "r-new-1")], "tree-after-1"),
      },
    });

    const result = await pushChanges({ api, backend, baseline, message: "同步笔记" });

    // 阶段顺序：一次读（headSha）→ 两个 blob（新增 + 修改）→ 树 → 提交 → 引用。**没有回读**
    expect(rec.log).toEqual(["headSha", "createBlob", "createBlob", "createTree", "createCommit", "updateRef"]);
    expect(rec.headSha).toEqual(["main"]);
    expect(rec.tree).toEqual([]); // 推送过程一次树都不读（读了就要处理「读失败但引用已前进」的死局）
    expect(rec.commitTree).toEqual([]); // 基线里有 treeSha，不必另外去读提交
    // 没改的 keep.md、没物化的 src/main.ts、被删的 gone.md 都不该发 blob
    expect(rec.createBlob).toEqual([
      { text: newText, bytes: bytesOf(newText) },
      { text: editText, bytes: bytesOf(editText) },
    ]);
    expect(rec.createTree).toEqual([
      {
        baseTree: "base-tree-1",
        entries: [
          { path: "notes/new.md", sha: "blob-1" },
          { path: "notes/edit.md", sha: "blob-2" },
          { path: "notes/gone.md", sha: null }, // 删除就是这么表达的
        ],
      },
    ]);
    expect(rec.createCommit).toEqual([{ message: "同步笔记", tree: "new-tree-1", parents: ["head-1"] }]);
    expect(rec.updateRef).toEqual([{ ref: "main", sha: "commit-1" }]);
    // 状态文件永不推送
    expect(rec.createTree[0].entries.map((entry) => entry.path)).not.toContain(".opennote/github.json");

    // 结果：三个计数 + 新头/新树
    expect({
      commitSha: result.commitSha,
      treeSha: result.treeSha,
      headSha: result.headSha,
      added: result.added,
      modified: result.modified,
      deleted: result.deleted,
    }).toEqual({ commitSha: "commit-1", treeSha: "new-tree-1", headSha: "commit-1", added: 1, modified: 1, deleted: 1 });

    // 基线：remoteSha 是 createBlob 的返回值（blob-1 / blob-2），localHash 是本地那一份的哈希
    expect(result.files["notes/new.md"]).toEqual({ remoteSha: "blob-1", localHash: await sha256Hex(newText), imported: true });
    expect(result.files["notes/edit.md"]).toEqual({ remoteSha: "blob-2", localHash: await sha256Hex(editText), imported: true });
    // 删掉的条目从账本里去掉；没推的文件保持原样（不拿别处的值去覆盖）
    expect(result.files["notes/gone.md"]).toBeUndefined();
    expect(result.files["notes/keep.md"]).toEqual({ remoteSha: "r-keep", localHash: await sha256Hex(keepText), imported: true });
    expect(result.files["src/main.ts"]).toEqual({ remoteSha: "r-src", localHash: null, imported: false });
  });

  it("headSha 与基线不一致 → GH-STALE，且一个写操作都不做", async () => {
    const backend = new MemoryBackend();
    backend.seed("notes/new.md", "本地新写的");
    const baseline = baselineOf({}, { headSha: "head-1" });
    const { api, rec } = fakeApi({ head: "head-2", trees: { "head-2": treeOf([]) } });

    // 中文那句话在 `userMessage` 上（界面走 describeGithubError），`Error.message` 是错误码
    await expect(pushChanges({ api, backend, baseline, message: "同步" })).rejects.toMatchObject({
      code: "GH-STALE",
      userMessage: "远端有新的提交，推送被拒绝了。请先「从远端拉取」。",
      status: 409,
    });

    expect(rec.log).toEqual(["headSha"]); // 连 tree 都没读，更没有 blob/tree/commit/ref
    expect({
      blob: rec.createBlob.length,
      tree: rec.createTree.length,
      commit: rec.createCommit.length,
      ref: rec.updateRef.length,
    }).toEqual({ blob: 0, tree: 0, commit: 0, ref: 0 });
    expect(backend.calls.filter((call) => call.startsWith("write"))).toEqual([]);
  });

  it("基线没有 treeSha 时，用 commitTree(head) 当 base_tree", async () => {
    const text = "第一次推";
    const backend = new MemoryBackend();
    backend.seed("a.md", text);
    const baseline = baselineOf({}, { treeSha: "" });
    const { api, rec } = fakeApi({
      head: "head-1",
      commitTreeSha: "tree-from-head",
      trees: { "commit-1": treeOf([blob("a.md", "r-a-1")]) },
    });

    const result = await pushChanges({ api, backend, baseline, message: "首推" });

    expect(rec.log).toEqual(["headSha", "createBlob", "commitTree", "createTree", "createCommit", "updateRef"]);
    expect(rec.commitTree).toEqual(["head-1"]);
    expect(rec.createTree[0].baseTree).toBe("tree-from-head");
    // remoteSha 仍取自 createBlob（`blob-1`），不是那棵树的 `r-a-1`
    expect(result.files["a.md"]).toEqual({ remoteSha: "blob-1", localHash: await sha256Hex(text), imported: true });
  });

  it("失败都发生在动引用之前：blob 失败 → 一次写操作都不做（远端引用不动）", async () => {
    const backend = new MemoryBackend();
    backend.seed("notes/new.md", "本地新写的");
    const baseline = baselineOf({});
    const { api, rec } = fakeApi({ head: "head-1", failBlob: true });

    await expect(pushChanges({ api, backend, baseline, message: "同步" })).rejects.toThrow("boom");
    // 关键不变量：引用没被更新，远端看起来完全没变（前一步产物只是悬空对象）
    expect(rec.updateRef).toEqual([]);
    expect(rec.createTree).toEqual([]);
    expect(rec.createCommit).toEqual([]);
  });
});

describe("pullChanges · 拉取", () => {
  it("远端新增 / 远端改了本地没动 → 写到本地，基线补上 remoteSha 与 localHash", async () => {
    const oldText = "旧内容";
    const newText = "远端改过的内容";
    const freshText = "远端新加的一篇";
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const backend = new MemoryBackend();
    backend.seed("notes/a.md", oldText); // 本地没动过这一份 → 可以被覆盖
    const baseline = baselineOf({
      "notes/a.md": { remoteSha: "r-old", localHash: await sha256Hex(oldText), imported: true },
    });
    const { api, rec } = fakeApi({
      head: "head-2",
      trees: {
        main: treeOf(
          [blob("notes/a.md", "r-new"), blob("notes/新笔记.md", "r-fresh"), blob("assets/pic.png", "r-pic")],
          "tree-ref-2",
        ),
      },
      raw: { "notes/a.md": utf8(newText), "notes/新笔记.md": utf8(freshText), "assets/pic.png": png },
    });

    const result = await pullChanges({ api, backend, baseline });

    expect(rec.log).toEqual(["headSha", "tree", "raw", "raw", "raw"]);
    expect(rec.headSha).toEqual(["main"]);
    expect(rec.tree).toEqual(["main"]);
    expect(rec.raw).toEqual([
      { path: "notes/a.md", ref: "main" },
      { path: "notes/新笔记.md", ref: "main" },
      { path: "assets/pic.png", ref: "main" },
    ]);
    expect({ downloaded: result.downloaded, removed: result.removed, conflicts: result.conflicts }).toEqual({
      downloaded: 3,
      removed: 0,
      conflicts: [],
    });
    expect(result.headSha).toBe("head-2");
    expect(result.treeSha).toBe("tree-ref-2");

    // 落盘：文本走 writeText、图片走 writeBytes
    expect(backend.text("notes/a.md")).toBe(newText);
    expect(backend.text("notes/新笔记.md")).toBe(freshText);
    expect(backend.bytes("assets/pic.png")).toEqual(png);
    expect(backend.calls).toContain("writeText:notes/a.md");
    expect(backend.calls).toContain("writeBytes:assets/pic.png");
    expect(backend.calls).not.toContain("writeText:assets/pic.png");

    // 基线：remoteSha 用树里的 sha，localHash 是刚落盘那份字节的 sha256
    expect(result.files["notes/a.md"]).toEqual({ remoteSha: "r-new", localHash: await sha256Hex(utf8(newText)), imported: true });
    expect(result.files["notes/新笔记.md"]).toEqual({
      remoteSha: "r-fresh",
      localHash: await sha256Hex(utf8(freshText)),
      imported: true,
    });
    expect(result.files["assets/pic.png"]).toEqual({ remoteSha: "r-pic", localHash: await sha256Hex(png), imported: true });
    expect(result.files["assets/pic.png"].localHash).toBe(await sha256Hex(backend.bytes("assets/pic.png")!));
    expect(Object.keys(result.files).sort()).toEqual(["assets/pic.png", "notes/a.md", "notes/新笔记.md"]);
  });

  it("远端删了、本地没动 → 删本地并从基线里去掉；imported:false 的源码不动", async () => {
    const goneText = "远端删掉了";
    const backend = new MemoryBackend();
    backend.seed("notes/gone.md", goneText);
    backend.seed("src/main.ts", "const a = 1;\n"); // 本地自己有一份源码，但它没物化过
    const baseline = baselineOf({
      "notes/gone.md": { remoteSha: "r-gone", localHash: await sha256Hex(goneText), imported: true },
      "src/main.ts": { remoteSha: "r-src", localHash: null, imported: false },
    });
    const { api, rec } = fakeApi({ head: "head-3", trees: { main: treeOf([], "tree-ref-3") } });

    const result = await pullChanges({ api, backend, baseline });

    expect(rec.log).toEqual(["headSha", "tree"]); // 没有下载，就不该去取字节
    expect({ downloaded: result.downloaded, removed: result.removed, conflicts: result.conflicts }).toEqual({
      downloaded: 0,
      removed: 1,
      conflicts: [],
    });
    expect(await backend.exists("notes/gone.md")).toBe(false);
    expect(backend.calls).toContain("remove:notes/gone.md");
    // 只记账（imported:false）的文件：远端没了也**不**动本地
    expect(await backend.exists("src/main.ts")).toBe(true);
    expect(backend.text("src/main.ts")).toBe("const a = 1;\n");
    expect(Object.keys(result.files)).toEqual(["src/main.ts"]);
    expect(result.files["src/main.ts"]).toEqual({ remoteSha: "r-src", localHash: null, imported: false });
    expect(result.headSha).toBe("head-3");
    expect(result.treeSha).toBe("tree-ref-3");
  });

  it("冲突的文件原样不动，只在结果里列出，基线也不改", async () => {
    const backend = new MemoryBackend();
    backend.seed("notes/b.md", "b 本地改过");
    backend.seed("notes/c.md", "c 本地改过");
    const baseline = baselineOf({
      "notes/b.md": { remoteSha: "r-b", localHash: await sha256Hex("b 老内容"), imported: true },
      "notes/c.md": { remoteSha: "r-c", localHash: await sha256Hex("c 老内容"), imported: true },
    });
    // b.md 远端也改了；c.md 远端直接删了
    const { api, rec } = fakeApi({ head: "head-4", trees: { main: treeOf([blob("notes/b.md", "r-b-new")], "tree-ref-4") } });

    const result = await pullChanges({ api, backend, baseline });

    expect(result.conflicts).toEqual([
      { path: "notes/b.md", reason: "both-modified" },
      { path: "notes/c.md", reason: "deleted-remotely-modified-locally" },
    ]);
    expect({ downloaded: result.downloaded, removed: result.removed }).toEqual({ downloaded: 0, removed: 0 });
    expect(rec.raw).toEqual([]); // 冲突不去取远端字节
    expect(backend.calls.filter((call) => call.startsWith("write") || call.startsWith("remove"))).toEqual([]);
    expect(backend.text("notes/b.md")).toBe("b 本地改过");
    expect(backend.text("notes/c.md")).toBe("c 本地改过");
    // 基线不能假装「远端那一份已经拉下来了」
    expect(result.files["notes/b.md"]).toEqual({ remoteSha: "r-b", localHash: await sha256Hex("b 老内容"), imported: true });
    expect(result.files["notes/c.md"]).toEqual({ remoteSha: "r-c", localHash: await sha256Hex("c 老内容"), imported: true });
  });

  it("远端新增但 raw() 拿不到 → 不计进 downloaded，也不留假状态", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const backend = new MemoryBackend();
    const baseline = baselineOf({});
    const { api, rec } = fakeApi({
      head: "head-5",
      trees: { main: treeOf([blob("notes/broken.md", "r-broken")], "tree-ref-5") },
      rawFails: ["notes/broken.md"],
    });

    const result = await pullChanges({ api, backend, baseline });

    expect(rec.raw).toEqual([{ path: "notes/broken.md", ref: "main" }]);
    expect({ downloaded: result.downloaded, removed: result.removed, conflicts: result.conflicts }).toEqual({
      downloaded: 0,
      removed: 0,
      conflicts: [],
    });
    expect(await backend.exists("notes/broken.md")).toBe(false);
    // 基线里干脆没有这一条 —— 下一次拉取还会再试，而不是「假装本地已经有这一份」
    expect(result.files["notes/broken.md"]).toBeUndefined();
    expect(Object.keys(result.files)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toContain("notes/broken.md");
  });

  it("没物化过的远端条目：拉取失败也把 remoteSha 更到最新（否则每次拉取都判成「远端改了」）", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const backend = new MemoryBackend();
    const baseline = baselineOf({ "src/main.ts": { remoteSha: "r-src-old", localHash: null, imported: false } });
    const { api } = fakeApi({
      head: "head-6",
      trees: { main: treeOf([blob("src/main.ts", "r-src-new")], "tree-ref-6") },
      rawFails: ["src/main.ts"],
    });

    const result = await pullChanges({ api, backend, baseline });

    expect({ downloaded: result.downloaded, removed: result.removed }).toEqual({ downloaded: 0, removed: 0 });
    expect(result.files["src/main.ts"]).toEqual({ remoteSha: "r-src-new", localHash: null, imported: false });
    expect(await backend.exists("src/main.ts")).toBe(false);
  });
});
