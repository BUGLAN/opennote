import { createStore, useStore } from "../lib/store";

/**
 * 浏览器笔记本（OPFS）的持久存储申请。
 *
 * OPFS 默认属于「尽力而为」的存储：磁盘紧张时 Chrome 可能整块清掉；Safari 会清掉
 * 超过 7 天没打开过的网站存的数据（加到主屏幕的网页应用不受影响）；用户「清除网站数据」
 * 时也会没。`navigator.storage.persist()` 能把这个 origin 的存储标记为持久，但它是
 * **申请**而不是保证 —— 浏览器可以拒绝，所以结果必须如实展示给用户。
 *
 * 只在 OPFS 后端使用：桌面版与 FSA（磁盘上的真实文件夹）不需要，也不该被这个提示打扰。
 *
 * **状态是 origin 级的**：`navigator.storage` 的持久化按 origin 生效，同一个 origin 下的
 * 所有浏览器笔记本共享一个结果。所以 store 里不记笔记本 id —— 后台新建另一个 OPFS 笔记本
 * （导入文件夹、GitHub 导入）不会把当前笔记本的提示和设置状态冲掉。
 */

/**
 * - `persisted`：浏览器已批准持久化。
 * - `denied`：没批准（或申请本身被拒，如隐私模式 / 企业策略）。
 * - `unsupported`：没有 `persist()` / `persisted()`（老浏览器或受限 WebView），申请不了。
 * - `unknown`：`persisted()` 自己抛错，无法确认当前状态。
 */
export type StoragePersistenceStatus = "persisted" | "denied" | "unsupported" | "unknown";

export interface StoragePersistenceState {
  /** null = 本会话还没检查过。 */
  status: StoragePersistenceStatus | null;
  /** 最近一次检查完成的时间（`Date.now()`）；null = 还没检查过。 */
  checkedAt: number | null;
}

export const storagePersistenceStore = createStore<StoragePersistenceState>({
  status: null,
  checkedAt: null,
});

export function useStoragePersistence(): StoragePersistenceState {
  return useStore(storagePersistenceStore);
}

/** 这些状态意味着「浏览器可能会清掉浏览器笔记本」，需要提示用户。 */
export function isStorageAtRisk(status: StoragePersistenceStatus | null): boolean {
  return status === "denied" || status === "unsupported" || status === "unknown";
}

/**
 * 这个运行时有没有 StorageManager 的持久化 API。
 *
 * 老浏览器或受限 WebView 可能没有 `persist()` / `persisted()`；此时只能如实说「申请不了」，
 * 而不是假装已持久化。（Safari 15.2+ 两个 API 都有，只是可能返回 false。）
 */
export function supportsStoragePersistence(): boolean {
  try {
    return (
      typeof navigator !== "undefined" &&
      typeof navigator.storage?.persist === "function" &&
      typeof navigator.storage?.persisted === "function"
    );
  } catch {
    // 站点数据被完全禁止时，连 `navigator.storage` 的 getter 都可能抛错。
    return false;
  }
}

async function queryPersisted(): Promise<StoragePersistenceStatus> {
  if (!supportsStoragePersistence()) return "unsupported";
  try {
    return (await navigator.storage.persisted()) ? "persisted" : "denied";
  } catch {
    return "unknown";
  }
}

async function requestPersistence(): Promise<StoragePersistenceStatus> {
  // 已经持久化就不再请求：部分浏览器会因此弹一次不必要的授权框。
  const current = await queryPersisted();
  if (current !== "denied") return current;
  try {
    return (await navigator.storage.persist()) ? "persisted" : "denied";
  } catch {
    // 隐私模式 / 企业策略 / 浏览器拒绝：申请失败不能连累笔记本打开。
    return "denied";
  }
}

function record(status: StoragePersistenceStatus): StoragePersistenceStatus {
  storagePersistenceStore.set({ status, checkedAt: Date.now() });
  return status;
}

/** 正在进行的检查 / 申请；并发调用共用这一个，避免「新建 + 打开」在同一个 tick 里各弹一次授权框。 */
let inFlight: Promise<StoragePersistenceStatus> | null = null;
/**
 * 本会话是否已经调用过 `persist()`。Firefox 等浏览器的 `persist()` 会弹权限框，
 * 用户拒绝过一次就不该在每次新建 / 切换笔记本时再打扰 —— 之后只用 `persisted()` 只读查询，
 * 这样用户在站点设置里手动放行后也能被看到。
 */
let requested = false;

function run(task: () => Promise<StoragePersistenceStatus>): Promise<StoragePersistenceStatus> {
  if (!inFlight) {
    inFlight = task()
      .then(record)
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/**
 * 为浏览器笔记本申请持久存储，并把结果写进 store。每个会话最多真正调用一次 `persist()`。
 *
 * **永不抛错**：调用方在打开笔记本的路径上，存储策略失败不能把笔记本变成打不开。
 */
export async function ensureStoragePersistence(): Promise<StoragePersistenceStatus> {
  // 正赶上一次只读刷新：等它结束再申请，不能搭只读查询的便车把申请跳过去。
  if (!requested && inFlight) await inFlight;
  if (!requested) {
    requested = true;
    return run(requestPersistence);
  }
  return run(queryPersisted);
}

/** 只读刷新当前状态（不向用户发申请），比如打开设置时。永不抛错。 */
export function refreshStoragePersistence(): Promise<StoragePersistenceStatus> {
  return run(queryPersisted);
}

/**
 * 打开笔记本时调用：只有浏览器笔记本（OPFS）才申请。桌面版 / FSA / Capacitor 是真实文件夹，
 * 返回 null，什么也不做。
 */
export function ensureStoragePersistenceFor(
  kind: string | null | undefined,
): Promise<StoragePersistenceStatus> | null {
  if (kind !== "opfs") return null;
  return ensureStoragePersistence();
}

/**
 * 顶部提示条是否该出现：当前是浏览器笔记本、状态有风险、且用户没在这个笔记本上点过「知道了」。
 */
export function shouldShowStorageNotice(
  workspace: { id: string; kind: string } | null | undefined,
  status: StoragePersistenceStatus | null,
  dismissed: ReadonlySet<string>,
): boolean {
  return workspace?.kind === "opfs" && isStorageAtRisk(status) && !dismissed.has(workspace.id);
}
