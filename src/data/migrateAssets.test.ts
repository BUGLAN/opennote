import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parentPath } from "../fs/paths";
import { resolveWorkspacePath } from "../fs/workspaceRef";
import { MemoryBackend } from "../lib/clip/testing/memoryBackend";
import { assetFinalName, dedupeAssetName } from "./assetPaths";
import { createNodeFsBackend } from "./nodeFsBackend";
import {
  applyAssetMigration,
  buildAssetMigrationPlan,
  extractLocalReferences,
  findLegacyAssetDirs,
  isAssetsDirName,
  isHistoryPath,
  isLegacyAssetsDir,
  listNotePaths,
  removeIfEmpty,
  renderAssetRef,
  rewriteAssetRefsIn,
  workspacePathOfRef,
} from "./migrateAssets";

/**
 * 旧附件迁移器的纯逻辑测试（`docs/asset-lifecycle-and-migration.md` §3.1 的 A→D）。
 *
 * 判据盯的都是**用户看得见的事实**：磁盘上最终多了哪个文件、正文里的引用改成了什么、
 * 再跑一次还会不会动东西。三条硬性质各有一组用例：
 * ① 按字节去重（含「同名不同内容」的真实反例）；② 覆盖全部既有引用写法；
 * ③ 幂等（连跑两次第二次 0 改动）+ `.opennote/history/` 一个字节都不碰。
 *
 * ⚠️ 前四组用的是 `MemoryBackend`（`src/lib/clip/testing/memoryBackend`），它是**宽松夹具**：
 * 它的 `remove()` 连**空目录**也能删掉，而真实 node 后端在 D1 之前对目录一律抛
 * `ERR_FS_EISDIR`（空目录也一样，异常还被 `removeIfEmpty` 静默吞掉）。所以「内存后端全绿」
 * 不能代表真实可用 —— 目录回收这条路径由最后一组**真实** `createNodeFsBackend` +
 * `os.tmpdir()` 用例负责。后人加用例时，凡是碰到「后端语义」的判据都请放那一组。
 */

const PNG_A = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const PNG_B = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]);
const PNG_C = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 5, 6, 7, 8]);

const NOTE_A = [
  "# a",
  "",
  "![1](./a.assets/b.png)", // 与公共 `assets/a.png` 内容相同 → 同一个最终名
  "![2](<./a 2.assets/c.png>)", // 角括号 + 空格名
  "![3](assets/e.png)", // 死引用：文件本来就不在
  "![4](./img/没有这张图.png)", // 死引用
  '<img src="./a 2.assets/d.png" alt="d">', // 内联 HTML
  "![远程](https://img.example/x.png)",
  "",
].join("\n");

/** 一个最小但形状真实的旧布局：公共 `assets/`（含子目录）、`<笔记名>.assets/`、回收站、历史快照。 */
function seedWorkspace(store: MemoryBackend): void {
  store.seedBytes("assets/a.png", PNG_A);
  store.seedBytes("assets/进程相关/process.png", PNG_B);
  store.seedBytes("子/a.assets/b.png", PNG_A); // 与 `assets/a.png` **内容相同**
  store.seedBytes("子/a 2.assets/c.png", PNG_C);
  store.seedBytes("子/a 2.assets/d.png", PNG_B);
  store.seedBytes(".opennote/trash/无标题.assets/x.png", PNG_C);
  store.seed(".opennote/trash/无标题.md", "# 无标题\n\n![x](./无标题.assets/x.png)\n");
  store.seed(".opennote/history/子/a.md/2026-01-01 00-00.md", "![x](./a.assets/b.png)\n");
  store.seed("子/a.md", NOTE_A);
  store.seed("根.md", "# 根\n\n![公共](assets/a.png)\n");
}

