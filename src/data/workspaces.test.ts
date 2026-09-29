import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryFileSystem } from "../fs/testing/memoryHandles";

const STORAGE_KEY = "opennote.workspaces.v1";

interface FakeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function memoryStorage(initial?: unknown): FakeStorage {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(STORAGE_KEY, JSON.stringify(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

/** workspaces.ts 在模块加载时就读取 localStorage，所以先铺全局再导入。 */
async function setup(initial?: unknown): Promise<{
  fs: typeof import("../fs");
  workspaces: typeof import("./workspaces");
}> {
  vi.stubGlobal("localStorage", memoryStorage(initial));
  vi.resetModules();
  const fs = await import("../fs");
  const workspaces = await import("./workspaces");
  return { fs, workspaces };
}

const fsaRecord = (id: string, location: string, name = "浏览器文件夹") => ({
  id,
  name,
  kind: "fsa" as const,
  location,
  addedAt: 1,
  lastOpenedAt: 1,
});

const nodeRecord = (location: string) => ({
  id: "本机",
  name: "本机笔记本",
  kind: "node" as const,
  location,
  addedAt: 1,
  lastOpenedAt: 1,
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("浏览器文件夹的句柄键（D32）", () => {
  it("两个浏览器文件夹各自独立，第二个不再覆盖第一个的句柄", async () => {
    const { fs, workspaces } = await setup();
    fs.setDirectoryHandleStore(fs.createMemoryDirectoryHandleStore());

    const folderA = new MemoryFileSystem();
    folderA.seedFile("A.md", "AAA");
    const folderB = new MemoryFileSystem();
    folderB.seedFile("B.md", "BBB");

    vi.stubGlobal("window", { showDirectoryPicker: async () => folderA.root });
    const recordA = await workspaces.addLocalFolder();
    vi.stubGlobal("window", { showDirectoryPicker: async () => folderB.root });
    const recordB = await workspaces.addLocalFolder();

    expect(recordA).not.toBeNull();
    expect(recordB).not.toBeNull();
    expect(recordA!.location).not.toBe("");
    expect(recordB!.location).not.toBe("");
    expect(recordA!.location).not.toBe(recordB!.location);
    expect(workspaces.listWorkspaces().map((workspace) => workspace.id).sort()).toEqual(
      [recordA!.id, recordB!.id].sort(),
    );

    const stored = await fs.listDirectoryHandles();
    expect(stored.map((entry) => entry.id).sort()).toEqual([recordA!.location, recordB!.location].sort());

    expect(await (await workspaces.resolveBackend(recordA!)).readText("A.md")).toBe("AAA");
    expect(await (await workspaces.resolveBackend(recordB!)).readText("B.md")).toBe("BBB");
  });

  it("忘记其中一个文件夹只删它自己的句柄", async () => {
    const { fs, workspaces } = await setup();
    fs.setDirectoryHandleStore(fs.createMemoryDirectoryHandleStore());

    const folderA = new MemoryFileSystem();
    folderA.seedFile("A.md", "AAA");
    const folderB = new MemoryFileSystem();
    folderB.seedFile("B.md", "BBB");

    vi.stubGlobal("window", { showDirectoryPicker: async () => folderA.root });
    const recordA = await workspaces.addLocalFolder();
    vi.stubGlobal("window", { showDirectoryPicker: async () => folderB.root });
    const recordB = await workspaces.addLocalFolder();

    await workspaces.forgetWorkspace(recordA!.id);
    await expect(fs.getDirectoryHandle(recordA!.location)).resolves.toBeNull();
    await expect(fs.getDirectoryHandle(recordB!.location)).resolves.not.toBeNull();
    expect(await (await workspaces.resolveBackend(recordB!)).readText("B.md")).toBe("BBB");
  });

  it("重复选中同一个文件夹时复用已有记录，不再产生第二个句柄", async () => {
    const { fs, workspaces } = await setup();
    fs.setDirectoryHandleStore(fs.createMemoryDirectoryHandleStore());

    const folder = new MemoryFileSystem();
    folder.seedFile("A.md", "AAA");
    vi.stubGlobal("window", { showDirectoryPicker: async () => folder.root });

    const first = await workspaces.addLocalFolder();
    const second = await workspaces.addLocalFolder();

    expect(second!.id).toBe(first!.id);
    expect(workspaces.listWorkspaces()).toHaveLength(1);
    expect(await fs.listDirectoryHandles()).toHaveLength(1);
  });

  it("旧记录 location===\"\" 时尽量迁移到 uid 键", async () => {
    const { fs, workspaces } = await setup({ workspaces: [fsaRecord("旧", "")], activeId: null });

    const legacyFolder = new MemoryFileSystem();
    legacyFolder.seedFile("旧笔记.md", "LEGACY");
    const store = fs.createMemoryDirectoryHandleStore();
    await store.put({ id: "", name: "旧文件夹", addedAt: 1, handle: legacyFolder.root });
    fs.setDirectoryHandleStore(store);

    const record = workspaces.listWorkspaces()[0];
    const backend = await workspaces.resolveBackend(record);
    expect(await backend.readText("旧笔记.md")).toBe("LEGACY");

    const migrated = workspaces.listWorkspaces()[0];
    expect(migrated.location).not.toBe("");
    await expect(fs.getDirectoryHandle("")).resolves.toBeNull();
    await expect(fs.getDirectoryHandle(migrated.location)).resolves.not.toBeNull();
  });

  it("旧记录读不到旧句柄时给出明确中文提示", async () => {
    const { fs, workspaces } = await setup({ workspaces: [fsaRecord("旧", "")], activeId: null });
    fs.setDirectoryHandleStore(fs.createMemoryDirectoryHandleStore());

    const record = workspaces.listWorkspaces()[0];
    await expect(workspaces.resolveBackend(record)).rejects.toThrow(/重新选择/);
  });
});

describe("桌面端 root 授权闸门（D20）", () => {
  it("主进程拒绝授权时给出中文提示，并且先问的是这个 root", async () => {
    const calls: string[] = [];
    vi.stubGlobal("window", {
      opennote: {
        isElectron: true,
        fs: {
          authorizeRoot: async (root: string) => {
            calls.push(root);
            return false;
          },
        },
      },
    });
    const { workspaces } = await setup();

    await expect(workspaces.resolveBackend(nodeRecord("C:\\笔记"))).rejects.toThrow(
      "这个文件夹还没有授权，请用「添加文件夹」重新选择一次",
    );
    expect(calls).toEqual(["C:\\笔记"]);
  });

  it("主进程授权后正常返回 node 后端", async () => {
    const calls: string[] = [];
    vi.stubGlobal("window", {
      opennote: {
        isElectron: true,
        fs: {
          authorizeRoot: async (root: string) => {
            calls.push(root);
            return true;
          },
        },
      },
    });
    const { workspaces } = await setup();

    const backend = await workspaces.resolveBackend(nodeRecord("C:\\笔记"));
    expect(backend.kind).toBe("node");
    expect(calls).toEqual(["C:\\笔记"]);
  });

  it("旧版 preload 没有 authorizeRoot 时不阻塞（兼容开发态 / 旧包）", async () => {
    vi.stubGlobal("window", { opennote: { isElectron: true, fs: {} } });
    const { workspaces } = await setup();
    const backend = await workspaces.resolveBackend(nodeRecord("C:\\笔记"));
    expect(backend.kind).toBe("node");
  });
});

describe("OPFS 工作区登记（D32 相关回归）", () => {
  it("opfs 记录用目录名做 location，forget 不会去删句柄", async () => {
    const { fs, workspaces } = await setup();
    const store = fs.createMemoryDirectoryHandleStore();
    fs.setDirectoryHandleStore(store);

    const opfs = new MemoryFileSystem();
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => opfs.root } });
    const record = await workspaces.createBrowserWorkspace("我的笔记");
    expect(record.location).toBe("我的笔记");

    const backend = await workspaces.resolveBackend(record);
    await backend.writeText("a.md", "A");
    expect(opfs.readText("opennote/我的笔记/a.md")).toBe("A");

    await workspaces.forgetWorkspace(record.id);
    expect(await store.list()).toEqual([]);
    expect(opfs.readText("opennote/我的笔记/a.md")).toBe("A");
  });
});

describe("存储被禁用时仍能启动（与 D04 同源）", () => {
  it("localStorage 是抛 SecurityError 的 getter 时，模块加载与写入都不抛", async () => {
    vi.resetModules();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Access to storage is not allowed from this context.", "SecurityError");
      },
    });

    const workspaces = await import("./workspaces");
    expect(workspaces.listWorkspaces()).toEqual([]);
    expect(() => workspaces.rememberWorkspace({ name: "浏览器本地", kind: "opfs", location: "浏览器本地" })).not.toThrow();
    expect(workspaces.listWorkspaces()).toHaveLength(1);
  });
});
