/**
 * 纯 diff 函数（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §6.2 判定表、§6.3、§6.4）。
 *
 * ## 这个文件测的是「新增的那部分」
 *
 * `planPush` / `planPull` 的**语义不变**由现有 GitHub 套件（`src/lib/github/sync.test.ts`）
 * 全绿来证明 —— 那是搬家前的原套件。这里补的是搬家后新加的三件东西：
 *
 * 1. **false conflict**（§6.2）：两边都改、内容标识相同 ⇒ 不算冲突。GitHub 那边因为
 *    远端是 blob SHA-1、本地是 sha256，这条分支不可达；同一个哈希空间里（`opennote`
 *    provider 的明文与 E2EE 两种模式）才真正生效。
 * 2. **删除保护阈值**（§6.3）：一次删太多要停下来问人。
 * 3. **`truncated` 时挂起全部删除**（§6.4 规则 1、C12）—— 这是**误删**的唯一闸门。
 */
import { describe, expect, it } from "vitest";
import { applyTruncationGuard, assertDeletionBudget, planPull, planPush, pushIsEmpty, type BaselineLike } from "./diff";

function baselineOf(files: BaselineLike["files"]): BaselineLike {
  return { files };
}

/** 同一个哈希空间里的标识（模拟 `opennote` provider 的 sha256 / ehash）。 */
function h(seed: string): string {
  return seed.padEnd(64, "0");
}

describe("§6.2 · false conflict（两边都改但内容相同）", () => {
  it("两边都改、标识相同 ⇒ **不算冲突**，也不进 download", () => {
    const plan = planPull(
      baselineOf({ "notes/a.md": { remoteHash: h("old"), localHash: h("base"), imported: true } }),
      { entries: [{ path: "notes/a.md", hash: h("same") }] },
      [{ path: "notes/a.md", hash: h("same"), bytes: 10 }],
    );
    expect(plan.conflicts).toEqual([]);
    expect(plan.download).toEqual([]);
    expect(plan.removeLocal).toEqual([]);
  });

  it("两边都改、标识不同 ⇒ 仍然列出冲突（别把上面那条放宽成「都改就放过」）", () => {
    const plan = planPull(
      baselineOf({ "notes/a.md": { remoteHash: h("old"), localHash: h("base"), imported: true } }),
      { entries: [{ path: "notes/a.md", hash: h("remote") }] },
      [{ path: "notes/a.md", hash: h("local"), bytes: 10 }],
    );
    expect(plan.conflicts).toEqual([{ path: "notes/a.md", reason: "both-modified" }]);
    expect(plan.download).toEqual([]);
  });

  it("只有一边改 ⇒ 照旧下载/上传，false-conflict 分支不参与", () => {
    // 远端改了、本地没动 → 下载
    const pullOnlyRemote = planPull(
      baselineOf({ "notes/a.md": { remoteHash: h("old"), localHash: h("base"), imported: true } }),
      { entries: [{ path: "notes/a.md", hash: h("new") }] },
      [{ path: "notes/a.md", hash: h("base"), bytes: 10 }],
    );
    expect(pullOnlyRemote.download).toEqual([{ path: "notes/a.md", sha: h("new") }]);
    expect(pullOnlyRemote.conflicts).toEqual([]);

    // 本地改了、远端没动 → 推送
    const push = planPush(
      baselineOf({ "notes/a.md": { remoteHash: h("same"), localHash: h("base"), imported: true } }),
      [{ path: "notes/a.md", hash: h("local"), bytes: 10 }],
    );
    expect(push.modified.map((file) => file.path)).toEqual(["notes/a.md"]);
    expect(pushIsEmpty(push)).toBe(false);
  });
});

