/**
 * 冲突账本与「只报不猜」（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §6.1 L2、§6.2、红线 5）。
 *
 * 这里钉住的核心是一条**语义切换**，不是一个开关的默认值：
 *
 * | 处境 | 磁盘出现我们不知道的版本（本地还有未落盘的改动） | 期望 |
 * | --- | --- | --- |
 * | **没开同步** | 磁盘就是权威（本地编辑器 / git pull / 网盘） | 磁盘赢（D3）：进前像、采纳磁盘、**不进冲突账本** |
 * | **开着同步** | 磁盘上那一版可能来自远端 ⇒ 两边都改了 | **只报不猜**：进冲突账本 + 前像，用户看得见 |
 *
 * 第二条断言第一次让「绝不静默覆盖」变成**可验证**的行为：没有账本，用户就永远不知道
 * 自己那一版曾经被搁置过。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRecord } from "./workspaces";
import { createHarness, drainTimers, expectNoConflictArtifacts, settleUntil } from "./libraryTestHarness";

const harness = createHarness();
const { backends, records } = harness;

vi.mock("./workspaces", () => ({
  activeWorkspaceRecord: () => null,
  resolveBackend: async (record: WorkspaceRecord) => backends.get(record.id),
  setActiveWorkspace: () => undefined,
}));

import { closeWorkspace, flushAll, getLibrary, openWorkspace, updateNoteContent } from "./library";
import { clearConflicts, conflictCount, getConflict, listConflicts, recordConflict, resolveConflict } from "../sync/conflicts";
import { resetSyncActiveForTests, setSyncActive } from "../sync/mode";
import { patchUi } from "./ui";

beforeEach(async () => {
  harness.reset();
  clearConflicts();
  resetSyncActiveForTests();
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  patchUi({ autoSave: "afterDelay", autoSaveDelay: 450 });
  await closeWorkspace().catch(() => undefined);
});

afterEach(() => {
  resetSyncActiveForTests();
});

describe("没开同步 ⇒ 行为与今天逐字节相同（磁盘赢 D3）", () => {
  it("dirty 笔记被外部改动：采纳磁盘、留前像、**不进冲突账本**", async () => {
    /*
     * ⚠️ 这条用例**刻意不走 watcher**（`bridge.emit` + 重扫），而是直接压
     * `flushAll()` → `flushNote()` —— 也就是「发现磁盘变了 → 读盘 → 判定」那条**真**路径。
     *
     * 为什么改写：原来的写法是「`backend.seed()` 然后 `emit()`」，但链路上有**两个各自的
     * 去抖** —— 自动保存 450ms、watcher 重扫 500ms。于是「外部写入在 emit 之前就摆好」
     * 落进一个竞态：谁先跑决定了笔记那一刻是 dirty 还是 clean，
     * 同一段代码在整套跑时会偶发走另一条分支（实测 1/5 概率红）。
     * 靠调 `advanceTimersByTime` 的数值去凑是治不好的 —— 机器一忙就变。
     *
     * 现在：`autoSave` 设成 `onFocusChange`（**不排**自动保存定时器），
     * 且**不** `emit`，所以没有任何东西在跟我们抢时序；落盘只由这一句显式 `flushAll()` 触发。
     */
    const backend = harness.scenario("A", (b) => b.seed("a.md", "# 磁盘旧内容"));
    await openWorkspace(records.get("A")!, { silent: true });
    patchUi({ autoSave: "onFocusChange" });

    updateNoteContent("a.md", "# 我没保存的编辑");
    // 外部写入：刻意换个**长度不同**的内容 ⇒ stat 的 size 变 ⇒ `flushNote` 一定会去读盘。
    backend.seed("a.md", "# 外部新版本");

    await flushAll();

    expect(getLibrary().notes["a.md"]?.content).toBe("# 外部新版本");
    // 本地那一版仍然留得住（隐藏前像），只是这一次**不需要用户裁决**。
    const preimages = backend.paths().filter((path) => path.includes("-before-disk"));
    expect(preimages).toHaveLength(1);
    expect(backend.text(preimages[0])).toBe("# 我没保存的编辑");
    expect(conflictCount()).toBe(0);
    expectNoConflictArtifacts(backend);
  });
});

