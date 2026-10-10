/**
 * 每篇笔记「磁盘状态」的记账处 —— 同步层的唯一真相记录（重构中）。
 *
 * ▍P0 现状（与 0.9.x 语义完全一致，只是从 `library.ts` 搬家 + 收口成一个模块）
 *   记录 `{ size, mtimeMs }`：
 *     - `seedAll()`：open/rescan 时整表重灌（**P1 会废除重灌**，见下）；
 *     - `set()`：`flushNote` 写成功后更新；`delete()`：stat 不到（文件消失）时清掉；
 *     - `get()`：`flushNote` 保存前比对，stat 不符 ⇒ 疑似「外部改动」（P1 改为字节判定）。
 *
 * ▍已知缺口（P1「同步核心」就在本模块内修，先立牌坊，防止被当新 bug 再修一遍）
 *   - GAP-误判：重扫的 `list()` 阶段早于并发写入时，种子是旧的 ⇒ 应用自己的保存被当成
 *     「外部改动」，凭空生成 `.conflict-*.md` 并弹提示（2026-10-10 实测事故，见
 *     `library.externalChange.test.ts` 的特征用例）。
 *   - GAP-A：trash/restore 换路径后不换键 ⇒ 检测静默失效，真外部改动被覆盖。
 *   - GAP-B：`rebaseNoteAssets` 直写后不更新 ⇒ 多一次读盘。
 *
 * ▍P1 目标形态（只改本文件内部与 `flushNote`，不动其它调用方）
 *   记录升级为 `{ stat, content }`（内容溯源）；产生事实只允许 `commitWrite` /
 *   `adoptFromDisk` 两处；播种改「保留较新者」三态；缺记录 = 先读盘再定，绝不静默覆盖。
 */

import type { Id } from "./types";

export interface FileStamp {
  size: number;
  mtimeMs: number;
}

const stamps = new Map<Id, FileStamp>();

export const fileStates = {
  /** 清空（打开/关闭笔记本时）：同一路径在另一个笔记本是另一篇笔记，不得跨库携带。 */
  clear(): void {
    stamps.clear();
  },

  /**
   * open/rescan 播种。
   * ⚠️ P1 将改为「保留较新者」的三态播种：整表重灌会把应用刚写下去的记录冲回旧版本，
   * 这正是 GAP-误判的源头之一。
   */
  seedAll(seeded: Record<string, FileStamp>): void {
    stamps.clear();
    for (const [id, stamp] of Object.entries(seeded)) stamps.set(id, stamp);
  },

  get(id: Id): FileStamp | undefined {
    return stamps.get(id);
  },

  set(id: Id, stamp: FileStamp): void {
    stamps.set(id, stamp);
  },

  delete(id: Id): void {
    stamps.delete(id);
  },

  /** 改名/移动/回收站/恢复：同一条磁盘事实换一个键（与 `remapKeyed` 同语义）。 */
  remap(replace: (id: Id) => Id): void {
    for (const [key, value] of [...stamps]) {
      const id = replace(key);
      if (id === key) continue;
      stamps.delete(key);
      stamps.set(id, value);
    }
  },

  /** 诊断/测试用只读快照。 */
  entries(): Array<[Id, FileStamp]> {
    return [...stamps];
  },
};
