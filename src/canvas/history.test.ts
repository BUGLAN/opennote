/**
 * 撤销栈的纯逻辑测试：容量、重做清空、无变化记录的合并（不产生空撤销步）。
 */
import { describe, expect, it } from "vitest";
import { createUndoHistory, UNDO_HISTORY_CAPACITY } from "./history";

describe("undo 历史", () => {
  it("撤销/重做的基本来回", () => {
    const h = createUndoHistory();
    h.record("A");
    h.record("B");
    expect(h.undo("C")).toBe("B");
    expect(h.undo("B")).toBe("A");
    expect(h.undo("A")).toBeNull();
    expect(h.redo("A")).toBe("B");
    expect(h.redo("B")).toBe("C");
    expect(h.redo("C")).toBeNull();
  });

  it("新变更清空重做栈", () => {
    const h = createUndoHistory();
    h.record("A");
    expect(h.undo("B")).toBe("A");
    expect(h.canRedo()).toBe(true);
    h.record("C"); // 重做栈作废
    expect(h.canRedo()).toBe(false);
    expect(h.redo("D")).toBeNull();
    expect(h.undo("D")).toBe("C");
  });

  it("与栈顶相同的记录被合并（同一次拖动的重复落定不产生空步）", () => {
    const h = createUndoHistory();
    h.record("A");
    h.record("A"); // 无变化落定
    h.record("A");
    expect(h.size()).toBe(1);
    expect(h.undo("B")).toBe("A");
    expect(h.undo("A")).toBeNull();
  });

  it("撤销跳过与当前态相同的快照（记录后实际没发生变化的场景）", () => {
    const h = createUndoHistory();
    h.record("A"); // A → B
    h.record("B"); // B → B（变更没生效，比如 resize 落定但尺寸没变）
    expect(h.undo("B")).toBe("A"); // 直接跳过 B === current 的那一步
    expect(h.redo("A")).toBe("B");
  });

  it("容量上限：最老的快照被挤出，仍可一路撤销到容量边界", () => {
    const h = createUndoHistory(3);
    for (let i = 0; i < 6; i += 1) h.record(`s${i}`);
    expect(h.size()).toBe(3);
    let current = "s5";
    const seen: string[] = [];
    for (;;) {
      const prev = h.undo(current);
      if (prev == null) break;
      seen.push(prev);
      current = prev;
    }
    // s5 与当前态相同（最后一条记录没有对应的新状态）：按无变化记录跳过，
    // 可回退到 s4、s3 —— 最老的 s2 已被挤出。
    expect(seen).toEqual(["s4", "s3"]);
    expect(h.canUndo()).toBe(false);
  });

  it("默认容量 ~100", () => {
    expect(UNDO_HISTORY_CAPACITY).toBe(100);
    const h = createUndoHistory();
    for (let i = 0; i < 150; i += 1) h.record(`s${i}`);
    expect(h.size()).toBe(100);
  });
});