describe("开着同步 ⇒ 只报不猜（红线 5）", () => {
  it("dirty 笔记被外部改动：进冲突账本，两边的标识都在，并说明是哪一种冲突", async () => {
    setSyncActive(true);
    const backend = harness.scenario("A", (b) => b.seed("a.md", "# 磁盘旧内容"));
    await openWorkspace(records.get("A")!, { silent: true });
    // 同上：不走 watcher、不排自动保存定时器（见上一条用例的说明）。
    patchUi({ autoSave: "onFocusChange" });

    updateNoteContent("a.md", "# 我没保存的编辑");
    backend.seed("a.md", "# 远端新版本");
    await flushAll();

    const conflicts = listConflicts();
    expect(conflicts).toHaveLength(1);
    const entry = conflicts[0]!;
    expect(entry.path).toBe("a.md");
    expect(entry.kind).toBe("both-modified");
    // 两边各自的标识必须**都在**，否则 UI 说不清「哪两份不一样」。
    expect(entry.localId).toBeTruthy();
    expect(entry.remoteId).toBeTruthy();
    expect(entry.localId).not.toBe(entry.remoteId);
    expect(entry.detectedAt).toBeGreaterThan(0);

    // 本地那一版依然进了隐藏前像 —— 「列出」不等于「丢掉」。
    const preimages = backend.paths().filter((path) => path.includes("-before-disk"));
    expect(preimages).toHaveLength(1);
    expect(backend.text(preimages[0])).toBe("# 我没保存的编辑");
    // 也绝不能凭空造 `.conflict-*.md`（那是 0.9.x 的旧病）。
    expectNoConflictArtifacts(backend);
  });

  it("干净笔记被外部改动：本地没有改动可争 ⇒ 不是冲突", async () => {
    setSyncActive(true);
    const bridge = harness.installBridge();
    const backend = harness.scenario("A", (b) => b.seed("a.md", "# 旧版本"));
    await openWorkspace(records.get("A")!, { silent: true });

    backend.seed("a.md", "# 远端新版本");
    bridge.emit(harness.rootOf("A"));
    await settleUntil(() => getLibrary().notes["a.md"]?.content === "# 远端新版本");

    expect(getLibrary().notes["a.md"]?.content).toBe("# 远端新版本");
    expect(conflictCount()).toBe(0);
  });

  it("两边都改但**内容相同** ⇒ 判为已同步，不算冲突（false conflict）", async () => {
    setSyncActive(true);
    const bridge = harness.installBridge();
    const backend = harness.scenario("A", (b) => b.seed("a.md", "# 起点"));
    await openWorkspace(records.get("A")!, { silent: true });

    /*
     * 本地敲成 A，远端也恰好是 A。
     *
     * ⚠️ 远端那一份**必须逐字节等价于本地那一版**：`updateNoteContent` 会把入库的正文做
     * EOL 归一（`normalizeEol`），所以 `"# 撞车了\r\n"` 归一后是 `"# 撞车了\n"`，
     * 与 `"# 撞车了"` **不是**同一份内容 —— 那是真的不同（多了一个换行），该报冲突。
     * 这一条踩过一次：早先的用例把「行尾不同」误当成 false conflict，断言写错了方向。
     */
    updateNoteContent("a.md", "# 撞车了");
    backend.seed("a.md", "# 撞车了");
    bridge.emit(harness.rootOf("A"));
    await settleUntil(() => getLibrary().notes["a.md"]?.content === "# 撞车了");

    expect(conflictCount()).toBe(0);
    expect(getLibrary().notes["a.md"]?.content).toBe("# 撞车了");
  });

  it("行尾形态不同**但归一后不同** ⇒ 仍然是冲突（别把 false conflict 放宽成「差不多就算」）", async () => {
    /*
     * ⚠️ 这条用例**刻意不走 watcher**（`bridge.emit` + 重扫）。
     *
     * 它原来的写法是「先 emit 再等重扫」，但那条链路上有两个各自的去抖
     * （自动保存 450ms、watcher 重扫 500ms），而**外部写入与本地编辑谁先被处理**
     * 取决于推进节奏：一旦自动保存先落盘、笔记变干净，重扫读到的是**我们自己刚写的**
     * 内容 —— 于是根本不产生冲突。那条用例因此 1/5 概率红（只在整套跑时现形）。
     *
     * 现在直接压**真正的判定入口**：`flushNote` 发现磁盘 stat 变了 → 读盘 →
     * `reconcileExternalChange`。这条路径没有去抖、没有竞态，测的就是判定本身。
     */
    setSyncActive(true);
    const backend = harness.scenario("A", (b) => b.seed("a.md", "# 起点"));
    await openWorkspace(records.get("A")!, { silent: true });
    // 不排自动保存定时器（`onFocusChange` 档），落盘只由我们显式 flush 触发。
    patchUi({ autoSave: "onFocusChange" });

    updateNoteContent("a.md", "# 撞车了");
    // 外部写入**比本地那一版长 2 字节**（CRLF）：stat 一定变，`flushNote` 会去读盘。
    backend.seed("a.md", "# 撞车了\r\n");

    await flushAll();

    const conflicts = listConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.path).toBe("a.md");
    expect(conflicts[0]!.kind).toBe("both-modified");
    // 两边标识都在，且**不相等** —— 这是「归一后确实不同」的直接证据。
    expect(conflicts[0]!.localId).toBeTruthy();
    expect(conflicts[0]!.remoteId).toBeTruthy();
    expect(conflicts[0]!.localId).not.toBe(conflicts[0]!.remoteId);
  });

  it("关掉同步之后，同一场景不再进账本（开关是判定的一部分，不是全局副作用）", async () => {
    /*
     * ⚠️ 与上面两条一样：**不走 watcher**，直接压 `flushAll()` → `flushNote()` → 判定。
     *
     * 这条第一版写的是「`backend.seed()` + `emit()` + `settleUntil(conflictCount() > 0)`」，
     * 于是在整套跑时约 1/6 概率红在 `expect(conflictCount()).toBe(1)` ——
     * `settleUntil` 等不到就超时返回，而它返回的布尔值被忽略了，断言接着读到 0。
     *
     * 根因和那两条一样：自动保存（450ms）与 watcher 重扫（500ms）**各有各的去抖**，
     * 谁先跑决定了笔记那一刻是 dirty 还是 clean。「等一等」治不好它；
     * 只有「把要测的那一步显式调出来」才行。
     */
    setSyncActive(true);
    const backend = harness.scenario("A", (b) => b.seed("a.md", "# 起点"));
    await openWorkspace(records.get("A")!, { silent: true });
    patchUi({ autoSave: "onFocusChange" });

    // ① 开着同步：两侧都改 ⇒ 进账本。
    updateNoteContent("a.md", "# 本地改的");
    backend.seed("a.md", "# 远端改的");
    await flushAll();
    expect(conflictCount()).toBe(1);

    // ② 关掉同步，同一场景再来一次 ⇒ 只有磁盘赢，**不进账本**。
    setSyncActive(false);
    resolveConflict("a.md");
    expect(conflictCount()).toBe(0);
    updateNoteContent("a.md", "# 又一次本地改动");
    backend.seed("a.md", "# 又一次远端改动");
    await flushAll();
    expect(getLibrary().notes["a.md"]?.content).toBe("# 又一次远端改动");

    // 再排空调度队列：确认后面不会再冒出一条冲突。
    await drainTimers({ maxMs: 2000 });
    expect(conflictCount()).toBe(0);
  });
});

