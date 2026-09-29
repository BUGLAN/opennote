import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Asset, Folder, Note, Snapshot } from "./types";

export interface OpennoteSchema extends DBSchema {
  notes: { key: string; value: Note };
  folders: { key: string; value: Folder };
  assets: { key: string; value: Asset };
  snapshots: { key: string; value: Snapshot; indexes: { by_note: string } };
  meta: { key: string; value: { key: string; value: unknown } };
}

export const DB_NAME = "opennote";
export const DB_VERSION = 1;

let handle: Promise<IDBPDatabase<OpennoteSchema>> | null = null;

export function db(): Promise<IDBPDatabase<OpennoteSchema>> {
  if (!handle) {
    handle = openDB<OpennoteSchema>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        database.createObjectStore("notes", { keyPath: "id" });
        database.createObjectStore("folders", { keyPath: "id" });
        database.createObjectStore("assets", { keyPath: "id" });
        const snapshots = database.createObjectStore("snapshots", { keyPath: "id" });
        snapshots.createIndex("by_note", "noteId");
        database.createObjectStore("meta", { keyPath: "key" });
      },
      blocked() {
        console.warn("[opennote] another tab is holding an older database version");
      },
    }).catch((error) => {
      handle = null;
      throw error;
    });
  }
  return handle;
}

/* ------------------------------------------------------------------- notes */

export async function readAllNotes(): Promise<Note[]> {
  return (await db()).getAll("notes");
}

export async function writeNote(note: Note): Promise<void> {
  await (await db()).put("notes", note);
}

export async function writeNotes(notes: Note[]): Promise<void> {
  const database = await db();
  const tx = database.transaction("notes", "readwrite");
  await Promise.all([...notes.map((note) => tx.store.put(note)), tx.done]);
}

export async function removeNote(id: string): Promise<void> {
  await (await db()).delete("notes", id);
}

export async function removeNotes(ids: string[]): Promise<void> {
  const database = await db();
  const tx = database.transaction("notes", "readwrite");
  await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done]);
}

/* ----------------------------------------------------------------- folders */

export async function readAllFolders(): Promise<Folder[]> {
  return (await db()).getAll("folders");
}

export async function writeFolder(folder: Folder): Promise<void> {
  await (await db()).put("folders", folder);
}

export async function writeFolders(folders: Folder[]): Promise<void> {
  const database = await db();
  const tx = database.transaction("folders", "readwrite");
  await Promise.all([...folders.map((folder) => tx.store.put(folder)), tx.done]);
}

export async function removeFolder(id: string): Promise<void> {
  await (await db()).delete("folders", id);
}

/* ------------------------------------------------------------------ assets */

export async function readAllAssets(): Promise<Asset[]> {
  return (await db()).getAll("assets");
}

export async function readAsset(id: string): Promise<Asset | undefined> {
  return (await db()).get("assets", id);
}

export async function writeAsset(asset: Asset): Promise<void> {
  await (await db()).put("assets", asset);
}

export async function removeAsset(id: string): Promise<void> {
  await (await db()).delete("assets", id);
}

/* --------------------------------------------------------------- snapshots */

export async function readSnapshots(noteId: string): Promise<Snapshot[]> {
  return (await db()).getAllFromIndex("snapshots", "by_note", noteId);
}

export async function writeSnapshot(snapshot: Snapshot): Promise<void> {
  await (await db()).put("snapshots", snapshot);
}

export async function removeSnapshot(id: string): Promise<void> {
  await (await db()).delete("snapshots", id);
}

export async function removeSnapshots(ids: string[]): Promise<void> {
  const database = await db();
  const tx = database.transaction("snapshots", "readwrite");
  await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done]);
}

export async function pruneSnapshots(noteId: string, keep: number): Promise<void> {
  const all = await readSnapshots(noteId);
  if (all.length <= keep) return;
  const sorted = all.sort((a, b) => b.createdAt - a.createdAt);
  await removeSnapshots(sorted.slice(keep).map((snapshot) => snapshot.id));
}

export async function clearAll(): Promise<void> {
  const database = await db();
  for (const store of ["notes", "folders", "assets", "snapshots", "meta"] as const) {
    await database.clear(store);
  }
}

export async function estimateUsage(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota };
}

/** Ask the browser to keep our data out of eviction sweeps. */
export async function requestPersistence(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
