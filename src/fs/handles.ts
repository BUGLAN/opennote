import { openDB } from "idb";

/**
 * IndexedDB is used here for exactly one thing: remembering the *handle* of a
 * folder the user granted access to. Handles are structured-cloneable objects
 * that cannot live in localStorage, and this is the API the platform provides
 * for persisting them. No note content ever goes through this database.
 *
 * The storage layer sits behind `DirectoryHandleStore` so the registry can be
 * unit-tested without IndexedDB (Node / vitest has none) — see D32.
 */
const DB_NAME = "opennote-fs";
const STORE = "handles";

export interface StoredDirectoryHandle {
  id: string;
  name: string;
  addedAt: number;
  handle: FileSystemDirectoryHandle;
}

export interface DirectoryHandleStore {
  put(record: StoredDirectoryHandle): Promise<void>;
  get(id: string): Promise<StoredDirectoryHandle | undefined>;
  delete(id: string): Promise<void>;
  list(): Promise<StoredDirectoryHandle[]>;
}

function indexedDbStore(): DirectoryHandleStore {
  let pending: ReturnType<typeof openDB> | null = null;
  const db = () => {
    pending ??= openDB(DB_NAME, 1, {
      upgrade(database) {
        database.createObjectStore(STORE, { keyPath: "id" });
      },
    });
    return pending;
  };
  return {
    async put(record) {
      await (await db()).put(STORE, record);
    },
    async get(id) {
      return (await (await db()).get(STORE, id)) as StoredDirectoryHandle | undefined;
    },
    async delete(id) {
      await (await db()).delete(STORE, id);
    },
    async list() {
      return (await (await db()).getAll(STORE)) as StoredDirectoryHandle[];
    },
  };
}

/** 内存实现：测试用（也是「浏览器不给我们 IndexedDB」时的兜底思路）。 */
export function createMemoryDirectoryHandleStore(): DirectoryHandleStore {
  const records = new Map<string, StoredDirectoryHandle>();
  return {
    async put(record) {
      records.set(record.id, record);
    },
    async get(id) {
      return records.get(id);
    },
    async delete(id) {
      records.delete(id);
    },
    async list() {
      return [...records.values()].sort((a, b) => a.addedAt - b.addedAt);
    },
  };
}

let store: DirectoryHandleStore | null = null;

function currentStore(): DirectoryHandleStore {
  store ??= indexedDbStore();
  return store;
}

/** 替换存储层；传 null 恢复默认的 IndexedDB 实现。 */
export function setDirectoryHandleStore(next: DirectoryHandleStore | null): void {
  store = next;
}

export async function putDirectoryHandle(id: string, handle: FileSystemDirectoryHandle, name?: string): Promise<void> {
  const record: StoredDirectoryHandle = { id, name: name ?? handle.name, addedAt: Date.now(), handle };
  await currentStore().put(record);
}

export async function getDirectoryHandle(id: string): Promise<FileSystemDirectoryHandle | null> {
  const record = await currentStore().get(id);
  return record?.handle ?? null;
}

export async function deleteDirectoryHandle(id: string): Promise<void> {
  await currentStore().delete(id);
}

export async function listDirectoryHandles(): Promise<{ id: string; name: string; addedAt: number }[]> {
  const records = await currentStore().list();
  return records.map(({ id, name, addedAt }) => ({ id, name, addedAt }));
}