describe("画布（.canvas）进物化判据：拉得下来、删得掉（docs/canvas/00 §7.2 的缺口）", () => {
  it("远端新增 / 远端已改的画布 ⇒ 进 download（不再只更新账本）", () => {
    // 远端新增（基线没见过）
    const added = planPull(
      baselineOf({}),
      { entries: [{ path: "看板/读书.canvas", hash: h("v1") }] },
      [],
    );
    expect(added.download).toEqual([{ path: "看板/读书.canvas", sha: h("v1") }]);

    // 远端改了、本地没动
    const updated = planPull(
      baselineOf({ "看板/读书.canvas": { remoteHash: h("old"), localHash: h("base"), imported: true } }),
      { entries: [{ path: "看板/读书.canvas", hash: h("new") }] },
      [{ path: "看板/读书.canvas", hash: h("base"), bytes: 10 }],
    );
    expect(updated.download).toEqual([{ path: "看板/读书.canvas", sha: h("new") }]);
    expect(updated.conflicts).toEqual([]);
  });

  it("远端删了画布、本地没动 ⇒ 进 removeLocal（与下载分支同一个判据）", () => {
    const plan = planPull(
      baselineOf({
        "看板/读书.canvas": { remoteHash: h("v1"), localHash: h("v1"), imported: true },
        "notes/a.ts": { remoteHash: h("x"), localHash: h("x"), imported: true },
      }),
      { entries: [] },
      [
        { path: "看板/读书.canvas", hash: h("v1"), bytes: 10 },
        { path: "notes/a.ts", hash: h("x"), bytes: 5 },
      ],
    );
    expect(plan.removeLocal).toEqual(["看板/读书.canvas"]);
  });

  it("源码 / 配置仍然永不落地（画布并入不是「什么都物化」）", () => {
    const plan = planPull(baselineOf({}), { entries: [{ path: "src/main.ts", hash: h("ts") }] }, []);
    expect(plan.download).toEqual([]);
    expect(plan.removeLocal).toEqual([]);
  });
});

describe("§6.3 · 删除保护阈值", () => {
  it("小批量放行（`max(20, 总量×25%)` 以内）", () => {
    expect(assertDeletionBudget(4, 1)).toBeNull();
    expect(assertDeletionBudget(4, 20)).toBeNull(); // 20 是下限，即使库里只有 4 篇
    expect(assertDeletionBudget(100, 25)).toBeNull();
  });

  it("超阈值拦住，并说清「删多少 / 阈值多少」", () => {
    const message = assertDeletionBudget(100, 26);
    expect(message).toContain("26");
    expect(message).toContain("25");
    const big = assertDeletionBudget(1000, 999);
    expect(big).toContain("250"); // 总量的 25% 比 20 大时，用百分比
  });

  it("空库 / 零删除不会误报", () => {
    expect(assertDeletionBudget(0, 0)).toBeNull();
    expect(assertDeletionBudget(0, 20)).toBeNull();
  });
});

describe("§6.4 / C12 · truncated 时禁止推断删除", () => {
  const baseline = baselineOf({
    "notes/a.md": { remoteHash: h("a"), localHash: h("a-local"), imported: true },
    "notes/b.md": { remoteHash: h("b"), localHash: h("b-local"), imported: true },
  });
  const local = [
    { path: "notes/a.md", hash: h("a-local"), bytes: 1 },
    { path: "notes/b.md", hash: h("b-local"), bytes: 1 },
  ];

  it("树完整 ⇒ 照常删（基线里有、本地有、远端没有）", () => {
    const plan = planPull(baseline, { truncated: false, entries: [] }, local);
    expect(plan.removeLocal.sort()).toEqual(["notes/a.md", "notes/b.md"]);
  });

  it("树**不完整** ⇒ 删除全部挂起，且新增/更新照常进行", () => {
    const plan = planPull(baseline, { truncated: true, entries: [{ path: "notes/c.md", hash: h("c") }] }, local);
    const guarded = applyTruncationGuard(plan, true);
    expect(guarded.removeLocal).toEqual([]);
    expect(guarded.suspendedDeletes.sort()).toEqual(["notes/a.md", "notes/b.md"]);
    // 新增照常 —— 「只做新增与更新」是这条纪律的原文。
    expect(guarded.download.map((item) => item.path)).toEqual(["notes/c.md"]);
  });

  it("truncated 为假时是恒等变换（别把正常路径也挂起）", () => {
    const plan = planPull(baseline, { truncated: false, entries: [] }, local);
    const guarded = applyTruncationGuard(plan, false);
    expect(guarded.suspendedDeletes).toEqual([]);
    expect(guarded.removeLocal.sort()).toEqual(["notes/a.md", "notes/b.md"]);
  });

  it("挂起的删除依然会以冲突以外的形式被如实报出（不静默丢弃）", () => {
    const plan = planPull(baseline, { truncated: true, entries: [] }, local);
    const guarded = applyTruncationGuard(plan, true);
    // 挂起不是「忽略」：调用方拿得到这份清单，才能在 UI 上说「有 2 项删除待确认」。
    expect(guarded.suspendedDeletes).toHaveLength(2);
  });
});
