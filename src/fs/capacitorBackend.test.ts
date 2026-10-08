import { beforeEach, describe, expect, it, vi } from "vitest";
import { capacitorWorkspaceDir, createCapacitorBackend, isCapacitorNative } from "./capacitorBackend";
import { describeBackend } from "./types";

/**
 * `@capacitor/filesystem` 的内存替身：按照插件 Android 实现的真实错误措辞
 * （`FilesystemErrors.kt`）模拟 `Documents` 目录下的原生文件系统，让
 * `createCapacitorBackend` 的契约测试可以在 Node 里跑。
 */

type MockDir = { type: "directory"; children: Map<string, MockNode>; mtime: number };

type MockNode =
  | { type: "file"; data: Uint8Array; mtime: number }
  | MockDir;

interface PluginOptions {
  path?: string;
  from?: string;
  to?: string;
  data?: string | Blob;
  encoding?: string;
  recursive?: boolean;
}

const fails = (method: string, path: string): Error =>
  new Error(`'${method}' failed because file at '${path}' does not exist.`);

const h = vi.hoisted(() => {
  let clock = 1_700_000_000_000;
  let root: MockNode;
  const reset = (): void => {
    clock = 1_700_000_000_000;
    root = { type: "directory", children: new Map(), mtime: clock };
  };
  reset();

  const segments = (path?: string): string[] => (path ?? "").split("/").filter(Boolean);

  const resolve = (path?: string): MockNode | null => {
    let node: MockNode = root;
    for (const segment of segments(path)) {
      if (node.type !== "directory") return null;
      const next: MockNode | undefined = node.children.get(segment);
      if (!next) return null;
      node = next;
    }
    return node;
  };

  const parentOf = (path: string): { parent: MockDir; name: string } | null => {
    const parts = segments(path);
    const name = parts.pop();
    if (!name) return null;
    const parent = resolve(parts.join("/"));
    return parent?.type === "directory" ? { parent, name } : null;
  };

  const ensureDirectory = (path: string): MockNode => {
    let node = root;
    for (const segment of segments(path)) {
      if (node.type !== "directory") throw new Error(`Invalid '${path}' path.`);
      let next = node.children.get(segment);
      if (!next) {
        next = { type: "directory", children: new Map(), mtime: clock++ };
        node.children.set(segment, next);
      }
      node = next;
    }
    return node;
  };

  const fs = {
    /** 测试断言用：按路径读回字节。 */
    __peek(path: string): Uint8Array | null {
      const node = resolve(path);
      return node?.type === "file" ? node.data : null;
    },
    reset,
    async requestPermissions(): Promise<{ publicStorage: string }> {
      return { publicStorage: "granted" };
    },
    async readdir(options: PluginOptions): Promise<{ files: { name: string; type: "file" | "directory"; size: number; mtime: number; uri: string }[] }> {
      const node = resolve(options.path);
      if (!node) throw fails("readdir", options.path ?? "");
      if (node.type !== "directory") throw new Error(`'readdir' not supported for files, only directories are supported.`);
      return {
        files: [...node.children.entries()].map(([name, child]) => ({
          name,
          type: child.type,
          size: child.type === "file" ? child.data.length : 0,
          mtime: child.mtime,
          uri: `file:///documents/${options.path ?? ""}/${name}`,
        })),
      };
    },
    async readFile(options: PluginOptions): Promise<{ data: string }> {
      const node = resolve(options.path);
      if (!node) throw fails("readFile", options.path ?? "");
      if (node.type !== "file") throw new Error(`'readFile' not supported for directories.`);
      let binary = "";
      const chunk = 0x8000;
      for (let offset = 0; offset < node.data.length; offset += chunk) {
        binary += String.fromCharCode(...node.data.subarray(offset, offset + chunk));
      }
      return { data: options.encoding === "utf8" ? new TextDecoder().decode(node.data) : btoa(binary) };
    },
    async writeFile(options: PluginOptions): Promise<void> {
      const path = options.path ?? "";
      if (options.recursive) ensureDirectory(segments(path).slice(0, -1).join("/"));
      const located = parentOf(path);
      if (!located) throw new Error(`Invalid '${path}' path.`);
      const { parent, name } = located;
      if (parent.children.get(name)?.type === "directory") {
        throw new Error(`'writeFile' failed with an unknown error.`);
      }
      const payload = options.data;
      if (payload === undefined) throw new Error(`Invalid '${path}' path.`);
      const bytes =
        typeof payload === "string"
          ? options.encoding === "utf8"
            ? new TextEncoder().encode(payload)
            : Uint8Array.from(atob(payload), (char) => char.charCodeAt(0))
          : new Uint8Array(await payload.arrayBuffer());
      parent.children.set(name, { type: "file", data: bytes, mtime: clock++ });
    },
    async mkdir(options: PluginOptions): Promise<void> {
      const parts = segments(options.path ?? "");
      if (!options.recursive) throw new Error(`'mkdir' failed with an unknown error.`);
      const existing = resolve(options.path);
      if (existing) throw new Error(`Directory at '${options.path}' already exists, cannot be overwritten.`);
      ensureDirectory(parts.join("/"));
    },
    async rmdir(options: PluginOptions): Promise<void> {
      const located = parentOf(options.path ?? "");
      const node = resolve(options.path);
      if (!located || !node) throw fails("rmdir", options.path ?? "");
      if (node.type === "file") throw new Error(`'rmdir' not supported for files, only directories are supported.`);
      if (node.type === "directory" && node.children.size > 0 && !options.recursive) {
        throw new Error("Cannot delete directory with children; received recursive=false but directory has contents.");
      }
      located.parent.children.delete(located.name);
    },
    async deleteFile(options: PluginOptions): Promise<void> {
      const located = parentOf(options.path ?? "");
      const node = resolve(options.path);
      if (!located || !node) throw fails("deleteFile", options.path ?? "");
      if (node.type === "directory") throw new Error(`'deleteFile' not supported for directories.`);
      located.parent.children.delete(located.name);
    },
    async stat(options: PluginOptions): Promise<{ type: "file" | "directory"; size: number; mtime: number; uri: string }> {
      const node = resolve(options.path);
      if (!node) throw fails("stat", options.path ?? "");
      return {
        type: node.type,
        size: node.type === "file" ? node.data.length : 0,
        mtime: node.mtime,
        uri: `file:///documents/${options.path ?? ""}`,
      };
    },
    async rename(options: PluginOptions): Promise<void> {
      const source = parentOf(options.from ?? "");
      const sourceNode = resolve(options.from);
      if (!source || !sourceNode) throw fails("rename", options.from ?? "");
      const target = parentOf(options.to ?? "");
      if (!target) throw new Error(`Invalid '${options.to}' path.`);
      if (resolve(options.to)) {
        throw new Error(`Directory at '${options.to}' already exists, cannot be overwritten.`);
      }
      target.parent.children.set(target.name, sourceNode);
      source.parent.children.delete(source.name);
    },
  };

  return { fs };
});

