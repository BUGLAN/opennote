/**
 * 每篇笔记「磁盘状态」的记账处 —— 同步层的唯一真相记录。
 *
 * ▍不变式（docs/设计-同步层与索引重构-2026-10-10.md §2）
 *   - **I1** 内容事实只允许两个入口产生：`commitWrite()`（写成功后）、
 *     `adoptFromDisk()`（应用显式读盘并采纳后）。改名/移动/回收站只做**换键**（`remap`）。
 *     没有「重扫整表重灌」——播种走 `seedFromScan()` 的规则（见下）。
 *   - **I2** 「是不是外部改动」的判定看**字节**（磁盘内容 ≠ `content`）；
 *     stat/mtime 只用来决定「要不要读盘」与「要不要重读」，**永不参与身份判定**。
 *
 * ▍谁赢：磁盘、还是内存里那份没落盘的 buffer（2026-10-13 重写）
 *
 * 旧规则问的是时间戳：「磁盘 mtime 比我们记录的**新**吗」。**跨设备 / 网盘 / `git clone`
 * 下 mtime 不可比** —— 另一台机器写来的内容可能带**更旧的 mtime** → 判成「不是外部改动」
 * → 保留本地旧 buffer → 下一次 `flushNote` 把远端新内容**覆盖掉**
 * （依据：`docs/执行-三端同步-密钥即身份-2026-10-13.md` §5.4 第 5 条）。
 *
 * 新规则问的是**编辑顺序**，答案不依赖任何时间戳：
 *
 *   `record.seq` = 「这条磁盘事实最后一次与内存对齐时，buffer 的编辑序号」。
 *   它在三个时刻被写下：`commitWrite`（写完）、`adoptFromDisk`（读盘并采纳）、
 *   `seedFromScan` 首次登记（等于当时的 buffer 序号）。
 *   `bufferSeq(id)` = 内存里那一版最后一次被编辑的序号（`noteEdited`）。
 *
 *   ```
 *   bufferSeq(id) > record.seq   →  buffer 是**我们自己后来敲的** → 内存赢，保留 buffer
 *   bufferSeq(id) ≤ record.seq   →  内存自那次对齐后没动过     → 磁盘赢，采纳扫描结果
 *   ```
 *
 * 于是「扫描读到旧字节」（`list()` 早于并发写入）与「真外部改动」被区分开：
 * 前者 buffer 已被编辑过 ⇒ 保留；后者 buffer 没动过 ⇒ 采纳。
 * **跨设备场景落进第二种**：远端写来的内容会被采纳，不会再被本地旧 buffer 覆盖。
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
  /**
   * 这条磁盘事实最后一次与内存对齐时，buffer 的编辑序号（见模块头）。
   * 不持久化、不进基线：它只在一次会话内区分「我们后来敲的」与「别人写的」。
   */
  seq: number;
}

/** `scanWorkspace` 结果里本模块关心的最小结构（结构化类型，避免与 library 相互依赖）。 */
export interface ScanSnapshot {
  stamps: Record<string, FileStamp>;
  notes: Record<string, { content: string }>;
  trash: Record<string, { content: string }>;
}

const records = new Map<Id, FileRecord>();
/** 内存 buffer 的编辑序号：单调递增，只用于「先后」比较。 */
const bufferSeqs = new Map<Id, number>();
/**
 * 写入**进行中**时捕获的 buffer 序号。
 *
 * 必须在 `writeText()` **开始之前**捕获：一次写入可能横跨用户的好几次击键，
 * 用写完之后的值会让「写完那一版」被误判成「用户后来敲的」。
 */
const pendingWriteSeqs = new Map<Id, number>();
/** 序号计数器。与 `records` 的 `seq` 共用一条单调轴，直接可比。 */
let nextSeq = 1;

/**
 * 写入成功：`seq` 用**写之前**捕获的那个 buffer 序号。
 *
 * 传 `undefined`（老调用方/直接写盘）时退回「当前 buffer 序号」——语义是
 * 「这条磁盘事实等于此刻内存那一版」，与 `adoptFromDisk` 一致。
 */
function commit(id: Id, content: string, stat: FileStamp, seq?: number): void {
  const aligned = seq ?? currentBufferSeq(id);
  records.set(id, { stat, content, seq: aligned });
}

function currentBufferSeq(id: Id): number {
  return bufferSeqs.get(id) ?? 0;
}

