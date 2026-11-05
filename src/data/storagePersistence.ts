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
 */

export type StoragePersistenceStatus = "persisted" | "denied" | "unsupported";

export interface StoragePersistenceState {
  /** 最近一次检查针对的浏览器笔记本 id；null = 还没检查过任何笔记本。 */
  workspaceId: string | null;
  /** null = 检查还没完成。 */
  status: StoragePersistenceStatus | null;
}

export const storagePersistenceStore = createStore<StoragePersistenceState>({
  workspaceId: null,
  status: null,
});

export function useStoragePersistence(): StoragePersistenceState {
  return useStore(storagePersistenceStore);
}

/**
 * 这个运行时有没有 StorageManager 的持久化 API。
 *
 * Safari 等浏览器没有 `persist()`；此时只能如实说「申请不了」，而不是假装已持久化。
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

/** 只读查询当前是否已持久化，不向用户发申请。 */
export async function readStoragePersistence(): Promise<StoragePersistenceStatus> {
  if (!supportsStoragePersistence()) return "unsupported";
  try {
    return (await navigator.storage.persisted()) ? "persisted" : "denied";
  } catch {
    return "denied";
  }
}

async function requestPersistence(): Promise<StoragePersistenceStatus> {
  if (!supportsStoragePersistence()) return "unsupported";
  try {
    // 已经持久化就不再请求：部分浏览器会因此弹一次不必要的授权框。
    if (await navigator.storage.persisted()) return "persisted";
    return (await navigator.storage.persist()) ? "persisted" : "denied";
  } catch {
    // 隐私模式 / 企业策略 / 浏览器拒绝：申请失败不能连累笔记本打开。
    return "denied";
  }
}

/**
 * 同一个 origin 的持久化状态是共享的（`navigator.storage` 按 origin 生效，不是按目录），
 * 所以并发调用共用同一个请求，避免「新建 + 打开」在同一个 tick 里各弹一次授权框。
 */
let inFlight: Promise<StoragePersistenceStatus> | null = null;

/**
 * 为浏览器笔记本申请持久存储，并把结果写进 store。
 *
 * **永不抛错**：调用方在打开笔记本的路径上，存储策略失败不能把笔记本变成打不开。
 */
export async function ensureStoragePersistence(workspaceId: string): Promise<StoragePersistenceStatus> {
  if (!inFlight) {
    inFlight = requestPersistence().finally(() => {
      inFlight = null;
    });
  }
  const status = await inFlight;
  storagePersistenceStore.set({ workspaceId, status });
  return status;
}