vi.mock("@capacitor/filesystem", () => ({
  Directory: { Documents: "DOCUMENTS", Data: "DATA" },
  Encoding: { UTF8: "utf8" },
  Filesystem: h.fs,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
}));

const WORKSPACE = "我的笔记";

function backend() {
  return createCapacitorBackend(`OpenNote/${WORKSPACE}`);
}

describe("createCapacitorBackend（@capacitor/filesystem 的契约）", () => {
  beforeEach(() => {
    h.fs.reset();
  });

  it("writeText 建齐缺失的父目录，readText 读回原文", async () => {
    const fs = backend();
    await fs.writeText("日记/2026/10/笔记.md", "# 你好\n正文");
    await expect(fs.readText("日记/2026/10/笔记.md")).resolves.toBe("# 你好\n正文");
    expect(h.fs.__peek(`OpenNote/${WORKSPACE}/日记/2026/10/笔记.md`)).toBeTruthy();
  });

  it("writeBytes / readBytes 走 base64，二进制不损坏", async () => {
    const fs = backend();
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 255]);
    await fs.writeBytes("assets/图标.png", bytes);
    await expect(fs.readBytes("assets/图标.png")).resolves.toEqual(bytes);
  });

  it("list 目录在前、中文名按 zh-Hans-CN 排序，字段齐全", async () => {
    const fs = backend();
    await fs.writeText("笔记.md", "# 一");
    await fs.mkdir("素材");
    await fs.writeText("啊.md", "# 二");
    const entries = await fs.list("");
    expect(entries.map((entry) => entry.name)).toEqual(["素材", "啊.md", "笔记.md"]);
    expect(entries[1]).toMatchObject({ kind: "file", size: 5 });
    expect(entries[1].mtimeMs).toBeGreaterThan(1e12);
  });

  it("readText 缺失文件抛中文「找不到」", async () => {
    const fs = backend();
    await expect(fs.readText("缺失.md")).rejects.toThrow(/^找不到：缺失\.md$/);
  });

  it("stat：文件给真实值，目录与缺失路径返回 null", async () => {
    const fs = backend();
    await fs.writeText("a.md", "12345");
    await fs.mkdir("文件夹");
    const stat = await fs.stat("a.md");
    expect(stat).toMatchObject({ size: 5 });
    expect(stat!.mtimeMs).toBeGreaterThan(1e12);
    await expect(fs.stat("文件夹")).resolves.toBeNull();
    await expect(fs.stat("没有.md")).resolves.toBeNull();
    await expect(fs.exists("a.md")).resolves.toBe(true);
    await expect(fs.exists("文件夹")).resolves.toBe(true);
    await expect(fs.exists("没有.md")).resolves.toBe(false);
    await expect(fs.exists("")).resolves.toBe(true);
  });

  it("mkdir 幂等：已存在不算失败", async () => {
    const fs = backend();
    await fs.mkdir("新目录");
    await fs.mkdir("新目录");
    await fs.mkdir("");
    await expect(fs.exists("新目录")).resolves.toBe(true);
  });

  it("remove：缺失路径视为成功，根目录拒绝，非空目录要 recursive", async () => {
    const fs = backend();
    await expect(fs.remove("没有.md")).resolves.toBeUndefined();
    await expect(fs.remove("")).rejects.toThrow("不能删除笔记本根目录");
    await fs.writeText("目录/内.md", "x");
    await expect(fs.remove("目录")).rejects.toThrow("文件夹不是空的：目录");
    await fs.remove("目录", { recursive: true });
    await expect(fs.exists("目录")).resolves.toBe(false);
    await fs.writeText("b.md", "y");
    await fs.remove("b.md");
    await expect(fs.exists("b.md")).resolves.toBe(false);
  });

  it("move：缺失源抛「找不到」，已存在目标拒绝", async () => {
    const fs = backend();
    await expect(fs.move("缺失.md", "新.md")).rejects.toThrow(/^找不到：缺失\.md$/);
    await fs.writeText("a.md", "A");
    await fs.writeText("b.md", "B");
    await expect(fs.move("a.md", "b.md")).rejects.toThrow("目标路径已存在：b.md");
  });

  it("move：文件与整目录都能搬，大小写折叠相同是 no-op", async () => {
    const fs = backend();
    await fs.writeText("故事/第一章.md", "正文");
    await fs.move("故事/第一章.md", "归档/第一章.md");
    await expect(fs.readText("归档/第一章.md")).resolves.toBe("正文");
    await expect(fs.exists("故事/第一章.md")).resolves.toBe(false);
    await fs.writeText("故事/第二章.md", "二");
    await fs.move("故事", "已归档");
    await expect(fs.readText("已归档/第二章.md")).resolves.toBe("二");
    await fs.writeText("Note.md", "n");
    await fs.move("Note.md", "note.md");
    await expect(fs.readText("Note.md")).resolves.toBe("n");
  });

  it("move：根目录与移进自身子树都拒绝", async () => {
    const fs = backend();
    await expect(fs.move("", "备份")).rejects.toThrow("不能移动笔记本根目录");
    await expect(fs.move("a.md", "./")).rejects.toThrow("不能移动笔记本根目录");
    await fs.mkdir("Docs");
    await expect(fs.move("Docs", "Docs/子")).rejects.toThrow("不能将文件夹移动到自身内部");
  });

  it("绝对路径与越界路径被 paths 层拒绝", async () => {
    const fs = backend();
    await expect(fs.readText("C:/Windows")).rejects.toThrow("不允许使用绝对路径");
    await expect(fs.readText("../outside.md")).rejects.toThrow("路径越界");
  });

  it("BackendKind 是 capacitor，label 与 describeBackend 都是「手机文件夹」", () => {
    const fs = backend();
    expect(fs.kind).toBe("capacitor");
    expect(fs.label).toBe("手机文件夹");
    expect(fs.canWrite).toBe(true);
    expect(describeBackend("capacitor")).toBe("手机文件夹");
  });

  it("isCapacitorNative 在测试（非原生）环境为 false", () => {
    expect(isCapacitorNative()).toBe(false);
  });

  it("capacitorWorkspaceDir 返回带 OpenNote/ 前缀的根目录并确保它存在（resolveBackend 的契约）", async () => {
    const root = await capacitorWorkspaceDir("旅行");
    expect(root).toBe("OpenNote/旅行");
    await expect(h.fs.stat({ path: root })).resolves.toMatchObject({ type: "directory" });
    // 名字里的非法字符被清洗，不会越界写出意料外的目录
    const weird = await capacitorWorkspaceDir("a/b:c");
    expect(weird).toBe("OpenNote/a b c");
  });
});