export const fileStates = {
  /** 清空（打开/关闭笔记本时）：同一路径在另一个笔记本是另一篇笔记，不得跨库携带。 */
  clear(): void {
    records.clear();
    bufferSeqs.clear();
    pendingWriteSeqs.clear();
  },

  /**
   * 内存里那一版被编辑了 —— **同步层唯一允许的「本地改没改」判据来源**。
   * 每次正文变动（含编辑器击键、外部采纳、新建）都要叫一次。
   */
  noteEdited(id: Id): number {
    nextSeq += 1;
    bufferSeqs.set(id, nextSeq);
    return nextSeq;
  },

  /** 内存 buffer 的编辑序号；0 = 本会话内没编辑过（等同「磁盘与我们一致」）。 */
  bufferSeq(id: Id): number {
    return currentBufferSeq(id);
  },

  /**
   * 取「这次写入的结束时序」并清账：配合 `commitWrite` 使用。
   * 没捕获过（直接写盘、测试夹具）→ 返回 `undefined`，由 `commit` 退回当前 buffer 序号。
   */
  takeWriteSeq(id: Id): number | undefined {
    const captured = pendingWriteSeqs.get(id);
    pendingWriteSeqs.delete(id);
    return captured;
  },

  /** 见模块头「谁赢」。 */
  seedFromScan(scanned: ScanSnapshot): void {
    for (const [id, stamp] of Object.entries(scanned.stamps)) {
      const note = scanned.notes[id] ?? scanned.trash[id];
      // 没读到内容（目录列到但正文读取失败等异常）就不动旧记录：宁可下次多读一次盘。
      if (!note) continue;
      const seen = records.get(id);
      if (!seen) {
        // 首次登记：把「此刻 buffer 序号」记进去，于是「本会话之后被敲过」才算本地赢。
        records.set(id, { stat: stamp, content: note.content, seq: currentBufferSeq(id) });
        continue;
      }
      if (seen.content === note.content) {
        // 磁盘上还是我们知道的那一版：内容事实不动，只把 stat 往新刷（下次少读一次盘）。
        if (stamp.mtimeMs > seen.stat.mtimeMs) records.set(id, { ...seen, stat: stamp });
        continue;
      }
      // 内容不同：内存后来被我们敲过（`bufferSeq > seen.seq`）就保留内存那一版；
      // 否则扫描读到的是真外部改动（或我们自己刚写下的那一版）→ 采纳磁盘。
      // 内容不同：内存后来被我们敲过（`bufferSeq > seen.seq`）就保留内存那一版；
      // 否则扫描读到的是真外部改动（或我们自己刚写下的那一版）→ 采纳磁盘。
      if (currentBufferSeq(id) <= seen.seq) {
        records.set(id, { stat: stamp, content: note.content, seq: seen.seq });
      }
    }
  },

  get(id: Id): FileRecord | undefined {
    return records.get(id);
  },

  /** 写成功后的记账（I1 入口之一）。**必须在 `takeWriteSeq` 之后调用。** */
  commitWrite(id: Id, content: string, stat: FileStamp): void {
    commit(id, content, stat, pendingWriteSeqs.get(id));
    pendingWriteSeqs.delete(id);
  },

  /** 显式读盘并采纳后的记账（I1 入口之二）：磁盘与内存此刻对齐。 */
  adoptFromDisk(id: Id, content: string, stat: FileStamp): void {
    commit(id, content, stat);
  },

  delete(id: Id): void {
    records.delete(id);
    bufferSeqs.delete(id);
    pendingWriteSeqs.delete(id);
  },

  /** 改名/移动/回收站/恢复：同一条磁盘事实换一个键（与 `remapKeyed` 同语义）。 */
  remap(replace: (id: Id) => Id): void {
    remapMap(records, replace);
    remapMap(bufferSeqs, replace);
    remapMap(pendingWriteSeqs, replace);
  },

  /** 诊断/测试用只读快照。 */
  entries(): Array<[Id, FileRecord]> {
    return [...records];
  },
};

/**
 * 写入开始前登记「这次写的是哪个 buffer 版本」。返回的序号要原样交给
 * `commitWrite`（经由 `takeWriteSeq`），**不要**在写完之后重新取 —— 见 `pendingWriteSeqs`。
 */
export function beginWrite(id: Id): number {
  const seq = currentBufferSeq(id);
  pendingWriteSeqs.set(id, seq);
  return seq;
}

function remapMap<V>(map: Map<Id, V>, replace: (id: Id) => Id): Id[] {
  const stale: Id[] = [];
  for (const [key, value] of [...map]) {
    const id = replace(key);
    if (id === key) continue;
    map.delete(key);
    map.set(id, value);
    stale.push(id);
  }
  return stale;
}
