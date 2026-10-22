/**
 * 增量同步的游标（`/v1/changes?since=` 的那个 `since`）保存在哪。
 *
 * ## 为什么是 `localStorage`，不是 `.opennote/`
 *
 * 设计文档 §3.7 把这件事写死了：**游标是「我拉到哪了」，它属于设备，不属于笔记本**。
 * `.opennote/` 会跟着笔记本目录被拷贝、被导出、被带进 `.git` ——
 * 一旦游标跟着走，第二台设备会「继承」一个它从没拉过的位置，
 * 然后**静默漏掉中间所有变更**。这是那一节点名的、最难查的一类故障。
 *
 * 所以：
 * - 游标 → `localStorage`（每设备一份，不随目录走）；
 * - 账本（`localHash` / `remoteHash`）→ `.opennote/sync.json`（跟着目录走，回答「我改没改」）。
 *
 * ## 丢了怎么办
 *
 * 丢了（清站点数据 / 换设备 / 隐私模式）就当没有 —— 下一次同步 `since = null`，
 * 退化成**全树比对**。那是正确但更慢的路径，**方向是安全的**：
 * 宁可多拉一遍，不可漏拉一条。
 */

/** 存储键前缀（后接 notebookId）。带版本号，换格式时不会把旧值当新格式读。 */
export const SYNC_CURSOR_KEY_PREFIX = "opennote.sync.cursor.v1.";

export interface CursorStore {
  /** 取这个笔记本上一次同步到达的游标；没有（或坏了）返回 `null`。 */
  load(notebookId: string): string | null;
  /** 记下游标；`null` = 清掉（换账号 / 换笔记本时用）。 */
  save(notebookId: string, cursor: string | null): void;
  clear(notebookId: string): void;
}

/** 只用到 `localStorage` 的这三个方法（传别的实现也能用，便于测试）。 */
export interface CursorStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * 内存实现（测试用；也是「站点存储被禁用」时的退化实现）。
 *
 * 退化到内存意味着「这次运行内增量，重启就全量」—— 慢一点，但绝不会漏。
 */
export function createMemoryCursorStore(initial: Record<string, string> = {}): CursorStore {
  const map = new Map(Object.entries(initial));
  return {
    load: (notebookId) => map.get(notebookId) ?? null,
    save: (notebookId, cursor) => {
      if (cursor === null) map.delete(notebookId);
      else map.set(notebookId, cursor);
    },
    clear: (notebookId) => void map.delete(notebookId),
  };
}

/**
 * `localStorage` 实现。
 *
 * 存储被禁用（隐私模式 / 站点数据被阻止）时**不抛**：退回「只用内存」。
 * 抛出去会让整个同步起不来，而那不是这里该背的锅 —— 游标只是优化。
 */
export function createWebCursorStore(
  storage?: CursorStorageLike,
  options: { onUnavailable?: (reason: string) => void } = {},
): CursorStore {
  const backing = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
  const memory = new Map<string, string>();
  let warned = false;
  const warn = (reason: string): void => {
    if (warned) return;
    warned = true;
    options.onUnavailable?.(reason);
  };

  const key = (notebookId: string): string => `${SYNC_CURSOR_KEY_PREFIX}${notebookId}`;

  return {
    load(notebookId) {
      if (!backing) return memory.get(notebookId) ?? null;
      try {
        const value = backing.getItem(key(notebookId));
        return value === null || value === "" ? (memory.get(notebookId) ?? null) : value;
      } catch (error) {
        warn(error instanceof Error ? error.message : String(error));
        return memory.get(notebookId) ?? null;
      }
    },
    save(notebookId, cursor) {
      if (cursor === null) {
        memory.delete(notebookId);
        if (!backing) return;
        try {
          backing.removeItem(key(notebookId));
        } catch {
          /* 删不掉也没有可做的 */
        }
        return;
      }
      memory.set(notebookId, cursor);
      if (!backing) return;
      try {
        backing.setItem(key(notebookId), cursor);
      } catch (error) {
        warn(error instanceof Error ? error.message : String(error));
      }
    },
    clear(notebookId) {
      memory.delete(notebookId);
      if (!backing) return;
      try {
        backing.removeItem(key(notebookId));
      } catch {
        /* 同上 */
      }
    },
  };
}

/**
 * 按宿主挑一个实现。
 *
 * 桌面端与网页端都用 `localStorage`：游标的性质是「本机、可丢、丢了只影响快慢」，
 * 不需要进主进程（那是给密钥与令牌用的，见 `keys.ts`）。
 */
export function resolveCursorStore(): CursorStore {
  return createWebCursorStore();
}
