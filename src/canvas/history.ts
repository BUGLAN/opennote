/**
 * 画布的撤销/重做栈（纯逻辑，无 React、无 DOM）。
 *
 * 模型是「双栈 + 显式当前态」：`past` 存每次变更**前**的序列化快照，`future`
 * 存被撤销掉的**后**态。调用方（CanvasView）在每次落盘级 emit 时拿「上一稳定态」
 * 调 `record`，撤销/重做时把当前态传入换回目标态 —— 栈自己不持有「现在」，
 * 也就不会和 React 状态打架。
 *
 * 两条防噪声纪律：
 * - `record` 与栈顶相同的快照直接丢弃（同一次拖动落定多次、无变化的落定）；
- `undo`/`redo` 跳过与当前态相同的快照（变更实际没发生的记录不出现在用户眼里）。
 */
export interface UndoHistory {
  /** 记一次变更前的序列化态；之后的变更会让 future（重做栈）清空。 */
  record(before: string): void;
  /** 撤销：返回应回到的文本；没有可回退的差异返回 null。 */
  undo(current: string): string | null;
  /** 重做：返回应前进到的文本；没有可前进的差异返回 null。 */
  redo(current: string): string | null;
  canUndo(): boolean;
  canRedo(): boolean;
  /** 快照数（容量裁剪后）。 */
  size(): number;
}

export const UNDO_HISTORY_CAPACITY = 100;

export function createUndoHistory(capacity: number = UNDO_HISTORY_CAPACITY): UndoHistory {
  let past: string[] = [];
  let future: string[] = [];

  const record = (before: string) => {
    // 新变更让重做栈作废（经典语义）。
    future = [];
    if (past[past.length - 1] === before) return;
    past.push(before);
    if (past.length > capacity) past.splice(0, past.length - capacity);
  };

  const undo = (current: string): string | null => {
    let prev = past.pop();
    while (prev != null && prev === current) prev = past.pop();
    if (prev == null) return null;
    future.push(current);
    return prev;
  };

  const redo = (current: string): string | null => {
    let next = future.pop();
    while (next != null && next === current) next = future.pop();
    if (next == null) return null;
    past.push(current);
    return next;
  };

  return {
    record,
    undo,
    redo,
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    size: () => past.length,
  };
}
