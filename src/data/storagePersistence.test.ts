import { afterEach, describe, expect, it, vi } from "vitest";

/** storagePersistence 模块有模块级 `inFlight`，每个用例重新导入一份。 */
async function load() {
  vi.resetModules();
  return import("./storagePersistence");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("浏览器存储持久化（issue #2）", () => {
  it("没有 StorageManager 持久化 API 时返回 unsupported，且绝不抛错", async () => {
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => null } });
    const { ensureStoragePersistence, supportsStoragePersistence, storagePersistenceStore } = await load();

    expect(supportsStoragePersistence()).toBe(false);
    await expect(ensureStoragePersistence("浏览器笔记本")).resolves.toBe("unsupported");
    expect(storagePersistenceStore.get()).toEqual({ workspaceId: "浏览器笔记本", status: "unsupported" });
  });

  it("navigator.storage 的 getter 抛错（站点数据被完全禁止）时也只按 unsupported 处理", async () => {
    const badNavigator = {};
    Object.defineProperty(badNavigator, "storage", {
      get() {
        throw new DOMException("Access to storage is not allowed from this context.", "SecurityError");
      },
    });
    vi.stubGlobal("navigator", badNavigator);
    const { ensureStoragePersistence, supportsStoragePersistence } = await load();

    expect(supportsStoragePersistence()).toBe(false);
    await expect(ensureStoragePersistence("w1")).resolves.toBe("unsupported");
  });

  it("已经 persisted() 为 true 时不再调用 persist()", async () => {
    const persist = vi.fn(async () => true);
    const persisted = vi.fn(async () => true);
    vi.stubGlobal("navigator", { storage: { persist, persisted } });
    const { ensureStoragePersistence } = await load();

    await expect(ensureStoragePersistence("w1")).resolves.toBe("persisted");
    expect(persisted).toHaveBeenCalledTimes(1);
    expect(persist).not.toHaveBeenCalled();
  });

  it("未持久化时申请成功，状态记为 persisted", async () => {
    const persist = vi.fn(async () => true);
    const persisted = vi.fn(async () => false);
    vi.stubGlobal("navigator", { storage: { persist, persisted } });
    const { ensureStoragePersistence, storagePersistenceStore } = await load();

    await expect(ensureStoragePersistence("w1")).resolves.toBe("persisted");
    expect(persisted).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(storagePersistenceStore.get()).toEqual({ workspaceId: "w1", status: "persisted" });
  });

  it("浏览器拒绝申请时状态记为 denied（不假装成功）", async () => {
    const persist = vi.fn(async () => false);
    const persisted = vi.fn(async () => false);
    vi.stubGlobal("navigator", { storage: { persist, persisted } });
    const { ensureStoragePersistence } = await load();

    await expect(ensureStoragePersistence("w1")).resolves.toBe("denied");
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("persist() 抛错（隐私模式 / 企业策略）时按 denied 返回，不把异常抛给打开流程", async () => {
    const persist = vi.fn(async () => {
      throw new DOMException("The operation is not allowed.", "SecurityError");
    });
    const persisted = vi.fn(async () => false);
    vi.stubGlobal("navigator", { storage: { persist, persisted } });
    const { ensureStoragePersistence } = await load();

    await expect(ensureStoragePersistence("w1")).resolves.toBe("denied");
  });

  it("persisted() 自己抛错时也按 denied 返回", async () => {
    const persist = vi.fn(async () => true);
    const persisted = vi.fn(async () => {
      throw new Error("boom");
    });
    vi.stubGlobal("navigator", { storage: { persist, persisted } });
    const { ensureStoragePersistence } = await load();

    await expect(ensureStoragePersistence("w1")).resolves.toBe("denied");
    expect(persist).not.toHaveBeenCalled();
  });

  it("只读查询不会发起持久化申请", async () => {
    const persist = vi.fn(async () => true);
    const persisted = vi.fn(async () => false);
    vi.stubGlobal("navigator", { storage: { persist, persisted } });
    const { readStoragePersistence } = await load();

    await expect(readStoragePersistence()).resolves.toBe("denied");
    expect(persist).not.toHaveBeenCalled();
  });

  it("并发调用共用同一个申请（同一 origin 只申请一次）", async () => {
    const persist = vi.fn(async () => true);
    const persisted = vi.fn(async () => false);
    vi.stubGlobal("navigator", { storage: { persist, persisted } });
    const { ensureStoragePersistence } = await load();

    const statuses = await Promise.all([ensureStoragePersistence("a"), ensureStoragePersistence("b")]);
    expect(statuses).toEqual(["persisted", "persisted"]);
    expect(persist).toHaveBeenCalledTimes(1);
  });
});
