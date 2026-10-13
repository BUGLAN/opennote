/**
 * 真实文件系统 → 同步后端的适配层用例（`docs/执行-三端同步…` §5.3、§3.11）。
 *
 * 这里最要紧的两条：
 *
 * 1. **递归只有这一份实现** —— 三个后端（node / fsa / opfs）的 `list()` 都只列一层，
 *    谁来走这棵树必须只有一处，否则三个后端的同步行为会不一致（极难发现）。
 * 2. **深度/条数超限要明确报错，不许静默截断** —— 静默截断意味着
 *    「一部分文件永远不同步」，而用户看不出为什么。
 */
import { describe, expect, it, vi } from "vitest";
import { createBackendSyncFiles, MAX_SYNC_DEPTH, MAX_SYNC_ENTRIES } from "./backendFiles";
import type { FileSystemBackend, EntryInfo } from "../fs/types";

/** 一个用「路径 → 条目」表驱动的假后端（只实现同步用到的那几个方法）。 */
function fakeBackend(tree: Record<string, EntryInfo[]>, options: { throwOn?: string[] } = {}) {
  const removed: { path: string; recursive: boolean }[] = [];
  const written: string[] = [];
  const backend = {
    kind: "node",
    label: "假",
    canWrite: true,
    list: async (relPath: string) => {
      if (options.throwOn?.includes(relPath)) throw new Error("读不了");
      return tree[relPath] ?? [];
    },
    readText: async () => "",
    readBytes: async () => new Uint8Array(),
    writeText: async () => undefined,
    writeBytes: async (relPath: string) => void written.push(relPath),
    mkdir: async () => undefined,
    remove: async (relPath: string, opts?: { recursive?: boolean }) => void removed.push({ path: relPath, recursive: opts?.recursive === true }),
    move: async () => undefined,
    exists: async () => true,
    stat: async () => null,
  } as unknown as FileSystemBackend;
  return { backend, removed, written };
}

const file = (name: string): EntryInfo => ({ name, kind: "file", size: 1, mtimeMs: 0 });
const dir = (name: string): EntryInfo => ({ name, kind: "directory", size: 0, mtimeMs: 0 });

/* ============================================================================
   递归
   ============================================================================ */

describe("递归列目录（**唯一**一份实现）", () => {
  it("列出嵌套目录里的文件（相对路径带 `/`）", async () => {
    const { backend } = fakeBackend({
      "": [dir("notes"), file("README.md")],
      notes: [file("a.md"), dir("deep")],
      "notes/deep": [file("b.md")],
    });
    const files = createBackendSyncFiles({ backend });
    const listed = await files.list();
    expect(listed.filter((entry) => !entry.isDir).map((entry) => entry.path).sort()).toEqual(["README.md", "notes/a.md", "notes/deep/b.md"]);
  });

  it("目录也列出来（过滤是 `workspaceFiles.ts` 的事，不是这一层）", async () => {
    const { backend } = fakeBackend({ "": [dir("notes")], notes: [file("a.md")] });
    const listed = await createBackendSyncFiles({ backend }).list();
    expect(listed).toContainEqual({ path: "notes", isDir: true });
  });

  it("★ 顺序**确定**（同层按名字排序）—— 两次列出必须一样", async () => {
    const { backend } = fakeBackend({ "": [file("z.md"), file("a.md"), file("m.md")] });
    const files = createBackendSyncFiles({ backend });
    const first = (await files.list()).map((entry) => entry.path);
    const second = (await files.list()).map((entry) => entry.path);
    expect(first).toEqual(["a.md", "m.md", "z.md"]);
    expect(second).toEqual(first);
  });

  it("空工作区 ⇒ 空列表（不抛）", async () => {
    const { backend } = fakeBackend({});
    expect(await createBackendSyncFiles({ backend }).list()).toEqual([]);
  });

  it("读不了的子目录被跳过，而不是让整轮同步失败", async () => {
    const { backend } = fakeBackend({ "": [dir("坏"), file("好.md")], 坏: [file("x.md")] }, { throwOn: ["坏"] });
    const listed = await createBackendSyncFiles({ backend }).list();
    expect(listed.map((entry) => entry.path)).toEqual(["坏", "好.md"]);
  });
});

/* ============================================================================
   ★ 护栏：明确报错，不静默截断
   ============================================================================ */

describe("★ 超限要**明确报错**，不许静默截断", () => {
  it("★ 目录太深 ⇒ 抛（防符号链接环把内存吃光）", async () => {
    // 造一条比上限更深的链：每一层只有一个目录。
    const tree: Record<string, EntryInfo[]> = {};
    for (let index = 0; index <= MAX_SYNC_DEPTH + 2; index += 1) {
      const path = index === 0 ? "" : Array.from({ length: index }, (_, i) => `d${i}`).join("/");
      const child = `d${index}`;
      tree[path] = [dir(child)];
    }
    const { backend } = fakeBackend(tree);
    await expect(createBackendSyncFiles({ backend }).list()).rejects.toThrow(/目录太深/);
  });

  it("★ 条目太多 ⇒ 抛（并提示「是否误选了很大的目录」）", async () => {
    const many = Array.from({ length: MAX_SYNC_ENTRIES + 5 }, (_, index) => file(`f${index}.md`));
    const { backend } = fakeBackend({ "": many });
    await expect(createBackendSyncFiles({ backend }).list()).rejects.toThrow(/条目太多/);
  });

  it("上限可注入（用例不必真造两万个文件）", async () => {
    const { backend } = fakeBackend({ "": [file("a.md"), file("b.md"), file("c.md")] });
    await expect(createBackendSyncFiles({ backend, maxEntries: 2 }).list()).rejects.toThrow(/条目太多/);
  });
});

/* ============================================================================
   读 / 写 / 删
   ============================================================================ */

describe("读 / 写 / 删", () => {
  it("`read` / `write` 直接转发给后端", async () => {
    const { backend, written } = fakeBackend({});
    const files = createBackendSyncFiles({ backend });
    await files.write("notes/a.md", new Uint8Array([1]));
    expect(written).toEqual(["notes/a.md"]);
    await expect(files.read("notes/a.md")).resolves.toBeInstanceOf(Uint8Array);
  });

  it("★ `remove` 带 `recursive: true`（否则会留下半棵树，而下一轮同步把它当「新增」⇒ 刚删的又回来了）", async () => {
    const { backend, removed } = fakeBackend({});
    await createBackendSyncFiles({ backend }).remove("notes/gone.md");
    expect(removed).toEqual([{ path: "notes/gone.md", recursive: true }]);
    void vi;
  });
});