describe("旧附件目录的识别（与 library.ts 的名单同一份）", () => {
  it("公共 `assets/` 与 `<笔记名>.assets/` 都算，共享 `.assets/` 不算", () => {
    expect(isAssetsDirName("assets")).toBe(true);
    expect(isAssetsDirName("无标题.assets")).toBe(true);
    expect(isAssetsDirName(".assets")).toBe(true);
    expect(isAssetsDirName("assets-old")).toBe(false);

    expect(isLegacyAssetsDir("操作系统/assets")).toBe(true);
    expect(isLegacyAssetsDir("项目实战/system_panel/无标题.assets")).toBe(true);
    expect(isLegacyAssetsDir(".assets")).toBe(false);
    expect(isLegacyAssetsDir("操作系统")).toBe(false);
  });

  it("`.opennote/history/` 明确排除：历史快照一个字节都不改", () => {
    expect(isHistoryPath(".opennote/history")).toBe(true);
    expect(isHistoryPath(".opennote/history/子/a.md/2026-01-01 00-00.md")).toBe(true);
    expect(isHistoryPath(".opennote/trash/无标题.md")).toBe(false);
  });
});

describe("阶段 A：扫描建映射（只读）", () => {
  let store: MemoryBackend;

  beforeEach(() => {
    store = new MemoryBackend();
    seedWorkspace(store);
  });

  it("扫到全部旧布局目录（含回收站），跳过共享 `.assets/` 与历史快照", async () => {
    expect(await findLegacyAssetDirs(store)).toEqual([
      ".opennote/trash/无标题.assets",
      "assets",
      "子/a 2.assets",
      "子/a.assets",
    ]);
  });

  it("旧附件目录里的**子目录**也算附件（真实数据：`assets/操作系统概念/image.png`）", async () => {
    const plan = await buildAssetMigrationPlan(store);
    expect(plan.files.map((file) => file.source)).toContain("assets/进程相关/process.png");
  });

  it("笔记清单含回收站笔记，**不含**历史快照", async () => {
    expect(await listNotePaths(store)).toEqual([".opennote/trash/无标题.md", "子/a.md", "根.md"]);
  });

  it("按**字节**去重：内容相同的两份文件共用一个最终名，省下的文件数如实报出", async () => {
    const plan = await buildAssetMigrationPlan(store);
    expect(plan.totalFiles).toBe(6);
    expect(plan.contentGroups).toBe(3);
    expect(plan.duplicateGroups).toBe(3);
    expect(plan.dedupedSavings).toBe(3);

    const a = plan.files.find((file) => file.source === "assets/a.png");
    const b = plan.files.find((file) => file.source === "子/a.assets/b.png");
    expect(a?.target).toBe(b?.target);
    expect(a?.hash).toBe(b?.hash);
  });

  it("真实反例：同名（`image.png` / `image 2.png`）不同内容 → 两个文件、两个目标，绝不互相覆盖", async () => {
    store.seedBytes("回收/无标题.assets/image.png", PNG_A);
    store.seedBytes("回收/无标题.assets/image 2.png", PNG_B);
    const plan = await buildAssetMigrationPlan(store);

    const first = plan.files.find((file) => file.source === "回收/无标题.assets/image.png");
    const second = plan.files.find((file) => file.source === "回收/无标题.assets/image 2.png");
    expect(first?.target).not.toBe(second?.target);
    expect(first?.hash).not.toBe(second?.hash);
  });

  it("**同名不同内容**会被单独报出来（按文件名去重的直接证据）", async () => {
    store.seedBytes("甲.assets/图.png", PNG_A);
    store.seedBytes("乙.assets/图.png", PNG_B);
    const plan = await buildAssetMigrationPlan(store);
    const entry = plan.sameNameDifferentBytes.find((item) => item.name === "图.png");
    expect(entry?.sources).toEqual(["乙.assets/图.png", "甲.assets/图.png"]);
  });

  it("最终名 = 内容派生的 uuid + 扩展名（复用 `assetFinalName`，不另抄公式）", async () => {
    const plan = await buildAssetMigrationPlan(store);
    expect(plan.files.find((file) => file.source === "assets/a.png")?.target).toBe(
      `.assets/${await assetFinalName(PNG_A, "a.png")}`,
    );
  });

  it("目标已存在且字节相同 → 复用（不复制、不覆盖）", async () => {
    const existing = await assetFinalName(PNG_A, "a.png");
    store.seedBytes(`.assets/${existing}`, PNG_A);
    const plan = await buildAssetMigrationPlan(store);
    // 按**最终文件**计数：`assets/a.png` 与 `子/a.assets/b.png` 同内容，共用这一个目标。
    expect(plan.reusedExisting).toBe(1);
    expect(plan.files.find((file) => file.source === "assets/a.png")?.reused).toBe(true);
    expect(plan.files.find((file) => file.source === "子/a.assets/b.png")?.reused).toBe(true);
  });

  it("目标已存在但字节不同 → 让位成 `-2`（绝不静默覆盖别人的图）", async () => {
    const existing = await assetFinalName(PNG_A, "a.png");
    store.seedBytes(`.assets/${existing}`, PNG_B);
    const plan = await buildAssetMigrationPlan(store);
    const target = plan.files.find((file) => file.source === "assets/a.png")?.target;
    expect(target).toBe(dedupeAssetName(`.assets/${existing}`, 2));
    expect(plan.dedupedTargets).toBe(1);
  });

  it("dry-run 只读：一个字节都不写（后端调用轨迹里没有 write/remove/mkdir）", async () => {
    const before = store.calls.length;
    const plan = await buildAssetMigrationPlan(store);
    await applyAssetMigration(store, plan); // 不带 apply = 只校验
    const calls = store.calls.slice(before);
    expect(calls.some((call) => call.startsWith("write") || call.startsWith("remove") || call.startsWith("mkdir"))).toBe(
      false,
    );
  });
});

