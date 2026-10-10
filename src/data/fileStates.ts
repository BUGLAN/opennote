/**
 * 每篇笔记「磁盘状态」的记账处 —— 同步层的唯一真相记录。
 *
 * ▍不变式（docs/设计-同步层与索引重构-2026-10-10.md §2）
 *   - **I1** 内容事实只允许两个入口产生：`commitWrite()`（写成功后）、
 *     `adoptFromDisk()`（应用显式读盘并采纳后）。改名/移动/回收站只做**换键**（`remap`）。
 *     没有「重扫整表重灌」——播种走 `seedFromScan()` 的三态规则（见下）。
 *   - **I2** 「是不是外部改动」的判定看**字节**（磁盘内容 ≠ `content`）；
 *     stat/mtime 只用来决定「要不要读盘」，在本模块里只参与「播种保留哪一份」。
 *
 * ▍三态播种（`seedFromScan`）：重扫不得覆盖应用刚写下去的记录
 *   1. 没有记录 → 采纳扫描结果（新文件 / 首次打开）；
 *   2. 磁盘内容 = 已知内容 → 只把 stat 往新刷（重扫的 `list()` 常早于并发写入）；
 *   3. 磁盘内容不同且 stat 比已知**新** → 外部改动已被重扫读走 → 采纳扫描结果；
 *      stat 不比已知新 → 扫描读到的是旧字节 → **保留我们的记录**。
 *
 * ▍历史缺口备忘（P1 已修，留注防止回退）
 *   - GAP-误判（0.9.x）：整表重灌 + list 早于并发写入 ⇒ 自己的保存被当成外部改动；
 *   - GAP-A：trash/restore 换路径后不换键 ⇒ 检测静默失效（现由调用方 `remap` 负责）；
 *   - GAP-B：`rebaseNoteAssets` 直写后不更新（现由调用方 `commitWrite` 负责）。
 */

import type { Id } from "./types";

export interface FileStamp {
  size: number;
  mtimeMs: number;
}

export interface FileRecord {
  stat: FileStamp;
  /** 我们最后一次写下去、或最后一次从磁盘读进来并采纳的那一版。 */
  content: string;
}

/** `scanWorkspace` 结果里本模块关心的最小结构（结构化类型，避免与 library 相互依赖）。 */
export interface ScanSnapshot {
  stamps: Record<string, FileStamp>;
  notes: Record<string, { content: string }>;
  trash: Record<string, { content: string }>;
}

const records = new Map<Id, FileRecord>();

export const fileStates = {
  /** 清空（打开/关闭笔记本时）：同一路径在另一个笔记本是另一篇笔记，不得跨库携带。 */
  clear(): void {
    records.clear();
  },

  /** 见模块头「三态播种」。 */
  seedFromScan(scanned: ScanSnapshot): void {
    for (const [id, stamp] of Object.entries(scanned.stamps)) {
      const note = scanned.notes[id] ?? scanned.trash[id];
      // 没读到内容（目录列到但正文读取失败等异常）就不动旧记录：宁可下次多读一次盘。
      if (!note) continue;
      const seen = records.get(id);
      if (!seen) {
        records.set(id, { stat: stamp, content: note.content });
        continue;
      }
      if (seen.content === note.content) {
        // 磁盘上还是我们知道的那一版：stat 只往新刷。
        if (stamp.mtimeMs > seen.stat.mtimeMs) records.set(id, { stat: stamp, content: seen.content });
        continue;
      }
      if (stamp.mtimeMs > seen.stat.mtimeMs) {
        // 外部改动已被重扫读走 → 采纳。
        records.set(id, { stat: stamp, content: note.content });
      }
      // 否则：扫描读到的是旧字节（它的 list 早于我们最后一次写入）→ 保留我们的记录。
    }
  },

  get(id: Id): FileRecord | undefined {
    return records.get(id);
  },

  /** 写成功后的记账（I1 入口之一）。 */
  commitWrite(id: Id, content: string, stat: FileStamp): void {
    records.set(id, { stat, content });
  },

  /** 显式读盘并采纳后的记账（I1 入口之二）。 */
  adoptFromDisk(id: Id, content: string, stat: FileStamp): void {
    records.set(id, { stat, content });
  },

  delete(id: Id): void {
    records.delete(id);
  },

  /** 改名/移动/回收站/恢复：同一条磁盘事实换一个键（与 `remapKeyed` 同语义）。 */
  remap(replace: (id: Id) => Id): void {
    for (const [key, value] of [...records]) {
      const id = replace(key);
      if (id === key) continue;
      records.delete(key);
      records.set(id, value);
    }
  },

  /** 诊断/测试用只读快照。 */
  entries(): Array<[Id, FileRecord]> {
    return [...records];
  },
};
