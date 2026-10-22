/**
 * 状态栏同步位的用例（`statusBar.ts`）。
 *
 * 这一组钉的是**「什么时候闭嘴」**：同步正常时不占位，只有
 * 「正在跑 / 要你动手 / 出问题」才说话。
 *
 * 以前它永远返回一句话（「同步 · 已同步」），于是底栏常驻一条**永远为真**的播报 ——
 * 没有信息量，还让真正的异常淹没在噪音里。
 */
import { describe, expect, it } from "vitest";
import { syncStatusBarInfo } from "./statusBar";
import type { SyncUiState } from "./appSync";

function state(patch: Partial<SyncUiState>): SyncUiState {
  return {
    phase: "attached",
    reason: null,
    status: null,
    last: null,
    error: null,
    logs: [],
    hasKey: true,
    accountId: null,
    storage: null,
    ...patch,
  };
}

const idle = { phase: "idle" as const, lastSyncedAt: 1, conflicts: 0 };

describe("状态栏同步位", () => {
  it("没有打开笔记本 ⇒ 不显示", () => {
    expect(syncStatusBarInfo(state({}), false)).toBeNull();
  });

  it("★ 一切正常 ⇒ **null**（不占位、不播报「已同步」）", () => {
    const info = syncStatusBarInfo(state({ status: idle }), true);
    expect(info).toBeNull();
  });

  it("没开同步 ⇒ 也不显示（关着的同步是一个普通笔记本，不是异常）", () => {
    expect(syncStatusBarInfo(state({ reason: "disabled" }), true)).toBeNull();
  });

  it("正在同步 ⇒ busy + 进度；知道总数时写「12 / 558」", () => {
    const info = syncStatusBarInfo(
      state({ status: { phase: "syncing", startedAt: 1, progress: { done: 12, total: 558 } } }),
      true,
    );
    expect(info?.tone).toBe("busy");
    expect(info?.label).toBe("同步中 12 / 558");
    expect(info?.progress).toBeCloseTo(12 / 558);
  });

  it("还在规划（没有总数）⇒ 只说「同步中…」，不编造进度", () => {
    const info = syncStatusBarInfo(state({ status: { phase: "syncing", startedAt: 1, progress: null } }), true);
    expect(info?.label).toBe("同步中…");
    expect(info?.progress).toBeNull();
  });

  it("有冲突 ⇒ warn，并且写清「只有你能解决」", () => {
    const info = syncStatusBarInfo(state({ status: { phase: "idle", lastSyncedAt: 1, conflicts: 3 } }), true);
    expect(info?.tone).toBe("warn");
    expect(info?.label).toBe("3 处冲突待处理");
  });

  it("删除被暂缓 ⇒ warn（不然用户只觉得「我删的又回来了」）", () => {
    const info = syncStatusBarInfo(
      state({
        status: idle,
        last: {
          at: 1,
          pushed: 0,
          pulled: 0,
          deleted: 0,
          remoteDeleted: 0,
          conflicts: [],
          unknownDids: 0,
          suspendedDeletes: 2,
          treeTruncated: false,
        },
      }),
      true,
    );
    expect(info?.label).toBe("2 条删除已暂缓");
  });

  it("没有密钥 ⇒ warn（这条只有用户自己能解决）", () => {
    const info = syncStatusBarInfo(state({ hasKey: false }), true);
    expect(info?.tone).toBe("warn");
    expect(info?.label).toBe("未导入密钥");
  });

  it("离线 / 失败 ⇒ 都要说话（沉默会被读成「同步好了」）", () => {
    expect(syncStatusBarInfo(state({ status: { phase: "offline", error: "断网", lastSyncedAt: null } }), true)?.tone).toBe("warn");
    expect(syncStatusBarInfo(state({ status: { phase: "error", error: "500", code: "unknown", lastSyncedAt: null } }), true)?.tone).toBe("error");
  });
});