describe("引用解析与改写（阶段 C 的射程）", () => {
  it("认得全部既有写法：裸写法、`./`、角括号（含空格名）、带笔记子目录的公共 `assets/`", () => {
    const content = [
      "![1](./foo.assets/a.png)",
      "![2](<./foo 2.assets/b.png>)",
      "![3](foo.assets/a.png)",
      "![4](assets/a.png)",
      "![5](assets/操作系统概念/image.png)",
      "![6](<QwenLM ….assets/63e80eb9-…>)",
    ].join("\n");
    const refs = extractLocalReferences(content);
    expect(refs.map((ref) => ref.ref)).toEqual([
      "./foo.assets/a.png",
      "./foo 2.assets/b.png",
      "foo.assets/a.png",
      "assets/a.png",
      "assets/操作系统概念/image.png",
      "QwenLM ….assets/63e80eb9-…",
    ]);
    expect(refs.map((ref) => ref.bracketed)).toEqual([false, true, false, false, false, true]);
  });

  it("远程 / data: / blob: / 锚点不是本地文件，一个都不收", () => {
    const content = [
      "![a](https://img.example/a.png)",
      "![b](data:image/png;base64,AAAA)",
      "![c](blob:opennote/abc)",
      "![d](asset://legacy-id)",
      "[e](#anchor)",
    ].join("\n");
    expect(extractLocalReferences(content)).toEqual([]);
  });

  it("`<img src=\"…\">` 也认，其余属性一字不动", () => {
    const refs = extractLocalReferences('<img src="./foo.assets/a.png" alt="图" width="100">');
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("html");
    expect(refs[0].ref).toBe("./foo.assets/a.png");
  });

  it("角括号形态保留角括号；裸写法（新路径不需要转义）也保持裸写法", () => {
    expect(renderAssetRef("../.assets/x.png", false)).toBe("../.assets/x.png");
    expect(renderAssetRef("../.assets/x 2.png", false)).toBe("<../.assets/x 2.png>");
    expect(renderAssetRef("../.assets/x.png", true)).toBe("<../.assets/x.png>");
  });

  it("引用 → 工作区路径：`..` 在目录语义下被吃掉（回收站笔记深两层）", () => {
    expect(workspacePathOfRef("../../.assets/x.png", "操作系统/产品/a.md")).toBe(".assets/x.png");
    expect(workspacePathOfRef("./无标题.assets/x.png", ".opennote/trash/无标题.md")).toBe(
      ".opennote/trash/无标题.assets/x.png",
    );
    expect(workspacePathOfRef("assets/a.png", "子/a.md")).toBe("子/assets/a.png");
  });

  it("表里查不到的一律原样保留（死引用 + 新布局引用都不许被猜）", async () => {
    const map = new Map([["子/a.assets/b.png", ".assets/AAA.png"]]);
    const content = ["![改](./a.assets/b.png)", "![新](.assets/已存在.png)", "![死](./img/x.png)"].join("\n");
    const result = await rewriteAssetRefsIn(content, "子/a.md", map, (path) => Promise.resolve(path.includes("已存在")));
    expect(result.after).toContain("![改](../.assets/AAA.png)");
    expect(result.after).toContain("![新](.assets/已存在.png)");
    expect(result.after).toContain("![死](./img/x.png)");
    // C1：只有 `./img/x.png` 算死引用（磁盘上没有）；`.assets/已存在.png` 不在清单但文件在，不计死。
    expect(result.issues.filter((issue) => issue.kind === "dead").map((issue) => issue.ref)).toEqual(["./img/x.png"]);
  });
});

