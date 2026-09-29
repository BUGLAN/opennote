import { openDB } from "idb";

/**
 * IndexedDB is used here for exactly one thing: remembering the *handle* of a
 * folder the user granted access to. Handles are structured-cloneable objects
 * that cannot live in localStorage, and this is the API the platform provides
 * for persisting them. No note content ever goes through this database.
 */
const DB_NAME = "opennote-fs";
const STORE = "handles";

interface HandleRecord {
  id: string;
  name: string;
  addedAt: number;
  handle: FileSystemDirectoryHandle;
}

function db() {
  return openDB(DB_NAME, 1, {
    upgrade(database) {
      database.createObjectStore(STORE, { keyPath: "id" });
    },
  });
}

export async function putDirectoryHandle(id: string, handle: FileSystemDirectoryHandle, name?: string): Promise<void> {
  const record: HandleRecord = { id, name: name ?? handle.name, addedAt: Date.now(), handle };
  await (await db()).put(STORE, record);
}

export async function getDirectoryHandle(id: string): Promise<FileSystemDirectoryHandle | null> {
  const record = (await (await db()).get(STORE, id)) as HandleRecord | undefined;
  return record?.handle ?? null;
}

export async function deleteDirectoryHandle(id: string): Promise<void> {
  await (await db()).delete(STORE, id);
}

export async function listDirectoryHandles(): Promise<{ id: string; name: string; addedAt: number }[]> {
  const records = (await (await db()).getAll(STORE)) as HandleRecord[];
  return records.map(({ id, name, addedAt }) => ({ id, name, addedAt }));
}
