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
import { createHarness, expectNoConflictArtifacts, settleUntil } from "./libraryTestHarness";

const harness = createHarness();
const { backends, records } = harness;

vi.mock("./workspaces", () => ({
  activeWorkspaceRecord: () => null,
  resolveBackend: async (record: WorkspaceRecord) => backends.get(record.id),
  setActiveWorkspace: () => undefined,
}));

import { closeWorkspace, getLibrary, openWorkspace, updateNoteContent } from "./library";
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
    const bridge = harness.installBridge();
    const backend = harness.scenario("A", (b) => b.seed("a.md", "# 磁盘旧内容"));
    await openWorkspace(records.get("A")!, { silent: true });

    updateNoteContent("a.md", "# 我没保存的编辑");
    backend.seed("a.md", "# 外部新版本");
    bridge.emit(harness.rootOf("A"));
    await settleUntil(() => getLibrary().notes["a.md"]?.content === "# 外部新版本");

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
    const bridge = harness.installBridge();
    const backend = harness.scenario("A", (b) => b.seed("a.md", "# 磁盘旧内容"));
    await openWorkspace(records.get("A")!, { silent: true });

    updateNoteContent("a.md", "# 我没保存的编辑");
    backend.seed("a.md", "# 远端新版本");
    bridge.emit(harness.rootOf("A"));
    // 等到「采纳了远端 + 记了账本」两件事都完成 —— 账本是判定链的最后一跳。
    await settleUntil(() => conflictCount() > 0 && getLibrary().notes["a.md"]?.content === "# 远端新版本");

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
    setSyncActive(true);
    const bridge = harness.installBridge();
    const backend = harness.scenario("A", (b) => b.seed("a.md", "# 起点"));
    await openWorkspace(records.get("A")!, { silent: true });

    updateNoteContent("a.md", "# 撞车了");
    backend.seed("a.md", "# 撞车了\r\n");
    bridge.emit(harness.rootOf("A"));
    await settleUntil(() => conflictCount() > 0);

    const conflicts = listConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.path).toBe("a.md");
  });

  it("关掉同步之后，同一场景不再进账本（开关是判定的一部分，不是全局副作用）", async () => {
    // 先在开着同步时制造一条冲突。
    setSyncActive(true);
    const bridge = harness.installBridge();
    const backend = harness.scenario("A", (b) => b.seed("a.md", "# 起点"));
    await openWorkspace(records.get("A")!, { silent: true });
    updateNoteContent("a.md", "# 本地改的");
    backend.seed("a.md", "# 远端改的");
    bridge.emit(harness.rootOf("A"));
    await settleUntil(() => conflictCount() > 0);
    expect(conflictCount()).toBe(1);

    // 关掉同步，再制造一次外部改动：这一回应当只有磁盘赢。
    setSyncActive(false);
    resolveConflict("a.md");
    expect(conflictCount()).toBe(0);
    updateNoteContent("a.md", "# 又一次本地改动");
    backend.seed("a.md", "# 又一次远端改动");
    bridge.emit(harness.rootOf("A"));
    await settleUntil(() => getLibrary().notes["a.md"]?.content === "# 又一次远端改动");
    // 再空转几轮：确认后面不会再冒出一条冲突。
    await settleUntil(() => false, { steps: 4 });
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