describe("死引用判定：先问磁盘再计数（C1 回修）", () => {
  it("(a) 解析目标真实存在的引用不计入死引用，且正文一字不动", async () => {
    const store = new MemoryBackend();
    const content = ["![图](.assets/alive.png)", "", "[下一篇](./b.md)", ""].join("\n");
    store.seed("a.md", content); // 根目录笔记：`.assets/…` 与 `./b.md` 都解析到真实存在的文件（t13 误报的真实形态）
    store.seedBytes(".assets/alive.png", PNG_A);
    store.seed("b.md", "# b\n");
    const plan = await buildAssetMigrationPlan(store);
    expect(plan.issues.filter((issue) => issue.kind === "dead")).toEqual([]);
    expect(plan.deadReferences).toBe(0);
    expect(plan.notePlans).toHaveLength(0); // 没有改写计划 ⇒ 行为零变化：引用只是「与迁移无关」
    expect(store.text("a.md")).toBe(content);
  });

  it("(b) 目标真不存在的引用仍计入死引用，且原样保留", async () => {
    const store = new MemoryBackend();
    const content = "![死](./img/没有这张图.png)\n";
    store.seed("子/a.md", content);
    const plan = await buildAssetMigrationPlan(store);
    const dead = plan.issues.filter((issue) => issue.kind === "dead");
    expect(dead).toHaveLength(1);
    expect(dead[0].ref).toBe("./img/没有这张图.png");
    expect(dead[0].note).toBe("子/a.md");
    expect(dead[0].reason).toContain("但那里没有文件");
    expect(plan.deadReferences).toBe(1);
    expect(store.text("子/a.md")).toBe(content);
  });

  it("(c) 后端拒答的路径（如 `E:\\…` 绝对路径，永不可能落在工作区里）仍计死引用，且不炸扫描", async () => {
    const content = String.raw`![外部](E:\杂记\images\x.png)` + "\n";
    const result = await rewriteAssetRefsIn(content, "a.md", new Map(), async (path) => {
      if (path.includes(":")) throw new Error("路径不能包含冒号"); // 复刻 nodeFsBackend.assertSafeRelative
      return true;
    });
    expect(result.after).toBe(content); // 原样保留：死引用本来就死，绝不猜
    expect(result.issues.map((issue) => issue.kind)).toEqual(["dead"]);
    expect(result.issues[0].reason).toContain("但那里没有文件");
  });
});

