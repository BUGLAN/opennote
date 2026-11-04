import { describe, expect, it } from "vitest";
import type { SyncOnceResult } from "./engine";
import { MAX_ENTRIES, MAX_PATHS, MERGE_WINDOW_MS, appendEntry, entryFromResult, failureEntry, parseHistory, type SyncHistoryEntry } from "./history";

/** 只填历史关心的字段；其余给个能过类型的空值。 */
function result(partial: Partial<SyncOnceResult>): SyncOnceResult {
  return {
    pushed: 0,
    remoteDeleted: 0,
    pulled: 0,
    pushConflicts: [],
    conflicts: [],
    deleted: 0,
    suspendedDeletes: [],
    treeTruncated: false,
    blockedDeletes: 0,
    deletionGuardMessage: null,
    scanIncomplete: false,
    suspendedPushDeletes: [],
    resynced: false,
    ledger: { version: 1, remote: { baseUrl: "", notebookId: "nb", cryptoMode: "none", protocolVersion: 2 }, nextBid: 1, bids: {}, files: {} },
    appliedPaths: [],
    unknownDids: [],
    checkpoint: null,
    ...partial,
  };
}

describe("同步历史：哪一轮值得记", () => {
  it("什么都没动、也没冲突的一轮不记（后台空跑不刷屏）", () => {
    expect(entryFromResult(result({}), [], 1)).toBeNull();
  });

  it("动了东西的一轮：计数 + 具体路径（每类最多 MAX_PATHS 条）", () => {
    const many = Array.from({ length: MAX_PATHS + 5 }, (_, index) => `n/${index}.md`);
    const entry = entryFromResult(result({ pushed: many.length, pushedPaths: many, pulled: 1, pulledPaths: ["a.md"] }), [], 10);
    expect(entry).toMatchObject({ kind: "synced", at: 10, pushed: many.length, pulled: 1 });
    expect(entry?.kind === "synced" && entry.paths.pushed).toHaveLength(MAX_PATHS);
    expect(entry?.kind === "synced" && entry.paths.pulled).toEqual(["a.md"]);
  });

  it("只有冲突、没上传下载的一轮也记（用户要知道有东西在等他）", () => {
    expect(entryFromResult(result({}), ["x.md"], 1)).toMatchObject({ kind: "synced", conflicts: 1 });
  });
});

describe("同步历史：合并规则", () => {
  const synced = (at: number, pushed: string[], extra: Partial<Extract<SyncHistoryEntry, { kind: "synced" }>> = {}): SyncHistoryEntry => ({
    kind: "synced",
    at,
    pushed: pushed.length,
    pulled: 0,
    deleted: 0,
    remoteDeleted: 0,
    conflicts: 0,
    paths: { pushed, pulled: [], deleted: [], remoteDeleted: [], conflicts: [] },
    ...extra,
  });

  it("新的在最前；超过 MAX_ENTRIES 丢掉最旧的", () => {
    let list: SyncHistoryEntry[] = [];
    for (let index = 0; index < MAX_ENTRIES + 3; index += 1) list = appendEntry(list, synced(index, [`n${index}.md`]));
    expect(list).toHaveLength(MAX_ENTRIES);
    expect(list[0]?.at).toBe(MAX_ENTRIES + 2);
  });

  it("连续同样的失败合并成一条，记次数与首次时间（重试不刷屏）", () => {
    let list: SyncHistoryEntry[] = [];
    list = appendEntry(list, failureEntry("offline", "连不上", 1));
    list = appendEntry(list, failureEntry("offline", "连不上", 5));
    list = appendEntry(list, failureEntry("offline", "连不上", 9));
    expect(list).toEqual([{ kind: "offline", at: 9, firstAt: 1, repeat: 3, message: "连不上" }]);
    // 换了一句话 ⇒ 另起一条
    list = appendEntry(list, failureEntry("error", "服务器 500", 10));
    expect(list).toHaveLength(2);
  });

  it("一直在改同一篇：30 分钟内连续「只上传了这一篇」合成一条，记保存次数", () => {
    let list: SyncHistoryEntry[] = [];
    list = appendEntry(list, synced(1_000, ["a.md"]));
    list = appendEntry(list, synced(2_000, ["a.md"]));
    list = appendEntry(list, synced(3_000, ["a.md"]));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ at: 3_000, firstAt: 1_000, rounds: 3 });
  });

  it("另一台设备一直在写同一篇：连续「只下载了这一篇」同样合成一条", () => {
    const pulled = (at: number, path: string): SyncHistoryEntry =>
      synced(at, [], { pushed: 0, pulled: 1, paths: { pushed: [], pulled: [path], deleted: [], remoteDeleted: [], conflicts: [] } });
    let list: SyncHistoryEntry[] = [pulled(1_000, "a.md")];
    list = appendEntry(list, pulled(2_000, "a.md"));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ pulled: 1, rounds: 2, firstAt: 1_000, at: 2_000 });
    // 上传和下载不是同一件事：不合并
    list = appendEntry(list, synced(3_000, ["a.md"]));
    expect(list).toHaveLength(2);
  });

  it("换了一篇、有下载、或隔太久 ⇒ 不合并", () => {
    let list: SyncHistoryEntry[] = [synced(1_000, ["a.md"])];
    list = appendEntry(list, synced(2_000, ["b.md"]));
    expect(list).toHaveLength(2);
    list = appendEntry(list, synced(3_000, ["b.md"], { pulled: 1, paths: { pushed: ["b.md"], pulled: ["c.md"], deleted: [], remoteDeleted: [], conflicts: [] } }));
    expect(list).toHaveLength(3);
    list = appendEntry(list, synced(3_000 + MERGE_WINDOW_MS + 1, ["b.md"], {}));
    list = appendEntry(list, synced(3_000 + MERGE_WINDOW_MS * 3, ["b.md"], {}));
    expect(list).toHaveLength(5);
  });

  it("冲突挂着没处理、每轮都带着同样的冲突回来 ⇒ 只更新时间", () => {
    const withConflict = (at: number): SyncHistoryEntry =>
      synced(at, [], { conflicts: 1, paths: { pushed: [], pulled: [], deleted: [], remoteDeleted: [], conflicts: ["x.md"] } });
    let list: SyncHistoryEntry[] = [withConflict(1)];
    list = appendEntry(list, withConflict(2));
    expect(list).toHaveLength(1);
    expect(list[0]?.at).toBe(2);
  });
});

describe("同步历史：读回", () => {
  it("坏数据当成空的（设置页不能因为它打不开）", () => {
    expect(parseHistory(null)).toEqual([]);
    expect(parseHistory("不是 JSON")).toEqual([]);
    expect(parseHistory('{"a":1}')).toEqual([]);
    expect(parseHistory('[{"kind":"synced","at":1},{"kind":"???","at":2},null]')).toHaveLength(1);
  });
});
