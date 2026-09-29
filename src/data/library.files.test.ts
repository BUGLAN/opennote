import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseName, joinPath, parentPath } from "../fs/paths";
import type { EntryInfo, FileSystemBackend } from "../fs/types";
import type { WorkspaceRecord } from "./workspaces";

let testBackend: MemoryBackend;
vi.mock("./workspaces", () => ({
  activeWorkspaceRecord: () => null,
  resolveBackend: async () => testBackend,
  setActiveWorkspace: () => undefined,
}));

import {
  deleteFolder,
  flushAll,
  flushMeta,
  getLibrary,
  openWorkspace,
  renameNote,
  rescanWorkspace,
  restoreNote,
  updateNoteContent,
} from "./library";

class MemoryBackend implements FileSystemBackend {
  readonly kind = "node";
  readonly label = "本机磁盘";
  readonly canWrite = true;
  readonly dirs = new Set([""]);
  readonly files = new Map<string, string | Uint8Array>();
  readonly calls: string[] = [];

  seed(path: string, text: string): void {
    this.mkdirSync(parentPath(path));
    this.files.set(path, text);
  }

  private mkdirSync(path: string): void {
    if (!path || this.dirs.has(path)) return;
    this.mkdirSync(parentPath(path));
    this.dirs.add(path);
  }

