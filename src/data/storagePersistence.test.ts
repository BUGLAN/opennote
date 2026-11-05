import { afterEach, describe, expect, it, vi } from "vitest";

/** storagePersistence 模块有模块级 `inFlight` / `requested`，每个用例重新导入一份。 */
async function load() {
  vi.resetModules();
  return import("./storagePersistence");
}

function stubStorage(opts: { persisted?: () => Promise<boolean>; persist?: () => Promise<boolean> }) {
  const persist = vi.fn(opts.persist ?? (async () => false));
  const persisted = vi.fn(opts.persisted ?? (async () => false));
  vi.stubGlobal("navigator", { storage: { persist, persisted } });
  return { persist, persisted };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("浏览器存储持久化（issue #2）", () => {
  it("没有 StorageManager 持久化 API 时返回 unsupported，且绝不抛错", async () => {
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => null } });
    const { ensureStoragePersistence, supportsStoragePersistence, storagePersistenceStore } = await load();

    expect(supportsStoragePersistence()).toBe(false);
    await expect(ensureStoragePersistence()).resolves.toBe("unsupported");
    expect(storagePersistenceStore.get().status).toBe("unsupported");
    expect(storagePersistenceStore.get().checkedAt).toEqual(expect.any(Number));
  });

  it("navigator.storage 的 getter 抛错（站点数据被完全禁止）时也只按 unsupported 处理", async () => {
    const badNavigator = {};
    Object.defineProperty(badNavigator, "storage", {
      get() {
        throw new DOMException("Access to storage is not allowed from this context.", "SecurityError");
      },
    });
    vi.stubGlobal("navigator", badNavigator);
    const { ensureStoragePersistence, supportsStoragePersistence, storagePersistenceStore } = await load();

    expect(supportsStoragePersistence()).toBe(false);
    await expect(ensureStoragePersistence()).resolves.toBe("unsupported");
    expect(storagePersistenceStore.get().status).toBe("unsupported");
  });

  it("已经 persisted() 为 true 时不再调用 persist()", async () => {
    const { persist, persisted } = stubStorage({ persisted: async () => true, persist: async () => true });
    const { ensureStoragePersistence, storagePersistenceStore } = await load();

    await expect(ensureStoragePersistence()).resolves.toBe("persisted");
    expect(persisted).toHaveBeenCalledTimes(1);
    expect(persist).not.toHaveBeenCalled();
    expect(storagePersistenceStore.get().status).toBe("persisted");
  });

  it("未持久化时申请成功，状态记为 persisted", async () => {
    const { persist, persisted } = stubStorage({ persist: async () => true });
    const { ensureStoragePersistence, storagePersistenceStore } = await load();

    await expect(ensureStoragePersistence()).resolves.toBe("persisted");
    expect(persisted).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(storagePersistenceStore.get().status).toBe("persisted");
  });

  it("浏览器拒绝申请时状态记为 denied（不假装成功）", async () => {
    const { persist } = stubStorage({ persist: async () => false });
    const { ensureStoragePersistence, storagePersistenceStore } = await load();

    await expect(ensureStoragePersistence()).resolves.toBe("denied");
    expect(persist).toHaveBeenCalledTimes(1);
    expect(storagePersistenceStore.get().status).toBe("denied");
  });

  it("persist() 抛错（隐私模式 / 企业策略）时按 denied 记录，不把异常抛给打开流程", async () => {
    stubStorage({
      persist: async () => {
        throw new DOMException("The operation is not allowed.", "SecurityError");
      },
    });
    const { ensureStoragePersistence, storagePersistenceStore } = await load();

    await expect(ensureStoragePersistence()).resolves.toBe("denied");
    expect(storagePersistenceStore.get().status).toBe("denied");
  });

  it("persisted() 自己抛错时记为 unknown（无法确认），不调用 persist()", async () => {
    const { persist } = stubStorage({
      persist: async () => true,
      persisted: async () => {
        throw new Error("boom");
      },
    });
    const { ensureStoragePersistence, storagePersistenceStore } = await load();

    await expect(ensureStoragePersistence()).resolves.toBe("unknown");
    expect(persist).not.toHaveBeenCalled();
    expect(storagePersistenceStore.get().status).toBe("unknown");
  });

  it("本会话被拒过一次后不再调用 persist()，只做只读查询（不反复弹授权框）", async () => {
    const { persist, persisted } = stubStorage({ persist: async () => false });
    const { ensureStoragePersistence, storagePersistenceStore } = await load();

    await ensureStoragePersistence(); // 新建
    await ensureStoragePersistence(); // 打开
    await ensureStoragePersistence(); // 切换到另一个浏览器笔记本
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persisted).toHaveBeenCalledTimes(3);
    expect(storagePersistenceStore.get().status).toBe("denied");
  });

  it("用户事后在站点设置里放行，后续只读查询能看到 persisted", async () => {
    let granted = false;
    stubStorage({ persisted: async () => granted, persist: async () => false });
    const { ensureStoragePersistence, refreshStoragePersistence, storagePersistenceStore } = await load();

    await ensureStoragePersistence();
    expect(storagePersistenceStore.get().status).toBe("denied");

    granted = true;
    await expect(refreshStoragePersistence()).resolves.toBe("persisted");
    expect(storagePersistenceStore.get().status).toBe("persisted");
  });

  it("只读刷新不会发起持久化申请", async () => {
    const { persist } = stubStorage({ persist: async () => true });
    const { refreshStoragePersistence, storagePersistenceStore } = await load();

    await expect(refreshStoragePersistence()).resolves.toBe("denied");
    expect(persist).not.toHaveBeenCalled();
    expect(storagePersistenceStore.get().status).toBe("denied");
  });

  it("只读刷新进行中时发起申请，申请不会被只读结果吞掉", async () => {
    const { persist } = stubStorage({ persist: async () => true });
    const { refreshStoragePersistence, ensureStoragePersistence } = await load();

    const [refreshed, ensured] = await Promise.all([refreshStoragePersistence(), ensureStoragePersistence()]);
    expect(refreshed).toBe("denied");
    expect(ensured).toBe("persisted");
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("并发调用共用同一个申请（同一 origin 只申请一次）", async () => {
    const { persist } = stubStorage({ persist: async () => true });
    const { ensureStoragePersistence } = await load();

    const statuses = await Promise.all([ensureStoragePersistence(), ensureStoragePersistence()]);
    expect(statuses).toEqual(["persisted", "persisted"]);
    expect(persist).toHaveBeenCalledTimes(1);
  });
});