describe("阶段 B→D：复制、改写、删源（整条流水线）", () => {
  let store: MemoryBackend;

  beforeEach(() => {
    store = new MemoryBackend();
    seedWorkspace(store);
  });

  it("复制 → 逐字节校验 → 改写引用 → 删源 → 收空目录，一条不漏", async () => {
    const plan = await buildAssetMigrationPlan(store);
    const result = await applyAssetMigration(store, plan, { apply: true });

    // 阶段 B：无校验失败；6 个源文件里 3 个真的写下去，另外 3 个命中了同内容的目标（复用）。
    expect(result.failedCopies).toEqual([]);
    expect(result.copied).toBe(3);
    expect(result.reused).toBe(3);
    expect(result.deletedSources).toBe(6);

    // 最终布局：共享 `.assets/` 里 3 个文件（6 份内容合成 3 份）。
    expect(store.paths().filter((path) => path.startsWith(".assets/"))).toHaveLength(3);

    // 阶段 D：旧目录全空 → 收掉；工作区根的空 `assets/` 例外（应用每次开工作区都会重建）。
    expect(result.removedDirs).toContain("子/a.assets");
    expect(result.removedDirs).toContain("子/a 2.assets");
    expect(result.removedDirs).toContain("assets/进程相关");
    expect(result.removedDirs).toContain(".opennote/trash/无标题.assets");
    expect(result.keptDirs).toContain("assets");
    expect(store.files.has("assets/a.png")).toBe(false);
    expect(store.dirs.has("子/a.assets")).toBe(false);
  });

  it("改写后的每一条引用都能用 `resolveWorkspacePath` 反解回最终文件，且那个文件真的在", async () => {
    const plan = await buildAssetMigrationPlan(store);
    const dead = new Set(plan.issues.filter((issue) => issue.kind === "dead").map((issue) => issue.ref));
    await applyAssetMigration(store, plan, { apply: true });

    for (const note of ["子/a.md", "根.md", ".opennote/trash/无标题.md"]) {
      const content = store.text(note) ?? "";
      for (const reference of extractLocalReferences(content)) {
        if (dead.has(reference.ref)) continue; // 死引用原样保留：本来就指空
        const resolved = resolveWorkspacePath(reference.ref, parentPath(note));
        expect(resolved, `${note} 里的 ${reference.ref} 解析不出来`).toBeTruthy();
        expect(store.files.has(resolved as string), `${note} → ${resolved} 上没有文件`).toBe(true);
      }
    }
    expect(store.text("子/a.md")).toContain("![1](../.assets/");
    expect(store.text("子/a.md")).toContain('<img src="../.assets/');
    expect(store.text("根.md")).toContain("![公共](.assets/");
    expect(store.text(".opennote/trash/无标题.md")).toContain("../.assets/");
  });

  it("死引用与远程地址原样保留 + 记入报告，绝不猜一个近似的文件名", async () => {
    const plan = await buildAssetMigrationPlan(store);
    const dead = plan.issues.filter((issue) => issue.kind === "dead").map((issue) => issue.ref).sort();
    expect(dead).toEqual(["./img/没有这张图.png", "assets/e.png"]);

    await applyAssetMigration(store, plan, { apply: true });
    expect(store.text("子/a.md")).toContain("![3](assets/e.png)");
    expect(store.text("子/a.md")).toContain("![4](./img/没有这张图.png)");
    expect(store.text("子/a.md")).toContain("![远程](https://img.example/x.png)");
  });

  it("`.opennote/history/` 一个字节都不动（不扫、不改、不删）", async () => {
    const before = store.text(".opennote/history/子/a.md/2026-01-01 00-00.md");
    const plan = await buildAssetMigrationPlan(store);
    await applyAssetMigration(store, plan, { apply: true });
    expect(store.text(".opennote/history/子/a.md/2026-01-01 00-00.md")).toBe(before);
    expect(plan.scannedDirs.some((dir) => dir.startsWith(".opennote/history"))).toBe(false);
    expect(store.files.has(".opennote/history/子/a.md/2026-01-01 00-00.md")).toBe(true);
  });

  it("幂等：连跑两次，第二次 0 处改动", async () => {
    const first = await buildAssetMigrationPlan(store);
    const firstResult = await applyAssetMigration(store, first, { apply: true });
    expect(firstResult.copied).toBe(3);

    const second = await buildAssetMigrationPlan(store);
    const secondResult = await applyAssetMigration(store, second, { apply: true });
    expect(second.totalFiles).toBe(0);
    expect(second.referencesToRewrite).toBe(0);
    expect(secondResult.copied).toBe(0);
    expect(secondResult.rewrittenNotes).toBe(0);
    expect(secondResult.deletedSources).toBe(0);
    expect(secondResult.removedDirs).toEqual([]);
  });

  it("并发改动：正文与阶段 A 读到的不一致 → 跳过该篇并报告，绝不覆盖用户的新内容", async () => {
    const plan = await buildAssetMigrationPlan(store);
    store.seed("子/a.md", "# a\n\n用户刚敲的新内容\n");
    const result = await applyAssetMigration(store, plan, { apply: true });
    expect(result.conflictedNotes).toContain("子/a.md");
    expect(store.text("子/a.md")).toContain("用户刚敲的新内容");
  });

  it("无引用文件如实报出（不算死引用，也不删别人的图）", async () => {
    const plan = await buildAssetMigrationPlan(store);
    // `assets/进程相关/process.png` 没有任何笔记引用（`根.md` 只引用 `assets/a.png`）。
    expect(plan.unreferencedFiles).toBe(1);
    expect(plan.referencedSources).toContain("assets/a.png");
  });
});

