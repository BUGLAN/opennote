/**
 * 同步历史（「设置 → 同步 → 最近同步」）。
 *
 * ## 记什么、不记什么
 *
 * - **真的动了东西的一轮**：上传 / 下载 / 删除了几篇、出了几条冲突，外加具体是哪几篇（各最多
 *   `MAX_PATHS` 条）。什么都没发生的一轮**不记** —— 后台每隔一会儿就会空跑一轮，全记下来列表就是
 *   一屏「已同步 · 0」，真正有用的那几条反而被挤走。
 * - **出错 / 离线**：说清楚原因。重试时同样的错误会连着来很多次，**连续相同的合并成一条**，
 *   记下次数与最后一次的时间。
 *
 * ## 存在哪
 *
 * 每个笔记本一份，存在这台设备的 localStorage（键带 notebookId），最多 `MAX_ENTRIES` 条。
 * 它是「这台设备看到的同步经过」，和游标一样是每设备的事，不进笔记本目录、也不跟着同步走。
 * 存不了（隐私模式 / 配额满）就只留在内存里，界面照常显示本次打开以来的记录。
 */

import { createStore } from "../lib/store";
import type { SyncOnceResult } from "./engine";

/** 每个笔记本最多留多少条。 */
export const MAX_ENTRIES = 50;
/** 每条记录里每类明细最多留多少个路径（剩下的只记数量）。 */
export const MAX_PATHS = 20;

export interface SyncHistoryPaths {
  pushed: string[];
  pulled: string[];
  deleted: string[];
  remoteDeleted: string[];
  conflicts: string[];
}

export type SyncHistoryEntry =
  | {
      kind: "synced";
      at: number;
      /** 本机 → 云端（新建 / 修改）。 */
      pushed: number;
      /** 云端 → 本机。 */
      pulled: number;
      /** 云端删了 ⇒ 本机跟着删的。 */
      deleted: number;
      /** 本机删了 ⇒ 云端留下墓碑的。 */
      remoteDeleted: number;
      /** 这一轮结束时挂着的冲突数。 */
      conflicts: number;
      paths: SyncHistoryPaths;
      /**
       * 合并进这一条的轮数（缺省 = 1）。一直在改同一篇时，每次自动保存都会触发一轮
       * 「上传 1」—— 连着的这种合成一条，记下一共几次（见 `appendEntry`）。
       */
      rounds?: number;
      /** 合并时第一轮的时间（`at` 是最后一轮）。 */
      firstAt?: number;
    }
  | {
      kind: "error" | "offline";
      /** 最后一次出现的时间。 */
      at: number;
      /** 第一次出现的时间（合并之后才和 `at` 不同）。 */
      firstAt: number;
      /** 连续出现了几次（重试时同样的错误会反复来）。 */
      repeat: number;
      message: string;
    };

const take = (paths: string[] | undefined): string[] => (paths ?? []).slice(0, MAX_PATHS);

/**
 * 一轮成功同步 → 一条记录。**什么都没动、也没有冲突**的一轮返回 `null`（不记）。
 *
 * `conflicts` 由调用方给（它把账本里挂着的与这一轮新判出的合在一起算，见 `appSync.collectConflicts`）。
 */
export function entryFromResult(result: SyncOnceResult, conflicts: string[], now: number): SyncHistoryEntry | null {
  const moved = result.pushed + result.pulled + result.deleted + result.remoteDeleted;
  if (moved === 0 && conflicts.length === 0) return null;
  return {
    kind: "synced",
    at: now,
    pushed: result.pushed,
    pulled: result.pulled,
    deleted: result.deleted,
    remoteDeleted: result.remoteDeleted,
    conflicts: conflicts.length,
    paths: {
      pushed: take(result.pushedPaths),
      pulled: take(result.pulledPaths),
      deleted: take(result.deletedPaths),
      remoteDeleted: take(result.remoteDeletedPaths),
      conflicts: take(conflicts),
    },
  };
}

/**
 * 把一条记录放到最前面（新的在上）。
 *
 * - 与最新那条是**同一种失败、同一句话** ⇒ 合并（次数 +1、时间更新），不另起一行；
 * - 「已同步」且与最新那条**完全相同**（同样的冲突、什么都没动）⇒ 只更新时间：冲突挂着没处理时，
 *   每一轮都会带着同样的冲突回来，不该刷出一串一样的行。
 * - 都**只朝一个方向动了同样那几篇**、且相隔不到 `MERGE_WINDOW_MS` ⇒ 合并成一条、记轮数：
 *   一直在写同一篇时，每次自动保存都会上传一次（实测：打一行字就是好几条「上传 1」）；
 *   另一台设备在写时，这边就是一串「下载 1」。
 */
export function appendEntry(list: readonly SyncHistoryEntry[], entry: SyncHistoryEntry): SyncHistoryEntry[] {
  const latest = list[0];
  if (latest !== undefined && latest.kind !== "synced" && entry.kind !== "synced" && latest.kind === entry.kind && latest.message === entry.message) {
    return [{ ...latest, at: entry.at, repeat: latest.repeat + entry.repeat }, ...list.slice(1)];
  }
  if (latest !== undefined && latest.kind === "synced" && entry.kind === "synced" && sameRound(latest, entry)) {
    return [{ ...latest, at: entry.at, firstAt: latest.firstAt ?? latest.at }, ...list.slice(1)];
  }
  if (latest !== undefined && latest.kind === "synced" && entry.kind === "synced" && sameEdits(latest, entry)) {
    return [
      { ...latest, at: entry.at, firstAt: latest.firstAt ?? latest.at, rounds: (latest.rounds ?? 1) + (entry.rounds ?? 1) },
      ...list.slice(1),
    ];
  }
  return [entry, ...list].slice(0, MAX_ENTRIES);
}