describe("账本自身的行为", () => {
  it("同一路径同一版本重复报告不重置「发现于」；版本变了才覆盖", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T00:00:00Z"));
    expect(recordConflict({ path: "a.md", kind: "both-modified", localId: "L1", remoteId: "R1" })).toBe(true);
    const first = getConflict("a.md")!.detectedAt;
    // 同一版本再来一次：不该改时间，也不该报告「变了」。
    vi.setSystemTime(new Date("2026-10-13T00:10:00Z"));
    expect(recordConflict({ path: "a.md", kind: "both-modified", localId: "L1", remoteId: "R1" })).toBe(false);
    expect(getConflict("a.md")!.detectedAt).toBe(first);
    // 版本变了（远端又改了一次）：覆盖，时间也跟着更新。
    expect(recordConflict({ path: "a.md", kind: "both-modified", localId: "L1", remoteId: "R2" })).toBe(true);
    expect(getConflict("a.md")!.remoteId).toBe("R2");
    expect(getConflict("a.md")!.detectedAt).toBeGreaterThan(first);
    vi.useRealTimers();
  });

  it("列表按路径稳定排序（UI 两次渲染顺序必须一致）", () => {
    recordConflict({ path: "z.md", kind: "both-modified", localId: "l", remoteId: "r" });
    recordConflict({ path: "a.md", kind: "both-modified", localId: "l", remoteId: "r" });
    recordConflict({ path: "m/n.md", kind: "both-modified", localId: "l", remoteId: "r" });
    expect(listConflicts().map((entry) => entry.path)).toEqual(["a.md", "m/n.md", "z.md"]);
  });

  it("裁决完就从账本里划掉", () => {
    recordConflict({ path: "a.md", kind: "both-modified", localId: "l", remoteId: "r" });
    expect(resolveConflict("a.md")).toBe(true);
    expect(resolveConflict("a.md")).toBe(false);
    expect(conflictCount()).toBe(0);
  });
});