/* ---------------------------------------------------------------------------
 * 真实 node 后端（`createNodeFsBackend` + os.tmpdir()）
 *
 * 为什么单开一组：上面那一组用的是 `src/lib/clip/testing/memoryBackend` 的 `MemoryBackend`，
 * 它的 `remove()` 把**空目录也能删掉**（先看 `files.delete(path)`，再 `dirs.has(path)` 就
 * `dirs.delete`）。而真实的 node 后端在 D1 之前走的是 `fs.rm(dir, { recursive: false })`，
 * 它在 Node 22 / win32 上对**目录一律抛 `ERR_FS_EISDIR`**（空目录也一样），异常又被
 * `removeIfEmpty` 的 `.catch(() => undefined)` 吞掉 —— 于是「内存后端全绿、真实后端一个
 * 空目录都收不掉」。**夹具比真实后端宽松造成的假绿**，必须用真后端堵住。
 * ------------------------------------------------------------------------ */

describe("真实 node 后端：remove 只删空目录（D1 回归）", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "opennote-nodefs-"));
  });

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  /** 在临时工作区里造一个目录树（父目录逐级创建）。 */
  async function seedDir(relPath: string, file?: { name: string; text: string }): Promise<void> {
    await mkdir(path.join(root, relPath), { recursive: true });
    if (file) await writeFile(path.join(root, relPath, file.name), file.text, "utf8");
  }

  it("空目录删得掉；非空目录抛 ENOTEMPTY 且原样留在磁盘上（安全边界）", async () => {
    const backend = createNodeFsBackend(root);
    await seedDir("空壳.assets");
    await seedDir("有图.assets", { name: "a.png", text: "pixels" });
    const full = path.join(root, "有图.assets");

    // ① 空目录：rmdir 成功（D1 之前这里是 ERR_FS_EISDIR，被静默吞掉）。
    await backend.remove("空壳.assets");
    expect(await backend.exists("空壳.assets")).toBe(false);

    // ② 非空目录：**必须**失败，而且不得被递归删掉。
    await expect(backend.remove("有图.assets")).rejects.toMatchObject({ code: "ENOTEMPTY" });
    expect(await backend.exists("有图.assets")).toBe(true);
    expect(await readdir(full)).toEqual(["a.png"]);
  });

  it("recursive: true 时保持 rm 行为（真要递归删时才走这支）", async () => {
    const backend = createNodeFsBackend(root);
    await seedDir("有图.assets", { name: "a.png", text: "pixels" });

    await backend.remove("有图.assets", { recursive: true });

    expect(await backend.exists("有图.assets")).toBe(false);
  });

  it("同一个 remove() 也要能删**文件**（阶段 D 删迁移过的源附件走的就是这一支）", async () => {
    const backend = createNodeFsBackend(root);
    await seedDir("子/a.assets", { name: "c.png", text: "pixels" });

    await backend.remove("子/a.assets/c.png");

    expect(await backend.exists("子/a.assets/c.png")).toBe(false);
    // 文件删掉之后，同一个目录就变成「可以收的空目录」。
    expect(await removeIfEmpty(backend, "子/a.assets")).toBe(true);
    expect(await backend.exists("子/a.assets")).toBe(false);
  });

  it("removeIfEmpty 对真实后端返回 true，目录真的从磁盘上消失", async () => {
    const backend = createNodeFsBackend(root);
    await seedDir("空壳.assets");
    await seedDir("有图.assets", { name: "a.png", text: "pixels" });

    expect(await removeIfEmpty(backend, "空壳.assets")).toBe(true);
    expect(await backend.exists("空壳.assets")).toBe(false);
    // 非空目录：判据先拦住（list() 非空），根本不去调 remove。
    expect(await removeIfEmpty(backend, "有图.assets")).toBe(false);
    expect(await backend.exists("有图.assets")).toBe(true);
  });

  it("迁移器在真实后端上把空目录收掉，且第二次跑 0 改动（--apply 的等价路径）", async () => {
    await seedDir("assets/子", { name: "b.png", text: "pixels" });
    await seedDir("子/a.assets", { name: "c.png", text: "other-pixels" });
    await seedDir(".opennote/history/子/a.md");
    await writeFile(path.join(root, "子", "a.md"), "# a\n\n![1](assets/子/b.png)\n", "utf8");
    await writeFile(path.join(root, ".opennote", "history", "子", "a.md", "2026.md"), "![x](assets/子/b.png)\n", "utf8");

    const backend = createNodeFsBackend(root);
    const first = await buildAssetMigrationPlan(backend);
    const firstResult = await applyAssetMigration(backend, first, { apply: true });

    // 「删除空目录」计数 > 0 —— 这正是 D1 之前恒为 0 的那个读数。
    expect(firstResult.removedDirs.length).toBeGreaterThan(0);
    expect(firstResult.removedDirs).toContain("子/a.assets");
    expect(firstResult.removedDirs).toContain("assets/子");
    expect(await backend.exists("子/a.assets")).toBe(false);
    expect(await backend.exists("assets/子")).toBe(false);
    // 工作区根的空 `assets/` 例外：应用每次开工作区都会重建它，留着不算脏。
    expect(await backend.exists("assets")).toBe(true);
    // 历史快照一个字节都不动。
    expect(await backend.exists(".opennote/history/子/a.md/2026.md")).toBe(true);

    const second = await buildAssetMigrationPlan(backend);
    const secondResult = await applyAssetMigration(backend, second, { apply: true });
    expect(second.totalFiles).toBe(0);
    expect(second.referencesToRewrite).toBe(0);
    expect(secondResult.copied).toBe(0);
    expect(secondResult.deletedSources).toBe(0);
    expect(secondResult.removedDirs).toEqual([]);
  });
});