/** 连续「只朝一个方向动了同样那几篇」合并的时间窗（30 分钟）。 */
export const MERGE_WINDOW_MS = 30 * 60_000;

type Synced = Extract<SyncHistoryEntry, { kind: "synced" }>;
const DIRECTIONS = ["pushed", "pulled", "deleted", "remoteDeleted"] as const;

/** 这一轮只朝**一个方向**动了文件（且没有冲突）时，返回那个方向；否则 null。 */
function soleDirection(entry: Synced): (typeof DIRECTIONS)[number] | null {
  if (entry.conflicts > 0) return null;
  const active = DIRECTIONS.filter((key) => entry[key] > 0);
  return active.length === 1 ? active[0]! : null;
}

/**
 * 两轮是不是「同一件事又发生了一次」：同一个方向、同样那几篇、相隔不到 `MERGE_WINDOW_MS`。
 * 本机一直在写同一篇（每次自动保存上传一次），或另一台设备一直在写同一篇（这边每次下载一次），
 * 都会连着来很多条一样的记录。
 */
function sameEdits(a: Synced, b: Synced): boolean {
  const direction = soleDirection(a);
  return (
    direction !== null &&
    soleDirection(b) === direction &&
    a[direction] === b[direction] &&
    a.paths[direction].join("\n") === b.paths[direction].join("\n") &&
    b.at - a.at <= MERGE_WINDOW_MS
  );
}

function sameRound(a: Synced, b: Synced): boolean {
  return (
    a.pushed + a.pulled + a.deleted + a.remoteDeleted === 0 &&
    b.pushed + b.pulled + b.deleted + b.remoteDeleted === 0 &&
    a.conflicts === b.conflicts &&
    a.paths.conflicts.join("\n") === b.paths.conflicts.join("\n")
  );
}

/** 一条失败 / 离线记录。 */
export function failureEntry(kind: "error" | "offline", message: string, now: number): SyncHistoryEntry {
  return { kind, at: now, firstAt: now, repeat: 1, message };
}

/* ------------------------------------------------------------- 存取与订阅 */

const STORAGE_PREFIX = "opennote:sync-history:";

function storageKey(notebookId: string): string {
  return `${STORAGE_PREFIX}${notebookId}`;
}

/** 读一份历史；坏数据（手改过 / 旧格式）当成空的，绝不让设置页因为它打不开。 */
export function parseHistory(raw: string | null): SyncHistoryEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is SyncHistoryEntry => {
        if (item === null || typeof item !== "object") return false;
        const entry = item as { kind?: unknown; at?: unknown };
        return (entry.kind === "synced" || entry.kind === "error" || entry.kind === "offline") && typeof entry.at === "number";
      })
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function readStored(notebookId: string): SyncHistoryEntry[] {
  try {
    return parseHistory(localStorage.getItem(storageKey(notebookId)));
  } catch {
    return [];
  }
}

function writeStored(notebookId: string, entries: SyncHistoryEntry[]): void {
  try {
    localStorage.setItem(storageKey(notebookId), JSON.stringify(entries));
  } catch {
    /* 存不了就只留在内存里（见模块头） */
  }
}

/** `notebookId → 记录`（按需从 localStorage 读进来）。 */
const historyStore = createStore<Record<string, SyncHistoryEntry[]>>({});

function entriesOf(notebookId: string): SyncHistoryEntry[] {
  const cached = historyStore.get()[notebookId];
  if (cached !== undefined) return cached;
  const loaded = readStored(notebookId);
  historyStore.set((prev) => ({ ...prev, [notebookId]: loaded }));
  return loaded;
}

/** 记一条。`notebookId` 为空（还没对上云端）时不记。 */
export function recordSyncHistory(notebookId: string, entry: SyncHistoryEntry): void {
  if (notebookId === "") return;
  const next = appendEntry(entriesOf(notebookId), entry);
  historyStore.set((prev) => ({ ...prev, [notebookId]: next }));
  writeStored(notebookId, next);
}

/** 清空某个笔记本在这台设备上的同步历史。 */
export function clearSyncHistory(notebookId: string): void {
  historyStore.set((prev) => ({ ...prev, [notebookId]: [] }));
  try {
    localStorage.removeItem(storageKey(notebookId));
  } catch {
    /* 同上 */
  }
}

/**
 * 设置页订阅这个 store（`notebookId → 记录`，新的在前）；第一次看某个笔记本之前先调
 * `loadSyncHistory()` 把 localStorage 里那份读进来。这一层不碰 React（同步层要能在 node 里跑）。
 */
export const syncHistoryStore = historyStore;

/** 把某个笔记本的历史读进 store（已经读过就什么都不做）。 */
export function loadSyncHistory(notebookId: string): void {
  if (notebookId !== "") entriesOf(notebookId);
}

/** 只给测试用：把内存里的缓存清掉（localStorage 由测试自己处理）。 */
export function resetSyncHistoryForTests(): void {
  historyStore.set({});
}
