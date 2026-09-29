import { beforeEach, describe, expect, it } from "vitest";
import {
  folderPathLabel,
  notesInFolder,
  replaceLibrary,
  searchNotes,
  sortNotes,
  type LibraryState,
} from "../data/library";
import type { Folder, Note } from "../data/types";
import { zipPathFor } from "./export";
import { parseBackupJson, parseMarkdownFileName } from "./import";

function note(partial: Partial<Note> & { id: string; title: string; content: string }): Note {
  const now = Date.parse("2025-05-05T12:00:00");
  return {
    folderId: null,
    titleOverride: null,
    createdAt: now,
    updatedAt: now,
    openedAt: now,
    starred: false,
    tags: [],
    chars: partial.content.length,
    words: 1,
    trashed: false,
    trashedAt: null,
    ...partial,
  } as Note;
}

function folder(id: string, name: string, parentId: string | null = null): Folder {
  return { id, name, parentId, createdAt: 0, updatedAt: 0 };
}

const folders = [folder("f1", "随笔"), folder("f2", "项目", "f1")];

const notes = [
  note({ id: "n1", title: "会议记录", content: "今天讨论了开源笔记的排版细节", folderId: "f1", tags: ["会议"] }),
  note({ id: "n2", title: "读书笔记", content: "关于写作与工具的一点思考", folderId: "f2", starred: true }),
  note({ id: "n3", title: "未归档草稿", content: "随手记下的东西", folderId: null }),
  note({ id: "n4", title: "删掉的", content: "旧内容", trashed: true }),
];

function state(): LibraryState {
  replaceLibrary(notes, folders);
  return {
    ready: true,
    notes: Object.fromEntries(notes.map((item) => [item.id, item])),
    folders: Object.fromEntries(folders.map((item) => [item.id, item])),
    error: null,
    dirty: {},
    lastSavedAt: null,
  };
}

describe("library selectors", () => {
  beforeEach(() => {
    replaceLibrary(notes, folders);
  });

  it("lists notes of a folder and its descendants", () => {
    const library = state();
    expect(notesInFolder(library, "f1", { descendants: false }).map((item) => item.id)).toEqual(["n1"]);
    expect(notesInFolder(library, "f1", { descendants: true }).map((item) => item.id).sort()).toEqual(["n1", "n2"]);
    expect(notesInFolder(library, null).map((item) => item.id)).toEqual(["n3"]);
    expect(notesInFolder(library, undefined).map((item) => item.id)).toEqual(["n1", "n2", "n3"]);
  });

  it("never mixes trashed notes into normal listings", () => {
    const library = state();
    expect(notesInFolder(library, undefined).some((item) => item.trashed)).toBe(false);
    expect(notesInFolder(library, undefined, { includeTrashed: true }).map((item) => item.id)).toContain("n4");
  });

  it("sorts by title with a CJK-aware collation", () => {
    const sorted = sortNotes([notes[1], notes[0], notes[2]], "title").map((item) => item.title);
    expect(sorted).toHaveLength(3);
    expect(sorted[0]).toBeTruthy();
  });

  it("builds readable folder paths", () => {
    expect(folderPathLabel("f2", Object.fromEntries(folders.map((item) => [item.id, item])))).toBe("随笔 / 项目");
    expect(folderPathLabel(null)).toBe("未归档");
  });
});

describe("searchNotes", () => {
  beforeEach(() => {
    replaceLibrary(notes, folders);
  });

  it("finds notes by body text with a snippet", () => {
    const hits = searchNotes("排版");
    expect(hits).toHaveLength(1);
    expect(hits[0].note.id).toBe("n1");
    expect(hits[0].snippet).toContain("排版");
  });

  it("ranks title matches above body matches", () => {
    const hits = searchNotes("笔记");
    expect(hits[0].note.id).toBe("n2");
  });

  it("requires every term to match", () => {
    expect(searchNotes("开源 排版")).toHaveLength(1);
    expect(searchNotes("开源 不存在的词")).toHaveLength(0);
  });

  it("skips trashed notes", () => {
    expect(searchNotes("旧内容")).toHaveLength(0);
  });

  it("returns nothing for an empty query", () => {
    expect(searchNotes("   ")).toEqual([]);
  });
});

describe("zip paths", () => {
  it("mirrors the folder tree", () => {
    expect(zipPathFor({ title: "会议记录", folderId: "f1" }, folders)).toBe("notes/随笔/会议记录.md");
    expect(zipPathFor({ title: "读书笔记", folderId: "f2" }, folders)).toBe("notes/随笔/项目/读书笔记.md");
    expect(zipPathFor({ title: "草稿", folderId: null }, folders)).toBe("notes/未归档/草稿.md");
  });

  it("sanitises illegal characters in titles", () => {
    expect(zipPathFor({ title: "a/b:c", folderId: null }, folders)).toBe("notes/未归档/a b c.md");
  });

  it("survives an unknown folder id", () => {
    expect(zipPathFor({ title: "x", folderId: "missing" }, folders)).toBe("notes/未归档/x.md");
  });
});

describe("import helpers", () => {
  it("splits relative markdown paths", () => {
    expect(parseMarkdownFileName("2024/日记/九月.md")).toEqual({ folderNames: ["2024", "日记"], title: "九月" });
    expect(parseMarkdownFileName("笔记.md")).toEqual({ folderNames: [], title: "笔记" });
    expect(parseMarkdownFileName("a\\b\\c.markdown")).toEqual({ folderNames: ["a", "b"], title: "c" });
  });

  it("parses a valid backup", () => {
    const parsed = parseBackupJson(
      JSON.stringify({ format: "opennote-backup", notes: [{ title: "a" }], folders: [], assets: [{ id: "x", path: "assets/x" }] }),
    );
    expect(parsed?.notes).toHaveLength(1);
    expect(parsed?.assets[0].id).toBe("x");
  });

  it("rejects foreign or broken json", () => {
    expect(parseBackupJson("not json")).toBeNull();
    expect(parseBackupJson(JSON.stringify({ format: "something-else" }))).toBeNull();
    expect(parseBackupJson("[]")).toBeNull();
  });
});