  async mkdir(path: string): Promise<void> { this.mkdirSync(path); }
  async list(path: string): Promise<EntryInfo[]> {
    this.calls.push(`list:${path}`);
    if (!this.dirs.has(path)) throw new Error(`ENOENT ${path}`);
    const dirEntries = [...this.dirs].filter((candidate) => candidate && parentPath(candidate) === path)
      .map((candidate) => ({ name: baseName(candidate), kind: "directory" as const, size: 0, mtimeMs: 1 }));
    const fileEntries = [...this.files].filter(([candidate]) => parentPath(candidate) === path)
      .map(([candidate, value]) => ({ name: baseName(candidate), kind: "file" as const, size: typeof value === "string" ? value.length : value.length, mtimeMs: 1 }));
    return [...dirEntries, ...fileEntries];
  }
  async readText(path: string): Promise<string> {
    this.calls.push(`read:${path}`);
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT ${path}`);
    return typeof value === "string" ? value : new TextDecoder().decode(value);
  }
  async readBytes(path: string): Promise<Uint8Array> { return new TextEncoder().encode(await this.readText(path)); }
  async writeText(path: string, text: string): Promise<void> {
    this.calls.push(`write:${path}`);
    this.mkdirSync(parentPath(path));
    this.files.set(path, text);
  }
  async writeBytes(path: string, bytes: Uint8Array | Blob): Promise<void> {
    this.mkdirSync(parentPath(path));
    this.files.set(path, bytes instanceof Blob ? new Uint8Array(await bytes.arrayBuffer()) : bytes);
  }
  async exists(path: string): Promise<boolean> { return this.dirs.has(path) || this.files.has(path); }
  async stat(path: string): Promise<{ size: number; mtimeMs: number } | null> {
    const value = this.files.get(path);
    return value === undefined ? null : { size: value.length, mtimeMs: 1 };
  }
  async move(from: string, to: string): Promise<void> {
    this.calls.push(`move:${from}->${to}`);
    if (await this.exists(to)) throw new Error(`EEXIST ${to}`);
    this.mkdirSync(parentPath(to));
    if (this.files.has(from)) {
      this.files.set(to, this.files.get(from)!);
      this.files.delete(from);
      return;
    }
    if (!this.dirs.has(from)) throw new Error(`ENOENT ${from}`);
    for (const [path, content] of [...this.files]) {
      if (path.startsWith(`${from}/`)) {
        this.files.delete(path);
        this.files.set(`${to}${path.slice(from.length)}`, content);
      }
    }
    for (const path of [...this.dirs].filter((dir) => dir === from || dir.startsWith(`${from}/`))) {
      this.dirs.delete(path);
      this.dirs.add(`${to}${path.slice(from.length)}`);
    }
  }
  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    this.calls.push(`remove:${path}`);
    if (this.files.delete(path)) return;
    if (!this.dirs.has(path)) throw new Error(`ENOENT ${path}`);
    const hasChildren = [...this.files.keys(), ...this.dirs].some((entry) => entry.startsWith(`${path}/`));
    if (hasChildren && !options?.recursive) throw new Error(`ENOTEMPTY ${path}`);
    for (const entry of [...this.files.keys()]) if (entry.startsWith(`${path}/`)) this.files.delete(entry);
    for (const entry of [...this.dirs]) if (entry === path || entry.startsWith(`${path}/`)) this.dirs.delete(entry);
  }
}

const record: WorkspaceRecord = { id: "test", name: "临时笔记本", kind: "node", location: "unused", addedAt: 1, lastOpenedAt: 1 };

beforeEach(async () => {
  testBackend = new MemoryBackend();
  testBackend.seed("故事/第一章.md", "# 第一章\n初稿");
  testBackend.seed("故事/子目录/第二章.md", "# 第二章\n草稿");
  testBackend.seed("故事/assets/封面.png", "pixels");
  await openWorkspace(record, { silent: true });
});

afterEach(async () => { await flushAll(); await flushMeta(); vi.restoreAllMocks(); });

describe("filesystem-backed workspace operations", () => {
  it("trashes the directory atomically, retains nested notes/assets and reloads the trash", async () => {
    await deleteFolder("故事", "trash");
    expect(testBackend.files.get(".opennote/trash/故事/第一章.md")).toBe("# 第一章\n初稿");
    expect(testBackend.files.get(".opennote/trash/故事/子目录/第二章.md")).toBe("# 第二章\n草稿");
    expect(testBackend.files.get(".opennote/trash/故事/assets/封面.png")).toBe("pixels");
    expect(getLibrary().notes["故事/第一章.md"]).toBeUndefined();
    await rescanWorkspace();
    expect(Object.keys(getLibrary().trash)).toContain(".opennote/trash/故事/第一章.md");
    expect(testBackend.calls).not.toContain("remove:.opennote/trash/故事");
  });

  it("restores a trashed note with its adjacent assets", async () => {
    await deleteFolder("故事", "trash");
    await restoreNote(".opennote/trash/故事/第一章.md");
    expect(testBackend.files.get("故事/第一章.md")).toBe("# 第一章\n初稿");
    expect(testBackend.files.get("故事/assets/封面.png")).toBe("pixels");
  });

  it("promotes children without flattening nested folders", async () => {
    await deleteFolder("故事", "promote");
    expect(testBackend.files.get("第一章.md")).toBe("# 第一章\n初稿");
    expect(testBackend.files.get("子目录/第二章.md")).toBe("# 第二章\n草稿");
    expect(testBackend.files.get("assets/封面.png")).toBe("pixels");
    expect(testBackend.dirs.has("故事")).toBe(false);
  });

  it("leaves the directory intact when promotion would overwrite an existing asset folder", async () => {
    testBackend.seed("assets/existing.png", "existing");
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await deleteFolder("故事", "promote");
    expect(testBackend.files.get("故事/第一章.md")).toBe("# 第一章\n初稿");
    expect(testBackend.files.get("assets/existing.png")).toBe("existing");
    expect(testBackend.calls.some((call) => call.startsWith("move:故事/"))).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("flushes pending edits before renaming so the new file keeps the latest text", async () => {
    updateNoteContent("故事/第一章.md", "# 改过\n未落盘");
    await renameNote("故事/第一章.md", "改名");
    expect(testBackend.files.get(joinPath("故事", "改名.md"))).toBe("# 改过\n未落盘");
    expect(testBackend.files.has("故事/第一章.md")).toBe(false);
  });
});