describe("打开笔记本时的触发与提示条件", () => {
  it("只有 OPFS 笔记本在打开时申请；FSA / 桌面 / Capacitor 不触发", async () => {
    const { persist, persisted } = stubStorage({ persist: async () => false });
    const { ensureStoragePersistenceFor } = await load();

    expect(ensureStoragePersistenceFor("fsa")).toBeNull();
    expect(ensureStoragePersistenceFor("node")).toBeNull();
    expect(ensureStoragePersistenceFor("capacitor")).toBeNull();
    expect(ensureStoragePersistenceFor(null)).toBeNull();
    expect(persisted).not.toHaveBeenCalled();

    await expect(ensureStoragePersistenceFor("opfs")).resolves.toBe("denied");
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("提示条：OPFS + 有风险才出现；已持久化 / 未检查 / 非 OPFS / 已关闭都不出现", async () => {
    const { shouldShowStorageNotice } = await load();
    const opfs = { id: "a", kind: "opfs" };
    const none = new Set<string>();

    expect(shouldShowStorageNotice(opfs, "denied", none)).toBe(true);
    expect(shouldShowStorageNotice(opfs, "unsupported", none)).toBe(true);
    expect(shouldShowStorageNotice(opfs, "unknown", none)).toBe(true);
    expect(shouldShowStorageNotice(opfs, "persisted", none)).toBe(false);
    expect(shouldShowStorageNotice(opfs, null, none)).toBe(false);
    expect(shouldShowStorageNotice({ id: "f", kind: "fsa" }, "denied", none)).toBe(false);
    expect(shouldShowStorageNotice(null, "denied", none)).toBe(false);
  });

  it("关闭按笔记本分别记：A、B 先后关闭后回到 A 也不再出现", async () => {
    const { shouldShowStorageNotice } = await load();
    const dismissed = new Set(["a", "b"]);

    expect(shouldShowStorageNotice({ id: "a", kind: "opfs" }, "denied", dismissed)).toBe(false);
    expect(shouldShowStorageNotice({ id: "b", kind: "opfs" }, "denied", dismissed)).toBe(false);
    expect(shouldShowStorageNotice({ id: "c", kind: "opfs" }, "denied", dismissed)).toBe(true);
  });
});
