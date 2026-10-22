/**
 * `tagTree()` 的形状测试（「标签」页树形化的数据层）：层级归并、计数口径、
 * 排序与脏数据兜底。它只读 `state.notes`，所以直接喂最小状态。
 */
import { describe, expect, it } from "vitest";
import { tagTree, type LibraryState } from "./library";
import type { Note } from "./types";

let seq = 0;
function makeNote(tags: string[], extra: Partial<Note> = {}): Note {
  seq += 1;
  return {
    id: `note-${seq}`,
    folderId: null,
    title: `笔记${seq}`,
    titleOverride: null,
    content: "",
    createdAt: seq,
    updatedAt: seq,
    openedAt: seq,
    starred: false,
    tags,
    chars: 0,
    words: 0,
    trashed: false,
    trashedAt: null,
    ...extra,
  };
}

function stateOf(notes: Note[]): LibraryState {
  return { notes: Object.fromEntries(notes.map((note) => [note.id, note])) } as unknown as LibraryState;
}

describe("tagTree", () => {
  it("扁平标签按「计数降序、同数按字典序」排成一层", () => {
    const tree = tagTree(stateOf([makeNote([]), makeNote(["b"]), makeNote(["a"]), makeNote(["a"])]));
    expect(tree.map((node) => node.path)).toEqual(["a", "b"]);
    expect(tree[0].total).toBe(2);
    expect(tree[1].total).toBe(1);
  });

  it("#父/子 按路径切层级：直接打父标签的笔记留在父节点，total 聚合子孙", () => {
    const tree = tagTree(stateOf([makeNote(["os"]), makeNote(["os/linux"]), makeNote(["os/windows"])]));
    expect(tree.map((node) => node.path)).toEqual(["os"]);
    expect(tree[0].notes).toHaveLength(1);
    expect(tree[0].children.map((child) => child.path)).toEqual(["os/linux", "os/windows"]);
    expect(tree[0].children.map((child) => child.name)).toEqual(["linux", "windows"]);
    expect(tree[0].total).toBe(3);
  });

  it("只有 a/b 时也补出父节点 a（空分支照样可展开，计数只算子标签）", () => {
    const tree = tagTree(stateOf([makeNote(["a/b"])]));
    expect(tree.map((node) => node.path)).toEqual(["a"]);
    expect(tree[0].notes).toHaveLength(0);
    expect(tree[0].total).toBe(1);
    expect(tree[0].children[0]?.path).toBe("a/b");
  });

  it("同一篇笔记重复写同一个标签只计一次（front matter 与正文双写是常态）", () => {
    const tree = tagTree(stateOf([makeNote(["z", "z"])]));
    expect(tree[0].total).toBe(1);
    expect(tree[0].notes).toHaveLength(1);
  });

  it("回收站里的笔记不进树", () => {
    const tree = tagTree(stateOf([makeNote(["gone"], { trashed: true }), makeNote(["keep"])]));
    expect(tree.map((node) => node.path)).toEqual(["keep"]);
  });

  it("空段与空白归一：a//b、' x / y '、'y/' 都落到干净路径", () => {
    const tree = tagTree(stateOf([makeNote(["a//b", " x / y ", "y/", "/"])]));
    expect(tree.map((node) => node.path).sort()).toEqual(["a", "x", "y"]);
    expect(tree.find((node) => node.path === "a")?.children[0]?.path).toBe("a/b");
    expect(tree.find((node) => node.path === "x")?.children[0]?.path).toBe("x/y");
  });

  it("notes 按传入的 sort 排序（title）", () => {
    const b = makeNote(["t"], { title: "B-title" });
    const a = makeNote(["t"], { title: "A-title" });
    const tree = tagTree(stateOf([b, a]), { sort: "title" });
    expect(tree[0].notes.map((note) => note.title)).toEqual(["A-title", "B-title"]);
  });
});
