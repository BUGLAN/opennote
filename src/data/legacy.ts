import { openDB } from "idb";

/**
 * Read-only access to the database used by Opennote ≤ 0.1, purely to offer a
 * one-time migration into a real folder (and to keep old `asset://` images
 * visible until the user migrates). Nothing is ever written here again.
 */
const DB_NAME = "opennote";
const NOTES = "notes";
const ASSETS = "assets";

export interface LegacyNote {
  id: string;
  title: string;
  content: string;
  folderId: string | null;
  createdAt?: number;
  updatedAt?: number;
  starred?: boolean;
}

export interface LegacyFolder {
  id: string;
  name: string;
  parentId: string | null;
}

async function legacyDb() {
  return openDB(DB_NAME, undefined, {
    upgrade() {
      // the database may not exist at all — creating an empty shell is fine
    },
  });
}

export async function hasLegacyData(): Promise<boolean> {
  try {
    const db = await legacyDb();
    if (!db.objectStoreNames.contains(NOTES)) return false;
    const count = await db.count(NOTES);
    db.close();
    return count > 0;
  } catch {
    return false;
  }
}

export async function readLegacyNotes(): Promise<{ notes: LegacyNote[]; folders: LegacyFolder[] }> {
  try {
    const db = await legacyDb();
    if (!db.objectStoreNames.contains(NOTES)) {
      db.close();
      return { notes: [], folders: [] };
    }
    const notes = (await db.getAll(NOTES)) as LegacyNote[];
    const folders = db.objectStoreNames.contains("folders")
      ? ((await db.getAll("folders")) as LegacyFolder[])
      : [];
    db.close();
    return { notes: notes.filter((note) => note && !(note as { trashed?: boolean }).trashed), folders };
  } catch {
    return { notes: [], folders: [] };
  }
}

export async function getLegacyAsset(id: string): Promise<Blob | null> {
  try {
    const db = await legacyDb();
    if (!db.objectStoreNames.contains(ASSETS)) {
      db.close();
      return null;
    }
    const record = (await db.get(ASSETS, id)) as { blob?: Blob } | undefined;
    db.close();
    return record?.blob ?? null;
  } catch {
    return null;
  }
}
