import { describe, expect, it, vi } from "vitest";
import { scanWorkspace } from "./library";
import { listOptionalDirectory, readOptionalText } from "./optionalFiles";
import type { EntryInfo, FileSystemBackend } from "../fs/types";

const file = (name: string): EntryInfo => ({ name, kind: "file", size: 12, mtimeMs: 100 });
const dir = (name: string): EntryInfo => ({ name, kind: "directory", size: 0, mtimeMs: 100 });

function backend(entries: Record<string, EntryInfo[]>, files: Record<string, string>): FileSystemBackend {
  return {
    kind: "node", label: "本机磁盘", canWrite: true,
    list: vi.fn(async (path) => {
      if (!(path in entries)) throw new Error(`ENOENT: ${path}`);
      return entries[path];
    }),
    exists: vi.fn(async (path) => path in entries || path in files),
    readText: vi.fn(async (path) => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      return files[path];
    }),
    readBytes: vi.fn(async () => new Uint8Array()),
    writeText: vi.fn(async () => {}), writeBytes: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}), remove: vi.fn(async () => {}), move: vi.fn(async () => {}),
    stat: vi.fn(async () => null),
  };
}

describe("optional workspace files", () => {
  it("does not send read/list IPC calls for missing metadata and history", async () => {
    const fs = backend({}, {});
    expect(await readOptionalText(fs, ".opennote/state.json")).toBeUndefined();
    expect(await listOptionalDirectory(fs, ".opennote/history/new.md")).toEqual([]);
    expect(fs.readText).not.toHaveBeenCalled();
    expect(fs.list).not.toHaveBeenCalled();
  });

  it("still reads existing files and reports actual failures", async () => {
    const fs = backend({ ".opennote/history/n.md": [file("1.md")] }, { ".opennote/state.json": "{}" });
    expect(await readOptionalText(fs, ".opennote/state.json")).toBe("{}");
    expect(await listOptionalDirectory(fs, ".opennote/history/n.md")).toHaveLength(1);
    vi.mocked(fs.readText).mockRejectedValueOnce(new Error("EACCES"));
    await expect(readOptionalText(fs, ".opennote/state.json")).rejects.toThrow("EACCES");
  });
});

describe("scanWorkspace", () => {
  it("keeps hidden/build folders out of the tree and loads trashed notes separately", async () => {
    const fs = backend(
      {
        "": [dir(".git"), dir(".opennote"), dir("node_modules"), dir("assets"), dir("日记"), file("根笔记.md")],
        "日记": [file("九月.md")],
        ".opennote/trash": [dir("旧文件夹")],
        ".opennote/trash/旧文件夹": [file("删掉.md")],
      },
      {
        "根笔记.md": "# 根笔记",
        "日记/九月.md": "# 九月",
        ".opennote/trash/旧文件夹/删掉.md": "# 删掉",
      },
    );
    const result = await scanWorkspace(fs);
    expect(Object.keys(result.folders)).toEqual(["日记"]);
    expect(Object.keys(result.notes)).toEqual(["日记/九月.md", "根笔记.md"]);
    expect(Object.keys(result.trash)).toEqual([".opennote/trash/旧文件夹/删掉.md"]);
    expect(result.trash[".opennote/trash/旧文件夹/删掉.md"].trashed).toBe(true);
    expect(fs.list).not.toHaveBeenCalledWith(".git");
    expect(fs.readText).not.toHaveBeenCalledWith(".opennote/state.json");
  });
});
